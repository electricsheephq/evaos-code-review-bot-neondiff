import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildRepoMemoryPacket,
  formatRepoMemoryPacketMarkdown,
  readRepoMemoryMarkdown,
  type RepoMemoryNote
} from "../src/repo-memory.js";
import { ReviewStateStore } from "../src/state.js";
import { buildReviewPrompt } from "../src/zcode.js";
import type { PullRequestSummary } from "../src/types.js";

describe("repo memory packets", () => {
  const roots: string[] = [];
  const repo = "electricsheephq/evaos-code-review-bot";
  const generatedAt = "2026-07-02T00:00:00.000Z";

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("builds a bounded reproducible packet from human memory and matching machine notes", () => {
    const humanMarkdown = [
      "# evaOS Code Review Bot Memory",
      "",
      "## Repository Purpose",
      "Local GitHub App reviewer backed by ZCode.",
      "",
      "## Preferred Proof",
      "Prefer release-status, coverage-audit, provider-cooldown audit, and runtime-inventory proof.",
      "",
      "## Security / Privacy Boundaries",
      "Never include secrets, raw customer data, or private keys in comments."
    ].join("\n");
    const stateNotes: RepoMemoryNote[] = [
      note({
        noteId: "note-policy",
        kind: "policy_note",
        title: "Release proof",
        body: "Release notes must link release-status and rollback evidence.",
        source: "issue#78"
      }),
      note({
        noteId: "note-fp-match",
        kind: "false_positive",
        title: "Generated walkthrough marker",
        body: "Do not repeat low-value guidance about hidden bot markers when the marker fingerprint matches.",
        source: "review#101",
        fingerprint: "fp:hidden-marker"
      }),
      note({
        noteId: "note-fp-miss",
        kind: "false_positive",
        title: "Unrelated false positive",
        body: "This should not be included without a current matching finding fingerprint.",
        source: "review#100",
        fingerprint: "fp:unrelated"
      }),
      note({
        noteId: "note-stale",
        kind: "review_outcome",
        title: "Old package script",
        body: "Use the previous release script shape.",
        source: "review#50",
        expiresAt: "2026-07-01T00:00:00.000Z"
      })
    ];

    const result = buildRepoMemoryPacket({
      repo,
      humanMarkdown,
      stateNotes,
      findingFingerprints: ["fp:hidden-marker"],
      generatedAt,
      maxPacketBytes: 12_000
    });
    const repeated = buildRepoMemoryPacket({
      repo,
      humanMarkdown,
      stateNotes,
      findingFingerprints: ["fp:hidden-marker"],
      generatedAt,
      maxPacketBytes: 12_000
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !repeated.ok) throw new Error("expected packet build to pass");
    expect(result.packet.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated.packet.sha256).toBe(result.packet.sha256);
    expect(result.packet.byteEstimate).toBe(Buffer.byteLength(formatRepoMemoryPacketMarkdown(result.packet), "utf8"));
    expect(result.packet.tokenEstimate).toBeGreaterThan(0);
    expect(result.packet.markdown).toContain("This memory is advisory. Current PR diff and current repository files override memory.");
    expect(result.packet.markdown).toContain("Repository Purpose");
    expect(result.packet.markdown).toContain("Release notes must link release-status");
    expect(result.packet.markdown).toContain("Generated walkthrough marker");
    expect(result.packet.markdown).not.toContain("Unrelated false positive");
    expect(result.packet.markdown).not.toContain("Old package script");
    expect(result.packet.sources.map((source) => source.id)).toEqual([
      "human:repo-memory.md",
      "note-policy",
      "note-fp-match"
    ]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "note-fp-miss", reason: "false_positive_fingerprint_mismatch" }),
        expect.objectContaining({ id: "note-stale", reason: "stale" })
      ])
    );
  });

  it("orders same-priority notes deterministically before hashing", () => {
    const result = buildRepoMemoryPacket({
      repo,
      stateNotes: [
        note({
          noteId: "policy-b",
          kind: "policy_note",
          title: "B policy",
          body: "Second lexicographic policy note.",
          source: "test"
        }),
        note({
          noteId: "proof-a",
          kind: "proof_preference",
          title: "Proof note",
          body: "Proof preferences render after policy notes.",
          source: "test"
        }),
        note({
          noteId: "policy-a",
          kind: "policy_note",
          title: "A policy",
          body: "First lexicographic policy note.",
          source: "test"
        })
      ],
      generatedAt,
      maxPacketBytes: 12_000
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected packet build to pass");
    expect(result.packet.sources.map((source) => source.id)).toEqual(["policy-a", "policy-b", "proof-a"]);
    expect(result.packet.markdown.indexOf("A policy")).toBeLessThan(result.packet.markdown.indexOf("B policy"));
    expect(result.packet.markdown.indexOf("B policy")).toBeLessThan(result.packet.markdown.indexOf("Proof note"));
  });

  it("hashes rendered note metadata into sqlite note source provenance", () => {
    const baseNote = note({
      noteId: "note-hash",
      kind: "policy_note",
      title: "Hash metadata",
      body: "Rendered metadata changes should alter source provenance.",
      source: "test",
      confidence: 0.8,
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const original = buildRepoMemoryPacket({
      repo,
      stateNotes: [baseNote],
      generatedAt,
      maxPacketBytes: 12_000
    });
    const changed = buildRepoMemoryPacket({
      repo,
      stateNotes: [{ ...baseNote, confidence: 0.9 }],
      generatedAt,
      maxPacketBytes: 12_000
    });

    if (!original.ok || !changed.ok) throw new Error("expected packet builds to pass");
    expect(original.packet.sources[0]?.sha256).not.toBe(changed.packet.sources[0]?.sha256);
  });

  it("keeps ordering deterministic when a legacy note has malformed updatedAt", () => {
    const stateNotes: RepoMemoryNote[] = [
      note({
        noteId: "policy-valid",
        kind: "policy_note",
        title: "Valid timestamp",
        body: "Valid timestamps sort after malformed legacy timestamps.",
        source: "test",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      note({
        noteId: "policy-b",
        kind: "policy_note",
        title: "Malformed B",
        body: "Malformed legacy timestamp B.",
        source: "test",
        updatedAt: "not-an-iso-date"
      }),
      note({
        noteId: "policy-a",
        kind: "policy_note",
        title: "Malformed A",
        body: "Malformed legacy timestamp A.",
        source: "test",
        updatedAt: ""
      })
    ];

    const result = buildRepoMemoryPacket({
      repo,
      stateNotes,
      generatedAt,
      maxPacketBytes: 12_000
    });
    const repeated = buildRepoMemoryPacket({
      repo,
      stateNotes,
      generatedAt,
      maxPacketBytes: 12_000
    });

    expect(result.ok).toBe(true);
    expect(repeated.ok).toBe(true);
    if (!result.ok || !repeated.ok) throw new Error("expected packet build to pass");
    expect(repeated.packet.sha256).toBe(result.packet.sha256);
    expect(result.packet.sources.map((source) => source.id)).toEqual(["policy-a", "policy-b", "policy-valid"]);
  });

  it("fails closed and redacts the report when memory text contains secret-like content", () => {
    const result = buildRepoMemoryPacket({
      repo,
      humanMarkdown: "## Security\nDo not leak token: ghp_fake_token",
      stateNotes: [],
      generatedAt,
      maxPacketBytes: 12_000
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected packet build to fail closed");
    expect(result.error).toContain("secret-like");
    expect(JSON.stringify(result)).not.toContain("ghp_fake_token");
    expect(JSON.stringify(result)).toContain("[redacted-secret]");
  });

  it("fails closed when note identifiers contain secret-like content", () => {
    const fixtureToken = "ghp_fake_token";
    const result = buildRepoMemoryPacket({
      repo,
      humanMarkdown: "## Preferred Proof\nKeep proof bounded.",
      stateNotes: [
        note({
          noteId: fixtureToken,
          kind: "review_outcome",
          title: "Expired note",
          body: "This note is stale but its identifier must still be scanned before exclusion.",
          source: "review#1",
          expiresAt: "2026-07-01T00:00:00.000Z"
        })
      ],
      generatedAt,
      maxPacketBytes: 12_000
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(fixtureToken);
    expect(JSON.stringify(result)).toContain("[redacted-secret]");
  });

  it("stores safe repo memory notes and packet build evidence in SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const generatedDocsFingerprint = `finding:${"a".repeat(64)}`;

    store.recordRepoMemoryNote({
      noteId: "memory-note-1",
      repo,
      kind: "policy_note",
      title: "Preferred release proof",
      body: "Require release-status, coverage-audit, cooldown, and runtime-inventory proof.",
      source: "operator",
      confidence: 0.9,
      now: new Date(generatedAt)
    });
    store.recordRepoMemoryNote({
      noteId: "memory-note-2",
      repo,
      kind: "false_positive",
      title: "Generated docs-only churn",
      body: "Suppress repeated generated-doc comments only on an exact finding fingerprint match.",
      source: "review#90",
      confidence: 0.7,
      fingerprint: generatedDocsFingerprint,
      expiresAt: "2026-08-01T00:00:00.000Z",
      now: new Date("2026-07-02T00:30:00.000Z")
    });
    expect(() =>
      store.recordRepoMemoryNote({
        noteId: "bad-fingerprint-note",
        repo,
        kind: "false_positive",
        title: "Bad fingerprint",
        body: "False-positive fingerprints must match the review gate fingerprint format.",
        source: "operator",
        fingerprint: "fp:generated-docs",
        expiresAt: "2026-08-01T00:00:00.000Z",
        now: new Date(generatedAt)
      })
    ).toThrow(/finding:<64-hex>/);
    expect(() =>
      store.recordRepoMemoryNote({
        noteId: "permanent-false-positive-note",
        repo,
        kind: "false_positive",
        title: "Permanent false positive",
        body: "False-positive suppressions must be bounded.",
        source: "operator",
        fingerprint: generatedDocsFingerprint,
        now: new Date(generatedAt)
      })
    ).toThrow(/require expiresAt/);
    expect(() =>
      store.recordRepoMemoryNote({
        noteId: "bad-secret-note",
        repo,
        kind: "policy_note",
        title: "Bad",
        body: "api_key=12345678901234567890",
        source: "operator",
        now: new Date(generatedAt)
      })
    ).toThrow(/secret-like/);
    const badId = "ghp_fake_token";
    expect(() =>
      store.recordRepoMemoryNote({
        noteId: badId,
        repo,
        kind: "policy_note",
        title: "Bad identifier",
        body: "Identifiers are emitted in evidence and must be safe.",
        source: "operator",
        now: new Date(generatedAt)
      })
    ).toThrow(/secret-like/);
    try {
      store.recordRepoMemoryNote({
        noteId: badId,
        repo,
        kind: "policy_note",
        title: "Bad identifier",
        body: "Identifiers are emitted in evidence and must be safe.",
        source: "operator",
        now: new Date(generatedAt)
      });
      throw new Error("expected secret-like note ID to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(badId);
      expect((error as Error).message).toContain("[redacted-secret]");
    }
    expect(() =>
      store.recordRepoMemoryNote({
        noteId: "bad-timestamp",
        repo,
        kind: "policy_note",
        title: "Bad timestamp",
        body: "Invalid Date should never become created_at or updated_at.",
        source: "operator",
        now: new Date("not-a-date")
      })
    ).toThrow(/now must be a valid Date/);
    store.recordRepoMemoryNote({
      noteId: "expired-offset-note",
      repo,
      kind: "policy_note",
      title: "Expired offset timestamp",
      body: "Offset timestamps should be normalized before filtering and limiting.",
      source: "operator",
      expiresAt: "2026-07-02T00:30:00+01:00",
      now: new Date(generatedAt)
    });

    const notes = store.listRepoMemoryNotes({ repo, now: new Date(generatedAt) });
    expect(notes).toHaveLength(2);
    expect(notes.map((entry) => entry.noteId)).not.toContain("expired-offset-note");
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: "memory-note-2",
          kind: "false_positive",
          fingerprint: generatedDocsFingerprint
        })
      ])
    );

    store.recordRepoMemoryNote({
      noteId: "memory-note-3-newest",
      repo,
      kind: "policy_note",
      title: "Newest correction",
      body: "Newest memory should survive note limits.",
      source: "operator",
      now: new Date("2026-07-02T01:00:00.000Z")
    });
    const limited = store.listRepoMemoryNotes({ repo, now: new Date(generatedAt), limit: 2 });
    expect(limited.map((entry) => entry.noteId)).toEqual([
      "memory-note-3-newest",
      "memory-note-2"
    ]);
    expect(limited[1]).toMatchObject({
      noteId: "memory-note-2",
      kind: "false_positive",
      fingerprint: generatedDocsFingerprint
    });
    store.recordRepoMemoryNote({
      noteId: "memory-note-1",
      repo: "100yenadmin/evaOS-GUI",
      kind: "policy_note",
      title: "Same note id in another repo",
      body: "Repo memory note IDs are scoped by repository.",
      source: "operator",
      now: new Date(generatedAt)
    });
    expect(store.listRepoMemoryNotes({ repo: "100yenadmin/evaOS-GUI", now: new Date(generatedAt) })).toEqual([
      expect.objectContaining({
        noteId: "memory-note-1",
        repo: "100yenadmin/evaOS-GUI",
        title: "Same note id in another repo"
      })
    ]);
    expect(store.listRepoMemoryNotes({ repo, now: new Date(generatedAt) })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: "memory-note-1",
          repo,
          title: "Preferred release proof"
        })
      ])
    );

    store.recordRepoMemoryPacketBuild({
      packetSha: "a".repeat(64),
      repo,
      packetVersion: "repo-memory-packet-v0.1",
      generatedAt,
      byteEstimate: 512,
      tokenEstimate: 128,
      includedNoteIds: ["memory-note-1", "memory-note-2"],
      redactionStatus: "passed",
      memoryRoot: "/Volumes/LEXAR/Codex/evaos-code-review-bot/memory"
    });
    expect(store.getRepoMemoryPacketBuild("a".repeat(64))).toMatchObject({
      packetSha: "a".repeat(64),
      repo,
      byteEstimate: 512,
      includedNoteIds: ["memory-note-1", "memory-note-2"],
      redactionStatus: "passed"
    });
    store.recordRepoMemoryPacketBuild({
      packetSha: "a".repeat(64),
      repo,
      packetVersion: "repo-memory-packet-v0.1",
      generatedAt,
      byteEstimate: 1024,
      tokenEstimate: 256,
      includedNoteIds: ["different-note"],
      redactionStatus: "passed",
      memoryRoot: "/different/root"
    });
    expect(store.getRepoMemoryPacketBuild("a".repeat(64))).toMatchObject({
      byteEstimate: 512,
      includedNoteIds: ["memory-note-1", "memory-note-2"],
      memoryRoot: "/Volumes/LEXAR/Codex/evaos-code-review-bot/memory"
    });
    expect(() =>
      store.recordRepoMemoryPacketBuild({
        packetSha: "b".repeat(64),
        repo,
        packetVersion: "repo-memory-packet-v0.1",
        generatedAt: "July 2, 2026",
        byteEstimate: 512,
        tokenEstimate: 128,
        includedNoteIds: ["memory-note-1"],
        redactionStatus: "passed"
      })
    ).toThrow(/canonical ISO/);
    expect(() =>
      store.recordRepoMemoryPacketBuild({
        packetSha: "c".repeat(64),
        repo,
        packetVersion: "repo-memory-packet-v0.1",
        generatedAt,
        byteEstimate: 512,
        tokenEstimate: 128,
        includedNoteIds: ["memory-note-1"],
        redactionStatus: "unknown"
      })
    ).toThrow(/redactionStatus/);
    expect(() =>
      store.recordRepoMemoryPacketBuild({
        packetSha: "d".repeat(64),
        repo,
        packetVersion: "repo-memory-packet-v0.1",
        generatedAt,
        byteEstimate: 512,
        tokenEstimate: 128,
        includedNoteIds: ["bad\nnote"],
        redactionStatus: "passed"
      })
    ).toThrow(/includedNoteIds/);
    store.close();
  });

  it("reads human repo-memory.md outside the target checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-root-"));
    roots.push(root);
    const memoryDir = join(root, "electricsheephq", "evaos-code-review-bot");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "repo-memory.md"), "## Repository Purpose\nReview bot memory.\n");

    expect(readRepoMemoryMarkdown(root, repo)).toContain("Review bot memory");
    expect(readRepoMemoryMarkdown(root, "owner/missing")).toBeUndefined();
    expect(() => readRepoMemoryMarkdown(root, "../repo")).toThrow(/owner\/repo/);
    expect(() => readRepoMemoryMarkdown(root, "owner/.")).toThrow(/owner\/repo/);
    expect(() => readRepoMemoryMarkdown(root, "owner/../repo")).toThrow(/owner\/repo/);
  });

  it("keeps prompt memory integration feature-flagged and default-off", () => {
    const defaultConfig = loadConfig(writeConfig({}));
    expect(defaultConfig.repoMemory).toMatchObject({
      enabled: false,
      memoryRoot: ".evaos/repo-memory",
      maxPacketBytes: 12_000
    });

    expect(() => loadConfig(writeConfig({ repoMemory: { enabled: "yes" } }))).toThrow(/repoMemory\.enabled/);

    const packetResult = buildRepoMemoryPacket({
      repo,
      humanMarkdown: "## Repository Purpose\nReview bot memory.",
      stateNotes: [],
      generatedAt,
      maxPacketBytes: 12_000
    });
    if (!packetResult.ok) throw new Error("expected packet build to pass");

    const withoutMemory = buildReviewPrompt({
      repo,
      pull,
      files: [{ filename: "src/state.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+state" }]
    });
    const withMemory = buildReviewPrompt({
      repo,
      pull,
      files: [{ filename: "src/state.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+state" }],
      repoMemoryPacket: packetResult.packet
    });

    expect(withoutMemory).not.toContain("Durable repo memory packet");
    expect(withMemory).toContain("Durable repo memory packet");
    expect(withMemory).toContain(packetResult.packet.sha256);
    expect(withMemory).toContain("This memory is advisory");
  });

  it("emits JSON and Markdown packets from the build-memory-packet CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-"));
    roots.push(root);
    const memoryRoot = join(root, "memory");
    const evidenceDir = join(root, "evidence");
    const outputDir = join(evidenceDir, "packet-output");
    const memoryDir = join(memoryRoot, "electricsheephq", "evaos-code-review-bot");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "repo-memory.md"), "## Preferred Proof\nCLI memory proof.\n");
    const statePath = join(root, "state.sqlite");
    const store = new ReviewStateStore(statePath);
    store.recordRepoMemoryNote({
      noteId: "cli-note",
      repo,
      kind: "policy_note",
      title: "CLI note",
      body: "CLI includes SQLite state notes.",
      source: "test",
      now: new Date(generatedAt)
    });
    store.close();
    const configPath = writeConfig({
      statePath,
      evidenceDir,
      repoMemory: {
        enabled: false,
        memoryRoot,
        maxPacketBytes: 12_000
      }
    });

    const stdout = execFileSync(process.execPath, [
      "./node_modules/.bin/tsx",
      "src/cli.ts",
      "build-memory-packet",
      "--config",
      configPath,
      "--repo",
      repo,
      "--output-dir",
      outputDir,
      "--generated-at",
      generatedAt
    ], { cwd: process.cwd(), encoding: "utf8" });
    const parsed = JSON.parse(stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.packet.markdown).toContain("CLI memory proof");
    expect(parsed.packet.markdown).toContain("CLI includes SQLite state notes.");
    expect(readFileSync(join(outputDir, "repo-memory-packet.md"), "utf8")).toContain("CLI memory proof");
    expect(JSON.parse(readFileSync(join(outputDir, "repo-memory-packet.json"), "utf8")).packet.sha256).toBe(parsed.packet.sha256);
  });

  it("keeps CLI false-positive notes from starving prompt memory notes", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-note-limit-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const store = new ReviewStateStore(statePath);
    store.recordRepoMemoryNote({
      noteId: "policy-survives",
      repo,
      kind: "policy_note",
      title: "Policy survives",
      body: "CLI packets must preserve prompt memory notes even when suppression notes are newer.",
      source: "test",
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    store.recordRepoMemoryNote({
      noteId: "newer-suppression",
      repo,
      kind: "false_positive",
      title: "Newer suppression",
      body: "This suppression note should not consume the prompt note limit.",
      source: "test",
      fingerprint: `finding:${"a".repeat(64)}`,
      expiresAt: "2026-07-03T00:00:00.000Z",
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    store.close();
    const configPath = writeConfig({
      statePath,
      evidenceDir: join(root, "evidence"),
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000,
        maxStateNotes: 1
      }
    });

    const stdout = execFileSync(process.execPath, [
      "./node_modules/.bin/tsx",
      "src/cli.ts",
      "build-memory-packet",
      "--config",
      configPath,
      "--repo",
      repo,
      "--note-limit",
      "1",
      "--generated-at",
      generatedAt
    ], { cwd: process.cwd(), encoding: "utf8" });
    const parsed = JSON.parse(stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.packet.sources.map((source: { id: string }) => source.id)).toContain("policy-survives");
    expect(parsed.packet.markdown).toContain("CLI packets must preserve prompt memory notes");
    expect(parsed.packet.markdown).not.toContain("This suppression note should not consume");
  });

  it("does not create or migrate SQLite state for non-recorded CLI packet builds", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-readonly-"));
    roots.push(root);
    const memoryRoot = join(root, "memory");
    const memoryDir = join(memoryRoot, "electricsheephq", "evaos-code-review-bot");
    const statePath = join(root, "missing", "state.sqlite");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "repo-memory.md"), "## Preferred Proof\nRead-only packet proof.\n");
    const configPath = writeConfig({
      statePath,
      evidenceDir: join(root, "evidence"),
      repoMemory: {
        enabled: false,
        memoryRoot,
        maxPacketBytes: 12_000
      }
    });

    const stdout = execFileSync(process.execPath, [
      "./node_modules/.bin/tsx",
      "src/cli.ts",
      "build-memory-packet",
      "--config",
      configPath,
      "--repo",
      repo,
      "--generated-at",
      generatedAt
    ], { cwd: process.cwd(), encoding: "utf8" });
    const parsed = JSON.parse(stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.packet.markdown).toContain("Read-only packet proof");
    expect(existsSync(statePath)).toBe(false);
  });

  it("requires canonical ISO --generated-at values for CLI packets", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-generated-at-"));
    roots.push(root);
    const configPath = writeConfig({
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000
      }
    });

    expect(() =>
      execFileSync(process.execPath, [
        "./node_modules/.bin/tsx",
        "src/cli.ts",
        "build-memory-packet",
        "--config",
        configPath,
        "--repo",
        repo,
        "--generated-at",
        "July 2, 2026"
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })
    ).toThrow(/canonical ISO timestamp/);
  });

  it("refuses to write memory packet output inside the current repository checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-unsafe-"));
    roots.push(root);
    const evidenceDir = join(process.cwd(), "repo-memory-output");
    const configPath = writeConfig({
      statePath: join(root, "state.sqlite"),
      evidenceDir,
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000
      }
    });

    expect(() =>
      execFileSync(process.execPath, [
        "./node_modules/.bin/tsx",
        "src/cli.ts",
        "build-memory-packet",
        "--config",
        configPath,
        "--repo",
        repo,
        "--output-dir",
        evidenceDir
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })
    ).toThrow(/must not be inside the repository checkout/);
  });

  it("refuses build-memory-packet state-path overrides outside the configured state path", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-state-path-"));
    roots.push(root);
    const configPath = writeConfig({
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000
      }
    });

    expect(() =>
      execFileSync(process.execPath, [
        "./node_modules/.bin/tsx",
        "src/cli.ts",
        "build-memory-packet",
        "--config",
        configPath,
        "--repo",
        repo,
        "--state-path",
        join(root, "other.sqlite")
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })
    ).toThrow(/must match the configured statePath/);
  });

  it("refuses to write memory packet output inside any Lexar repo checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-target-checkout-"));
    roots.push(root);
    const fakeReposRoot = join(root, "repos");
    const fakeTargetCheckout = join(fakeReposRoot, "target-repo");
    const outputDir = join(fakeTargetCheckout, "memory-packet");
    mkdirSync(join(fakeTargetCheckout, ".git"), { recursive: true });
    const configPath = writeConfig({
      statePath: join(root, "state.sqlite"),
      workRoot: join(fakeReposRoot, "review-bot-runtime"),
      evidenceDir: fakeReposRoot,
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000
      }
    });

    expect(() =>
      execFileSync(process.execPath, [
        "./node_modules/.bin/tsx",
        "src/cli.ts",
        "build-memory-packet",
        "--config",
        configPath,
        "--repo",
        repo,
        "--output-dir",
        outputDir
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })
    ).toThrow(/configured evidenceDir|repository checkout/);
  });

  it("refuses output paths that enter a checkout through an evidence-dir symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-cli-symlink-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    const fakeTargetCheckout = join(root, "repos", "target-repo");
    const symlinkedCheckout = join(evidenceDir, "linked-checkout");
    mkdirSync(join(fakeTargetCheckout, ".git"), { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    symlinkSync(fakeTargetCheckout, symlinkedCheckout);
    const configPath = writeConfig({
      statePath: join(root, "state.sqlite"),
      evidenceDir,
      repoMemory: {
        enabled: false,
        memoryRoot: join(root, "memory"),
        maxPacketBytes: 12_000
      }
    });

    expect(() =>
      execFileSync(process.execPath, [
        "./node_modules/.bin/tsx",
        "src/cli.ts",
        "build-memory-packet",
        "--config",
        configPath,
        "--repo",
        repo,
        "--output-dir",
        join(symlinkedCheckout, "memory-packet")
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })
    ).toThrow(/configured evidenceDir|repository checkout/);
  });

  function writeConfig(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "repo-memory-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return path;
  }
});

function note(overrides: Partial<RepoMemoryNote> & Pick<RepoMemoryNote, "noteId" | "kind" | "title" | "body" | "source">): RepoMemoryNote {
  return {
    repo: "electricsheephq/evaos-code-review-bot",
    confidence: 0.8,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

const pull: PullRequestSummary = {
  number: 81,
  title: "Add repo memory packets",
  draft: false,
  body: "Closes #81",
  head: {
    sha: "memory-head",
    ref: "issue-81-repo-memory",
    repo: { full_name: "electricsheephq/evaos-code-review-bot" }
  },
  base: {
    sha: "memory-base",
    ref: "main",
    repo: { full_name: "electricsheephq/evaos-code-review-bot" }
  },
  html_url: "https://github.com/electricsheephq/evaos-code-review-bot/pull/102",
  requested_reviewers: []
};
