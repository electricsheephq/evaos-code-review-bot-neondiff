#!/usr/bin/env node
import { resolve } from "node:path";
import { planAcceptedDesktopTransition } from "./lib/desktop-update-command.mjs";

const KEYS = ["index", "packet", "packet-sha256", "artifact", "feed", "target", "target-sha256"];
function fail(message) { throw new Error(message); }
function input() {
  const [action, ...values] = process.argv.slice(2), args = new Map(); if (values.length !== KEYS.length * 2) fail("usage: desktop-update-command.mjs <update|rollback|reupdate> --index PATH --packet PATH --packet-sha256 SHA --artifact PATH --feed PATH --target PATH --target-sha256 SHA");
  for (let index = 0; index < values.length; index += 2) { const key = values[index]?.replace(/^--/, ""), value = values[index + 1]; if (!KEYS.includes(key) || !value || args.has(key)) fail("transition arguments are invalid or duplicated"); args.set(key, value); }
  return { action, indexPath: resolve(args.get("index")), packetPath: resolve(args.get("packet")), packetSHA256: args.get("packet-sha256"), artifactPath: resolve(args.get("artifact")), feedPath: resolve(args.get("feed")), targetPath: resolve(args.get("target")), targetSHA256: args.get("target-sha256") };
}
try { console.log(JSON.stringify(await planAcceptedDesktopTransition(input()))); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
