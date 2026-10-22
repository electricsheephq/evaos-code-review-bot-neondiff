import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GitHubApi, isAuthoredBy } from "../src/github.js";
import { collectAnsweredThreads, matchPriorThread, titleWords, wordSetJaccard } from "../src/prior-thread-suppression.js";
import type { Finding, PullReviewComment } from "../src/types.js";

const ownIdentity = { login: "evaos-code-review-bot[bot]", type: "Bot" as const };
const isOwn = (comment: PullReviewComment) => isAuthoredBy(comment.user, ownIdentity);
const root: PullReviewComment = {
  id: 1, path: "src/save.ts", line: 30, original_line: 2,
  user: { login: "evaos-code-review-bot[bot]", type: "Bot" },
  body: "**P2: Retry loses saved records**\n\nRollback overwrites fresh database rows.\n\nCategory: Data loss\n\nWhy this matters: ignored metadata"
};
const reply: PullReviewComment = { id: 2, in_reply_to_id: 1, user: { login: "human", type: "User" } };
const finding: Finding = { severity: "P2", path: "src/save.ts", line: 30, title: "Retry loses saved records",
  body: "Rollback overwrites fresh database rows.", confidence: 0.9 };
const threads = () => collectAnsweredThreads([root, reply], isOwn);

describe("prior thread suppression", () => {
  it("extracts title/body and keeps the current-head line", () => {
    expect(threads()).toEqual([{ id: 1, path: root.path, line: 30, title: finding.title, body: finding.body }]);
  });
  it("requires an own root and a direct human reply, irrespective of reply order", () => {
    expect(collectAnsweredThreads([root], isOwn)).toEqual([]);
    for (const user of [{ login: "other", type: "Bot" }, { login: "other[bot]", type: "User" }]) {
      expect(collectAnsweredThreads([root, { ...reply, user }], isOwn)).toEqual([]);
    }
    expect(collectAnsweredThreads([root, { ...reply, in_reply_to_id: 99 }], isOwn)).toEqual([]);
    expect(collectAnsweredThreads([root, { ...reply, user: null }], isOwn)).toEqual([]);
    expect(collectAnsweredThreads([{ ...root, user: { login: "other[bot]", type: "Bot" } }, reply], isOwn)).toEqual([]);
    expect(collectAnsweredThreads([reply, root], isOwn)).toEqual(threads());
  });
  it("matches own roots by the client's posting identity", async () => {
    const app = await new GitHubApi({}).postingIdentity();
    expect(isAuthoredBy(root.user, app)).toBe(true);
    expect(isAuthoredBy({ ...root.user!, type: "User" }, app)).toBe(false);
  });
  it("ignores outdated or unanchored roots even with original_line", () => {
    for (const line of [null, undefined]) expect(collectAnsweredThreads([{ ...root, line }, reply], isOwn)).toEqual([]);
  });
  it("requires the same path and an inclusive ten-line window", () => {
    expect(matchPriorThread({ ...finding, path: "elsewhere.ts" }, threads())).toBeUndefined();
    for (const delta of [-11, 11]) expect(matchPriorThread({ ...finding, line: 30 + delta }, threads())).toBeUndefined();
    for (const delta of [-10, 10]) expect(matchPriorThread({ ...finding, line: 30 + delta }, threads())?.id).toBe(1);
  });
  it("never matches P0 but matches P1 through P3", () => {
    expect(matchPriorThread({ ...finding, severity: "P0" }, threads())).toBeUndefined();
    for (const severity of ["P1", "P2", "P3"] as const) expect(matchPriorThread({ ...finding, severity }, threads())?.id).toBe(1);
  });
  it("retains a distinct nearby finding and matches by body independently", () => {
    const distinct = { ...finding, line: 33, title: "Null pointer in parser", body: "Empty input crashes decoding." };
    expect(matchPriorThread(distinct, threads())).toBeUndefined();
    expect(matchPriorThread({ ...distinct, body: finding.body }, threads())?.id).toBe(1);
  });
  it("tokenizes case, punctuation, short words and stop words without splitting hyphens/underscores", () => {
    expect([...titleWords("The AND are now for with this that from into when not a v5 Retry-path saved_rows!")])
      .toEqual(["retry-path", "saved_rows"]);
    expect(wordSetJaccard(new Set(), new Set())).toBe(0);
    expect(wordSetJaccard(titleWords("alpha beta"), titleWords("alpha gamma"))).toBeCloseTo(1 / 3);
  });
  it("suppresses the repeated optional-v5-columns finding from the real capture", () => {
    const comments = JSON.parse(readFileSync(new URL("./fixtures/github/lcmx-1752-review-comments.json", import.meta.url), "utf8"));
    const answered = collectAnsweredThreads(comments, isOwn);
    expect(matchPriorThread({ ...finding, path: "scripts/store_wedge_inspect.py", line: 78,
      title: "Optional v5 columns are now treated as mandatory", body: "" }, answered)).toBeDefined();
  });
});
