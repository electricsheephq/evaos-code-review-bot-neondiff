import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("packaged customer setup surface", () => {
  it("packs the README, setup guide, and native adoption anchor", () => {
    const pack = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" })
    ) as Array<{ files?: Array<{ path?: string }> }>;
    const files = new Set(pack[0]?.files?.map((entry) => entry.path));

    for (const path of ["README.md", "docs/SETUP.md", "docs/github-app-setup.md", "docs/mac-update-rollback.md"]) {
      expect(existsSync(path), `${path} exists in the repository`).toBe(true);
      expect(files.has(path), `${path} is present in npm pack`).toBe(true);
    }

    const readme = read("README.md");
    const setup = read("docs/SETUP.md");
    const githubSetup = read("docs/github-app-setup.md");
    expect(readme).toContain("docs/SETUP.md#native-desktop-adoption");
    expect(readme).toContain("docs/SETUP.md#update-an-existing-local-worker");
    expect(setup).toContain("## Native Desktop adoption");
    expect(setup).toContain("### Update an existing local worker");
    expect(setup).toContain("bots: []");
    expect(setup).toContain("state/reviews.sqlite");
    expect(setup).toContain("mac-update-rollback.md");
    expect(setup).toContain("Useful current-launch work requires the exact");
    expect(setup).toContain("REFRESH ACCOUNTS");
    expect(setup).toContain("pending local bot cannot promote itself");
    for (const guide of [readme, setup, githubSetup]) {
      expect(guide).toContain("REFRESH ACCOUNTS");
      expect(guide).toContain("pending local bot");
    }
    expect(setup).not.toContain("apps/neondiff-desktop/docs/customer-adoption.md");
  });
});
