import type { BotConfig } from "./config.js";
import { classifyProviderAdapterError, createOpenAICompatibleReviewAdapter } from "./provider-adapters.js";
import { createPinnedProviderFetch } from "./providers.js";
import { emptyReviewModelSummary, parseReviewModelSummary } from "./zcode.js";
import { parseFindings } from "./findings.js";

export class UntrustedProviderUnavailable extends Error {}

/** Shared by PR and local review; the provider receives only the prompt, never a checkout or tools. */
export async function runUntrustedProviderReview(input: {
  config: BotConfig; prompt: string; providerApiKeys?: Record<string, string>;
}) {
  const providerId = input.config.untrustedProviderLane!.providerId;
  const provider = input.config.providers!.providers[providerId]!;
  const env = input.providerApiKeys ? { [provider.apiKeyEnv!]: input.providerApiKeys[providerId] } : process.env;
  const key = env[provider.apiKeyEnv!];
  if (!key) throw new UntrustedProviderUnavailable("Missing API key for untrusted author provider.");
  let fetchImpl: typeof fetch;
  try { fetchImpl = await createPinnedProviderFetch({ baseUrl: provider.baseUrl!, provider }); }
  catch (error) {
    // A lookup that failed or timed out is transient and retried; an unsafe or invalid target is terminal for the head.
    if (/DNS lookup (?:timed out|failed)/.test(error instanceof Error ? error.message : "")) throw new Error("Untrusted author provider DNS lookup failed (transient).");
    throw new UntrustedProviderUnavailable("Untrusted author provider target/DNS validation failed.");
  }
  const startedAt = new Date();
  try {
    const output = await createOpenAICompatibleReviewAdapter({ provider, providerId,
      env, fetchImpl, pinnedTransport: true }).execute({ fixtureId: "untrusted-author-review", providerId, prompt: input.prompt, model: provider.model, adapterId: "openai-compatible" });
    const completedAt = new Date();
    const parsed = JSON.parse(output.text);
    const { findings, dropped } = parseFindings(parsed);
    return { findings, droppedFromSchema: dropped, summary: parsed.summary === undefined ? emptyReviewModelSummary("Configured provider returned no structured summary.") : parseReviewModelSummary(parsed, findings.length),
      rawResponse: output.text, attempts: 1, degradedRecovery: false, runtime: {
      provider: providerId, model: provider.model, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(), providerAttempts: 1,
      notes: ["Runtime: openai-compatible; configured provider review with no repository or tool access."]
    } };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split(key).join("[redacted-provider-key]");
    const category = classifyProviderAdapterError(message);
    // Decide auth from the status only: an upstream relay error body (e.g. a 503 quoting "403") stays retryable.
    if (/endpoint returned (?:401|403) auth failure/.test(message)) throw new UntrustedProviderUnavailable("Untrusted author provider authentication failed.");
    // Keep transient failures retryable while discarding untrusted response/error text.
    throw new Error(`Untrusted author provider review failed (${category}).`);
  }
}
