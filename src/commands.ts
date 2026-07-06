import type { CommandConfig } from "./config.js";
import {
  FINISHING_TOUCH_ACTIONS,
  parseFinishingTouchCommand,
  type FinishingTouchAction
} from "./finishing-touches.js";

export type ReviewCommandAction = "review" | "re-review" | "explain" | "stop" | FinishingTouchAction;

export interface IssueCommentCommandSource {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: {
    login: string;
    type?: string;
  } | null;
}

export interface ReviewCommand {
  action: ReviewCommandAction;
  commentId: number;
  author: string;
  body: string;
  url?: string;
}

export interface UnauthorizedReviewCommand {
  action: ReviewCommandAction;
  commentId: number;
  author: string;
}

export interface CollectedReviewCommands {
  commands: ReviewCommand[];
  /** Public-eligible candidates (#345): review/re-review from a non-trusted author when publicCommands
   * is enabled. NOT yet authorized — the caller must apply the stateful bot + cooldown gate. */
  publicEligible: ReviewCommand[];
  unauthorized: UnauthorizedReviewCommand[];
}

export type CommandDecision =
  | { action: "none"; shouldReview: false }
  | {
      action: ReviewCommandAction;
      shouldReview: boolean;
      commandId: number;
      command: ReviewCommand;
    };

export function parseReviewCommand(comment: IssueCommentCommandSource, config: CommandConfig): ReviewCommand | undefined {
  if (!config.enabled) return undefined;
  const action = parseCommandAction(comment.body, config.botMentions);
  if (!action) return undefined;
  const author = comment.user?.login;
  if (!author || !isTrustedAuthor(author, config)) return undefined;
  return {
    action,
    commentId: comment.id,
    author,
    body: comment.body ?? "",
    url: comment.html_url
  };
}

export function collectTrustedReviewCommands(
  comments: IssueCommentCommandSource[],
  config: CommandConfig
): CollectedReviewCommands {
  if (!config.enabled) return { commands: [], publicEligible: [], unauthorized: [] };

  const commands: ReviewCommand[] = [];
  const publicEligible: ReviewCommand[] = [];
  const unauthorized: UnauthorizedReviewCommand[] = [];
  for (const comment of comments) {
    const action = parseCommandAction(comment.body, config.botMentions);
    if (!action) continue;
    const author = comment.user?.login ?? "(unknown)";
    const command: ReviewCommand = { action, commentId: comment.id, author, body: comment.body ?? "", url: comment.html_url };
    const authorization = classifyCommandAuthorization({ action, author }, config);
    if (authorization === "trusted") {
      commands.push(command);
    } else if (authorization === "public-eligible") {
      // Pure classification only — the stateful bot + cooldown gate runs in the caller (scheduler).
      publicEligible.push(command);
    } else {
      unauthorized.push({ action, commentId: comment.id, author });
    }
  }

  return {
    commands: commands.sort((left, right) => left.commentId - right.commentId),
    publicEligible: publicEligible.sort((left, right) => left.commentId - right.commentId),
    unauthorized
  };
}

export function decideCommandAction(input: {
  commands: ReviewCommand[];
  repo: string;
  pullNumber: number;
  headSha: string;
  hasProcessedCommand: (repo: string, pullNumber: number, headSha: string, commentId: number) => boolean;
}): CommandDecision {
  const pending = input.commands.filter(
    (command) => !input.hasProcessedCommand(input.repo, input.pullNumber, input.headSha, command.commentId)
  );
  const latestPending = pending.at(-1);
  const latestReview = pending.filter((command) => isReviewCommandAction(command.action)).at(-1);
  const latestStop = pending.filter((command) => command.action === "stop").at(-1);
  const latest = latestStop && (!latestReview || latestStop.commentId > latestReview.commentId)
    ? latestStop
    : latestReview ?? latestPending;
  if (!latest) return { action: "none", shouldReview: false };

  return {
    action: latest.action,
    commandId: latest.commentId,
    command: latest,
    shouldReview: isReviewCommandAction(latest.action)
  };
}

export type CommandAuthorization = "trusted" | "public-eligible" | "unauthorized";

