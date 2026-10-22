import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// Repo-only native tool; never imported by the packaged CLI.
// @ts-expect-error JavaScript repo tool has no declarations.
import { readCorpus, writeFindingsFile, nativePrompt } from "../scripts/reviewbench/run-local.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nd-rb-")); roots.push(root); mkdirSync(join(root, "corpus/test"), { recursive: true });
  const task = { repo: "https://github.com/fixture/repo", nwo: "fixture/repo", pr_number: 3, base: "a".repeat(40), head: "b".repeat(40), title: "Fixture", body: "Body" };
  writeFileSync(join(root, "corpus/manifest.json"), JSON.stringify([task, { ...task, pr_number: 4 }]));
  writeFileSync(join(root, "corpus/test/test.json"), JSON.stringify([task])); return { root, task };
}
it("reads test/full corpus arrays dynamically from a tiny fake clone", () => {
  const { root, task } = fixture(); expect(readCorpus(root, "test")).toEqual([task]); expect(readCorpus(root, "full")).toHaveLength(2);
  writeFileSync(join(root, "corpus/test/test.json"), JSON.stringify({ tasks: [task] }));
  expect(() => readCorpus(root, "test")).toThrow(/unexpected.*shape/i);
  expect(() => readCorpus(root, "other")).toThrow(/test.*full/i);
});
it("rejects malformed corpus entries clearly without hardcoding tasks", () => {
  const { root, task } = fixture();
  for (const bad of [{ ...task, head: undefined }, { ...task, nwo: "../escape" }, { ...task, pr_number: "3" }]) {
    writeFileSync(join(root, "corpus/test/test.json"), JSON.stringify([bad])); expect(() => readCorpus(root, "test")).toThrow(/unexpected.*shape/i);
  }
});
it("atomically writes validated ReviewBench findings, including empty findings", () => {
  const { root, task } = fixture(), out = join(root, "out.json");
  const finding = { file: "src/a.ts", start_line: 2, end_line: 3, message: "Bad value." };
  writeFindingsFile(out, task, "codex-native", [finding], { time_in_ms: 2, total_tokens: 10 });
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ pr: { head: task.head, pr_number: 3 }, agent: "codex-native", findings: [{ ...finding, producer: "codex-native" }] });
  writeFindingsFile(out, task, "neondiff", [], { time_in_ms: 1 }); expect(JSON.parse(readFileSync(out, "utf8")).findings).toEqual([]);
  expect(readdirSync(root).some(x => x.includes(".tmp-"))).toBe(false);
  expect(() => writeFindingsFile(out, task, "x", [{ ...finding, file: "../escape" }], {})).toThrow(/finding/i);
  expect(nativePrompt(task)).toBe(`Review the change between ${task.base} and ${task.head} in this repository (the diff is in diff.patch). Report real defects introduced by the change: file, start_line, end_line at head, and a message that says what is wrong and why. Report nothing if there are none.`);
});
