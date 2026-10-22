import { buildFindingFingerprint } from "./findings.js";
import type { DroppedFinding, Finding, PullReviewComment, ReviewComment } from "./types.js";

export const PRIOR_THREAD_MAX_LINE_DELTA = 10;
export const PRIOR_THREAD_TITLE_JACCARD_THRESHOLD = 0.5;
export const PRIOR_THREAD_BODY_JACCARD_THRESHOLD = 0.4;
const STOP_WORDS = new Set("the and are now for with this that from into when not".split(" "));

export interface AnsweredThread {
  id: number;
  path: string;
  line: number;
  title: string;
  body: string;
}

export function collectAnsweredThreads(
  comments: PullReviewComment[],
  isOwnComment: (comment: PullReviewComment) => boolean
): AnsweredThread[] {
  const answered = new Set(comments.filter((comment) =>
    comment.in_reply_to_id != null && comment.user && comment.user.type !== "Bot" &&
    !comment.user.login.endsWith("[bot]")
  ).map((comment) => comment.in_reply_to_id));
  return comments.filter((root) =>
    root.in_reply_to_id == null && isOwnComment(root) && root.line != null &&
    typeof root.path === "string" && answered.has(root.id)
  ).map((root) => {
    const [first = "", ...rest] = (root.body ?? "").split(/\r?\n/);
    const categoryIndex = rest.findIndex((line) => line.startsWith("Category:"));
    return {
      id: root.id, path: root.path!, line: root.line!,
      title: first.replace(/^\*\*P\d:\s*/, "").replace(/\*\*$/, "").trim(),
      body: (categoryIndex < 0 ? rest : rest.slice(0, categoryIndex)).join("\n").trim()
    };
  });
}

export function matchPriorThread(finding: Finding, threads: AnsweredThread[]): AnsweredThread | undefined {
  if (finding.severity === "P0") return undefined;
  return threads.find((thread) => thread.path === finding.path &&
    Math.abs(thread.line - finding.line) <= PRIOR_THREAD_MAX_LINE_DELTA && (
      wordSetJaccard(titleWords(finding.title), titleWords(thread.title)) >= PRIOR_THREAD_TITLE_JACCARD_THRESHOLD ||
      wordSetJaccard(titleWords(finding.body), titleWords(thread.body)) >= PRIOR_THREAD_BODY_JACCARD_THRESHOLD
    ));
}

/**
 * The gate exempts P0 from prior-thread matching, but self-consistency can later publish an
 * unconfirmed P0 as an advisory P2. Match those demoted comments again at the published severity so
 * an answered thread is not reposted (#1172).
 */
export function suppressAnsweredDemotedComments<T extends ReviewComment>(
  comments: T[],
  findings: Finding[],
  threads: AnsweredThread[]
): { comments: T[]; dropped: DroppedFinding[] } {
  if (!threads.length) return { comments, dropped: [] };
  const kept: T[] = [];
  const dropped: DroppedFinding[] = [];
  for (const comment of comments) {
    const original = comment.severityDemotedFrom === "P0"
      ? findings.find((finding) => buildFindingFingerprint(finding) === comment.fingerprint)
      : undefined;
    const thread = original && matchPriorThread({ ...original, severity: comment.severity }, threads);
    if (!thread) {
      kept.push(comment);
      continue;
    }
    dropped.push({ ...original, reason: "prior_thread_answered", threadId: thread.id });
  }
  return { comments: kept, dropped };
}

export function titleWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

export function wordSetJaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}
