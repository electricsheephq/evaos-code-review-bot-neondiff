import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface CandidateCommandRequest {
  executable: string;
  args: string[];
  stdin?: string;
}

export interface CandidateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LifecycleRecord {
  id: "issue" | "activate" | "validate_active" | "deactivate" | "validate_denied";
  outcome: "succeeded" | "denied";
  statusCode: number;
  apiBaseUrl: string;
  redactedResponse: Record<string, unknown>;
}

export interface ProductionLifecycleArtifact {
  evidenceKind: "production-lifecycle";
  releaseVersion: string;
  candidateHead: string;
  packShasum: string;
  packIntegrity: string;
  harnessRunId: string;
  records: LifecycleRecord[];
}

export type LicenseLifecycleSmokeResult =
  | {
      ok: true;
      command: "license-lifecycle-smoke";
      observedAt: string;
      licenseFingerprint: string;
      artifact: ProductionLifecycleArtifact;
      lifecycle: {
        apiBaseUrl: string;
        licenseFingerprint: string;
        steps: Array<LifecycleRecord & { responseSha256: string }>;
      };
      proofBoundary: string;
    }
  | {
      ok: false;
      command: "license-lifecycle-smoke";
      errorCode:
        | "confirm_live_lifecycle_required"
        | "invalid_input"
        | "issuance_failed"
        | "candidate_failed"
        | "post_deactivation_validation_failed";
      detail: string;
      proofBoundary: string;
    };

export interface LicenseLifecycleSmokeInput {
  releaseVersion: string;
  candidateHead: string;
  packShasum: string;
  packIntegrity: string;
  apiBaseUrl: string;
  issuanceSecret: string;
  candidateCliPath: string;
  configPath: string;
  confirmLiveLifecycle: boolean;
  now?: () => Date;
  randomId?: () => string;
  fetchImpl?: typeof fetch;
  runCandidateCommand?: (request: CandidateCommandRequest) => Promise<CandidateCommandResult>;
}

export async function runLicenseLifecycleSmoke(input: LicenseLifecycleSmokeInput): Promise<LicenseLifecycleSmokeResult> {
  const boundary = "Disposable lifecycle only. The issuance bearer and raw license key stay in process memory or bounded candidate stdin and are never returned.";
  if (!input.confirmLiveLifecycle) {
    return failure("confirm_live_lifecycle_required", "live lifecycle confirmation is required", boundary);
  }
  if (!isValidInput(input)) return failure("invalid_input", "lifecycle input failed validation", boundary);

  const fetchImpl = input.fetchImpl ?? fetch;
  const runCandidate = input.runCandidateCommand ?? defaultRunCandidateCommand;
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const randomId = input.randomId ?? (() => randomBytes(16).toString("hex"));
  const harnessRunId = createHash("sha256")
    .update(`${input.releaseVersion}:${input.candidateHead}:${input.packShasum}:${observedAt}:${randomId()}`)
    .digest("hex");
  let rawKey: string | undefined;
  let deactivated = false;
  const records: LifecycleRecord[] = [];

  try {
    const issuance = await postJson(fetchImpl, `${input.apiBaseUrl}/v1/admin/licenses/issue`, {
      idempotencyKey: `neondiff-lifecycle-${input.releaseVersion}-${harnessRunId.slice(0, 24)}`,
      checkoutLookupKey: "neondiff_monthly",
      externalCheckoutId: `lifecycle-${harnessRunId.slice(0, 32)}`
    }, input.issuanceSecret);
    rawKey = readIssuedKey(issuance);
    if (!rawKey) return failure("issuance_failed", "production issuance did not return one valid disposable key", boundary);
    records.push(record("issue", "succeeded", issuance.statusCode, input.apiBaseUrl, { status: "issued" }));

    const activate = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "activate", "--config", input.configPath, "--license-key-stdin", "true", "--json"],
      stdin: `${rawKey}\n`
    });
    if (!activate.ok || activate.body.status !== "active" || activate.body.source !== "api") {
      return failure("candidate_failed", "candidate activation did not return active API state", boundary);
    }
    records.push(record("activate", "succeeded", 200, input.apiBaseUrl, { status: "active", source: "api" }));

    const activeStatus = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "status", "--config", input.configPath, "--refresh", "true", "--json"]
    });
    if (!activeStatus.ok || activeStatus.body.status !== "active" || activeStatus.body.source !== "api") {
      return failure("candidate_failed", "candidate refresh did not return active API state", boundary);
    }
    records.push(record("validate_active", "succeeded", 200, input.apiBaseUrl, { status: "active", source: "api" }));

    const deactivate = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "deactivate", "--config", input.configPath, "--notify-api", "true", "--json"]
    });
    if (!deactivate.ok || deactivate.body.status !== "revoked" && deactivate.body.status !== "deactivated") {
      return failure("candidate_failed", "candidate deactivation did not complete", boundary);
    }
    deactivated = true;
    records.push(record("deactivate", "succeeded", 200, input.apiBaseUrl, { status: "revoked" }));

    const denied = await postJson(fetchImpl, `${input.apiBaseUrl}/v1/license/validate`, {
      licenseKey: rawKey,
      machineId: `release-smoke-${harnessRunId.slice(0, 24)}`
    });
    if (denied.statusCode !== 403 || denied.body.status !== "revoked") {
      return failure("post_deactivation_validation_failed", "post-deactivation validation did not fail closed as revoked", boundary);
    }
    records.push(record("validate_denied", "denied", 403, input.apiBaseUrl, { status: "revoked" }));

    const licenseFingerprint = `sha256:${createHash("sha256").update(rawKey).digest("hex")}`;
    const artifact: ProductionLifecycleArtifact = {
      evidenceKind: "production-lifecycle",
      releaseVersion: input.releaseVersion,
      candidateHead: input.candidateHead,
      packShasum: input.packShasum,
      packIntegrity: input.packIntegrity,
      harnessRunId,
      records
    };
    return {
      ok: true,
      command: "license-lifecycle-smoke",
      observedAt,
      licenseFingerprint,
      artifact,
      lifecycle: {
        apiBaseUrl: input.apiBaseUrl,
        licenseFingerprint,
        steps: records.map((item) => ({
          ...item,
          responseSha256: createHash("sha256").update(JSON.stringify(item.redactedResponse)).digest("hex")
        }))
      },
      proofBoundary: boundary
    };
  } catch {
    return failure("candidate_failed", "lifecycle execution failed before redacted proof completed", boundary);
  } finally {
    if (rawKey && !deactivated) {
      try {
        await postJson(fetchImpl, `${input.apiBaseUrl}/v1/license/deactivate`, {
          licenseKey: rawKey,
          machineId: `release-smoke-cleanup-${harnessRunId.slice(0, 24)}`
        });
      } catch {
        // The caller receives a failed result and must treat cleanup as unresolved.
      }
    }
    rawKey = undefined;
  }
}

