import type { BotConfig } from "./config.js";
import { classifyProviderAdapterError, createOpenAICompatibleReviewAdapter } from "./provider-adapters.js";
import { createPinnedProviderFetch } from "./providers.js";
import { codexReviewOutputSchema } from "./codex-runtime.js";
import { emptyReviewModelSummary, parseReviewModelSummary } from "./zcode.js";
import { parseFindings } from "./findings.js";

export class UntrustedProviderUnavailable extends Error {}
/** A fast transport failure (DNS, connection, 5xx other than a gateway timeout); retried in-run because a failed head is not requeued. */
class UntrustedProviderTransient extends Error {}

/** A 429 from this lane defers only the routed head; the repository-wide provider cooldown stays for the main runtime. */
export const UNTRUSTED_PROVIDER_THROTTLE_MESSAGE = "Untrusted author provider review failed (throttle): provider rate limit.";
export function isUntrustedProviderThrottle(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(UNTRUSTED_PROVIDER_THROTTLE_MESSAGE);
}

type UntrustedProviderReviewInput = {
  config: BotConfig; prompt: string; providerApiKeys?: Record<string, string>; lcmReviewAssessment?: boolean;
};

/** Shared by PR and local review; the provider receives only the prompt, never a checkout or tools. */
export async function runUntrustedProviderReview(input: UntrustedProviderReviewInput) {
  const { transientRetryAttempts, transientRetryBaseDelayMs, transientRetryMaxDelayMs } = input.config.providerCooldown;
  for (let attempt = 1; ; attempt += 1) {
    try { return await runUntrustedProviderReviewOnce(input); }
    catch (error) {
      if (!(error instanceof UntrustedProviderTransient) || attempt > transientRetryAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(transientRetryMaxDelayMs, transientRetryBaseDelayMs * 2 ** (attempt - 1))));
    }
  }
}

async function runUntrustedProviderReviewOnce(input: UntrustedProviderReviewInput) {
  const providerId = input.config.untrustedProviderLane!.providerId;
  const provider = input.config.providers!.providers[providerId]!;
  const env = input.providerApiKeys ? { [provider.apiKeyEnv!]: input.providerApiKeys[providerId] } : process.env;
  const key = env[provider.apiKeyEnv!];
  if (!key) throw new UntrustedProviderUnavailable("Missing API key for untrusted author provider.");
  let fetchImpl: typeof fetch;
  try { fetchImpl = await createPinnedProviderFetch({ baseUrl: provider.baseUrl!, provider }); }
  catch (error) {
    // A lookup that failed or timed out is transient and retried; an unsafe or invalid target is terminal for the head.
    if (/DNS lookup (?:timed out|failed)/.test(error instanceof Error ? error.message : "")) throw new UntrustedProviderTransient("Untrusted author provider DNS lookup failed (transient).");
    throw new UntrustedProviderUnavailable("Untrusted author provider target/DNS validation failed.");
  }
  const startedAt = new Date();
  try {
    // The shared prompt asks for a summary (and the lcm-x assessment); a schema-constrained provider must be allowed both.
    const output = await createOpenAICompatibleReviewAdapter({ provider, providerId, env, fetchImpl, pinnedTransport: true,
      responseSchema: codexReviewOutputSchema({ checkoutReads: false, lcmReviewAssessment: input.lcmReviewAssessment }) }).execute({ fixtureId: "untrusted-author-review", providerId, prompt: input.prompt, model: provider.model, adapterId: "openai-compatible" });
    const completedAt = new Date();
    const parsed = JSON.parse(output.text);
    // A schema-feedback retry that rescued the output is a degraded recovery, as for the other runtimes.
    const evidence = output.rawEvidence as { schemaRetries?: unknown } | undefined;
    const schemaRetries = typeof evidence?.schemaRetries === "number" ? evidence.schemaRetries : 0;
    const attempts = 1 + schemaRetries;
    const { findings, dropped } = parseFindings(parsed);
    return { findings, droppedFromSchema: dropped, summary: parsed.summary == null ? emptyReviewModelSummary("Configured provider returned no structured summary.") : parseReviewModelSummary(parsed, findings.length),
      rawResponse: output.text, attempts, degradedRecovery: attempts > 1, runtime: {
      provider: providerId, model: provider.model, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(), providerAttempts: attempts,
      notes: ["Runtime: openai-compatible; configured provider review with no repository or tool access."]
    } };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split(key).join("[redacted-provider-key]");
    // Decide from the adapter's leading status first; the response body is untrusted and may quote other statuses or words.
    const status = /^OpenAI-compatible chat completions endpoint returned (\d{3})\b/.exec(message)?.[1];
    if (status === "401" || status === "403") throw new UntrustedProviderUnavailable("Untrusted author provider authentication failed.");
    const category = status === "429" ? "throttle" : classifyProviderAdapterError(message);
    // The worker's cooldown path (classifyProviderError) keys on "rate limit"; keep that signal for a 429.
    if (category === "throttle") throw new Error(UNTRUSTED_PROVIDER_THROTTLE_MESSAGE);
    // Discard untrusted response/error text. Fast transport failures are retried above; a timeout already spent its budget.
    const failure = `Untrusted author provider review failed (${category}).`;
    if ((status !== undefined && status.startsWith("5") && status !== "504") || (status === undefined && category === "network")) {
      throw new UntrustedProviderTransient(failure);
    }
    throw new Error(failure);
  }
}
