import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runDocsDriftEval,
  runRepoWikiContextAbEval,
  type DocsDriftSeedClaim,
  type RepoWikiContextAbEvalInput
} from "../src/openwiki-eval-gates.js";
import { buildRepoWikiPacket, formatRepoWikiPacketJson } from "../src/repo-wiki-packet.js";

const generatedAt = "2026-07-09T09:10:00.000Z";
const repo = "electricsheephq/evaos-code-review-bot-neondiff";
const headSha = "b224ecc8146e4005ea471e3f1adc664e55828170";

describe("OpenWiki eval gates", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("passes A/B eval when deterministic and OpenWiki context preserve precision and P0/P1 noise", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-pass-"));
    roots.push(outputRoot);

    const result = runRepoWikiContextAbEval(buildAbInput(), {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(true);
    expect(result.summary.comparisons.openwiki).toMatchObject({
      precisionDelta: 0,
      p0p1FalsePositiveDelta: 0
    });
    expect(readFileSync(result.artifacts["repo-wiki-context-ab-report.md"]!, "utf8")).toContain("Repo-Wiki Context A/B Eval");
  });

  it("fails A/B eval when OpenWiki context adds a P1 false positive", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-fail-"));
    roots.push(outputRoot);
    const input = buildAbInput();
    input.modes.openwiki.botFindings = {
      findings: [
        buildReviewFinding(),
        {
          severity: "P1",
          path: "src/worker.ts",
          line: 33,
          title: "Provider fallback leaks paid tokens",
          body: "This unrelated finding claims paid fallback behavior without label support.",
          confidence: 0.9
        }
      ]
    };

    const result = runRepoWikiContextAbEval(input, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "openwiki_no_p0_p1_false_positive_regression",
      ok: false
    }));
  });

  it("passes docs-drift eval with source-cited suggestions and true-claim traps", () => {
    const { packetPath, root } = createDocsDriftFixture();
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-pass-"));
    roots.push(root, outputRoot);

    const result = runDocsDriftEval({
      runId: "seeded-docs-drift",
      repo,
      headSha,
      worktreePath: root,
      packetPath,
      claims: buildDocsDriftClaims()
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(true);
    expect(result.summary.counts).toMatchObject({
      staleCaught: 5,
      materialFalsePositives: 0,
      suggestions: 5
    });
    expect(result.summary.suggestions.every((suggestion) => suggestion.packetSectionIds.length > 0)).toBe(true);
    expect(readFileSync(result.artifacts["suggested-doc-edits.md"]!, "utf8")).toContain("Suggested Doc Edits");
  });

  it("fails docs-drift eval when a true trap would be rewritten", () => {
    const { packetPath, root } = createDocsDriftFixture({ trueTrapMismatch: true });
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-fail-"));
    roots.push(root, outputRoot);

    const result = runDocsDriftEval({
      runId: "seeded-docs-drift-fail",
      repo,
      headSha,
      worktreePath: root,
      packetPath,
      claims: buildDocsDriftClaims({ trueTrapMismatch: true }),
      thresholds: {
        maxMaterialFalsePositives: 0
      }
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.counts.materialFalsePositives).toBe(1);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "false_positive_limit",
      ok: false
    }));
  });
});

function buildAbInput(): RepoWikiContextAbEvalInput {
  return {
    runId: "repo-wiki-context-ab",
    repo,
    pullNumber: 480,
    headSha,
    suite: "seeded_defect_recall",
    providerProof: { mode: "offline_fixture", paidFallbackUsed: false },
    labels: [{
      source: "seeded_defect",
      severity: "P1",
      path: "src/worker.ts",
      line: 12,
      title: "Fresh repo wiki context must not override the diff",
      body: "The review should preserve the current diff as authority when repo wiki context is present.",
      sourceId: "seed-repo-wiki-authority"
    }],
    modes: {
      baseline: { botFindings: { findings: [buildReviewFinding()] } },
      deterministic: {
        botFindings: { findings: [buildReviewFinding()] },
        packetSha: "deterministic-packet",
        freshness: "fresh",
        degraded: false
      },
      openwiki: {
        botFindings: { findings: [buildReviewFinding()] },
        packetSha: "openwiki-packet",
        freshness: "fresh",
        degraded: false
      }
    }
  };
}

