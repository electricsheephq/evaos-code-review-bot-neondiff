import { afterEach, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { isRoutedToUntrustedProvider, buildUntrustedProviderReviewConfig } from "../src/public-repo-author-gate.js";

export const provider = { enabled: true, adapter: "openai-compatible", authMode: "api-key-env", apiKeyEnv: "FIXTURE_PROVIDER_KEY",
  baseUrl: "https://provider.example/v1", model: "fixture-model", capabilities: { review: true, jsonOutput: true, local: false, streaming: false } };
export function laneConfig() {
  return loadConfigFromObject({ codexRuntime: { enabled: true },
    reviewGate: { publicRepoAuthorGate: { mode: "on", untrustedAuthorReview: { mode: "provider", providerId: "fixture" } }, selfConsistency: { enabled: true } },
    providers: { providers: { fixture: provider } } });
}
afterEach(() => vi.unstubAllEnvs());
it("routes only blocked authors", () => {
  const cfg = laneConfig();
  for (const [association, login, visibility, mode, expected] of [
    ["NONE", "stranger", "public", "on", true], ["NONE", "stranger", "unknown", "on", true],
    ["OWNER", "owner", "public", "on", false], ["NONE", "dependabot[bot]", "public", "on", false],
    ["NONE", "stranger", "private", "on", false], ["NONE", "stranger", "public", "off", false]
  ] as const) {
    cfg.reviewGate!.publicRepoAuthorGate!.mode = mode;
    expect(isRoutedToUntrustedProvider(cfg, { authorAssociation: association, authorLogin: login }, visibility)).toBe(expected);
  }
  cfg.reviewGate!.publicRepoAuthorGate!.mode = "auto";
  vi.stubEnv("CODEX_API_KEY", "fixture"); vi.stubEnv("CODEX_HOME", "/nonexistent-fixture-home");
  expect(isRoutedToUntrustedProvider(cfg, { authorAssociation: "NONE" }, "public")).toBe(false);
});
it("default and explicit skip preserve author blocking", () => {
  for (const extra of [undefined, { mode: "skip" as const }]) {
    const cfg = loadConfigFromObject({ reviewGate: { publicRepoAuthorGate: { mode: "on", untrustedAuthorReview: extra } } });
    expect(isRoutedToUntrustedProvider(cfg, { authorAssociation: "NONE" }, "public")).toBe(false);
  }
});
it("derived config disables CLI execution and extra draws without mutating the base", () => {
  const cfg = laneConfig(); const derived = buildUntrustedProviderReviewConfig(cfg, "fixture");
  expect(derived.codexRuntime?.enabled).toBe(false);
  expect(derived.reviewGate?.selfConsistency?.enabled).toBe(false);
  expect(derived.reviewEnsemble?.enabled).toBe(false);
  expect(derived.untrustedProviderLane).toEqual({ providerId: "fixture" });
  expect(cfg.codexRuntime?.enabled).toBe(true); expect(cfg.reviewGate?.selfConsistency?.enabled).toBe(true);
});
it("validates lane config without requiring the key in the environment", () => {
  expect(() => laneConfig()).not.toThrow();
  for (const patch of [{ enabled: false }, { adapter: "zcode" }, { authMode: "none" }, { apiKeyEnv: "" }, { baseUrl: "http://provider.example" }, { model: "" }]) {
    expect(() => loadConfigFromObject({ reviewGate: { publicRepoAuthorGate: { untrustedAuthorReview: { mode: "provider", providerId: "fixture" } } },
      providers: { providers: { fixture: { ...provider, ...patch } } } })).toThrow();
  }
  for (const lane of [{ mode: "provider" }, { mode: "provider", providerId: "missing" }, { mode: "skip", unknown: true }]) {
    expect(() => loadConfigFromObject({ reviewGate: { publicRepoAuthorGate: { untrustedAuthorReview: lane } } })).toThrow();
  }
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import * as providers from "../src/providers.js";
import * as codex from "../src/codex-runtime.js";
import * as zcode from "../src/zcode.js";
import type { GitHubApi } from "../src/github.js";
import type { PullRequestSummary } from "../src/types.js";
import { ReviewStateStore } from "../src/state.js";
import { recordPublicRepoAuthorGateSkip, reviewPull } from "../src/worker.js";
import { runScheduledCycleWithDeps } from "../src/scheduler.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

vi.mock("../src/git.js", async original => ({ ...await original<object>(),
  preparePullWorktree: vi.fn(async ({ workRoot, expectedHeadSha }) => {
    mkdirSync(join(workRoot, "checkout"), { recursive: true }); return { path: join(workRoot, "checkout"), headSha: expectedHeadSha };
  }), assertGitClean: vi.fn()
}));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nd-untrusted-provider-")); roots.push(root);
  const cfg = laneConfig(); cfg.evidenceDir = join(root, "evidence"); cfg.workRoot = join(root, "work"); cfg.statePath = join(root, "state.sqlite");
  cfg.pilotRepos = ["org/repo"]; cfg.repoProfiles = { repos: { "org/repo": { enabled: true } } } as typeof cfg.repoProfiles;
  cfg.commands.enabled = false; cfg.walkthrough!.enabled = false; cfg.activation!.reviewExistingOpenPrsOnActivation = true;
  cfg.providers!.providers.fixture!.contextWindowTokens = 12000;
  cfg.zcode.maxPatchBytes = 100000;
  cfg.contextBudget = { ...cfg.contextBudget!, enabled: true, overflow: "chunk", reservedOutputTokens: 100, maxChunks: 8 };
  const pull: PullRequestSummary = { number: 1, title: "Stranger fixture", body: "Fixture PR text", draft: false, state: "open", authorAssociation: "NONE", authorLogin: "stranger",
    html_url: "https://github.com/org/repo/pull/1", head: { sha: "a".repeat(40), ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "org/repo", visibility: "public" } } };
  const files = Array.from({ length: 4 }, (_, i) => ({ filename: `src/file${i}.ts`, status: "modified", additions: 1, deletions: 1,
    patch: `@@ -1 +1 @@\n-old\n+${"x".repeat(20000)}`, patchComplete: true }));
  const github = { listPullFiles: async () => files, getPull: async () => pull, listIssueComments: async () => [],
    listPullReviewComments: async () => [], canPost: () => false, canPostAsApp: () => true } as unknown as GitHubApi;
  const state = new ReviewStateStore(cfg.statePath);
  return { cfg, pull, files, github, state, root };
}
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [{
  severity: "P1", path: "src/file0.ts", line: 1, title: "Loses pending records", body: "The changed assignment discards pending records before they are persisted.",
  confidence: 0.99, category: "data_loss", why_this_matters: "Pending records are lost."
}], summary: "Fixture review completed." }) } }] }));
function allEvidence(root: string): string {
  return readdirSync(root, { withFileTypes: true }).map(x => x.isDirectory() ? allEvidence(join(root, x.name)) : readFileSync(join(root, x.name), "utf8")).join("\n");
}
it("routed chunk review never invokes Codex, probes, ZCode or extra draws; prompt and body are tool-less", async () => {
  const f = fixture();
  f.cfg.reviewEnsemble = { enabled: true, mode: "shadow" };
  const cli = [vi.spyOn(codex, "runCodexReview"), vi.spyOn(codex, "runCodexStructuredOutput"), vi.spyOn(codex, "resolveCheckoutReadsStatus"),
    vi.spyOn(zcode, "runZCodeReview"), vi.spyOn(zcode, "runZCodeRawJson")];
  for (const spy of cli) spy.mockImplementation(() => { throw new Error("CLI invocation forbidden"); });
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response(); });
  vi.spyOn(providers, "createPinnedProviderFetch").mockResolvedValue(fetch as typeof globalThis.fetch);
  const logs = (["warn", "log", "error", "info", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
  const key = "fixture-key-NEVER-EVIDENCE-719";
  try {
    expect(await reviewPull({ config: f.cfg, github: f.github, state: f.state, repo: "org/repo", pull: f.pull, dryRun: true,
      useZCode: true, providerApiKeys: { fixture: key }, licenseAdmission: testLicenseAdmission })).toBe("reviewed");
    expect(fetch.mock.calls.length).toBeGreaterThan(1); // Really exercised the chunk branch.
    for (const spy of cli) expect(spy).not.toHaveBeenCalled();
    for (const body of bodies) {
      expect(body).not.toHaveProperty("tools"); expect(body).not.toHaveProperty("functions");
      const prompt = JSON.stringify(body.messages);
      expect(prompt).toContain("Stranger fixture"); expect(prompt).not.toContain("read-only checkout of"); expect(prompt).not.toContain("repo_wiki");
    }
    const evidence = allEvidence(f.cfg.evidenceDir);
    expect(evidence).toContain("untrusted_author_provider_lane"); expect(evidence).toContain("fixture-model");
    expect(evidence).not.toContain(key); expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(key);
  } finally { f.state.close(); }
});
it.each(["key", "dns", "auth"])("provider %s unavailable records once per head, clears on mode change", async reason => {
  const f = fixture(); f.cfg.contextBudget!.enabled = false;
  const fetch = vi.fn(async () => new Response("unauthorized fixture-key-NEVER-EVIDENCE-719", { status: 401 }));
  const actualPin = providers.createPinnedProviderFetch;
  const pin = vi.spyOn(providers, "createPinnedProviderFetch");
  if (reason === "dns") pin.mockImplementation(target => actualPin({ ...target, dnsLookupImpl: async () => [{ address: "169.254.169.254", family: 4 }] })); else pin.mockResolvedValue(fetch as typeof globalThis.fetch);
  try {
    const input = { config: f.cfg, github: f.github, state: f.state, repo: "org/repo", pull: f.pull, dryRun: true, useZCode: true,
      providerApiKeys: reason === "key" ? {} : { fixture: "fixture-key-NEVER-EVIDENCE-719" }, licenseAdmission: testLicenseAdmission };
    const record = vi.spyOn(f.state, "recordProcessed");
    expect(await reviewPull(input)).toBe("untrusted_author_provider_unavailable");
    expect(await reviewPull(input)).toBe("skipped_processed");
    expect(record.mock.calls.filter(([row]) => row.error === "untrusted_author_provider_unavailable")).toHaveLength(1);
    expect(allEvidence(f.cfg.evidenceDir)).not.toContain("fixture-key-NEVER-EVIDENCE-719");
    f.cfg.reviewGate!.publicRepoAuthorGate!.untrustedAuthorReview = { mode: "skip" };
    expect(recordPublicRepoAuthorGateSkip({ config: f.cfg, state: f.state, repo: "org/repo", pull: f.pull })).toBe(true);
    expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.error).toBe("untrusted_author_public_repo");
  } finally { f.state.close(); }
});
it.each([429, 500, 503])("HTTP %i remains an ordinary review failure", async status => {
  const f = fixture(); f.cfg.contextBudget!.enabled = false;
  vi.spyOn(providers, "createPinnedProviderFetch").mockResolvedValue((async () => new Response("temporary", { status })) as typeof fetch);
  try {
    await expect(reviewPull({ config: f.cfg, github: f.github, state: f.state, repo: "org/repo", pull: f.pull, dryRun: true,
      useZCode: true, providerApiKeys: { fixture: "fixture" }, licenseAdmission: testLicenseAdmission })).rejects.toThrow("provider review failed");
    expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.status).not.toBe("skipped");
  } finally { f.state.close(); }
});
it("scheduler skip-to-provider admits discovery and queued heads without skippedPolicy", async () => {
  for (const queued of [false, true]) {
    const f = fixture(); f.cfg.reviewScheduler!.enabled = true;
    const gate = f.cfg.reviewGate!.publicRepoAuthorGate!;
    gate.untrustedAuthorReview = { mode: "skip" };
    try {
      expect(recordPublicRepoAuthorGateSkip({ config: f.cfg, state: f.state, repo: "org/repo", pull: f.pull })).toBe(true);
      gate.untrustedAuthorReview = { mode: "provider", providerId: "fixture" };
      if (queued) f.state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, baseSha: f.pull.base.sha });
      const review = vi.fn(async () => "reviewed" as const);
      const result = await runScheduledCycleWithDeps({ config: f.cfg, state: f.state,
        github: { ...f.github, listOpenPulls: async () => [f.pull] }, options: { dryRun: true }, reviewPullImpl: review, licenseAdmission: testLicenseAdmission });
      expect(result.skippedPolicy).toBe(0); expect(review).toHaveBeenCalled();
      expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.error).not.toBe("untrusted_author_public_repo");
      gate.untrustedAuthorReview = { mode: "skip" };
      expect(recordPublicRepoAuthorGateSkip({ config: f.cfg, state: f.state, repo: "org/repo", pull: f.pull })).toBe(true);
      expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.error).toBe("untrusted_author_public_repo");
    } finally { f.state.close(); }
  }
});
it("pinned POST uses validated DNS and SNI, preserves body, and refuses redirects and unsafe answers", async () => {
  const addresses = [{ address: "93.184.216.34", family: 4 }];
  const dns = vi.fn(async () => addresses);
  const sent: unknown[] = [];
  const request = vi.fn((options, callback) => {
    expect(options.method).toBe("POST"); expect(options.servername).toBe("provider.example");
    const lookup = vi.fn(); options.lookup("provider.example", {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const handle = new EventEmitter() as EventEmitter & { end: (body?: string) => void; destroy: () => void };
    handle.destroy = vi.fn();
    handle.end = body => { sent.push(body); const res = new EventEmitter() as IncomingMessage; res.statusCode = 302;
      res.headers = { location: "https://169.254.169.254/" }; res.destroy = vi.fn() as IncomingMessage["destroy"]; callback(res); };
    return handle;
  });
  const fetch = await providers.createPinnedProviderFetch({ baseUrl: provider.baseUrl, provider: provider as providers.ProviderRegistryEntry, dnsLookupImpl: dns, requestImpl: request });
  addresses[0] = { address: "169.254.169.254", family: 4 }; // DNS rebinding after validation cannot change the socket target.
  const result = await fetch("https://provider.example/v1/chat/completions", { method: "POST", body: "{}" });
  expect(result.status).toBe(302); expect(sent).toEqual(["{}"]); expect(dns).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  await expect(providers.createPinnedProviderFetch({ baseUrl: provider.baseUrl, provider: provider as providers.ProviderRegistryEntry,
    dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }] })).rejects.toThrow();
});

