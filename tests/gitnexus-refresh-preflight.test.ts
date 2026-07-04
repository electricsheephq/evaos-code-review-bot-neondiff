import { describe, expect, it } from "vitest";
import {
  buildGitNexusRefreshPreflight,
  formatGitNexusAnalyzeCommand,
  parseGitNexusIndexDimensions
} from "../src/gitnexus-refresh-preflight.js";

describe("GitNexus refresh preflight", () => {
  it("reports the existing index dimensions and intended provider dimensions", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Index: evaos-code-review-bot-neondiff\nEmbedding dimensions: 2048\nProvider: voyage-code-3\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.voyageai.com/v1",
        GITNEXUS_EMBEDDING_MODEL: "voyage-code-3",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      action: "analyze_with_embeddings",
      current: {
        dimensions: 2048
      },
      intended: {
        provider: "voyage",
        model: "voyage-code-3",
        dimensions: 2048
      }
    });
    expect(result.warnings).toEqual([]);
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --embeddings");
  });

  it("fails closed before vector rebuild when provider configuration is missing", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {}
    });

    expect(result).toMatchObject({
      ok: false,
      action: "blocked",
      current: {
        dimensions: 2048
      }
    });
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --index-only");
    expect(result.errors).toContain("GITNEXUS_EMBEDDING_DIMS is required before running gitnexus analyze --embeddings");
  });

  it("can explicitly choose index-only fallback when provider configuration is missing", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {},
      indexOnlyFallback: true
    });

    expect(result).toMatchObject({
      ok: true,
      action: "index_only_fallback"
    });
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --index-only");
    expect(result.warnings).toContain("provider configuration missing; using index-only fallback to avoid changing embedding dimensions");
    expect(result.errors).toEqual([]);
  });

  it("blocks mismatched intended dimensions unless force is explicit", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {
        GITNEXUS_EMBEDDING_PROVIDER: "local",
        GITNEXUS_EMBEDDING_DIMS: "384"
      }
    });

    expect(result).toMatchObject({
      ok: false,
      action: "blocked",
      current: {
        dimensions: 2048
      },
      intended: {
        dimensions: 384
      }
    });
    expect(result.errors).toContain("intended dimensions 384 do not match current index dimensions 2048");
  });

  it("allows an explicit dimension-change override only when other proof is present", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {
        GITNEXUS_EMBEDDING_PROVIDER: "local",
        GITNEXUS_EMBEDDING_DIMS: "384"
      },
      allowDimensionChange: true
    });

    expect(result).toMatchObject({
      ok: true,
      action: "analyze_with_embeddings",
      current: {
        dimensions: 2048
      },
      intended: {
        provider: "local",
        dimensions: 384
      }
    });
    expect(result.errors).toEqual([]);
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --embeddings --allow-dimension-change true");
  });

  it("keeps missing-provider and missing-current-dimension errors even with dimension-change override", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Repository: /repo\nStatus: stale\n",
      env: {
        GITNEXUS_EMBEDDING_DIMS: "384"
      },
      allowDimensionChange: true
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("blocked");
    expect(result.errors).toContain("GITNEXUS_EMBEDDING_PROVIDER, GITNEXUS_EMBEDDING_MODEL, or GITNEXUS_EMBEDDING_URL is required before running gitnexus analyze --embeddings");
    expect(result.errors).toContain("current index embedding dimensions are required before running gitnexus analyze --embeddings");
  });

  it("blocks embedding refresh when current index dimensions cannot be proven", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Repository: /repo\nStatus: stale\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.voyageai.com/v1",
        GITNEXUS_EMBEDDING_MODEL: "voyage-code-3",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      }
    });

    expect(result).toMatchObject({
      ok: false,
      action: "blocked",
      current: {},
      intended: {
        provider: "voyage",
        model: "voyage-code-3",
        dimensions: 2048
      }
    });
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --index-only");
    expect(result.errors).toContain("current index embedding dimensions are required before running gitnexus analyze --embeddings");
  });

  it("allows explicit index-only fallback when embedding refresh dimensions are unsafe", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Repository: /repo\nStatus: stale\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.voyageai.com/v1",
        GITNEXUS_EMBEDDING_MODEL: "voyage-code-3",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      },
      indexOnlyFallback: true
    });

    expect(result).toMatchObject({
      ok: true,
      action: "index_only_fallback"
    });
    expect(result.recommendedCommand).toBe("gitnexus analyze . --name evaos-code-review-bot-neondiff --index-only");
    expect(result.warnings).toContain("embedding refresh unsafe; using index-only fallback to avoid changing embedding dimensions");
    expect(result.errors).toEqual([]);
  });

  it("parses common GitNexus dimension output shapes", () => {
    expect(parseGitNexusIndexDimensions("Embedding dimensions: 2048")).toBe(2048);
    expect(parseGitNexusIndexDimensions("embeddingDimensions=1024")).toBe(1024);
    expect(parseGitNexusIndexDimensions("no vectors yet")).toBeUndefined();
  });

  it("rejects stray duration and bare non-embedding dimensions as index dimensions", () => {
    expect(parseGitNexusIndexDimensions("Status: stale 7d\nRepo VECTOR note: exact scan limit: 10000 chunks")).toBeUndefined();
    expect(parseGitNexusIndexDimensions("cache dimensions: 256\nmatrix dimensions=384")).toBeUndefined();
    expect(parseGitNexusIndexDimensions("Embeddings: enabled\ncache dimensions: 2048")).toBeUndefined();
    expect(parseGitNexusIndexDimensions("dimensions: 2048 embeddings enabled")).toBeUndefined();
    expect(parseGitNexusIndexDimensions("Embedding dimensions changed (2048d -> 384d), discarding cache")).toBeUndefined();
  });

  it("surfaces invalid dimension environment values distinctly", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.openai.com/v1",
        GITNEXUS_EMBEDDING_DIMS: "2048.0"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.intended.provider).toBe("openai");
    expect(result.intended).not.toHaveProperty("dimensionsText");
    expect(result.errors).toContain("GITNEXUS_EMBEDDING_DIMS must be a positive integer");
    expect(result.errors).not.toContain("GITNEXUS_EMBEDDING_DIMS is required before running gitnexus analyze --embeddings");
  });

  it("does not leak raw dimension text into successful public output", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions: 2048\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.voyageai.com/v1",
        GITNEXUS_EMBEDDING_MODEL: "voyage-code-3",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.intended).toEqual({
      provider: "voyage",
      model: "voyage-code-3",
      dimensions: 2048
    });
  });

  it("surfaces the exact CLI diagnostic envelope for gitnexus status and doctor command failures", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "$ gitnexus status\n[gitnexus status exit status=1 signal=null]\n[gitnexus status error code=ENOENT message=spawn gitnexus ENOENT]\n$ gitnexus doctor\n[gitnexus doctor exit status=7 signal=null]\n",
      env: {
        GITNEXUS_EMBEDDING_URL: "https://api.voyageai.com/v1",
        GITNEXUS_EMBEDDING_MODEL: "voyage-code-3",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("gitnexus status failed: status=1; error=ENOENT spawn gitnexus ENOENT");
    expect(result.errors).toContain("gitnexus doctor failed: status=7");
  });

  it("treats changed-dimension output as ambiguous until a fresh current dimension is present", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "Embedding dimensions changed (2048d -> 384d), discarding cache\n",
      env: {
        GITNEXUS_EMBEDDING_PROVIDER: "local",
        GITNEXUS_EMBEDDING_DIMS: "384"
      }
    });

    expect(result.current.dimensions).toBeUndefined();
    expect(result.errors).toContain("current index embedding dimensions are required before running gitnexus analyze --embeddings");
  });

  it("parses sanitized diagnostic envelope messages containing bracket-like text", () => {
    const result = buildGitNexusRefreshPreflight({
      repoAlias: "evaos-code-review-bot-neondiff",
      indexInfoText: "$ gitnexus status\n[gitnexus status exit status=null signal=null]\n[gitnexus status error code=EACCES message=spawn gitnexus EACCES at /repo/(bracketed)]\n",
      env: {
        GITNEXUS_EMBEDDING_PROVIDER: "local",
        GITNEXUS_EMBEDDING_DIMS: "2048"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("gitnexus status failed: error=EACCES spawn gitnexus EACCES at /repo/(bracketed)");
  });

  it("formats analyze commands without silently enabling vector rebuilds", () => {
    expect(formatGitNexusAnalyzeCommand({ repoPath: ".", embeddings: true })).toBe("gitnexus analyze . --embeddings");
    expect(formatGitNexusAnalyzeCommand({ repoPath: ".", embeddings: true, allowDimensionChange: true })).toBe("gitnexus analyze . --embeddings --allow-dimension-change true");
    expect(formatGitNexusAnalyzeCommand({ repoPath: ".", indexOnly: true })).toBe("gitnexus analyze . --index-only");
    expect(formatGitNexusAnalyzeCommand({
      repoPath: "/Volumes/LEXAR/repos/evaos-code-review-bot",
      repoAlias: "evaos-code-review-bot-neondiff",
      indexOnly: true
    })).toBe("gitnexus analyze /Volumes/LEXAR/repos/evaos-code-review-bot --name evaos-code-review-bot-neondiff --index-only");
  });
});
