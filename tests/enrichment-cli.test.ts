import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewStateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = String(testPrivateKey.export({ type: "pkcs1", format: "pem" }));

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
      const markdown = readFileSync(join(outputDir, "enrichment.md"), "utf8");
      const suggestedLabelsLine = markdown.split("\n").find((line) => line.startsWith("Suggested labels:"));
      const suggestedOwnersLine = markdown.split("\n").find((line) => line.startsWith("Suggested owners:"));
      expect(markdown).toContain("## evaOS issue enrichment");
      expect(markdown).toContain("Confirm owner, acceptance criteria, and validation evidence before implementation.");
      expect(suggestedLabelsLine).toBe("Suggested labels: none.");
      expect(suggestedOwnersLine).toBe("Suggested owners: none.");
      expect(suggestedLabelsLine).not.toContain("issue-policy");
      expect(suggestedOwnersLine).not.toContain("issue-owner");
      expect(suggestedLabelsLine).not.toContain("triage");
      expect(suggestedOwnersLine).not.toContain("owner-a");
      expect(markdown).not.toContain("Proof status:");
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

  it("keeps build-enrichment-comment single-issue only when --issue is repeated", async () => {
    await expect(runCli([
      "build-enrichment-comment",
      "--repo",
      "owner/repo",
      "--issue",
      "17",
      "--issue",
      "18"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--issue must be provided once")
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

  it("dry-run scans only the separate issue-enrichment allowlist with throttled output", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const outputDir = join(root, "evidence", "issue-scan");
      const configPath = writeIssueScanConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "issue-enrichment-scan",
        "--config",
        configPath,
        "--dry-run",
        "true",
        "--include-existing",
        "true",
        "--output-dir",
        outputDir
      ]);
      const parsed = JSON.parse(stdout);

      expect(parsed.summary).toMatchObject({
        reposScanned: 1,
        issuesSeen: 3,
        eligible: 2,
        skipped: 1,
        wouldComment: 1,
        deferred: 1
      });
      expect(parsed.items).toContainEqual(expect.objectContaining({
        repo: "owner/issue-repo",
        issueNumber: 18,
        action: "skipped",
        reason: "stale_issue_closed"
      }));
      expect(parsed.items).toContainEqual(expect.objectContaining({
        repo: "owner/issue-repo",
        issueNumber: 20,
        action: "deferred",
        reason: "repo_max_comments_per_cycle"
      }));
      expect(readFileSync(join(outputDir, "issue-enrichment-scan.json"), "utf8")).toContain("\"repo\": \"owner/issue-repo\"");
      expect(requests.some((request) => request.path.startsWith("/repos/owner/issue-repo/issues?"))).toBe(true);
      expect(requests.some((request) => request.path.startsWith("/repos/owner/pr-review-repo/issues?"))).toBe(false);
      const issueScanRequest = requests.find((request) => request.path.startsWith("/repos/owner/issue-repo/issues?"));
      expect(issueScanRequest?.path).toContain("state=open");
    });
  });

  it("continues past PR-shaped issue pages until it finds real issues", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueScanConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "issue-enrichment-scan",
        "--config",
        configPath,
        "--dry-run",
        "true",
        "--include-existing",
        "true"
      ]);
      const parsed = JSON.parse(stdout);

      expect(parsed.summary).toMatchObject({
        reposScanned: 1,
        issuesSeen: 3,
        eligible: 2,
        skipped: 1,
        wouldComment: 1
      });
      expect(parsed.items.some((item: { issueNumber: number }) => item.issueNumber === 20)).toBe(true);
      expect(requests.filter((request) => request.path.startsWith("/repos/owner/issue-repo/issues?"))).toHaveLength(2);
    }, {
      issuePages: [
        Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          title: `PR shaped issue ${index + 1}`,
          state: "open",
          html_url: `https://github.test/owner/issue-repo/pull/${index + 1}`,
          pull_request: {},
          body: "Pull request record."
        })),
        [
          {
            number: 17,
            title: "Open issue",
            state: "open",
            html_url: "https://github.test/owner/issue-repo/issues/17",
            body: "Acceptance criteria and owner are present."
          },
          {
            number: 18,
            title: "Closed issue",
            state: "closed",
            html_url: "https://github.test/owner/issue-repo/issues/18",
            body: "Done."
          },
          {
            number: 20,
            title: "Another open issue",
            state: "open",
            html_url: "https://github.test/owner/issue-repo/issues/20",
            body: "Acceptance criteria and owner are present."
          }
        ]
      ]
    });
  });

  it("rejects invalid issue-enrichment scan since timestamps before calling GitHub", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueScanConfig(root, apiBaseUrl);

      await expect(runCli([
        "issue-enrichment-scan",
        "--config",
        configPath,
        "--dry-run",
        "true",
        "--since",
        "not-a-date"
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("--since must be a canonical ISO timestamp")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("parses issue-enrichment lease clear booleans consistently", async () => {
    await withMockGitHub(async ({ apiBaseUrl }) => {
      const root = createRoot(roots);
      const configPath = writeIssueScanConfig(root, apiBaseUrl);
      const statePath = join(root, "state.sqlite");
      const state = new ReviewStateStore(statePath);
      try {
        state.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date());
      } finally {
        state.close();
      }

      const dryRun = await runCli([
        "clear-issue-enrichment-leases",
        "--config",
        configPath,
        "--dry-run",
        "--expired-only",
        "false"
      ]);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        ok: true,
        dryRun: true,
        expiredOnly: false,
        forceActive: false,
        matched: 1,
        expiredMatched: 0,
        activeMatched: 1,
        deleted: 0
      });

      await expect(runCli([
        "clear-issue-enrichment-leases",
        "--config",
        configPath,
        "--dry-run",
        "false",
        "--confirm",
        "true",
        "--expired-only",
        "false"
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("clearing active issue-enrichment leases requires --force-active true")
      });

      const forced = await runCli([
        "clear-issue-enrichment-leases",
        "--config",
        configPath,
        "--dry-run",
        "false",
        "--confirm",
        "true",
        "--expired-only",
        "false",
        "--force-active",
        "true"
      ]);
      expect(JSON.parse(forced.stdout)).toMatchObject({
        ok: true,
        dryRun: false,
        expiredOnly: false,
        forceActive: true,
        matched: 1,
        expiredMatched: 0,
        activeMatched: 1,
        deleted: 1
      });

      await expect(runCli([
        "clear-issue-enrichment-leases",
        "--config",
        configPath,
        "--dry-run",
        "false",
        "--confirm",
        "maybe"
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("--confirm must be true or false")
      });
    });
  });

  it("requires explicit confirmation before live issue enrichment runs", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false"
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("issue-enrichment-run requires --confirm true when --dry-run false")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("rejects live issue enrichment when comment posting is disabled", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.issueEnrichment.postIssueComment = false;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("issue-enrichment-run live posting requires issueEnrichment.postIssueComment true")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("surfaces missing live repo thresholds before fetching", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      delete config.issueEnrichment.repos["owner/issue-repo"];
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("issue-enrichment-run dry-run blocked: issue_enrichment_live_repo_thresholds_required")
      });

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("issue-enrichment-run live posting blocked: issue_enrichment_live_repo_thresholds_required")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("rejects selected issue enrichment for repos outside the issue allowlist", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/not-allowlisted",
        "--issue",
        "17",
        "--dry-run",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("not_issue_enrichment_allowlisted")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("dry-runs selected issue enrichment and writes JSON plus Markdown evidence", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const outputDir = join(root, "evidence", "issue-run-dry");
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--issue",
        "20",
        "--dry-run",
        "true",
        "--output-dir",
        outputDir
      ], issueRunEnv(root));
      const parsed = JSON.parse(stdout);

      expect(parsed.summary).toMatchObject({ wouldComment: 2, posted: 0, failed: 0 });
      expect(parsed.items).toHaveLength(2);
      expect(readFileSync(join(outputDir, "issue-enrichment-run.json"), "utf8")).toContain("\"issueNumber\": 17");
      expect(readFileSync(join(outputDir, "issue-17.md"), "utf8")).toContain("## evaOS issue enrichment");
      const issue20Markdown = readFileSync(join(outputDir, "issue-20.md"), "utf8");
      expect(issue20Markdown).toContain("Issue: owner/issue-repo#20");
      expect(issue20Markdown).not.toContain("ghp_secret");
      expect(requests.some((request) => request.method === "POST" && request.path.includes("/comments"))).toBe(false);
    });
  });

  it("applies comment caps to live selected batches but not dry-run batches", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.issueEnrichment.maxCommentsPerCycle = 1;
      config.issueEnrichment.globalMaxCommentsPerCycle = 1;
      config.issueEnrichment.repos["owner/issue-repo"].maxCommentsPerCycle = 1;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const dryRun = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--issue",
        "20",
        "--dry-run",
        "true"
      ], issueRunEnv(root));
      expect(JSON.parse(dryRun.stdout).summary).toMatchObject({ wouldComment: 1, deferred: 1 });

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--issue",
        "20",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("selected issue count 2 exceeds configured per-run cap 1")
      });
      expect(requests.some((request) => request.method === "POST" && request.path.includes("/comments"))).toBe(false);
    });
  });

  it("dedupes repeated selected issue numbers before fetching or posting", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--issue",
        "17",
        "--dry-run",
        "true"
      ], issueRunEnv(root));
      const parsed = JSON.parse(stdout);

      expect(parsed.issueNumbers).toEqual([17]);
      expect(parsed.items).toHaveLength(1);
      expect(requests.filter((request) => request.path === "/repos/owner/issue-repo/issues/17")).toHaveLength(1);
      expect(requests.some((request) => request.method === "POST" && request.path.includes("/comments"))).toBe(false);
    });
  });

  it("rejects force for dry-run selected issue enrichment", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "true",
        "--force",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("issue-enrichment-run --force true requires --dry-run false")
      });
      expect(requests).toHaveLength(0);
    });
  });

  it("dry-runs selected issue enrichment on a second allowlisted repo", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeTwoRepoIssueRunConfig(root, apiBaseUrl);

      const { stdout } = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/second-issue-repo",
        "--issue",
        "5",
        "--dry-run",
        "true"
      ], issueRunEnv(root));
      const parsed = JSON.parse(stdout);

      expect(parsed.repo).toBe("owner/second-issue-repo");
      expect(parsed.summary).toMatchObject({ wouldComment: 1, posted: 0, failed: 0 });
      expect(parsed.items).toContainEqual(expect.objectContaining({
        repo: "owner/second-issue-repo",
        issueNumber: 5,
        action: "would_comment"
      }));
      expect(requests).toContainEqual(expect.objectContaining({
        method: "GET",
        path: "/repos/owner/second-issue-repo/issues/5"
      }));
    });
  });

  it("rejects closed and PR-shaped selected issues before posting", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "18",
        "--dry-run",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("stale_issue_closed")
      });

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "19",
        "--dry-run",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stderr: expect.stringContaining("issue_is_pull_request")
      });
      expect(requests.some((request) => request.method === "POST" && request.path.includes("/comments"))).toBe(false);
    });
  });

  it("posts selected issue enrichment live, skips unchanged reruns, and force-updates the sticky comment", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);

      const first = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root));
      expect(JSON.parse(first.stdout).summary).toMatchObject({ posted: 1, failed: 0 });

      const second = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root));
      expect(JSON.parse(second.stdout).summary).toMatchObject({ posted: 0, alreadyProcessed: 1, failed: 0 });

      const forced = await runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true",
        "--force",
        "true"
      ], issueRunEnv(root));
      expect(JSON.parse(forced.stdout).summary).toMatchObject({ posted: 1, alreadyProcessed: 0, failed: 0 });

      const commentPosts = requests.filter((request) => request.method === "POST" && request.path === "/repos/owner/issue-repo/issues/17/comments");
      const commentPatches = requests.filter((request) => request.method === "PATCH" && request.path === "/repos/owner/issue-repo/issues/comments/9001");
      expect(commentPosts).toHaveLength(1);
      expect(commentPatches).toHaveLength(1);
      const state = new ReviewStateStore(join(root, "state.sqlite"));
      try {
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 17)).toMatchObject({
          status: "posted",
          commentUrl: "https://github.test/owner/issue-repo/issues/17#issuecomment-9001"
        });
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toBeUndefined();
      } finally {
        state.close();
      }
    });
  });

  it("exits nonzero when a confirmed live selected run cannot acquire the worker lease", async () => {
    await withMockGitHub(async ({ apiBaseUrl, requests }) => {
      const root = createRoot(roots);
      const configPath = writeIssueRunConfig(root, apiBaseUrl);
      const state = new ReviewStateStore(join(root, "state.sqlite"));
      try {
        state.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date());
      } finally {
        state.close();
      }

      await expect(runCli([
        "issue-enrichment-run",
        "--config",
        configPath,
        "--repo",
        "owner/issue-repo",
        "--issue",
        "17",
        "--dry-run",
        "false",
        "--confirm",
        "true"
      ], issueRunEnv(root))).rejects.toMatchObject({
        stdout: expect.stringContaining("\"workerSkipped\": 1")
      });
      expect(requests.some((request) => request.method === "POST" && request.path.includes("/comments"))).toBe(false);
    });
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      EVAOS_REVIEW_BOT_APP_ID: "",
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
      GITHUB_TOKEN: "test-token",
      ...env
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
    issueEnrichment: {
      enabled: false,
      postIssueComment: false,
      allowlist: ["owner/repo"],
      allowedLabels: ["issue-policy"],
      allowedReviewers: ["issue-owner"]
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

function writeIssueScanConfig(root: string, apiBaseUrl: string): string {
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify({
    pilotRepos: ["owner/pr-review-repo"],
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    github: {
      token: "test-token",
      apiBaseUrl
    },
    issueEnrichment: {
      enabled: false,
      postIssueComment: true,
      allowlist: ["owner/issue-repo"],
      maxIssuesPerCycle: 3,
      maxCommentsPerCycle: 1,
      cooldownMs: 3_600_000,
      burstWindowMs: 3_600_000,
      maxIssuesPerBurst: 10,
      lookbackMs: 600_000,
      processExistingOpenIssuesOnActivation: false
    }
  }, null, 2)}\n`);
  return path;
}

function writeIssueRunConfig(root: string, apiBaseUrl: string): string {
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify({
    pilotRepos: ["owner/pr-review-repo"],
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    github: {
      token: "test-token",
      apiBaseUrl
    },
    issueEnrichment: {
      enabled: true,
      postIssueComment: true,
      allowlist: ["owner/issue-repo"],
      allowedLabels: ["docs", "enhancement"],
      allowedReviewers: ["issue-owner"],
      maxIssuesPerCycle: 5,
      maxCommentsPerCycle: 2,
      globalMaxIssuesPerCycle: 5,
      globalMaxCommentsPerCycle: 2,
      maxActiveRuns: 1,
      leaseTtlMs: 1_200_000,
      cooldownMs: 3_600_000,
      burstWindowMs: 3_600_000,
      maxIssuesPerBurst: 10,
      lookbackMs: 600_000,
      processExistingOpenIssuesOnActivation: false,
      repos: {
        "owner/issue-repo": {
          enabled: true,
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 2,
          cooldownMs: 3_600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 10,
          lookbackMs: 600_000,
          processExistingOpenIssuesOnActivation: false
        }
      }
    }
  }, null, 2)}\n`);
  return path;
}

