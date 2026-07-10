import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = JSON.parse(readFileSync(join(root, "shared/canonical-secret-rules.json"), "utf8"));
const generatedText = readFileSync(join(root, "src/generated-secret-rules.ts"), "utf8");
const rules = parseGenerated("canonicalSecretRules", generatedText);
const cookie = parseGenerated("canonicalSensitiveCookieRule", generatedText);
const fixtures = [];

for (const sourceRule of [...canonical.rules, canonical.cookieHeader]) {
  const sample = sourceRule.sampleParts ? sourceRule.sampleParts.join("") : sourceRule.sample;
  const variants = {
    happy: sample,
    "unicode-adjacency": `é${sample}é`,
    "astral-unicode-adjacency": `𐐀${sample}𐐀`,
    "ascii-whitespace": `\t${sample}\r`,
    "non-ascii-whitespace": `\u00A0${sample}\u3000`,
    "ascii-internal-whitespace": sample.replaceAll(" ", "\t"),
    "non-ascii-internal-whitespace": sample.replaceAll(" ", "\u00A0"),
    lowercase: sample.toLowerCase(),
    uppercase: sample.toUpperCase(),
    lf: `prefix\n${sample}\nsuffix`,
    crlf: `prefix\r\n${sample}\r\nsuffix`,
    "near-miss": "ordinary public metadata"
  };
  for (const [variant, text] of Object.entries(variants)) fixtures.push({ id: sourceRule.id, variant, text });
}

const nodeResults = fixtures.map((fixture) => ({ ...fixture, matched: nodeMatches(fixture) }));
for (const result of nodeResults.filter((item) => item.variant === "happy")) {
  if (!result.matched) throw new Error(`Node canonical rule lost its happy path: ${result.id}`);
}
for (const result of nodeResults.filter((item) => item.variant === "near-miss")) {
  if (result.matched) throw new Error(`Node canonical rule accepts its near miss: ${result.id}`);
}

const temporary = mkdtempSync(join(tmpdir(), "neondiff-secret-parity-"));
let swiftResults;
try {
  const executable = join(temporary, "foundation-runner");
  const compile = spawnSync("swiftc", [join(root, "scripts/secret-rule-foundation-runner.swift"), "-o", executable], {
    cwd: root,
    encoding: "utf8"
  });
  if (compile.error?.code === "ENOENT" && !process.argv.includes("--require-swift")) {
    console.log(`secret rule differential skipped: Swift is unavailable; ${fixtures.length} Node cases passed`);
    process.exit(0);
  }
  if (compile.status !== 0) throw new Error(`Foundation parity runner failed to compile:\n${compile.stdout}\n${compile.stderr}`);
  const swift = spawnSync(executable, [], {
    cwd: root,
    input: JSON.stringify({ rules, cookie, fixtures }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (swift.status !== 0) throw new Error(`Foundation parity runner failed:\n${swift.stdout}\n${swift.stderr}`);
  swiftResults = JSON.parse(swift.stdout).results;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const mismatches = nodeResults.flatMap((node, index) => {
  const foundation = swiftResults[index];
  return foundation?.id === node.id && foundation?.variant === node.variant && foundation?.matched === node.matched
    ? []
    : [`${node.id}/${node.variant}: Node=${node.matched} Foundation=${foundation?.matched ?? "missing"}`];
});
if (mismatches.length > 0) throw new Error(`secret rule differential mismatch:\n${mismatches.join("\n")}`);
console.log(`secret rule differential ok: ${fixtures.length} Node/Foundation cases across ${rules.length + 1} rules`);

function parseGenerated(name, text) {
  const marker = `export const ${name}`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing generated ${name}`);
  const equals = text.indexOf("=", start) + 1;
  const end = name === "canonicalSecretRules" ? text.indexOf(";", equals) : text.indexOf(" as const;", equals);
  return JSON.parse(text.slice(equals, end).trim());
}

function nodeMatches(fixture) {
  if (fixture.id === cookie.id) return matchesCookie(fixture.text);
  const rule = rules.find((candidate) => candidate.id === fixture.id);
  if (!rule) return false;
  return new RegExp(rule.source, rule.ignoreCase ? "i" : "").test(fixture.text);
}

function matchesCookie(input) {
  const name = new RegExp(cookie.sensitiveNameSource);
  return input.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    if (trimmed.slice(0, cookie.prefix.length).toLowerCase() !== cookie.prefix) return false;
    const colon = line.indexOf(":");
    if (colon < 0) return false;
    const attributes = line.slice(colon + 1).split(";", cookie.maximumAttributes + 1);
    if (attributes.length > cookie.maximumAttributes) return true;
    return attributes.some((attribute) => {
      const equals = attribute.indexOf("=");
      return equals > 0 && attribute.slice(equals + 1).trim().length > 0 && name.test(attribute.slice(0, equals).trim());
    });
  });
}
