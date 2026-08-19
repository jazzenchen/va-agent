import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import * as acp from "@agentclientprotocol/sdk";

import { PI_IDENTITY_SENTENCE, VA_IDENTITY_SENTENCE } from "../src/identity.ts";

interface AgentHandle {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  permissions: acp.RequestPermissionRequest[];
  timeline: string[];
  updates: acp.SessionNotification[];
  mcp: string[];
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const MCP_SERVER_ID = "vibearound";

test("runs a permitted tool and restores its Pi transcript after restart", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-acp-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const requests: unknown[] = [];
  const serverErrors: Error[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, "Bearer test-key");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const serialized = JSON.stringify(parsed);
      if (serialized.includes("second prompt")) {
        sendTextResponse(response, `response-${requests.length}`, "context restored");
      } else if (serialized.includes('"type":"function_call_output"')) {
        sendTextResponse(response, `response-${requests.length}`, "first complete");
      } else {
        sendBashResponse(response, `response-${requests.length}`);
      }
    })().catch((error) => {
      serverErrors.push(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  let first: AgentHandle | undefined;
  let second: AgentHandle | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    first = startAgent(agentDir, join(root, "data"), baseUrl);
    const initialized = await first.connection.agent.request(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION },
    );
    assert.equal(initialized.agentCapabilities?.loadSession, true);
    await assert.rejects(
      first.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
        additionalDirectories: [cwd],
      }),
      /Invalid params: Additional workspace directories are not supported yet/u,
    );
    const created = await first.connection.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );
    const firstPrompt = await first.connection.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "first prompt" }],
      },
    );
    assert.equal(firstPrompt.stopReason, "end_turn");
    assert.equal(first.permissions.length, 1);
    assert.equal(first.permissions[0].sessionId, created.sessionId);
    assert.equal(first.permissions[0].toolCall.name, "bash");
    assert.equal(first.permissions[0].toolCall.status, "pending");
    assert.ok(first.permissions[0].options.some(
      (option) => option.optionId === "allow-once",
    ));

    const toolCall = first.updates.find(
      ({ update }) => update.sessionUpdate === "tool_call" &&
        update.name === "bash",
    )?.update;
    assert.ok(toolCall && toolCall.sessionUpdate === "tool_call");
    const statuses = first.updates.flatMap(({ update }) =>
      update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === toolCall.toolCallId
        ? [update.status]
        : []
    );
    assert.equal(statuses[0], "in_progress");
    assert.equal(statuses.at(-1), "completed");
    assert.ok(statuses.every((status) =>
      status === "in_progress" || status === "completed"
    ));
    assert.ok(
      first.timeline.indexOf(`pending:${toolCall.toolCallId}`) <
        first.timeline.indexOf(`permission:${toolCall.toolCallId}`),
    );
    assert.ok(
      first.timeline.indexOf(`permission:${toolCall.toolCallId}`) <
        first.timeline.indexOf(`in_progress:${toolCall.toolCallId}`),
    );
    assert.equal(agentText(first.updates), "first complete");

    await stopAgent(first);
    first = undefined;

    second = startAgent(agentDir, join(root, "data"), baseUrl);
    await second.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    await assert.rejects(
      second.connection.agent.request(acp.methods.agent.session.load, {
        sessionId: "missing-session",
        cwd,
        mcpServers: [],
      }),
      /Resource not found: missing-session: Session not found: missing-session/u,
    );
    await second.connection.agent.request(acp.methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd,
      mcpServers: [],
    });
    // Replayed notifications precede the load response on the wire, but the
    // client dispatches messages concurrently; wait for the last one to land.
    await waitFor(() =>
      second!.updates.some(({ update }) =>
        update.sessionUpdate === "tool_call_update" && update.status === "completed"
      ), "session/load replay");

    assert.equal(second.permissions.length, 0);
    assert.ok(second.updates.some(({ update }) =>
      update.sessionUpdate === "user_message_chunk" &&
      update.content.type === "text" &&
      update.content.text === "first prompt"
    ));
    assert.ok(second.updates.some(({ update }) =>
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text" &&
      update.content.text === "first complete"
    ));
    assert.ok(second.updates.some(({ update }) =>
      update.sessionUpdate === "tool_call" && update.name === "bash"
    ));
    assert.ok(second.updates.some(({ update }) =>
      update.sessionUpdate === "tool_call_update" &&
      update.status === "completed"
    ));

    const promptUpdateStart = second.updates.length;
    const secondPrompt = await second.connection.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "second prompt" }],
      },
    );
    assert.equal(secondPrompt.stopReason, "end_turn");
    assert.equal(
      agentText(second.updates.slice(promptUpdateStart)),
      "context restored",
    );

    assert.equal(requests.length, 3);
    const restoredRequest = JSON.stringify(requests[2]);
    assert.match(restoredRequest, /first prompt/);
    assert.match(restoredRequest, /printf integration-tool/);
    assert.ok(restoredRequest.includes("$VIBEAROUND_MODEL_API_KEY"));
    assert.match(restoredRequest, /integration-tool/);
    assert.match(restoredRequest, /first complete/);
    assert.match(restoredRequest, /second prompt/);
    assert.deepEqual(serverErrors, []);
  } finally {
    if (first) {
      await stopAgent(first).catch(() => {});
    }
    if (second) {
      await stopAgent(second).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces an upstream model error through ACP", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-error-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { message: "review sentinel upstream failure" },
    }));
  });
  let agent: AgentHandle | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    agent = startAgent(agentDir, join(root, "data"), `http://127.0.0.1:${port}/v1`);
    await agent.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    const created = await agent.connection.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );

    await assert.rejects(
      agent.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "fail visibly" }],
      }),
      /Internal error: OpenAI API error \(401\):.*review sentinel upstream failure/u,
    );
    assert.deepEqual(agent.updates, []);
  } finally {
    if (agent) {
      await stopAgent(agent).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces real read targets through the compiled Pi tool path", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-read-access-"));
  const dataDir = join(root, "data");
  const agentDir = join(dataDir, "agents", "va-agent");
  const cwd = join(dataDir, "workspaces", "project");
  const inside = join(cwd, "inside.txt");
  const sibling = join(dataDir, "workspaces", "sibling.txt");
  const outside = join(root, "outside.txt");
  const outsideLink = join(cwd, "outside-link.txt");
  const auth = join(dataDir, "local-api-auth.json");
  const cases = [
    { marker: "READ_CASE_INSIDE", path: "inside.txt", permissions: 0, status: "completed" },
    { marker: "READ_CASE_PARENT", path: "../sibling.txt", permissions: 1, status: "completed" },
    { marker: "READ_CASE_ABSOLUTE", path: outside, permissions: 1, status: "completed" },
    { marker: "READ_CASE_SYMLINK", path: outsideLink, permissions: 1, status: "completed" },
    { marker: "READ_CASE_DATA", path: auth, permissions: 0, status: "failed" },
  ] as const;
  const followups: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const parsed = JSON.parse(body);
      const serialized = JSON.stringify(parsed);
      const current = cases.find(({ marker }) => serialized.includes(marker));
      assert.ok(current, "request must retain its case marker");
      if (serialized.includes('"type":"function_call_output"')) {
        followups.push(serialized);
        sendTextResponse(response, `read-final-${followups.length}`, "read complete");
      } else {
        sendReadResponse(response, `read-${current.marker}`, current.path);
      }
    })().catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  let agent: AgentHandle | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(inside, "inside");
    await writeFile(sibling, "sibling");
    await writeFile(outside, "outside");
    await writeFile(auth, "secret");
    try {
      await symlink(outside, outsideLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating symlinks is not permitted on this platform");
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    agent = startAgent(agentDir, join(root, "data"), `http://127.0.0.1:${port}/v1`);
    await agent.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });

    for (const current of cases) {
      const created = await agent.connection.agent.request(
        acp.methods.agent.session.new,
        { cwd, mcpServers: [] },
      );
      const permissionStart: number = agent.permissions.length;
      const updateStart: number = agent.updates.length;
      const response: { stopReason: string } = await agent.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: current.marker }],
        },
      );
      assert.equal(response.stopReason, "end_turn");
      assert.equal(
        agent.permissions.length - permissionStart,
        current.permissions,
        current.marker,
      );
      const currentUpdates = agent.updates.slice(updateStart);
      const readCall = currentUpdates.find(({ update }) =>
        update.sessionUpdate === "tool_call" && update.name === "read"
      )?.update;
      assert.ok(readCall && readCall.sessionUpdate === "tool_call", current.marker);
      const readStatuses: Array<string | null | undefined> = currentUpdates
        .flatMap(({ update }) =>
          update.sessionUpdate === "tool_call_update" &&
            update.toolCallId === readCall.toolCallId
            ? [update.status]
            : []
        );
      assert.equal(readStatuses.at(-1), current.status, current.marker);
    }

    assert.equal(followups.length, cases.length);
    assert.match(
      followups.at(-1) ?? "",
      /Access to VibeAround product data is denied/u,
    );
  } finally {
    if (agent) {
      await stopAgent(agent).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("uses VibeAround MCP tools over the ACP connection", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-mcp-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      // Turn 1: ask for the session id (built-in, auto-allowed). Turn 2: call
      // the VibeAround tool with it (over ACP, permission-gated). Turn 3: done.
      const outputs = toolOutputs(parsed);
      const sessionId = outputs.get("get_session_id");
      const echoed = outputs.get("va_mcp_echo");
      if (echoed !== undefined) {
        sendTextResponse(
          response,
          `response-${requests.length}`,
          echoed === `echo:session-${sessionId}` ? "mcp complete" : `unexpected: ${echoed}`,
        );
      } else if (sessionId !== undefined) {
        sendToolCallResponse(response, `response-${requests.length}`, "va_mcp_echo", {
          text: `session-${sessionId}`,
        });
      } else {
        sendToolCallResponse(response, `response-${requests.length}`, "get_session_id", {});
      }
    })().catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  let agent: AgentHandle | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    agent = startAgent(agentDir, join(root, "data"), `http://127.0.0.1:${port}/v1`);

    const initialized = await agent.connection.agent.request(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION },
    );
    assert.equal(initialized.agentCapabilities?.mcpCapabilities?.acp, true);

    await assert.rejects(
      agent.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [{ type: "http", name: "other", url: "http://127.0.0.1:1/mcp", headers: [] }],
      }),
      /Only MCP servers over ACP/u,
    );

    const { sessionId } = await agent.connection.agent.request(
      acp.methods.agent.session.new,
      {
        cwd,
        mcpServers: [{ type: "acp", name: "vibearound", serverId: MCP_SERVER_ID }],
      },
    );
    assert.deepEqual(agent.mcp, [
      `connect:${MCP_SERVER_ID}`,
      `conn-${MCP_SERVER_ID}:initialize`,
      `conn-${MCP_SERVER_ID}:notifications/initialized`,
      `conn-${MCP_SERVER_ID}:tools/list`,
    ]);

    const result = await agent.connection.agent.request(
      acp.methods.agent.session.prompt,
      { sessionId, prompt: [{ type: "text", text: "use the tools" }] },
    );
    assert.equal(result.stopReason, "end_turn");
    assert.equal(agentText(agent.updates), "mcp complete");

    // Pi's system prompt goes out with our identity sentence swapped in. If a
    // Pi upgrade rewords the anchor, this is where it shows.
    const firstRequest = JSON.stringify(requests[0]);
    assert.ok(firstRequest.includes(VA_IDENTITY_SENTENCE), firstRequest.slice(0, 400));
    assert.ok(!firstRequest.includes(PI_IDENTITY_SENTENCE));

    // Only the VibeAround tool asked for permission; the built-in session
    // tool is auto-allowed.
    assert.deepEqual(
      agent.permissions.map((request) => request.toolCall.name),
      ["va_mcp_echo"],
    );
    assert.equal(agent.mcp.at(-1), `call:va_mcp_echo:session-${sessionId}`);
    // Pi's own tool_call gate ran, so the ACP client saw the pending update
    // before the permission prompt, then in_progress, then completed.
    const echoCallId = agent.permissions[0]?.toolCall.toolCallId;
    assert.ok(echoCallId);
    assert.deepEqual(
      agent.timeline.filter((entry) => entry.endsWith(`:${echoCallId}`)),
      [
        `pending:${echoCallId}`,
        `permission:${echoCallId}`,
        `in_progress:${echoCallId}`,
        `completed:${echoCallId}`,
      ],
    );

    // Replacing the session in-process disconnects the old MCP connection
    // (and the reloaded session connects again).
    await agent.connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [{ type: "acp", name: "vibearound", serverId: MCP_SERVER_ID }],
    });
    assert.ok(
      agent.mcp.includes(`disconnect:conn-${MCP_SERVER_ID}`),
      JSON.stringify(agent.mcp),
    );
    assert.equal(
      agent.mcp.filter((entry) => entry === `connect:${MCP_SERVER_ID}`).length,
      2,
    );

    await stopAgent(agent);
    agent = undefined;
  } finally {
    if (agent) {
      agent.child.kill("SIGKILL");
      agent.connection.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// The SDK only ships typed handlers for the stable client methods; the MCP
// ones take an explicit params parser.
function passthrough<T>(): acp.ParamsParser<T> {
  return { parse: (params: unknown) => params as T };
}

/// Tool outputs the model has received so far, keyed by tool name.
function toolOutputs(request: unknown): Map<string, string> {
  const input = (request as { input?: unknown[] }).input ?? [];
  const names = new Map<string, string>();
  const outputs = new Map<string, string>();
  for (const item of input) {
    const record = item as {
      type?: string;
      call_id?: string;
      name?: string;
      output?: string;
    };
    if (record.type === "function_call" && record.call_id && record.name) {
      names.set(record.call_id, record.name);
    }
    if (record.type === "function_call_output" && record.call_id) {
      const name = names.get(record.call_id);
      if (name && typeof record.output === "string") {
        outputs.set(name, record.output.trim());
      }
    }
  }
  return outputs;
}

function startAgent(agentDir: string, dataDir: string, baseUrl: string): AgentHandle {
  const binary = process.env.VA_AGENT_TEST_BINARY?.trim();
  const child = spawn(binary || process.execPath, binary ? [] : ["src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIBEAROUND_AGENT_DIR: agentDir,
      VIBEAROUND_DATA_DIR: dataDir,
      VIBEAROUND_MODEL_API_KEY: "test-key",
      VIBEAROUND_MODEL_CONFIG: JSON.stringify({
        api: "openai-responses",
        baseUrl,
        model: "test-model",
        provider: "vibearound-test",
      }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const updates: acp.SessionNotification[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const timeline: string[] = [];
  const mcp: string[] = [];
  const client = acp
    .client({ name: "va-agent-integration-test" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      timeline.push(`permission:${params.toolCall.toolCallId}`);
      return {
        outcome: { outcome: "selected", optionId: "allow-once" },
      };
    })
    // The test client plays VibeAround: one MCP server reachable over this
    // ACP connection, exposing a single echo tool.
    .onRequest<acp.ConnectMcpRequest, acp.ConnectMcpResponse>(
      acp.CLIENT_METHODS.mcp_connect,
      passthrough<acp.ConnectMcpRequest>(),
      ({ params }) => {
        mcp.push(`connect:${params.serverId}`);
        return { connectionId: `conn-${params.serverId}` };
      },
    )
    .onRequest<acp.MessageMcpRequest, acp.MessageMcpResponse>(
      acp.CLIENT_METHODS.mcp_message,
      passthrough<acp.MessageMcpRequest>(),
      ({ params }) => {
        mcp.push(`${params.connectionId}:${params.method}`);
        switch (params.method) {
          case "initialize":
            return {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "vibearound-test", version: "0" },
            };
          case "tools/list":
            return {
              tools: [{
                name: "va_mcp_echo",
                description: "Echo text back through VibeAround.",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              }],
            };
          case "tools/call": {
            const args = (params.params as {
              name: string;
              arguments: { text: string };
            });
            mcp.push(`call:${args.name}:${args.arguments.text}`);
            return {
              content: [{ type: "text", text: `echo:${args.arguments.text}` }],
            };
          }
          default:
            throw acp.RequestError.methodNotFound(params.method);
        }
      },
    )
    .onNotification<acp.MessageMcpNotification>(
      acp.CLIENT_METHODS.mcp_message,
      passthrough<acp.MessageMcpNotification>(),
      ({ params }) => {
        mcp.push(`${params.connectionId}:${params.method}`);
      },
    )
    .onRequest<acp.DisconnectMcpRequest, acp.DisconnectMcpResponse>(
      acp.CLIENT_METHODS.mcp_disconnect,
      passthrough<acp.DisconnectMcpRequest>(),
      ({ params }) => {
        mcp.push(`disconnect:${params.connectionId}`);
        return {};
      },
    )
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
      if (params.update.sessionUpdate === "tool_call") {
        timeline.push(`pending:${params.update.toolCallId}`);
      } else if (params.update.sessionUpdate === "tool_call_update") {
        timeline.push(`${params.update.status}:${params.update.toolCallId}`);
      }
    });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = client.connect(stream);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    connection,
    permissions,
    timeline,
    updates,
    mcp,
    stderr: () => stderr,
    exited,
  };
}

async function stopAgent(handle: AgentHandle): Promise<void> {
  handle.child.stdin.end();
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await withTimeout(handle.exited, 3_000, "agent did not exit");
  } catch (error) {
    handle.child.kill("SIGTERM");
    await handle.exited;
    throw error;
  } finally {
    handle.connection.close();
  }
  assert.equal(exit.signal, null, handle.stderr());
  assert.equal(exit.code, 0, handle.stderr());
  assert.equal(handle.stderr(), "");
}

function agentText(notifications: acp.SessionNotification[]): string {
  return notifications.flatMap(({ update }) =>
    update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
      ? [update.content.text]
      : []
  ).join("");
}

function sendBashResponse(response: ServerResponse, responseId: string): void {
  const argumentsJson = JSON.stringify({
    command:
      'test -z "$VIBEAROUND_MODEL_API_KEY" && test -z "$VIBEAROUND_MODEL_CONFIG" && printf integration-tool',
  });
  const item = {
    type: "function_call",
    id: `function-${responseId}`,
    call_id: `call-${responseId}`,
    name: "bash",
    arguments: argumentsJson,
    status: "completed",
  };
  sendEvents(response, [
    createdEvent(responseId),
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item },
    completedEvent(responseId, [item]),
  ]);
}

