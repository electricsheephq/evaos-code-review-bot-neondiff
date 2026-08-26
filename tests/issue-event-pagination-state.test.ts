import { describe, expect, it } from "vitest";
import { resolveGitHubIssueEventEndpointIdentity } from "../src/github-issue-event-endpoint-identity.js";
import { readIssueEventHistory, type IssueEventPage } from "../src/issue-event-pagination-state.js";

type Event = { id: number; value?: string };
const resolved = resolveGitHubIssueEventEndpointIdentity({ apiBaseUrl: "https://api.github.com", repository: "owner/repo", repositoryId: 42, issueNumber: 990 });
if (!resolved.ok) throw new Error("test identity setup failed");
const identity = resolved.identity;
const events = (page: number, count = 100): Event[] => Array.from({ length: count }, (_unused, index) => ({ id: page * 100 + index }));
const link = (relation: string, page: number, path = identity.repositoryPath) => `<${identity.origin}${path}?per_page=100&page=${page}>; rel="${relation}"`;
const chain = (page: number, last: number) => [page > 1 ? link("prev", page - 1) : "", page < last ? link("next", page + 1) : "", link("last", last)].filter(Boolean).join(
  ", "
);
const terminal = (page: number) => [link("first", 1), link("prev", page - 1)].join(", ");
const run = (pages: Record<number, IssueEventPage<Event>>) => readIssueEventHistory({ endpointIdentity: identity, readPage: async (page) => pages[page] ?? { page, items: [] } });

describe("strict issue-event pagination state", () => {
  it("rejects an empty advertised final page without admitting older tail rows", async () => {
    const requested: number[] = [];
    const result = await readIssueEventHistory<Event>({ endpointIdentity: identity, readPage: async (page) => {
      requested.push(page);
      return { page, items: page === 8 ? [] : events(page), link: chain(page, 8) };
    } });
    expect(requested).toEqual([1, 4, 5, 6, 7, 8]);
    expect(result).toMatchObject({ items: [], pagesRead: 6, rawCount: 500, uniqueCount: 0, lastPage: 8, terminal: "event_history_unbounded", truncated: true, overflow: true });
  });

  it("counts rows from a malformed tail response but trusts none of it", async () => {
    const requested: number[] = [];
    const result = await readIssueEventHistory<Event>({ endpointIdentity: identity, readPage: async (page) => {
      requested.push(page);
      return { page, items: events(page), link: page === 4 ? `<https://evil.invalid${identity.repositoryPath}?per_page=100&page=4>; rel="next"` : chain(page, 8) };
    } });
    expect(requested).toEqual([1, 4]);
    expect(result).toMatchObject({ items: [], pagesRead: 2, rawCount: 200, uniqueCount: 0, lastPage: 8, terminal: "event_history_unbounded", truncated: true, overflow: true });
  });

  it("handles short pages, exact probes, bounded tails, dedupe, and transport errors", async () => {
    expect((await run({ 1: { page: 1, items: events(1, 3) } })).terminal).toBe("short_page");
    expect(await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: [] } })).toMatchObject({ pagesRead: 2, rawCount: 100, lastPage: 1, terminal: "short_page" });
    expect(await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: events(2, 3), link: terminal(2) }, 3: { page: 3, items: [] } })).toMatchObject({ rawCount: 103, lastPage: 2, terminal: "short_page" });
    expect(await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: events(2) } })).toMatchObject({ terminal: "event_history_unbounded", truncated: true, overflow: true });
    const pages: Record<number, IssueEventPage<Event>> = {};
    for (let page = 1; page <= 5; page += 1) pages[page] = { page, items: page === 5 ? [{ id: 450, value: "new" }, ...events(page, 49)] : events(page), link: page === 5 ? terminal(page) : chain(page, 5) };
    pages[4].items[50] = { id: 450, value: "old" };
    const bounded = await run(pages);
    expect(bounded).toMatchObject({ rawCount: 450, uniqueCount: 449, duplicateCount: 1, pagesRead: 5, lastPage: 5, terminal: "bounded_tail", truncated: true, overflow: false });
    expect(bounded.items).toHaveLength(200); expect(bounded.items.find((event) => event.id === 450)?.value).toBe("new");
    await expect(readIssueEventHistory({ endpointIdentity: identity, readPage: async (page) => { if (page === 4) throw new Error("transport"); return { page, items: events(page), link: chain(page, 8) }; } })).rejects.toThrow("transport");
  });

  it("rejects hostile, incomplete, and contradictory Link/page metadata", async () => {
    const badFirst = [`<https://evil.invalid${identity.repositoryPath}?per_page=100&page=2>; rel="next"`, link("next", 2, "/wrong"), link("next", 2).replace("per_page=100", "per_page=99"), link("next", 2).replace("page=2", "page=2&page=2"), `${link("next", 2)}, ${link("next", 2)}`, `${link("next", 2)}, ${link("last", 1)}`];
    for (const raw of badFirst) expect((await run({ 1: { page: 1, items: events(1), link: raw } })).terminal).toBe("event_history_unbounded");
    const badTail = [undefined, chain(4, 9), chain(4, 7), chain(4, 8).replace("page=3", "page=2"), chain(4, 8).replace("page=5", "page=6"), chain(4, 8).replace("page=3", "page=3&page=3")];
    for (const raw of badTail) expect((await run({ 1: { page: 1, items: events(1), link: chain(1, 8) }, 4: { page: 4, items: events(4, raw === chain(4, 8) ? 99 : 100), link: raw } })).terminal).toBe("event_history_unbounded");
    expect((await run({ 1: { page: 1, items: events(1), link: `${link("next", 2)}, ${link("last", 1)}` } })).terminal).toBe("event_history_unbounded");
  });
});
