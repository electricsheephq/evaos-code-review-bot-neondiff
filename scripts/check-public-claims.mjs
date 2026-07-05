import { readFileSync } from "node:fs";

const paths = [
  "README.md",
  "docs/SETUP.md",
  "docs/github-app-setup.md",
  "docs/providers.md",
  "docs/license-boundary.md",
  "docs/pricing.md",
  "docs/releases/v0.4.24-beta.1.md"
];

const required = [
  /source-available beta/i,
  /public open-source repositor(?:y|ies).*free/i,
  /private.*commercial.*paid|paid.*private.*commercial/i
];

const forbiddenClaims = [
  /\bMIT licensed\b/i,
  /\bApache licensed\b/i,
  /\bopen-source software\b/i,
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
