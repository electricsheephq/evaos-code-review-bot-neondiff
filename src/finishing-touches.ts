import { containsSecretLikeText } from "./secrets.js";
import type { RepoFinishingTouchesConfig } from "./config.js";

export type FinishingTouchAction =
  | "generate_tests"
  | "generate_docs"
  | "generate_docstrings"
  | "simplify_suggestion"
  | "changelog_draft"
  | "explain_risk"
  | "make_review_ready";

export const FINISHING_TOUCH_ACTIONS: FinishingTouchAction[] = [
  "generate_tests",
  "generate_docs",
  "generate_docstrings",
  "simplify_suggestion",
  "changelog_draft",
  "explain_risk",
  "make_review_ready"
];

export interface ParsedFinishingTouchCommand {
  action: FinishingTouchAction;
  phrase: string;
}

export interface FinishingTouchRequestValidationInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  currentHeadSha?: string;
  commentId: number;
  author: string;
  trustedAuthors: string[];
  worktreeClean: boolean;
  action: FinishingTouchAction;
  proposedOutput?: unknown;
}

export type FinishingTouchRequestValidationResult =
  | { ok: true; secretScan: "passed" | "not_scanned" }
  | {
      ok: false;
      reason:
        | "untrusted_author"
        | "stale_head"
        | "dirty_worktree"
        | "secret_detected";
      detail: string;
      secretScan: FinishingTouchSecretScanState;
    };

export interface BuildFinishingTouchDraftInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  action: FinishingTouchAction;
  author: string;
  commentId: number;
  trigger: string;
  generatedAt?: string;
}

export interface FinishingTouchDraft {
  mode: "draft_only";
  repo: string;
  pullNumber: number;
  headSha: string;
  action: FinishingTouchAction;
  author: string;
  commandCommentId: number;
  trigger: string;
  generatedAt: string;
  canPush: false;
  canCommit: false;
  canApprove: false;
  markdown: string;
}

export interface BuildFinishingTouchDryRunContractInput {
  dryRun: boolean;
  recorded: boolean;
  draft: FinishingTouchDraft;
  currentHeadSha: string;
  worktreeClean: boolean;
  worktreeCleanState?: FinishingTouchWorktreeCleanState;
  trustedAuthors: string[];
  validation: FinishingTouchRequestValidationResult;
}

export type FinishingTouchSecretScanState = "passed" | "failed" | "not_scanned";
export type FinishingTouchWorktreeCleanState = "verified_clean" | "dirty" | "assumed_clean";

export interface FinishingTouchDryRunContract {
  ok: boolean;
  mode: "draft_only";
  defaultOff: true;
  dryRun: boolean;
  recorded: boolean;
  target: {
    repo: string;
    pullNumber: number;
    headSha: string;
    currentHeadSha: string;
    staleHead: boolean;
  };
  command: {
    action: FinishingTouchAction;
    author: string;
    commentId: number;
    trigger?: string;
  };
  safety: {
    trustedAuthor: boolean;
    currentHeadMatches: boolean;
    worktreeClean: FinishingTouchWorktreeCleanState;
    secretScan: FinishingTouchSecretScanState;
    mutation: {
      canPush: false;
      canCommit: false;
      canApprove: false;
      directProtectedBranchCommit: false;
    };
  };
  validation: FinishingTouchRequestValidationResult;
  draft?: FinishingTouchDraft;
}

const COMMAND_PHRASES: Array<[FinishingTouchAction, string[]]> = [
  ["generate_tests", ["generate tests", "generate unit tests"]],
  ["generate_docs", ["generate docs", "generate documentation", "docs draft"]],
  ["generate_docstrings", ["generate docstrings"]],
  ["simplify_suggestion", ["simplify suggestion"]],
  ["changelog_draft", ["changelog draft", "release notes draft", "draft changelog"]],
  ["explain_risk", ["explain risk", "risk explanation", "explain risks"]],
  ["make_review_ready", ["make review-ready", "make review ready", "review-ready checklist"]]
];

