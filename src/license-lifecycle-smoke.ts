import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname, platform } from "node:os";

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
        | "post_deactivation_validation_failed"
        | "cleanup_unresolved";
      detail: string;
      cleanup?: {
        localState: "not_applicable" | "confirmed_removed" | "unresolved";
        remoteState: "not_applicable" | "confirmed_deactivated" | "unresolved";
      };
      proofBoundary: string;
    };

export interface LicenseLifecycleSmokeInput {
  releaseVersion: string;
  candidateHead: string;
  packShasum: string;
  packIntegrity: string;
  apiBaseUrl: string;
  issuanceAuthorization: {
    kind: "shared-secret" | "github-oidc";
    bearer: string;
  };
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
  const issuanceIdentity = createHash("sha256")
    .update(`${input.releaseVersion}:${input.candidateHead}:${input.packShasum}:${input.packIntegrity}:license-lifecycle`)
    .digest("hex");
  let rawKey: string | undefined;
  let licenseFingerprint: string | undefined;
  let activationAttempted = false;
  let localState: "not_applicable" | "confirmed_removed" | "unresolved" = "not_applicable";
  let remoteState: "not_applicable" | "confirmed_deactivated" | "unresolved" = "not_applicable";
  let executionFailure: Extract<LicenseLifecycleSmokeResult, { ok: false }> | undefined;
  let lifecycleSucceeded = false;
  const records: LifecycleRecord[] = [];

  try {
    const githubOidcIssuance = input.issuanceAuthorization.kind === "github-oidc";
    const issuance = await postJson(
      fetchImpl,
      `${input.apiBaseUrl}${githubOidcIssuance ? "/v1/admin/licenses/issue-lifecycle" : "/v1/admin/licenses/issue"}`,
      githubOidcIssuance
        ? {
            releaseVersion: input.releaseVersion,
            candidateHead: input.candidateHead,
            packShasum: input.packShasum,
            packIntegrity: input.packIntegrity
          }
        : {
            idempotencyKey: `neondiff-lifecycle-${input.releaseVersion}-${issuanceIdentity.slice(0, 24)}`,
            checkoutLookupKey: "neondiff_monthly",
            externalCheckoutId: `lifecycle-${issuanceIdentity.slice(0, 32)}`
          },
      input.issuanceAuthorization.bearer
    );
    rawKey = readIssuedKey(issuance);
    if (!rawKey) {
      executionFailure = failure("issuance_failed", "production issuance did not return one valid disposable key", boundary);
      throw new Error("issuance failed");
    }
    licenseFingerprint = `sha256:${createHash("sha256").update(rawKey).digest("hex")}`;
    localState = "unresolved";
    remoteState = "unresolved";
    records.push(record("issue", "succeeded", issuance.statusCode, input.apiBaseUrl, { status: "issued" }));

    activationAttempted = true;
    const activate = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "activate", "--config", input.configPath, "--license-key-stdin", "true", "--json"],
      stdin: `${rawKey}\n`
    });
    if (!activate.ok || activate.body.status !== "active" || activate.body.source !== "api") {
      executionFailure = failure("candidate_failed", "candidate activation did not return active API state", boundary);
      throw new Error("candidate activation failed");
    }
    records.push(record("activate", "succeeded", 200, input.apiBaseUrl, { status: "active", source: "api" }));

    const activeStatus = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "status", "--config", input.configPath, "--refresh", "true", "--json"]
    });
    if (!activeStatus.ok || activeStatus.body.status !== "active" || activeStatus.body.source !== "api") {
      executionFailure = failure("candidate_failed", "candidate refresh did not return active API state", boundary);
      throw new Error("candidate refresh failed");
    }
    records.push(record("validate_active", "succeeded", 200, input.apiBaseUrl, { status: "active", source: "api" }));

    const deactivate = await runCandidateJson(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "deactivate", "--config", input.configPath, "--notify-api", "true", "--json"]
    });
    if (!deactivate.ok || (deactivate.body.status !== "revoked" && deactivate.body.status !== "deactivated")) {
      executionFailure = failure("candidate_failed", "candidate deactivation did not complete", boundary);
      throw new Error("candidate deactivation failed");
    }
    records.push(record("deactivate", "succeeded", 200, input.apiBaseUrl, { status: "deactivated" }));

    const localMissing = await runCandidateJsonAnyExit(runCandidate, {
      executable: input.candidateCliPath,
      args: ["license", "status", "--config", input.configPath, "--json"]
    });
    if (localMissing.body.status !== "missing") {
      executionFailure = failure("candidate_failed", "candidate local key/cache removal was not confirmed", boundary);
      throw new Error("local cleanup failed");
    }
    localState = "confirmed_removed";

    const denied = await postJson(fetchImpl, `${input.apiBaseUrl}/v1/license/validate`, {
      licenseKey: rawKey,
      machineId: localMachineId()
    });
    if (denied.statusCode !== 409 || denied.body.status !== "scope_mismatch") {
      executionFailure = failure("post_deactivation_validation_failed", "same-machine validation did not fail closed after deactivation", boundary);
      throw new Error("remote cleanup failed");
    }
    remoteState = "confirmed_deactivated";
    records.push(record("validate_denied", "denied", 409, input.apiBaseUrl, { status: "scope_mismatch" }));
    lifecycleSucceeded = true;
  } catch {
    executionFailure ??= failure("candidate_failed", "lifecycle execution failed before redacted proof completed", boundary);
  } finally {
    if (rawKey) {
      if (activationAttempted && localState !== "confirmed_removed") {
        try {
          await runCandidateJsonAnyExit(runCandidate, {
            executable: input.candidateCliPath,
            args: ["license", "deactivate", "--config", input.configPath, "--notify-api", "false", "--json"]
          });
          const missing = await runCandidateJsonAnyExit(runCandidate, {
            executable: input.candidateCliPath,
            args: ["license", "status", "--config", input.configPath, "--json"]
          });
          if (missing.body.status === "missing") localState = "confirmed_removed";
        } catch {
          localState = "unresolved";
        }
      } else if (!activationAttempted) {
        localState = "not_applicable";
      }
      if (remoteState !== "confirmed_deactivated") {
        for (let attempt = 0; attempt < 3 && remoteState !== "confirmed_deactivated"; attempt += 1) {
          try {
            await postJson(fetchImpl, `${input.apiBaseUrl}/v1/license/deactivate`, {
              licenseKey: rawKey,
              machineId: localMachineId()
            });
            const denied = await postJson(fetchImpl, `${input.apiBaseUrl}/v1/license/validate`, {
              licenseKey: rawKey,
              machineId: localMachineId()
            });
            if (denied.statusCode === 409 && denied.body.status === "scope_mismatch") {
              remoteState = "confirmed_deactivated";
            }
          } catch {
            remoteState = "unresolved";
          }
        }
      }
    }
    rawKey = undefined;
  }

  const cleanup = { localState, remoteState };
  if (executionFailure || !lifecycleSucceeded) {
    return { ...(executionFailure ?? failure("candidate_failed", "lifecycle execution failed", boundary)), cleanup };
  }
  if (localState !== "confirmed_removed" || remoteState !== "confirmed_deactivated" || !licenseFingerprint) {
    return { ...failure("cleanup_unresolved", "lifecycle cleanup could not be confirmed", boundary), cleanup };
  }
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
}

