import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOutcomeLedger,
  buildOutcomeLedgerInputFromReviewPlan,
  parseOutcomeLedgerInput,
  writeOutcomeLedgerPacket,
  type OutcomeLedgerInput
} from "../src/outcome-ledger.js";
import type { PullFilePatch, PullRequestSummary, ReviewPlan } from "../src/types.js";
import { writeDryRunOutcomeLedgerEvidence } from "../src/worker.js";

const nodeRequire = createRequire(import.meta.url);
const tsxCli = nodeRequire.resolve("tsx/cli");

describe("outcome ledger", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("builds a dry-run ledger with normalized outcome fields and hard gates", () => {
    const ledger = buildOutcomeLedger(sampleInput(), {
      now: new Date("2026-07-05T12:00:00Z")
    });

    expect(ledger).toMatchObject({
      artifactVersion: "0.1",
      ok: true,
      runId: "lco-461-agent-provenance",
      mode: "advanced_dry_run",
      generatedAt: "2026-07-05T12:00:00.000Z",
      subject: {
        type: "pull_request",
        repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        number: 461,
        headSha: "144d0cc9506b8d2dba7115174b86b67c03b371cc"
      },
      reviewerDecision: {
        status: "warn"
      },
      hardGateStatus: {
        ok: true,
        failed: []
      },
      metrics: {
        changedArtifacts: 1,
        evidenceRecords: 2,
        riskClaims: 1,
        proofGaps: 1,
        failedSafetyGates: 0,
        latencyMs: 420000,
        providerAttempts: 1,
        estimatedTokens: 5000
      },
      redaction: {
        ok: true
      }
    });
    expect(ledger.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.proofBoundary).toContain("does not post comments");
  });

  it("fails closed when a hard safety gate fails", () => {
    const input = sampleInput({
      safetyGates: [
        { name: "current_head", status: "pass", detail: "head matched" },
        { name: "duplicate_same_head", status: "fail", detail: "duplicate marker found" }
      ]
    });

    const ledger = buildOutcomeLedger(input);

    expect(ledger.ok).toBe(false);
    expect(ledger.hardGateStatus).toMatchObject({
      ok: false,
      failed: ["duplicate_same_head"]
    });
    expect(ledger.metrics.failedSafetyGates).toBe(1);
  });

  it("marks unknown safety gates non-ok without treating them as failed", () => {
    const ledger = buildOutcomeLedger(sampleInput({
      safetyGates: [
        { name: "current_head", status: "unknown", detail: "not checked in this dry run" }
      ]
    }));

    expect(ledger.ok).toBe(false);
    expect(ledger.hardGateStatus).toMatchObject({
      ok: false,
      failed: [],
      unknown: ["current_head"]
    });
    expect(ledger.metrics.unknownSafetyGates).toBe(1);
  });


  it("redacts secret-like evidence and marks the packet non-ok", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const ledger = buildOutcomeLedger(sampleInput({
      evidence: [
        {
          id: "raw-log",
          kind: "log",
          title: "Raw provider log",
          status: "pass",
          summary: `provider emitted ${token}`
        }
      ]
    }));

    expect(ledger.ok).toBe(false);
    expect(JSON.stringify(ledger)).not.toContain(token);
    expect(ledger.redaction).toMatchObject({
      ok: false,
      redactedSources: [
        {
          id: "input.evidence[0].summary",
          redactedPreview: "provider emitted [redacted-secret]"
        }
      ]
    });
    expect(ledger.safetyGates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "secret_redaction",
        status: "fail",
        detail: "Secret-like text detected; see redaction report."
      })
    ]));
  });

  it("overrides a caller-supplied passing secret redaction gate when secrets are present", () => {
    const token = ["ghp", "abcdef1234567890abcdef1234567890abcd"].join("_");
    const ledger = buildOutcomeLedger({
      runId: "secret-gate-override",
      subject: {
        type: "issue",
        repo: "owner/repo",
        number: 123
      },
      evidence: [
        {
          kind: "log",
          title: "Provider output",
          summary: `raw output included ${token}`
        }
      ],
      safetyGates: [
        { name: "secret_redaction", status: "pass", detail: "caller claimed clean" }
      ],
      reviewerDecision: {
        status: "warn"
      },
      postMergeOutcome: {
        status: "unknown"
      }
    });

    expect(ledger.ok).toBe(false);
    expect(JSON.stringify(ledger)).not.toContain(token);
    expect(ledger.safetyGates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "secret_redaction",
        status: "fail",
        detail: "Secret-like text detected; see redaction report."
      })
    ]));
  });


  it("writes a JSON, Markdown, redaction, and manifest evidence packet", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-"));
    roots.push(root);

    const result = writeOutcomeLedgerPacket({
      ledgerInput: sampleInput(),
      outputDir: root,
      now: new Date("2026-07-05T12:00:00Z")
    });

    expect(result.ok).toBe(true);
    for (const artifact of ["outcome-ledger.json", "outcome-ledger.md", "redaction-report.json", "manifest.json"]) {
      expect(existsSync(join(root, artifact)), artifact).toBe(true);
      expect(result.artifacts[artifact]).toMatch(/^[a-f0-9]{64}$/);
    }
    const markdown = readFileSync(join(root, "outcome-ledger.md"), "utf8");
    expect(markdown).toContain("# Outcome Ledger: 100yenadmin/Lossless-Codex-Orchestrator-LCO#461");
    expect(markdown).toContain("Outcome Ledger dry-run proves evidence-packet construction only.");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      artifactVersion: "0.1",
      ok: true,
      runId: "lco-461-agent-provenance"
    });
    expect(Object.keys(manifest.artifactInventory).sort()).toEqual([
      "outcome-ledger.json",
      "outcome-ledger.md",
      "redaction-report.json"
    ].sort());
    expect(Object.keys(result.artifacts).sort()).toEqual([
      "manifest.json",
      "outcome-ledger.json",
      "outcome-ledger.md",
      "redaction-report.json"
    ].sort());
  });

  it("removes packet artifacts written before a mid-sequence failure", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-partial-packet-"));
    roots.push(root);
    mkdirSync(join(root, "outcome-ledger.md"));

    expect(() => writeOutcomeLedgerPacket({
      ledgerInput: sampleInput(),
      outputDir: root,
      now: new Date("2026-07-05T12:00:00Z")
    })).toThrow();

    expect(existsSync(join(root, "outcome-ledger.json"))).toBe(false);
    expect(existsSync(join(root, "redaction-report.json"))).toBe(false);
    expect(existsSync(join(root, "manifest.json"))).toBe(false);
  });

  it("rejects invalid pull request subjects without base and head shas", () => {
    expect(() => parseOutcomeLedgerInput({
      runId: "bad",
      subject: {
        type: "pull_request",
        repo: "owner/repo",
        number: 1
      }
    })).toThrow("pull_request subject requires 40-character baseSha");
  });

  it("derives a ledger input from an existing dry-run review plan", () => {
    const ledgerInput = buildOutcomeLedgerInputFromReviewPlan({
      repo: "owner/repo",
      pull: samplePull(),
      files: sampleFiles(),
      plan: sampleReviewPlan(),
      dryRun: true
    });

    const ledger = buildOutcomeLedger(ledgerInput);

    expect(ledger).toMatchObject({
      ok: false,
      subject: {
        repo: "owner/repo",
        number: 42,
        headSha: "2222222222222222222222222222222222222222"
      },
      intent: {
        sourceIssue: "owner/repo#41",
        acceptanceCriteria: [
          "[ ] Verify runtime smoke",
          "Must include focused test evidence"
        ]
      },
      changedArtifacts: [
        {
          path: "src/runtime.ts",
          changeType: "modified",
          riskAreas: ["Runtime smoke"]
        }
      ],
      riskClaims: [
        {
          severity: "P1",
          category: "runtime_correctness",
          status: "unvalidated"
        }
      ],
      reviewerDecision: {
        status: "block"
      },
      safetyGates: expect.arrayContaining([
        expect.objectContaining({ name: "duplicate_same_head", status: "unknown" }),
        expect.objectContaining({ name: "current_head", status: "unknown" }),
        expect.objectContaining({ name: "inline_coordinate_validation", status: "unknown" })
      ]),
      hardGateStatus: {
        ok: false,
        failed: [],
        unknown: ["current_head", "duplicate_same_head", "inline_coordinate_validation"]
      }
    });
  });

  it("exposes a dry-run-only CLI that writes an evidence packet", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-cli-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    const outputDir = join(root, "packet");
    writeFileSync(inputPath, `${JSON.stringify(sampleInput(), null, 2)}\n`);

    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-ledger",
      "--input",
      inputPath,
      "--dry-run",
      "true",
      "--output-dir",
      outputDir
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      command: "outcome-ledger",
      dryRun: true
    });
    expect(parsed.outputDir).toContain("/packet");
    expect(existsSync(join(outputDir, "outcome-ledger.json"))).toBe(true);
  });

  it("requires output-dir for CLI portability", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-output-required-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, `${JSON.stringify(sampleInput(), null, 2)}\n`);

    expect(() => execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-ledger",
      "--input",
      inputPath
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe"
    })).toThrow("--output-dir is required for outcome-ledger");
  });

  it("refuses non-dry-run CLI execution", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-live-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, `${JSON.stringify(sampleInput(), null, 2)}\n`);

    expect(() => execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-ledger",
      "--input",
      inputPath,
      "--dry-run",
      "false",
      "--output-dir",
      join(root, "packet")
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe"
    })).toThrow("outcome-ledger is dry-run only in this release");
  });

  it("isolates dry-run worker ledger build failures into an error artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-worker-error-"));
    roots.push(root);
    const invalidPull = {
      ...samplePull(),
      head: {
        ...samplePull().head,
        sha: "short"
      }
    };

    const result = writeDryRunOutcomeLedgerEvidence({
      evidenceDir: root,
      repo: "owner/repo",
      pull: invalidPull,
      files: sampleFiles(),
      plan: sampleReviewPlan(),
      provider: "zcode",
      model: "glm-5.2"
    });

    expect(result).toMatchObject({ ok: false });
    expect(existsSync(join(root, "outcome-ledger-error.json"))).toBe(true);
    expect(existsSync(join(root, "outcome-ledger.json"))).toBe(false);
    const error = JSON.parse(readFileSync(join(root, "outcome-ledger-error.json"), "utf8"));
    expect(error).toMatchObject({
      ok: false,
      proofBoundary: "Outcome Ledger dry-run evidence failed to build; stable review-plan evidence must continue."
    });
  });

  it("removes partial worker success artifacts when markdown write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-ledger-worker-partial-"));
    roots.push(root);
    mkdirSync(join(root, "outcome-ledger.md"));

    const result = writeDryRunOutcomeLedgerEvidence({
      evidenceDir: root,
      repo: "owner/repo",
      pull: samplePull(),
      files: sampleFiles(),
      plan: sampleReviewPlan(),
      provider: "zcode",
      model: "glm-5.2"
    });

    expect(result).toMatchObject({ ok: false });
    expect(existsSync(join(root, "outcome-ledger-error.json"))).toBe(true);
    expect(existsSync(join(root, "outcome-ledger.json"))).toBe(false);
  });
});