export function parseFinishingTouchCommand(input: {
  body: string | null | undefined;
  botMentions: string[];
}): ParsedFinishingTouchCommand | undefined {
  if (!input.body) return undefined;
  const mentions = input.botMentions.map((mention) => mention.toLowerCase());
  for (const line of input.body.split(/\r?\n/)) {
    const normalized = line.trim().replace(/\s+/g, " ").toLowerCase();
    for (const mention of mentions) {
      const suffix = normalized.startsWith(`${mention} `) ? normalizeCommandSuffix(normalized.slice(mention.length + 1)) : undefined;
      if (!suffix) continue;
      for (const [action, phrases] of COMMAND_PHRASES) {
        const phrase = phrases.find((candidate) => suffix === candidate);
        if (phrase) return { action, phrase };
      }
    }
  }
  return undefined;
}

function normalizeCommandSuffix(value: string): string {
  let normalized = value.trim().replace(/[.!?,;:]+$/g, "").trim();
  normalized = normalized.replace(/\s+please$/i, "").replace(/[.!?,;:]+$/g, "").trim();
  return normalized;
}

export function validateFinishingTouchRequest(
  input: FinishingTouchRequestValidationInput
): FinishingTouchRequestValidationResult {
  if (!input.trustedAuthors.includes("*") && !input.trustedAuthors.includes(input.author)) {
    return {
      ok: false,
      reason: "untrusted_author",
      detail: `Author ${input.author} is not trusted for finishing-touch commands.`,
      secretScan: "not_scanned"
    };
  }
  if (input.currentHeadSha && input.currentHeadSha !== input.headSha) {
    return {
      ok: false,
      reason: "stale_head",
      detail: `Command targeted ${input.headSha}, but current head is ${input.currentHeadSha}.`,
      secretScan: "not_scanned"
    };
  }
  if (!input.worktreeClean) {
    return {
      ok: false,
      reason: "dirty_worktree",
      detail: "Refusing finishing-touch draft while the worktree is dirty.",
      secretScan: "not_scanned"
    };
  }
  if (input.proposedOutput !== undefined) {
    if (containsSecretLikeText(stringifyOutput(input.proposedOutput))) {
      return {
        ok: false,
        reason: "secret_detected",
        detail: "Refusing finishing-touch draft because proposed output contains secret-like text.",
        secretScan: "failed"
      };
    }
    return { ok: true, secretScan: "passed" };
  }
  return { ok: true, secretScan: "not_scanned" };
}

export function isFinishingTouchActionEnabled(
  action: FinishingTouchAction,
  touches: RepoFinishingTouchesConfig | undefined
): boolean {
  switch (action) {
    case "generate_tests":
      return touches?.unitTests?.enabled === true;
    case "generate_docs":
      return touches?.docs?.enabled === true;
    case "generate_docstrings":
      return touches?.docstrings?.enabled === true;
    case "simplify_suggestion":
      return touches?.simplifySuggestion?.enabled === true;
    case "changelog_draft":
      return touches?.changelogDraft?.enabled === true;
    case "explain_risk":
      return touches?.riskExplanation?.enabled === true;
    case "make_review_ready":
      return touches?.reviewReady?.enabled === true;
  }
}

export function buildFinishingTouchDraft(input: BuildFinishingTouchDraftInput): FinishingTouchDraft {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const title = titleForAction(input.action);
  const markdown = [
    `### ${title}`,
    "",
    `Draft only for \`${input.repo}#${input.pullNumber}\` at \`${input.headSha}\`.`,
    "",
    `Triggered by \`${input.author}\` comment \`${input.commentId}\`:`,
    "",
    "```text",
    input.trigger,
    "```",
    "",
    "No branch was pushed. No commit was created. No approval or merge action was taken.",
    "",
    ...draftChecklist(input.action)
  ].join("\n");

  return {
    mode: "draft_only",
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    action: input.action,
    author: input.author,
    commandCommentId: input.commentId,
    trigger: input.trigger,
    generatedAt,
    canPush: false,
    canCommit: false,
    canApprove: false,
    markdown
  };
}

