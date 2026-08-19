import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/// Pi's default system prompt opens by naming itself. Keep the rest of Pi's
/// prompt and only swap the identity sentence; the integration test pins the
/// anchor so a Pi upgrade that rewords it fails loudly instead of silently
/// leaving the model calling itself pi.
export const PI_IDENTITY_SENTENCE =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";
export const VA_IDENTITY_SENTENCE =
  "You are VibeAround Agent, VibeAround's built-in coding agent.";

export function applyIdentity(systemPrompt: string): string {
  return systemPrompt.replace(PI_IDENTITY_SENTENCE, VA_IDENTITY_SENTENCE);
}

export function identityExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: applyIdentity(event.systemPrompt),
    }));
  };
}
