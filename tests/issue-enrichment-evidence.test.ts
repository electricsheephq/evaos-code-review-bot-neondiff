import { describe, expect, it } from "vitest";
import { ENRICHMENT_MARKER_PREFIX } from "../src/enrichment.js";
import {
  buildIssueEvidenceContext,
  type IssueEnrichmentCycleGithub
} from "../src/issue-enrichment.js";
import type { GitHubRelatedIssueOrPull } from "../src/github-related-context.js";
import type { BoundedGithubList } from "../src/github.js";

const issue: GitHubRelatedIssueOrPull = {
  number: 853,
  title: "Preserve issue evidence completeness",
  state: "open",
  updated_at: "2026-08-23T00:00:00Z",
  body: "Acceptance criteria are recorded."
};

function comment(id: number, body: string) {
  return {
    id,
    body,
    html_url: `https://github.test/issues/853#issuecomment-${id}`,
    user: { login: id === 1 ? "evaos-code-review-bot[bot]" : `author-${id}` }
  };
}

function boundedComments(
  comments: ReturnType<typeof comment>[],
  rawCount: number,
  truncated: boolean
): BoundedGithubList<ReturnType<typeof comment>> {
  return Object.assign(comments, {
    items: comments.slice(),
    rawCount,
    truncated,
    overflow: truncated
  });
}

async function buildEvidence(comments: ReturnType<typeof boundedComments>) {
  const github = {
    listIssueComments: async () => comments
  } as unknown as IssueEnrichmentCycleGithub;
  return buildIssueEvidenceContext({
    repo: "owner/issue-repo",
    issue,
    github,
    defaultBranch: "main",
    headSha: "a".repeat(40)
  });
}

describe("issue-enrichment evidence completeness", () => {
  it("preserves bounded-reader truncation after filtering enrichment comments", async () => {
    const comments = boundedComments(
      [
        comment(1, `${ENRICHMENT_MARKER_PREFIX} generated comment`),
        ...Array.from({ length: 49 }, (_unused, index) => comment(index + 2, `human comment ${index + 1}`))
      ],
      500,
      true
    );

    const evidence = await buildEvidence(comments);

    expect(evidence.comments).toHaveLength(49);
    expect(evidence.truncation.comments).toBe(true);
  });

  it("keeps a fully read bounded comment list complete when filtering stays below the cap", async () => {
    const comments = boundedComments(
      [
        comment(1, `${ENRICHMENT_MARKER_PREFIX} generated comment`),
        ...Array.from({ length: 49 }, (_unused, index) => comment(index + 2, `human comment ${index + 1}`))
      ],
      50,
      false
    );

    const evidence = await buildEvidence(comments);

    expect(evidence.comments).toHaveLength(49);
    expect(evidence.truncation.comments).toBe(false);
  });
});