/**
 * Pure authorization classification (#345, NO DB). A trusted author is allowed for ALL actions
 * exactly as today. A non-trusted author is "public-eligible" ONLY when publicCommands is enabled
 * AND the action is in publicCommands.actions (structurally only review/re-review can pass) —
 * otherwise "unauthorized" exactly as today. The stateful bot-author and rate-limit checks run in
 * the worker (where the store + head SHA are in scope); this classifier never touches them.
 */
export function classifyCommandAuthorization(
  command: { action: ReviewCommandAction; author: string },
  config: CommandConfig
): CommandAuthorization {
  if (isTrustedAuthor(command.author, config)) return "trusted";
  const publicCommands = config.publicCommands;
  if (publicCommands?.enabled && (publicCommands.actions as ReviewCommandAction[]).includes(command.action)) {
    return "public-eligible";
  }
  return "unauthorized";
}

/**
 * Public-command bot rejection (#345, loop protection). Deliberately BROAD: any Bot-type actor OR the
 * app's own login is blocked from triggering a public command. The breadth is intentional — a public
 * path must never let ANY automated actor (dependabot, another app, or ourselves) spin up reviews,
 * so we reject on user.type === "Bot" OR login === botLogin.
 *
 * This is intentionally DIFFERENT from GitHubApi.isBotAuthoredComment, which is the NARROWER
 * app-own-comment check (type === "Bot" AND login === botLogin) used to detect the bot's OWN status
 * comments for marker matching. Different questions ("is this any bot?" vs "is this MY comment?"), so
 * they are not unified; both derive the identity from the same botLogin config value. Trusted-author
 * authorization is unaffected — this only guards the public path.
 */
export function isBotCommandComment(user: { login: string; type?: string } | null | undefined, botLogin: string): boolean {
  if (!user) return false;
  return user.type === "Bot" || user.login === botLogin;
}

export function isReviewCommandAction(action: ReviewCommandAction): boolean {
  return action === "review" || action === "re-review";
}

export function isFinishingTouchCommandAction(action: ReviewCommandAction): action is FinishingTouchAction {
  return FINISHING_TOUCH_ACTIONS.includes(action as FinishingTouchAction);
}

export function isRecordOnlyCommandAction(action: ReviewCommandAction): boolean {
  return !isReviewCommandAction(action);
}

export function buildCommandStatusMarker(repo: string, pullNumber: number, headSha: string): string {
  return `<!-- evaos-command-status ${repo}#${pullNumber} ${headSha} -->`;
}

export function buildCommandStatusBody(input: {
  repo: string;
  pullNumber: number;
  headSha: string;
  decision: Exclude<CommandDecision, { action: "none"; shouldReview: false }>;
}): string {
  const verb = input.decision.shouldReview ? "queued a current-head review" : "recorded command state";
  return [
    buildCommandStatusMarker(input.repo, input.pullNumber, input.headSha),
    `evaOS Code Review Bot ${verb} for \`${input.repo}#${input.pullNumber}\` at \`${input.headSha}\`.`,
    `Command: \`${input.decision.action}\` from \`${input.decision.command.author}\` comment \`${input.decision.commandId}\`.`,
    "Safety boundary: command handling cannot approve, merge, repair, push branches, or expand repo permissions."
  ].join("\n\n");
}

function parseCommandAction(body: string | null | undefined, mentions: string[]): ReviewCommandAction | undefined {
  if (!body) return undefined;
  const normalizedMentions = mentions.map((mention) => mention.toLowerCase());
  for (const line of body.split(/\r?\n/)) {
    const normalized = line.trim().replace(/\s+/g, " ").toLowerCase();
    for (const mention of normalizedMentions) {
      const suffix = normalized.startsWith(`${mention} `) ? normalized.slice(mention.length + 1) : undefined;
      if (suffix === "review" || suffix === "re-review" || suffix === "explain" || suffix === "stop") return suffix;
    }
  }
  return parseFinishingTouchCommand({ body, botMentions: mentions })?.action;
}

function isTrustedAuthor(author: string, config: CommandConfig): boolean {
  return config.trustedAuthors.includes(author) || config.trustedAuthors.includes("*");
}
