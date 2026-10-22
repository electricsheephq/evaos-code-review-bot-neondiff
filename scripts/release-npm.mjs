import { appendFileSync, readFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLeanReleaseVersion } from "../src/release-version.ts";
import { hasDesktopOnlyTagAnnotation } from "./lib/desktop-only-release-policy.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function verifyLeanPack(packPath, tarballPath, version) {
  const packs = json(packPath);
  ensure(packs.length === 1, "expected exactly one packed package");
  const [pack] = packs;
  ensure(isLeanReleaseVersion(version) && pack.name === "neondiff" && pack.version === version.replace(/^v/, ""), "packed release identity mismatch");
  const bytes = readFileSync(tarballPath);
  ensure(createHash("sha1").update(bytes).digest("hex") === pack.shasum, "packed shasum mismatch");
  ensure(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === pack.integrity, "packed integrity mismatch");
  return pack;
}

export function classifyLeanRelease(tag, release, annotation) {
  return /^v\d+\.\d+\.\d+$/.test(tag) && isLeanReleaseVersion(tag) &&
    release.tag_name === tag && release.draft === false && release.prerelease === false &&
    !hasDesktopOnlyTagAnnotation(tag, annotation);
}

function npm(args, options = {}) {
  const result = spawnSync("npm", [...args, "--fetch-retries=0", "--fetch-timeout=25000"], {
    encoding: "utf8", timeout: 120_000, ...options
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  return result;
}

// The dry-run supplies a registry fixture to this same sequence; it never invokes npm.
export async function publishLeanRelease(pack, tarball, run = npm, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now) {
  const scalar = (result) => {
    if (result.status !== 0) return undefined;
    try { return JSON.parse(result.stdout); } catch { return result.stdout.trim(); }
  };
  const required = (args, options) => {
    const result = run(args, options);
    ensure(result.status === 0, `npm ${args.slice(0, 2).join(" ")} failed`);
    return result;
  };
  const poll = async (args, expected) => {
    const deadline = now() + 15 * 60_000;
    let delay = 10_000;
    while (now() < deadline) {
      const observed = scalar(run(args, { timeout: Math.min(30_000, deadline - now()) }));
      if (observed === expected) return;
      console.error(`npm read-back has not converged: expected ${expected}, observed ${observed ?? "unavailable"}`);
      await wait(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(delay * 2, 60_000);
    }
    throw new Error(`npm read-back timed out for ${args.join(" ")}`);
  };
  const identity = `neondiff@${pack.version}`;
  const existing = run(["view", identity, "dist.shasum", "--json", "--prefer-online"]);
  if (existing.status === 0) {
    ensure(scalar(existing) === pack.shasum, "existing npm shasum differs from packed shasum");
  } else {
    ensure(/E404/.test(`${existing.stdout}\n${existing.stderr}`), "npm existence lookup failed; refusing to publish");
    required(["publish", resolve(tarball), "--provenance", "--access", "public", "--tag", "next"]);
  }
  await poll(["view", identity, "dist.shasum", "--json", "--prefer-online"], pack.shasum);
  const provenanceUrl = scalar(required(["view", identity, "dist.attestations.url", "--json", "--prefer-online"]));
  ensure(provenanceUrl === `https://registry.npmjs.org/-/npm/v1/attestations/${identity}`, "missing npm provenance URL");
  const cwd = mkdtempSync(join(tmpdir(), "neondiff-signatures-"));
  required(["init", "-y"], { cwd });
  // --prefer-online: the abbreviated packument install reads can lag the full one the read-back polled.
  required(["install", identity, "--ignore-scripts", "--prefer-online"], { cwd });
  const audit = JSON.parse(required(["audit", "signatures", "--json", "--include-attestations"], { cwd }).stdout);
  ensure(Array.isArray(audit.invalid) && audit.invalid.length === 0 && Array.isArray(audit.missing) && audit.missing.length === 0 &&
    audit.verified?.some((item) => item.name === "neondiff" && item.version === pack.version && item.attestations), "neondiff signature/attestation was not verified");
  required(["dist-tag", "add", identity, "latest"]);
  await poll(["view", "neondiff", "dist-tags.latest", "--json", "--prefer-online"], pack.version);
  const cleanup = run(["dist-tag", "rm", "neondiff", "next"]);
  if (cleanup.status !== 0) console.error("next cleanup failed; latest was verified (best effort)");
  const tags = JSON.parse(required(["view", "neondiff", "dist-tags", "--json", "--prefer-online"]).stdout);
  const summary = `Version: ${pack.version}\nShasum: ${pack.shasum}\nIntegrity: ${pack.integrity}\nProvenance: ${provenanceUrl}\nDist-tags: ${JSON.stringify(tags)}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

async function main() {
  const [mode, packPath, tarball] = process.argv.slice(2);
  const tag = process.env.RELEASE_TAG;
  if (mode === "classify") {
    const event = json(process.env.GITHUB_EVENT_PATH);
    const release = process.env.GITHUB_EVENT_NAME === "release" ? event.release : JSON.parse(execFileSync("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`], { encoding: "utf8", timeout: 30_000 }));
    let annotation = "";
    if (git("cat-file", "-t", tag) === "tag") annotation = execFileSync("git", ["cat-file", "tag", tag], { encoding: "utf8" }).split("\n\n").slice(1).join("\n\n");
    const eligible = classifyLeanRelease(tag, release, annotation);
    output("publish", eligible);
    if (!eligible) { console.log("::notice::Not a stable lean npm release; skipping"); return; }
    ensure(json("package.json").version === tag.slice(1), "package version does not match tag");
    const sha = git("rev-parse", "HEAD");
    git("merge-base", "--is-ancestor", sha, "origin/main");
    output("sha", sha);
    return;
  }
  if (mode === "ci") {
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${process.env.GITHUB_REPOSITORY}/commits/${git("rev-parse", "HEAD")}/check-runs?per_page=100`], { encoding: "utf8", timeout: 120_000 }));
    const checks = pages.flatMap((page) => page.check_runs);
    for (const name of ["Build, test, and package", "Swift desktop gate"]) {
      const latest = checks.filter((check) => check.name === name && check.app?.slug === "github-actions").sort((a, b) => b.id - a.id)[0];
      ensure(latest?.conclusion === "success", `required CI check is not successful: ${name}`);
    }
    return;
  }
  const pack = verifyLeanPack(packPath, tarball, tag);
  if (mode === "dry-run") {
    let clock = 0;
    const fixture = (args) => {
      console.log(`dry-run: npm ${args.join(" ")}`);
      let value;
      if (args[0] === "view") value = args[2] === "dist.shasum" ? pack.shasum : args[2] === "dist-tags.latest" ? pack.version : args[2] === "dist-tags" ? { latest: pack.version } : `https://registry.npmjs.org/-/npm/v1/attestations/neondiff@${pack.version}`;
      if (args[0] === "audit") value = { invalid: [], missing: [], verified: [{ name: "neondiff", version: pack.version, attestations: {} }] };
      return { status: 0, stdout: JSON.stringify(value ?? {}), stderr: "" };
    };
    await publishLeanRelease(pack, tarball, fixture, async (ms) => { clock += ms; }, () => clock);
  } else {
    ensure(mode === "publish", "expected classify, ci, dry-run or publish mode");
    await publishLeanRelease(pack, tarball);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
