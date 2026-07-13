import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  selectAndSealPhase1Cohort,
  verifyPhase1CohortSeal,
  type Phase1Candidate,
  type Phase1CohortPolicy
} from "../src/phase1-cohort-selection.js";
import * as cohortSelectionModule from "../src/phase1-cohort-selection.js";
import { runPhase1CohortSelectionCli } from "../src/phase1-cohort-selection-cli.js";

const PHASE1_COHORT_PROOF_BOUNDARY = "This may prove only that a metadata-only 30-case candidate cohort is selected and immutably sealed under the named workload and privacy contracts. It does not admit scenarios, prove labels, review quality, noninferiority, production routing, runtime safety, customer readiness, or public claims. No model run may begin until separate hidden outcomes, blinded adjudication, and restricted identity sidecars pass their own gates.";
const CANONICAL_LANGUAGES = ["typescript", "javascript", "swift", "python", "go", "rust", "java", "kotlin", "csharp", "cpp", "ruby", "php", "shell", "sql"] as const;
const CANONICAL_RISK_TAGS = ["security", "auth", "release", "state-machine", "concurrency", "migration", "architecture", "simplification", "correctness", "config", "debugging", "ci", "state", "privacy", "licensing", "performance", "reliability"] as const;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaque(prefix: "candidate" | "repo" | "lineage", value: string | number): string {
  return `${prefix}_${digest(`${prefix}:${value}`).slice(0, 32)}`;
}

function candidate(index: number, promptTokens: number): Phase1Candidate {
  const bucket = promptTokens <= 16_384 ? "16k"
    : promptTokens <= 32_768 ? "32k"
      : promptTokens <= 65_536 ? "64k"
        : "128k";
  return {
    candidateId: opaque("candidate", index),
    sourceIdentitySha256: digest(`source-${index}`),
    inputArtifactSha256: digest(`artifact-${index}`),
    promptTokens,
    bucket,
    repositoryGroup: opaque("repo", index % 10),
    lineageGroup: opaque("lineage", index),
    language: CANONICAL_LANGUAGES[index % 6],
    riskTags: index % 3 === 0 ? ["security"] : [],
    caseKind: index % 4 === 0 ? "clean_control_candidate" : "defect_candidate",
    eligibility: {
      currentHead: true,
      redactionPassed: true,
      secretScanPassed: true,
      immutableInput: true,
      sourcePolicyPassed: true
    }
  };
}

function candidatePool(): Phase1Candidate[] {
  const ranges = [
    [8_193, 6],
    [16_385, 15],
    [32_769, 15],
    [65_537, 6]
  ] as const;
  let index = 0;
  return ranges.flatMap(([start, count]) => Array.from({ length: count }, (_, offset) =>
    candidate(index++, start + offset)));
}

