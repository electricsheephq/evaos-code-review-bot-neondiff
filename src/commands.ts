import type { CommandConfig } from "./config.js";
import {
  selectReviewEventAuthorizationAttempt,
  type ReviewEventAuthorizationAttempt
} from "./review-event-policy.js";
import {
  FINISHING_TOUCH_ACTIONS,
  parseFinishingTouchCommand,
  type FinishingTouchAction
} from "./finishing-touches.js";

export type ReviewCommandAction = "review" | "re-review" | "request-changes" | "explain" | "stop" | FinishingTouchAction;

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

export interface ReviewEventAuthorizationTarget {
  repo: string;
  pullNumber: number;
  headSha: string;
}

/** Bounded request metadata only: the source command body must never leave the parser. */
export interface ReviewEventAuthorizationReviewRequest {
  action: "request-changes";
  commentId: number;
  author: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export interface CollectedReviewEventAuthorizationAttempts {
  attempts: ReviewEventAuthorizationAttempt[];
  selected: ReviewEventAuthorizationAttempt;
  /** Valid exact-target commands for the scheduler to enqueue as manual review requests. */
  reviewRequests: ReviewEventAuthorizationReviewRequest[];
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

/**
 * Parses only whole-line request-changes commands. It deliberately returns bounded metadata rather
 * than the raw GitHub comment body; legacy review/re-review command handling remains separate.
 */
export function collectReviewEventAuthorizationAttempts(
  comments: IssueCommentCommandSource[],
  config: CommandConfig,
  target: ReviewEventAuthorizationTarget
): CollectedReviewEventAuthorizationAttempts {
  if (!config.enabled) return { attempts: [], selected: { status: "missing" }, reviewRequests: [] };

  const attempts: ReviewEventAuthorizationAttempt[] = [];
  const reviewRequests: ReviewEventAuthorizationReviewRequest[] = [];
  const seenCommentIds = new Set<number>();
  for (const comment of comments) {
    if (!Number.isSafeInteger(comment.id) || comment.id < 1 || seenCommentIds.has(comment.id)) continue;
    seenCommentIds.add(comment.id);

    const parsed = parseRequestChangesCommand(comment.body, config.botMentions);
    if (!parsed) continue;
    const author = boundedAuthor(comment.user?.login);
    const metadata = {
      ...(author === undefined ? {} : { author }),
      commentId: comment.id
    };

    if (parsed.status === "malformed") {
      attempts.push({ status: "malformed", ...metadata });
      continue;
    }
    if (!author || !isExplicitTrustedAuthor(author, config)) {
      attempts.push({ status: "untrusted", ...metadata });
      continue;
    }
    if (
      parsed.repo !== target.repo ||
      parsed.pullNumber !== target.pullNumber ||
      parsed.headSha !== normalizeHeadSha(target.headSha)
    ) {
      attempts.push({ status: "stale_head", headSha: parsed.headSha, ...metadata });
      continue;
    }

    const attempt: ReviewEventAuthorizationAttempt = {
      status: "eligible",
      headSha: parsed.headSha,
      author,
      commentId: comment.id
    };
    attempts.push(attempt);
    reviewRequests.push({
      action: "request-changes",
      commentId: comment.id,
      author,
      repo: parsed.repo,
      pullNumber: parsed.pullNumber,
      headSha: parsed.headSha
    });
  }

  return {
    attempts,
    selected: selectReviewEventAuthorizationAttempt(attempts, target.headSha),
    reviewRequests
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
  return action === "review" || action === "re-review" || action === "request-changes";
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

type ParsedRequestChangesCommand =
  | { status: "malformed" }
  | { status: "parsed"; repo: string; pullNumber: number; headSha: string };

function parseRequestChangesCommand(
  body: string | null | undefined,
  mentions: string[]
): ParsedRequestChangesCommand | undefined {
  if (!body) return undefined;
  const normalizedMentions = new Set(mentions.map((mention) => mention.toLowerCase()));
  const trimmed = body.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  const mentionsRequestChanges = [...normalizedMentions].some((mention) =>
    normalized.toLowerCase().includes(`${mention} request-changes`)
  );
  if (!mentionsRequestChanges) return undefined;
  if (!trimmed || /[\r\n]/.test(trimmed)) return { status: "malformed" };

  const tokens = normalized.split(" ");
  if (!normalizedMentions.has(tokens[0].toLowerCase()) || tokens[1]?.toLowerCase() !== "request-changes") {
    return { status: "malformed" };
  }
  if (tokens.length !== 8 || tokens[2] !== "--repo" || tokens[4] !== "--pr" || tokens[6] !== "--head") {
    return { status: "malformed" };
  }
  const repo = tokens[3];
  const pullNumber = Number(tokens[5]);
  const headSha = normalizeHeadSha(tokens[7]);
  if (!isRepoName(repo) || !/^[1-9]\d*$/.test(tokens[5]) || !Number.isSafeInteger(pullNumber) || !headSha) {
    return { status: "malformed" };
  }
  return { status: "parsed", repo, pullNumber, headSha };
}

function normalizeHeadSha(headSha: string): string | undefined {
  return /^[0-9a-f]{40}$/i.test(headSha) ? headSha.toLowerCase() : undefined;
}

function isRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo);
}

function boundedAuthor(author: string | undefined): string | undefined {
  return author && /^[A-Za-z0-9-]{1,39}$/.test(author) ? author : undefined;
}

function isTrustedAuthor(author: string, config: CommandConfig): boolean {
  return config.trustedAuthors.includes(author) || config.trustedAuthors.includes("*");
}

function isExplicitTrustedAuthor(author: string, config: CommandConfig): boolean {
  return author !== "*" || config.trustedAuthors.includes(author);
}
