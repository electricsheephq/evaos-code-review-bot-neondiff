import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { BotConfig } from "./config.js";
import { getLicenseStatus, type LicenseStatusResult } from "./license.js";
import { requireActiveProductionLicense } from "./license-admission.js";
import { writeSecureFileSync } from "./temp-files.js";
import {
  doctorProviderRegistry,
  type ProviderDoctorCheck,
  type ProviderRegistryConfig
} from "./providers.js";
import { redactSecrets, stringifyRedactedJson } from "./secrets.js";

export type LocalDashboardReadinessState =
  | "not_configured"
  | "configured_unverified"
  | "healthy"
  | "degraded"
  | "blocked";

export interface LocalDashboardStatusItem {
  id: "license" | "githubApp" | "daemon" | "provider";
  label: string;
  state: LocalDashboardReadinessState;
  detail: string;
  checkedAt: string;
  redacted: true;
  actions: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface LocalDashboardProviderOption {
  id: string;
  label: string;
  adapter: string;
  authMode: string;
  apiKeyEnv?: string;
  default: boolean;
}

export interface LocalDashboardStatusContract {
  ok: boolean;
  command: "dashboard status";
  schemaVersion: "local-dashboard-status-v0.1";
  checkedAt: string;
  config: {
    path: string;
    exists: boolean;
    source: "file" | "defaults";
  };
  items: {
    license: LocalDashboardStatusItem;
    githubApp: LocalDashboardStatusItem;
    daemon: LocalDashboardStatusItem;
    provider: LocalDashboardStatusItem;
  };
  providers: {
    defaultProviderId: string;
    options: LocalDashboardProviderOption[];
  };
  firstReviewPreview: {
    available: boolean;
    detail: string;
    command: string;
  };
  proofBoundary: string;
}

export interface LocalDashboardServerHandle {
  server: Server;
  url: string;
  status: LocalDashboardStatusContract;
  openAttempted: boolean;
  openOk: boolean;
}

type ProviderVerificationCommand = "dashboard verify-provider" | "providers verify";

export interface ProviderApiKeyVerificationInput {
  command?: ProviderVerificationCommand;
  config: BotConfig;
  providerId?: string;
  apiKey?: string;
  allowRemoteSmoke?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ProviderApiKeyVerificationResult {
  ok: boolean;
  command: ProviderVerificationCommand;
  checkedAt: string;
  providerId: string;
  state: LocalDashboardReadinessState;
  mode: "metadata_only" | "openai_compatible_models";
  detail: string;
  redacted: true;
  keySource?: "submitted" | "env";
  check?: Omit<ProviderDoctorCheck, "error"> & { error?: string };
  troubleshooting: string[];
  configRevision?: string;
}

export interface LocalDashboardPreviewSmokeResult {
  ok: boolean;
  command: "dashboard preview-smoke";
  route: "/";
  url: string;
  sourceSha?: string;
  outputDir: string;
  htmlPath: string;
  statusPath: string;
  providerVerifyPath: string;
  packetPath: string;
  screenshotPath?: string;
  screenshotCaptured: boolean;
  settledUiState: {
    htmlLoaded: boolean;
    statusApiLoaded: boolean;
    providerVerifyRouteLoaded: boolean;
    controlsRendered: boolean;
    statusScriptRendered: boolean;
    providerVerifyStatus: number;
  };
  proofBoundary: string;
}

export async function buildLocalDashboardStatus(input: {
  config: BotConfig;
  configPath: string;
  configExists: boolean;
  launchdLabel?: string;
  providerVerification?: ProviderApiKeyVerificationResult;
  now?: Date;
}): Promise<LocalDashboardStatusContract> {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const license = await buildLicenseStatusItem(input.config, checkedAt);
  const githubApp = buildGitHubAppStatusItem(input.config, checkedAt);
  const daemon = buildDaemonStatusItem(input.config, checkedAt, input.launchdLabel);
  const provider = input.providerVerification
    ? providerStatusItemFromVerification(input.providerVerification, checkedAt)
    : buildProviderStatusItem(input.config.providers!, checkedAt);
  const items = { license, githubApp, daemon, provider };
  const ok = Object.values(items).every((item) => item.state === "healthy" || item.state === "degraded");

  return redactedStatus({
    ok,
    command: "dashboard status",
    schemaVersion: "local-dashboard-status-v0.1",
    checkedAt,
    config: {
      path: input.configPath,
      exists: input.configExists,
      source: input.configExists ? "file" : "defaults"
    },
    items,
    providers: {
      defaultProviderId: input.config.providers!.defaultProviderId,
      options: buildProviderOptions(input.config.providers!)
    },
    firstReviewPreview: {
      available: ok,
      detail: ok
        ? "Configuration looks ready for a dry-run PR review."
        : "Complete blocked setup items before running a review.",
      command: "neondiff review-pr --config config.local.json --repo owner/repo --pr 123 --dry-run true"
    },
    proofBoundary: "Local dashboard readiness only; this does not prove signed desktop release, appcast, notarization, or live review quality."
  });
}

export async function verifyProviderApiKey(input: ProviderApiKeyVerificationInput): Promise<ProviderApiKeyVerificationResult> {
  const checkedAt = new Date().toISOString();
  const command = input.command ?? "dashboard verify-provider";
  const registry = input.config.providers!;
  const providerId = input.providerId ?? registry.defaultProviderId;
  const provider = registry.providers[providerId];
  if (!provider) {
    return redactedVerification({
      ok: false,
      command,
      checkedAt,
      providerId,
      state: "blocked",
      mode: "metadata_only",
      detail: `Provider ${providerId} is not configured.`,
      redacted: true,
      troubleshooting: ["Choose a configured provider id from config.providers.providers."]
    });
  }

  if (provider.adapter !== "openai-compatible" || provider.authMode !== "api-key-env") {
    const result = await doctorProviderRegistry({
      registry,
      providerId,
      smoke: false,
      env: input.env
    });
    const check = result.checks[0];
    return redactedVerification({
      ok: Boolean(check?.ok),
      command,
      checkedAt,
      providerId,
      state: check?.ok ? "configured_unverified" : "blocked",
      mode: "metadata_only",
      detail: check?.ok
        ? `${displayProviderName(providerId, registry)} passed metadata checks; API-key verification is not applicable for ${provider.authMode}.`
        : check?.error ?? "Provider metadata check failed.",
      redacted: true,
      ...(check ? { check: redactProviderCheck(check) } : {}),
      troubleshooting: result.troubleshooting
    });
  }

  const apiKey = input.apiKey?.trim();
  const env = { ...(input.env ?? process.env) };
  if (apiKey && provider.apiKeyEnv) env[provider.apiKeyEnv] = apiKey;
  const keySource = apiKey ? "submitted" : provider.apiKeyEnv && env[provider.apiKeyEnv] ? "env" : undefined;
  if (provider.apiKeyEnv && !env[provider.apiKeyEnv]) {
    return redactedVerification({
      ok: false,
      command,
      checkedAt,
      providerId,
      state: "blocked",
      mode: "metadata_only",
      detail: `Missing API key source ${provider.apiKeyEnv}.`,
      redacted: true,
      troubleshooting: [`Set ${provider.apiKeyEnv} or paste a key into the local dashboard verify form.`]
    });
  }

  const allowRemoteSmoke = input.allowRemoteSmoke === true;
  const shouldSmoke = isLoopbackProvider(provider.baseUrl) || allowRemoteSmoke;
  if (!shouldSmoke) {
    const result = await doctorProviderRegistry({
      registry,
      providerId,
      smoke: false,
      env
    });
    const check = result.checks[0];
    return redactedVerification({
      ok: false,
      command,
      checkedAt,
      providerId,
      state: check?.ok ? "configured_unverified" : "blocked",
      mode: "metadata_only",
      detail: check?.ok
        ? "API key source is present, but hosted provider smoke was not run. Start dashboard with --allow-remote-smoke true to perform a live /models check."
        : check?.error ?? "Provider metadata check failed.",
      redacted: true,
      ...(keySource ? { keySource } : {}),
      ...(check ? { check: redactProviderCheck(check) } : {}),
      troubleshooting: [
        ...result.troubleshooting,
        "Remote provider verification is opt-in to avoid surprising hosted-provider calls."
      ]
    });
  }

  const result = await doctorProviderRegistry({
    registry,
    providerId,
    smoke: true,
    allowRemoteSmoke,
    env
  });
  const check = result.checks[0];
  return redactedVerification({
    ok: Boolean(check?.ok),
    command,
    checkedAt,
    providerId,
    state: check?.ok ? "healthy" : "blocked",
    mode: "openai_compatible_models",
    detail: check?.ok
      ? `Verified ${displayProviderName(providerId, registry)} with a redacted /models check.`
      : check?.error ?? "Provider verification failed.",
    redacted: true,
    ...(keySource ? { keySource } : {}),
    ...(check ? { check: redactProviderCheck(check) } : {}),
    troubleshooting: result.troubleshooting
  });
}

export function renderLocalDashboardHtml(status: LocalDashboardStatusContract): string {
  const safeStatusJson = stringifyRedactedJson(status).replaceAll("</", "<\\/");
  const items = Object.values(status.items).map((item) => renderStatusItem(item)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NeonDiff Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171a1f;
      --muted: #5b6470;
      --line: #d8dee8;
      --panel: #ffffff;
      --wash: #f5f7fb;
      --ok: #16724b;
      --warn: #9a5b00;
      --bad: #b3261e;
      --accent: #155eef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--wash);
    }
    main {
      width: min(1120px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 32px 0 44px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 34px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    .command {
      flex: none;
      padding: 8px 10px;
      border: 1px solid var(--line);
      background: var(--panel);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      border-radius: 6px;
      color: #2e3440;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0;
    }
    .status-card, .setup-panel, .preview-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .status-card {
      min-height: 184px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 14px;
      font-weight: 700;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid currentColor;
      text-transform: uppercase;
    }
    .healthy { color: var(--ok); }
    .degraded, .configured_unverified { color: var(--warn); }
    .blocked, .not_configured { color: var(--bad); }
    .detail { font-size: 13px; color: var(--muted); }
    .actions {
      margin: auto 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 5px;
      font-size: 12px;
      color: #384250;
    }
    .setup-panel {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
      gap: 20px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .form-row { display: grid; gap: 7px; margin-top: 12px; }
    label { font-size: 13px; font-weight: 700; }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .check-row input { width: auto; min-height: 0; }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      margin-top: 12px;
      padding: 8px 12px;
      border: 1px solid #0f45bf;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { opacity: 0.58; cursor: progress; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 12px;
      border-radius: 6px;
      background: #111827;
      color: #e5e7eb;
      min-height: 132px;
      font-size: 12px;
    }
    .preview-panel { padding: 16px 18px; }
    .preview-panel code {
      display: block;
      margin-top: 8px;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #f9fafb;
      overflow-wrap: anywhere;
    }
    @media (max-width: 860px) {
      header, .setup-panel { display: grid; }
      .command { width: 100%; overflow-wrap: anywhere; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 540px) {
      main { width: min(100vw - 24px, 1120px); padding-top: 20px; }
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 28px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>NeonDiff Dashboard</h1>
        <p>First-run setup and readiness for the local PR reviewer. Output is redacted before it reaches the browser.</p>
      </div>
      <div class="command">neondiff dashboard</div>
    </header>
    <section class="grid" aria-label="Readiness status">
      ${items}
    </section>
    <section class="setup-panel" aria-label="Provider API key verification">
      <div>
        <h2>Provider Setup</h2>
        <p>Verify the provider key source before launching review work. Hosted provider smoke checks are opt-in.</p>
        <div class="form-row">
          <label for="provider-id">Provider</label>
          <select id="provider-id">
            ${renderProviderOptions(status)}
          </select>
        </div>
        <div class="form-row">
          <label for="api-key">API key</label>
          <input id="api-key" type="password" autocomplete="off" placeholder="Paste key for local verification; it is not echoed back">
        </div>
        <label class="check-row" for="allow-remote-smoke">
          <input id="allow-remote-smoke" type="checkbox">
          Allow hosted provider /models smoke check
        </label>
        <button id="verify-api-key" type="button">Verify API Key</button>
      </div>
      <div>
        <h2>Verification Result</h2>
        <pre id="verification-output">No provider verification has run in this browser session.</pre>
      </div>
    </section>
    <section class="preview-panel" aria-label="First review dry-run preview">
      <h2>First Review Dry Run</h2>
      <p>${escapeHtml(status.firstReviewPreview.detail)}</p>
      <code>${escapeHtml(status.firstReviewPreview.command)}</code>
    </section>
  </main>
  <script type="application/json" id="dashboard-status">${safeStatusJson}</script>
  <script>
    const button = document.getElementById("verify-api-key");
    const output = document.getElementById("verification-output");
    button.addEventListener("click", async () => {
      button.disabled = true;
      output.textContent = "Verifying provider readiness...";
      try {
        const response = await fetch("/api/provider/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: document.getElementById("provider-id").value,
            apiKey: document.getElementById("api-key").value,
            allowRemoteSmoke: document.getElementById("allow-remote-smoke").checked
          })
        });
        const json = await response.json();
        output.textContent = JSON.stringify(json, null, 2);
      } catch (error) {
        output.textContent = JSON.stringify({ ok: false, error: String(error) }, null, 2);
      } finally {
        document.getElementById("api-key").value = "";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export async function runLocalDashboardPreviewSmoke(input: {
  config: BotConfig;
  configPath: string;
  configExists: boolean;
  outputDir: string;
  host?: string;
  port?: number;
  launchdLabel?: string;
  providerId?: string;
  apiKey?: string;
  allowRemoteSmoke?: boolean;
  screenshotPath?: string;
  sourceSha?: string;
  requireActiveProductionLicense?: typeof requireActiveProductionLicense;
}): Promise<LocalDashboardPreviewSmokeResult> {
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const handle = await startLocalDashboardServer({
    config: input.config,
    configPath: input.configPath,
    configExists: input.configExists,
    host: input.host,
    port: input.port,
    launchdLabel: input.launchdLabel,
    openBrowser: false,
    allowRemoteSmoke: input.allowRemoteSmoke,
    requireActiveProductionLicense: input.requireActiveProductionLicense
  });

  try {
    const htmlResponse = await fetch(handle.url);
    const html = await htmlResponse.text();
    const statusResponse = await fetch(new URL("/api/status", handle.url));
    const statusText = await statusResponse.text();
    const providerVerifyResponse = await fetch(new URL("/api/provider/verify", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        allowRemoteSmoke: input.allowRemoteSmoke === true
      })
    });
    const providerVerifyText = await providerVerifyResponse.text();

    const htmlPath = join(outputDir, "dashboard.html");
    const statusPath = join(outputDir, "dashboard-status.json");
    const providerVerifyPath = join(outputDir, "provider-verify.json");
    const packetPath = join(outputDir, "preview-smoke.json");
    writeSecureFileSync(htmlPath, redactSecrets(html));
    writeSecureFileSync(statusPath, stringifyRedactedJson(JSON.parse(statusText)));
    writeSecureFileSync(providerVerifyPath, stringifyRedactedJson(JSON.parse(providerVerifyText)));

    const statusScriptRendered = html.includes('id="dashboard-status"');
    const controlsRendered =
      html.includes('id="provider-id"') &&
      html.includes('id="api-key"') &&
      html.includes('id="verify-api-key"') &&
      html.includes("Verify API Key");
    const settledUiState = {
      htmlLoaded: htmlResponse.ok && html.includes("NeonDiff Dashboard"),
      statusApiLoaded: statusResponse.ok,
      providerVerifyRouteLoaded: providerVerifyResponse.status === 200 || providerVerifyResponse.status === 422,
      controlsRendered,
      statusScriptRendered,
      providerVerifyStatus: providerVerifyResponse.status
    };
    const ok = Object.values(settledUiState)
      .filter((value): value is boolean => typeof value === "boolean")
      .every(Boolean);
    const result: LocalDashboardPreviewSmokeResult = {
      ok,
      command: "dashboard preview-smoke",
      route: "/",
      url: handle.url,
      ...(input.sourceSha ? { sourceSha: input.sourceSha } : {}),
      outputDir,
      htmlPath,
      statusPath,
      providerVerifyPath,
      packetPath,
      ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
      screenshotCaptured: Boolean(input.screenshotPath && existsSync(input.screenshotPath)),
      settledUiState,
      proofBoundary: "Preview/browser smoke proves the local HTML dashboard routes and controls only; it does not prove signed Mac app behavior, updater, TCC, customer readiness, or GA."
    };
    writeSecureFileSync(packetPath, stringifyRedactedJson(result));
    return JSON.parse(stringifyRedactedJson(result)) as LocalDashboardPreviewSmokeResult;
  } finally {
    await closeServer(handle.server);
  }
}

export async function startLocalDashboardServer(input: {
  config: BotConfig;
  configPath: string;
  configExists: boolean;
  host?: string;
  port?: number;
  launchdLabel?: string;
  openBrowser?: boolean;
  allowRemoteSmoke?: boolean;
  requireActiveProductionLicense?: typeof requireActiveProductionLicense;
}): Promise<LocalDashboardServerHandle> {
  let latestVerification: ProviderApiKeyVerificationResult | undefined;
  let status = await buildLocalDashboardStatus({
    config: input.config,
    configPath: input.configPath,
    configExists: input.configExists,
    launchdLabel: input.launchdLabel,
    providerVerification: latestVerification
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${input.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/") {
        status = await buildLocalDashboardStatus({
          config: input.config,
          configPath: input.configPath,
          configExists: input.configExists,
          launchdLabel: input.launchdLabel,
          providerVerification: latestVerification
        });
        writeResponse(response, 200, "text/html; charset=utf-8", renderLocalDashboardHtml(status));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        status = await buildLocalDashboardStatus({
          config: input.config,
          configPath: input.configPath,
          configExists: input.configExists,
          launchdLabel: input.launchdLabel,
          providerVerification: latestVerification
        });
        writeResponse(response, 200, "application/json; charset=utf-8", stringifyRedactedJson(status));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/provider/verify") {
        const admission = await (input.requireActiveProductionLicense ?? requireActiveProductionLicense)({
          operation: "provider_verify",
          config: input.config.license!
        });
        if (!admission.ok) {
          writeResponse(response, 403, "application/json; charset=utf-8", stringifyRedactedJson({
            ok: false,
            command: "dashboard verify-provider",
            state: "blocked",
            redacted: true,
            detail: `license ${admission.decision.status}: ${admission.decision.detail}`,
            troubleshooting: ["Activate NeonDiff with the canonical license service before provider verification."]
          }));
          return;
        }
        const body = await readJsonBody(request);
        latestVerification = await verifyProviderApiKey({
          config: input.config,
          providerId: readOptionalString(body, "providerId"),
          apiKey: readOptionalString(body, "apiKey"),
          allowRemoteSmoke: readOptionalBoolean(body, "allowRemoteSmoke") || input.allowRemoteSmoke === true
        });
        writeResponse(response, latestVerification.ok ? 200 : 422, "application/json; charset=utf-8", stringifyRedactedJson(latestVerification));
        return;
      }
      writeResponse(response, 404, "application/json; charset=utf-8", stringifyRedactedJson({ ok: false, error: "not found" }));
    } catch (error) {
      writeResponse(response, 500, "application/json; charset=utf-8", stringifyRedactedJson({
        ok: false,
        error: "dashboard request failed"
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, input.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${address.address === "::" ? "localhost" : address.address}:${address.port}/`;
  const openAttempted = input.openBrowser !== false;
  const openOk = openAttempted ? openLocalUrl(url) : false;
  return { server, url, status, openAttempted, openOk };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function buildLicenseStatusItem(config: BotConfig, checkedAt: string): Promise<LocalDashboardStatusItem> {
  if (!config.license?.enabled) {
    return {
      id: "license",
      label: "License",
      state: config.license?.publicReposFree ? "degraded" : "not_configured",
      detail: config.license?.publicReposFree
        ? "License enforcement is not enabled; public repository mode may work, private activation is still pending."
        : "License configuration is missing.",
      checkedAt,
      redacted: true,
      actions: ["Set license.apiBaseUrl and activate a license before private-repo launch."]
    };
  }
  const status = await getLicenseStatus({ config: config.license, refresh: false });
  return licenseStatusItemFromResult(status, checkedAt);
}

function licenseStatusItemFromResult(status: LicenseStatusResult, checkedAt: string): LocalDashboardStatusItem {
  return {
    id: "license",
    label: "License",
    state: status.ok ? (status.stale ? "degraded" : "healthy") : status.status === "missing" ? "not_configured" : "blocked",
    detail: status.detail,
    checkedAt,
    redacted: true,
    actions: status.ok ? ["License status is ready for the configured scope."] : ["Run neondiff license activate with a key stored outside shell history."],
    metadata: {
      status: status.status,
      source: status.source,
      stale: status.stale === true,
      plan: status.entitlement?.plan ?? null,
      licenseFingerprint: status.entitlement?.licenseFingerprint ?? null
    }
  };
}

function buildGitHubAppStatusItem(config: BotConfig, checkedAt: string): LocalDashboardStatusItem {
  const hasApp = Boolean(config.github.appId && config.github.privateKeyPath);
  const hasAppId = Boolean(config.github.appId);
  const hasClientId = Boolean(config.github.clientId);
  const hasReadableKeyPath = Boolean(config.github.privateKeyPath && existsSync(config.github.privateKeyPath));
  const hasFallbackToken = Boolean(config.github.token);
  const baseMetadata = {
    appIdConfigured: hasAppId,
    clientIdConfigured: hasClientId,
    botLogin: config.github.botLogin ?? null
  };
  if (hasAppId && hasClientId && !hasReadableKeyPath && !hasFallbackToken) {
    return {
      id: "githubApp",
      label: "GitHub App",
      state: "configured_unverified",
      detail: "GitHub App identity is configured for desktop sign-in; install/repo access still needs user authorization and doctor github proof.",
      checkedAt,
      redacted: true,
      actions: ["Connect GitHub from the desktop app, then run neondiff doctor github --config config.local.json --json for installation-scope proof."],
      metadata: baseMetadata
    };
  }
  if (hasApp && hasReadableKeyPath) {
    return {
      id: "githubApp",
      label: "GitHub App",
      state: "configured_unverified",
      detail: "GitHub App credentials are configured locally; run doctor github for installation-scope proof.",
      checkedAt,
      redacted: true,
      actions: ["Run neondiff doctor github --config config.local.json --json."],
      metadata: {
        ...baseMetadata,
        readMode: "app_installation",
        appIdConfigured: true,
        privateKeyPathPresent: true
      }
    };
  }
  if (hasFallbackToken) {
    return {
      id: "githubApp",
      label: "GitHub App",
      state: "degraded",
      detail: "Fallback GitHub token is present, but GitHub App installation proof is not configured.",
      checkedAt,
      redacted: true,
      actions: ["Create/install the GitHub App and set NEONDIFF_GITHUB_APP_ID plus NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH."],
      metadata: { ...baseMetadata, readMode: "fallback_token" }
    };
  }
  return {
    id: "githubApp",
    label: "GitHub App",
    state: "not_configured",
    detail: "No GitHub App credentials or fallback token are configured.",
    checkedAt,
    redacted: true,
    actions: ["Create/install the GitHub App before expecting PR reviews."],
    metadata: baseMetadata
  };
}

function buildDaemonStatusItem(config: BotConfig, checkedAt: string, launchdLabel?: string): LocalDashboardStatusItem {
  if (!launchdLabel) {
    return {
      id: "daemon",
      label: "Daemon",
      state: "not_configured",
      detail: "No launchd label was supplied to this dashboard session.",
      checkedAt,
      redacted: true,
      actions: ["Start with --launchd-label or use daemon start/status after setup."],
      metadata: {
        pollIntervalMs: config.pollIntervalMs
      }
    };
  }
  return {
    id: "daemon",
    label: "Daemon",
    state: "configured_unverified",
    detail: "Daemon label is configured for display; launchd status proof is a separate operator check.",
    checkedAt,
    redacted: true,
    actions: ["Run neondiff daemon status --config config.local.json --launchd-label <label>."],
    metadata: { launchdLabel }
  };
}

function buildProviderStatusItem(registry: ProviderRegistryConfig, checkedAt: string): LocalDashboardStatusItem {
  const providerId = registry.defaultProviderId;
  const provider = registry.providers[providerId];
  if (!provider) {
    return {
      id: "provider",
      label: "Provider",
      state: "blocked",
      detail: `Default provider ${providerId} is not configured.`,
      checkedAt,
      redacted: true,
      actions: ["Choose an existing provider id in providers.defaultProviderId."]
    };
  }
  const authReady = provider.authMode !== "api-key-env" || Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
  const state: LocalDashboardReadinessState = !provider.enabled
    ? "not_configured"
    : provider.authMode === "api-key-env" && !authReady
      ? "not_configured"
      : provider.capabilities.review && provider.capabilities.jsonOutput
        ? "configured_unverified"
        : "blocked";
  return {
    id: "provider",
    label: "Provider",
    state,
    detail: providerStatusDetail(providerId, registry, state),
    checkedAt,
    redacted: true,
    actions: provider.authMode === "api-key-env"
      ? ["Use Verify API Key to run a redacted readiness check."]
      : ["Run provider doctor or a review dry-run to verify runtime auth."],
    metadata: {
      providerId,
      adapter: provider.adapter,
      authMode: provider.authMode,
      apiKeyEnv: provider.apiKeyEnv ?? null,
      model: provider.model
    }
  };
}

function providerStatusDetail(providerId: string, registry: ProviderRegistryConfig, state: LocalDashboardReadinessState): string {
  const provider = registry.providers[providerId]!;
  if (!provider.enabled) return `${displayProviderName(providerId, registry)} is disabled.`;
  if (provider.authMode === "api-key-env" && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
    return `${displayProviderName(providerId, registry)} needs API key source ${provider.apiKeyEnv}.`;
  }
  if (!provider.capabilities.review || !provider.capabilities.jsonOutput) {
    return `${displayProviderName(providerId, registry)} is not ready for JSON PR reviews.`;
  }
  if (state === "configured_unverified") {
    return `${displayProviderName(providerId, registry)} is configured but has not been verified in this dashboard session.`;
  }
  return `${displayProviderName(providerId, registry)} status is ${state}.`;
}

function providerStatusItemFromVerification(result: ProviderApiKeyVerificationResult, checkedAt: string): LocalDashboardStatusItem {
  return {
    id: "provider",
    label: "Provider",
    state: result.state,
    detail: result.detail,
    checkedAt,
    redacted: true,
    actions: result.ok ? ["Provider readiness check passed."] : result.troubleshooting,
    metadata: {
      providerId: result.providerId,
      mode: result.mode,
      keySource: result.keySource ?? null
    }
  };
}

function displayProviderName(providerId: string, registry: ProviderRegistryConfig): string {
  return registry.providers[providerId]?.displayName ?? providerId;
}

export function isLoopbackProvider(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function redactProviderCheck(check: ProviderDoctorCheck): ProviderDoctorCheck {
  return JSON.parse(stringifyRedactedJson(check)) as ProviderDoctorCheck;
}

function redactedStatus(status: LocalDashboardStatusContract): LocalDashboardStatusContract {
  return JSON.parse(stringifyRedactedJson(status)) as LocalDashboardStatusContract;
}

function redactedVerification(result: ProviderApiKeyVerificationResult): ProviderApiKeyVerificationResult {
  return JSON.parse(stringifyRedactedJson(result)) as ProviderApiKeyVerificationResult;
}

function renderStatusItem(item: LocalDashboardStatusItem): string {
  return `<article class="status-card" data-status-id="${escapeHtml(item.id)}">
    <div class="label">
      <span>${escapeHtml(item.label)}</span>
      <span class="pill ${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
    </div>
    <p class="detail">${escapeHtml(item.detail)}</p>
    <ul class="actions">
      ${item.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}
    </ul>
  </article>`;
}

function renderProviderOptions(status: LocalDashboardStatusContract): string {
  return status.providers.options.map((option) => {
    const label = `${option.label} (${option.authMode})`;
    return `<option value="${escapeHtml(option.id)}"${option.default ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("\n");
}

function buildProviderOptions(registry: ProviderRegistryConfig): LocalDashboardProviderOption[] {
  return Object.entries(registry.providers).map(([id, provider]) => ({
    id,
    label: provider.displayName ?? id,
    adapter: provider.adapter,
    authMode: provider.authMode,
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    default: id === registry.defaultProviderId
  }));
}

function escapeHtml(value: string): string {
  return redactSecrets(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function openLocalUrl(url: string): boolean {
  try {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    if (Buffer.concat(chunks).length > 16 * 1024) throw new Error("request body is too large");
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function writeResponse(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}