function sendToolCallResponse(
  response: ServerResponse,
  responseId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  const argumentsJson = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: `function-${responseId}`,
    call_id: `call-${responseId}`,
    name,
    arguments: argumentsJson,
    status: "completed",
  };
  sendEvents(response, [
    createdEvent(responseId),
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item },
    completedEvent(responseId, [item]),
  ]);
}

function sendReadResponse(
  response: ServerResponse,
  responseId: string,
  path: string,
): void {
  const argumentsJson = JSON.stringify({ path });
  const item = {
    type: "function_call",
    id: `function-${responseId}`,
    call_id: `call-${responseId}`,
    name: "read",
    arguments: argumentsJson,
    status: "completed",
  };
  sendEvents(response, [
    createdEvent(responseId),
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item },
    completedEvent(responseId, [item]),
  ]);
}

function sendTextResponse(
  response: ServerResponse,
  responseId: string,
  text: string,
): void {
  const item = {
    type: "message",
    id: `message-${responseId}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  sendEvents(response, [
    createdEvent(responseId),
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    completedEvent(responseId, [item]),
  ]);
}

function createdEvent(responseId: string): unknown {
  return {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      output: [],
    },
  };
}

function completedEvent(responseId: string, output: unknown[]): unknown {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      output,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    },
  };
}

function sendEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
  });
  for (const event of events) {
    const type = (event as { type: string }).type;
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
