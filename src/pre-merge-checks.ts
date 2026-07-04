export type PreMergeCheckMode = "off" | "warning" | "error";
export type PreMergeCheckStatus = "pass" | "warning" | "fail" | "skipped";
export type PreMergeReviewEvent = "COMMENT" | "REQUEST_CHANGES";

export interface PreMergeLinkedIssue {
  number?: number;
  ref?: string;
  url?: string;
  state?: string;
}

export type PreMergeLinkedIssueInput = number | string | PreMergeLinkedIssue;

export interface PreMergePullInput {
  title?: string | null;
  body?: string | null;
  linkedIssues?: PreMergeLinkedIssueInput[];
  linkedIssueRefs?: string[];
  changedFiles?: string[];
}

export interface PreMergeBuiltInCheckConfig {
  mode: PreMergeCheckMode;
}

export interface PreMergeTitleCheckConfig extends PreMergeBuiltInCheckConfig {
  minLength?: number;
  rejectDraftPrefixes?: boolean;
}

export interface PreMergeDescriptionCheckConfig extends PreMergeBuiltInCheckConfig {
  minLength?: number;
}

export interface PreMergeLinkedIssueCheckConfig extends PreMergeBuiltInCheckConfig {
  requireOpen?: boolean;
}

export type PreMergeCustomMatchSource = "title" | "description" | "title_or_description" | "changed_files" | "linked_issue_refs";

export interface PreMergeCustomMatcher {
  source: PreMergeCustomMatchSource;
  includes?: string;
  matches?: string;
}

export interface PreMergeCustomCheckConfig {
  name: string;
  mode: PreMergeCheckMode;
  instructions: string;
  match: PreMergeCustomMatcher;
}

export interface PreMergeCheckPolicy {
  title?: PreMergeTitleCheckConfig;
  description?: PreMergeDescriptionCheckConfig;
  linkedIssue?: PreMergeLinkedIssueCheckConfig;
  customChecks?: PreMergeCustomCheckConfig[];
}

export interface PreMergeCheckEvidence {
  key: string;
  value: string;
  passed: boolean;
  detail?: string;
}

export interface PreMergeCheckResult {
  id: string;
  name: string;
  mode: PreMergeCheckMode;
  status: PreMergeCheckStatus;
  blocking: boolean;
  summary: string;
  evidence: PreMergeCheckEvidence[];
  instructions?: string;
}

export interface PreMergePolicyValidationError {
  check: string;
  field: string;
  message: string;
}

export interface PreMergePolicyValidationResult {
  ok: boolean;
  errors: PreMergePolicyValidationError[];
}

export interface PreMergeCheckEvaluation {
  ok: boolean;
  reviewEvent: PreMergeReviewEvent;
  checks: PreMergeCheckResult[];
  warnings: PreMergeCheckResult[];
  blockingErrors: PreMergeCheckResult[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    blockingErrors: number;
    skipped: number;
  };
  validation: PreMergePolicyValidationResult;
}

const CUSTOM_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const NON_DETERMINISTIC_INSTRUCTION_PATTERN =
  /\b(ask\s+(?:the\s+)?(?:model|llm)|model\s+(?:should|must|can)|llm|ai\s+judg|judge\s+whether|best\s+judg(?:e)?ment|probably|seems\s+safe|looks\s+safe)\b/i;
const MAX_CUSTOM_REGEX_INPUT_CHARS = 2048;

export function evaluatePreMergeChecks(input: {
  pull: PreMergePullInput;
  policy: PreMergeCheckPolicy;
}): PreMergeCheckEvaluation {
  const validation = validatePreMergeCheckPolicy(input.policy);
  if (!validation.ok) {
    const blockingErrors = validation.errors.map(validationErrorToCheck);
    return summarizeChecks([...skippedChecksForInvalidPolicy(input.policy), ...blockingErrors], validation);
  }

  const checks: PreMergeCheckResult[] = [];
  if (input.policy.title) checks.push(evaluateTitleCheck(input.pull, input.policy.title));
  if (input.policy.description) checks.push(evaluateDescriptionCheck(input.pull, input.policy.description));
  if (input.policy.linkedIssue) checks.push(evaluateLinkedIssueCheck(input.pull, input.policy.linkedIssue));
  for (const custom of input.policy.customChecks ?? []) checks.push(evaluateCustomCheck(input.pull, custom));
  return summarizeChecks(checks, validation);
}