function buildReviewFinding() {
  return {
    severity: "P1",
    path: "src/worker.ts",
    line: 12,
    title: "Fresh repo wiki context must not override the diff",
    body: "The review should preserve the current diff as authority when repo wiki context is present.",
    confidence: 0.96
  };
}

function createDocsDriftFixture(options: { trueTrapMismatch?: boolean } = {}): { root: string; packetPath: string } {
  const root = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-fixture-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".neondiff"), { recursive: true });
  writeFileSync(
    join(root, "docs", "repo-wiki-packet.md"),
    [
      "# Repo Wiki Packet",
      "Use raw OpenWiki Markdown directly in prompts.",
      "OpenWiki docs may update runtime daemon config.",
      "Repo wiki context is enabled by default.",
      "Docs drift edits can rewrite docs directly.",
      "OpenWiki replaces API documentation.",
      options.trueTrapMismatch
        ? "Repo wiki context may override the PR diff."
        : "Repo wiki context is advisory only.",
      "Missing packets degrade safely.",
      "Suggestions are written outside production docs."
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "src", "repo-wiki-context.ts"),
    [
      "export const promptPolicy = 'Curated packets quote untrusted data only.';",
      "export const runtimePolicy = 'No production daemon config change.';",
      "export const defaultPolicy = 'repoWikiContext.enabled defaults false.';",
      "export const docsPolicy = 'Docs drift is suggest-only.';",
      "export const apiPolicy = 'OpenWiki is not authoritative API documentation.';",
      "export const advisoryPolicy = 'Repo wiki context is advisory only.';",
      "export const missingPolicy = 'Missing packets degrade safely.';",
      "export const suggestionPolicy = 'Suggestions are written outside production docs.';"
    ].join("\n"),
    "utf8"
  );
  const packet = buildRepoWikiPacket({
    repo: { fullName: repo, defaultBranch: "main" },
    source: { ref: "main", headSha, checkedAt: generatedAt, status: "fresh" },
    generatedAt,
    budget: { maxBytes: 12_000 },
    sections: [{
      id: "repo-wiki-context",
      title: "Repo Wiki Context",
      body: "OpenWiki-derived context is curated, advisory, default-off, and suggest-only for docs drift.",
      sourceFiles: ["docs/repo-wiki-packet.md", "src/repo-wiki-context.ts"]
    }]
  });
  const packetPath = ".neondiff/repo-wiki-packet.json";
  writeFileSync(join(root, packetPath), formatRepoWikiPacketJson(packet), "utf8");
  return { root, packetPath };
}

function buildDocsDriftClaims(options: { trueTrapMismatch?: boolean } = {}): DocsDriftSeedClaim[] {
  const stale: DocsDriftSeedClaim[] = [
    claim("stale-raw-prompt", "Use raw OpenWiki Markdown directly in prompts.", "Curated packets quote untrusted data only."),
    claim("stale-runtime", "OpenWiki docs may update runtime daemon config.", "No production daemon config change."),
    claim("stale-default", "Repo wiki context is enabled by default.", "repoWikiContext.enabled defaults false."),
    claim("stale-doc-edit", "Docs drift edits can rewrite docs directly.", "Docs drift is suggest-only."),
    claim("stale-api-docs", "OpenWiki replaces API documentation.", "OpenWiki is not authoritative API documentation.")
  ];
  const trueClaims: DocsDriftSeedClaim[] = [
    claim(
      "true-advisory",
      options.trueTrapMismatch ? "Repo wiki context may override the PR diff." : "Repo wiki context is advisory only.",
      "Repo wiki context is advisory only.",
      "true",
      7
    ),
    claim("true-missing", "Missing packets degrade safely.", "Missing packets degrade safely.", "true", 8),
    claim("true-suggestions", "Suggestions are written outside production docs.", "Suggestions are written outside production docs.", "true", 9)
  ];
  return [...stale, ...trueClaims];
}

function claim(
  id: string,
  currentClaim: string,
  currentText: string,
  expected: "stale" | "true" = "stale",
  line = 2
): DocsDriftSeedClaim {
  return {
    id,
    expected,
    docPath: "docs/repo-wiki-packet.md",
    line,
    claim: currentClaim,
    sourcePath: "src/repo-wiki-context.ts",
    currentText,
    suggestion: currentText
  };
}
