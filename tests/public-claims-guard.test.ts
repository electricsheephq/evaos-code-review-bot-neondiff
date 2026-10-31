import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-public-claims.mjs");
const scannedPaths = [...readFileSync(script, "utf8").matchAll(/^\s+"([^"]+\.md)",?$/gm)].map((match) => match[1]);
const roots: string[] = [];

function runGuardWith(readmePrefix: string, transform?: (text: string, path: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-public-claims-"));
  roots.push(root);
  for (const path of scannedPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (transform) writeFileSync(join(root, path), transform(readFileSync(path, "utf8"), path));
    else copyFileSync(path, join(root, path));
  }
  // Prepend fixtures without replacing the required canonical claims.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  writeFileSync(join(root, "README.md"), `${readmePrefix}\n\n${readme}`);
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public claims guard", () => {
  it("passes the current public docs", () => {
    expect(scannedPaths.length).toBeGreaterThan(5);
    expect(runGuardWith("").status).toBe(0);
  });

  it.each([
    "Private repositories are free to review with NeonDiff.",
    "Private repos are free.",
    "NeonDiff offers free private repo review.",
    "NeonDiff is free for all repositories.",
    "NeonDiff is free for private repositories."
  ])("rejects a free-private claim: %s", (claim) => {
    const result = runGuardWith(claim);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/forbidden public claims phrase/);
  });

  it("judges a repeated forbidden phrase at its own location, not the first exempt occurrence", () => {
    const result = runGuardWith("", (text, path) => path === "docs/license-boundary.md"
      ? `${text}\n${"\n".repeat(14)}NeonDiff is free for private repositories.\n`
      : text);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/docs\/license-boundary\.md: forbidden public claims phrase/);
  });

  it("requires the 1.1.0 qualifier on the public-free claim", () => {
    const result = runGuardWith("", (text) => text.replace(/From (?:NeonDiff )?1\.1\.0,\s+review/g, "Review"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing required public boundary .*1\\\.1\\\.0/);
  });

  it("rejects a public-free claim that drops its GitHub Action / review-pr --ci / self-hosted worker scope", () => {
    const result = runGuardWith("From NeonDiff 1.1.0, review of repositories that GitHub reports as public is free, with no license key, everywhere.");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/README\.md:1: public-free claim must name its scope/);
  });

  it("requires the Mac app keyless public-review claim", () => {
    const result = runGuardWith("", (text) => text.replace(/Mac app reviews public repositories without a key/gi, "Mac app setup"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing required public boundary .*Mac app/);
  });

  it("requires the 1.0.x qualifier on the every-repository activation claim", () => {
    const result = runGuardWith("", (text) => text.replace(/1\.0\.x(\s+)requires/g, "always$1requires"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing required public boundary .*1\\\.0\\\.x/);
  });
});

// Lane B items 5 and 6: unrelated disclaimers never scope another sentence.
it.each(["Do not misstate policy.\n\n\n\n", "Do not misstate policy. "])("rejects private-free claims after an unrelated disclaimer: %s", (prefix) => {
  expect(runGuardWith(`${prefix}NeonDiff is free for private repositories.`).status).toBe(1);
});
it.each([
  "From NeonDiff 1.1.0, all public repositories are free everywhere, including daemon and local review-pr.",
  "NeonDiff is free for open source.",
  "Public repos are free.",
  "Free review for public repositories.",
  "Public repos are free. Use the GitHub Action and `neondiff review-pr --ci`."
])("rejects an unscoped public-free paraphrase: %s", (claim) => {
  expect(runGuardWith(claim).status).toBe(1);
});
it.each([
  "Public repos are free through `neondiff review-pr --ci`.",
  "Public repos are free through the self-hosted worker.",
  "Public repos are free through the Mac app with Public repositories only selected.",
  "Free review for public repositories through the GitHub Action.",
  "NeonDiff is free for open source through `neondiff review-pr --ci`.",
  "NeonDiff is not free for private repositories.",
  "Avoid: \"free for private repositories\""
])("allows scoped or explicitly disallowed copy: %s", (claim) => {
  expect(runGuardWith(claim).status).toBe(0);
});
// Review of lane B: the canonical claim keeps both surfaces and no exemption; a trailing negation exempts nothing.
it.each([
  "From 1.1.0, review of repositories that GitHub reports as public is free on every surface, so you never need a license.",
  "From 1.1.0, review of repositories that GitHub reports as public is free in the Mac app and the GitHub Action.",
  "Public repositories are free everywhere and never need a license."
])("rejects a broad public-free claim despite negation or a single surface: %s", (claim) => {
  expect(runGuardWith(claim).status).toBe(1);
});
// #1203: the stale "Mac app needs a key everywhere" claim is blocked; the true private-repository rule is not.
it.each([
  "The Mac app still requires a license key for every repository.",
  "The Mac app needs activation even for public repositories."
])("rejects the stale Mac app key claim: %s", (claim) => {
  const result = runGuardWith(claim);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/README\.md: forbidden public claims phrase/);
});
// A free claim that covers every surface is broad even when it names one surface. A negation after a clause break
// does not excuse it, and free-trial copy is not such a claim (#1243).
it.each([
  "Public repos are free on every interface, including the Mac app.",
  "Public repositories are free everywhere, including the GitHub Action.",
  "Public repos are free everywhere, including the Mac app, and never need a license.",
  "Public repos are free everywhere through the Mac app and never need a license.",
  "Public repos are free on every interface, including the Mac app, unless the repo is private.",
  "Public review is free everywhere, not just through the GitHub Action.",
  "From NeonDiff 1.1.0, review of repositories that GitHub reports as public is free everywhere, including the GitHub Action, `neondiff review-pr --ci`, and the self-hosted worker.",
  "NeonDiff is free everywhere.",
  "Reviews are free on every surface for public repositories."
])("rejects a free claim that covers every surface: %s", (claim) => {
  const result = runGuardWith(claim);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/README\.md:\d+: free claim covers every surface/);
});
it.each([
  "The 7-day free trial works on every surface.",
  "Solo includes a free 14 day trial on every surface.",
  "Team plans include a free, 30-day trial on every surface.",
  "The 7-day Solo trial is free on every surface.",
  "The confirmed install keeps the self-hosted worker credential-free on every path except Keychain-backed mode.",
  "Use strong passwords everywhere; public repos are free through the GitHub Action.",
  "Public repos are free through the GitHub Action, but not everywhere.",
  "Do not say NeonDiff is free everywhere.",
  "Don't call NeonDiff free everywhere.",
  "Private, internal, and unknown-visibility repositories aren't free on any surface.",
  "Calling NeonDiff free everywhere is forbidden.",
  "Describing NeonDiff as free on every surface is forbidden.",
  "The Mac app does not require a license key for every repository.",
  "Calling NeonDiff MIT licensed is forbidden."
])("allows copy that is not an every-surface free claim: %s", (claim) => {
  expect(runGuardWith(claim).status).toBe(0);
});
it("allows the Mac app private-repository license rule", () => {
  expect(runGuardWith("The Mac app needs a Solo or Team license for private repositories.").status).toBe(0);
});
