import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRepoWikiPacket,
  buildSupportedAddonDryRunPacket,
  formatRepoWikiPacketJson,
  formatRepoWikiPacketMarkdown,
  formatSupportedAddonDryRunPacketMarkdown,
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

  it("preserves caller sourceSha and records emitted body hashes separately", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "feature/wiki", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 1_000, maxTokens: 300, maxSectionBytes: 12 },
      sections: [
        section({
          id: "provenance",
          title: "Provenance",
          body: "Source file body that will be truncated.",
          sourceSha: "source-file-sha"
        })
      ]
    });
    const included = packet.includedSections[0];
    const markdown = formatRepoWikiPacketMarkdown(packet);

    expect(included?.sourceSha).toBe("source-file-sha");
    expect(included?.emittedBodySha).toBe(sha256(included?.body ?? ""));
    expect(included?.emittedBodySha).not.toBe(included?.sourceSha);
    expect(markdown).toContain("source_sha=source-file-sha");
    expect(markdown).toContain(`emitted_body_sha=${included?.emittedBodySha}`);
  });

  it("counts redactions only from sections accepted after packet budgeting", () => {
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "feature/wiki", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 700, maxTokens: 300, maxSectionBytes: 48 },
      sections: [
        section({
          id: "kept",
          title: "Kept notes",
          order: 1,
          body: "A".repeat(200)
        }),
        section({
          id: "dropped",
          title: "Dropped notes",
          order: 2,
          body: "B".repeat(200),
          preRedactionReplacementCount: 5
        })
      ]
    });

    expect(packet.includedSections.map((included) => included.id)).toEqual(["kept"]);
    expect(packet.excludedSections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dropped", reason: "packet_budget_exceeded" })
      ])
    );
    expect(packet.redaction).toEqual({ status: "passed", replacementCount: 0 });
  });

  it("redacts token-like strings from markdown and JSON payloads", () => {
    const token = "ghp_fake_token";
    const packet = buildRepoWikiPacket({
      repo: {
        fullName: `electricsheephq/${token}`,
        defaultBranch: `release-${token}`,
        remoteUrl: `https://${token}@github.com/electricsheephq/evaos-code-review-bot.git`
      },
      source: {
        ref: `refs/heads/${token}`,
        headSha: token,
        checkedAt: generatedAt,
        status: "fresh",
        staleReason: `stale source mentions ${token}`
      },
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
    expect(packet.redaction.replacementCount).toBeGreaterThanOrEqual(9);
    expect(packet.repo.fullName).toContain("[redacted-secret]");
    expect(packet.repo.fullName).not.toContain(token);
    expect(packet.repo.defaultBranch).toContain("[redacted-secret]");
    expect(packet.repo.defaultBranch).not.toContain(token);
    expect(packet.repo.remoteUrl).toContain("[redacted-secret]");
    expect(packet.repo.remoteUrl).not.toContain(token);
    expect(packet.source.ref).toContain("[redacted-secret]");
    expect(packet.source.ref).not.toContain(token);
    expect(packet.source.headSha).toBe("[redacted-secret]");
    expect(packet.source.staleReason).toContain("[redacted-secret]");
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

  it("dedupes included files when redaction collapses distinct source paths", () => {
    const token = "ghp_fake_token";
    const packet = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [
        section({ id: "one", title: "One", body: "First body.", sourceFiles: [token] }),
        section({ id: "two", title: "Two", body: "Second body.", sourceFiles: ["person@example.com"] })
      ]
    });

    expect(packet.includedFiles).toContainEqual({
      path: "[redacted-secret]",
      sections: ["one", "two"]
    });
    expect(packet.includedSections.map((included) => included.sourceFiles)).toEqual([
      ["[redacted-secret]"],
      ["[redacted-secret]"]
    ]);
  });

  it("counts real replacements when input already contains the literal redaction marker", () => {
    const token = "ghp_fake_token";
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

  it("rejects invalid repo names, budgets, timestamps, and byte caps", () => {
    const validInput = {
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" as const },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000, maxSectionBytes: 2_000 },
      sections: [section({ id: "valid", title: "Valid", body: "Valid packet content." })]
    };

    expect(() => buildRepoWikiPacket({ ...validInput, repo: { fullName: "owner/repo/extra" } })).toThrow(/repo.fullName/);
    expect(() => buildRepoWikiPacket({ ...validInput, repo: { fullName: "/repo" } })).toThrow(/repo.fullName/);
    expect(() => buildRepoWikiPacket({ ...validInput, repo: { fullName: "owner/re_po!" } })).toThrow(/repo.fullName/);
    expect(() => buildRepoWikiPacket({ ...validInput, budget: { maxBytes: 0 } })).toThrow(/budget.maxBytes/);
    expect(() => buildRepoWikiPacket({ ...validInput, budget: { maxBytes: 12_000, maxTokens: -1 } })).toThrow(/budget.maxTokens/);
    expect(() => buildRepoWikiPacket({ ...validInput, budget: { maxBytes: 12_000, maxSectionBytes: 1.5 } })).toThrow(/budget.maxSectionBytes/);
    expect(() => buildRepoWikiPacket({ ...validInput, generatedAt: "2026-07-04T08:00:00Z" })).toThrow(/generatedAt/);
    expect(() =>
      buildRepoWikiPacket({
        ...validInput,
        source: { ref: "main", status: "fresh", checkedAt: "2026-07-04T08:00:00Z" }
      })
    ).toThrow(/source.checkedAt/);
    expect(() => truncateUtf8Bytes("abc", -1)).toThrow(/maxBytes/);
    expect(() => truncateUtf8Bytes("abc", 1.5)).toThrow(/maxBytes/);
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

  it("converges packet size at decimal digit boundaries", () => {
    const base = {
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: { ref: "main", status: "fresh" as const },
      generatedAt,
      sections: [section({ id: "digit-boundary", title: "Digit boundary", body: "x".repeat(80) })]
    };

    for (let maxBytes = 510; maxBytes <= 620; maxBytes += 1) {
      const packet = buildRepoWikiPacket({
        ...base,
        budget: { maxBytes, maxTokens: 200, maxSectionBytes: 80 }
      });
      expect(Buffer.byteLength(formatRepoWikiPacketMarkdown(packet), "utf8")).toBe(packet.byteBudget.usedBytes);
      expect(packet.byteBudget.usedBytes).toBeLessThanOrEqual(maxBytes);
    }
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
    expect(packetSha).toMatch(/^[a-f0-9]{64}$/);
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
    const privateKeyFixture = "-----BEGIN " + "PRIVATE KEY-----\n[redacted-secret]\nabc\n-----END " + "PRIVATE KEY-----";
    expect(truncateUtf8Bytes("ééabc", 3)).toBe("é");
    expect(redactRepoWikiText("token=abcdefghijklmnop")).toEqual({
      text: "[redacted-secret]",
      replacementCount: 1
    });
    expect(redactRepoWikiText(privateKeyFixture)).toEqual({
      text: "[redacted-secret]",
      replacementCount: 1
    });
  });

  it("builds a dry-run supported-addon contract without runtime or native tool expansion", () => {
    const wikiPacket = buildRepoWikiPacket({
      repo: { fullName: "electricsheephq/evaos-code-review-bot" },
      source: {
        ref: "main",
        headSha: "02c388056e6b04405bce2e6fe2de74db34db6ba7",
        checkedAt: generatedAt,
        status: "fresh"
      },
      generatedAt,
      budget: { maxBytes: 12_000, maxTokens: 3_000 },
      sections: [section({ id: "arch", title: "Architecture", body: "Local-first review worker." })]
    });
    const contract = buildSupportedAddonDryRunPacket({
      repo: "electricsheephq/evaos-code-review-bot",
      generatedAt,
      maxBytes: 40_000,
      maxTokens: 10_000,
      repoWikiPacket: wikiPacket,
      gitnexusPacket: {
        packetVersion: "gitnexus-context-packet-v0.1",
        sha256: "a".repeat(64),
        byteEstimate: 2048,
        tokenEstimate: 512,
        freshness: "fresh",
        degradedMode: false,
        relatedContextCount: 2,
        omittedContextCount: 0,
        redactionReportSha256: "b".repeat(64)
      }
    });
    const markdown = formatSupportedAddonDryRunPacketMarkdown(contract);

    expect(contract.packetSha).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.runtimePromotion).toBe(false);
    expect(contract.nativeToolExpansion).toBe(false);
    expect(contract.addons.map((addon) => addon.kind)).toEqual([
      "openwiki-compatible-repo-wiki",
      "gitnexus-context"
    ]);
    expect(contract.addons.every((addon) => addon.advisory)).toBe(true);
    expect(contract.addons.every((addon) => !addon.degradedMode)).toBe(true);
    expect(contract.byteBudget.usedBytes).toBe(Buffer.byteLength(markdown, "utf8"));
    expect(contract.tokenBudget.usedTokens).toBe(Math.ceil(contract.byteBudget.usedBytes / 4));
    expect(markdown).toContain("Runtime promotion: false");
    expect(markdown).toContain("Native tool expansion: false");
  });

  it("records missing and stale addons as degraded dry-run evidence without blocking the contract", () => {
    const contract = buildSupportedAddonDryRunPacket({
      repo: "electricsheephq/evaos-code-review-bot",
      generatedAt,
      maxBytes: 40_000,
      maxTokens: 10_000,
      gitnexusPacket: {
        packetVersion: "gitnexus-context-packet-v0.1",
        sha256: "c".repeat(64),
        byteEstimate: 1024,
        tokenEstimate: 256,
        freshness: "stale",
        degradedMode: true,
        degradedReason: "GitNexus index commit does not match PR base/head.",
        relatedContextCount: 0,
        omittedContextCount: 1,
        redactionReportSha256: "d".repeat(64)
      }
    });

    expect(contract.degradedMode).toBe(true);
    expect(contract.addons).toEqual([
      expect.objectContaining({
        kind: "openwiki-compatible-repo-wiki",
        status: "missing",
        degradedMode: true,
        degradedReason: "OpenWiki-compatible repo wiki packet was not supplied for this dry run."
      }),
      expect.objectContaining({
        kind: "gitnexus-context",
        status: "stale",
        degradedMode: true,
        degradedReason: "GitNexus index commit does not match PR base/head."
      })
    ]);
  });

  it("does not treat a GitNexus redaction report hash as a passed redaction status", () => {
    const contract = buildSupportedAddonDryRunPacket({
      repo: "electricsheephq/evaos-code-review-bot",
      generatedAt,
      maxBytes: 40_000,
      maxTokens: 10_000,
      gitnexusPacket: {
        packetVersion: "gitnexus-context-packet-v0.1",
        sha256: "e".repeat(64),
        byteEstimate: 1024,
        tokenEstimate: 256,
        freshness: "fresh",
        degradedMode: false,
        relatedContextCount: 1,
        omittedContextCount: 0,
        redactionReportSha256: "f".repeat(64)
      }
    });

    expect(contract.addons.find((addon) => addon.kind === "gitnexus-context")).toEqual(
      expect.objectContaining({
        redactionStatus: "unknown",
        redactionReportSha256: "f".repeat(64)
      })
    );
  });

  it("preserves an explicit GitNexus redaction status when the packet summary includes one", () => {
    const contract = buildSupportedAddonDryRunPacket({
      repo: "electricsheephq/evaos-code-review-bot",
      generatedAt,
      maxBytes: 40_000,
      maxTokens: 10_000,
      gitnexusPacket: {
        packetVersion: "gitnexus-context-packet-v0.1",
        sha256: "1".repeat(64),
        byteEstimate: 1024,
        tokenEstimate: 256,
        freshness: "fresh",
        degradedMode: false,
        relatedContextCount: 1,
        omittedContextCount: 0,
        redactionStatus: "passed",
        redactionReportSha256: "2".repeat(64)
      }
    });

    expect(contract.addons.find((addon) => addon.kind === "gitnexus-context")).toEqual(
      expect.objectContaining({
        redactionStatus: "passed",
        redactionReportSha256: "2".repeat(64)
      })
    );
  });

  it("rejects supported-addon dry-run contracts whose fixed summary exceeds byte or token caps", () => {
    const input = {
      repo: "electricsheephq/evaos-code-review-bot",
      generatedAt,
      repoWikiPacket: undefined,
      gitnexusPacket: undefined
    };

    expect(() => buildSupportedAddonDryRunPacket({ ...input, maxBytes: 10, maxTokens: 10 })).toThrow(/supported addon dry-run packet exceeds budget/);
    expect(() => buildSupportedAddonDryRunPacket({ ...input, maxBytes: 40_000, maxTokens: 1 })).toThrow(/supported addon dry-run packet exceeds budget/);
  });
});

function section(input: {
  id: string;
  title: string;
  body: string;
  order?: number;
  sourceFiles?: string[];
  sourceSha?: string;
  preRedactionReplacementCount?: number;
}) {
  return {
    id: input.id,
    title: input.title,
    body: input.body,
    order: input.order,
    sourceFiles: input.sourceFiles ?? ["README.md", "AGENTS.md", "src/worker.ts", "src/cli.ts", "tests/repo-wiki-packet.test.ts"],
    sourceSha: input.sourceSha,
    preRedactionReplacementCount: input.preRedactionReplacementCount
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