export function buildFinishingTouchDryRunContract(
  input: BuildFinishingTouchDryRunContractInput
): FinishingTouchDryRunContract {
  const currentHeadSha = input.currentHeadSha.trim();
  const draftHeadSha = input.draft.headSha.trim();
  const currentHeadMatches =
    currentHeadSha.length > 0 && draftHeadSha.length > 0 && currentHeadSha === draftHeadSha;
  const trustedAuthor = input.trustedAuthors.includes("*") || input.trustedAuthors.includes(input.draft.author);
  const secretScan = input.validation.secretScan;
  const worktreeCleanState = input.worktreeCleanState ?? (input.worktreeClean ? "verified_clean" : "dirty");
  return {
    ok: input.validation.ok,
    mode: "draft_only",
    defaultOff: true,
    dryRun: input.dryRun,
    recorded: input.recorded,
    target: {
      repo: input.draft.repo,
      pullNumber: input.draft.pullNumber,
      headSha: input.draft.headSha,
      currentHeadSha: input.currentHeadSha,
      staleHead: !currentHeadMatches
    },
    command: {
      action: input.draft.action,
      author: input.draft.author,
      commentId: input.draft.commandCommentId,
      ...(input.validation.ok ? { trigger: input.draft.trigger } : {})
    },
    safety: {
      trustedAuthor,
      currentHeadMatches,
      worktreeClean: worktreeCleanState,
      secretScan,
      mutation: {
        canPush: false,
        canCommit: false,
        canApprove: false,
        directProtectedBranchCommit: false
      }
    },
    validation: input.validation,
    ...(input.validation.ok ? { draft: input.draft } : {})
  };
}

function titleForAction(action: FinishingTouchAction): string {
  switch (action) {
    case "generate_tests":
      return "Test Draft";
    case "generate_docs":
      return "Documentation Draft";
    case "generate_docstrings":
      return "Docstring Draft";
    case "simplify_suggestion":
      return "Simplification Draft";
    case "changelog_draft":
      return "Changelog Draft";
    case "explain_risk":
      return "Risk Explanation Draft";
    case "make_review_ready":
      return "Review-Ready Draft";
  }
}

function draftChecklist(action: FinishingTouchAction): string[] {
  switch (action) {
    case "generate_tests":
      return [
        "- Identify changed behavior from the PR diff.",
        "- Propose focused tests for the changed surface only.",
        "- Keep test code as a proposal until a branch-safety design is approved."
      ];
    case "generate_docs":
      return [
        "- Identify user-visible behavior changes.",
        "- Propose documentation edits without modifying repository files.",
        "- Include validation commands the author should run after applying docs."
      ];
    case "generate_docstrings":
      return [
        "- Identify changed exported functions or classes.",
        "- Propose concise docstrings only for changed code.",
        "- Avoid restating implementation details that can drift."
      ];
    case "simplify_suggestion":
      return [
        "- Identify the smallest simplification that preserves behavior.",
        "- Prefer deleting duplication over adding abstraction.",
        "- Include risks and validation commands."
      ];
    case "changelog_draft":
      return [
        "- Summarize user-facing changes.",
        "- Separate fixes, behavior changes, and operator notes.",
        "- Avoid claiming release readiness without CI evidence."
      ];
    case "explain_risk":
      return [
        "- Explain correctness, security, data-loss, CI, and release risks.",
        "- Mark confidence as uncalibrated unless an eval-backed bin exists.",
        "- Include missing proof explicitly."
      ];
    case "make_review_ready":
      return [
        "- List unresolved checks, missing proof, stale-head risk, and open review threads.",
        "- Suggest the smallest next actions for the PR author.",
        "- Do not approve, merge, push, or mark the PR ready automatically."
      ];
  }
}

function stringifyOutput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
