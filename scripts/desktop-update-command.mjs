#!/usr/bin/env node

import { resolve } from "node:path";
import { planAcceptedDesktopTransition } from "./lib/desktop-update-command.mjs";

const KEYS = ["target-artifact", "evidence-packet", "target-packet", "target-bundle", "target-release", "target-tag-ref", "target-feed", "target-receipt", "current-packet"];
const fail = (message) => { throw new Error(message); };
function parse(values) {
  if (values.length !== 1 + KEYS.length * 2 || !["update", "rollback", "reupdate"].includes(values[0])) fail("transition arguments are invalid or duplicated"); const action = values[0], options = new Map();
  for (let index = 1; index < values.length; index += 2) { const option = values[index], key = option?.startsWith("--") ? option.slice(2) : "", value = values[index + 1]; if (!KEYS.includes(key) || !value || options.has(key)) fail("transition arguments are invalid or duplicated"); options.set(key, resolve(value)); }
  return { action, targetArtifactPath: options.get("target-artifact"), evidencePacketPath: options.get("evidence-packet"), targetPacketPath: options.get("target-packet"), targetBundlePath: options.get("target-bundle"), targetReleasePath: options.get("target-release"), targetTagRefPath: options.get("target-tag-ref"), targetFeedPath: options.get("target-feed"), targetReceiptPath: options.get("target-receipt"), currentPacketPath: options.get("current-packet") };
}

try { process.stdout.write(`${JSON.stringify(await planAcceptedDesktopTransition(parse(process.argv.slice(2))))}\n`); }
catch { process.stderr.write("accepted Desktop transition preflight failed\n"); process.exitCode = 1; }
