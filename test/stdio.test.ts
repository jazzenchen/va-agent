import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

test("serves ACP initialize over stdio without polluting stdout", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "va-agent-stdio-"));
  try {
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIBEAROUND_AGENT_DIR: agentDir,
        VIBEAROUND_MODEL_API_KEY: "test-key",
        VIBEAROUND_MODEL_CONFIG: JSON.stringify({
          api: "openai-responses",
          baseUrl: "https://model-api.example.test/v1",
          model: "test-model",
          provider: "vibearound-test",
        }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    child.stdin.end(`${[
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: agentDir, mcpServers: [] },
      },
    ].map((message) => JSON.stringify(message)).join("\n")}\n`);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, "");

    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    const responses = lines.map((line) => JSON.parse(line));
    const initialize = responses.find((response) => response.id === 1);
    assert.equal(initialize.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(initialize.result.agentInfo.name, "va-agent");
    assert.equal(initialize.result.agentCapabilities.loadSession, true);
    assert.deepEqual(
      initialize.result.agentCapabilities.sessionCapabilities,
      { resume: {} },
    );
    const newSession = responses.find((response) => response.id === 2);
    assert.equal(typeof newSession.result.sessionId, "string");
    assert.ok(newSession.result.sessionId.length > 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
