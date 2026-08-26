import { parseIssueEventLink } from "./issue-event-pagination-links.js";
export type IssueEventTerminal = "short_page" | "bounded_tail" | "event_history_unbounded";
export interface IssueEventPage<T> { page: number; items: T[]; link?: string | null; linkHeader?: string | null; }
export interface IssueEventPaginationReceipt<T> { items: T[]; rawCount: number; uniqueCount: number; duplicateCount: number; pagesRead: number; lastPage?: number; terminal: IssueEventTerminal; truncated: boolean; overflow: boolean; }
interface Relations { first?: number; prev?: number; next?: number; last?: number; }
interface ReadPage<T> { page?: IssueEventPage<T>; relations?: Relations; present: boolean; valid: boolean; }
const PAGE_SIZE = 100, MAX_ITEMS = 200, RELATIONS = new Set(["first", "prev", "next", "last"]);

export async function readIssueEventHistory<T extends { id?: unknown }>(input: { readPage: (page: number) => Promise<IssueEventPage<T>>; apiOrigin: string; issueEventsPath: string }): Promise<IssueEventPaginationReceipt<T>> {
  const newest = new Map<string, T>();
  let anonymous = 0, trustedRawCount = 0, rawCount = 0, pagesRead = 0, skippedPages = false, lastPage: number | undefined;
  const add = (items: T[]) => {
    trustedRawCount += items.length;
    for (const event of items) {
      const value = event?.id;
      const known = Number.isSafeInteger(value) || (typeof value === "string" && value.trim().length > 0);
      const key = known ? `id:${String(value).trim()}` : `anonymous:${anonymous++}`;
      newest.delete(key);
      newest.set(key, event);
    }
  };
  const receipt = (terminal: IssueEventTerminal): IssueEventPaginationReceipt<T> => {
    const untrusted = terminal === "event_history_unbounded";
    const allItems = untrusted ? [] : [...newest.values()];
    const uniqueCount = untrusted ? 0 : allItems.length;
    return {
      items: allItems.slice(-MAX_ITEMS), rawCount, uniqueCount,
      duplicateCount: untrusted ? 0 : trustedRawCount - uniqueCount,
      pagesRead, ...(lastPage === undefined ? {} : { lastPage }), terminal,
      truncated: untrusted || skippedPages || uniqueCount > MAX_ITEMS,
      overflow: untrusted
    };
  };
  const fail = () => receipt("event_history_unbounded");
  const read = async (requested: number): Promise<ReadPage<T>> => {
    // Do not catch this call: provider/network failures are transport failures, not metadata failures.
    const candidate = await input.readPage(requested) as IssueEventPage<T> | null | undefined;
    pagesRead += 1;
    const items = Array.isArray(candidate?.items) ? candidate.items : [];
    rawCount += items.length;
    if (!candidate || !Number.isSafeInteger(candidate.page) || candidate.page !== requested || !Array.isArray(candidate.items)) {
      return { present: false, valid: false };
    }
    const hasLink = candidate.link !== undefined && candidate.link !== null;
    const hasHeader = candidate.linkHeader !== undefined && candidate.linkHeader !== null;
    if (hasLink && hasHeader && candidate.link !== candidate.linkHeader) return { page: candidate, present: true, valid: false };
    const value = hasLink ? candidate.link : hasHeader ? candidate.linkHeader : undefined;
    if (value === undefined) return { page: candidate, present: false, valid: true };
    const relations = parseRelations(value, input.apiOrigin, input.issueEventsPath);
    return { page: candidate, relations: relations ?? undefined, present: true, valid: relations !== null };
  };
  const chain = (relations: Relations | undefined, page: number, last: number): boolean => Boolean(
    relations && (relations.last === last || (page === last && relations.last === undefined)) && (relations.first === undefined || relations.first === 1) &&
    (page === 1
      ? relations.prev === undefined && (last === 1 ? relations.next === undefined : relations.next === 2)
      : relations.prev === page - 1 && (page === last ? relations.next === undefined : relations.next === page + 1))
  );
  const terminalLinks = (relations: Relations | undefined, page: number, last: number): boolean => Boolean(
    relations && (relations.last === last || (page === last && relations.last === undefined)) && (relations.first === undefined || relations.first === 1) &&
    relations.prev === (page === 1 ? undefined : page - 1) && relations.next === undefined
  );
  const tail = async (existing: number): Promise<IssueEventPaginationReceipt<T>> => {
    if (!lastPage || lastPage < existing) return fail();
    const start = Math.max(existing + 1, Math.max(2, lastPage - 4)); skippedPages = start > existing + 1;
    for (let page = start; page <= lastPage; page += 1) {
      const result = await read(page);
      if (!result.valid || !result.present || !chain(result.relations, page, lastPage)) return fail();
      const items = result.page!.items;
      if (page < lastPage ? items.length !== PAGE_SIZE : items.length < 1 || items.length > PAGE_SIZE) return fail();
      add(items);
    }
    return receipt("bounded_tail");
  };
  const first = await read(1);
  if (!first.valid) return fail();
  const firstItems = first.page!.items;
  if (firstItems.length > PAGE_SIZE) return fail();
  if (firstItems.length < PAGE_SIZE) {
    if (first.present && (firstItems.length === 0 || !terminalLinks(first.relations, 1, 1))) return fail();
    lastPage = 1;
    add(firstItems);
    return receipt("short_page");
  }
  if (first.present) {
    if (!first.relations?.last || !chain(first.relations, 1, first.relations.last)) return fail();
    lastPage = first.relations.last;
    add(firstItems);
    return lastPage === 1 ? receipt("short_page") : tail(1);
  }
  const second = await read(2);
  if (!second.valid) return fail();
  const secondItems = second.page!.items;
  if (secondItems.length > PAGE_SIZE) return fail();
  if (secondItems.length < PAGE_SIZE) {
    if (second.present && (secondItems.length === 0 || !terminalLinks(second.relations, 2, 2))) return fail();
    lastPage = secondItems.length === 0 ? 1 : 2;
    add(firstItems);
    if (secondItems.length > 0) add(secondItems);
    return receipt("short_page");
  }
  if (!second.present || !second.relations?.last || second.relations.last < 2 || !chain(second.relations, 2, second.relations.last)) return fail();
  lastPage = second.relations.last;
  add(firstItems);
  add(secondItems);
  return tail(2);
}
function parseRelations(value: unknown, origin: string, path: string): Relations | null {
  if (typeof value !== "string") return null;
  let parsed: ReturnType<typeof parseIssueEventLink>;
  try { parsed = parseIssueEventLink(value); } catch { return null; }
  if (parsed.kind === "absent") return null;
  const result: Relations = {}, seen = new Set<string>();
  for (const member of parsed.members) {
    let target: URL;
    try { target = new URL(member.target); } catch { return null; }
    const keys = [...target.searchParams.keys()];
    const pageValues = target.searchParams.getAll("page");
    const perPageValues = target.searchParams.getAll("per_page");
    if (target.origin !== origin || target.pathname !== path || target.username || target.password || target.hash
      || keys.length !== 2 || pageValues.length !== 1 || perPageValues.length !== 1 || perPageValues[0] !== "100"
      || keys.some((key) => key !== "page" && key !== "per_page") || !/^[1-9]\d*$/.test(pageValues[0]!)) return null;
    const page = Number(pageValues[0]);
    if (!Number.isSafeInteger(page)) return null;
    const relation = member.relation.startsWith('"') ? member.relation.slice(1, -1) : member.relation;
    for (const name of relation.toLowerCase().split(/\s+/)) {
      if (!RELATIONS.has(name) || seen.has(name)) return null;
      seen.add(name);
      result[name as keyof Relations] = page;
    }
  }
  return seen.size > 0 ? result : null;
}
