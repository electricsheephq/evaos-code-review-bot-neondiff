import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preparePullWorktree } from "../src/git.js";
const calls = vi.hoisted(() => ({ exec: vi.fn(), fail: false }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: calls.exec }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); calls.exec.mockReset(); });
it.each([true, false])("passes clone/fetch credentials only in child env when CI token supplied=%s", async authenticated => {
  const root = mkdtempSync(join(tmpdir(), "ci-git-auth-")); roots.push(root);
  const token = "fixture-credential-never-log", encoded = Buffer.from("x-access-token:" + token).toString("base64");
  const seen: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  calls.exec.mockImplementation((_cmd, args, options, callback) => {
    seen.push({ args, env: options.env });
    if (args.includes("clone") && calls.fail) return callback(Object.assign(new Error("failed"), { code: 1 }), "", token + " " + encoded);
    const out = args.includes("rev-parse") ? (args.includes("--is-bare-repository") ? "false" : "a".repeat(40)) : "";
    callback(args.includes("--is-bare-repository") ? Object.assign(new Error("missing"), { code: 1 }) : null, out, "");
  });
  const input = { repo: "org/private", pullNumber: 1, expectedHeadSha: "a".repeat(40), workRoot: join(root, "work"),
    ...(authenticated ? { gitAuthToken: token } : {}) };
  calls.fail = false;
  await preparePullWorktree(input);
  const network = seen.filter(call => call.args.includes("clone") || call.args.includes("fetch"));
  expect(network).toHaveLength(2);
  for (const call of network) {
    if (authenticated) expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + encoded });
    else expect(call.env).toBeUndefined();
    expect(call.args.some(arg => arg.includes(token) || arg.includes(encoded))).toBe(false);
  }
  expect(seen.filter(call => !network.includes(call)).every(call => call.env === undefined)).toBe(true);
  if (authenticated) {
    calls.fail = true;
    const message = await preparePullWorktree(input).then(() => "unexpected success", error => String(error));
    expect(message.includes(token) || message.includes(encoded)).toBe(false);
    expect(message).toContain("git command exit_nonzero");
  }
});
