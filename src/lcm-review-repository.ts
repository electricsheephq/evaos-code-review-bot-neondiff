export const LCM_REVIEW_REPOSITORY = "electricsheephq/lcm-x";

export function isLcmReviewRepository(repo: string): boolean {
  return repo.toLowerCase() === LCM_REVIEW_REPOSITORY;
}