export function validatePreMergeCheckPolicy(policy: PreMergeCheckPolicy): PreMergePolicyValidationResult {
  const errors: PreMergePolicyValidationError[] = [];
  validateMode("title", policy.title?.mode, errors, policy.title !== undefined);
  validateMode("description", policy.description?.mode, errors, policy.description !== undefined);
  validateMode("linked_issue", policy.linkedIssue?.mode, errors, policy.linkedIssue !== undefined);
  validatePositiveInteger("title", "minLength", policy.title?.minLength, errors);
  validatePositiveInteger("description", "minLength", policy.description?.minLength, errors);

  const seenCustomNames = new Set<string>();
  for (const custom of policy.customChecks ?? []) {
    const check = `custom:${custom.name}`;
    validateMode(check, custom.mode, errors, true);
    if (!CUSTOM_NAME_PATTERN.test(custom.name)) {
      errors.push({
        check,
        field: "name",
        message: "Custom check names must match /^[a-z][a-z0-9-]{1,63}$/."
      });
    }
    if (seenCustomNames.has(custom.name)) {
      errors.push({ check, field: "name", message: "Custom check names must be unique." });
    }
    seenCustomNames.add(custom.name);
    validateInstructions(check, custom.instructions, errors);
    validateMatcher(check, custom.match, errors);
  }

  return { ok: errors.length === 0, errors };
}

function evaluateTitleCheck(pull: PreMergePullInput, config: PreMergeTitleCheckConfig): PreMergeCheckResult {
  if (config.mode === "off") return skippedCheck("title", "Title", config.mode, "Title check is disabled.");
  const title = normalizeText(pull.title);
  const minLength = config.minLength ?? 8;
  const rejectDraftPrefixes = config.rejectDraftPrefixes ?? true;
  const lengthPassed = title.length >= minLength;
  const draftPassed = !rejectDraftPrefixes || !isExplicitDraftTitle(title);
  const passed = lengthPassed && draftPassed;

  return checkFromOutcome({
    id: "title",
    name: "Title",
    mode: config.mode,
    passed,
    passSummary: "PR title is specific enough for pre-merge review.",
    failSummary: "PR title is missing, too short, or still marked as draft/WIP.",
    evidence: [
      { key: "title.length", value: String(title.length), passed: lengthPassed, detail: `minimum ${minLength}` },
      { key: "title.not_draft_prefix", value: String(draftPassed), passed: draftPassed }
    ]
  });
}

function evaluateDescriptionCheck(pull: PreMergePullInput, config: PreMergeDescriptionCheckConfig): PreMergeCheckResult {
  if (config.mode === "off") return skippedCheck("description", "Description", config.mode, "Description check is disabled.");
  const body = normalizeText(pull.body);
  const minLength = config.minLength ?? 20;
  const lengthPassed = body.length >= minLength;
  const placeholderPassed = !/^\s*(?:n\/a|none|todo|tbd|placeholder|tiny\.?)\s*$/i.test(body);
  const passed = lengthPassed && placeholderPassed;

  return checkFromOutcome({
    id: "description",
    name: "Description",
    mode: config.mode,
    passed,
    passSummary: "PR description contains enough deterministic context.",
    failSummary: "PR description is missing, placeholder-only, or too short.",
    evidence: [
      { key: "description.length", value: String(body.length), passed: lengthPassed, detail: `minimum ${minLength}` },
      { key: "description.not_placeholder", value: String(placeholderPassed), passed: placeholderPassed }
    ]
  });
}

function evaluateLinkedIssueCheck(pull: PreMergePullInput, config: PreMergeLinkedIssueCheckConfig): PreMergeCheckResult {
  if (config.mode === "off") return skippedCheck("linked_issue", "Linked issue", config.mode, "Linked issue check is disabled.");
  const refs = collectLinkedIssueRefs(pull);
  const linkedIssues = collectLinkedIssues(pull);
  const hasRefs = refs.length > 0;
  const openState = evaluateOpenLinkedIssueState(linkedIssues, config.requireOpen === true);
  const openStatePassed = openState.passed;
  const passed = hasRefs && openStatePassed;

  return checkFromOutcome({
    id: "linked_issue",
    name: "Linked issue",
    mode: config.mode,
    passed,
    passSummary: "PR metadata links to an issue with deterministic evidence.",
    failSummary: "PR metadata does not link to an issue required by policy.",
    evidence: [
      {
        key: "linked_issue.references",
        value: refs.length > 0 ? refs.join(", ") : "none",
        passed: hasRefs
      },
      {
        key: "linked_issue.open_state",
        value: openState.value,
        passed: openStatePassed,
        detail: openState.detail
      }
    ]
  });
}

