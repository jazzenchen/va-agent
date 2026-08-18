import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import type { McpBinding } from "../src/mcp-over-acp.ts";
import {
  Sessions,
  toolAccess,
  type BeforeToolCall,
  type SessionFactory,
  type SessionLike,
} from "../src/sessions.ts";

class FakeSession implements SessionLike {
  readonly sessionId: string;
  readonly historyUpdates: SessionUpdate[];
  promptText: string | undefined;
  aborted = false;
  disposed = false;
  runPrompt: (() => Promise<void>) | undefined;
  #listener: ((event: AgentSessionEvent) => void) | undefined;
  #finishPrompt: (() => void) | undefined;

  constructor(
    sessionId = "session-1",
    historyUpdates: SessionUpdate[] = [],
  ) {
    this.sessionId = sessionId;
    this.historyUpdates = historyUpdates;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  history(): SessionUpdate[] {
    return [...this.historyUpdates];
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }

  async prompt(text: string): Promise<void> {
    this.promptText = text;
    if (this.runPrompt) {
      await this.runPrompt();
      return;
    }
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    } as AgentSessionEvent);
    await new Promise<void>((resolve) => {
      this.#finishPrompt = resolve;
      queueMicrotask(resolve);
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#finishPrompt?.();
  }

  dispose(): void {
    this.disposed = true;
  }
}

function factoryFor(
  session: FakeSession,
  capture?: (beforeToolCall: BeforeToolCall) => void,
): SessionFactory {
  return {
    async create(_cwd, beforeToolCall) {
      capture?.(beforeToolCall);
      return session;
    },
    async resume(_sessionId, _cwd, beforeToolCall) {
      capture?.(beforeToolCall);
      return session;
    },
  };
}

const allow = async () => true;
const noMcp: McpBinding = {
  servers: [],
  transport: {
    connect: () => Promise.reject(new Error("no MCP in this test")),
    message: () => Promise.reject(new Error("no MCP in this test")),
    notify: () => Promise.reject(new Error("no MCP in this test")),
    disconnect: () => Promise.reject(new Error("no MCP in this test")),
  },
};

test("creates a session and streams a completed prompt", async () => {
  const fake = new FakeSession();
  const sessions = new Sessions(factoryFor(fake));
  assert.equal(await sessions.create("/repo", allow, noMcp), "session-1");

  const updates: unknown[] = [];
  const stopReason = await sessions.prompt(
    "session-1",
    [{ type: "text", text: "question" }],
    async (update) => {
      updates.push(update);
    },
  );

  assert.equal(stopReason, "end_turn");
  assert.equal(fake.promptText, "question");
  assert.deepEqual(updates, [{
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "answer" },
  }]);
});

test("cancels the active Pi prompt", async () => {
  const fake = new FakeSession();
  const sessions = new Sessions(factoryFor(fake));
  await sessions.create("/repo", allow, noMcp);

  const prompting = sessions.prompt(
    "session-1",
    [{ type: "text", text: "question" }],
    async () => {},
  );
  await sessions.cancel("session-1");

  assert.equal(await prompting, "cancelled");
  assert.equal(fake.aborted, true);
});

test("maps Pi length and error outcomes instead of reporting a blank success", async () => {
  const fake = new FakeSession();
  const sessions = new Sessions(factoryFor(fake));
  await sessions.create("/repo", allow, noMcp);
  fake.runPrompt = async () => {
    fake.emit(assistantEnd("length"));
  };
  assert.equal(
    await sessions.prompt(fake.sessionId, [{ type: "text", text: "long" }], async () => {}),
    "max_tokens",
  );

  fake.runPrompt = async () => {
    fake.emit(assistantEnd("error", "upstream rejected the request"));
  };
  await assert.rejects(
    sessions.prompt(fake.sessionId, [{ type: "text", text: "fail" }], async () => {}),
    /upstream rejected the request/u,
  );
});

test("gates side-effect tools after the pending ACP update with the real session id", async () => {
  const fake = new FakeSession("real-session-id");
  let beforeToolCall: BeforeToolCall | undefined;
  const events: string[] = [];
  const sessions = new Sessions(factoryFor(fake, (gate) => {
    beforeToolCall = gate;
  }));
  await sessions.create("/repo", async (request) => {
    events.push(`permission:${request.sessionId}:${request.toolName}`);
    return true;
  }, noMcp);

  fake.runPrompt = async () => {
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    assert.equal(await beforeToolCall?.({
      sessionId: fake.sessionId,
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
      permissionRequired: false,
    }), true);
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });

    fake.emit({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "x", content: "y" },
    });
    assert.equal(await beforeToolCall?.({
      sessionId: fake.sessionId,
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "x", content: "y" },
      permissionRequired: true,
    }), true);
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "write-1",
      toolName: "write",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
  };

  await sessions.prompt(
    fake.sessionId,
    [{ type: "text", text: "use tools" }],
    async (update) => {
      if (update.sessionUpdate === "tool_call") {
        events.push(`pending:${update.toolCallId}`);
      } else if (update.sessionUpdate === "tool_call_update") {
        events.push(`${update.status}:${update.toolCallId}`);
      }
    },
  );

  assert.deepEqual(events, [
    "pending:read-1",
    "in_progress:read-1",
    "completed:read-1",
    "pending:write-1",
    "permission:real-session-id:write",
    "in_progress:write-1",
    "completed:write-1",
  ]);
});