it("provider errors never expose the API key in thrown text or logs", async () => {
  const { runUntrustedProviderReview } = await import("../src/untrusted-provider-review.js");
  const key = "fixture-key-NEVER-EVIDENCE-719";
  vi.spyOn(providers, "createPinnedProviderFetch").mockResolvedValue((async () => { throw new Error(`socket failure ${key}`); }) as typeof fetch);
  const config = buildUntrustedProviderReviewConfig(laneConfig(), "fixture");
  await expect(runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: key } })).rejects.toThrow("provider review failed");
  try { await runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: key } }); }
  catch (error) { expect(String(error)).not.toContain(key); }
});

it("accepts the adapter's findings-only schema and keeps the provider's schema-repair retries", async () => {
  const { runUntrustedProviderReview } = await import("../src/untrusted-provider-review.js");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] })));
  vi.spyOn(providers, "createPinnedProviderFetch").mockResolvedValue(fetch as typeof globalThis.fetch);
  const config = buildUntrustedProviderReviewConfig(laneConfig(), "fixture"); config.providers!.providers.fixture!.retrySchemaFeedbackMax = 2;
  expect(await runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: "fixture" } })).toMatchObject({
    findings: [], attempts: 1, runtime: { provider: "fixture", model: "fixture-model" }, summary: { limitations: expect.any(Array) }
  });
  expect(fetch).toHaveBeenCalledOnce(); fetch.mockClear();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "invalid" } }] })));
  await expect(runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: "fixture" } })).rejects.toThrow();
  // One draw plus the two configured schema-repair retries; a weaker provider often fixes its JSON on feedback.
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("treats a DNS lookup failure as transient and an unsafe DNS answer as terminal", async () => {
  const { runUntrustedProviderReview, UntrustedProviderUnavailable } = await import("../src/untrusted-provider-review.js");
  const config = buildUntrustedProviderReviewConfig(laneConfig(), "fixture");
  const pin = vi.spyOn(providers, "createPinnedProviderFetch");
  pin.mockRejectedValueOnce(new Error("Remote OpenAI-compatible smoke DNS lookup timed out."));
  const transient = await runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: "fixture" } }).catch(error => error);
  expect(transient).toBeInstanceOf(Error);
  expect(transient).not.toBeInstanceOf(UntrustedProviderUnavailable);
  pin.mockRejectedValueOnce(new Error("Remote OpenAI-compatible smoke DNS resolved to an unsafe private, link-local, loopback, or metadata address."));
  await expect(runUntrustedProviderReview({ config, prompt: "fixture", providerApiKeys: { fixture: "fixture" } })).rejects.toBeInstanceOf(UntrustedProviderUnavailable);
});
