import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRepoWikiPacket,
  formatRepoWikiPacketJson,
  formatRepoWikiPacketMarkdown,
  normalizeRepoWikiSections,
  redactRepoWikiText,
  truncateUtf8Bytes
} from "../src/repo-wiki-packet.js";

const generatedAt = "2026-07-04T08:00:00.000Z";

describe("repo wiki packets", () => {
  it("builds deterministic packet hashes from normalized section order", () => {
    const common = {
      repo: {
        fullName: "electricsheephq/evaos-code-review-bot",
        defaultBranch: "main",
        remoteUrl: "https://github.com/electricsheephq/evaos-code-review-bot"
      },
      source: {
        ref: "main",
        headSha: "02c388056e6b04405bce2e6fe2de74db34db6ba7",
        checkedAt: generatedAt,
        status: "fresh" as const
      },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000, maxSectionBytes: 2_000 }
    };
    const sections = [
      section({ id: "tests", title: "Test commands", order: 30, body: "npm run build; npm test" }),
      section({ id: "architecture", title: "Architecture overview", order: 10, body: "Local-first GitHub App worker." }),
      section({ id: "entrypoints", title: "Key entrypoints", order: 20, body: "src/cli.ts and src/worker.ts." })
    ];

    const first = buildRepoWikiPacket({ ...common, sections });
    const second = buildRepoWikiPacket({ ...common, sections: [...sections].reverse() });

    expect(first.packetSha).toMatch(/^[a-f0-9]{64}$/);
    expect(second.packetSha).toBe(first.packetSha);
    expect(first.includedSections.map((included) => included.id)).toEqual([
      "architecture",
      "entrypoints",
      "tests"
    ]);
    expect(first.includedFiles.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "README.md",
      "src/cli.ts",
      "src/worker.ts",
      "tests/repo-wiki-packet.test.ts"
    ]);
  });

  it("caps section text and packet budget deterministically", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "feature/wiki", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 700, maxTokens: 300, maxSectionBytes: 48 },
      sections: [
        section({
          id: "long",
          title: "Long architecture notes",
          order: 1,
          body: "A".repeat(200)
        }),
        section({
          id: "later",
          title: "Later notes",
          order: 2,
          body: "This lower-priority section may be excluded if the packet budget is tight."
        })
      ]
    });

    expect(packet.byteBudget.usedBytes).toBeLessThanOrEqual(packet.byteBudget.maxBytes);
    expect(packet.tokenBudget.usedTokens).toBeLessThanOrEqual(packet.tokenBudget.maxTokens);
    expect(packet.includedSections[0]).toMatchObject({
      id: "long",
      byteLength: 48,
      truncated: true
    });
    expect(packet.excludedSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "later", reason: "packet_budget_exceeded" })
      ])
    );
  });

  it("redacts token-like strings from markdown and JSON payloads", () => {
    const token = "ghp_123456789012345678901234";
    const packet = buildRepoWikiPacket({
      repo: {
        fullName: "electricsheephq/evaos-code-review-bot",
        remoteUrl: `https://${token}@github.com/electricsheephq/evaos-code-review-bot.git`
      },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [
        section({
          id: "security",
          title: "Security notes",
          body: `Never paste ${token} into repo wiki context.`,
          sourceFiles: [`docs/person@example.com/${token}.md`, "README.md"]
        })
      ]
    });
    const markdown = formatRepoWikiPacketMarkdown(packet);
    const json = formatRepoWikiPacketJson(packet);

    expect(packet.redaction.status).toBe("redacted");
    expect(packet.redaction.replacementCount).toBeGreaterThanOrEqual(4);
    expect(packet.repo.remoteUrl).toContain("[redacted-secret]");
    expect(packet.repo.remoteUrl).not.toContain(token);
    expect(packet.includedSections[0]?.sourceFiles).toContain("README.md");
    expect(packet.includedSections[0]?.sourceFiles.join("\n")).toContain("[redacted-secret]");
    expect(packet.includedFiles.map((file) => file.path)).toContain("README.md");
    expect(packet.includedFiles.map((file) => file.path).join("\n")).toContain("[redacted-secret]");
    expect(markdown).not.toContain(token);
    expect(json).not.toContain(token);
    expect(markdown).not.toContain("person@example.com");
    expect(json).not.toContain("person@example.com");
    expect(markdown).toContain("[redacted-secret]");
    expect(JSON.parse(json).packetSha).toBe(packet.packetSha);
  });

  it("counts real replacements when input already contains the literal redaction marker", () => {
    const token = "ghp_123456789012345678901234";
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [
        section({
          id: "marker",
          title: "Marker",
          body: `Document literal [redacted-secret] while scrubbing https://${token}@github.com/[redacted-secret]/repo.git.`
        })
      ]
    });

    expect(packet.redaction.status).toBe("redacted");
    expect(packet.redaction.replacementCount).toBeGreaterThan(0);
    expect(packet.includedSections[0]).toMatchObject({ redacted: true });
    expect(formatRepoWikiPacketMarkdown(packet)).not.toContain(token);
  });

  it("rejects budgets that cannot fit the fixed packet header", () => {
    expect(() =>
      buildRepoWikiPacket({
        repo: { fullName: "electricsheephq/evaos-code-review-bot" },
        source: { ref: "main", status: "fresh" },
        generatedAt,
        budget: { maxBytes: 10, maxTokens: 3 },
        sections: []
      })
    ).toThrow(/fixed packet header exceeds budget/);
  });

  it("measures final packet size after budget fields stabilize", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 520, maxTokens: 130 },
      sections: [section({ id: "tight", title: "Tight", body: "This section must be dropped near the header budget." })]
    });
    const markdown = formatRepoWikiPacketMarkdown(packet);

    expect(Buffer.byteLength(markdown, "utf8")).toBe(packet.byteBudget.usedBytes);
    expect(packet.byteBudget.usedBytes).toBeLessThanOrEqual(packet.byteBudget.maxBytes);
    expect(packet.tokenBudget.usedTokens).toBeLessThanOrEqual(packet.tokenBudget.maxTokens);
  });

  it("binds packet byte and token budgets to the markdown emitter only", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 620, maxTokens: 155 },
      sections: [section({ id: "json-budget", title: "JSON budget", body: "JSON callers must re-check serialized size." })]
    });
    const markdownBytes = Buffer.byteLength(formatRepoWikiPacketMarkdown(packet), "utf8");
    const jsonBytes = Buffer.byteLength(formatRepoWikiPacketJson(packet), "utf8");

    expect(packet.byteBudget.usedBytes).toBe(markdownBytes);
    expect(packet.tokenBudget.usedTokens).toBe(Math.ceil(markdownBytes / 4));
    expect(markdownBytes).toBeLessThanOrEqual(packet.byteBudget.maxBytes);
    expect(jsonBytes).toBeGreaterThan(packet.byteBudget.maxBytes);
  });

  it("normalizes sections with stable ids, source files, and empty exclusions", () => {
    const normalized = normalizeRepoWikiSections([
      section({
        id: " Zeta ",
        title: " Zeta ",
        body: "Uses CRLF\r\nand surrounding whitespace. ",
        order: 20,
        sourceFiles: ["src/worker.ts", "src/worker.ts", " README.md "]
      }),
      section({ id: "empty", title: "Empty", body: "   ", order: 10 }),
      section({ id: "alpha", title: "Alpha", body: "Alpha body.", order: 20 })
    ]);

    expect(normalized.sections.map((section) => section.id)).toEqual(["alpha", "zeta"]);
    expect(normalized.sections[1]).toMatchObject({
      title: "Zeta",
      body: "Uses CRLF\nand surrounding whitespace.",
      sourceFiles: ["README.md", "src/worker.ts"]
    });
    expect(normalized.excluded).toEqual([{ id: "empty", reason: "empty" }]);
  });

  it("makes normalized section ID collisions deterministic across input order", () => {
    const colliding = [
      section({ id: "API Docs", title: "Second title", body: "Second body.", order: 10 }),
      section({ id: "api_docs", title: "First title", body: "First body.", order: 10 })
    ];

    const first = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: colliding
    });
    const second = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [...colliding].reverse()
    });

    expect(first.packetSha).toBe(second.packetSha);
    expect(first.includedSections.map((included) => included.id)).toEqual(["api-docs", "api-docs-2"]);
  });

  it("uses locale-independent code-unit ordering for packet hash inputs", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [
        section({ id: "same", title: "alpha", body: "lower title", order: 1, sourceFiles: ["a.md"] }),
        section({ id: "same", title: "Zed", body: "upper title", order: 1, sourceFiles: ["Z.md"] })
      ]
    });

    expect(packet.includedSections.map((included) => included.title)).toEqual(["Zed", "alpha"]);
    expect(packet.includedFiles.map((file) => file.path)).toEqual(["Z.md", "a.md"]);
  });

  it("hashes canonical packet content without self-referential packetSha", () => {
    const common = {
      source: { status: "fresh" as const, ref: "main", checkedAt: generatedAt },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [section({ id: "hash", title: "Hash", body: "Stable hash input." })]
    };
    const first = buildRepoWikiPacket({
      ...common,
      repo: { remoteUrl: "https://github.com/electricsheephq/evaos-code-review-bot", fullName: "electricsheephq/evaos-code-review-bot" }
    });
    const second = buildRepoWikiPacket({
      ...common,
      repo: { fullName: "electricsheephq/evaos-code-review-bot", remoteUrl: "https://github.com/electricsheephq/evaos-code-review-bot" }
    });
    const parsed = JSON.parse(formatRepoWikiPacketJson(first)) as Record<string, unknown>;
    const packetSha = parsed.packetSha;
    delete parsed.packetSha;

    expect(first.packetSha).toBe(second.packetSha);
    expect(packetSha).toBe(first.packetSha);
    expect(sha256(canonicalStringifyForTest(parsed))).toBe(first.packetSha);
    expect(Object.keys(JSON.parse(formatRepoWikiPacketJson(first)))).toEqual([...Object.keys(JSON.parse(formatRepoWikiPacketJson(first)))].sort(codeUnitCompare));
    expect(Object.keys((JSON.parse(formatRepoWikiPacketJson(first)) as { byteBudget: Record<string, unknown> }).byteBudget)).toEqual(["maxBytes", "usedBytes"]);
    expect(Object.keys((JSON.parse(formatRepoWikiPacketJson(first)) as { tokenBudget: Record<string, unknown> }).tokenBudget)).toEqual(["maxTokens", "usedTokens"]);
  });

  it("marks stale and missing source context as degraded advisory packets", () => {
    const stale = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: {
        ref: "main",
        headSha: "02c388056e6b04405bce2e6fe2de74db34db6ba7",
        checkedAt: "2026-07-01T00:00:00.000Z",
        status: "stale",
        staleReason: "source generated before current checkout"
      },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [section({ id: "arch", title: "Architecture", body: "Old but useful map." })]
    });
    const missing = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "missing", staleReason: "repo-memory.md not generated yet" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: []
    });

    expect(stale.degraded).toBe(true);
    expect(stale.source.status).toBe("stale");
    expect(formatRepoWikiPacketMarkdown(stale)).toContain("GitHub diff and checkout remain truth");
    expect(missing.degraded).toBe(true);
    expect(missing.excludedSections).toContainEqual({ id: "packet:sections", reason: "missing_source" });
    expect(missing.includedSections).toEqual([]);
  });

  it("exposes evidence-safe text helpers", () => {
    expect(truncateUtf8Bytes("ééabc", 3)).toBe("é");
    expect(redactRepoWikiText("token=abcdefghijklmnop")).toEqual({
      text: "[redacted-secret]",
      replacementCount: 1
    });
    expect(redactRepoWikiText("-----BEGIN PRIVATE KEY-----\n[redacted-secret]\nabc\n-----END PRIVATE KEY-----")).toEqual({
      text: "[redacted-secret]",
      replacementCount: 1
    });
  });
});

function section(input: {
  id: string;
  title: string;
  body: string;
  order?: number;
  sourceFiles?: string[];
}) {
  return {
    id: input.id,
    title: input.title,
    body: input.body,
    order: input.order,
    sourceFiles: input.sourceFiles ?? ["README.md", "AGENTS.md", "src/worker.ts", "src/cli.ts", "tests/repo-wiki-packet.test.ts"]
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalStringifyForTest(input: unknown): string {
  return JSON.stringify(sortJsonForTest(input));
}

function sortJsonForTest(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sortJsonForTest(item));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([key, value]) => [key, sortJsonForTest(value)])
    );
  }
  return input;
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
