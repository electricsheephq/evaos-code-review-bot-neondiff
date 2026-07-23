import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareReviewBenchAdjudicationPacket,
  verifyReviewBenchAdvisoryAdjudicationResponses,
  verifyReviewBenchAdjudicationResponses,
  type ReviewBenchAdvisoryAdjudicationResponseV1,
  type ReviewBenchAdvisoryAdjudicationReceiptV2,
  type ReviewBenchAdvisoryAiResolverResponseV1,
  type ReviewBenchAdjudicationCandidateV1,
  type ReviewBenchAdjudicationPacketV1,
  type ReviewBenchAdjudicationResponseV1,
  type ReviewBenchAdjudicationResolverResponseV1,
  type ReviewBenchAdjudicationReceiptV1
} from "../src/review-bench-adjudication-packets.js";

const PREPARED_AT = "2026-07-13T08:00:00.000Z";
const VERIFIED_AT = "2026-07-13T10:00:00.000Z";
const RUBRIC = "# review-bench-rubric/v1\nActionability and severity definitions.\n";
const PROTOCOL = "# review-bench-adjudication-protocol/v1\nIndependent blinded adjudication.\n";
const ADVISORY_PROTOCOL = "# review-bench-phase1-advisory-protocol/v1\nIndependent blinded agent advisory adjudication.\n";
const DIFF = [
  "diff --git a/src/state.ts b/src/state.ts",
  "index 1111111..2222222 100644",
  "--- a/src/state.ts",
  "+++ b/src/state.ts",
  "@@ -1,2 +1,2 @@",
  " const current = readState();",
  "-writeState(current);",
  "+writeState(next);",
  ""
].join("\n");
const DELETION_DIFF = [
  "diff --git a/src/legacy.ts b/src/legacy.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/legacy.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const legacy = true;",
  ""
].join("\n");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): {
  root: string;
  candidatePath: string;
  artifactsDirectory: string;
  outputDirectory: string;
  candidate: ReviewBenchAdjudicationCandidateV1;
} {
  const root = mkdtempSync(join(tmpdir(), "neondiff-adjudication-"));
  roots.push(root);
  const artifactsDirectory = join(root, "artifacts");
  mkdirSync(artifactsDirectory);
  const candidate: ReviewBenchAdjudicationCandidateV1 = {
    schemaVersion: "review-bench-adjudication-candidate/v1",
    candidateId: "candidate:public-safe-1",
    blindingNonce: sha256("fixture-blinding-nonce"),
    sourceArtifactSha256: sha256(DIFF),
    language: "TypeScript",
    annotationUniverse: {
      schemaVersion: "review-bench-annotation-universe/v1",
      frozenAt: "2026-07-13T07:00:00.000Z",
      methodVersion: "review-bench-adjudication-protocol/v1",
      methodSha256: sha256(PROTOCOL),
      candidates: [{
        id: "candidate:state-write",
        path: "src/state.ts",
        line: 2,
        title: "Potential stale state write",
        body: "The final-side write might use a stale value."
      }]
    },
    rubricVersion: "review-bench-rubric/v1",
    rubricSha256: sha256(RUBRIC),
    protocolVersion: "review-bench-adjudication-protocol/v1",
    protocolSha256: sha256(PROTOCOL)
  };
  const candidatePath = join(root, "candidate.json");
  writeFileSync(candidatePath, `${stableJson(candidate)}\n`);
  writeFileSync(join(artifactsDirectory, `${candidate.sourceArtifactSha256}.diff`), DIFF);
  writeFileSync(join(artifactsDirectory, `${candidate.rubricSha256}.rubric.md`), RUBRIC);
  writeFileSync(join(artifactsDirectory, `${candidate.protocolSha256}.protocol.md`), PROTOCOL);
  return { root, candidatePath, artifactsDirectory, outputDirectory: join(root, "packet"), candidate };
}

function prepare(input = fixture()): ReturnType<typeof fixture> & { packetPath: string; packet: ReviewBenchAdjudicationPacketV1 } {
  prepareReviewBenchAdjudicationPacket({
    candidatePath: input.candidatePath,
    artifactsDirectory: input.artifactsDirectory,
    outputDirectory: input.outputDirectory,
    preparedAt: PREPARED_AT
  });
  const packetPath = join(input.outputDirectory, "packet.json");
  return { ...input, packetPath, packet: JSON.parse(readFileSync(packetPath, "utf8")) as ReviewBenchAdjudicationPacketV1 };
}

function advisoryFixture(): ReturnType<typeof fixture> {
  const input = fixture();
  input.candidate.protocolVersion = "review-bench-phase1-advisory-protocol/v1";
  input.candidate.protocolSha256 = sha256(ADVISORY_PROTOCOL);
  input.candidate.annotationUniverse.methodVersion = input.candidate.protocolVersion;
  input.candidate.annotationUniverse.methodSha256 = input.candidate.protocolSha256;
  writeFileSync(input.candidatePath, `${stableJson(input.candidate)}\n`);
  writeFileSync(
    join(input.artifactsDirectory, `${input.candidate.protocolSha256}.protocol.md`),
    ADVISORY_PROTOCOL
  );
  return input;
}

function prepareAdvisory(): ReturnType<typeof prepare> {
  return prepare(advisoryFixture());
}

function response(
  packet: ReviewBenchAdjudicationPacketV1,
  adjudicatorId: string,
  overrides: Partial<ReviewBenchAdjudicationResponseV1> = {}
): ReviewBenchAdjudicationResponseV1 {
  return {
    schemaVersion: "review-bench-adjudication-response/v1",
    packetFingerprint: packet.packetFingerprint,
    adjudicatorId,
    verdict: "defect_present",
    decisions: packet.annotationUniverse.candidates.map((candidate) => ({
      candidateId: candidate.id,
      actionability: "actionable" as const,
      severity: "P1" as const
    })),
    rationale: "The final-side change has a reviewable correctness risk.",
    completedAt: "2026-07-13T09:00:00.000Z",
    blindedToProviderIdentity: true,
    blindedToPeerDecision: true,
    ...overrides
  };
}

function resolver(
  packet: ReviewBenchAdjudicationPacketV1,
  overrides: Partial<ReviewBenchAdjudicationResolverResponseV1> = {}
): ReviewBenchAdjudicationResolverResponseV1 {
  return {
    schemaVersion: "review-bench-adjudication-resolver-response/v1",
    packetFingerprint: packet.packetFingerprint,
    adjudicatorId: "human:resolver",
    verdict: "defect_present",
    decisions: packet.annotationUniverse.candidates.map((candidate) => ({
      candidateId: candidate.id,
      actionability: "actionable" as const,
      severity: "P2" as const
    })),
    rationale: "The disputed unit is resolved from the same blinded packet.",
    completedAt: "2026-07-13T09:30:00.000Z",
    blindedToProviderIdentity: true,
    reviewedDisagreement: true,
    ...overrides
  };
}

