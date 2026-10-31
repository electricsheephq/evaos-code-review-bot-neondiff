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
// current flat prices; the public-free and activation claims must carry their
// 1.1.0 and 1.0.x qualifiers.
// Owner decision #1191: the self-hosted worker joins the CI public-free scope;
// #1203 adds the Mac app public-only onboarding path without a license key.
const required = [
  /source-available/i,
  /From (?:NeonDiff )?1\.1\.0,\s+review\s+of\s+repositories\s+that\s+GitHub\s+reports\s+as\s+public\s+is\s+free/i,
  /through\s+the\s+GitHub\s+Action,[\s\S]{0,60}review-pr\s+--ci[\s\S]{0,60}self-hosted\s+worker/i,
  /Mac app reviews public repositories without a key/i,
  /Public repositories only/i,
  /private, internal, and unknown-visibility repositor(?:y|ies) (?:require|need)/i,
  /1\.0\.x\s+requires\s+(?:live\s+|active\s+|mandatory\s+)?API-backed\s+activation\s+for\s+every\s+repository/i,
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
  /\bfree for all repositor(?:y|ies)\b/i,
  /\bprivate (?:repos?|repositor(?:y|ies)) (?:are|is) free\b/i,
  // #1203: the Mac app reviews public repositories without a key, so the old claim is stale.
  /\bMac app\b[^.!?]{0,80}\b(?:requires?|needs?)\b[^.!?]{0,80}\b(?:every repositor|even (?:for )?public)/i
];

let failed = false;
const combined = paths.map((path) => readFileSync(path, "utf8")).join("\n\n");

for (const pattern of required) {
  if (!pattern.test(combined)) {
    console.error(`public docs: missing required public boundary ${pattern}`);
    failed = true;
  }
}

// Sentence boundaries preserve wrapped prose and dotted version numbers.
function sentenceSpan(text, index) {
  const boundaries = /[.!?](?=\s|$)|\n\s*\n|\n(?=\s*(?:[-*] |#{1,6} ))/g;
  let start = 0;
  for (const boundary of text.matchAll(boundaries)) {
    if (boundary.index >= index) return [start, boundary.index];
    start = boundary.index + boundary[0].length;
  }
  return [start, text.length];
}
function sentenceAt(text, index) {
  return text.slice(...sentenceSpan(text, index));
}
const boundaryLanguage = /\b(?:not|avoid|unless|forbidden|never)\b/i;
// The canonical claim keeps the strict rule: all three surfaces within 350 characters, no exemption.
const canonicalPublicFree = /reports\s+as\s+public\s+is\s+free/gi;
const canonicalScope = /GitHub\s+Action[\s\S]{0,60}review-pr\s+--ci[\s\S]{0,60}self-hosted\s+worker/i;
const publicFreeClaim = /public\s+(?:repos?\b|repositor(?:y|ies)\b)[^.!?]{0,60}\bfree\b|\bfree\s+(?:(?:review\s+)?for\s+)?(?:public\s+(?:repos?\b|repositor(?:y|ies)\b)|open[ -]source\b)|open[ -]source[^.!?]{0,60}\bfree\b/gi;
const scopedPublicFree = /GitHub\s+Action|review-pr\s+--ci|self-hosted\s+worker|Mac\s+app/i;
// A free claim that covers every surface is broad even when it names one surface. A negation excuses it only inside the
// claim's own clause: before it ("Do not say ... free everywhere"), within it ("free through the Action, but not
// everywhere") or after it ("Calling NeonDiff free everywhere is forbidden"). A clause break ends that clause, so neither
// ", and never need a license" nor "Don't wait; ..." excuses the claim. Before the claim only punctuation and "but" break
// a clause, because "and" there often joins words ("open source and free everywhere").
// Free-trial copy ("free 7-day trial", "the trial is free") and credential compounds such as "credential-free" are not
// such claims; pricing compounds such as "license-free" are.
const freeEverySurface = /(?<!\btrials?\s+(?:is|are|stays|remains)\s+)\b(?<!(?:credential|secret|token)-)free\b(?![\s,-]+(?:\d+[\s-]day[\s-]+)?trials?\b)[^.!?]{0,40}(?:\beverywhere\b|\b(?:on|in|through|via|across)\s+(?:every|all|any)\s+(?:interfaces?|surfaces?|paths?)\b)/gi;
const everySurfaceNegation = /\b(?:not|avoid|unless|forbidden|never)\b|n['’]t\b/i;
const clauseBreak = /[,;:]|\b(?:and|but|while|so|because|whereas)\b/i;
const clauseBreakBefore = /[,;:]|\bbut\b/gi;
for (const path of paths) {
  const text = readFileSync(path, "utf8");
  for (const pattern of forbiddenClaims) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (!boundaryLanguage.test(sentenceAt(text, match.index))) {
        console.error(`${path}: forbidden public claims phrase outside boundary language: ${match[0]}`);
        failed = true;
      }
    }
  }
  for (const match of text.matchAll(canonicalPublicFree)) {
    if (!canonicalScope.test(text.slice(match.index, match.index + 350))) {
      const line = text.slice(0, match.index).split("\n").length;
      console.error(`${path}:${line}: public-free claim must name its scope (GitHub Action, review-pr --ci, and self-hosted worker)`);
      failed = true;
    }
  }
  // Paraphrases are exempt only when boundary language precedes them ("Do not describe ... as open source"),
  // so a trailing "never need a license" cannot excuse a broad promise.
  for (const match of text.matchAll(publicFreeClaim)) {
    const sentence = sentenceAt(text, match.index);
    const before = text.slice(sentenceSpan(text, match.index)[0], match.index);
    if (!boundaryLanguage.test(before) && !scopedPublicFree.test(sentence)) {
      const line = text.slice(0, match.index).split("\n").length;
      console.error(`${path}:${line}: public-free claim must name its scope (GitHub Action, review-pr --ci, self-hosted worker, or Mac app)`);
      failed = true;
    }
  }
  for (const match of text.matchAll(freeEverySurface)) {
    const [start, end] = sentenceSpan(text, match.index);
    const claimEnd = match.index + match[0].length;
    const last = [...text.slice(start, match.index).matchAll(clauseBreakBefore)].at(-1);
    const clauseStart = last ? start + last.index + last[0].length : start;
    const rest = text.slice(claimEnd, end);
    const cut = rest.search(clauseBreak);
    if (!everySurfaceNegation.test(text.slice(clauseStart, claimEnd) + (cut === -1 ? rest : rest.slice(0, cut)))) {
      const line = text.slice(0, match.index).split("\n").length;
      console.error(`${path}:${line}: free claim covers every surface (name its surfaces, or negate it in the same clause): ${match[0]}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("forbidden public claims scan ok");
