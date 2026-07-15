import { readFileSync, existsSync } from "node:fs";

// Contract guard for issue #611: the live production website
// (https://neondiff.com) is the single approved visual source for the native
// macOS app. This check fails the build if the design-source document is
// missing or stripped, or if retired browser-dashboard/WebView-parity language
// reappears in the public-facing product docs. Follows the style of
// scripts/check-public-claims.mjs (Node, no dependencies).

const designDoc = "docs/design/live-site-design-source.md";

// Files that previously carried the retired "dashboard is the first-run
// product surface" / browser-parity direction. Only these three are scanned;
// eval and boundary docs legitimately keep parity disclaimers.
const guardedDocs = ["README.md", "docs/SETUP.md", "docs/neondiff-desktop.md"];

const requiredSubstrings = ["https://neondiff.com"];

const requiredLinePatterns = [/Captured: 2026-07-15/];

const requiredHeadings = [
  "Design authority",
  "Token table",
  "Type system",
  "Component translation",
  "Neon budget",
  "Forbidden clones",
  "Light mode",
  "Accessibility floors"
];

const forbiddenDocPatterns = [
  /dashboard is the (human )?first-run/i,
  /browser[- ]dashboard parity/i,
  /webview/i
];

const violations = [];

// (A) + (C) design-source document must exist and stay complete.
if (!existsSync(designDoc)) {
  violations.push(`${designDoc}: design-source document is missing`);
} else {
  const doc = readFileSync(designDoc, "utf8");
  for (const needle of requiredSubstrings) {
    if (!doc.includes(needle)) {
      violations.push(`${designDoc}: missing required reference "${needle}"`);
    }
  }
  for (const pattern of requiredLinePatterns) {
    if (!pattern.test(doc)) {
      violations.push(`${designDoc}: missing required line matching ${pattern}`);
    }
  }
  for (const heading of requiredHeadings) {
    if (!doc.includes(heading)) {
      violations.push(`${designDoc}: missing required section "${heading}"`);
    }
  }
  // (C) the rejected-direction statement must survive.
  if (!doc.includes("rejected")) {
    violations.push(`${designDoc}: missing the rejected-direction statement ("rejected")`);
  }
}

// (B) retired-direction language must not reappear in the guarded product docs.
for (const path of guardedDocs) {
  if (!existsSync(path)) {
    violations.push(`${path}: guarded doc is missing`);
    continue;
  }
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const pattern of forbiddenDocPatterns) {
      if (pattern.test(line)) {
        violations.push(`${path}:${index + 1}: retired-direction language matches ${pattern}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("design-source contract violations:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("live-site design-source contract ok");
