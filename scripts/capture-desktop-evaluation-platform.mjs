#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const flagIndex = process.argv.indexOf("--output");
if (flagIndex < 0 || !process.argv[flagIndex + 1] || process.argv.length !== 4) {
  process.stderr.write("usage: capture-desktop-evaluation-platform.mjs --output <absolute-json-path>\n");
  process.exit(2);
}
const output = resolve(process.argv[flagIndex + 1]);
if (!process.argv[flagIndex + 1].startsWith("/") || !output.endsWith(".json")) {
  throw new Error("platform evidence output must be an absolute JSON path");
}
const parent = lstatSync(dirname(output));
if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("platform evidence parent is unsafe");

let xcodeVersion = "not-installed-command-line-tools";
try {
  xcodeVersion = execFileSync("/usr/bin/xcodebuild", ["-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim().replaceAll("\n", "; ");
} catch {}

const evidence = {
  schemaVersion: 1,
  macOSVersion: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  xcodeVersion,
  swiftVersion: execFileSync("/usr/bin/swift", ["--version"], { encoding: "utf8" }).split("\n")[0].trim(),
  architecture: execFileSync("/usr/bin/uname", ["-m"], { encoding: "utf8" }).trim()
};
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
