import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
const repoRoot = resolve(import.meta.dirname, "..");
const operationalDocs = ["docs/beta-release-runbook.md", "docs/release-governance.md", "docs/desktop-auto-update-channel.md", "apps/neondiff-desktop/docs/appcast-channels.md", "docs/eval-harness.md", "docs/repo-profiles.md", "docs/skills/release-operator.md", "launchd/evaos-code-review-bot.plist.example"];
function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}
it("keeps current operational docs portable and account-scoped", () => {
  const contents = operationalDocs.map(read).join("\n");
  expect(contents).not.toMatch(/\/Volumes\/LEXAR|\/Users\/(?:m1|lume)|PRIVATE_KEY_PATH|REPLACE_WITH_APP_ID/);
  expect(contents).toContain("Library/Application Support/NeonDiffDesktop/Accounts");
  expect(contents).toContain("macOS Keychain");
});
it("keeps generated eval and appcast evidence outside the checkout", () => {
  expect(read("docs/eval-harness.md")).toContain("NEONDIFF_EVAL_ROOT");
  expect(read("apps/neondiff-desktop/docs/appcast-channels.md")).toContain("NEONDIFF_EVIDENCE_ROOT");
});
it("uses the signed Desktop executable in the launchd example", () => {
  const plist = read("launchd/evaos-code-review-bot.plist.example");
  expect(plist).toContain("/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop");
  expect(plist).not.toMatch(/WorkingDirectory|EnvironmentVariables/);
});
