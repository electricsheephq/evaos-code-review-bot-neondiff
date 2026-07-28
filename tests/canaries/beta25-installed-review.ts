/**
 * Disposable paid-beta review canary.
 *
 * This branch is not intended to merge. The missing empty-list guard below is
 * deliberate so the installed NeonDiff worker has one bounded defect to find.
 */
export function firstRepositoryName(repositories: string[]): string {
  // Deliberate canary: an empty list must be rejected before this dereference.
  return repositories[0].trim();
}
