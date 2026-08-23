import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("legacy CLI/operator documentation boundary", () => {
  it("documents the verified plist coordinate and confined evidence roots", () => {
    const legacy = read("docs/legacy-cli-boundary.md");
    const operator = read("docs/operator-cli.md");

    expect(legacy).toContain("ProgramArguments");
    expect(legacy).toContain("WorkingDirectory");
    expect(legacy).toContain("EnvironmentVariables");
    expect(legacy).toContain("statePath");
    expect(legacy).toContain("NEONDIFF_OPERATOR_EVIDENCE_ROOT");
    expect(legacy).toContain("evidence must be outside checkout");
    expect(legacy).toContain("--allow-external-plist true");
    expect(legacy).toContain("NEONDIFF_CANDIDATE_INSTALLER\" update");
    expect(legacy).toContain("NEONDIFF_CANDIDATE_INSTALLER\" rollback");
    expect(legacy).toContain("--manifest-sha256");
    expect(legacy).toContain("Workers/<label>/current/node_modules/neondiff/dist/src/cli.js");
    expect(legacy).toContain("one worker pair");
    expect(legacy).toContain("evidence must not contain checkout");
    expect(legacy).toContain("api-key-env");
    expect(legacy).not.toContain("Volumes/LEXAR");
    expect(legacy).toContain("Accounts/<account>/Bots/<bot>/config.local.json");
    expect(legacy).toContain("reviews.sqlite");
    expect(operator).toContain("legacy-cli-boundary.md");
  });
});
