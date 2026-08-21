import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import {
  createModelLaunch,
  MODEL_API_KEY_ENV,
  MODEL_CONFIG_ENV,
  readModelEnvironment,
} from "./model-runtime.ts";
import { acpMcpTransport, type McpBinding } from "./mcp-over-acp.ts";
import { toolKind } from "./pi-acp-bridge.ts";
import { createPiSessionFactory, Sessions } from "./sessions.ts";

// Injected by the npm build; running from source (`npm start`) has no define.
const AGENT_VERSION =
  typeof __VA_AGENT_VERSION__ === "string" ? __VA_AGENT_VERSION__ : "0.0.0-dev";

const agentDir = process.env.VIBEAROUND_AGENT_DIR?.trim();
if (!agentDir) {
  console.error("VIBEAROUND_AGENT_DIR is required");
  process.exit(2);
}
const dataDir = process.env.VIBEAROUND_DATA_DIR?.trim();
if (!dataDir) {
  console.error("VIBEAROUND_DATA_DIR is required");
  process.exit(2);
}

let modelLaunch;
try {
  const { config, apiKey } = readModelEnvironment(process.env);
  delete process.env[MODEL_CONFIG_ENV];
  delete process.env[MODEL_API_KEY_ENV];
  modelLaunch = await createModelLaunch(resolve(agentDir), config, apiKey);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const sessions = new Sessions(
  createPiSessionFactory(
    resolve(agentDir),
    resolve(dataDir),
    modelLaunch.modelRuntime,
    modelLaunch.model,
  ),
);
const permissionOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
];
const permissionRequest = (client: acp.AgentContext) =>
  async ({ sessionId, toolCallId, toolName, args, signal }: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<boolean> => {
    const outcome = await client.request<
      acp.RequestPermissionResponse,
      acp.RequestPermissionRequest
    >(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId,
          title: toolName,
          name: toolName,
          kind: toolKind(toolName),
          status: "pending",
          rawInput: args,
        },
        options: permissionOptions,
      },
      { cancellationSignal: signal },
    );
    return outcome.outcome.outcome === "selected" &&
      outcome.outcome.optionId === "allow-once";
  };
const app = acp
  .agent({ name: "va-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      mcpCapabilities: { acp: true },
    },
    agentInfo: {
      name: "va-agent",
      title: "VibeAround Agent",
      version: AGENT_VERSION,
    },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    const mcp = mcpBinding(client, params.mcpServers);
    if (params.additionalDirectories?.length) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Additional workspace directories are not supported yet",
      );
    }
    try {
      const sessionId = await sessions.create(
        params.cwd,
        permissionRequest(client),
        mcp,
      );
      return { sessionId };
    } catch (error) {
      throw internalRequestError(error);
    }
  })
  .onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
    const mcp = mcpBinding(client, params.mcpServers ?? []);
    if (params.additionalDirectories?.length) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Additional workspace directories are not supported yet",
      );
    }
    try {
      await sessions.resume(
        params.sessionId,
        params.cwd,
        permissionRequest(client),
        mcp,
      );
      return {};
    } catch (error) {
      throw sessionRequestError(params.sessionId, error);
    }
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    const mcp = mcpBinding(client, params.mcpServers);
    if (params.additionalDirectories?.length) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Additional workspace directories are not supported yet",
      );
    }
    try {
      await sessions.load(
        params.sessionId,
        params.cwd,
        permissionRequest(client),
        mcp,
        (update) => client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        }),
      );
      return {};
    } catch (error) {
      throw sessionRequestError(params.sessionId, error);
    }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    try {
      return {
        stopReason: await sessions.prompt(
          params.sessionId,
          params.prompt,
          (update) => client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update,
          }),
        ),
      };
    } catch (error) {
      throw internalRequestError(error);
    }
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
    sessions.cancel(params.sessionId),
  );

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);

process.once("SIGINT", () => connection.close());
process.once("SIGTERM", () => connection.close());

await connection.closed;
sessions.dispose();

// Only MCP servers reached over this ACP connection are accepted; the agent
// has no HTTP or stdio MCP client and does not want one.
function mcpBinding(
  client: acp.AgentContext,
  servers: acp.McpServer[],
): McpBinding {
  const acpServers: acp.McpServerAcp[] = [];
  for (const server of servers) {
    // Stdio entries carry no `type` tag in the ACP schema.
    if (!("type" in server) || server.type !== "acp") {
      throw acp.RequestError.invalidParams(
        undefined,
        "Only MCP servers over ACP are supported",
      );
    }
    acpServers.push(server);
  }
  return { servers: acpServers, transport: acpMcpTransport(client) };
}

function internalRequestError(error: unknown): acp.RequestError {
  if (error instanceof acp.RequestError) {
    return error;
  }
  return acp.RequestError.internalError(undefined, errorMessage(error));
}

function sessionRequestError(
  sessionId: string,
  error: unknown,
): acp.RequestError {
  return new acp.RequestError(
    -32002,
    `Resource not found: ${sessionId}: ${errorMessage(error)}`,
    { sessionId },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