test("does not move a denied side-effect tool to in_progress", async () => {
  const fake = new FakeSession();
  let beforeToolCall: BeforeToolCall | undefined;
  const statuses: Array<string | null | undefined> = [];
  const sessions = new Sessions(factoryFor(fake, (gate) => {
    beforeToolCall = gate;
  }));
  await sessions.create("/repo", async () => false, noMcp);

  fake.runPrompt = async () => {
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "touch denied" },
    });
    const allowed = await beforeToolCall?.({
      sessionId: fake.sessionId,
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "touch denied" },
      permissionRequired: true,
    });
    assert.equal(allowed, false);
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "bash-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Permission denied" }] },
      isError: true,
    });
  };

  await sessions.prompt(
    fake.sessionId,
    [{ type: "text", text: "run" }],
    async (update) => {
      if (update.sessionUpdate === "tool_call") {
        statuses.push(update.status);
      } else if (update.sessionUpdate === "tool_call_update") {
        statuses.push(update.status);
      }
    },
  );

  assert.deepEqual(statuses, ["pending", "failed"]);
});

test("only auto-allows real read-only targets inside the session workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-access-"));
  const dataDir = join(root, "data");
  const agentDir = join(dataDir, "agents", "va-agent");
  const cwd = join(dataDir, "workspaces", "project");
  const inside = join(cwd, "inside.txt");
  const sibling = join(dataDir, "workspaces", "sibling.txt");
  const outside = join(root, "outside.txt");
  const auth = join(dataDir, "local-api-auth.json");
  const outsideLink = join(cwd, "outside-link.txt");
  const authLink = join(cwd, "auth-link.json");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(inside, "inside");
    await writeFile(sibling, "sibling");
    await writeFile(outside, "outside");
    await writeFile(auth, "secret");
    try {
      await symlink(outside, outsideLink);
      await symlink(auth, authLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating symlinks is not permitted on this platform");
        return;
      }
      throw error;
    }

    // The built-in session id tool only reports agent state.
    assert.equal(await toolAccess("get_session_id", {}, cwd, agentDir), "auto_allow");
    // VibeAround MCP tools are gated like any other side-effect tool.
    assert.equal(
      await toolAccess("va_mcp_send_file", { file: "inside.txt" }, cwd, agentDir),
      "permission",
    );

    for (const [toolName, args] of [
      ["read", { path: "inside.txt" }],
      ["grep", { pattern: "inside", path: "." }],
      ["find", { pattern: "*.txt", path: "." }],
      ["ls", {}],
    ] as const) {
      assert.equal(
        await toolAccess(toolName, args, cwd, agentDir),
        "auto_allow",
        toolName,
      );
    }

    assert.equal(
      await toolAccess("read", { path: "../sibling.txt" }, cwd, agentDir),
      "permission",
    );
    assert.equal(
      await toolAccess("read", { path: outside }, cwd, agentDir),
      "permission",
    );
    assert.equal(
      await toolAccess("read", { path: outsideLink }, cwd, agentDir),
      "permission",
    );
    assert.equal(
      await toolAccess("read", { path: auth }, cwd, agentDir),
      "deny",
    );
    assert.equal(
      await toolAccess("read", { path: authLink }, cwd, agentDir),
      "deny",
    );
    assert.equal(
      await toolAccess(
        "read",
        { path: join(agentDir, "session.json") },
        cwd,
        agentDir,
      ),
      "deny",
    );
    assert.equal(
      relative(join(dataDir, "workspaces"), inside).startsWith(".."),
      false,
      "the fixture exercises the dataDir/workspaces exception",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a resumed session and replays its history in order", async () => {
  const history: SessionUpdate[] = [
    {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "question" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    },
  ];
  const fake = new FakeSession("saved-session", history);
  const sessions = new Sessions(factoryFor(fake));
  const replayed: SessionUpdate[] = [];

  await sessions.load(
    fake.sessionId,
    "/repo",
    allow,
    noMcp,
    async (update) => {
      replayed.push(update);
    },
  );

  assert.deepEqual(replayed, history);
});

function assistantEnd(
  stopReason: "length" | "error" | "aborted" | "stop",
  errorMessage?: string,
): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      errorMessage,
      timestamp: Date.now(),
    },
  } as AgentSessionEvent;
}
