import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";

export function promptToText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return `${block.name}: ${block.uri}`;
      }
      throw new Error(`Unsupported prompt content: ${block.type}`);
    })
    .join("\n\n");
}

export function eventToSessionUpdate(
  event: AgentSessionEvent,
): SessionUpdate | undefined {
  if (event.type === "tool_execution_start") {
    return toolCall(event.toolCallId, event.toolName, event.args);
  }
  if (event.type === "tool_execution_update") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      rawOutput: event.partialResult,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      content: toolResultContent(event.result),
      rawOutput: event.result,
    };
  }
  if (event.type !== "message_update") {
    return undefined;
  }

  const update = event.assistantMessageEvent;
  if (update.type === "text_delta") {
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: update.delta },
    };
  }
  if (update.type === "thinking_delta") {
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: update.delta },
    };
  }
  return undefined;
}

export function historyToSessionUpdates(entries: readonly SessionEntry[]): SessionUpdate[] {
  const updates: SessionUpdate[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }

    const message = entry.message;
    if (message.role === "user") {
      for (const content of textAndImageContent(message.content)) {
        updates.push({ sessionUpdate: "user_message_chunk", content });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "text") {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: content.text },
          });
        } else if (content.type === "thinking") {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: content.thinking },
          });
        } else if (content.type === "toolCall") {
          updates.push(toolCall(
            content.id,
            content.name,
            content.arguments,
          ));
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: message.toolCallId,
        status: message.isError ? "failed" : "completed",
        content: toolResultContent(message),
        rawOutput: {
          content: message.content,
          details: message.details,
        },
      });
    }
  }

  return updates;
}

export function toolCallInProgress(toolCallId: string): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
  };
}

export function toolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "grep":
    case "find":
    case "ls":
      return "search";
    case "edit":
    case "write":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

function toolCall(
  toolCallId: string,
  toolName: string,
  args: unknown,
): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: toolName,
    name: toolName,
    kind: toolKind(toolName),
    status: "pending",
    rawInput: args,
  };
}

function textAndImageContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block): ContentBlock[] => {
    if (isTextBlock(block)) {
      return [{ type: "text", text: block.text }];
    }
    if (isImageBlock(block)) {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }
    return [];
  });
}

function toolResultContent(result: unknown): ToolCallContent[] | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const mapped = content.flatMap((block): ToolCallContent[] => {
    if (isTextBlock(block)) {
      return [{
        type: "content",
        content: { type: "text", text: block.text },
      }];
    }
    if (isImageBlock(block)) {
      return [{
        type: "content",
        content: {
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        },
      }];
    }
    return [];
  });
  return mapped.length > 0 ? mapped : undefined;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "text" &&
      typeof (value as { text?: unknown }).text === "string",
  );
}

function isImageBlock(value: unknown): value is {
  type: "image";
  data: string;
  mimeType: string;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "image" &&
      typeof (value as { data?: unknown }).data === "string" &&
      typeof (value as { mimeType?: unknown }).mimeType === "string",
  );
}
