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

// Licensing framing (PM decision 2026-10-22, reversing the 2026-07-16 ruling).
// From 1.1.0 the official policy sets publicReposFree: true, so a review cycle on
// a repository whose GitHub-reported visibility is public is admitted without a
// license call (src/license-admission.ts). The old ruling deferred this to a
// server-side broker (#614) because a local flag trusts the client; but a
// source-available client can always be patched, so the broker adds no real
// enforcement for public repos, and free public review is distribution.
// Private, internal, and unknown visibility still require live activation.
// These required claims keep the docs on that truth, the 1.0.x caveat, and the
// current flat prices.
const required = [
  /source-available/i,
  /repositor(?:y|ies) that GitHub reports as public (?:is |for )free/i,
  /private, internal, and unknown-visibility repositor(?:y|ies) (?:require|need)/i,
  /requires (?:live |active |mandatory )?API-backed activation for every repository/i,
  /\$9\/mo/,
  /\$90\/(?:year|yr)/i,
  /\$290\/(?:year|yr)/i,
  /7-day trial/i,
  /30-day trial/i,
  /existing subscribers keep their current price/i,
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
  /\bpublic launch is complete\b/i,
  /\bfree (?:for )?private repo/i,
  /\bprivate (?:repos?|repositor(?:y|ies)) (?:are|is) free\b/i
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
