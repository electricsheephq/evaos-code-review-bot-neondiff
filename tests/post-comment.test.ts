import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENRICHMENT_MARKER_PREFIX } from "../src/enrichment.js";
import { DEFAULT_BOT_LOGIN, GitHubApi } from "../src/github.js";
import { buildWalkthroughMarker } from "../src/walkthrough.js";
import { REVIEW_ATTRIBUTION_PREFIX } from "../src/walkthrough-post.js";

const roots: string[] = [];
const body = "The follow-up shipped. Thanks!";
const repo = "owner/repo";
const privateProfileNote = "Verify the internal mobile signing checklist before merging release branches.";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps an operator comment separate from a walkthrough create and update", async () => {
  const target = { repo, issueNumber: 42 };
  const marker = buildWalkthroughMarker({ repo, pullNumber: target.issueNumber });
  const user = { login: DEFAULT_BOT_LOGIN, type: "Bot" };
  const operatorComment = { id: 12, body: `${body}\n\n<!-- neondiff-operator-comment:fixture -->`, user };
  const comments = [operatorComment];
  const updates: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(input);
    if (pathname === "/user") return Response.json(user);
    if (init?.method === "POST") {
      const created = { id: 13, body: JSON.parse(String(init.body)).body, user };
      comments.push(created);
      return Response.json(created);
    }
    if (init?.method === "PATCH") {
      updates.push(pathname);
      return Response.json({ id: 13 });
    }
    return Response.json(comments);
  });
  const github = new GitHubApi({ token: "fixture", botLogin: user.login });
  const upsert = () => github.upsertIssueComment({ ...target, marker, body: marker });
  expect(await upsert()).toMatchObject({ action: "created", id: 13 });
  expect(await upsert()).toMatchObject({ action: "updated", id: 13 });
  expect(updates).toEqual(["/repos/owner/repo/issues/comments/13"]);
  expect(comments[0]).toEqual(operatorComment);
});

function fixture(contents: string | Buffer = body) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-post-comment-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.sqlite");
  const bodyPath = join(root, "body.md");
  writeFileSync(configPath, JSON.stringify({ statePath, pilotRepos: [repo, "owner/disabled"],
    repoProfiles: { repos: { [repo]: { promptNote: privateProfileNote }, "owner/disabled": { enabled: false } } }
  }));
  writeFileSync(bodyPath, contents);
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "post-comment", "--config", configPath, ...args],
    { encoding: "utf8", timeout: 10_000 });
  return { statePath, run, post: (options: { repo?: string; number?: string; flags?: string[] } = {}) =>
    run("--repo", options.repo ?? repo, "--number", options.number ?? "42", "--body-file", bodyPath, ...(options.flags ?? [])) };
}

describe("post-comment CLI", () => {
  it("previews a safe body without creating state or emitting the body", () => {
    const { statePath, post } = fixture();
    const result = post();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      repo, number: 42, bodyLength: body.length, bodySha256: createHash("sha256").update(body).digest("hex"),
      safetyCheck: "passed", existing: null
    });
    expect(result.stdout).not.toContain(body);
    expect(existsSync(statePath)).toBe(false);
  });

  it("requires live confirmation and returns the same pending request for a case-insensitive rerun", () => {
    const { post, run, statePath } = fixture();
    const unconfirmed = post({ flags: ["--dry-run", "false"] });
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toMatch(/requires --confirm true/);
    expect(existsSync(statePath)).toBe(false);

    const flags = ["--dry-run", "false", "--confirm", "true"];
    const queued = post({ flags });
    expect(queued.status, queued.stderr).toBe(0);
    const request = JSON.parse(queued.stdout);
    expect(request).toMatchObject({ id: expect.any(String), status: "pending" });
    expect(JSON.parse(post({ repo: "Owner/Repo", flags }).stdout)).toMatchObject(request);
    expect(JSON.parse(post().stdout).existing).toMatchObject(request);
    for (const selector of [[], ["--id", request.id], ["--repo", "OWNER/REPO", "--number", "42"]]) {
      const status = run("--status", ...selector);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual([expect.objectContaining(request)]);
      expect(status.stdout).not.toContain(body);
    }
  }, 15_000);

  it.each([
    ["secret-like body", ["ghp", "x".repeat(36)].join("_"), /secret-like/],
    ["public-output leak", "These are our validation hints.", /public_review_config_leak_rejected/],
    ["private profile fragment", privateProfileNote, /public_review_config_leak_rejected/],
    ["walkthrough marker", "<!-- evaos-code-review-bot:walkthrough", /marker or attribution/],
    ["LCM marker", "<!-- lcm-x-ai-review:v2", /marker or attribution/],
    ["enrichment marker", ENRICHMENT_MARKER_PREFIX, /marker or attribution/],
    ["NeonDiff marker", "<!-- neondiff-operator-comment:other -->", /marker or attribution/],
    ["attribution", REVIEW_ATTRIBUTION_PREFIX, /marker or attribution/],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]), /UTF-8/],
    ["empty body", " \n", /non-empty/],
    ["oversized body", "x".repeat(60_001), /60,000/]
  ])("refuses %s", (_description, contents, expectedError) => {
    const { statePath, post } = fixture(contents);
    const result = post({ flags: ["--dry-run", "false", "--confirm", "true"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expectedError);
    expect(existsSync(statePath)).toBe(false);
  });

  it.each(["owner/unknown", "owner/disabled"])("refuses unenrolled or disabled repo %s", (target) => {
    const result = fixture().post({ repo: target });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/configured repos|repo policy/);
  });

  it.each(["0", "1.5", "9007199254740992"])("refuses invalid issue number %s", (number) => {
    const result = fixture().post({ number });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/positive integer/);
  });
});
