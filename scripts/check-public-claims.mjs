import { readFileSync } from "node:fs";

const paths = [
  "README.md",
  "LICENSE.md",
  "docs/SETUP.md",
  "docs/setup-validation.md",
  "docs/neondiff-desktop.md",
  "docs/github-app-setup.md",
  "docs/providers.md",
  "docs/license-boundary.md",
  "docs/pricing.md",
  "docs/github-marketplace-free-listing.md",
  "docs/releases/v1.0.3.md",
  "docs/releases/v1.0.0.md"
];

// Licensing framing (owner ruling; technical-merit resolution 2026-07-16). The
// SHIPPED CLI (v1.0.x) requires API-backed activation for EVERY repository — a
// local publicReposFree flag would trust the client's own visibility claim, the
// exact bypass the #614 server-side broker exists to stop. So public-free is the
// TARGET, gated on the native app + managed GitHub App broker (#614), and must be
// announced as upcoming — never asserted as current CLI behavior. Website copy
// migration is owned by website issue #52. These required claims guard that the
// docs state current CLI truth AND mark the public-free target correctly.
const required = [
  /source-available/i,
  /public open-source repositor(?:y|ies) will be free/i,
  /requires (?:live |active |mandatory )?API-backed activation for every repository/i,
  /private.*commercial.*paid|paid.*private.*commercial/i,
  /\$100\/(?:year|yr)/i,
  /7-day trial/i,
  /30-day trial/i,
  /legacy lifetime licenses? remain honored/i,
  /org_yearly_support/i,
  /--license-key-stdin true/,
  /nd_live_/
];

const forbiddenClaims = [
  /\bMIT licensed\b/i,
  /\bApache licensed\b/i,
  /\bopen-source software\b/i,
  /\$100\s+lifetime/i,
  /NEONDIFF_API_KEY/,
  /\bproduction-ready\b/i,
  /\benterprise-ready\b/i,
  /\bCodeRabbit parity\b/i,
  /\bpublic launch is complete\b/i
];

let failed = false;
const combined = paths.map((path) => readFileSync(path, "utf8")).join("\n\n");

for (const pattern of required) {
  if (!pattern.test(combined)) {
    console.error(`public docs: missing required public boundary ${pattern}`);
    failed = true;
  }
}

for (const path of paths) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  for (const pattern of forbiddenClaims) {
    const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
    for (const match of matches) {
      const index = lines.findIndex((candidate) => candidate.includes(match));
      const context = lines.slice(Math.max(0, index - 12), index + 2).join("\n");
      const boundaryLanguage = /not |does not|do not|avoid|unless|not claimed|must not|forbidden|never/i.test(context);
      if (!boundaryLanguage) {
        console.error(`${path}: forbidden public claims phrase outside boundary language: ${match}`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log("forbidden public claims scan ok");
