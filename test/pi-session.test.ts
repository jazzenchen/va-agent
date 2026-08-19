import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createModelLaunch } from "../src/model-runtime.ts";
import type { McpBinding } from "../src/mcp-over-acp.ts";
import { createPiSessionFactory } from "../src/sessions.ts";

const noMcp: McpBinding = {
  servers: [],
  transport: {
    connect: () => Promise.reject(new Error("no MCP in this test")),
    message: () => Promise.reject(new Error("no MCP in this test")),
    notify: () => Promise.reject(new Error("no MCP in this test")),
    disconnect: () => Promise.reject(new Error("no MCP in this test")),
  },
};

test("creates a real Pi session without global Pi installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "va-agent-pi-"));
  try {
    const launch = await createModelLaunch(
      join(root, "data"),
      {
        api: "openai-responses",
        baseUrl: "https://model-api.example.test/v1",
        model: "test-model",
        provider: "vibearound-test",
      },
      "test-key",
    );
    const agentDir = join(root, "data", "agents", "va-agent");
    const factory = createPiSessionFactory(
      agentDir,
      join(root, "data"),
      launch.modelRuntime,
      launch.model,
    );
    const session = await factory.create(root, async () => true, noMcp);
    assert.ok(session.sessionId.length > 0);
    const newSessionId = session.sessionId;
    session.dispose();

    const reopened = await factory.resume(newSessionId, root, async () => true, noMcp);
    assert.equal(reopened.sessionId, newSessionId);
    assert.deepEqual(reopened.history(), []);
    reopened.dispose();

    const sessionDir = join(agentDir, "sessions");
    const saved = SessionManager.create(root, sessionDir, { id: "saved-id" });
    saved.appendMessage({
      role: "user",
      content: "saved question",
      timestamp: Date.now(),
    });
    saved.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "saved answer" }],
      api: "openai-responses",
      provider: "vibearound-test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const resumed = await factory.resume("saved-id", root, async () => true, noMcp);
    assert.deepEqual(resumed.history(), [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "saved question" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "saved answer" },
      },
    ]);
    resumed.dispose();
    await assert.rejects(
      factory.resume("saved-id", join(root, "other-cwd"), async () => true, noMcp),
      /Session not found: saved-id/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
