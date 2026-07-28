/**
 * Disposable beta.30 installed-app review canary.
 *
 * This branch must not merge. The unchecked lookup below is deliberate so the
 * signed/notarized NeonDiff candidate has one bounded defect to find during the
 * dry-review and exact-head live-review proof.
 */
export function selectedRepository(
  repositories: Map<string, string>,
  repositoryId: string,
): string {
  // Deliberate canary: reject an unknown repository before dereferencing it.
  return repositories.get(repositoryId)!.trim();
}