function evaluateCustomCheck(pull: PreMergePullInput, custom: PreMergeCustomCheckConfig): PreMergeCheckResult {
  const id = `custom:${custom.name}`;
  if (custom.mode === "off") return skippedCheck(id, custom.name, custom.mode, "Custom check is disabled.", custom.instructions);
  const match = evaluateMatcher(pull, custom.match);
  return checkFromOutcome({
    id,
    name: custom.name,
    mode: custom.mode,
    passed: match.passed,
    passSummary: `Custom check ${custom.name} passed.`,
    failSummary: `Custom check ${custom.name} did not find the required deterministic evidence.`,
    evidence: [
      {
        key: `custom.${custom.name}.${custom.match.source}`,
        value: match.value,
        passed: match.passed,
        detail: match.detail
      }
    ],
    instructions: custom.instructions
  });
}

function evaluateMatcher(pull: PreMergePullInput, matcher: PreMergeCustomMatcher): { passed: boolean; value: string; detail: string } {
  const values = valuesForMatcherSource(pull, matcher.source);
  if (matcher.includes !== undefined) {
    const needle = matcher.includes.toLowerCase();
    const passed = values.some((value) => value.toLowerCase().includes(needle));
    return {
      passed,
      value: passed ? "matched" : "not_matched",
      detail: `operator=includes; source=${matcher.source}`
    };
  }
  if (matcher.matches !== undefined) {
    const regex = new RegExp(matcher.matches);
    const matched = values.find((value) => regex.test(capCustomRegexInput(value)));
    return {
      passed: matched !== undefined,
      value: matched !== undefined ? "matched" : "not_matched",
      detail: `operator=matches; source=${matcher.source}; max_input_chars=${MAX_CUSTOM_REGEX_INPUT_CHARS}`
    };
  }
  return { passed: false, value: "not_matched", detail: "operator=missing" };
}

function isExplicitDraftTitle(title: string): boolean {
  return /^\s*(?:\[(?:wip|draft|tmp)\]|(?:wip|draft|tmp)\s*[:\-]|(?:wip|draft|tmp)$)/i.test(title);
}

function evaluateOpenLinkedIssueState(
  linkedIssues: PreMergeLinkedIssue[],
  requireOpen: boolean
): { passed: boolean; value: string; detail: string } {
  if (!requireOpen) return { passed: true, value: "not_required", detail: "open issue state is not required" };
  if (linkedIssues.length === 0) {
    return {
      passed: false,
      value: "not_applicable",
      detail: "open issue state requires structured linked issue metadata"
    };
  }

  const states = linkedIssues.map((issue) => normalizeIssueState(issue.state));
  const passed = states.every((state) => state === "open");
  return {
    passed,
    value: passed ? "open" : [...new Set(states)].join(","),
    detail: "open issue required"
  };
}

function normalizeIssueState(state: string | undefined): string {
  if (!state?.trim()) return "unknown";
  return state.trim().toLowerCase();
}

function valuesForMatcherSource(pull: PreMergePullInput, source: PreMergeCustomMatchSource): string[] {
  if (source === "title") return [normalizeText(pull.title)];
  if (source === "description") return [normalizeText(pull.body)];
  if (source === "title_or_description") return [normalizeText(pull.title), normalizeText(pull.body)];
  if (source === "changed_files") return pull.changedFiles ?? [];
  return collectLinkedIssueRefs(pull);
}

function checkFromOutcome(input: {
  id: string;
  name: string;
  mode: Exclude<PreMergeCheckMode, "off">;
  passed: boolean;
  passSummary: string;
  failSummary: string;
  evidence: PreMergeCheckEvidence[];
  instructions?: string;
}): PreMergeCheckResult {
  if (input.passed) {
    return {
      id: input.id,
      name: input.name,
      mode: input.mode,
      status: "pass",
      blocking: false,
      summary: input.passSummary,
      evidence: input.evidence,
      instructions: input.instructions
    };
  }
  return {
    id: input.id,
    name: input.name,
    mode: input.mode,
    status: input.mode === "error" ? "fail" : "warning",
    blocking: input.mode === "error",
    summary: input.failSummary,
    evidence: input.evidence,
    instructions: input.instructions
  };
}

