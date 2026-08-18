import { join } from "node:path";

import {
  ModelRuntime,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const MODEL_CONFIG_ENV = "VIBEAROUND_MODEL_CONFIG";
export const MODEL_API_KEY_ENV = "VIBEAROUND_MODEL_API_KEY";

const modelConfigSchema = z
  .object({
    api: z.string().trim().min(1),
    baseUrl: z
      .string()
      .trim()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
        message: "must use http or https",
      }),
    model: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    input: z.array(z.enum(["text", "image"])).nonempty().optional(),
    reasoning: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authHeader: z.boolean().optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.contextWindow !== undefined &&
      config.maxTokens !== undefined &&
      config.maxTokens > config.contextWindow
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxTokens"],
        message: "must not exceed contextWindow",
      });
    }
  });

export type ModelConfig = z.infer<typeof modelConfigSchema>;
type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface ModelLaunch {
  modelRuntime: ModelRuntime;
  model: PiModel;
}

export function readModelEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): { config: ModelConfig; apiKey: string } {
  const rawConfig = requiredEnvironmentVariable(env, MODEL_CONFIG_ENV);
  const apiKey = requiredEnvironmentVariable(env, MODEL_API_KEY_ENV);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (cause) {
    throw new Error(`${MODEL_CONFIG_ENV} must be valid JSON`, { cause });
  }

  const result = modelConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${MODEL_CONFIG_ENV} is invalid: ${issues}`);
  }

  return { config: result.data, apiKey };
}

export async function createModelLaunch(
  agentDir: string,
  config: ModelConfig,
  apiKey: string,
): Promise<ModelLaunch> {
  const contextWindow = config.contextWindow ?? 128_000;
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(config.provider, {
    api: config.api,
    baseUrl: config.baseUrl,
    headers: config.headers,
    authHeader: config.authHeader,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: config.reasoning ?? false,
        input: config.input ?? ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: config.maxTokens ?? Math.min(contextWindow, 16_384),
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(config.provider, apiKey);

  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`Pi did not register model ${config.provider}/${config.model}`);
  }
  return { modelRuntime, model };
}

function requiredEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
