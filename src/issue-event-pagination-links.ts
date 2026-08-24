export const ISSUE_EVENT_PAGE_SIZE = 100;
export type IssueEventRelation = "first" | "prev" | "next" | "last";
export type IssueEventRelations = Partial<Record<IssueEventRelation, number>>;

export type IssueEventLinkResult =
  | { kind: "absent" }
  | { kind: "present"; relations: IssueEventRelations };

export function parseIssueEventLink(input: {
  link?: unknown;
  apiOrigin: string;
  issueEventsPath: string;
  currentPage: unknown;
}): IssueEventLinkResult {
  if (typeof input.currentPage !== "number") invalid("current page");
  const currentPage = positivePage(input.currentPage, "current page");
  if (input.link === undefined || input.link === null) return { kind: "absent" };
  if (typeof input.link !== "string" || input.link.trim() === "") invalid("Link header");
  const origin = configuredOrigin(input.apiOrigin);
  if (typeof input.issueEventsPath !== "string" || !input.issueEventsPath.startsWith("/")) invalid("event path");
  const relations: IssueEventRelations = {};
  const seen = new Set<IssueEventRelation>();
  for (const part of input.link.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel=(?:"([^"]+)"|([^\s;,]+))\s*$/.exec(part);
    if (!match) invalid("Link member");
    const target = parseTarget(match[1]!, origin, input.issueEventsPath);
    const relationNames = (match[2] ?? match[3]!).split(/\s+/);
    if (relationNames.length === 0 || relationNames.some((name) => !isRelation(name))) invalid("relation");
    for (const name of relationNames) {
      const relation = name as IssueEventRelation;
      if (seen.has(relation)) invalid("duplicate relation");
      seen.add(relation);
      relations[relation] = target;
    }
  }
  if (seen.size === 0) invalid("empty relations");
  const { first, prev, next, last } = relations;
  if (first !== undefined && first !== 1) invalid("first relation");
  if (prev !== undefined && (currentPage === 1 || prev !== currentPage - 1)) invalid("prev relation");
  if (next !== undefined && (currentPage === Number.MAX_SAFE_INTEGER || next !== currentPage + 1)) invalid("next relation");
  if (last !== undefined && (last < currentPage || (last === currentPage && next !== undefined))) invalid("last relation");
  return { kind: "present", relations };
}

export type IssueEventPageCardinality = "empty" | "short" | "full";
export interface IssueEventPage<T> {
  page: number;
  items: T[];
  cardinality: IssueEventPageCardinality;
}

export function parseIssueEventPage<T>(input: {
  requestedPage: unknown;
  returnedPage: unknown;
  items: unknown;
}): IssueEventPage<T> {
  if (typeof input.requestedPage !== "number") invalid("requested page");
  const page = positivePage(input.requestedPage, "requested page");
  if (input.returnedPage !== page) invalid("returned page");
  if (!Array.isArray(input.items) || input.items.length > ISSUE_EVENT_PAGE_SIZE) invalid("page items");
  const items = input.items.slice() as T[];
  return {
    page,
    items,
    cardinality: items.length === 0 ? "empty" : items.length === ISSUE_EVENT_PAGE_SIZE ? "full" : "short"
  };
}

function parseTarget(raw: string, origin: string, path: string): number {
  if (/%(?![0-9a-f]{2})/i.test(raw)) invalid("URL escape");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("URL");
  }
  if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== path) invalid("URL target");
  const schemeEnd = raw.indexOf("://");
  const pathStart = raw.indexOf("/", schemeEnd + 3);
  const pathEnd = raw.search(/[?#]/);
  const rawPath = raw.slice(pathStart < 0 ? raw.length : pathStart, pathEnd < 0 ? raw.length : pathEnd);
  if (rawPath !== path) invalid("URL path");
  const query = url.search.slice(1);
  if (!query || query.startsWith("&") || query.endsWith("&") || query.includes("&&")) invalid("query");
  if (query.split("&").some((part) => !part.includes("="))) invalid("query member");
  const entries = [...url.searchParams.entries()];
  const pages = entries.filter(([key]) => key === "page").map(([, value]) => value);
  const perPages = entries.filter(([key]) => key === "per_page").map(([, value]) => value);
  if (entries.some(([key]) => key !== "page" && key !== "per_page") || pages.length !== 1 || perPages.length > 1) {
    invalid("query keys");
  }
  if (perPages.length === 1 && perPages[0] !== "100") invalid("per_page");
  return positivePage(pages[0], "page");
}

function configuredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("origin");
  }
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/") invalid("origin");
  return url.origin;
}

function positivePage(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^[1-9]\d*$/.test(String(value))) invalid(label);
  const page = Number(value);
  if (!Number.isSafeInteger(page)) invalid(label);
  return page;
}

function isRelation(value: string): value is IssueEventRelation {
  return value === "first" || value === "prev" || value === "next" || value === "last";
}

function invalid(label: string): never {
  throw new Error(`invalid issue-event ${label}`);
}
