import type { GitHubRelatedIssueOrPull } from "../../src/github-related-context.js";
import type { IssueEnrichmentReader, IssueEnrichmentIssueList } from "../../src/issue-enrichment.js";

// Match GitHub's descending update order and positive-minimum early stop.
export function enrichmentListing(rows: () => GitHubRelatedIssueOrPull[], visited: number[] = []): IssueEnrichmentReader["listIssuesForEnrichment"] {
  return async (_repo, options = {}) => {
    const result: IssueEnrichmentIssueList = [];
    let qualified = 0;
    const ordered = [...rows()].filter((issue) => !options.since || issue.updated_at! >= options.since)
      .sort((a, b) => Date.parse(b.updated_at!) - Date.parse(a.updated_at!));
    for (const issue of ordered) {
      result.push(issue);
      visited.push(issue.number);
      if (options.qualifyForMinimum && await options.qualifyForMinimum(issue)) qualified += 1;
      if (options.qualifyForMinimum && (options.minIssueResults ?? 0) > 0 && qualified >= options.minIssueResults!) {
        return Object.assign(result, { scanCompletion: "stopped_after_min_issue_results" as const });
      }
    }
    return Object.assign(result, { scanCompletion: "complete" as const });
  };
}
