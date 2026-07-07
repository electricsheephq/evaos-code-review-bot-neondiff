import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("NeonDiff desktop release-smoke pipeline", () => {
  it("defines an unsigned macOS release-smoke workflow with the required desktop gates", () => {
    const workflowPath = ".github/workflows/desktop-release-smoke.yml";

    expect(existsSync(workflowPath)).toBe(true);

    const workflow = read(workflowPath);
    const parsed = YAML.parse(workflow) as {
      on?: {
        workflow_dispatch?: unknown;
        push?: { tags?: string[] };
      };
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      permissions?: { contents?: string };
      jobs?: Record<
        string,
        {
          "runs-on"?: string;
          defaults?: { run?: { "working-directory"?: string } };
          steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, string> }>;
        }
      >;
    };

    expect(Object.prototype.hasOwnProperty.call(parsed.on ?? {}, "workflow_dispatch")).toBe(true);
    expect(parsed.on?.push?.tags).toContain("v*");
    expect(parsed.concurrency?.group).toContain("desktop-release-smoke");
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(parsed.permissions).toEqual({ contents: "read" });

    const job = parsed.jobs?.["unsigned-desktop-release-smoke"];
    expect(job?.["runs-on"]).toBe("macos-latest");
    expect(job?.defaults?.run?.["working-directory"]).toBe("apps/neondiff-desktop");

    for (const command of [
      "swift run NeonDiffDesktopCoreChecks",
      "swift run NeonDiffDesktopAppcastChecks",
      "script/build_and_run.sh build",
      "script/build_and_run.sh bundle-check"
    ]) {
      expect(workflow).toContain(command);
    }

    expect(workflow).not.toContain("NeonDiffDesktopCoreSmoke");
    expect(workflow).toContain("release_ready");
    expect(workflow).toContain("customer_ready");
    expect(workflow).toContain("unsigned");
    expect(workflow).toMatch(/hosted-runner-safe core checks/);
    expect(workflow).toMatch(/persist-credentials:\s*false/);
    expect(workflow).toMatch(/SOURCE_SHA:/);
    expect(workflow).toMatch(/SOURCE_REF:/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).not.toMatch(/actions\/checkout@v4/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v4/);
    expect(workflow).toMatch(/NeonDiffDesktop\.app\.zip/);
    expect(workflow).toMatch(/desktop-release-smoke-metadata\.json/);

    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toMatch(/\b(codesign|notarytool|stapler|spctl)\b/);
    expect(workflow).not.toMatch(/\bopen\s+-n\b/);
  });

  it("documents the desktop smoke artifact as non-release proof", () => {
    const docPath = "apps/neondiff-desktop/docs/desktop-release-smoke.md";

    expect(existsSync(docPath)).toBe(true);

    const docs = read(docPath);
    expect(docs).toMatch(/desktop-release-smoke\.yml/);
    expect(docs).toMatch(/unsigned/i);
    expect(docs).toMatch(/non-release proof/i);
    expect(docs).toMatch(/customer-not-ready/i);
    expect(docs).toMatch(/NeonDiffDesktopCoreChecks/);
    expect(docs).toMatch(/Keychain/i);
    expect(docs).not.toMatch(/\b(codesign|notarytool|stapler|spctl)\b/);
  });
});