function skippedCheck(
  id: string,
  name: string,
  mode: PreMergeCheckMode,
  summary: string,
  instructions?: string
): PreMergeCheckResult {
  return {
    id,
    name,
    mode,
    status: "skipped",
    blocking: false,
    summary,
    evidence: [{ key: "mode", value: mode, passed: true }],
    instructions
  };
}

function summarizeChecks(
  checks: PreMergeCheckResult[],
  validation: PreMergePolicyValidationResult
): PreMergeCheckEvaluation {
  const warnings = checks.filter((check) => check.status === "warning");
  const blockingErrors = checks.filter((check) => check.blocking);
  return {
    ok: blockingErrors.length === 0,
    reviewEvent: blockingErrors.length === 0 ? "COMMENT" : "REQUEST_CHANGES",
    checks,
    warnings,
    blockingErrors,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "pass").length,
      warnings: warnings.length,
      blockingErrors: blockingErrors.length,
      skipped: checks.filter((check) => check.status === "skipped").length
    },
    validation
  };
}

function validationErrorToCheck(error: PreMergePolicyValidationError): PreMergeCheckResult {
  return {
    id: `policy_validation:${error.check}:${error.field}`,
    name: "Policy validation",
    mode: "error",
    status: "fail",
    blocking: true,
    summary: error.message,
    evidence: [
      { key: "policy.check", value: error.check, passed: false },
      { key: "policy.field", value: error.field, passed: false }
    ]
  };
}

function skippedChecksForOffModes(policy: PreMergeCheckPolicy): PreMergeCheckResult[] {
  const checks: PreMergeCheckResult[] = [];
  if (policy.title?.mode === "off") checks.push(skippedCheck("title", "Title", "off", "Title check is disabled."));
  if (policy.description?.mode === "off") checks.push(skippedCheck("description", "Description", "off", "Description check is disabled."));
  if (policy.linkedIssue?.mode === "off") checks.push(skippedCheck("linked_issue", "Linked issue", "off", "Linked issue check is disabled."));
  for (const custom of policy.customChecks ?? []) {
    if (custom.mode === "off") checks.push(skippedCheck(`custom:${custom.name}`, custom.name, "off", "Custom check is disabled.", custom.instructions));
  }
  return checks;
}

function skippedChecksForInvalidPolicy(policy: PreMergeCheckPolicy): PreMergeCheckResult[] {
  const checks: PreMergeCheckResult[] = [];
  if (policy.title) {
    checks.push(skippedCheck("title", "Title", policy.title.mode, skippedForInvalidPolicySummary("Title", policy.title.mode)));
  }
  if (policy.description) {
    checks.push(skippedCheck("description", "Description", policy.description.mode, skippedForInvalidPolicySummary("Description", policy.description.mode)));
  }
  if (policy.linkedIssue) {
    checks.push(skippedCheck("linked_issue", "Linked issue", policy.linkedIssue.mode, skippedForInvalidPolicySummary("Linked issue", policy.linkedIssue.mode)));
  }
  for (const custom of policy.customChecks ?? []) {
    checks.push(
      skippedCheck(
        `custom:${custom.name}`,
        custom.name,
        custom.mode,
        skippedForInvalidPolicySummary(`Custom check ${custom.name}`, custom.mode),
        custom.instructions
      )
    );
  }
  return checks;
}

function skippedForInvalidPolicySummary(name: string, mode: PreMergeCheckMode): string {
  return mode === "off" ? `${name} check is disabled.` : `${name} check was not evaluated because policy validation failed.`;
}

function validateMode(
  check: string,
  mode: unknown,
  errors: PreMergePolicyValidationError[],
  present: boolean
): void {
  if (!present) return;
  if (mode !== "off" && mode !== "warning" && mode !== "error") {
    errors.push({ check, field: "mode", message: "Mode must be one of: off, warning, error." });
  }
}

function validatePositiveInteger(
  check: string,
  field: string,
  value: unknown,
  errors: PreMergePolicyValidationError[]
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < 1) {
    errors.push({ check, field, message: `${field} must be a positive integer when provided.` });
  }
}

function validateInstructions(
  check: string,
  instructions: unknown,
  errors: PreMergePolicyValidationError[]
): void {
  if (typeof instructions !== "string" || instructions.trim().length < 12 || instructions.trim().length > 500) {
    errors.push({ check, field: "instructions", message: "Instructions must be 12 to 500 characters." });
    return;
  }
  if (NON_DETERMINISTIC_INSTRUCTION_PATTERN.test(instructions)) {
    errors.push({
      check,
      field: "instructions",
      message: "Instructions must be deterministic and must not delegate pass/fail judgment to a model."
    });
  }
}

