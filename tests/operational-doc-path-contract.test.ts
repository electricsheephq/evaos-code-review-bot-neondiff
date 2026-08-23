import { readFileSync } from "node:fs"; import { join, resolve } from "node:path"; import { expect, it } from "vitest";
const root = resolve(import.meta.dirname, ".."), docs = ["docs/beta-release-runbook.md", "docs/release-governance.md", "docs/desktop-auto-update-channel.md", "apps/neondiff-desktop/docs/appcast-channels.md", "docs/eval-harness.md", "docs/repo-profiles.md", "docs/skills/release-operator.md", "launchd/evaos-code-review-bot.plist.example"], read = (path: string) => readFileSync(join(root, path), "utf8");
it("keeps active operational docs portable and Keychain-only", () => {
  const contents = docs.map(read).join("\n");
  expect(contents).not.toMatch(/\/Volumes\/LEXAR|\/Users\/(?:m1|lume)\//);
  expect(contents).not.toMatch(/PRIVATE_KEY_PATH|private-key\.pem|REPLACE_WITH_APP_ID/); expect(contents).toContain("Library/Application Support/NeonDiffDesktop/Accounts"); expect(contents).toContain("macOS Keychain");
}); it("keeps generated eval and appcast evidence under explicit portable roots", () => {
  expect(read("docs/eval-harness.md")).toContain("NEONDIFF_EVAL_ROOT"); expect(read("apps/neondiff-desktop/docs/appcast-channels.md")).toContain("NEONDIFF_EVIDENCE_ROOT"); expect(read("docs/desktop-auto-update-channel.md")).toContain("NEONDIFF_EVIDENCE_ROOT");
}); it("uses the signed Desktop headless worker contract in the launchd example", () => {
  const plist = read("launchd/evaos-code-review-bot.plist.example");
  for (const value of ["/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop", "--neondiff-worker-daemon", "--config", "Accounts/REPLACE_WITH_ACCOUNT_ID/Bots/REPLACE_WITH_BOT_ID/config.local.json", "--launchd-label", "--github-app-id", "--license-machine-id"]) expect(plist).toContain(value);
  expect(plist).not.toMatch(/WorkingDirectory|EnvironmentVariables|PRIVATE_KEY|private-key/);
});
it("documents accepted signed worker updates that preserve the running identity", () => {
  const releaseDocs = ["docs/SETUP.md", "docs/beta-release-runbook.md", "docs/release-governance.md", "docs/skills/release-operator.md"].map(read).join("\n");
  expect(releaseDocs).toContain("accepted signed"); expect(releaseDocs).toMatch(/Install \/ Update Local Worker/); expect(releaseDocs).toMatch(/preserves? (?:the )?(?:existing )?(?:running )?worker/i);
  expect(releaseDocs).toMatch(/LaunchAgent.{0,120}(?:preserve|same|identity)/is); expect(releaseDocs).not.toMatch(/git checkout main[\s\S]{0,240}launchctl/);
});
