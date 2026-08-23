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
  | "bounded_complete"
  | "ambiguous_overlap"
  | "uncapped_explicit_command"
  | "trusted_stop"
  | "uncapped_read_failed"
  | "incomplete_evidence";

export interface EvidenceCommandDecision {
  decision: CommandDecision;
  evidenceComplete: boolean;
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
  const bounded = input.bounded.status === "failed" ? [] : input.bounded.comments;
  const uncapped = input.uncapped?.status === "complete" ? input.uncapped.comments : undefined;
  const reconciled = uncapped ? reconcileComments(bounded, uncapped) : { comments: bounded, ambiguous: false };
  if (reconciled.ambiguous) return blocked("ambiguous_overlap");

  const evidenceComplete = input.bounded.status === "complete";
  const commands = trustedCommands(reconciled.comments, input);
  const eligible = evidenceComplete
    ? commands
    : commands.filter((command) => isReviewCommandAction(command.action) || command.action === "stop");
  const decision = decideCommandAction({
    commands: eligible,
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    hasProcessedCommand: (_repo, _pull, _head, commentId) => {
      const command = eligible.find((candidate) => candidate.commentId === commentId);
      return command ? input.isProcessedCommand(command) : false;
    }
  });
  if (evidenceComplete) return { decision, evidenceComplete: true, reason: "bounded_complete" };
  if (decision.shouldReview && uncapped) return { decision, evidenceComplete: false, reason: "uncapped_explicit_command" };
  if (decision.action === "stop") return { decision, evidenceComplete: false, reason: "trusted_stop" };
  return blocked(input.uncapped?.status === "failed" ? "uncapped_read_failed" : "incomplete_evidence");
}

function reconcileComments(bounded: IssueCommentCommandSource[], complete: IssueCommentCommandSource[]): {
  comments: IssueCommentCommandSource[];
  ambiguous: boolean;
} {
  const priorById = new Map(bounded.map((comment) => [comment.id, comment]));
  const byId = new Map<number, IssueCommentCommandSource>();
  for (const current of complete) {
    const prior = priorById.get(current.id);
    if (!prior || sameCommandIdentity(prior, current)) {
      byId.set(current.id, current);
      continue;
    }
    const priorEdit = editTime(prior.updated_at);
    const currentEdit = editTime(current.updated_at);
    if (priorEdit === undefined || currentEdit === undefined || priorEdit === currentEdit) {
      return { comments: [], ambiguous: true };
    }
    byId.set(current.id, currentEdit > priorEdit ? current : prior);
  }
  return { comments: [...byId.values()].sort((left, right) => left.id - right.id), ambiguous: false };
}

function sameCommandIdentity(left: IssueCommentCommandSource, right: IssueCommentCommandSource): boolean {
  return left.body === right.body && left.user?.login === right.user?.login && left.user?.type === right.user?.type;
}

function editTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trustedCommands(
  read: IssueCommentCommandSource[],
  input: { config: CommandConfig; repo: string; pullNumber: number; headSha: string }
): ReviewCommand[] {
  const commands = collectTrustedReviewCommands(read, input.config).commands;
  const requests = collectReviewEventAuthorizationAttempts(read, input.config, input).reviewRequests;
  return [...commands, ...requests.map((request) => ({
    action: request.action, commentId: request.commentId, author: request.author, body: ""
  }))].sort((left, right) => left.commentId - right.commentId);
}

function blocked(reason: EvidenceDecisionReason): EvidenceCommandDecision {
  return { decision: { action: "none", shouldReview: false }, evidenceComplete: false, reason };
}