function validateMatcher(
  check: string,
  matcher: PreMergeCustomMatcher,
  errors: PreMergePolicyValidationError[]
): void {
  const validSources: PreMergeCustomMatchSource[] = ["title", "description", "title_or_description", "changed_files", "linked_issue_refs"];
  if (!matcher || typeof matcher !== "object") {
    errors.push({ check, field: "match", message: "Custom checks require a deterministic match rule." });
    return;
  }
  if (!validSources.includes(matcher.source)) {
    errors.push({ check, field: "match.source", message: `Match source must be one of: ${validSources.join(", ")}.` });
  }
  if (matcher.includes === undefined && matcher.matches === undefined) {
    errors.push({ check, field: "match", message: "Custom match requires includes or matches." });
  }
  if (matcher.includes !== undefined && matcher.matches !== undefined) {
    errors.push({ check, field: "match", message: "Custom match must set exactly one of includes or matches." });
  }
  if (matcher.includes !== undefined && matcher.includes.trim().length === 0) {
    errors.push({ check, field: "match.includes", message: "includes must not be empty." });
  }
  if (matcher.matches !== undefined) {
    try {
      new RegExp(matcher.matches);
    } catch {
      errors.push({ check, field: "match.matches", message: "matches must be a valid JavaScript regular expression." });
      return;
    }
    if (isPotentiallyUnsafeRegex(matcher.matches)) {
      errors.push({
        check,
        field: "match.matches",
        message: "matches must avoid nested quantifiers, quantified alternation groups, backreferences, and lookaround assertions."
      });
    }
  }
}

function collectLinkedIssueRefs(pull: PreMergePullInput): string[] {
  const refs = new Set<string>();
  for (const ref of pull.linkedIssueRefs ?? []) {
    const normalized = normalizeIssueRef(ref);
    if (normalized) refs.add(normalized);
  }
  for (const issue of collectLinkedIssues(pull)) {
    const normalized = normalizeIssueRef(issue.ref ?? issue.url ?? (issue.number ? `#${issue.number}` : ""));
    if (normalized) refs.add(normalized);
  }
  for (const ref of refsFromText(`${pull.title ?? ""}\n${pull.body ?? ""}`)) refs.add(ref);
  return [...refs].sort();
}

function collectLinkedIssues(pull: PreMergePullInput): PreMergeLinkedIssue[] {
  return (pull.linkedIssues ?? []).map((issue) => {
    if (typeof issue === "number") return { number: issue, ref: `#${issue}` };
    if (typeof issue === "string") return { ref: issue };
    return issue;
  });
}

function refsFromText(text: string): string[] {
  const refs = new Set<string>();
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|relate[sd]?|refs?|issue)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) refs.add(`#${match[1]}`);
  }
  return [...refs];
}

function normalizeIssueRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const issueNumber = trimmed.match(/#(\d+)\b/);
  if (issueNumber?.[1]) return `#${issueNumber[1]}`;
  if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
  return trimmed;
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function capCustomRegexInput(value: string): string {
  return value.length > MAX_CUSTOM_REGEX_INPUT_CHARS ? value.slice(0, MAX_CUSTOM_REGEX_INPUT_CHARS) : value;
}

function isPotentiallyUnsafeRegex(pattern: string): boolean {
  const stripped = stripEscapedRegexCharacters(pattern);
  if (/\\[1-9]/.test(pattern)) return true;
  if (/\(\?<([=!]|!)/.test(pattern) || /\(\?[=!]/.test(pattern)) return true;
  return hasNestedQuantifiedGroup(stripped) || hasQuantifiedAlternationGroup(stripped);
}

function stripEscapedRegexCharacters(pattern: string): string {
  return pattern.replace(/\\./g, "");
}

function hasNestedQuantifiedGroup(pattern: string): boolean {
  return /\((?:[^()]|\([^()]*\))*[*+][^()]*\)(?:[*+]|\{\d+(?:,\d*)?\})/.test(pattern);
}

function hasQuantifiedAlternationGroup(pattern: string): boolean {
  return /\([^()]*\|[^()]*\)(?:[*+]|\{\d+(?:,\d*)?\})/.test(pattern);
}