function isValidInput(input: LicenseLifecycleSmokeInput): boolean {
  try {
    const url = new URL(input.apiBaseUrl);
    return isStableVersionAtLeastV104(input.releaseVersion)
      && /^[a-f0-9]{40}$/.test(input.candidateHead)
      && /^[a-f0-9]{40}$/.test(input.packShasum)
      && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(input.packIntegrity)
      && url.protocol === "https:"
      && url.origin === "https://neondiff-license.fly.dev"
      && url.pathname === "/"
      && (input.issuanceAuthorization.kind === "shared-secret" || input.issuanceAuthorization.kind === "github-oidc")
      && input.issuanceAuthorization.bearer.length >= 8
      && input.issuanceAuthorization.bearer.length <= 16 * 1024
      && Boolean(input.candidateCliPath && input.configPath);
  } catch {
    return false;
  }
}

function isStableVersionAtLeastV104(version: string): boolean {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [1, 0, 4];
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function localMachineId(): string {
  return createHash("sha256").update(`${platform()}:${hostname()}`).digest("hex").slice(0, 24);
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

async function runCandidateJsonAnyExit(
  runner: (request: CandidateCommandRequest) => Promise<CandidateCommandResult>,
  request: CandidateCommandRequest
): Promise<{ exitCode: number; body: Record<string, unknown> }> {
  const result = await runner(request);
  if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return { exitCode: result.exitCode, body: {} };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { exitCode: result.exitCode, body: parsed as Record<string, unknown> }
      : { exitCode: result.exitCode, body: {} };
  } catch {
    return { exitCode: result.exitCode, body: {} };
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
