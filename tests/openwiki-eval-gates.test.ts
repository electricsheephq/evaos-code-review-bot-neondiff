import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countEvalFalsePositiveSeverities, type EvalLabelInput } from "../src/eval-harness.js";
import {
  runDocsDriftEval,
  runRepoWikiContextAbEval,
  type DocsDriftSeedClaim,
  type RepoWikiContextAbEvalInput
} from "../src/openwiki-eval-gates.js";
import { buildRepoWikiPacket, formatRepoWikiPacketJson } from "../src/repo-wiki-packet.js";
import { containsSecretLikeText } from "../src/secrets.js";

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
    expect(containsSecretLikeText(JSON.stringify(result.summary))).toBe(false);
    expect(result.summary.comparisons.openwiki).toMatchObject({
      precisionDelta: 0,
      recallDelta: 0,
      p0p1FalsePositiveDelta: 0
    });
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "deterministic_recall_neutral_or_better",
      ok: true
    }));
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "openwiki_recall_neutral_or_better",
      ok: true
    }));
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

  it("throws a clean validation error when a required A/B mode is missing", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-missing-mode-"));
    roots.push(outputRoot);
    const input = buildAbInput();
    delete (input.modes as Partial<RepoWikiContextAbEvalInput["modes"]>).openwiki;

    expect(() => runRepoWikiContextAbEval(input, {
      outputRoot,
      now: new Date(generatedAt)
    })).toThrow("repoWikiContextAb.modes.openwiki is required");
    expect(existsSync(join(outputRoot, "repo-wiki-context-ab-summary.json"))).toBe(false);
  });

  it("rejects non-empty A/B output roots before writing new artifacts", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-non-empty-"));
    roots.push(outputRoot);
    writeFileSync(join(outputRoot, "previous-run.json"), "{}", "utf8");

    expect(() => runRepoWikiContextAbEval(buildAbInput(), {
      outputRoot,
      now: new Date(generatedAt)
    })).toThrow("outputRoot must be empty before running repo-wiki context A/B eval");
    expect(existsSync(join(outputRoot, "repo-wiki-context-ab-summary.json"))).toBe(false);
  });

  it("buckets unmatched false positives by their actual severity", () => {
    const labels: EvalLabelInput[] = [{
      source: "seeded_defect",
      severity: "P0",
      path: "src/worker.ts",
      line: 12,
      title: "Matched outage",
      body: "This finding is expected and should not count as a false positive.",
      sourceId: "matched-p0"
    }];

    const counts = countEvalFalsePositiveSeverities({
      findings: [
        {
          severity: "P0",
          path: "src/worker.ts",
          line: 12,
          title: "Matched outage",
          body: "This finding is expected and should not count as a false positive.",
          confidence: 0.99
        },
        severityFinding("P0", "Unexpected outage"),
        severityFinding("P1", "Unexpected token fallback"),
        severityFinding("P2", "Unexpected docs drift"),
        severityFinding("P3", "Unexpected note")
      ]
    }, labels);

    expect(counts).toEqual({ P0: 1, P1: 1, P2: 1, P3: 1 });
  });

  it("fails A/B eval when OpenWiki context drops baseline recall", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-recall-fail-"));
    roots.push(outputRoot);
    const input = buildAbInput();
    input.modes.openwiki.botFindings = { findings: [] };

    const result = runRepoWikiContextAbEval(input, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.comparisons.openwiki.recallDelta).toBeLessThan(0);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "openwiki_recall_neutral_or_better",
      ok: false
    }));
  });

  it("counts expected-false labels the same way as the core scorecard", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-ab-expected-false-"));
    roots.push(outputRoot);
    const input = buildAbInput();
    input.labels.push({
      source: "seeded_defect",
      severity: "P1",
      path: "src/worker.ts",
      line: 33,
      title: "Provider fallback leaks paid tokens",
      body: "This label is an explicit non-finding and must not match false positives.",
      sourceId: "seed-expected-false",
      expected: false
    });
    input.modes.openwiki.botFindings = {
      findings: [
        buildReviewFinding(),
        {
          severity: "P1",
          path: "src/worker.ts",
          line: 33,
          title: "Provider fallback leaks paid tokens",
          body: "This label is an explicit non-finding and must not match false positives.",
          confidence: 0.9
        }
      ]
    };

    const result = runRepoWikiContextAbEval(input, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.summary.modes.openwiki.scorecard.counts.falsePositive).toBe(1);
    expect(result.summary.modes.openwiki.p0p1FalsePositives).toBe(1);
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
    expect(containsSecretLikeText(JSON.stringify(result.summary))).toBe(false);
    expect(result.summary.counts).toMatchObject({
      staleCaught: 5,
      materialFalsePositives: 0,
      suggestions: 5
    });
    expect(result.summary.thresholds.maxMaterialFalsePositives).toBe(0);
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
    expect(result.summary.claims).toContainEqual(expect.objectContaining({
      id: "true-advisory",
      detail: "true trap would be rewritten; counted as material false positive"
    }));
  });

  it("rejects docs-drift output roots inside the checkout before writing artifacts", () => {
    const { packetPath, root } = createDocsDriftFixture();
    const outputRoot = join(process.cwd(), ".tmp-openwiki-docs-drift-inside-checkout");
    roots.push(root, outputRoot);
    rmSync(outputRoot, { recursive: true, force: true });

    expect(() => runDocsDriftEval({
      runId: "docs-drift-output-inside-checkout",
      repo,
      headSha,
      worktreePath: root,
      packetPath,
      claims: buildDocsDriftClaims()
    }, {
      outputRoot,
      now: new Date(generatedAt)
    })).toThrow("outputDir must not be inside the current git checkout");
    expect(existsSync(join(outputRoot, "docs-drift-summary.json"))).toBe(false);
    expect(existsSync(join(outputRoot, "suggested-doc-edits.md"))).toBe(false);
  });

  it("rejects packet paths that resolve outside the worktree", () => {
    const { root } = createDocsDriftFixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-outside-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-outside-result-"));
    roots.push(root, outsideRoot, outputRoot);
    writeFileSync(join(outsideRoot, "packet.json"), "{}", "utf8");

    const result = runDocsDriftEval({
      runId: "packet-outside-worktree",
      repo,
      headSha,
      worktreePath: root,
      packetPath: `../${outsideRoot.split("/").at(-1)}/packet.json`,
      claims: buildDocsDriftClaims()
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "packet_readable",
      ok: false
    }));
  });

  it("rejects symlinked packets that escape the worktree", () => {
    const { root } = createDocsDriftFixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-symlink-outside-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-symlink-result-"));
    roots.push(root, outsideRoot, outputRoot);
    const outsidePacket = join(outsideRoot, "packet.json");
    writeFileSync(outsidePacket, formatRepoWikiPacketJson(buildRepoWikiPacket({
      repo: { fullName: repo, defaultBranch: "main" },
      source: { ref: "main", headSha, checkedAt: generatedAt, status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000 },
      sections: [{
        id: "external",
        title: "External Packet",
        body: "This packet lives outside the worktree.",
        sourceFiles: ["src/repo-wiki-context.ts"]
      }]
    })), "utf8");
    symlinkSync(outsidePacket, join(root, ".neondiff", "linked-packet.json"));

    const result = runDocsDriftEval({
      runId: "packet-symlink-escape",
      repo,
      headSha,
      worktreePath: root,
      packetPath: ".neondiff/linked-packet.json",
      claims: buildDocsDriftClaims()
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "packet_readable",
      ok: false
    }));
  });

  it("fails closed instead of throwing when packetPath resolves to the worktree root", () => {
    const { root } = createDocsDriftFixture();
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-root-packet-"));
    roots.push(root, outputRoot);

    const result = runDocsDriftEval({
      runId: "packet-root-path",
      repo,
      headSha,
      worktreePath: root,
      packetPath: ".",
      claims: buildDocsDriftClaims()
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(false);
    expect(result.summary.gates).toContainEqual(expect.objectContaining({
      name: "packet_readable",
      ok: false
    }));
  });

  it("marks missing, malformed, and secret-like packets unreadable", () => {
    const malformed = createDocsDriftFixture();
    const secret = createDocsDriftFixture();
    const missing = createDocsDriftFixture();
    const malformedOutput = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-malformed-"));
    const secretOutput = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-secret-"));
    const missingOutput = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-missing-"));
    roots.push(
      malformed.root,
      secret.root,
      missing.root,
      malformedOutput,
      secretOutput,
      missingOutput
    );
    writeFileSync(join(malformed.root, malformed.packetPath), "{not json", "utf8");
    writeFileSync(join(secret.root, secret.packetPath), "{\"token\":\"ghp_1234567890abcdef\"}", "utf8");

    const cases = [
      { fixture: malformed, outputRoot: malformedOutput },
      { fixture: secret, outputRoot: secretOutput },
      { fixture: { root: missing.root, packetPath: ".neondiff/missing.json" }, outputRoot: missingOutput }
    ];

    for (const [index, item] of cases.entries()) {
      const result = runDocsDriftEval({
        runId: `packet-unreadable-${index}`,
        repo,
        headSha,
        worktreePath: item.fixture.root,
        packetPath: item.fixture.packetPath,
        claims: buildDocsDriftClaims()
      }, {
        outputRoot: item.outputRoot,
        now: new Date(generatedAt)
      });
      expect(result.ok).toBe(false);
      expect(result.summary.gates).toContainEqual(expect.objectContaining({
        name: "packet_readable",
        ok: false
      }));
    }
  });

  it("redacts secret-like text before writing docs-drift artifacts", () => {
    const { packetPath, root } = createDocsDriftFixture();
    const outputRoot = mkdtempSync(join(tmpdir(), "neondiff-docs-drift-redaction-"));
    roots.push(root, outputRoot);
    const secret = "ghp_1234567890abcdef";
    writeFileSync(
      join(root, "docs", "repo-wiki-packet.md"),
      "The documented token is stale.\n",
      "utf8"
    );
    writeFileSync(
      join(root, "src", "repo-wiki-context.ts"),
      `export const secretExample = '${secret}';\n`,
      "utf8"
    );

    const result = runDocsDriftEval({
      runId: "docs-drift-redaction",
      repo,
      headSha,
      worktreePath: root,
      packetPath,
      thresholds: { minStaleCaught: 1 },
      claims: [{
        id: "secret-redaction",
        expected: "stale",
        docPath: "docs/repo-wiki-packet.md",
        line: 1,
        claim: "The documented token is stale.",
        sourcePath: "src/repo-wiki-context.ts",
        currentText: secret,
        suggestion: secret
      }]
    }, {
      outputRoot,
      now: new Date(generatedAt)
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.summary)).not.toContain(secret);
    expect(readFileSync(result.artifacts["suggested-doc-edits.md"]!, "utf8")).not.toContain(secret);
    expect(readFileSync(result.artifacts["docs-drift-summary.json"]!, "utf8")).toContain("[redacted-secret]");
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

function severityFinding(severity: "P0" | "P1" | "P2" | "P3", title: string) {
  return {
    severity,
    path: "src/worker.ts",
    line: 99,
    title,
    body: `${title} is intentionally unmatched.`,
    confidence: 0.9
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
