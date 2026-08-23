#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { planDesktopUpdate } from "./lib/desktop-update-command.mjs";

function fail(message) { throw new Error(message); }
function parse(values) {
  const args = new Map();
  for (let i = 0; i < values.length; i += 2) { const key = values[i], value = values[i + 1]; if (!key?.startsWith("--") || value === undefined || args.has(key)) fail("invalid or duplicate argument"); args.set(key, value); }
  return args;
}
function need(args, key) { const value = args.get(`--${key}`); if (!value) fail(`--${key} is required`); return value; }
function readRegular(path, label) {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`);
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); if (!fstatSync(fd).isFile()) fail(`${label} must be a regular file`); return readFileSync(fd); }
  catch (error) { if (error?.code === "ELOOP") fail(`${label} must not be a symlink`); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function main() {
  const [action, ...values] = process.argv.slice(2), args = parse(values);
  if (!action) fail("usage: desktop-update-command.mjs <update|rollback|reupdate> --index PATH --packet PATH --packet-sha256 SHA --artifact PATH --team-id ID [--dry-run true]");
  if ((args.get("--dry-run") ?? "true") !== "true") fail("live Desktop mutation is not implemented; dry-run must remain true");
  const indexPath = resolve(need(args, "index")), validation = spawnSync(process.execPath, [new URL("./validate-desktop-release-declaration.mjs", import.meta.url).pathname, "--index", indexPath], { encoding: "utf8" });
  if (validation.status !== 0) fail("Desktop declaration index is not accepted");
  const index = JSON.parse(readRegular(indexPath, "declaration index"));
  if (index.status !== "retained" || !index.currentPath || basename(index.currentPath) !== index.currentPath) fail("declaration index has no current release");
  const declarationBytes = readRegular(join(dirname(indexPath), index.declarationDirectory, index.currentPath), "Desktop declaration"), declaration = JSON.parse(declarationBytes);
  const packetBytes = readRegular(resolve(need(args, "packet")), "accepted packet"), packet = JSON.parse(packetBytes), artifactBytes = readRegular(resolve(need(args, "artifact")), "Desktop artifact");
  console.log(JSON.stringify(planDesktopUpdate({ action, declaration, declarationBytes, packet, packetBytes, packetSHA256: need(args, "packet-sha256"), artifactBytes, expectedTeamID: need(args, "team-id") })));
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
