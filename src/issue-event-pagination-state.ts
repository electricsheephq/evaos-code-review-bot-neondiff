import { matchesGitHubIssueEventEndpointIdentity, type GitHubIssueEventEndpointIdentity } from "./github-issue-event-endpoint-identity.js";
import { parseIssueEventLink, type IssueEventLinkMember } from "./issue-event-pagination-links.js";

export type IssueEventTerminal = "short_page" | "bounded_tail" | "event_history_unbounded";
export interface IssueEventPage<T> { page: number; items: T[]; link?: string | null; linkHeader?: string | null; }
export interface IssueEventPaginationReceipt<T> {
  items: T[]; pagesRead: number; rawCount: number; uniqueCount: number; duplicateCount: number;
  lastPage?: number; terminal: IssueEventTerminal; truncated: boolean; overflow: boolean;
}
type Relation = "first" | "prev" | "next" | "last";
type Relations = Partial<Record<Relation, number>>;
type CheckedPage<T> = { page: IssueEventPage<T>; relations?: Relations; present: boolean; valid: boolean };
const SIZE = 100, MAX = 200, RELATIONS = new Set<Relation>(["first", "prev", "next", "last"]);

export async function readIssueEventHistory<T extends { id?: unknown }>(input: {
  endpointIdentity: Readonly<GitHubIssueEventEndpointIdentity>;
  readPage: (page: number) => Promise<IssueEventPage<T>>;
}): Promise<IssueEventPaginationReceipt<T>> {
  const newest = new Map<string, T>(), tailKeys = new Set<string>();
  let anonymous = 0, pagesRead = 0, rawCount = 0, trustedRawCount = 0, skipped = false, lastPage: number | undefined;
  const add = (items: T[], tail = false) => {
    trustedRawCount += items.length;
    for (const item of items) {
      const value = item?.id;
      const known = (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.trim() !== "");
      const key = known ? `id:${String(value).trim()}` : `anonymous:${anonymous++}`;
      if (tail) tailKeys.add(key);
      newest.delete(key); newest.set(key, item);
    }
  };
  const finish = (terminal: IssueEventTerminal): IssueEventPaginationReceipt<T> => {
    const unsafe = terminal === "event_history_unbounded", all = unsafe ? [] : [...newest.values()];
    const uniqueCount = unsafe ? 0 : all.length;
    return {
      items: all.slice(-MAX), pagesRead, rawCount, uniqueCount,
      duplicateCount: unsafe ? 0 : trustedRawCount - uniqueCount,
      ...(lastPage === undefined ? {} : { lastPage }), terminal,
      truncated: unsafe || skipped || uniqueCount > MAX, overflow: unsafe
    };
  };
  const fail = () => finish("event_history_unbounded");
  const identity = input.endpointIdentity;
  try {
    if (!matchesGitHubIssueEventEndpointIdentity(identity, `${identity.origin}${identity.repositoryPath}`)) return fail();
  } catch { return fail(); }
  const read = async (requested: number): Promise<CheckedPage<T>> => {
    const candidate = await input.readPage(requested) as IssueEventPage<T> | null | undefined;
    pagesRead += 1;
    const items = Array.isArray(candidate?.items) ? candidate.items : [];
    rawCount += items.length;
    if (!candidate || !Number.isSafeInteger(candidate.page) || candidate.page !== requested || !Array.isArray(candidate.items) || items.length > SIZE) {
      return { page: candidate as IssueEventPage<T>, present: false, valid: false };
    }
    if (candidate.link != null && candidate.linkHeader != null && candidate.link !== candidate.linkHeader) return { page: candidate, present: true, valid: false };
    const link = candidate.link !== undefined && candidate.link !== null ? candidate.link : candidate.linkHeader;
    const present = link !== undefined && link !== null;
    if (!present) return { page: candidate, present: false, valid: true };
    try {
      const framed = parseIssueEventLink(link);
      if (framed.kind !== "present") return { page: candidate, present: true, valid: false };
      const parsed = relations(framed.members, identity);
      return { page: candidate, present: true, relations: parsed, valid: parsed !== undefined };
    } catch { return { page: candidate, present: true, valid: false }; }
  };
  const lastMatches = (r: Relations, page: number, last: number) => r.last === last || (page === last && r.last === undefined);
  const chain = (r: Relations | undefined, page: number, last: number) => Boolean(r && lastMatches(r, page, last) && (r.first === undefined || r.first === 1) && (page === 1 ? r.prev === undefined && (last === 1 ? r.next === undefined : r.next === 2) : r.prev === page - 1 && (page === last ? r.next === undefined : r.next === page + 1)));
  const terminalLinks = (r: Relations | undefined, page: number, last: number) => Boolean(r && lastMatches(r, page, last) && (r.first === undefined || r.first === 1) && r.prev === (page === 1 ? undefined : page - 1) && r.next === undefined);
  const tail = async (existing: number): Promise<IssueEventPaginationReceipt<T>> => {
    if (!lastPage || lastPage < existing) return fail();
    const start = Math.max(existing + 1, Math.max(2, lastPage - 4)); skipped = start > existing + 1;
    for (let page = start; page <= lastPage; page += 1) {
      const result = await read(page);
      if (!result.valid || !result.present || !chain(result.relations, page, lastPage)) return fail();
      const count = result.page.items.length;
      if (page < lastPage ? count !== SIZE : count < 1 || count > SIZE) return fail();
      add(result.page.items, true);
    }
    if (skipped && tailKeys.size < MAX) return fail();
    return finish("bounded_tail");
  };
  const first = await read(1);
  if (!first.valid) return fail();
  if (first.page.items.length < SIZE) {
    if (first.present && (first.page.items.length === 0 || !terminalLinks(first.relations, 1, 1))) return fail();
    lastPage = 1; add(first.page.items); return finish("short_page");
  }
  if (first.present) {
    if (!first.relations?.last || !chain(first.relations, 1, first.relations.last)) return fail();
    lastPage = first.relations.last; add(first.page.items);
    return lastPage === 1 ? finish("short_page") : tail(1);
  }
  const second = await read(2);
  if (!second.valid) return fail();
  if (second.page.items.length < SIZE) {
    if (second.present && !terminalLinks(second.relations, 2, second.page.items.length ? 2 : 1)) return fail();
    lastPage = second.page.items.length ? 2 : 1; add(first.page.items); if (second.page.items.length) add(second.page.items); return finish("short_page");
  }
  if (!second.present || !second.relations?.last || second.relations.last < 2 || !chain(second.relations, 2, second.relations.last)) return fail();
  lastPage = second.relations.last; add(first.page.items); add(second.page.items); return tail(2);
}