function sampleInput(overrides: Partial<OutcomeLedgerInput> = {}): OutcomeLedgerInput {
  return {
    ledgerName: "Outcome Ledger fixture",
    runId: "lco-461-agent-provenance",
    mode: "advanced_dry_run",
    subject: {
      type: "pull_request",
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      number: 461,
      title: "[codex] Add agent provenance schema parser",
      url: "https://github.com/100yenadmin/Lossless-Codex-Orchestrator-LCO/pull/461",
      baseSha: "0000000000000000000000000000000000000000",
      headSha: "144d0cc9506b8d2dba7115174b86b67c03b371cc",
      author: "codex",
      labels: ["codex"]
    },
    intent: {
      summary: "Add provenance parsing so downstream agents can reason about who created generated artifacts.",
      sourceIssue: "100yenadmin/Lossless-Codex-Orchestrator-LCO#460",
      acceptanceCriteria: ["Parses known provenance schema", "Rejects malformed provenance payloads"],
      nonGoals: ["Do not change agent scheduling"]
    },
    changedArtifacts: [
      {
        path: "src/provenance/schema.ts",
        changeType: "added",
        summary: "Adds schema parser.",
        riskAreas: ["agent handoff", "metadata compatibility"]
      }
    ],
    evidence: [
      {
        id: "focused-test",
        kind: "test",
        title: "Focused parser tests",
        status: "pass",
        summary: "Parser fixtures passed."
      },
      {
        id: "stable-mode",
        kind: "runtime",
        title: "Stable mode untouched",
        status: "pass",
        summary: "No launchd or active config change."
      }
    ],
    riskClaims: [
      {
        id: "schema-compat",
        severity: "P2",
        category: "api_compatibility",
        claim: "Malformed provenance payloads could block downstream agents.",
        evidenceIds: ["focused-test"],
        status: "validated"
      }
    ],
    proofGaps: [
      {
        id: "integration-smoke",
        severity: "P3",
        summary: "Needs downstream agent handoff smoke before claiming workflow improvement.",
        requiredEvidence: ["agent handoff transcript"]
      }
    ],
    safetyGates: [
      { name: "current_head", status: "pass", detail: "head matched" },
      { name: "duplicate_same_head", status: "pass", detail: "no public posting in dry-run" },
      { name: "secret_redaction", status: "pass", detail: "no secret-like content" }
    ],
    reviewerDecision: {
      status: "warn",
      reason: "Useful but needs downstream smoke for outcome claim."
    },
    runtime: {
      provider: "zcode",
      model: "glm-5.2",
      startedAt: "2026-07-05T11:53:00.000Z",
      completedAt: "2026-07-05T12:00:00.000Z",
      latencyMs: 420000,
      providerAttempts: 1,
      promptTokens: 3000,
      outputTokens: 2000,
      totalTokens: 5000
    },
    postMergeOutcome: {
      status: "unknown",
      checkedAt: "2026-07-05T12:00:00.000Z",
      summary: "Not merged at ledger creation time."
    },
    ...overrides
  };
}

