import { describe, expect, it } from "vitest";
import { readIssueEventHistory, type IssueEventPage } from "../src/issue-event-pagination.js";

type Event = { id: number; value?: string };
const origin = "https://api.github.com", path = "/repos/o/r/issues/7/events";
const events = (start: number, count = 100): Event[] => Array.from({ length: count }, (_, i) => ({ id: start + i }));
const url = (rel: string, page: string | number, suffix = "") => `<${origin}${path}?page=${page}${suffix}>; rel="${rel}"`;
const chain = (page: number, last: number, prev: number | null | undefined = page > 1 ? page - 1 : undefined, next: number | null | undefined = page < last ? page + 1 : undefined) =>
  [prev == null ? "" : url("prev", prev), next == null ? "" : url("next", next), url("last", last)].filter(Boolean).join(", ");
const run = async (pages: Record<number, IssueEventPage<Event>>) => readIssueEventHistory({ apiOrigin: origin, issueEventsPath: path, readPage: async (page) => pages[page] ?? { page, items: [] } });

describe("strict issue-event pagination state machine", () => {
  it("handles short history, exact-100 probe, nonempty page 2, and full/no-Link overflow", async () => {
    expect((await run({ 1: { page: 1, items: events(1, 3) } })).terminal).toBe("short_page");
    const exact = await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: [] } });
    expect(exact).toMatchObject({ rawCount: 100, pagesRead: 2, lastPage: 1, terminal: "short_page", overflow: false });
    const two = await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: events(101, 3) } });
    expect(two).toMatchObject({ rawCount: 103, pagesRead: 2, lastPage: 2, terminal: "short_page" });
    expect((await run({ 1: { page: 1, items: events(1) }, 2: { page: 2, items: events(101) } })).terminal).toBe("event_history_unbounded");
  });

  it("validates a five-page tail, overlap, newest duplicate, and newest-200 receipt", async () => {
    const pages: Record<number, IssueEventPage<Event>> = { 1: { page: 1, items: events(1), link: chain(1, 5) } };
    for (let page = 2; page <= 5; page += 1) pages[page] = { page, items: page === 5 ? [{ id: 400, value: "newest" }, ...events(401, 49)] : events(page === 2 ? 101 : page === 3 ? 201 : 301), link: chain(page, 5) };
    const result = await run(pages);
    expect(result).toMatchObject({ rawCount: 450, uniqueCount: 449, duplicateCount: 1, pagesRead: 5, lastPage: 5, terminal: "bounded_tail", truncated: true, overflow: false });
    expect(result.items).toHaveLength(200); expect(result.items.find((event) => event.id === 400)?.value).toBe("newest");
  });

  it("fails closed for hostile links and contradictory chains", async () => {
    const hostile = [`<${origin}${path}?page=2>; rel="next", <${origin}${path}?page=3>; rel="next"`, `<${origin}${path}?page=2>; rel="next"`, `<https://evil.test/x?page=2>; rel="next"`, `<${origin}/wrong?page=2>; rel="next"`, `<${origin}${path}?page=2&page=2>; rel="next"`, `<${origin}${path}?page=0>; rel="next"`, `<${origin}${path}?page=no>; rel="next"`, `<${origin}${path}?page=2; rel="next"`, `<${origin}${path}?page=2>; rel="bogus"`];
    for (const link of hostile) expect((await run({ 1: { page: 1, items: events(1), link } })).terminal).toBe("event_history_unbounded");
    const bad = (page: number, link: string, items = events(page * 100 + 1)) => run({ 1: { page: 1, items: events(1), link: chain(1, 5) }, 4: { page: 4, items, link }, 2: { page: 2, items: events(101), link: chain(2, 5) }, 3: { page: 3, items: events(201), link: chain(3, 5) }, 5: { page: 5, items: events(401, 2), link: chain(5, 5) } });
    for (const [page, link, items] of [[4, chain(4, 4), events(301)], [4, chain(4, 6, 3, 5), events(301)], [4, chain(4, 5, 2, 5), events(301)], [4, chain(4, 5, 3, null), events(301)], [4, chain(4, 5, 3, 5), events(301, 1)], [5, chain(5, 5, 3), events(401, 2)] ] as const) expect((await bad(page, link, items)).terminal).toBe("event_history_unbounded");
    expect((await run({ 1: { page: 1, items: events(1), link: `${url("next", 2)}, ${url("last", 1)}` } })).terminal).toBe("event_history_unbounded");
  });
});
