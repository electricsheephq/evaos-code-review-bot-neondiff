import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isLeanReleaseVersion } from "../src/release-version.js";
import { readPublicReleaseManifestStatus } from "../src/release-status.js";
// @ts-expect-error Repository scripts run directly under Node 26.
import { classifyLeanRelease, publishLeanRelease } from "../scripts/release-npm.mjs";

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
    ["release", "v2.0.0", false], ["workflow_dispatch", "v1.1.0", true]
  ])("routes legacy %s %s", (eventName, tag, expected) => {
    const workflow = parse(readFileSync(".github/workflows/publish-npm.yml", "utf8"));
    const script = workflow.jobs.release_route.steps[0].with.script;
    const outputs: Record<string, boolean> = {};
    const notices: string[] = [];
    new Function("context", "core", script)(
      { eventName, payload: { release: { tag_name: tag } } },
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
  it.each([false, true])("verifies bytes and attestation before promotion (existing=%s)", async (existing) => {
    const calls: string[] = [];
    let clock = 0;
    let lookups = 0;
    const run = (args: string[]) => {
      const command = args.join(" "); calls.push(command);
      if (args[2] === "dist.shasum" && ++lookups === 1 && !existing) return { status: 1, stdout: "", stderr: "E404" };
      if (args[2] === "dist.shasum" && lookups === 2) return { status: 1, stdout: "", stderr: "temporary registry failure" };
      if (command === "dist-tag rm neondiff next") return { status: 1, stdout: "", stderr: "cleanup failure" };
      const value = args[2] === "dist.shasum" ? pack.shasum : args[2] === "dist-tags.latest" ? pack.version :
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