function isValidInput(input: LicenseLifecycleSmokeInput): boolean {
  try {
    const url = new URL(input.apiBaseUrl);
    return input.releaseVersion === "v1.0.4"
      && /^[a-f0-9]{40}$/.test(input.candidateHead)
      && /^[a-f0-9]{40}$/.test(input.packShasum)
      && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(input.packIntegrity)
      && url.protocol === "https:"
      && url.origin === "https://neondiff-license.fly.dev"
      && url.pathname === "/"
      && Boolean(input.issuanceSecret && input.candidateCliPath && input.configPath);
  } catch {
    return false;
  }
}

function record(
  id: LifecycleRecord["id"],
  outcome: LifecycleRecord["outcome"],
  statusCode: number,
  apiBaseUrl: string,
  redactedResponse: Record<string, unknown>
): LifecycleRecord {
  return { id, outcome, statusCode, apiBaseUrl, redactedResponse };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  bearer?: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error("response too large");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response was not an object");
  return { statusCode: response.status, body: parsed as Record<string, unknown> };
}

function readIssuedKey(response: { statusCode: number; body: Record<string, unknown> }): string | undefined {
  const key = response.body.licenseKey;
  return response.statusCode === 200
    && response.body.status === "issued"
    && typeof key === "string"
    && /^nd_live_[A-Za-z0-9_-]{8,}$/.test(key)
    ? key
    : undefined;
}

async function runCandidateJson(
  runner: (request: CandidateCommandRequest) => Promise<CandidateCommandResult>,
  request: CandidateCommandRequest
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const result = await runner(request);
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return { ok: false, body: {} };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, body: {} };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, body: {} };
  }
}

async function defaultRunCandidateCommand(request: CandidateCommandRequest): Promise<CandidateCommandResult> {
  const result = spawnSync(request.executable, request.args, {
    input: request.stdin,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function failure(
  errorCode: Extract<LicenseLifecycleSmokeResult, { ok: false }>["errorCode"],
  detail: string,
  proofBoundary: string
): Extract<LicenseLifecycleSmokeResult, { ok: false }> {
  return { ok: false, command: "license-lifecycle-smoke", errorCode, detail, proofBoundary };
}
