import type { ProductionLicenseOperation } from "./license-admission.js";

export type CommandLicensePolicy =
  | { mode: "setup_safe" }
  | { mode: "requires_license"; operation: ProductionLicenseOperation };

const setupSafeCommands = new Set([
  "init",
  "config",
  "pricing",
  "license",
  "dashboard",
  "status",
  "runtime-inventory",
  "agents",
  "queue",
  "budget-status",
  "cooldowns",
  "why",
  "release-status",
  "review-head-gate",
  "provider-cooldowns",
  "provider-throttle-report",
  "gitnexus-refresh-preflight",
  "eval-offline",
  "eval-suite",
  "eval-sticky-vs-cold",
  "eval-repo-wiki-context-ab",
  "eval-openwiki-docs-drift",
  "review-lenses-eval",
  "outcome-ledger",
  "outcome-scorecard",
  "outcome-observe",
  "calibration-aggregate",
  "calibration-promote",
  "badge",
  "checkout-issuance-smoke",
  "doctor",
  "retire-failed"
]);

export function classifyCommandLicensePolicy(input: {
  command: string;
  subcommand?: string;
  smoke?: boolean;
  dryRun?: boolean;
  coverageBacked?: boolean;
}): CommandLicensePolicy {
  if (input.coverageBacked === true) {
    return { mode: "requires_license", operation: "review_discovery" };
  }
  if (input.command === "providers") {
    if (input.subcommand === "verify") return { mode: "requires_license", operation: "provider_verify" };
    if (input.subcommand === "doctor" && input.smoke === true) {
      return { mode: "requires_license", operation: "provider_smoke" };
    }
    if (input.subcommand === "list" || input.subcommand === "doctor") return { mode: "setup_safe" };
  }
  if (input.command === "review-bench" && (
    input.subcommand === "verify-sources" ||
    input.subcommand === "prepare-adjudication" ||
    input.subcommand === "verify-adjudication" ||
    input.subcommand === "verify-advisory-adjudication"
  )) {
    return { mode: "setup_safe" };
  }
  if (input.command === "daemon") {
    if (input.subcommand === "stop" || input.subcommand === "status") return { mode: "setup_safe" };
    if (input.subcommand === "start" && input.dryRun === true) return { mode: "setup_safe" };
    return { mode: "requires_license", operation: "daemon_cycle" };
  }
  if (input.command === "issue-enrichment-run" || input.command === "issue-enrichment-scan") {
    return { mode: "requires_license", operation: "issue_enrichment" };
  }
  if (input.command === "review-pr"
    || input.command === "run-once"
    || input.command === "retry-failed"
    || input.command === "retry-provider-cooldowns"
    || input.command === "finishing-touch-dry-run"
    || input.command === "build-enrichment-comment") {
    return { mode: "requires_license", operation: "review_cycle" };
  }
  if (setupSafeCommands.has(input.command)) return { mode: "setup_safe" };
  return { mode: "requires_license", operation: "review_cycle" };
}
