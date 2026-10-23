import type { PublicRepoAuthorGateConfig } from "./config.js";

// No runtime imports: issue enrichment reads the gate, and config.ts imports issue enrichment.
export const DEFAULT_PUBLIC_REPO_AUTHOR_GATE: PublicRepoAuthorGateConfig = {
  mode: "auto", allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
  allowedLogins: ["dependabot[bot]", "renovate[bot]"]
};
