import * as acp from "@agentclientprotocol/sdk";
import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/// Built-in tool that returns the current Pi session ID. VibeAround's skills
/// point at it instead of the va_mcp_get_session_id lookup.
export const SESSION_ID_TOOL = "get_session_id";

const MCP_PROTOCOL_VERSION = "2025-03-26";

type PiToolParameters = ToolDefinition["parameters"];
type PiToolContent = { type: "text"; text: string } | {
  type: "image";
  data: string;
  mimeType: string;
};

/// The three ACP methods that carry MCP over the agent's own connection.
export interface McpOverAcpTransport {
  connect(serverId: string): Promise<string>;
  message(
    connectionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  notify(
    connectionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
}

export interface McpBinding {
  servers: acp.McpServerAcp[];
  transport: McpOverAcpTransport;
}

interface McpToolListing {
  tools?: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface McpCallResult {
  content?: unknown;
  isError?: boolean;
}

export function acpMcpTransport(client: acp.AgentContext): McpOverAcpTransport {
  return {
    async connect(serverId) {
      const response = await client.request<
        acp.ConnectMcpResponse,
        acp.ConnectMcpRequest
      >(acp.CLIENT_METHODS.mcp_connect, { serverId });
      return response.connectionId;
    },
    message(connectionId, method, params) {
      return client.request<acp.MessageMcpResponse, acp.MessageMcpRequest>(
        acp.CLIENT_METHODS.mcp_message,
        { connectionId, method, params },
      );
    },
    notify(connectionId, method, params) {
      return client.notify(acp.CLIENT_METHODS.mcp_message, {
        connectionId,
        method,
        params,
      });
    },
    async disconnect(connectionId) {
      await client.request<
        acp.DisconnectMcpResponse,
        acp.DisconnectMcpRequest
      >(acp.CLIENT_METHODS.mcp_disconnect, { connectionId });
    },
  };
}

export interface McpOverAcpExtension {
  factory: ExtensionFactory;
  /// Send `mcp/disconnect` for every connection the factory opened.
  disconnect(): Promise<void>;
}

/// Connect to each declared ACP MCP server, register its tools with Pi under
/// their own names, and forward calls as `tools/call`. Registered names are
/// added to `registered` so the session can activate them alongside its fixed
/// built-in set.
export function mcpOverAcpExtension(
  binding: McpBinding,
  registered: Set<string>,
): McpOverAcpExtension {
  const connections: string[] = [];
  const factory: ExtensionFactory = async (pi) => {
    for (const server of binding.servers) {
      const connectionId = await binding.transport.connect(server.serverId);
      connections.push(connectionId);
      await binding.transport.message(connectionId, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "va-agent", version: "0.0.0" },
      });
      await binding.transport.notify(connectionId, "notifications/initialized");
      const listing = await binding.transport.message(
        connectionId,
        "tools/list",
      ) as McpToolListing;
      for (const tool of listing.tools ?? []) {
        registered.add(tool.name);
        pi.registerTool({
          name: tool.name,
          label: tool.title ?? tool.name,
          description: tool.description ?? "",
          parameters: (tool.inputSchema ??
            { type: "object", properties: {} }) as PiToolParameters,
          async execute(_toolCallId, params) {
            const result = await binding.transport.message(
              connectionId,
              "tools/call",
              { name: tool.name, arguments: params },
            ) as McpCallResult;
            const content = mcpContent(result.content);
            if (result.isError) {
              throw new Error(
                content
                  .flatMap((block) => block.type === "text" ? [block.text] : [])
                  .join("\n") || `${tool.name} failed`,
              );
            }
            return { content, details: result };
          },
        });
      }
    }
  };
  return {
    factory,
    async disconnect() {
      for (const connectionId of connections.splice(0)) {
        await binding.transport.disconnect(connectionId);
      }
    },
  };
}

export function sessionIdToolExtension(registered: Set<string>): ExtensionFactory {
  return (pi) => {
    registered.add(SESSION_ID_TOOL);
    pi.registerTool({
      name: SESSION_ID_TOOL,
      label: "Session ID",
      description:
        "Return the current VibeAround Agent session ID. Use it when a VibeAround tool such as va_mcp_prepare_handover asks for session_id.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as PiToolParameters,
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        const sessionId = context.sessionManager.getSessionId();
        return {
          content: [{ type: "text", text: sessionId }],
          details: { sessionId },
        };
      },
    });
  };
}

function mcpContent(content: unknown): PiToolContent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block): PiToolContent[] => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return [{ type: "text", text: record.text }];
    }
    if (
      record.type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      return [{ type: "image", data: record.data, mimeType: record.mimeType }];
    }
    return [];
  });
}
