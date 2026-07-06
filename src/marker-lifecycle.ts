import { createHash } from "node:crypto";
import { redactSecrets } from "./secrets.js";

/**
 * Additive, backward-compatible lifecycle + fixer-handoff metadata for the bot-owned markers
 * (#263). These fields ride the DIAGNOSTIC state marker only — never the public identity marker
 * that keys sticky-comment upsert — so the dedup key stays byte-stable and posting behavior is
 * unchanged. Every field is optional: when absent, the marker is byte-identical to today.
 *
 * All values are derived from decisions the run already made (see mapReviewOutcome / mapReviewRole
 * / mapIssueLifecycleState); nothing here computes new behavior or posts new comments.
 */

/** Actor role for a marker-posting surface. */
export type MarkerRole = "reviewer" | "enricher" | "observer";

/** Terminal review outcome, mapped from the existing review-status decision. */
export type MarkerOutcome = "reviewed" | "enriched" | "skipped" | "deferred" | "stale";

/** Issue-side lifecycle state, mapped from the existing issue-enrichment decision path. */
export type IssueLifecycleState =
  | "enriched"
  | "needs-human-routing"
  | "needs-repro"
  | "ready-for-fix-proposal"
  | "stale-head"
  | "deferred-by-throttle";

/** Optional lifecycle/handoff metadata appended to a diagnostic state marker. */
export interface MarkerLifecycleFields {
  runId?: string;
  role?: MarkerRole;
  outcome?: MarkerOutcome;
  /** Free-form downstream-fixer pointer (agent/label). Diagnostic-only; redacted. */
  handoffTarget?: string;
  /** Stable hash of the reviewed subject; never raw subject text. */
  issueHash?: string;
}

/** Parsed lifecycle fields plus the issue-side `lifecycle=` state token, for round-trip checks. */
export interface ParsedMarkerLifecycleFields extends MarkerLifecycleFields {
  issueLifecycleState?: IssueLifecycleState;
}

const MARKER_FIELD_ORDER = ["runId", "role", "outcome", "handoffTarget", "issueHash"] as const;
// Marker tokens are space-delimited `key=value` pairs closed by ` -->`; values may not contain
// whitespace or the comment terminator, so we sanitize to a token-safe charset.
const TOKEN_UNSAFE_PATTERN = /[\s>]|--/g;

/**
 * Stable, hashed subject identifier for cross-run correlation. Hashes the identity tuple
 * (repo+pr+head or repo+issue) — never the raw subject text — and truncates to 16 hex chars.
 */
export function buildIssueHash(input:
  | { repo: string; pullNumber: number; headSha: string }
  | { repo: string; issueNumber: number }
): string {
  const subject = "pullNumber" in input
    ? `${input.repo}#pr-${input.pullNumber}@${input.headSha}`
    : `${input.repo}#issue-${input.issueNumber}`;
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 16);
}

/**
 * Renders the optional lifecycle fields as ` key=value` tokens in a fixed order. Returns "" when
 * no fields are present so callers append byte-identical marker text to today's output. Values are
 * redacted and stripped of marker-breaking characters; handoffTarget in particular is treated as
 * untrusted free-form text.
 */
export function renderMarkerLifecycleFields(fields: MarkerLifecycleFields | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const key of MARKER_FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined) continue;
    const token = sanitizeMarkerToken(value);
    if (!token) continue;
    parts.push(`${key}=${token}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * Parses lifecycle fields back out of a marker string, ignoring the identity tokens
 * (repo/pr/sha/issue/state/status/version/hash/updated_at). Round-trips markers WITHOUT these
 * fields to an empty object (never fail-closed on absence), which is what preserves back-compat.
 */
export function parseMarkerLifecycleFields(marker: string): ParsedMarkerLifecycleFields {
  const fields: ParsedMarkerLifecycleFields = {};
  for (const match of marker.matchAll(/(\w+)=(\S+)/g)) {
    const key = match[1]!;
    const value = match[2]!;
    if (key === "role" && isMarkerRole(value)) fields.role = value;
    else if (key === "outcome" && isMarkerOutcome(value)) fields.outcome = value;
    else if (key === "runId") fields.runId = value;
    else if (key === "handoffTarget") fields.handoffTarget = value;
    else if (key === "issueHash") fields.issueHash = value;
    else if (key === "lifecycle" && isIssueLifecycleState(value)) fields.issueLifecycleState = value;
  }
  return fields;
}

/** Maps the existing review-status decision to a terminal outcome. Undefined for non-terminal states. */
export function mapReviewOutcome(state: string): MarkerOutcome | undefined {
  switch (state) {
    case "completed":
      return "reviewed";
    case "skipped":
      return "skipped";
    case "provider_deferred":
      return "deferred";
    case "stale_head":
    case "closed_or_merged_before_review":
      return "stale";
    default:
      // queued / in_progress / failed have no terminal handoff outcome yet.
      return undefined;
  }
}

/**
 * Maps the existing issue-enrichment record status (+ optional skip/defer reason) to an issue-side
 * lifecycle state. These are renamings/exposures of decisions the enricher already made — not new
 * behavior. Undefined for statuses with no lifecycle exposure (e.g. dry_run/failed).
 */
export function mapIssueLifecycleState(input: {
  status: string;
  reason?: string;
}): IssueLifecycleState | undefined {
  switch (input.status) {
    case "posted":
      return "enriched";
    case "deferred":
      // The enricher already decided WHY it deferred; expose throttle vs stale separately.
      if (input.reason === "stale_issue_closed") return "stale-head";
      return "deferred-by-throttle";
    case "skipped":
      if (input.reason === "stale_issue_closed") return "stale-head";
      if (input.reason === "issue_is_pull_request") return "needs-human-routing";
      return undefined;
    default:
      // dry_run / failed carry no public lifecycle exposure.
      return undefined;
  }
}

function sanitizeMarkerToken(value: string): string {
  return redactSecrets(value).replace(TOKEN_UNSAFE_PATTERN, "").trim();
}

function isMarkerRole(value: string): value is MarkerRole {
  return value === "reviewer" || value === "enricher" || value === "observer";
}

function isMarkerOutcome(value: string): value is MarkerOutcome {
  return value === "reviewed" || value === "enriched" || value === "skipped" ||
    value === "deferred" || value === "stale";
}

function isIssueLifecycleState(value: string): value is IssueLifecycleState {
  return value === "enriched" || value === "needs-human-routing" || value === "needs-repro" ||
    value === "ready-for-fix-proposal" || value === "stale-head" || value === "deferred-by-throttle";
}
