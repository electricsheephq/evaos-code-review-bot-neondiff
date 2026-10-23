import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isLeanReleaseVersion } from "../src/release-version.js";
import { readPublicReleaseManifestStatus } from "../src/release-status.js";
// @ts-expect-error Repository scripts run directly under Node 26.
import { classifyLeanRelease, hasDesktopOnlyMarker, isNewerStableVersion, publishLeanRelease, requireAnnotatedLeanTag } from "../scripts/release-npm.mjs";

describe("lean npm release routing", () => {
  it("keeps 1.0.6 ledger-gated and exempts 1.1.0 without claiming publication", () => {
    const status = (expectedVersion: string) => readPublicReleaseManifestStatus({
      cwd: process.cwd(), manifestPath: "docs/public-release-manifest.json", expectedVersion
    });
    expect(status("v1.0.6").npmPublication.requiredForThisRelease).toBe(true);
    expect(status("v1.1.0").npmPublication).toMatchObject({
      ok: true, requiredForThisRelease: false, state: "lean_workflow"
    });
    expect(status("v1.1.0").ok).toBe(false);
  });

  it("reuses the exact Desktop-only annotation before package compatibility", () => {
    const release = { tag_name: "v1.1.0", prerelease: false, draft: false };
    expect(classifyLeanRelease("v1.1.0", release, "NeonDiff-Release-Class: desktop-only\n")).toBe(false);
    expect(classifyLeanRelease("v1.1.0", release, "")).toBe(true);
    expect(classifyLeanRelease("v1.1.0", { ...release, prerelease: true }, "")).toBe(false);
    expect(classifyLeanRelease("v1.0.6", { ...release, tag_name: "v1.0.6" }, "")).toBe(false);
  });
  it.each([
    ["1.0.6", false], ["v1.0.6", false], ["1.1.0", true],
    ["v1.1.1", true], ["2.0.0", true], ["1.1.0-rc.1", false],
    ["1.1.0+build", false], ["01.1.0", false], ["invalid", false]
  ])("classifies %s as lean=%s", (version, expected) => {
    expect(isLeanReleaseVersion(version)).toBe(expected);
  });

  it.each([
    ["release", "v1.0.6", true], ["release", "v1.1.0", false],
    ["release", "v2.0.0", false], ["workflow_dispatch", "v1.1.0", false],
    ["workflow_dispatch", "v1.0.6", true], ["workflow_dispatch", "v2.3.4", false],
    ["release", "v1.1.0-beta.90", false], ["release", "v1.1.0-rc.1", false],
    ["release", "v1.1.0-beta.90", true, false], ["workflow_dispatch", "v1.1.0-beta.90", true],
    ["release", "v1.2.0-beta.1", true], ["release", "v1.0.6-rc.1", true],
    ["release", "v1.1.0-beta.", true], ["release", "v1.1.0-beta..90", true],
    ["release", "v1.1.0-beta.0", true], ["release", "v1.1.0+build", true]
  ] as [string, string, boolean, boolean?][])("routes legacy %s %s", (eventName, tag, expected, prerelease = tag.includes("-")) => {
    const workflow = parse(readFileSync(".github/workflows/publish-npm.yml", "utf8"));
    const script = workflow.jobs.release_route.steps[0].with.script;
    const outputs: Record<string, boolean> = {};
    const notices: string[] = [];
    new Function("context", "core", script)(
      { eventName, payload: eventName === "release" ? { release: { tag_name: tag, prerelease } } : { inputs: { tag } } },
      { setOutput: (key: string, value: boolean) => { outputs[key] = value; }, notice: (value: string) => notices.push(value) }
    );
    expect(outputs.legacy).toBe(expected);
    expect(notices).toEqual(expected ? [] : ["handled by release-npm.yml"]);
    expect(workflow.jobs.publish.needs).toBe("release_route");
    expect(workflow.jobs.publish.if).toContain("needs.release_route.outputs.legacy == 'true'");
  });
});

