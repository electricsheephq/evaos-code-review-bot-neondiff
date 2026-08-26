import type { IssueEnrichmentConfig, IssueEnrichmentRepoOverride } from "./issue-enrichment.js";

export interface CanonicalIssueEnrichmentRepository {
  key: string;
  repo: string;
  override?: IssueEnrichmentRepoOverride;
}

export function canonicalIssueEnrichmentRepositories(
  config: IssueEnrichmentConfig,
  repositories: readonly string[] = config.allowlist
): CanonicalIssueEnrichmentRepository[] {
  const group = (values: readonly string[]): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const repo of values) {
      const key = repo.toLowerCase();
      const aliases = groups.get(key);
      if (aliases) aliases.push(repo);
      else groups.set(key, [repo]);
    }
    return groups;
  };
  const configured = group(config.allowlist);
  return [...group(repositories)].map(([key, requestedAliases]) => {
    const aliases = configured.get(key) ?? requestedAliases;
    const repo = [...aliases].sort()[0]!;
    const exact = config.repos?.[repo];
    const fallback = Object.entries(config.repos ?? {})
      .filter(([candidate]) => candidate.toLowerCase() === key)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0]?.[1];
    return { key, repo, ...(exact ?? fallback ? { override: exact ?? fallback } : {}) };
  });
}

export function canonicalIssueEnrichmentRepository(
  config: IssueEnrichmentConfig,
  repo: string
): CanonicalIssueEnrichmentRepository {
  return canonicalIssueEnrichmentRepositories(config, [repo])[0]!;
}