function writeTwoRepoIssueRunConfig(root: string, apiBaseUrl: string): string {
  const path = writeIssueRunConfig(root, apiBaseUrl);
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.issueEnrichment.allowlist = ["owner/issue-repo", "owner/second-issue-repo"];
  config.issueEnrichment.repos["owner/second-issue-repo"] = {
    enabled: true,
    maxIssuesPerCycle: 5,
    maxCommentsPerCycle: 2,
    cooldownMs: 3_600_000,
    burstWindowMs: 3_600_000,
    maxIssuesPerBurst: 10,
    lookbackMs: 600_000,
    processExistingOpenIssuesOnActivation: false
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function issueRunEnv(root: string): NodeJS.ProcessEnv {
  const privateKeyPath = join(root, "app.pem");
  writeFileSync(privateKeyPath, TEST_PRIVATE_KEY_PEM);
  return {
    EVAOS_REVIEW_BOT_APP_ID: "4184532",
    EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: privateKeyPath
  };
}

async function withMockGitHub(
  callback: (input: { apiBaseUrl: string; requests: Array<{ method: string; path: string; authorization?: string }> }) => Promise<void>,
  options: { issuePages?: unknown[][] } = {}
): Promise<void> {
  const requests: Array<{ method: string; path: string; authorization?: string }> = [];
  const state: MockGitHubState = {};
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    requests.push({ method, path, authorization: request.headers.authorization });
    routeMockGitHub(request, response, { ...options, state });
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

interface MockGitHubState {
  issue17CommentBody?: string;
}

function routeMockGitHub(
  request: IncomingMessage,
  response: ServerResponse,
  options: { issuePages?: unknown[][]; state?: MockGitHubState } = {}
): void {
  if (
    request.method === "GET" &&
    (request.url === "/repos/owner/issue-repo/installation" ||
      request.url === "/repos/owner/second-issue-repo/installation")
  ) {
    respondJson(response, 200, { id: 123 });
    return;
  }
  if (request.method === "POST" && request.url === "/app/installations/123/access_tokens") {
    respondJson(response, 200, { token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
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
  if (request.url === "/repos/owner/issue-repo/issues/17") {
    respondJson(response, 200, {
      number: 17,
      title: "Open issue #11 #12 #13",
      state: "open",
      updated_at: "2026-07-05T00:00:00.000Z",
      html_url: "https://github.test/owner/issue-repo/issues/17",
      body: "Acceptance criteria and owner are present.",
      labels: [{ name: "support" }]
    });
    return;
  }
  if (request.url === "/repos/owner/issue-repo/issues/18") {
    respondJson(response, 200, {
      number: 18,
      title: "Closed issue",
      state: "closed",
      updated_at: "2026-07-05T00:00:00.000Z",
      html_url: "https://github.test/owner/issue-repo/issues/18",
      body: "Done."
    });
    return;
  }
  if (request.url === "/repos/owner/issue-repo/issues/19") {
    respondJson(response, 200, {
      number: 19,
      title: "PR shaped issue",
      state: "open",
      updated_at: "2026-07-05T00:00:00.000Z",
      html_url: "https://github.test/owner/issue-repo/pull/19",
      pull_request: {},
      body: "Pull request record."
    });
    return;
  }
  if (request.url === "/repos/owner/issue-repo/issues/20") {
    respondJson(response, 200, {
      number: 20,
      title: "Another open issue ghp_secret1234567890abcdef",
      state: "open",
      updated_at: "2026-07-05T00:01:00.000Z",
      html_url: "https://github.test/owner/issue-repo/issues/20",
      body: "Acceptance criteria and owner are present."
    });
    return;
  }
  if (request.url === "/repos/owner/second-issue-repo/issues/5") {
    respondJson(response, 200, {
      number: 5,
      title: "Second repo open issue",
      state: "open",
      updated_at: "2026-07-05T00:02:00.000Z",
      html_url: "https://github.test/owner/second-issue-repo/issues/5",
      body: "Acceptance criteria and owner are present."
    });
    return;
  }
  if (request.method === "GET" && request.url === "/repos/owner/issue-repo/issues/17/comments?per_page=100&page=1") {
    respondJson(response, 200, options.state?.issue17CommentBody ? [
      {
        id: 9001,
        body: options.state.issue17CommentBody,
        user: { type: "Bot", login: "evaos-code-review-bot[bot]" }
      }
    ] : []);
    return;
  }
  if (request.method === "POST" && request.url === "/repos/owner/issue-repo/issues/17/comments") {
    if (options.state) {
      options.state.issue17CommentBody = "<!-- evaos-code-review-bot:enrichment repo=owner/issue-repo issue=17 -->";
    }
    respondJson(response, 200, {
      id: 9001,
      html_url: "https://github.test/owner/issue-repo/issues/17#issuecomment-9001"
    });
    return;
  }
  if (request.method === "PATCH" && request.url === "/repos/owner/issue-repo/issues/comments/9001") {
    if (options.state) {
      options.state.issue17CommentBody = "<!-- evaos-code-review-bot:enrichment repo=owner/issue-repo issue=17 --> updated";
    }
    respondJson(response, 200, {
      id: 9001,
      html_url: "https://github.test/owner/issue-repo/issues/17#issuecomment-9001"
    });
    return;
  }
  const parsed = new URL(request.url ?? "/", "https://github.test");
  if (parsed.pathname === "/repos/owner/issue-repo/issues") {
    if (options.issuePages) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      respondJson(response, 200, options.issuePages[page - 1] ?? []);
      return;
    }
    respondJson(response, 200, [
      {
        number: 17,
        title: "Open issue",
        state: "open",
        html_url: "https://github.test/owner/issue-repo/issues/17",
        body: "Acceptance criteria and owner are present."
      },
      {
        number: 18,
        title: "Closed issue",
        state: "closed",
        html_url: "https://github.test/owner/issue-repo/issues/18",
        body: "Done."
      },
      {
        number: 19,
        title: "PR shaped issue",
        state: "open",
        html_url: "https://github.test/owner/issue-repo/pull/19",
        pull_request: {},
        body: "Pull request record."
      },
      {
        number: 20,
        title: "Another open issue",
        state: "open",
        html_url: "https://github.test/owner/issue-repo/issues/20",
        body: "Acceptance criteria and owner are present."
      }
    ]);
    return;
  }
  respondJson(response, 404, { message: `unexpected path ${request.url}` });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