describe("lean npm publication sequence", () => {
  const pack = { name: "neondiff", version: "1.1.0", shasum: "a".repeat(40), integrity: "sha512-fixture" };
  it.each([
    ["1.2.0", "1.1.0", true], ["1.1.0", "1.1.0", false], ["1.0.6", "1.1.0", false],
    ["1.10.0", "1.9.0", true], ["2.0.0-rc.1", "1.1.0", false], [undefined, "1.1.0", false]
  ])("isNewerStableVersion(%s, %s) = %s", (candidate, version, expected) => {
    expect(isNewerStableVersion(candidate, version)).toBe(expected);
  });
  const fixtureRun = (calls: string[], tags: Record<string, string>, published = true) => (args: string[]) => {
    calls.push(args.join(" "));
    if (args[2] === "dist.shasum" && !published) return { status: 1, stdout: "", stderr: "E404" };
    const value = args[2] === "dist.shasum" ? pack.shasum : args[2] === "dist.integrity" ? pack.integrity : args[2] === "dist-tags.latest" ? tags.latest :
      args[2] === "dist-tags" ? tags :
      args[2] === "dist.attestations.url" ? "https://registry.npmjs.org/-/npm/v1/attestations/neondiff@1.1.0" :
      args[0] === "audit" ? { invalid: [], missing: [], verified: [{ name: "neondiff", version: "1.1.0", attestations: {} }] } : {};
    return { status: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  it("removes next only while it points at this release", async () => {
    for (const [next, removed] of [["1.1.0", true], ["1.3.0", false]] as const) {
      const calls: string[] = [];
      let clock = 0;
      await publishLeanRelease(pack, "fixture.tgz", fixtureRun(calls, { latest: "1.1.0", next }), async (ms: number) => { clock += ms; }, () => clock);
      expect(calls.includes("dist-tag rm neondiff next")).toBe(removed);
    }
  });
  it("refuses a first publication outside the release tag ref", async () => {
    const calls: string[] = [];
    let clock = 0;
    await expect(publishLeanRelease(pack, "fixture.tgz", fixtureRun(calls, { latest: "1.0.6" }, false), async (ms: number) => { clock += ms; }, () => clock, { allowFirstPublish: false }))
      .rejects.toThrow(/release tag ref/);
    expect(calls.some((call) => call.startsWith("publish "))).toBe(false);
  });
  it("refuses a publishable lean release on a lightweight tag", () => {
    expect(() => requireAnnotatedLeanTag(true, "commit")).toThrow(/must be annotated/);
    expect(() => requireAnnotatedLeanTag(true, "tag")).not.toThrow();
    expect(() => requireAnnotatedLeanTag(false, "commit")).not.toThrow();
  });
  it("refuses promotion when the registry integrity differs from the packed integrity", async () => {
    const calls: string[] = [];
    let clock = 0;
    const base = fixtureRun(calls, { latest: "1.0.6" });
    const run = (args: string[]) => args[2] === "dist.integrity" ? (calls.push(args.join(" ")), { status: 0, stdout: JSON.stringify("sha512-other"), stderr: "" }) : base(args);
    await expect(publishLeanRelease(pack, "fixture.tgz", run, async (ms: number) => { clock += ms; }, () => clock)).rejects.toThrow(/integrity/);
    expect(calls.some((call) => call.startsWith("dist-tag add"))).toBe(false);
  });
  it("honours the desktop-only marker on every lean stable tag", () => {
    const marker = "NeonDiff-Release-Class: desktop-only";
    expect(hasDesktopOnlyMarker(`Notes\n${marker}\n`)).toBe(true);
    expect(hasDesktopOnlyMarker("Notes only")).toBe(false);
    for (const tag of ["v1.1.0", "v1.2.0", "v2.0.0"]) {
      const release = { tag_name: tag, draft: false, prerelease: false };
      expect(classifyLeanRelease(tag, release, marker)).toBe(false);
      expect(classifyLeanRelease(tag, release, "")).toBe(true);
    }
  });
  it("keeps 1.1.0+ release events of the legacy workflow out of the shared publish group", () => {
    const legacy = parse(readFileSync(".github/workflows/publish-npm.yml", "utf8"));
    const lean = parse(readFileSync(".github/workflows/release-npm.yml", "utf8"));
    expect(lean.concurrency.group).toContain("github.event_name == 'workflow_dispatch'");
    expect(lean.concurrency.group).toContain("!startsWith(github.event.release.tag_name, 'v1.0.')");
    expect(lean.concurrency.group).toContain("!github.event.release.prerelease");
    expect(lean.concurrency.group).toContain("&& 'publish-npm-neondiff' || format('release-npm-route-{0}', github.run_id)");
    expect(legacy.concurrency.group).toContain("!startsWith(github.event.release.tag_name, 'v1.0.')");
    expect(legacy.concurrency.group).toContain("format('publish-npm-route-{0}', github.run_id)");
    expect(legacy.concurrency.group).toContain("github.event.release.prerelease && (startsWith(github.event.release.tag_name, 'v1.1.0-beta.')");
    expect(legacy.concurrency.group).toContain("|| 'publish-npm-neondiff'");
  });
  it("never moves latest backward when an older release is retried", async () => {
    const calls: string[] = [];
    const run = (args: string[]) => {
      calls.push(args.join(" "));
      const value = args[2] === "dist.shasum" ? pack.shasum : args[2] === "dist.integrity" ? pack.integrity : args[2] === "dist-tags.latest" ? "1.2.0" :
        args[2] === "dist-tags" ? { latest: "1.2.0", next: "1.1.0" } :
        args[2] === "dist.attestations.url" ? "https://registry.npmjs.org/-/npm/v1/attestations/neondiff@1.1.0" :
        args[0] === "audit" ? { invalid: [], missing: [], verified: [{ name: "neondiff", version: "1.1.0", attestations: {} }] } : {};
      return { status: 0, stdout: JSON.stringify(value), stderr: "" };
    };
    let clock = 0;
    await publishLeanRelease(pack, "fixture.tgz", run, async (ms: number) => { clock += ms; }, () => clock);
    expect(calls).not.toContain("dist-tag add neondiff@1.1.0 latest");
    expect(calls.some((call) => call.startsWith("publish "))).toBe(false);
  });
  it.each([false, true])("verifies bytes and attestation before promotion (existing=%s)", async (existing) => {
    const calls: string[] = [];
    let clock = 0;
    let lookups = 0;
    const run = (args: string[]) => {
      const command = args.join(" "); calls.push(command);
      if (args[2] === "dist.shasum" && ++lookups === 1 && !existing) return { status: 1, stdout: "", stderr: "E404" };
      if (args[2] === "dist.shasum" && lookups === 2) return { status: 1, stdout: "", stderr: "temporary registry failure" };
      if (command === "dist-tag rm neondiff next") return { status: 1, stdout: "", stderr: "cleanup failure" };
      const value = args[2] === "dist.shasum" ? pack.shasum : args[2] === "dist.integrity" ? pack.integrity : args[2] === "dist-tags.latest" ? pack.version :
        args[2] === "dist-tags" ? { latest: "1.1.0", next: "1.1.0" } :
        args[2] === "dist.attestations.url" ? "https://registry.npmjs.org/-/npm/v1/attestations/neondiff@1.1.0" :
        args[0] === "audit" ? { invalid: [], missing: [], verified: [{ name: "neondiff", version: "1.1.0", attestations: {} }] } : {};
      return { status: 0, stdout: JSON.stringify(value), stderr: "" };
    };
    await publishLeanRelease(pack, "fixture.tgz", run, async (ms: number) => { clock += ms; }, () => clock);
    expect(calls.some((call) => call.startsWith("publish "))).toBe(!existing);
    expect(clock).toBe(10_000);
    expect(calls.indexOf("audit signatures --json --include-attestations")).toBeLessThan(calls.indexOf("dist-tag add neondiff@1.1.0 latest"));
    expect(calls.indexOf("dist-tag add neondiff@1.1.0 latest")).toBeLessThan(calls.indexOf("dist-tag rm neondiff next"));
  });

  it("refuses an immutable mismatch or a non-404 lookup failure", async () => {
    await expect(publishLeanRelease(pack, "fixture.tgz", () => ({ status: 0, stdout: '"wrong"' }))).rejects.toThrow("existing npm shasum differs");
    await expect(publishLeanRelease(pack, "fixture.tgz", () => ({ status: 1, stderr: "E401" }))).rejects.toThrow("refusing to publish");
  });
});
