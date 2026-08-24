export type IssueEventTerminal = "short_page" | "bounded_tail" | "event_history_unbounded";

export interface IssueEventPage<T> {
  page: number;
  items: T[];
  link?: string | null;
  linkHeader?: string | null;
}

export interface IssueEventPaginationReceipt<T> {
  items: T[];
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  pagesRead: number;
  lastPage?: number;
  terminal: IssueEventTerminal;
  truncated: boolean;
  overflow: boolean;
}

interface Relations {
  first?: number;
  prev?: number;
  next?: number;
  last?: number;
}

interface ReadPage<T> {
  page: IssueEventPage<T>;
  relations?: Relations;
  present: boolean;
}

const PAGE_SIZE = 100;
const MAX_ITEMS = 200;
const RELATIONS = new Set(["first", "prev", "next", "last"]);

export async function readIssueEventHistory<T extends { id?: unknown }>(input: {
  readPage: (page: number) => Promise<IssueEventPage<T>>;
  apiOrigin: string;
  issueEventsPath: string;
}): Promise<IssueEventPaginationReceipt<T>> {
  const latest = new Map<string, T>();
  let anonymous = 0, rawCount = 0, pagesRead = 0, lastPage: number | undefined;
  const add = (items: T[]) => {
    rawCount += items.length;
    for (const event of items) {
      const value = event?.id;
      const known = (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && Boolean(value.trim()));
      const id = known ? `id:${String(value)}` : `anonymous:${anonymous++}`;
      latest.delete(id);
      latest.set(id, event);
    }
  };
  const receipt = (terminal: IssueEventTerminal): IssueEventPaginationReceipt<T> => {
    const items = [...latest.values()];
    const uniqueCount = items.length;
    const overflow = terminal === "event_history_unbounded";
    return {
      items: items.slice(-MAX_ITEMS), rawCount, uniqueCount, duplicateCount: rawCount - uniqueCount,
      pagesRead, ...(lastPage === undefined ? {} : { lastPage }), terminal,
      truncated: overflow || uniqueCount > MAX_ITEMS, overflow
    };
  };
  const read = async (requested: number): Promise<ReadPage<T>> => {
    const page = await input.readPage(requested);
    if (!Number.isSafeInteger(page.page) || page.page !== requested || !Array.isArray(page.items)) throw new Error("invalid issue-event page");
    pagesRead += 1; add(page.items);
    const rawLink = page.link ?? page.linkHeader;
    const present = rawLink !== undefined && rawLink !== null;
    const relations = present ? parseRelations(rawLink!, input.apiOrigin, input.issueEventsPath) : undefined;
    return { page, relations, present };
  };
  const fail = () => receipt("event_history_unbounded");
  const readSafe = async (page: number) => {
    try { return await read(page); } catch { return undefined; }
  };
  const chain = (relations: Relations | undefined, page: number, last: number) => Boolean(
    relations && relations.last === last && (relations.first === undefined || relations.first === 1) &&
    (page === 1 ? relations.prev === undefined && (last === 1 ? relations.next === undefined : relations.next === 2)
      : relations.prev === page - 1 && (page === last ? relations.next === undefined : relations.next === page + 1))
  );
  const terminalLinks = (relations: Relations | undefined, page: number, last: number) => Boolean(
    relations && relations.last === last && (relations.first === undefined || relations.first === 1) &&
    relations.prev === undefined && relations.next === undefined
  );
  const tail = async (existing: number, first: ReadPage<T>): Promise<IssueEventPaginationReceipt<T>> => {
    if (!first.relations?.last || first.relations.last < existing || !chain(first.relations, existing, lastPage!)) return fail();
    const start = Math.max(1, lastPage! - 4);
    for (let page = Math.max(existing + 1, start); page <= lastPage!; page += 1) {
      const next = await readSafe(page);
      if (!next || !next.present || !chain(next.relations, page, lastPage!) || (page < lastPage! && next.page.items.length < PAGE_SIZE)) return fail();
    }
    return receipt("bounded_tail");
  };

  const first = await readSafe(1);
  if (!first) return fail();
  if (first.page.items.length < PAGE_SIZE) {
    if (first.present && (!first.relations || !terminalLinks(first.relations, 1, 1))) return fail();
    lastPage = 1; return receipt("short_page");
  }
  if (first.present) {
    if (!first.relations?.last || first.relations.last < 1) return fail();
    lastPage = first.relations.last;
    if (lastPage === 1) return chain(first.relations, 1, 1) ? receipt("short_page") : fail();
    return tail(1, first);
  }
  const second = await readSafe(2);
  if (!second) return fail();
  if (second.page.items.length < PAGE_SIZE) {
    const terminalLast = second.page.items.length ? 2 : 1;
    if (second.present && (!second.relations || !terminalLinks(second.relations, 2, terminalLast))) return fail();
    lastPage = terminalLast; return receipt("short_page");
  }
  if (!second.present || !second.relations?.last || second.relations.last < 2) return fail();
  lastPage = second.relations.last;
  return tail(2, second);
}

function parseRelations(value: string, origin: string, path: string): Relations | undefined {
  const result: Relations = {}, seen = new Set<string>();
  if (!value.trim()) return undefined;
  for (const part of value.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))\s*$/.exec(part);
    if (!match) return undefined;
    let url: URL;
    try { url = new URL(match[1]!); } catch { return undefined; }
    const pageValues = [...url.searchParams.entries()].filter(([key]) => key.toLowerCase() === "page").map(([, page]) => page);
    if (url.origin !== origin || url.username || url.password || url.pathname !== path || url.hash || pageValues.length !== 1) return undefined;
    const page = pageValues[0]!;
    if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) return undefined;
    for (const name of (match[2] ?? match[3] ?? match[4]!).toLowerCase().split(/\s+/)) {
      if (!RELATIONS.has(name) || seen.has(name)) return undefined;
      seen.add(name); result[name as keyof Relations] = Number(page);
    }
  }
  return seen.size ? result : undefined;
}
