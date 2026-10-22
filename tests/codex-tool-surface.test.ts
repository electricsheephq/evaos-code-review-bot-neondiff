import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildCodexExecInvocation, resolveCodexReadConfinement } from "../src/codex-runtime.js";
const roots: string[] = [];
const enabled = process.env.NEONDIFF_REAL_CODEX === "1";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-tool-surface-")); roots.push(root);
  const cwd = join(root, "checkout"); const home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home); mkdirSync(join(home, ".codex"));
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: tmpdir() };
  const cli = process.platform === "darwin" ? "/Users/m1/.local/bin/codex" : "codex";
  return { root, cwd, env, cli };
}
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end("Return JSON only. Fixture review.\n");
  });
}
it.skipIf(!enabled)("real Codex omits shell tools and project docs, with a trusted positive control", async () => {
  const { root, cwd, env, cli } = fixture();
  const marker = "NEONDIFF_UNTRUSTED_PROJECT_DOC_MARKER";
  writeFileSync(join(cwd, "AGENTS.md"), marker);
  const schemaPath = join(root, "schema.json");
  writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: {}, additionalProperties: false }));
  const requests: Array<{ url?: string; body: { input?: unknown[] } }> = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", data => { body += data; });
    req.on("end", () => { requests.push({ url: req.url, body: JSON.parse(body) }); res.writeHead(400); res.end('{"error":{"message":"fixture rejection"}}'); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
    const provider = `model_providers.fixture={name="Fixture",wire_api="responses",base_url="http://127.0.0.1:${address.port}/v1",request_max_retries=0,stream_max_retries=0,requires_openai_auth=false}`;
    for (const restrictTools of [true, false]) {
      requests.length = 0;
      const invocation = buildCodexExecInvocation({ cliPath: cli, cwd, model: "gpt-6.1-sol", reasoningEffort: "high", schemaPath,
        outputPath: join(root, "result.json"), restrictTools,
        ...(restrictTools ? { readConfinement: resolveCodexReadConfinement(cwd, cli, env, true) } : {}) });
      const result = await run(invocation.command, [invocation.args[0]!, "--skip-git-repo-check", "-c", 'model_provider="fixture"', "-c", provider, ...invocation.args.slice(1)], cwd, env);
      expect(requests.length, result.output).toBeGreaterThan(0);
      const request = requests.find(item => item.url === "/v1/responses");
      expect(request, result.output).toBeDefined();
      const additionalTools = request!.body.input?.find(item => JSON.stringify(item).includes("additional_tools"));
      expect(additionalTools, "request must include the additional_tools input item").toBeDefined();
      const toolText = JSON.stringify(additionalTools);
      if (restrictTools) {
        expect(toolText).not.toMatch(/### `(?:exec_command|write_stdin)`/);
        expect(JSON.stringify(request!.body)).not.toContain(marker);
      } else {
        expect(toolText).toContain("### `exec_command`");
        expect(JSON.stringify(request!.body)).toContain(marker);
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 55_000);
it.skipIf(!enabled || process.platform !== "linux" || !process.env.CI)("Linux permission profile denies proc, runner temp and outside-checkout reads", async () => {
  const { root, cwd, env, cli } = fixture();
  const runnerTemp = process.env.RUNNER_TEMP!;
  expect(runnerTemp).toBeTruthy();
  // A private subdirectory avoids collisions with other jobs sharing RUNNER_TEMP.
  const runnerDir = mkdtempSync(join(runnerTemp, "neondiff-probe-")); roots.push(runnerDir);
  const runnerFile = join(runnerDir, "x"); writeFileSync(runnerFile, "fixture");
  const outside = join(root, "outside"); writeFileSync(outside, "fixture");
  const inside = join(cwd, "inside"); writeFileSync(inside, "fixture");
  const invocation = buildCodexExecInvocation({ cliPath: cli, cwd, model: "fixture", reasoningEffort: "high", schemaPath: "unused", outputPath: "unused",
    restrictTools: true, readConfinement: resolveCodexReadConfinement(cwd, cli, env, true) });
  const flags = invocation.args.flatMap((arg, i, args) => arg === "-c" ? [arg, args[i + 1]!] : []);
  // Exact paths arrive as arguments (the sandbox may not forward RUNNER_TEMP); the checkout file is the positive control.
  const script = 'for path in "$@" /proc/$PPID/environ; do if cat "$path" >/dev/null 2>&1; then printf "READABLE:%s\\n" "$path"; else printf "DENIED:%s\\n" "$path"; fi; done';
  // Codex 0.163 runs the platform sandbox from `codex sandbox` itself; the fixture's CODEX_HOME holds no user config.
  const result = await run(invocation.command, ["sandbox", ...flags, "--", "/bin/sh", "-c", script, "probe",
    inside, "/proc/self/environ", runnerFile, outside], cwd, env);
  expect(result.code, result.output).toBe(0);
  expect(result.output, "the probe must be able to read the checkout").toContain(`READABLE:${inside}\n`);
  for (const path of ["/proc/self/environ", runnerFile, outside]) expect(result.output, result.output).toContain(`DENIED:${path}\n`);
  expect(result.output).toMatch(/DENIED:\/proc\/\d+\/environ\n/);
  expect(result.output.match(/READABLE:/g)).toHaveLength(1);
});
