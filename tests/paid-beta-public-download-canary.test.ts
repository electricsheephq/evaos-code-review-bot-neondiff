import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflowPath = ".github/workflows/paid-beta-public-download-canary.yml";
const workflow = readFileSync(workflowPath, "utf8");
type Step = { name?: string; run?: string };

function stepRun(name: string): string {
  const parsed = YAML.parse(workflow) as { jobs?: Record<string, { steps?: Step[] }> };
  const step = parsed.jobs?.["public-download-install-canary"]?.steps?.find((item) => item.name === name);
  if (!step?.run) throw new Error(`missing ${name}`);
  return step.run;
}

function runInput(script: string, releaseTag: string, artifactName: string, digest: string): number | null {
  const root = mkdtempSync(join(tmpdir(), "neondiff-rc-input-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const uname = join(bin, "uname");
  writeFileSync(uname, "#!/bin/sh\nprintf '%s\\n' arm64\n");
  chmodSync(uname, 0o755);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TAG: releaseTag, ARTIFACT_NAME: artifactName, ARTIFACT_SHA256: digest, GITHUB_OUTPUT: join(root, "out") }
  });
  rmSync(root, { recursive: true, force: true });
  return result.status;
}

describe("paid beta public RC canary", () => {
  it("accepts beta and RC identities but rejects drift under Bash 3.2", () => {
    const script = stepRun("Validate immutable release input");
    const digest = "a".repeat(64);
    expect(runInput(script, "v1.1.0-beta.7", "NeonDiff-1.1.0-beta.7-build42-macOS.zip", digest)).toBe(0);
    expect(runInput(script, "v1.1.0-rc.1", "NeonDiff-1.1.0-rc.1-build42-macOS.zip", digest)).toBe(0);
    for (const [tag, name, hash] of [
      ["v1.1.0-rc", "NeonDiff-1.1.0-rc-build42-macOS.zip", digest],
      ["v1.1.0-rc.1", "NeonDiff-1.1.0-beta.1-build42-macOS.zip", digest],
      ["v1.1.0-rc.1", "NeonDiff-1.1.0-rc.2-build42-macOS.zip", digest],
      ["v1.1.0-rc.1", "NeonDiff-1.1.0-rc.1-build42-macOS.zip", "A".repeat(64)]
    ]) expect(runInput(script, tag, name, hash)).not.toBe(0);
    for (const sequence of ["0", "00", "01"]) expect(runInput(script, `v1.1.0-rc.${sequence}`, `NeonDiff-1.1.0-rc.${sequence}-build42-macOS.zip`, digest)).not.toBe(0);
  });

  it("requires the canonical Sparkle namespace, beta channel, and exact enclosure", () => {
    const parser = stepRun("Verify version build feed and Sparkle signature agreement").match(/python3 - [^\n]+ <<'PY'\n([\s\S]*?)\nPY/)?.[1];
    if (!parser) throw new Error("missing parser");
    const feedUrl = "https://www.neondiff.com/updates/beta/appcast.xml";
    const artifact = "https://example.invalid/NeonDiff-1.1.0-rc.1-build42-macOS.zip";
    const sig = Buffer.alloc(64, 7).toString("base64");
    const key = Buffer.alloc(32, 9).toString("base64");
    const run = (xml: string, publicKey = key) => {
      const root = mkdtempSync(join(tmpdir(), "neondiff-feed-"));
      const path = join(root, "appcast.xml");
      writeFileSync(path, xml);
      const result = spawnSync("python3", ["-", path, artifact, "42", "1.1.0-rc.1", feedUrl, publicKey], { input: parser, encoding: "utf8" });
      rmSync(root, { recursive: true, force: true });
      return result.status;
    };
    const valid = `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><link>${feedUrl}</link><item><description>${artifact} sparkle:version="42"</description><enclosure url="https://stale.invalid/old.zip"/></item><item><sparkle:channel>beta</sparkle:channel><enclosure url="${artifact}" sparkle:version="42" sparkle:shortVersionString="1.1.0-rc.1" sparkle:edSignature="${sig}"/></item></channel></rss>`;
    expect(run(valid)).toBe(0);
    expect(run(valid, "bad-key")).not.toBe(0);
    expect(run(valid.replaceAll("sparkle", "other"))).not.toBe(0);
    expect(run(valid.replace(`url="${artifact}"`, `url="https://wrong.invalid/wrong.zip"`))).not.toBe(0);
    expect(run(valid.replace("<sparkle:channel>beta</sparkle:channel>", ""))).not.toBe(0);
    expect(run(valid.replace("<sparkle:channel>beta</sparkle:channel>", "<sparkle:channel>alpha</sparkle:channel>"))).not.toBe(0);
    expect(run(valid.replace("<sparkle:channel>beta</sparkle:channel>", "<sparkle:channel>beta</sparkle:channel><sparkle:channel>beta</sparkle:channel>"))).not.toBe(0);
    expect(run(valid.replace("<item><sparkle:channel>beta</sparkle:channel>", '<item sparkle:channel="beta">'))).not.toBe(0);
    expect(workflow).toContain("Curve25519.Signing.PublicKey");
    expect(workflow).toContain("isValidSignature");
    expect(workflow).not.toContain("local_name");
  });
});
