import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const swiftTestCorpus = join(
  root,
  "apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/Support/CanonicalSecretRuleCorpus.generated.swift"
);
const retiredSwiftCorpus = join(
  root,
  "apps/neondiff-desktop/Sources",
  ["NeonDiffDesktopCore", "Checks"].join(""),
  "CanonicalSecretRuleCorpus.generated.swift"
);
if (!existsSync(swiftTestCorpus)) {
  throw new Error("generated Swift test corpus is missing from the compiled Core test target");
}
if (existsSync(retiredSwiftCorpus)) {
  throw new Error("generated Swift test corpus still has an orphan copy under Sources");
}
const canonical = JSON.parse(readFileSync(join(root, "shared/canonical-secret-rules.json"), "utf8"));
const productionNodeScanner = join(root, "dist/src/secrets.js");
if (!existsSync(productionNodeScanner)) {
  throw new Error("production Node scanner is missing; run npm run build before the differential check");
}
const { containsSecretLikeText } = await import(pathToFileURL(productionNodeScanner).href);
const fixtures = [];

for (const sourceRule of [...canonical.rules, canonical.cookieHeader]) {
  const sample = sourceRule.sampleParts ? sourceRule.sampleParts.join("") : sourceRule.sample;
  const caseInsensitive = sourceRule.id === canonical.cookieHeader.id || sourceRule.ignoreCase === true;
  const variants = [
    { variant: "happy", text: sample, expected: true },
    {
      variant: "unicode-adjacency",
      text: `é${sample}é`,
      expected: sourceRule.id !== canonical.cookieHeader.id
    },
    {
      variant: "astral-unicode-adjacency",
      text: `𐐀${sample}𐐀`,
      expected: sourceRule.id !== canonical.cookieHeader.id
    },
    { variant: "ascii-whitespace", text: `\t${sample}\r`, expected: true },
    { variant: "non-ascii-whitespace", text: `\u00A0${sample}\u3000`, expected: true },
    {
      variant: "lowercase",
      text: sample.toLowerCase(),
      expected: caseInsensitive || sample.toLowerCase() === sample
    },
    {
      variant: "uppercase",
      text: sample.toUpperCase(),
      expected: caseInsensitive
        || sample.toUpperCase() === sample
        || ["complete-private-key", "truncated-private-key"].includes(sourceRule.id)
    },
    { variant: "lf", text: `prefix\n${sample}\nsuffix`, expected: true },
    { variant: "crlf", text: `prefix\r\n${sample}\r\nsuffix`, expected: true },
    { variant: "near-miss", text: "ordinary public metadata", expected: false }
  ];
  fixtures.push(...variants.map((variant) => ({ id: sourceRule.id, ...variant })));
}

fixtures.push(
  {
    id: "safe-literal",
    variant: "standalone-reference",
    text: "Set NEONDIFF_PROVIDER_API_KEY before running verification.",
    expected: false
  },
  {
    id: "safe-literal",
    variant: "assignment",
    text: "NEONDIFF_PROVIDER_API_KEY=abcdefghijklmnop",
    expected: true
  },
  {
    id: "safe-literal",
    variant: "json-assignment",
    text: "\"NEONDIFF_PROVIDER_API_KEY\": \"abcdefghijklmnop\"",
    expected: true
  }
);

const nodeResults = fixtures.map((fixture) => ({
  id: fixture.id,
  variant: fixture.variant,
  expected: fixture.expected,
  matched: containsSecretLikeText(fixture.text)
}));

const temporary = mkdtempSync(join(tmpdir(), "neondiff-secret-parity-"));
let swiftResults;
try {
  const executable = join(temporary, "foundation-runner");
  const compile = spawnSync("swiftc", [
    join(root, "apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/CanonicalSecretRules.generated.swift"),
    join(root, "apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/CanonicalSecretScanner.swift"),
    join(root, "scripts/secret-rule-foundation-runner.swift"),
    "-o",
    executable
  ], {
    cwd: root,
    encoding: "utf8"
  });
  if (compile.error?.code === "ENOENT" && !process.argv.includes("--require-swift")) {
    assertExpected("Node", nodeResults);
    console.log(`secret rule differential skipped: Swift is unavailable; ${fixtures.length} production Node cases passed`);
    process.exit(0);
  }
  if (compile.status !== 0) throw new Error(`production Foundation scanner failed to compile:\n${compile.stdout}\n${compile.stderr}`);
  const swift = spawnSync(executable, [], {
    cwd: root,
    input: JSON.stringify({ fixtures }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (swift.status !== 0) throw new Error(`production Foundation scanner failed:\n${swift.stdout}\n${swift.stderr}`);
  swiftResults = JSON.parse(swift.stdout).results;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

assertExpected("Node", nodeResults);
assertExpected("Foundation", swiftResults);
const mismatches = nodeResults.flatMap((node, index) => {
  const foundation = swiftResults[index];
  return foundation?.id === node.id
      && foundation?.variant === node.variant
      && foundation?.expected === node.expected
      && foundation?.matched === node.matched
    ? []
    : [`${node.id}/${node.variant}: expected=${node.expected} Node=${node.matched} Foundation=${foundation?.matched ?? "missing"}`];
});
if (mismatches.length > 0) throw new Error(`secret rule differential mismatch:\n${mismatches.join("\n")}`);
console.log(`secret rule differential ok: ${fixtures.length} expected production Node/Foundation cases across ${canonical.rules.length + 1} rules`);

function assertExpected(engine, results) {
  const failures = results
    .filter((result) => result.matched !== result.expected)
    .map((result) => `${result.id}/${result.variant}: expected=${result.expected} matched=${result.matched}`);
  if (failures.length > 0) {
    throw new Error(`${engine} production scanner violated expected outcomes:\n${failures.join("\n")}`);
  }
}
