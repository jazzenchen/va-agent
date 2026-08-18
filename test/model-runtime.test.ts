import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createModelLaunch,
  MODEL_API_KEY_ENV,
  MODEL_CONFIG_ENV,
  readModelEnvironment,
} from "../src/model-runtime.ts";

const validConfig = {
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:12358/va/local-api/test/va-agent/openai-responses/v1",
  model: "test-model",
  provider: "vibearound-test",
};

test("reads the model definition and API key from separate environment variables", () => {
  const result = readModelEnvironment({
    [MODEL_CONFIG_ENV]: JSON.stringify(validConfig),
    [MODEL_API_KEY_ENV]: "test-key",
  });

  assert.deepEqual(result, { config: validConfig, apiKey: "test-key" });
});

test("rejects secrets and unknown fields in the model JSON", () => {
  assert.throws(
    () =>
      readModelEnvironment({
        [MODEL_CONFIG_ENV]: JSON.stringify({
          ...validConfig,
          apiKey: "must-not-be-here",
        }),
        [MODEL_API_KEY_ENV]: "test-key",
      }),
    /VIBEAROUND_MODEL_CONFIG is invalid.*Unrecognized key/u,
  );
});

test("rejects missing credentials and invalid model limits", () => {
  assert.throws(
    () =>
      readModelEnvironment({
        [MODEL_CONFIG_ENV]: JSON.stringify(validConfig),
      }),
    /VIBEAROUND_MODEL_API_KEY is required/u,
  );
  assert.throws(
    () =>
      readModelEnvironment({
        [MODEL_CONFIG_ENV]: JSON.stringify({
          ...validConfig,
          contextWindow: 1_000,
          maxTokens: 2_000,
        }),
        [MODEL_API_KEY_ENV]: "test-key",
      }),
    /maxTokens: must not exceed contextWindow/u,
  );
});

test("registers the configured model and runtime-only API key with Pi", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "va-agent-model-"));
  try {
    const launch = await createModelLaunch(agentDir, validConfig, "test-key");

    assert.equal(launch.model.provider, "vibearound-test");
    assert.equal(launch.model.id, "test-model");
    assert.equal(launch.model.api, "openai-responses");
    assert.equal(launch.model.baseUrl, validConfig.baseUrl);
    assert.equal(launch.model.contextWindow, 128_000);
    assert.equal(launch.model.maxTokens, 16_384);

    const auth = await launch.modelRuntime.getAuth(launch.model);
    assert.equal(auth?.auth.apiKey, "test-key");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
