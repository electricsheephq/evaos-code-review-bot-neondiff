import { describe, expect, it } from "vitest";
import { readIssueEventHistory } from "../src/issue-event-pagination.js";

type Event = { id: number; value?: string };
const origin = "https://api.github.com";
const path = "/repos/owner/repo/issues/970/events";
const events = (page: number, count = 100): Event[] => Array.from({ length: count }, (_unused, index) => ({ id: page * 100 + index }));
const link = (relation: string, page: number) => `<${origin}${path}?per_page=100&page=${page}>; rel="${relation}"`;
const chain = (page: number, last: number) => [
  page > 1 ? link("prev", page - 1) : "",
  page < last ? link("next", page + 1) : "",
  link("last", last)
].filter(Boolean).join(", ");
const run = (pages: Record<number, { page: number; items: Event[]; link?: string }>, repositoryId?: number) => readIssueEventHistory<Event>({ apiOrigin: origin, issueEventsPath: path, repositoryId, readPage: async (page) => pages[page] ?? { page, items: [] } });
describe("strict issue-event pagination state machine", () => {
  it("rejects an empty advertised final page without admitting older tail rows", async () => {
    const pagesRequested: number[] = [];
    const result = await readIssueEventHistory<Event>({
      apiOrigin: origin,
      issueEventsPath: path,
      readPage: async (page) => {
        pagesRequested.push(page);
        return { page, items: page === 8 ? [] : events(page), link: chain(page, 8) };
      }
    });
    expect(pagesRequested).toEqual([1, 4, 5, 6, 7, 8]);
    expect(result.items).toHaveLength(0);
    expect(result).toMatchObject({ pagesRead: 6, rawCount: 500, lastPage: 8, terminal: "event_history_unbounded", truncated: true, overflow: true });
  });
  it("rejects malformed tail metadata while counting every received row", async () => {
    const pagesRequested: number[] = [];
    const result = await readIssueEventHistory<Event>({
      apiOrigin: origin,
      issueEventsPath: path,
      readPage: async (page) => {
        pagesRequested.push(page);
        return {
          page,
          items: events(page),
          link: page === 4 ? `<https://evil.invalid${path}?per_page=100&page=4>; rel="next"` : chain(page, 8)
        };
      }
    });
    expect(pagesRequested).toEqual([1, 4]);
    expect(result.items).toHaveLength(0);
    expect(result).toMatchObject({ pagesRead: 2, rawCount: 200, lastPage: 8, terminal: "event_history_unbounded", truncated: true, overflow: true });
  });
  it("handles short history and exact full-page probes", async () => {
    expect((await run({ 1: { page: 1, items: events(1, 3) } })).terminal).toBe("short_page"); expect((await run({ 1: { page: 1, items: [], link: link("last", 1) } })).terminal).toBe("event_history_unbounded");
    expect(await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: [] } })).toMatchObject({ rawCount: 100, pagesRead: 2, lastPage: 1, terminal: "short_page" });
    expect(await run({ 1: { page: 1, items: events(1), link: `<${origin}/repositories/1285247004/issues/970/events?per_page=100&page=2>; rel="next", <${origin}/repositories/1285247004/issues/970/events?per_page=100&page=2>; rel="last"` }, 2: { page: 2, items: events(2, 3), link: `<${origin}/repositories/1285247004/issues/970/events?per_page=100&page=1>; rel="prev", <${origin}/repositories/1285247004/issues/970/events?per_page=100&page=1>; rel="first"` } }, 1285247004)).toMatchObject({ rawCount: 103, pagesRead: 2, lastPage: 2, terminal: "bounded_tail", truncated: false });
    expect((await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: events(2) } })).terminal).toBe("event_history_unbounded");
  });
  it("fails closed on hostile or contradictory pagination metadata", async () => {
    const invalid: Array<[string | undefined, number]> = [[undefined, 100], [chain(4, 9), 100], [chain(4, 7), 100], [`${link("prev", 2)}, ${link("next", 5)}, ${link("last", 8)}`, 100], [`<${origin}/repos/owner/repo/issues/971/events?per_page=100&page=3>; rel="prev"`, 100], [`<${origin}${path}?per_page=100&page=3&page=4>; rel="prev"`, 100], [`${link("prev", 3)}, ${link("prev", 3)}, ${link("next", 5)}, ${link("last", 8)}`, 100], [chain(4, 8), 50]];
    for (const [raw, count] of invalid) expect((await run({ 1: { page: 1, items: events(1), link: chain(1, 8) }, 4: { page: 4, items: events(4, count), link: raw } })).terminal).toBe("event_history_unbounded");
    expect((await run({ 1: { page: 1, items: events(1), link: `${link("next", 2)}, ${link("last", 1)}` } })).terminal).toBe("event_history_unbounded");
  });
  it("retains newest duplicates and propagates transport failures", async () => {
    const pages = Object.fromEntries([1, 2, 3, 4, 5].map((page) => [page, { page, items: page === 5 ? [{ id: 450, value: "new" }, ...events(page, 49)] : events(page), link: chain(page, 5) }]));
    pages[4].items[50] = { id: 450, value: "old" };
    const result = await run(pages);
    expect(result).toMatchObject({ rawCount: 450, uniqueCount: 449, duplicateCount: 1, pagesRead: 5, terminal: "bounded_tail", truncated: true, overflow: false });
    expect(result.items).toHaveLength(200); expect(result.items.at(-1)?.id).toBe(548);
    expect(result.items.find((event) => event.id === 450)?.value).toBe("new");
    await expect(readIssueEventHistory({ apiOrigin: origin, issueEventsPath: path, readPage: async (page) => { if (page === 4) throw new Error("transport"); return { page, items: events(page), link: chain(page, 8) }; } })).rejects.toThrow("transport");
  });
});
