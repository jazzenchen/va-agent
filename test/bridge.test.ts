import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  eventToSessionUpdate,
  historyToSessionUpdates,
  promptToText,
} from "../src/pi-acp-bridge.ts";

test("converts ACP text and resource links to one Pi prompt", () => {
  assert.equal(
    promptToText([
      { type: "text", text: "Inspect this" },
      { type: "resource_link", name: "README", uri: "file:///repo/README.md" },
    ]),
    "Inspect this\n\nREADME: file:///repo/README.md",
  );
});

test("maps Pi text deltas to ACP message chunks", () => {
  const event = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  } as AgentSessionEvent;

  assert.deepEqual(eventToSessionUpdate(event), {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello" },
  });
});

test("maps the Pi tool lifecycle to ACP tool calls and updates", () => {
  assert.deepEqual(eventToSessionUpdate({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "pwd" },
  }), {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "bash",
    name: "bash",
    kind: "execute",
    status: "pending",
    rawInput: { command: "pwd" },
  });

  assert.deepEqual(eventToSessionUpdate({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "pwd" },
    partialResult: { content: [{ type: "text", text: "/repo" }] },
  }), {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "in_progress",
    rawOutput: { content: [{ type: "text", text: "/repo" }] },
  });

  assert.deepEqual(eventToSessionUpdate({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  }), {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    content: [{
      type: "content",
      content: { type: "text", text: "done" },
    }],
    rawOutput: { content: [{ type: "text", text: "done" }] },
  });
});

test("replays text, thought, and tool history from the active Pi branch", () => {
  const entries = [{
    type: "message",
    id: "1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "question", timestamp: 1 },
  }, {
    type: "message",
    id: "2",
    parentId: "1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
    },
  }, {
    type: "message",
    id: "3",
    parentId: "2",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      details: { path: "README.md" },
      isError: false,
      timestamp: 3,
    },
  }] as unknown as SessionEntry[];

  assert.deepEqual(historyToSessionUpdates(entries), [
    {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "question" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "reason" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read",
      name: "read",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{
        type: "content",
        content: { type: "text", text: "contents" },
      }],
      rawOutput: {
        content: [{ type: "text", text: "contents" }],
        details: { path: "README.md" },
      },
    },
  ]);
});
