import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("build-enrichment-comment issue CLI", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes JSON and Markdown for open issue dry runs", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const evidenceDir = join(root, "evidence");
      const outputDir = join(evidenceDir, "issue-open");
      const configPath = writeConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "build-enrichment-comment",
        "--config",
        configPath,
        "--repo",
        "owner/repo",
        "--issue",
        "17",
        "--output-dir",
        outputDir
      ]);
      const parsed = JSON.parse(stdout);

      expect(parsed).toMatchObject({ ok: true, skipped: false, repo: "owner/repo", issueNumber: 17 });
      expect(readFileSync(join(outputDir, "enrichment-comment.json"), "utf8")).toContain("\"issueNumber\": 17");
      expect(readFileSync(join(outputDir, "enrichment.md"), "utf8")).toContain("## evaOS issue enrichment");
      expect(requests).toContainEqual({
        method: "GET",
        path: "/repos/owner/repo/issues/17",
        authorization: "Bearer test-token"
      });
    });
  });

  it("writes only JSON for skipped issue dry runs", async () => {
    await withMockGitHub(async ({ apiBaseUrl }) => {
      const root = createRoot(roots);
      const evidenceDir = join(root, "evidence");
      const outputDir = join(evidenceDir, "issue-closed");
      const configPath = writeConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "build-enrichment-comment",
        "--config",
        configPath,
        "--repo",
        "owner/repo",
        "--issue",
        "18",
        "--output-dir",
        outputDir
      ]);
      const parsed = JSON.parse(stdout);

      expect(parsed).toMatchObject({ ok: true, skipped: true, reason: "stale_issue_closed" });
      expect(existsSync(join(outputDir, "enrichment-comment.json"))).toBe(true);
      expect(existsSync(join(outputDir, "enrichment.md"))).toBe(false);
    });
  });

  it("surfaces unreadable issues through the friendly operator error", async () => {
    await withMockGitHub(async ({ apiBaseUrl }) => {
      const root = createRoot(roots);
      const configPath = writeConfig(root, apiBaseUrl);

      await expect(runCli([
        "build-enrichment-comment",
        "--config",
        configPath,
        "--repo",
        "owner/repo",
        "--issue",
        "404"
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("Issue owner/repo#404 was not found or is not readable")
      });
    });
  });

  it("requires exactly one PR or issue target", async () => {
    await expect(runCli([
      "build-enrichment-comment",
      "--repo",
      "owner/repo",
      "--pr",
      "1",
      "--issue",
      "17"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("exactly one of --pr or --issue is required")
    });
  });

  it("rejects issue output directories outside the configured evidence dir", async () => {
    await withMockGitHub(async ({ apiBaseUrl }) => {
      const root = createRoot(roots);
      const configPath = writeConfig(root, apiBaseUrl);

      await expect(runCli([
        "build-enrichment-comment",
        "--config",
        configPath,
        "--repo",
        "owner/repo",
        "--issue",
        "17",
        "--output-dir",
        join(root, "not-evidence")
      ])).rejects.toMatchObject({
        stderr: expect.stringMatching(/configured evidenceDir|repository checkout/)
      });
    });
  });
});

async function runCli(args: string[]) {
  return execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EVAOS_REVIEW_BOT_APP_ID: "",
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
      GITHUB_TOKEN: "test-token"
    },
    maxBuffer: 1024 * 1024
  });
}

function createRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "enrichment-cli-"));
  roots.push(root);
  return root;
}

function writeConfig(root: string, apiBaseUrl: string): string {
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify({
    pilotRepos: ["owner/repo"],
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    github: {
      token: "test-token",
      apiBaseUrl
    },
    enrichment: {
      enabled: false,
      postIssueComment: false,
      packetVersion: "enrichment-comment-v0.1",
      maxRelatedRefs: 2,
      maxSuggestions: 2
    },
    repoProfiles: {
      repos: {
        "owner/repo": {
          enabled: true,
          suggestedLabels: ["triage"],
          suggestedReviewers: ["owner-a"]
        }
      }
    }
  }, null, 2)}\n`);
  return path;
}

async function withMockGitHub(
  callback: (input: { apiBaseUrl: string; requests: Array<{ method: string; path: string; authorization?: string }> }) => Promise<void>
): Promise<void> {
  const requests: Array<{ method: string; path: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    requests.push({ method, path, authorization: request.headers.authorization });
    routeMockGitHub(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock GitHub server did not bind to a TCP port");
  try {
    await callback({ apiBaseUrl: `http://127.0.0.1:${address.port}`, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function routeMockGitHub(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") {
    respondJson(response, 405, { message: "method not allowed" });
    return;
  }
  if (request.url === "/repos/owner/repo/issues/17") {
    respondJson(response, 200, {
      number: 17,
      title: "Open issue #11 #12 #13",
      state: "open",
      html_url: "https://github.test/owner/repo/issues/17",
      body: "Acceptance criteria and owner are present.",
      labels: [{ name: "support" }]
    });
    return;
  }
  if (request.url === "/repos/owner/repo/issues/18") {
    respondJson(response, 200, {
      number: 18,
      title: "Closed issue",
      state: "closed",
      html_url: "https://github.test/owner/repo/issues/18",
      body: "Done."
    });
    return;
  }
  if (request.url === "/repos/owner/repo/issues/404") {
    respondJson(response, 404, { message: "Not Found" });
    return;
  }
  respondJson(response, 404, { message: `unexpected path ${request.url}` });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