function samplePull(): PullRequestSummary {
  return {
    number: 42,
    title: "Fixes owner/repo#41 runtime handoff",
    draft: false,
    body: "- [ ] Verify runtime smoke\n- Must include focused test evidence",
    head: {
      sha: "2222222222222222222222222222222222222222",
      ref: "feature/runtime"
    },
    base: {
      sha: "1111111111111111111111111111111111111111",
      ref: "main",
      repo: {
        full_name: "owner/repo"
      }
    },
    html_url: "https://github.com/owner/repo/pull/42",
    labels: [{ name: "runtime" }]
  };
}

function sampleFiles(): PullFilePatch[] {
  return [
    {
      filename: "src/runtime.ts",
      status: "modified",
      changes: 12,
      additions: 8,
      deletions: 4
    }
  ];
}

function sampleReviewPlan(): ReviewPlan {
  return {
    event: "REQUEST_CHANGES",
    comments: [
      {
        path: "src/runtime.ts",
        line: 10,
        side: "RIGHT",
        body: "Runtime handoff can still lose provider state.",
        severity: "P1",
        category: "runtime_correctness",
        title: "Preserve provider state"
      }
    ],
    dropped: [],
    summary: "Found a runtime correctness blocker.",
    deterministicGate: {
      inputFindings: 1,
      acceptedComments: 1,
      droppedFindings: 0,
      event: "REQUEST_CHANGES",
      requestChangesEligible: 1,
      categoryCounts: {
        runtime_correctness: 1
      },
      dropReasonCounts: {}
    },
    validation: {
      summary: "Runtime code changed.",
      docsOnly: false,
      recommendations: [
        {
          id: "runtime-smoke",
          title: "Runtime smoke",
          status: "required",
          reason: "Runtime handoff changed.",
          matchedPaths: ["src/runtime.ts"],
          proofTypes: ["smoke"]
        }
      ],
      profileHints: {
        validationHints: [],
        proofExpectations: []
      }
    },
    proof: {
      status: "sufficient",
      summary: "Focused smoke proof was provided.",
      requiredRecommendationIds: ["runtime-smoke"],
      missingRecommendationIds: [],
      detectedEvidence: ["smoke"]
    }
  };
}
