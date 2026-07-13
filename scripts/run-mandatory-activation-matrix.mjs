#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { runMandatoryActivationMatrix } from "../dist/src/mandatory-activation-matrix.js";

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
  process.stderr.write("usage: run-mandatory-activation-matrix.mjs --output <path>\n");
  process.exit(1);
}
const result = await runMandatoryActivationMatrix();
if (!result.ok || result.bypassAllowedCases !== 0) {
  process.stderr.write("mandatory activation matrix found a bypass\n");
  process.exit(1);
}
writeFileSync(argv[1], `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
process.stdout.write(`${JSON.stringify({ ok: true, scenarios: result.records.length, output: argv[1] })}\n`);
