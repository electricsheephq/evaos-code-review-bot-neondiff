import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { binarySecretScanExtension, scanSecretText } from "./shared/secret-patterns.mjs";

const json = process.argv.includes("--json");
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const findings = [];

for (const file of files) {
  if (binarySecretScanExtension.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  findings.push(...scanSecretText(file, text));
}

const envTracked = files.filter((file) => /(^|\/)\.env(?:\.|$)/.test(file));
const sensitiveTracked = files.filter((file) => /\.(?:pem|key|sqlite|db)$/.test(file));
const result = {
  ok: findings.length === 0 && envTracked.length === 0 && sensitiveTracked.length === 0,
  findings,
  envTracked,
  sensitiveTracked,
  scannedFiles: files.length
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(`secret scan ok: ${files.length} tracked files`);
} else {
  console.error(JSON.stringify(result, null, 2));
}

if (!result.ok) process.exit(1);
