import type { CommandConfig } from "./config.js";
import {
  collectReviewEventAuthorizationAttempts,
  collectTrustedReviewCommands,
  decideCommandAction,
  isReviewCommandAction,
  type CommandDecision,
  type IssueCommentCommandSource,
  type ReviewCommand
} from "./commands.js";

export type EvidenceRead =
  | { status: "complete" | "truncated"; comments: IssueCommentCommandSource[] }
  | { status: "failed" };

export type EvidenceDecisionReason =
  | "bounded_complete_no_command"
  | "bounded_complete_trusted_command"
  | "incomplete_evidence"
  | "incomplete_uncapped_explicit_command"
  | "incomplete_trusted_stop"
  | "incomplete_uncapped_read_failed";

export interface EvidenceCommandDecision {
  decision: CommandDecision;
  /** Automatic review authority. Explicit admitted commands may still be returned when false. */
  evidenceComplete: boolean;
  /** Literal, public-safe reason; never contains comment text, URLs, authors, or read errors. */
  reason: EvidenceDecisionReason;
}

export function resolveEvidenceCommandDecision(input: {
  config: CommandConfig;
  repo: string;
  pullNumber: number;
  headSha: string;
  bounded: EvidenceRead;
  uncapped?: EvidenceRead;
  isProcessedCommand: (command: ReviewCommand) => boolean;
}): EvidenceCommandDecision {
  const boundedIds = new Set(input.bounded.status === "failed" ? [] : input.bounded.comments.map((comment) => comment.id));
  const boundedCommands = trustedCommands(input.bounded, input);
  let commands = boundedCommands;
  let uncappedExplicit = false;
  if (input.bounded.status !== "complete" && input.uncapped?.status === "complete") {
    const uncappedCommands = trustedCommands(input.uncapped, input);
    const additions = uncappedCommands.filter((command) => !boundedIds.has(command.commentId));
    commands = [
      ...boundedCommands,
      ...additions.filter((command) => isReviewCommandAction(command.action) || command.action === "stop")
    ];
    uncappedExplicit = additions.some((command) => isReviewCommandAction(command.action));
  }

  const decision = decideCommandAction({
    commands: dedupeCommands(commands),
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    hasProcessedCommand: (_repo, _pullNumber, _headSha, commentId) => {
      const command = commands.find((candidate) => candidate.commentId === commentId);
      return command ? input.isProcessedCommand(command) : false;
    }
  });
  const evidenceComplete = input.bounded.status === "complete";
  const reason: EvidenceDecisionReason = evidenceComplete
    ? (decision.action === "none" ? "bounded_complete_no_command" : "bounded_complete_trusted_command")
    : uncappedExplicit && decision.shouldReview
      ? "incomplete_uncapped_explicit_command"
      : decision.action === "stop"
        ? "incomplete_trusted_stop"
        : input.uncapped?.status === "failed"
          ? "incomplete_uncapped_read_failed"
          : "incomplete_evidence";
  return { decision, evidenceComplete, reason };
}

function trustedCommands(read: EvidenceRead, input: { config: CommandConfig; repo: string; pullNumber: number; headSha: string }): ReviewCommand[] {
  if (read.status === "failed") return [];
  const collected = collectTrustedReviewCommands(read.comments, input.config).commands;
  const requests = collectReviewEventAuthorizationAttempts(read.comments, input.config, input).reviewRequests;
  const commands = [
    ...collected,
    ...requests.map((request) => ({ action: request.action, commentId: request.commentId, author: request.author, body: "" }))
  ];
  return commands.map((command) => ({ action: command.action, commentId: command.commentId, author: command.author, body: "" }));
}

function dedupeCommands(commands: ReviewCommand[]): ReviewCommand[] {
  return [...new Map(commands.map((command) => [command.commentId, command])).values()]
    .sort((left, right) => left.commentId - right.commentId);
}
