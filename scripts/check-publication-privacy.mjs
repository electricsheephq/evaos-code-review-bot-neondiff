import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const encodedBlocklist = process.env.PUBLICATION_PRIVACY_BLOCKLIST_B64?.trim();

if (!encodedBlocklist) {
  console.error("privacy audit blocked: PUBLICATION_PRIVACY_BLOCKLIST_B64 is not configured");
  process.exit(2);
}

const blockedTerms = Buffer.from(encodedBlocklist, "base64")
  .toString("utf8")
  .split(/\r?\n/u)
  .map((term) => term.trim().toLocaleLowerCase("en-US"))
  .filter(Boolean);

if (blockedTerms.length === 0) {
  console.error("privacy audit blocked: the decoded blocklist is empty");
  process.exit(2);
}

const findings = [];
let scannedItems = 0;

function scan(label, value) {
  if (typeof value !== "string" || value.length === 0) return;
  scannedItems += 1;
  const normalized = value.toLocaleLowerCase("en-US");
  let count = 0;

  for (const term of blockedTerms) {
    let offset = 0;
    while ((offset = normalized.indexOf(term, offset)) !== -1) {
      count += 1;
      offset += term.length;
    }
  }

  if (count > 0) findings.push({ label, count });
}

const ignoredDirectories = new Set([".build", ".git", ".swiftpm", "coverage", "dist", "node_modules"]);

function scanDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(path);
      continue;
    }
    if (!entry.isFile() || statSync(path).size > 5_000_000) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    scan(`source:${relative(root, path)}`, bytes.toString("utf8"));
  }
}

scanDirectory(root);

const token = process.env.GITHUB_TOKEN?.trim();
const repository = process.env.GITHUB_REPOSITORY?.trim();

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub privacy audit read failed (${response.status}) for ${path}`);
  return response.json();
}

async function paginated(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await github(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

if (token && repository) {
  const repo = await github(`/repos/${repository}`);
  scan("repository:name", repo.name);
  scan("repository:description", repo.description);
  scan("repository:homepage", repo.homepage);

  const [issues, issueComments, pulls, reviewComments, releases] = await Promise.all([
    paginated(`/repos/${repository}/issues?state=all`),
    paginated(`/repos/${repository}/issues/comments`),
    paginated(`/repos/${repository}/pulls?state=all`),
    paginated(`/repos/${repository}/pulls/comments`),
    paginated(`/repos/${repository}/releases`)
  ]);

  for (const issue of issues) {
    scan(`issue:${issue.number}:title`, issue.title);
    scan(`issue:${issue.number}:body`, issue.body);
  }
  for (const comment of issueComments) scan(`issue-comment:${comment.id}`, comment.body);
  for (const pull of pulls) {
    scan(`pull:${pull.number}:title`, pull.title);
    scan(`pull:${pull.number}:body`, pull.body);
  }
  for (const comment of reviewComments) scan(`review-comment:${comment.id}`, comment.body);
  for (const release of releases) {
    scan(`release:${release.id}:name`, release.name);
    scan(`release:${release.id}:tag`, release.tag_name);
    scan(`release:${release.id}:body`, release.body);
  }
} else if (token || repository) {
  console.error("privacy audit blocked: GITHUB_TOKEN and GITHUB_REPOSITORY must be provided together");
  process.exit(2);
}

console.log(JSON.stringify({ scannedItems, findingItems: findings.length, findings }));
if (findings.length > 0) process.exit(1);
