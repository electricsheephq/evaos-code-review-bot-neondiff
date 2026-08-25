#!/usr/bin/env node

import { planAcceptedDesktopTransition } from "./lib/desktop-update-command.mjs";

const KEYS = ["accepted-artifact", "accepted-packet", "accepted-bundle", "accepted-release", "accepted-tag-ref", "target-artifact", "target-packet", "target-evidence-packet", "target-bundle", "target-release", "target-tag-ref", "target-feed", "target-receipt"];
const fail = (message) => { throw new Error(message); };
function parse(values) {
  if (values.length !== 1 + KEYS.length * 2) fail("transition arguments are invalid or duplicated"); const action = values[0], options = new Map();
  for (let index = 1; index < values.length; index += 2) { const option = values[index], key = option?.startsWith("--") ? option.slice(2) : "", value = values[index + 1]; if (!KEYS.includes(key) || !value || options.has(key)) fail("transition arguments are invalid or duplicated"); options.set(key, value); }
  return { action, acceptedArtifactPath: options.get("accepted-artifact"), acceptedPacketPath: options.get("accepted-packet"), acceptedBundlePath: options.get("accepted-bundle"), acceptedReleasePath: options.get("accepted-release"), acceptedTagRefPath: options.get("accepted-tag-ref"), targetArtifactPath: options.get("target-artifact"), targetPacketPath: options.get("target-packet"), targetEvidencePacketPath: options.get("target-evidence-packet"), targetBundlePath: options.get("target-bundle"), targetReleasePath: options.get("target-release"), targetTagRefPath: options.get("target-tag-ref"), targetFeedPath: options.get("target-feed"), targetReceiptPath: options.get("target-receipt") };
}

try { process.stdout.write(`${JSON.stringify(await planAcceptedDesktopTransition(parse(process.argv.slice(2))))}\n`); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