function relations(members: IssueEventLinkMember[], identity: Readonly<GitHubIssueEventEndpointIdentity>): Relations | undefined {
  const result: Relations = {}, seen = new Set<Relation>();
  for (const member of members) {
    const page = targetPage(member.target, identity);
    if (page === undefined) return;
    const relation = member.relation.startsWith('"') ? member.relation.slice(1, -1) : member.relation;
    for (const name of relation.toLowerCase().split(" ")) {
      if (!RELATIONS.has(name as Relation) || seen.has(name as Relation)) return;
      seen.add(name as Relation); result[name as Relation] = page;
    }
  }
  return seen.size ? result : undefined;
}

function targetPage(raw: string, identity: Readonly<GitHubIssueEventEndpointIdentity>): number | undefined {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return; }
  const endpoint = `${parsed.origin}${parsed.pathname}`;
  if (!matchesGitHubIssueEventEndpointIdentity(identity, endpoint) || !raw.startsWith(`${endpoint}?`)) return;
  const parts = raw.slice(endpoint.length + 1).split("&");
  if (parts.length !== 2) return;
  const pagePart = parts.find((part) => part.startsWith("page="));
  const perPart = parts.find((part) => part.startsWith("per_page="));
  if (!pagePart || !perPart || perPart !== "per_page=100" || !/^[1-9]\d*$/.test(pagePart.slice(5))) return;
  const page = Number(pagePart.slice(5));
  return Number.isSafeInteger(page) ? page : undefined;
}
