import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfinedEvidenceOutputPath } from "../scripts/lib/evidence-output-path.mjs";

describe("release evidence output confinement", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a syntactically in-tree output whose existing parent escapes through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-evidence-output-"));
    const outside = mkdtempSync(join(tmpdir(), "neondiff-evidence-outside-"));
    roots.push(root, outside);
    mkdirSync(join(root, "docs", "evidence"), { recursive: true });
    symlinkSync(outside, join(root, "docs", "evidence", "link"));

    expect(() => resolveConfinedEvidenceOutputPath(root, "docs/evidence/link/created-before-reject/proof.json")).toThrow(
      /stay within docs\/evidence/
    );
    expect(existsSync(join(outside, "created-before-reject"))).toBe(false);
    expect(resolveConfinedEvidenceOutputPath(root, "docs/evidence/v1.0.4/proof.json")).toBe(
      join(realpathSync(root), "docs", "evidence", "v1.0.4", "proof.json")
    );
  });
});
