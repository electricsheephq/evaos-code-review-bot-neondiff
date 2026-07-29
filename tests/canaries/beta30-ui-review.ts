/**
 * Disposable beta.30 installed-app UI review canary.
 *
 * This branch must not merge. The unchecked lookup below is deliberate so the
 * signed/notarized NeonDiff candidate has one bounded defect to find when the
 * dry and live review sequence is initiated from the native app.
 * Beta 36 refreshes this disposable head without changing the canary defect.
 */
export function selectedRepository(
  repositories: Map<string, string>,
  repositoryId: string,
): string {
  // Deliberate canary: reject an unknown repository before dereferencing it.
  return repositories.get(repositoryId)!.trim();
}