function policy(safeOutputRoot: string): Phase1CohortPolicy {
  return {
    cohortSize: 30,
    bucketQuotas: { "16k": 3, "32k": 12, "64k": 12, "128k": 3 },
    firstFiveBucketQuotas: { "16k": 1, "32k": 2, "64k": 1, "128k": 1 },
    outputTokens: 2_048,
    maximumFindings: 5,
    minimumCleanControls: 5,
    minimumRepositoryGroups: 6,
    minimumLanguages: 5,
    minimumHighRisk: 8,
    maximumPerRepositoryGroup: 5,
    selectionSeed: digest("frozen-575-aggregate"),
    tokenizerFingerprint: digest("tokenizer"),
    promptBuilderFingerprint: digest("prompt-builder"),
    parserFingerprint: digest("parser"),
    gateFingerprint: digest("gate"),
    redactorFingerprint: digest("redactor"),
    secretScannerFingerprint: digest("secret-scanner"),
    sourcePolicyFingerprint: digest("source-policy"),
    safeOutputRoot,
    proofBoundary: PHASE1_COHORT_PROOF_BOUNDARY
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-cohort-"));
  const candidatePoolPath = join(root, "candidates.json");
  const policyPath = join(root, "policy.json");
  const outputDir = join(root, "sealed", "run-1");
  const candidates = candidatePool();
  const cohortPolicy = policy(join(root, "sealed"));
  mkdirSync(cohortPolicy.safeOutputRoot, { mode: 0o700 });
  writeFileSync(candidatePoolPath, `${JSON.stringify(candidates, null, 2)}\n`);
  writeFileSync(policyPath, `${JSON.stringify(cohortPolicy, null, 2)}\n`);
  return { root, candidatePoolPath, policyPath, outputDir, candidates, cohortPolicy };
}

function writeFixture(f: ReturnType<typeof fixture>): void {
  writeFileSync(f.candidatePoolPath, `${JSON.stringify(f.candidates, null, 2)}\n`);
  writeFileSync(f.policyPath, `${JSON.stringify(f.cohortPolicy, null, 2)}\n`);
}

function seal(f: ReturnType<typeof fixture>) {
  return selectAndSealPhase1Cohort(selectionOptions(f));
}

function selectionOptions(f: ReturnType<typeof fixture>) {
  return {
    candidatePoolPath: f.candidatePoolPath,
    policyPath: f.policyPath,
    outputDir: f.outputDir,
    candidatePoolSha256: digest(readFileSync(f.candidatePoolPath)),
    policySha256: digest(readFileSync(f.policyPath)),
    allowedOutputRoot: f.cohortPolicy.safeOutputRoot
  };
}

describe("phase 1 cohort selection", () => {
  it("exports the frozen sprint language and risk vocabularies", () => {
    const exported = cohortSelectionModule as unknown as Record<string, unknown>;
    expect(exported.PHASE1_COHORT_LANGUAGES).toEqual(CANONICAL_LANGUAGES);
    expect(exported.PHASE1_COHORT_RISK_TAGS).toEqual(CANONICAL_RISK_TAGS);
    expect(Object.isFrozen(exported.PHASE1_COHORT_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(exported.PHASE1_COHORT_RISK_TAGS)).toBe(true);
  });

  it("parses select and verify CLI commands and rejects malformed options", () => {
    const f = fixture();
    const trusted = selectionOptions(f);
    const args = [
      "--candidate-pool", f.candidatePoolPath,
      "--candidate-pool-sha256", trusted.candidatePoolSha256,
      "--policy", f.policyPath,
      "--policy-sha256", trusted.policySha256,
      "--output-dir", f.outputDir,
      "--allowed-output-root", trusted.allowedOutputRoot
    ];
    const selected = runPhase1CohortSelectionCli(["select", ...args]);
    expect(selected).toEqual({ ok: true, command: "select", manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const manifestSha256 = (selected as { manifestSha256: string }).manifestSha256;
    expect(runPhase1CohortSelectionCli(["verify", ...args])).toEqual({ ok: true, command: "verify", manifestSha256 });
    expect(Object.keys(selected as object).sort()).toEqual(["command", "manifestSha256", "ok"]);
    expect(() => runPhase1CohortSelectionCli(["select", "--candidate-pool", f.candidatePoolPath])).toThrow(/usage/i);
    expect(() => runPhase1CohortSelectionCli(["select", ...args, "--unknown", "value"])).toThrow(/unknown option/i);
    expect(() => runPhase1CohortSelectionCli(["select", ...args, "--policy", f.policyPath])).toThrow(/duplicate option/i);
  });

  it("rejects non-regular candidate and policy input descriptors", () => {
    const candidate = fixture();
    expect(() => selectAndSealPhase1Cohort({
      ...selectionOptions(candidate),
      candidatePoolPath: "/dev/null",
      candidatePoolSha256: digest("")
    })).toThrow(/regular file/i);

    const policyInput = fixture();
    expect(() => selectAndSealPhase1Cohort({
      ...selectionOptions(policyInput),
      policyPath: "/dev/null",
      policySha256: digest("")
    })).toThrow(/regular file/i);
  });

  it("selects deterministically under input reordering with exact cohort and first-five strata", () => {
    const first = fixture();
    const firstManifest = seal(first);
    const second = fixture();
    second.candidates.reverse();
    writeFixture(second);
    const secondManifest = seal(second);

    expect(secondManifest.selectedCandidateIds).toEqual(firstManifest.selectedCandidateIds);
    expect(firstManifest.strata.bucketCounts).toEqual({ "16k": 3, "32k": 12, "64k": 12, "128k": 3 });
    expect(firstManifest.firstFive.bucketCounts).toEqual({ "16k": 1, "32k": 2, "64k": 1, "128k": 1 });
    expect(firstManifest.firstFive.cleanControlCount).toBeGreaterThanOrEqual(1);
    expect(firstManifest.diversity.cleanControlCount).toBeGreaterThanOrEqual(5);
    expect(firstManifest.diversity.repositoryGroupCount).toBeGreaterThanOrEqual(6);
    expect(firstManifest.diversity.languageCount).toBeGreaterThanOrEqual(5);
    expect(firstManifest.diversity.highRiskCount).toBeGreaterThanOrEqual(8);
    expect(firstManifest.diversity.maximumRepositoryGroupCount).toBeLessThanOrEqual(5);
  });

  it("prefers lower-frequency repository and language groups across equally feasible cohorts", () => {
    const f = fixture();
    const tokens = [
      ...Array.from({ length: 3 }, (_, index) => 8_193 + index),
      ...Array.from({ length: 12 }, (_, index) => 16_385 + index),
      ...Array.from({ length: 12 }, (_, index) => 32_769 + index),
      ...Array.from({ length: 3 }, (_, index) => 65_537 + index)
    ];
    f.candidates = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const baseline = candidate(index, tokens[index]);
      baseline.repositoryGroup = opaque("repo", `baseline-${index % 6}`);
      baseline.language = CANONICAL_LANGUAGES[index % 5];
      baseline.riskTags = index < 8 ? ["security"] : [];
      baseline.caseKind = index < 5 ? "clean_control_candidate" : "defect_candidate";
      f.candidates.push(baseline);

      const diverse = candidate(index + 100, tokens[index]);
      diverse.repositoryGroup = opaque("repo", `diverse-${index}`);
      diverse.language = CANONICAL_LANGUAGES[index % 6];
      diverse.riskTags = baseline.riskTags;
      diverse.caseKind = baseline.caseKind;
      f.candidates.push(diverse);
    }
    writeFixture(f);

    const manifest = seal(f);
    expect(manifest.diversity.repositoryGroupCount).toBe(30);
    expect(manifest.diversity.languageCount).toBe(6);
  });

  it("accepts strict bucket boundaries and rejects 8k and over-128k rows", () => {
    const f = fixture();
    f.candidates[0].promptTokens = 16_384;
    f.candidates[6].promptTokens = 32_768;
    f.candidates[21].promptTokens = 65_536;
    f.candidates[36].promptTokens = 131_072;
    writeFixture(f);
    expect(() => seal(f)).not.toThrow();

    for (const invalid of [8_192, 131_073]) {
      const bad = fixture();
      bad.candidates[0].promptTokens = invalid;
      writeFixture(bad);
      expect(() => seal(bad)).toThrow(/bucket|token/i);
    }
  });

  it.each([
    ["candidate ID", (rows: Phase1Candidate[]) => { rows[1].candidateId = rows[0].candidateId; }],
    ["source identity", (rows: Phase1Candidate[]) => { rows[1].sourceIdentitySha256 = rows[0].sourceIdentitySha256; }],
    ["lineage", (rows: Phase1Candidate[]) => { rows[1].lineageGroup = rows[0].lineageGroup; }]
  ])("rejects duplicate %s values", (_label, mutate) => {
    const f = fixture();
    mutate(f.candidates);
    writeFixture(f);
    expect(() => seal(f)).toThrow(/duplicate/i);
  });

  it("rejects forbidden outcome keys, secrets, ineligible candidates, and malformed hashes", () => {
    const forbidden = fixture();
    (forbidden.candidates[0] as unknown as Record<string, unknown>).outcome = "hidden";
    writeFixture(forbidden);
    expect(() => seal(forbidden)).toThrow(/forbidden/i);

    const secret = fixture();
    secret.candidates[0].riskTags = ["Authorization: Bearer sk-secret-value-1234567890"];
    writeFixture(secret);
    expect(() => seal(secret)).toThrow(/secret-like/i);

    const ineligible = fixture();
    ineligible.candidates[0].eligibility.currentHead = false;
    writeFixture(ineligible);
    expect(() => seal(ineligible)).toThrow(/ineligible/i);

    const malformed = fixture();
    malformed.candidates[0].inputArtifactSha256 = "a".repeat(63);
    writeFixture(malformed);
    expect(() => seal(malformed)).toThrow(/sha-256/i);
  });

  it("fails closed when diversity floors or repository caps cannot be met", () => {
    const clean = fixture();
    clean.candidates.forEach((row) => { row.caseKind = "defect_candidate"; });
    writeFixture(clean);
    expect(() => seal(clean)).toThrow(/clean-control/i);

    const repositories = fixture();
    repositories.candidates.forEach((row, index) => { row.repositoryGroup = opaque("repo", `limited-${index % 5}`); });
    writeFixture(repositories);
    expect(() => seal(repositories)).toThrow(/repository|cap/i);

    const languages = fixture();
    languages.candidates.forEach((row, index) => { row.language = CANONICAL_LANGUAGES[index % 4]; });
    writeFixture(languages);
    expect(() => seal(languages)).toThrow(/language/i);

    const risk = fixture();
    risk.candidates.forEach((row) => { row.riskTags = []; });
    writeFixture(risk);
    expect(() => seal(risk)).toThrow(/high-risk/i);

    const cap = fixture();
    cap.candidates.forEach((row, index) => { row.repositoryGroup = opaque("repo", index < 5 ? `rare-${index}` : "crowded"); });
    writeFixture(cap);
    expect(() => seal(cap)).toThrow(/cap|quota/i);
  });

  it("finds a feasible cohort through 100 novelty decoys without exploring selection permutations", () => {
    const f = fixture();
    let index = 0;
    f.candidates = [];
    const reservedCleanRepository = opaque("repo", "reserved-clean");
    for (const [start, count] of [[8_193, 3], [32_769, 12], [65_537, 3]] as const) {
      for (let offset = 0; offset < count; offset += 1) {
        const row = candidate(index++, start + offset);
        row.repositoryGroup = index <= 5 ? reservedCleanRepository : opaque("repo", `support-${index}`);
        row.language = CANONICAL_LANGUAGES[index % 6];
        row.riskTags = [];
        row.caseKind = index <= 5 ? "clean_control_candidate" : "defect_candidate";
        f.candidates.push(row);
      }
    }
    for (let offset = 0; offset < 100; offset += 1) {
      const row = candidate(index++, 16_385 + offset);
      row.repositoryGroup = reservedCleanRepository;
      row.language = CANONICAL_LANGUAGES[offset % 6];
      row.riskTags = ["security"];
      f.candidates.push(row);
    }
    for (let offset = 0; offset < 8; offset += 1) {
      const row = candidate(index++, 20_000 + offset);
      row.repositoryGroup = opaque("repo", `risk-${offset}`);
      row.language = CANONICAL_LANGUAGES[offset % 2];
      row.riskTags = ["security"];
      f.candidates.push(row);
    }
    for (let offset = 0; offset < 4; offset += 1) {
      const row = candidate(index++, 24_000 + offset);
      row.repositoryGroup = opaque("repo", `neutral-${offset}`);
      row.language = CANONICAL_LANGUAGES[offset % 6];
      row.riskTags = [];
      f.candidates.push(row);
    }
    writeFixture(f);

    expect(seal(f).diversity.highRiskCount).toBeGreaterThanOrEqual(8);
  });

  it("confines output, writes private atomic artifacts, verifies the seal, and fails on tampering or input drift", () => {
    const escaped = fixture();
    escaped.outputDir = join(escaped.root, "outside");
    expect(() => seal(escaped)).toThrow(/safe output root/i);

    const f = fixture();
    const manifest = seal(f);
    for (const name of ["selection-manifest.json", "runtime-input-manifest.json", "selection-receipt.json", "SEALED"]) {
      expect(statSync(join(f.outputDir, name)).mode & 0o777).toBe(0o600);
    }
    const modificationTimes = Object.fromEntries(
      ["selection-manifest.json", "runtime-input-manifest.json", "selection-receipt.json", "SEALED"]
        .map((name) => [name, statSync(join(f.outputDir, name)).mtimeMs])
    );
    expect(seal(f).manifestSha256).toBe(manifest.manifestSha256);
    expect(Object.fromEntries(Object.keys(modificationTimes).map((name) => [name, statSync(join(f.outputDir, name)).mtimeMs]))).toEqual(modificationTimes);
    expect(verifyPhase1CohortSeal(selectionOptions(f))).toEqual({ ok: true, manifestSha256: manifest.manifestSha256 });

    const runtime = JSON.parse(readFileSync(join(f.outputDir, "runtime-input-manifest.json"), "utf8")) as unknown;
    const runtimeText = JSON.stringify(runtime);
    for (const forbidden of ["sourceIdentity", "repositoryGroup", "language", "riskTags", "caseKind", "outcome", "adjudication", "reviewer", "content", "path"]) {
      expect(runtimeText).not.toContain(forbidden);
    }

    writeFileSync(join(f.outputDir, "runtime-input-manifest.json"), "{}\n");
    chmodSync(join(f.outputDir, "runtime-input-manifest.json"), 0o600);
    expect(() => verifyPhase1CohortSeal(selectionOptions(f))).toThrow(/tamper|mismatch/i);

    const drift = fixture();
    const pinnedDrift = selectionOptions(drift);
    seal(drift);
    drift.candidates[0].riskTags = ["security", "correctness"];
    writeFixture(drift);
    expect(() => verifyPhase1CohortSeal(pinnedDrift)).toThrow(/sha-256|hash|drift|mismatch/i);
  });

  it("pins candidate bytes, policy bytes, and the independently allowed canonical output root before mutation", () => {
    const candidateMismatch = fixture();
    const candidateOptions = selectionOptions(candidateMismatch);
    candidateOptions.candidatePoolSha256 = "0".repeat(64);
    expect(() => selectAndSealPhase1Cohort(candidateOptions)).toThrow(/candidate pool.*sha-256/i);
    expect(existsSync(candidateMismatch.outputDir)).toBe(false);

    const substituted = fixture();
    const substitutedOptions = selectionOptions(substituted);
    substituted.cohortPolicy.selectionSeed = digest("substituted-policy");
    writeFixture(substituted);
    expect(() => selectAndSealPhase1Cohort(substitutedOptions)).toThrow(/policy.*sha-256/i);
    expect(existsSync(substituted.outputDir)).toBe(false);

    const wrongRoot = fixture();
    const otherRoot = join(wrongRoot.root, "other-root");
    mkdirSync(otherRoot, { mode: 0o700 });
    expect(() => selectAndSealPhase1Cohort({ ...selectionOptions(wrongRoot), allowedOutputRoot: otherRoot })).toThrow(/allowed output root/i);
    expect(existsSync(wrongRoot.outputDir)).toBe(false);

    const filesystemRoot = fixture();
    filesystemRoot.cohortPolicy.safeOutputRoot = "/";
    filesystemRoot.outputDir = join(filesystemRoot.root, "root-policy-output");
    writeFixture(filesystemRoot);
    expect(() => selectAndSealPhase1Cohort({ ...selectionOptions(filesystemRoot), allowedOutputRoot: "/" })).toThrow(/filesystem root|allowed output root/i);
    expect(existsSync(filesystemRoot.outputDir)).toBe(false);
  });

  it("requires the canonical proof boundary and opaque neutral identifiers and risk tags", () => {
    expect((cohortSelectionModule as unknown as Record<string, unknown>).PHASE1_COHORT_PROOF_BOUNDARY).toBe(PHASE1_COHORT_PROOF_BOUNDARY);
    const proof = fixture();
    proof.cohortPolicy.proofBoundary = "similar but not the canonical proof boundary";
    writeFixture(proof);
    expect(() => seal(proof)).toThrow(/proof boundary/i);

    for (const mutate of [
      (row: Phase1Candidate) => { row.candidateId = "owner-repo-pr-123"; },
      (row: Phase1Candidate) => { row.repositoryGroup = "electricsheephq/neondiff"; },
      (row: Phase1Candidate) => { row.lineageGroup = "pr-123-head-deadbeef"; },
      (row: Phase1Candidate) => { row.language = "electricsheephq/private-repo"; }
    ]) {
      const identity = fixture();
      mutate(identity.candidates[0]);
      writeFixture(identity);
      expect(() => seal(identity)).toThrow(/opaque|neutral|identifier|language.*allowlist/i);
    }

    const risk = fixture();
    risk.candidates[0].riskTags = ["Security Finding"];
    writeFixture(risk);
    expect(() => seal(risk)).toThrow(/risk tag.*normalized/i);

    const identityRisk = fixture();
    identityRisk.candidates[0].riskTags = ["customer_acme"];
    writeFixture(identityRisk);
    expect(() => seal(identityRisk)).toThrow(/risk tag.*allowlist/i);
  });

  it("bounds input bytes and rejects malformed UTF-8", () => {
    const invalidUtf8 = fixture();
    writeFileSync(invalidUtf8.candidatePoolPath, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(() => selectAndSealPhase1Cohort(selectionOptions(invalidUtf8))).toThrow(/utf-8/i);
    expect(existsSync(invalidUtf8.outputDir)).toBe(false);

    const oversized = fixture();
    writeFileSync(oversized.policyPath, " ".repeat(300_000));
    expect(() => selectAndSealPhase1Cohort(selectionOptions(oversized))).toThrow(/policy.*byte limit/i);
    expect(existsSync(oversized.outputDir)).toBe(false);
  });

  it("requires exact 0600 modes and rejects undeclared or symlinked output entries", () => {
    const looseMode = fixture();
    seal(looseMode);
    chmodSync(join(looseMode.outputDir, "selection-manifest.json"), 0o400);
    expect(() => verifyPhase1CohortSeal(selectionOptions(looseMode))).toThrow(/permission|0600/i);

    const extra = fixture();
    seal(extra);
    writeFileSync(join(extra.outputDir, "UNDECLARED"), "unexpected\n", { mode: 0o600 });
    expect(() => verifyPhase1CohortSeal(selectionOptions(extra))).toThrow(/undeclared|artifact set/i);
    expect(() => seal(extra)).toThrow(/undeclared|artifact set/i);

    const linked = fixture();
    seal(linked);
    const targetDir = join(linked.root, "link-target");
    mkdirSync(targetDir);
    const target = join(targetDir, "receipt.json");
    writeFileSync(target, readFileSync(join(linked.outputDir, "selection-receipt.json")), { mode: 0o600 });
    rmSync(join(linked.outputDir, "selection-receipt.json"));
    symlinkSync(target, join(linked.outputDir, "selection-receipt.json"));
    expect(() => verifyPhase1CohortSeal(selectionOptions(linked))).toThrow(/symlink|artifact/i);
    expect(() => seal(linked)).toThrow(/symlink|artifact/i);
  });

  it("does not mutate an existing drifted directory or clobber a partial final path", () => {
    const driftedDirectory = fixture();
    mkdirSync(driftedDirectory.outputDir, { mode: 0o755 });
    const extraPath = join(driftedDirectory.outputDir, "UNDECLARED");
    writeFileSync(extraPath, "keep-me\n", { mode: 0o644 });
    const beforeMode = statSync(driftedDirectory.outputDir).mode & 0o777;
    expect(() => seal(driftedDirectory)).toThrow(/undeclared|artifact set|directory mode/i);
    expect(statSync(driftedDirectory.outputDir).mode & 0o777).toBe(beforeMode);
    expect(readFileSync(extraPath, "utf8")).toBe("keep-me\n");
    expect(readdirNames(driftedDirectory.outputDir)).toEqual(["UNDECLARED"]);

    const partial = fixture();
    mkdirSync(partial.outputDir, { mode: 0o700 });
    const finalPath = join(partial.outputDir, "selection-manifest.json");
    writeFileSync(finalPath, "do-not-clobber\n", { mode: 0o600 });
    expect(() => seal(partial)).toThrow(/incomplete|drift|artifact set/i);
    expect(readFileSync(finalPath, "utf8")).toBe("do-not-clobber\n");
    expect(readdirNames(partial.outputDir)).toEqual(["selection-manifest.json"]);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path).sort();
}
