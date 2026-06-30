import type { CommandConfig } from "./config.js";

export type ReviewCommandAction = "review" | "re-review" | "explain" | "stop";

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
  if (!config.enabled) return { commands: [], unauthorized: [] };

  const commands: ReviewCommand[] = [];
  const unauthorized: UnauthorizedReviewCommand[] = [];
  for (const comment of comments) {
    const action = parseCommandAction(comment.body, config.botMentions);
    if (!action) continue;
    const author = comment.user?.login ?? "(unknown)";
    if (!isTrustedAuthor(author, config)) {
      unauthorized.push({ action, commentId: comment.id, author });
      continue;
    }
    commands.push({
      action,
      commentId: comment.id,
      author,
      body: comment.body ?? "",
      url: comment.html_url
    });
  }

  return {
    commands: commands.sort((left, right) => left.commentId - right.commentId),
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
  const latest = pending.at(-1);
  if (!latest) return { action: "none", shouldReview: false };

  return {
    action: latest.action,
    commandId: latest.commentId,
    command: latest,
    shouldReview: latest.action === "review" || latest.action === "re-review"
  };
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
  return undefined;
}

function isTrustedAuthor(author: string, config: CommandConfig): boolean {
  return config.trustedAuthors.includes(author) || config.trustedAuthors.includes("*");
}