function aiResolver(
  packet: ReviewBenchAdjudicationPacketV1,
  overrides: Partial<ReviewBenchAdvisoryAiResolverResponseV1> = {}
): ReviewBenchAdvisoryAiResolverResponseV1 {
  return {
    schemaVersion: "review-bench-advisory-ai-resolver-response/v1",
    packetFingerprint: packet.packetFingerprint,
    adjudicatorId: "agent:high-reasoning-resolver",
    verdict: "defect_present",
    decisions: packet.annotationUniverse.candidates.map((candidate) => ({
      candidateId: candidate.id,
      actionability: "actionable" as const,
      severity: "P2" as const
    })),
    rationale: "The independent AI resolver re-analyzed the supplied packet and frozen disagreement.",
    completedAt: "2026-07-13T09:30:00.000Z",
    blindedToProviderIdentity: true,
    reviewedDisagreement: true,
    ...overrides
  };
}

function agentResponse(
  packet: ReviewBenchAdjudicationPacketV1,
  adjudicatorId: string,
  overrides: Partial<ReviewBenchAdvisoryAdjudicationResponseV1> = {}
): ReviewBenchAdvisoryAdjudicationResponseV1 {
  return {
    schemaVersion: "review-bench-advisory-adjudication-response/v1",
    packetFingerprint: packet.packetFingerprint,
    adjudicatorId,
    verdict: "defect_present",
    decisions: packet.annotationUniverse.candidates.map((candidate) => ({
      candidateId: candidate.id,
      actionability: "actionable" as const,
      severity: "P1" as const
    })),
    rationale: "The blinded advisory reviewer found a correctness risk.",
    completedAt: "2026-07-13T09:00:00.000Z",
    blindedToProviderIdentity: true,
    blindedToPeerDecision: true,
    ...overrides
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${stableJson(value)}\n`, { mode: 0o600 });
}

function responsePaths(prepared: ReturnType<typeof prepare>, primary: unknown, secondary: unknown) {
  const primaryResponsePath = join(prepared.root, "primary.json");
  const secondaryResponsePath = join(prepared.root, "secondary.json");
  const receiptPath = join(prepared.root, "receipt.json");
  writeJson(primaryResponsePath, primary);
  writeJson(secondaryResponsePath, secondary);
  return { primaryResponsePath, secondaryResponsePath, receiptPath };
}

describe("review-bench adjudication packet preparation", () => {
  it("prepares a deterministic blinded packet and digest-only summary", () => {
    const input = fixture();
    const secondOutput = join(input.root, "packet-two");
    const first = prepare(input);
    const summary = prepareReviewBenchAdjudicationPacket({
      candidatePath: input.candidatePath,
      artifactsDirectory: input.artifactsDirectory,
      outputDirectory: secondOutput,
      preparedAt: PREPARED_AT
    });
    const second = JSON.parse(readFileSync(join(secondOutput, "packet.json"), "utf8")) as ReviewBenchAdjudicationPacketV1;

    expect(summary.packetFingerprint).toBe(first.packet.packetFingerprint);
    expect(second).toEqual(first.packet);
    expect(first.packet).toMatchObject({
      schemaVersion: "review-bench-adjudication-packet/v1",
      packetId: expect.stringMatching(/^packet:[a-f0-9]{32}$/),
      preparedAt: PREPARED_AT,
      declarations: {
        providerIdentityExcluded: true,
        peerDecisionsExcluded: true,
        oracleGoldAnswersExcluded: true
      }
    });
    expect(first.packet.annotationUniverse.candidates[0]).toEqual({
      id: expect.stringMatching(/^item:[a-f0-9]{32}$/),
      path: "src/state.ts",
      line: 2,
      sourceCandidateCommitmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      question: "Does this exact final-side anchor contain an actionable correctness or security defect under the bound rubric?"
    });
    expect(stableJson(first.packet)).not.toContain(input.candidate.candidateId);
    expect(stableJson(first.packet)).not.toContain(input.candidate.blindingNonce);
    expect(stableJson(first.packet)).not.toContain(input.candidate.annotationUniverse.candidates[0]!.id);
    expect(stableJson(summary)).not.toContain(input.candidate.annotationUniverse.candidates[0]!.body);
  });

  it("creates private no-clobber output and removes only its own directory on failure", () => {
    const prepared = prepare();
    expect(statSync(prepared.outputDirectory).mode & 0o777).toBe(0o700);
    for (const name of [
      "packet.json",
      `${prepared.candidate.sourceArtifactSha256}.diff`,
      `${prepared.candidate.rubricSha256}.rubric.md`,
      `${prepared.candidate.protocolSha256}.protocol.md`
    ]) expect(statSync(join(prepared.outputDirectory, name)).mode & 0o777).toBe(0o600);
    expect(() => prepareReviewBenchAdjudicationPacket({
      candidatePath: prepared.candidatePath,
      artifactsDirectory: prepared.artifactsDirectory,
      outputDirectory: prepared.outputDirectory,
      preparedAt: PREPARED_AT
    })).toThrow(/fresh|exist|no-clobber/i);
    expect(lstatSync(prepared.outputDirectory).isDirectory()).toBe(true);
  });

  it("rejects output parents writable by another operating-system user", () => {
    const input = fixture();
    chmodSync(input.root, 0o777);
    expect(() => prepare(input)).toThrow(/group|other users|ownership/i);
    chmodSync(input.root, 0o700);
  });

  it("rejects extra candidate keys instead of carrying sensitive fields into the packet", () => {
    const input = fixture();
    writeJson(input.candidatePath, { ...input.candidate, oracle: { answer: "hidden" } });
    expect(() => prepare(input)).toThrow(/unknown keys.*oracle/i);
    expect(() => statSync(input.outputDirectory)).toThrow();
  });

  it("rejects an all-zero blinding nonce as trivially weak", () => {
    const input = fixture();
    input.candidate.blindingNonce = "0".repeat(64);
    writeJson(input.candidatePath, input.candidate);

    expect(() => prepare(input)).toThrow(/blindingNonce|all-zero|entropy|CSPRNG/i);
    expect(() => statSync(input.outputDirectory)).toThrow();
  });

  it("replaces source identity and allegation text with opaque commitments bound into the packet", () => {
    const input = fixture();
    input.candidate.candidateId = "glm-5.2:holdout:oracle-answer";
    input.candidate.annotationUniverse.candidates[0]!.id = "qwen3:gold:P0";
    input.candidate.annotationUniverse.candidates[0]!.title = "Gold answer P0";
    input.candidate.annotationUniverse.candidates[0]!.body = "Provider-specific expected answer.";
    writeJson(input.candidatePath, input.candidate);
    const prepared = prepare(input);
    const serialized = stableJson(prepared.packet);
    expect(serialized).not.toContain(input.candidate.candidateId);
    expect(serialized).not.toContain(input.candidate.annotationUniverse.candidates[0]!.id);
    expect(serialized).not.toContain(input.candidate.annotationUniverse.candidates[0]!.title);
    expect(serialized).not.toContain(input.candidate.annotationUniverse.candidates[0]!.body);
    expect(prepared.packet.packetId).toMatch(/^packet:[a-f0-9]{32}$/);
    expect(prepared.packet.annotationUniverse.candidates[0]!.id).toMatch(/^item:[a-f0-9]{32}$/);

    const changed = fixture();
    changed.candidate.candidateId = input.candidate.candidateId;
    changed.candidate.annotationUniverse.candidates[0]!.id = input.candidate.annotationUniverse.candidates[0]!.id;
    changed.candidate.annotationUniverse.candidates[0]!.title = "A different alleged defect";
    changed.candidate.annotationUniverse.candidates[0]!.body = "This claim differs while retaining the same source anchor.";
    writeJson(changed.candidatePath, changed.candidate);
    const changedPacket = prepare(changed);
    expect(changedPacket.packet.packetFingerprint).not.toBe(prepared.packet.packetFingerprint);
  });

  it("keeps distinct allegations at the same final-side anchor as separate blinded units", () => {
    const input = fixture();
    input.candidate.annotationUniverse.candidates.push({
      id: "candidate:state-write-second-allegation",
      path: "src/state.ts",
      line: 2,
      title: "Potential write ordering defect",
      body: "The same final-side write might occur before a required state transition."
    });
    writeJson(input.candidatePath, input.candidate);

    const prepared = prepare(input);
    expect(prepared.packet.annotationUniverse.candidates).toHaveLength(2);
    expect(new Set(prepared.packet.annotationUniverse.candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(new Set(prepared.packet.annotationUniverse.candidates.map(
      (candidate) => candidate.sourceCandidateCommitmentSha256
    )).size).toBe(2);

    const incomplete = response(prepared.packet, "human:one", {
      decisions: [response(prepared.packet, "human:one").decisions[0]!]
    });
    const paths = responsePaths(prepared, incomplete, response(prepared.packet, "human:two"));
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/complete|candidate|decision/i);
  });

  it("rejects duplicate allegation content even when source candidate ids differ", () => {
    const input = fixture();
    input.candidate.annotationUniverse.candidates.push({
      ...input.candidate.annotationUniverse.candidates[0]!,
      id: "candidate:duplicate-content"
    });
    writeJson(input.candidatePath, input.candidate);

    expect(() => prepare(input)).toThrow(/duplicate.*content/i);
    expect(() => statSync(input.outputDirectory)).toThrow();
  });

  it("fails closed on malformed, duplicate-key, noncanonical, and invalid UTF-8 candidate JSON", () => {
    for (const bytes of [
      "{",
      `{"schemaVersion":"review-bench-adjudication-candidate/v1","schemaVersion":"review-bench-adjudication-candidate/v1"}`,
      JSON.stringify(fixture().candidate, null, 2),
      Buffer.from([0xff])
    ]) {
      const input = fixture();
      writeFileSync(input.candidatePath, bytes);
      expect(() => prepare(input)).toThrow(/UTF-8|JSON|canonical|duplicate/i);
    }
  });

  it("rejects symlinks, non-regular or empty artifacts, and digest mismatches", () => {
    const linked = fixture();
    const candidateLink = join(linked.root, "candidate-link.json");
    symlinkSync(linked.candidatePath, candidateLink);
    linked.candidatePath = candidateLink;
    expect(() => prepare(linked)).toThrow();

    const linkedArtifact = fixture();
    const linkedSourcePath = join(
      linkedArtifact.artifactsDirectory,
      `${linkedArtifact.candidate.sourceArtifactSha256}.diff`
    );
    const linkedSourceTarget = join(linkedArtifact.artifactsDirectory, "source-target.diff");
    rmSync(linkedSourcePath);
    writeFileSync(linkedSourceTarget, DIFF);
    symlinkSync(linkedSourceTarget, linkedSourcePath);
    expect(() => prepare(linkedArtifact)).toThrow(/symbolic|symlink|regular|artifact/i);

    const directoryArtifact = fixture();
    const sourcePath = join(directoryArtifact.artifactsDirectory, `${directoryArtifact.candidate.sourceArtifactSha256}.diff`);
    rmSync(sourcePath);
    mkdirSync(sourcePath);
    expect(() => prepare(directoryArtifact)).toThrow(/regular|file|artifact/i);

    const empty = fixture();
    writeFileSync(join(empty.artifactsDirectory, `${empty.candidate.rubricSha256}.rubric.md`), "");
    expect(() => prepare(empty)).toThrow(/1-|empty|bytes/i);

    const mismatch = fixture();
    writeFileSync(join(mismatch.artifactsDirectory, `${mismatch.candidate.sourceArtifactSha256}.diff`), `${DIFF}tampered\n`);
    expect(() => prepare(mismatch)).toThrow(/sha256|digest/i);
  });

  it("rejects unsafe diff paths, missing anchors, unsupported languages, and secret-like text", () => {
    const unsafe = fixture();
    const unsafeDiff = DIFF.replaceAll("src/state.ts", "../state.ts");
    unsafe.candidate.sourceArtifactSha256 = sha256(unsafeDiff);
    unsafe.candidate.annotationUniverse.candidates[0]!.path = "../state.ts";
    writeJson(unsafe.candidatePath, unsafe.candidate);
    writeFileSync(join(unsafe.artifactsDirectory, `${unsafe.candidate.sourceArtifactSha256}.diff`), unsafeDiff);
    expect(() => prepare(unsafe)).toThrow(/canonical|path/i);

    const missingAnchor = fixture();
    missingAnchor.candidate.annotationUniverse.candidates[0]!.line = 99;
    writeJson(missingAnchor.candidatePath, missingAnchor.candidate);
    expect(() => prepare(missingAnchor)).toThrow(/anchor|final-side/i);

    const language = fixture();
    (language.candidate as { language: string }).language = "Kotlin";
    writeJson(language.candidatePath, language.candidate);
    expect(() => prepare(language)).toThrow(/language/i);

    const secret = fixture();
    const privateKeyMarker = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    const secretDiff = `${DIFF}${privateKeyMarker}\n`;
    secret.candidate.sourceArtifactSha256 = sha256(secretDiff);
    writeJson(secret.candidatePath, secret.candidate);
    writeFileSync(join(secret.artifactsDirectory, `${secret.candidate.sourceArtifactSha256}.diff`), secretDiff);
    expect(() => prepare(secret)).toThrow(/secret/i);
  });

  it("rejects non-diff text outside validated hunks", () => {
    for (const contaminatedDiff of [
      `Known answer: stale state write\n${DIFF}`,
      `${DIFF}\nKnown answer: stale state write\n`
    ]) {
      const input = fixture();
      input.candidate.sourceArtifactSha256 = sha256(contaminatedDiff);
      writeJson(input.candidatePath, input.candidate);
      writeFileSync(
        join(input.artifactsDirectory, `${input.candidate.sourceArtifactSha256}.diff`),
        contaminatedDiff
      );

      expect(() => prepare(input)).toThrow(/outside validated hunks|unexpected content/i);
      expect(() => statSync(input.outputDirectory)).toThrow();
    }
  });

  it("accepts Git-generated index metadata with short object abbreviations", () => {
    for (const abbreviatedIndex of [
      "index 7f72..9485 100644",
      "index 7f72a..9485b 100644",
      "index 7f72ab..9485bc 100644"
    ]) {
      const input = fixture();
      const abbreviatedDiff = DIFF.replace("index 1111111..2222222 100644", abbreviatedIndex);
      input.candidate.sourceArtifactSha256 = sha256(abbreviatedDiff);
      writeJson(input.candidatePath, input.candidate);
      writeFileSync(
        join(input.artifactsDirectory, `${input.candidate.sourceArtifactSha256}.diff`),
        abbreviatedDiff
      );

      expect(() => prepare(input), abbreviatedIndex).not.toThrow();
    }
  });

  it("rejects unified diff hunks whose declared line counts do not match their body", () => {
    const input = fixture();
    const malformedDiff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "index 1111111..2222222 100644",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -1 +1 @@",
      "-writeState(current);",
      "+const next = readState();",
      "+writeState(next);",
      ""
    ].join("\n");
    input.candidate.sourceArtifactSha256 = sha256(malformedDiff);
    writeJson(input.candidatePath, input.candidate);
    writeFileSync(join(input.artifactsDirectory, `${input.candidate.sourceArtifactSha256}.diff`), malformedDiff);

    expect(() => prepare(input)).toThrow(/hunk|count|malformed/i);
    expect(() => statSync(input.outputDirectory)).toThrow();
  });

  it("treats final-side content beginning with two plus signs as hunk content", () => {
    const input = fixture();
    const plusContentDiff = DIFF.replace("+writeState(next);", "+++ marker");
    input.candidate.sourceArtifactSha256 = sha256(plusContentDiff);
    writeJson(input.candidatePath, input.candidate);
    writeFileSync(join(input.artifactsDirectory, `${input.candidate.sourceArtifactSha256}.diff`), plusContentDiff);

    expect(() => prepare(input)).not.toThrow();
  });

  it("accepts valid zero-count insertion and deletion hunks away from line zero", () => {
    const insertion = fixture();
    const insertionDiff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "index 1111111..2222222 100644",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -5,0 +6,2 @@",
      "+const next = readState();",
      "+writeState(next);",
      ""
    ].join("\n");
    insertion.candidate.sourceArtifactSha256 = sha256(insertionDiff);
    insertion.candidate.annotationUniverse.candidates[0]!.line = 6;
    writeJson(insertion.candidatePath, insertion.candidate);
    writeFileSync(join(
      insertion.artifactsDirectory,
      `${insertion.candidate.sourceArtifactSha256}.diff`
    ), insertionDiff);
    expect(() => prepare(insertion)).not.toThrow();

    const deletion = fixture();
    const deletionDiff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "index 1111111..2222222 100644",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -5,2 +4,0 @@",
      "-writeState(current);",
      "-writeState(stale);",
      ""
    ].join("\n");
    deletion.candidate.sourceArtifactSha256 = sha256(deletionDiff);
    deletion.candidate.annotationUniverse.candidates = [];
    writeJson(deletion.candidatePath, deletion.candidate);
    writeFileSync(join(
      deletion.artifactsDirectory,
      `${deletion.candidate.sourceArtifactSha256}.diff`
    ), deletionDiff);
    expect(() => prepare(deletion)).not.toThrow();
  });

  it("requires matching old and new file headers before accepting a hunk", () => {
    for (const invalidDiff of [
      DIFF.replace("+++ b/src/state.ts", "+++ b/src/other.py"),
      DIFF.replace("--- a/src/state.ts\n", ""),
      DIFF.replace("+++ b/src/state.ts\n", "")
    ]) {
      const input = fixture();
      input.candidate.sourceArtifactSha256 = sha256(invalidDiff);
      if (invalidDiff.includes("src/other.py")) {
        input.candidate.annotationUniverse.candidates[0]!.path = "src/other.py";
      }
      writeJson(input.candidatePath, input.candidate);
      writeFileSync(join(
        input.artifactsDirectory,
        `${input.candidate.sourceArtifactSha256}.diff`
      ), invalidDiff);

      expect(() => prepare(input)).toThrow(/header|path|hunk|match/i);
      expect(() => statSync(input.outputDirectory)).toThrow();
    }
  });

  it("rejects header-only diff sections instead of counting them toward the language gate", () => {
    const headerOnly = [
      "diff --git a/src/state.ts b/src/state.ts",
      "index 1111111..2222222 100644",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      ""
    ].join("\n");
    const pythonSection = [
      "diff --git a/src/other.py b/src/other.py",
      "index 1111111..2222222 100644",
      "--- a/src/other.py",
      "+++ b/src/other.py",
      "@@ -1 +1 @@",
      "-current = read_state()",
      "+next_state = read_state()",
      ""
    ].join("\n");

    for (const [diff, path, candidates] of [
      [headerOnly, "src/state.ts", []],
      [headerOnly + pythonSection, "src/other.py", [{
        id: "candidate:python-anchor",
        path: "src/other.py",
        line: 1,
        title: "Python-only allegation",
        body: "This anchor must not inherit the header-only TypeScript language classification."
      }]]
    ] as const) {
      const input = fixture();
      input.candidate.sourceArtifactSha256 = sha256(diff);
      input.candidate.annotationUniverse.candidates = [...candidates];
      writeJson(input.candidatePath, input.candidate);
      writeFileSync(join(
        input.artifactsDirectory,
        `${input.candidate.sourceArtifactSha256}.diff`
      ), diff);

      expect(() => prepare(input), path).toThrow(/section|hunk|header/i);
      expect(() => statSync(input.outputDirectory)).toThrow();
    }
  });

  it("binds dev-null side headers to zero hunk counts and rejects empty hunks", () => {
    const malformedDiffs = [
      DIFF.replace("--- a/src/state.ts", "--- /dev/null"),
      DIFF.replace("+++ b/src/state.ts", "+++ /dev/null"),
      [
        "diff --git a/src/state.ts b/src/state.ts",
        "index 1111111..2222222 100644",
        "--- a/src/state.ts",
        "+++ b/src/state.ts",
        "@@ -0,0 +0,0 @@",
        ""
      ].join("\n"),
      [
        "diff --git a/src/state.ts b/src/state.ts",
        "index 1111111..2222222 100644",
        "--- /dev/null",
        "+++ /dev/null",
        "@@ -0,0 +0,0 @@",
        ""
      ].join("\n")
    ];

    for (const malformedDiff of malformedDiffs) {
      const input = fixture();
      input.candidate.sourceArtifactSha256 = sha256(malformedDiff);
      input.candidate.annotationUniverse.candidates = [];
      writeJson(input.candidatePath, input.candidate);
      writeFileSync(join(
        input.artifactsDirectory,
        `${input.candidate.sourceArtifactSha256}.diff`
      ), malformedDiff);

      expect(() => prepare(input)).toThrow(/null|side|count|empty|hunk/i);
      expect(() => statSync(input.outputDirectory)).toThrow();
    }
  });

  it("supports an empty blinded universe for deletion-only clean controls", () => {
    const input = fixture();
    input.candidate.sourceArtifactSha256 = sha256(DELETION_DIFF);
    input.candidate.annotationUniverse.candidates = [];
    writeJson(input.candidatePath, input.candidate);
    writeFileSync(join(input.artifactsDirectory, `${input.candidate.sourceArtifactSha256}.diff`), DELETION_DIFF);
    const prepared = prepare(input);
    expect(prepared.packet.annotationUniverse.candidates).toEqual([]);

    const clean = (adjudicatorId: string) => response(prepared.packet, adjudicatorId, {
      verdict: "verified_clean",
      decisions: []
    });
    const paths = responsePaths(prepared, clean("human:one"), clean("human:two"));
    const summary = verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    });
    expect(summary.status).toBe("ready");
  });
});

describe("review-bench adjudication response verification", () => {
  it("rejects a packet whose annotation universe froze after packet preparation", () => {
    const prepared = prepare();
    prepared.packet.annotationUniverse.frozenAt = "2026-07-13T08:30:00.000Z";
    const packetBasis = { ...prepared.packet } as Record<string, unknown>;
    delete packetBasis.packetFingerprint;
    prepared.packet.packetFingerprint = sha256(stableJson(packetBasis));
    writeJson(prepared.packetPath, prepared.packet);
    const paths = responsePaths(
      prepared,
      response(prepared.packet, "human:one"),
      response(prepared.packet, "human:two")
    );

    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/frozenAt.*preparedAt|annotation universe chronology/i);
  });

  it("runs the offline prepare and verify CLI happy path without echoing private content", () => {
    const input = fixture();
    const prepareResult = spawnSync("npx", [
      "tsx", "src/cli.ts", "review-bench", "prepare-adjudication",
      "--candidate", input.candidatePath,
      "--artifacts", input.artifactsDirectory,
      "--output", input.outputDirectory
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(prepareResult.status).toBe(0);
    expect(prepareResult.stdout).not.toContain(input.candidate.annotationUniverse.candidates[0]!.body);
    const packetPath = join(input.outputDirectory, "packet.json");
    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as ReviewBenchAdjudicationPacketV1;
    const paths = responsePaths(
      { ...input, packetPath, packet },
      response(packet, "human:one", { completedAt: packet.preparedAt }),
      response(packet, "human:two", { completedAt: packet.preparedAt })
    );
    const verifyResult = spawnSync("npx", [
      "tsx", "src/cli.ts", "review-bench", "verify-adjudication",
      "--packet", packetPath,
      "--primary", paths.primaryResponsePath,
      "--secondary", paths.secondaryResponsePath,
      "--receipt", paths.receiptPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(verifyResult.status).toBe(0);
    expect(JSON.parse(verifyResult.stdout)).toMatchObject({ status: "ready" });
    expect(JSON.parse(readFileSync(paths.receiptPath, "utf8"))).toMatchObject({
      status: "ready",
      receiptKind: "initial_ready"
    });
  }, 20_000);

  it("exits one while emitting a needs_resolution routing summary", () => {
    const prepared = prepare();
    const primary = response(prepared.packet, "human:one");
    const secondary = response(prepared.packet, "human:two", {
      verdict: "verified_clean",
      decisions: [{
        candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
        actionability: "not_actionable"
      }],
      rationale: "The change appears clean."
    });
    const paths = responsePaths(prepared, primary, secondary);
    const verifyResult = spawnSync("npx", [
      "tsx", "src/cli.ts", "review-bench", "verify-adjudication",
      "--packet", prepared.packetPath,
      "--primary", paths.primaryResponsePath,
      "--secondary", paths.secondaryResponsePath,
      "--receipt", paths.receiptPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(verifyResult.status).toBe(1);
    expect(JSON.parse(verifyResult.stdout)).toMatchObject({ status: "needs_resolution" });
    expect(JSON.parse(readFileSync(paths.receiptPath, "utf8"))).toMatchObject({ status: "needs_resolution" });
  }, 20_000);

  it("emits a ready immutable receipt for agreeing independent responses", () => {
    const prepared = prepare();
    const primary = response(prepared.packet, "human:one");
    const secondary = response(prepared.packet, "human:two");
    const paths = responsePaths(prepared, primary, secondary);
    const summary = verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    });
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8")) as ReviewBenchAdjudicationReceiptV1;

    expect(summary).toMatchObject({ status: "ready", receiptSha256: receipt.receiptSha256 });
    expect(receipt).toMatchObject({
      schemaVersion: "review-bench-adjudication-receipt/v1",
      status: "ready",
      receiptKind: "initial_ready",
      artifactBothDefectCount: 1,
      actionabilityBothActionableCount: 1,
      severityWithinOneTierCount: 1,
      disagreementCount: 0
    });
    expect(receipt.resolvedDecisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.disagreementQueueSha256).toBe(sha256(stableJson(receipt.disagreementQueue)));
    expect(receipt.disagreementQueueSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(receipt).sort()).toEqual([
      "actionabilityBothActionableCount",
      "actionabilityNeitherCount",
      "actionabilityPrimaryOnlyCount",
      "actionabilitySecondaryOnlyCount",
      "artifactBothCleanCount",
      "artifactBothDefectCount",
      "artifactPrimaryOnlyDefectCount",
      "artifactSecondaryOnlyDefectCount",
      "disagreementCount",
      "disagreementQueue",
      "disagreementQueueSha256",
      "packetFingerprint",
      "packetSha256",
      "primaryAdjudicatorId",
      "primaryResponseSha256",
      "receiptKind",
      "receiptSha256",
      "resolvedDecisionSha256",
      "schemaVersion",
      "secondaryAdjudicatorId",
      "secondaryResponseSha256",
      "severityBothActionableCount",
      "severityWithinOneTierCount",
      "status",
      "verifiedAt"
    ]);
    expect(statSync(paths.receiptPath).mode & 0o777).toBe(0o600);
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/exist|no-clobber/i);
  });

  it("rejects overlong receipt leaf names before temporary publication", () => {
    const prepared = prepare();
    const paths = responsePaths(
      prepared,
      response(prepared.packet, "human:one"),
      response(prepared.packet, "human:two")
    );
    paths.receiptPath = join(prepared.root, `${"r".repeat(129)}.json`);

    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/128|length|component|bytes/i);
  });

  it("rejects packet and response inputs stored inside a Git checkout", () => {
    for (const inputKind of ["packet", "primary", "secondary", "resolver"] as const) {
      const prepared = prepare();
      const primary = response(prepared.packet, "human:one");
      const secondary = response(prepared.packet, "human:two", inputKind === "resolver" ? {
        verdict: "verified_clean",
        decisions: [{
          candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
          actionability: "not_actionable"
        }],
        rationale: "The change appears clean."
      } : {});
      const paths = responsePaths(prepared, primary, secondary);
      const checkoutInput = mkdtempSync(join(process.cwd(), ".review-bench-inside-checkout-"));
      roots.push(checkoutInput);
      let packetPath = prepared.packetPath;
      let primaryResponsePath = paths.primaryResponsePath;
      let secondaryResponsePath = paths.secondaryResponsePath;
      let resolverResponsePath: string | undefined;

      if (inputKind === "packet") {
        cpSync(prepared.outputDirectory, checkoutInput, { recursive: true });
        packetPath = join(checkoutInput, "packet.json");
      } else if (inputKind === "primary") {
        primaryResponsePath = join(checkoutInput, "primary.json");
        writeJson(primaryResponsePath, primary);
      } else if (inputKind === "secondary") {
        secondaryResponsePath = join(checkoutInput, "secondary.json");
        writeJson(secondaryResponsePath, secondary);
      } else {
        resolverResponsePath = join(checkoutInput, "resolver.json");
        writeJson(resolverResponsePath, resolver(prepared.packet));
      }

      expect(() => verifyReviewBenchAdjudicationResponses({
        packetPath,
        primaryResponsePath,
        secondaryResponsePath,
        ...(resolverResponsePath === undefined ? {} : { resolverResponsePath }),
        receiptPath: paths.receiptPath,
        verifiedAt: VERIFIED_AT
      })).toThrow(/outside a Git checkout/i);
      expect(() => statSync(paths.receiptPath)).toThrow();
    }
  });

  it("rejects adjudication inputs from a group-writable parent", () => {
    const prepared = prepare();
    const paths = responsePaths(
      prepared,
      response(prepared.packet, "human:one"),
      response(prepared.packet, "human:two")
    );
    chmodSync(prepared.root, 0o770);

    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/primary response parent.*writable by group|writable by group or other/i);
    expect(() => statSync(paths.receiptPath)).toThrow();
  });

  it("emits needs_resolution and a deterministic bounded queue without a resolver", () => {
    const prepared = prepare();
    const primary = response(prepared.packet, "human:one");
    const secondary = response(prepared.packet, "human:two", {
      verdict: "verified_clean",
      decisions: [{ candidateId: prepared.packet.annotationUniverse.candidates[0]!.id, actionability: "not_actionable" }],
      rationale: "The change appears clean."
    });
    const paths = responsePaths(prepared, primary, secondary);
    const summary = verifyReviewBenchAdjudicationResponses({ packetPath: prepared.packetPath, ...paths, verifiedAt: VERIFIED_AT });
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8")) as ReviewBenchAdjudicationReceiptV1;

    expect(summary.status).toBe("needs_resolution");
    expect(receipt.status).toBe("needs_resolution");
    expect(receipt.receiptKind).toBe("initial_needs_resolution");
    expect(receipt.resolvedDecisionSha256).toBeUndefined();
    expect(receipt.disagreementQueue).toMatchObject({
      schemaVersion: "review-bench-adjudication-disagreement/v1",
      verdictDisagreement: { primary: "defect_present", secondary: "verified_clean" }
    });
    expect(receipt.disagreementQueueSha256).toBe(sha256(stableJson(receipt.disagreementQueue)));
    expect(receipt.disagreementQueueSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stableJson(receipt.disagreementQueue)).not.toContain(primary.rationale);
  });

  it("requires exact severity resolution while retaining the one-tier agreement count", () => {
    const prepared = prepare();
    const primary = response(prepared.packet, "human:one");
    const secondary = response(prepared.packet, "human:two", {
      decisions: [{
        candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
        actionability: "actionable",
        severity: "P2"
      }]
    });
    const paths = responsePaths(prepared, primary, secondary);
    const summary = verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    });
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8")) as ReviewBenchAdjudicationReceiptV1;
    expect(summary.status).toBe("needs_resolution");
    expect(receipt.severityWithinOneTierCount).toBe(1);
    expect(receipt.disagreementCount).toBe(1);
  });

  it("uses a distinct later resolver only for disputed units", () => {
    const prepared = prepare();
    const primary = response(prepared.packet, "human:one");
    const secondary = response(prepared.packet, "human:two", {
      decisions: [{ candidateId: prepared.packet.annotationUniverse.candidates[0]!.id, actionability: "actionable", severity: "P3" }]
    });
    const paths = responsePaths(prepared, primary, secondary);
    const resolverPath = join(prepared.root, "resolver.json");
    writeJson(resolverPath, resolver(prepared.packet));
    const summary = verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      resolverResponsePath: resolverPath,
      verifiedAt: VERIFIED_AT
    });
    expect(summary.status).toBe("ready");
    expect(summary.resolvedDecisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(paths.receiptPath, "utf8"))).toMatchObject({
      status: "ready",
      receiptKind: "resolved"
    });

    const unnecessary = prepare(fixture());
    const agreePaths = responsePaths(
      unnecessary,
      response(unnecessary.packet, "human:one"),
      response(unnecessary.packet, "human:two")
    );
    const unnecessaryResolverPath = join(unnecessary.root, "resolver.json");
    writeJson(unnecessaryResolverPath, resolver(unnecessary.packet));
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: unnecessary.packetPath,
      ...agreePaths,
      resolverResponsePath: unnecessaryResolverPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/unnecessary|no disagreement/i);
  });

  it("supports all-nonactionable clean-control-style responses", () => {
    const prepared = prepare();
    const clean = (id: string) => response(prepared.packet, id, {
      verdict: "verified_clean",
      decisions: [{ candidateId: prepared.packet.annotationUniverse.candidates[0]!.id, actionability: "not_actionable" }]
    });
    const paths = responsePaths(prepared, clean("human:one"), clean("human:two"));
    const summary = verifyReviewBenchAdjudicationResponses({ packetPath: prepared.packetPath, ...paths, verifiedAt: VERIFIED_AT });
    expect(summary.status).toBe("ready");
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8")) as ReviewBenchAdjudicationReceiptV1;
    expect(receipt.actionabilityNeitherCount).toBe(1);
    expect(receipt.severityBothActionableCount).toBe(0);
  });

  it("rejects invalid identities, incomplete decisions, severity misuse, and chronology", () => {
    const cases: Array<[string, (packet: ReviewBenchAdjudicationPacketV1) => [unknown, unknown]]> = [
      ["distinct", (packet) => [response(packet, "human:same"), response(packet, "human:same")]],
      ["canonical", (packet) => [response(packet, "Human:One"), response(packet, "human:two")]],
      ["complete", (packet) => [response(packet, "human:one", { decisions: [] }), response(packet, "human:two")]],
      ["severity", (packet) => [response(packet, "human:one", { decisions: [{ candidateId: packet.annotationUniverse.candidates[0]!.id, actionability: "not_actionable", severity: "P1" }] }), response(packet, "human:two")]],
      ["severity", (packet) => [response(packet, "human:one", { decisions: [{ candidateId: packet.annotationUniverse.candidates[0]!.id, actionability: "actionable" }] }), response(packet, "human:two")]],
      ["verdict", (packet) => [response(packet, "human:one", { verdict: "verified_clean" }), response(packet, "human:two")]],
      ["chronology", (packet) => [response(packet, "human:one", { completedAt: "2026-07-13T06:00:00.000Z" }), response(packet, "human:two")]]
    ];
    for (const [expected, build] of cases) {
      const prepared = prepare();
      const [primary, secondary] = build(prepared.packet);
      const paths = responsePaths(prepared, primary, secondary);
      expect(() => verifyReviewBenchAdjudicationResponses({
        packetPath: prepared.packetPath,
        ...paths,
        verifiedAt: VERIFIED_AT
      })).toThrow(new RegExp(expected, "i"));
    }
  });

  it("rejects mismatched fingerprints and missing, extra, or duplicate decisions", () => {
    const variants: Array<(candidateId: string) => ReviewBenchAdjudicationResponseV1["decisions"]> = [
      () => [],
      (candidateId) => [
        { candidateId, actionability: "actionable", severity: "P1" },
        { candidateId: "item:00000000000000000000000000000000", actionability: "not_actionable" }
      ],
      (candidateId) => [
        { candidateId, actionability: "actionable", severity: "P1" },
        { candidateId, actionability: "not_actionable" }
      ]
    ];
    for (const buildDecisions of variants) {
      const prepared = prepare();
      const decisions = buildDecisions(prepared.packet.annotationUniverse.candidates[0]!.id);
      const primary = response(prepared.packet, "human:one", { decisions });
      const paths = responsePaths(prepared, primary, response(prepared.packet, "human:two"));
      expect(() => verifyReviewBenchAdjudicationResponses({ packetPath: prepared.packetPath, ...paths, verifiedAt: VERIFIED_AT })).toThrow(/candidate|decision|complete|duplicate|extra/i);
    }

    const prepared = prepare();
    const primary = response(prepared.packet, "human:one", { packetFingerprint: "0".repeat(64) });
    const paths = responsePaths(prepared, primary, response(prepared.packet, "human:two"));
    expect(() => verifyReviewBenchAdjudicationResponses({ packetPath: prepared.packetPath, ...paths, verifiedAt: VERIFIED_AT })).toThrow(/fingerprint/i);
  });

  it("rejects duplicate, early, or undisputed-unit-changing resolvers and packet artifact tampering", () => {
    for (const resolverOverride of [
      { adjudicatorId: "human:one" },
      { completedAt: "2026-07-13T08:30:00.000Z" }
    ]) {
      const prepared = prepare();
      const primary = response(prepared.packet, "human:one");
      const secondary = response(prepared.packet, "human:two", {
        verdict: "verified_clean",
        decisions: [{
          candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
          actionability: "not_actionable"
        }]
      });
      const paths = responsePaths(prepared, primary, secondary);
      const resolverPath = join(prepared.root, "resolver.json");
      writeJson(resolverPath, resolver(prepared.packet, resolverOverride));
      expect(() => verifyReviewBenchAdjudicationResponses({
        packetPath: prepared.packetPath,
        ...paths,
        resolverResponsePath: resolverPath,
        verifiedAt: VERIFIED_AT
      })).toThrow(/distinct|later|chronology/i);
    }

    const tampered = prepare();
    chmodSync(join(tampered.outputDirectory, `${tampered.candidate.sourceArtifactSha256}.diff`), 0o600);
    writeFileSync(join(tampered.outputDirectory, `${tampered.candidate.sourceArtifactSha256}.diff`), `${DIFF}tampered\n`);
    const paths = responsePaths(tampered, response(tampered.packet, "human:one"), response(tampered.packet, "human:two"));
    expect(() => verifyReviewBenchAdjudicationResponses({ packetPath: tampered.packetPath, ...paths, verifiedAt: VERIFIED_AT })).toThrow(/sha256|digest|tamper/i);
  });

  it("independently rejects secret-like packet artifacts and noncanonical response JSON", () => {
    const prepared = prepare();
    const privateKeyMarker = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    const secretDiff = `${DIFF}${privateKeyMarker}\n`;
    const secretDigest = sha256(secretDiff);
    writeFileSync(join(prepared.outputDirectory, `${secretDigest}.diff`), secretDiff, { mode: 0o600 });
    const packetBasis = { ...prepared.packet, sourceArtifactSha256: secretDigest } as Record<string, unknown>;
    delete packetBasis.packetFingerprint;
    const packet = {
      ...packetBasis,
      packetFingerprint: sha256(stableJson(packetBasis))
    };
    writeJson(prepared.packetPath, packet);
    const paths = responsePaths(
      { ...prepared, packet: packet as unknown as ReviewBenchAdjudicationPacketV1 },
      response(packet as unknown as ReviewBenchAdjudicationPacketV1, "human:one"),
      response(packet as unknown as ReviewBenchAdjudicationPacketV1, "human:two")
    );
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/secret/i);

    const duplicate = prepare();
    const primary = response(duplicate.packet, "human:one");
    const responseText = stableJson(primary);
    const duplicateResponse = responseText.replace(
      '"schemaVersion":"review-bench-adjudication-response/v1"',
      '"schemaVersion":"review-bench-adjudication-response/v1","schemaVersion":"review-bench-adjudication-response/v1"'
    );
    const duplicatePaths = responsePaths(
      duplicate,
      primary,
      response(duplicate.packet, "human:two")
    );
    writeFileSync(duplicatePaths.primaryResponsePath, duplicateResponse);
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: duplicate.packetPath,
      ...duplicatePaths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/canonical|duplicate/i);
  });

  it("rejects Phase 1 advisory protocol packets from the human Corpus v1 receipt path", () => {
    const prepared = prepareAdvisory();
    const paths = responsePaths(
      prepared,
      response(prepared.packet, "human:one"),
      response(prepared.packet, "human:two")
    );

    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: prepared.packetPath,
      ...paths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/rejects the Phase 1 advisory protocol/i);
  });
});

describe("review-bench advisory agent response verification", () => {
  it("emits only a Corpus-ineligible pilot-ready receipt when two blinded agents agree", () => {
    const prepared = prepareAdvisory();
    const paths = responsePaths(
      prepared,
      agentResponse(prepared.packet, "agent:blind-a"),
      agentResponse(prepared.packet, "agent:blind-b")
    );

    const summary = verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: prepared.packetPath,
      primaryResponsePath: paths.primaryResponsePath,
      secondaryResponsePath: paths.secondaryResponsePath,
      receiptPath: paths.receiptPath,
      verifiedAt: VERIFIED_AT
    });
    const receipt = JSON.parse(readFileSync(paths.receiptPath, "utf8")) as ReviewBenchAdvisoryAdjudicationReceiptV2;

    expect(summary).toMatchObject({ status: "pilot_ready", receiptKind: "agent_agreement" });
    expect(receipt).toMatchObject({
      schemaVersion: "review-bench-advisory-adjudication-receipt/v2",
      profile: "phase1_advisory",
      claimClass: "advisory_model_selection_only",
      corpusV1Eligible: false,
      publicationEligible: false,
      resolutionAuthority: "independent_ai",
      advisoryProtocolVersion: "review-bench-phase1-advisory-protocol/v1",
      advisoryProtocolSha256: sha256(ADVISORY_PROTOCOL),
      status: "pilot_ready",
      receiptKind: "agent_agreement",
      primaryAdjudicatorId: "agent:blind-a",
      secondaryAdjudicatorId: "agent:blind-b"
    });
  });

  it("fails closed on agent disagreement until a third distinct AI resolves it", () => {
    const prepared = prepareAdvisory();
    const secondary = agentResponse(prepared.packet, "agent:blind-b", {
      verdict: "verified_clean",
      decisions: [{
        candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
        actionability: "not_actionable"
      }],
      rationale: "The blinded advisory reviewer found no actionable defect."
    });
    const unresolved = responsePaths(
      prepared,
      agentResponse(prepared.packet, "agent:blind-a"),
      secondary
    );

    const unresolvedSummary = verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: prepared.packetPath,
      primaryResponsePath: unresolved.primaryResponsePath,
      secondaryResponsePath: unresolved.secondaryResponsePath,
      receiptPath: unresolved.receiptPath,
      verifiedAt: VERIFIED_AT
    });
    expect(unresolvedSummary).toMatchObject({
      status: "needs_ai_resolution",
      receiptKind: "agent_disagreement"
    });

    const resolvedReceiptPath = join(prepared.root, "resolved-advisory-receipt.json");
    const resolverPath = join(prepared.root, "ai-resolver.json");
    writeJson(resolverPath, aiResolver(prepared.packet));
    const resolvedSummary = verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: prepared.packetPath,
      primaryResponsePath: unresolved.primaryResponsePath,
      secondaryResponsePath: unresolved.secondaryResponsePath,
      resolverResponsePath: resolverPath,
      receiptPath: resolvedReceiptPath,
      verifiedAt: VERIFIED_AT
    });
    expect(resolvedSummary).toMatchObject({ status: "pilot_ready", receiptKind: "ai_resolved" });
  });

  it("keeps agent and human identities separated across advisory and Corpus v1 verification", () => {
    const prepared = prepareAdvisory();
    const advisoryPaths = responsePaths(
      prepared,
      agentResponse(prepared.packet, "human:not-an-agent"),
      agentResponse(prepared.packet, "agent:blind-b")
    );
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: prepared.packetPath,
      primaryResponsePath: advisoryPaths.primaryResponsePath,
      secondaryResponsePath: advisoryPaths.secondaryResponsePath,
      receiptPath: advisoryPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/canonical ASCII agent:\*/i);

    const humanPrepared = prepare();
    const humanPaths = responsePaths(
      humanPrepared,
      response(humanPrepared.packet, "agent:blind-a"),
      response(humanPrepared.packet, "human:two")
    );
    expect(() => verifyReviewBenchAdjudicationResponses({
      packetPath: humanPrepared.packetPath,
      ...humanPaths,
      verifiedAt: VERIFIED_AT
    })).toThrow(/canonical ASCII human:\*/i);
  });

  it("exposes a setup-safe CLI that exits one with a structured AI-resolution status", () => {
    const prepared = prepareAdvisory();
    const paths = responsePaths(
      prepared,
      agentResponse(prepared.packet, "agent:blind-a"),
      agentResponse(prepared.packet, "agent:blind-b", {
        verdict: "verified_clean",
        decisions: [{
          candidateId: prepared.packet.annotationUniverse.candidates[0]!.id,
          actionability: "not_actionable"
        }],
        rationale: "The blinded advisory reviewer found no actionable defect."
      })
    );
    const result = spawnSync("npx", [
      "tsx", "src/cli.ts", "review-bench", "verify-advisory-adjudication",
      "--packet", prepared.packetPath,
      "--primary", paths.primaryResponsePath,
      "--secondary", paths.secondaryResponsePath,
      "--receipt", paths.receiptPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_ai_resolution" });
  }, 20_000);

  it("rejects packets bound to the human-only Corpus v1 adjudication protocol", () => {
    const prepared = prepare();
    const paths = responsePaths(
      prepared,
      agentResponse(prepared.packet, "agent:blind-a"),
      agentResponse(prepared.packet, "agent:blind-b")
    );

    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: prepared.packetPath,
      primaryResponsePath: paths.primaryResponsePath,
      secondaryResponsePath: paths.secondaryResponsePath,
      receiptPath: paths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/Phase 1 advisory protocol/i);
  });

  it("rejects advisory identity, schema, completeness, and chronology violations", () => {
    const cases: Array<[string, (packet: ReviewBenchAdjudicationPacketV1) => [unknown, unknown]]> = [
      ["distinct", (packet) => [
        agentResponse(packet, "agent:same"),
        agentResponse(packet, "agent:same")
      ]],
      ["canonical", (packet) => [
        agentResponse(packet, "Agent:blind-a"),
        agentResponse(packet, "agent:blind-b")
      ]],
      ["canonical", (packet) => [
        agentResponse(packet, "agent:blіnd-a"),
        agentResponse(packet, "agent:blind-b")
      ]],
      ["schemaVersion", (packet) => [
        response(packet, "agent:blind-a"),
        agentResponse(packet, "agent:blind-b")
      ]],
      ["complete", (packet) => [
        agentResponse(packet, "agent:blind-a", { decisions: [] }),
        agentResponse(packet, "agent:blind-b")
      ]],
      ["chronology", (packet) => [
        agentResponse(packet, "agent:blind-a", { completedAt: "2026-07-13T06:00:00.000Z" }),
        agentResponse(packet, "agent:blind-b")
      ]]
    ];

    for (const [expected, build] of cases) {
      const prepared = prepareAdvisory();
      const [primary, secondary] = build(prepared.packet);
      const paths = responsePaths(prepared, primary, secondary);
      expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
        packetPath: prepared.packetPath,
        primaryResponsePath: paths.primaryResponsePath,
        secondaryResponsePath: paths.secondaryResponsePath,
        receiptPath: paths.receiptPath,
        verifiedAt: VERIFIED_AT
      })).toThrow(new RegExp(expected, "i"));
    }
  });

  it("requires a third distinct AI resolver only for disagreements and preserves no-clobber and tamper checks", () => {
    const disagreement = prepareAdvisory();
    const secondary = agentResponse(disagreement.packet, "agent:blind-b", {
      verdict: "verified_clean",
      decisions: [{
        candidateId: disagreement.packet.annotationUniverse.candidates[0]!.id,
        actionability: "not_actionable"
      }],
      rationale: "The blinded advisory reviewer found no actionable defect."
    });
    const disagreementPaths = responsePaths(
      disagreement,
      agentResponse(disagreement.packet, "agent:blind-a"),
      secondary
    );
    const duplicateResolverPath = join(disagreement.root, "duplicate-agent-resolver.json");
    writeJson(duplicateResolverPath, aiResolver(disagreement.packet, { adjudicatorId: "agent:blind-a" }));
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: disagreement.packetPath,
      primaryResponsePath: disagreementPaths.primaryResponsePath,
      secondaryResponsePath: disagreementPaths.secondaryResponsePath,
      resolverResponsePath: duplicateResolverPath,
      receiptPath: disagreementPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/distinct/i);

    const humanResolverPath = join(disagreement.root, "human-resolver.json");
    writeJson(humanResolverPath, resolver(disagreement.packet));
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: disagreement.packetPath,
      primaryResponsePath: disagreementPaths.primaryResponsePath,
      secondaryResponsePath: disagreementPaths.secondaryResponsePath,
      resolverResponsePath: humanResolverPath,
      receiptPath: disagreementPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/advisory AI resolver|schemaVersion/i);

    const agreement = prepareAdvisory();
    const agreementPaths = responsePaths(
      agreement,
      agentResponse(agreement.packet, "agent:blind-a"),
      agentResponse(agreement.packet, "agent:blind-b")
    );
    const unnecessaryResolverPath = join(agreement.root, "unnecessary-resolver.json");
    writeJson(unnecessaryResolverPath, resolver(agreement.packet));
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: agreement.packetPath,
      primaryResponsePath: agreementPaths.primaryResponsePath,
      secondaryResponsePath: agreementPaths.secondaryResponsePath,
      resolverResponsePath: unnecessaryResolverPath,
      receiptPath: agreementPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/unnecessary|no disagreement/i);

    verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: agreement.packetPath,
      primaryResponsePath: agreementPaths.primaryResponsePath,
      secondaryResponsePath: agreementPaths.secondaryResponsePath,
      receiptPath: agreementPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    });
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: agreement.packetPath,
      primaryResponsePath: agreementPaths.primaryResponsePath,
      secondaryResponsePath: agreementPaths.secondaryResponsePath,
      receiptPath: agreementPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/exist|no-clobber/i);

    const tampered = prepareAdvisory();
    const sourcePath = join(tampered.outputDirectory, `${tampered.candidate.sourceArtifactSha256}.diff`);
    chmodSync(sourcePath, 0o600);
    writeFileSync(sourcePath, `${DIFF}tampered\n`);
    const tamperedPaths = responsePaths(
      tampered,
      agentResponse(tampered.packet, "agent:blind-a"),
      agentResponse(tampered.packet, "agent:blind-b")
    );
    expect(() => verifyReviewBenchAdvisoryAdjudicationResponses({
      packetPath: tampered.packetPath,
      primaryResponsePath: tamperedPaths.primaryResponsePath,
      secondaryResponsePath: tamperedPaths.secondaryResponsePath,
      receiptPath: tamperedPaths.receiptPath,
      verifiedAt: VERIFIED_AT
    })).toThrow(/sha256|digest|tamper/i);
  });
});
