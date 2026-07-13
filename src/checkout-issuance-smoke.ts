import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { redactSecrets } from "./secrets.js";

const CHECKOUT_LOOKUP_KEYS = new Set(["neondiff_monthly", "neondiff_yearly", "neondiff_org_yearly"]);
const CHECKOUT_ISSUANCE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024;
const DEFAULT_CAPTURE_CONTEXT = {
  tool: "neondiff checkout-issuance-smoke",
  transport: "https",
  tlsValidation: "node default CA validation",
  capturedFrom: "operator CLI"
} as const;

export type CheckoutLookupKey = "neondiff_monthly" | "neondiff_yearly" | "neondiff_org_yearly";
export type CheckoutProviderMode = "test" | "live";
export type CheckoutIssuanceFetch = typeof fetch;

export interface CheckoutProviderTupleInput {
  providerAccountId: string;
  providerMode: string;
  externalSubscriptionId: string;
  externalCheckoutId: string;
}

export interface CheckoutProviderTuple {
  provider: "stripe";
  providerAccountId: string;
  providerMode: CheckoutProviderMode;
  externalSubscriptionId: string;
  externalCheckoutId: string;
}

export interface CheckoutIssuanceSmokeInput extends CheckoutProviderTupleInput {
  url: string;
  releaseVersion: string;
  checkoutLookupKey: string;
  confirmLiveIssuance: boolean;
  secretEnvName: string;
  env?: Record<string, string | undefined>;
  idempotencyKey?: string;
  outputPath?: string;
  cwd?: string;
  now?: () => Date;
  fetchImpl?: CheckoutIssuanceFetch;
}

export interface CheckoutIssuanceSmokeRequestPreview {
  idempotencyKey: string;
  checkoutLookupKey: CheckoutLookupKey;
  provider: "stripe";
  providerAccountId: string;
  providerMode: CheckoutProviderMode;
  externalSubscriptionId: string;
  externalCheckoutId: string;
}

export interface CheckoutIssuanceSmokeRequestSummary {
  checkoutLookupKey: CheckoutLookupKey;
  provider: "stripe";
  providerMode: CheckoutProviderMode;
}

export type CheckoutIssuanceSmokeRequestResult =
  | { ok: true; requestPreview: CheckoutIssuanceSmokeRequestPreview }
  | {
      ok: false;
      errorCode: "invalid_provider_tuple" | "invalid_checkout_lookup_key";
      detail: string;
    };

export interface AuthenticatedCheckoutIssuanceProof {
  evidenceKind: "license_api_checkout_issuance_authenticated";
  releaseVersion: string;
  observedAt: string;
  method: "POST";
  url: string;
  statusCode: 200;
  redactedResponse: {
    status: "issued";
    replayed: boolean;
    checkoutLookupKey: CheckoutLookupKey;
    issuedLicensePrefix: "nd_live_";
    issuedLicenseFingerprint: string;
  };
  captureContext: typeof DEFAULT_CAPTURE_CONTEXT;
}

export type CheckoutIssuanceSmokeResult =
  | {
      ok: true;
      command: "checkout-issuance-smoke";
      proof: AuthenticatedCheckoutIssuanceProof;
      proofPath?: string;
      requestPreview: CheckoutIssuanceSmokeRequestSummary;
      proofBoundary: string;
    }
  | {
      ok: false;
      command: "checkout-issuance-smoke";
      errorCode:
        | "confirm_live_issuance_required"
        | "invalid_url"
        | "invalid_checkout_lookup_key"
        | "invalid_provider_tuple"
        | "invalid_output_path"
        | "missing_secret_env"
        | "fetch_failed"
        | "response_too_large"
        | "invalid_json_response"
        | "unexpected_status"
        | "invalid_success_response";
      detail: string;
      secretEnvName?: string;
      statusCode?: number;
      requestPreview?: CheckoutIssuanceSmokeRequestSummary;
      proofBoundary: string;
    };

export function buildCheckoutIssuanceSmokeRequestPreview(input: {
  releaseVersion: string;
  checkoutLookupKey: string;
  idempotencyKey?: string;
} & CheckoutProviderTupleInput): CheckoutIssuanceSmokeRequestPreview {
  const checkoutLookupKey = normalizeCheckoutLookupKey(input.checkoutLookupKey);
  const providerTuple = normalizeCheckoutProviderTuple(input);
  const idempotencyKey = input.idempotencyKey
    ?? defaultIdempotencyKey(input.releaseVersion, checkoutLookupKey, providerTuple);
  return {
    idempotencyKey,
    checkoutLookupKey,
    ...providerTuple
  };
}

export function buildCheckoutIssuanceSmokeRequestResult(input: {
  releaseVersion: string;
  checkoutLookupKey: string;
  idempotencyKey?: string;
} & CheckoutProviderTupleInput): CheckoutIssuanceSmokeRequestResult {
  try {
    return { ok: true, requestPreview: buildCheckoutIssuanceSmokeRequestPreview(input) };
  } catch (error) {
    return {
      ok: false,
      errorCode: error instanceof InvalidProviderTupleError
        ? "invalid_provider_tuple"
        : "invalid_checkout_lookup_key",
      detail: error instanceof Error ? error.message : "invalid checkout issuance input"
    };
  }
}

export function normalizeCheckoutProviderTuple(
  input: CheckoutProviderTupleInput
): CheckoutProviderTuple {
  const providerMode = input.providerMode?.trim();
  if (providerMode !== "test" && providerMode !== "live") {
    throw new InvalidProviderTupleError("providerMode must be test or live");
  }
  return {
    provider: "stripe",
    providerAccountId: readProviderTupleField(input.providerAccountId, "providerAccountId"),
    providerMode,
    externalSubscriptionId: readProviderTupleField(
      input.externalSubscriptionId,
      "externalSubscriptionId"
    ),
    externalCheckoutId: readProviderTupleField(input.externalCheckoutId, "externalCheckoutId")
  };
}

export function checkoutProviderTupleFingerprint(tuple: CheckoutProviderTuple): string {
  const digest = createHash("sha256")
    .update("neondiff-checkout-provider-tuple-v1\0")
    .update(JSON.stringify([
      tuple.provider,
      tuple.providerAccountId,
      tuple.providerMode,
      tuple.externalSubscriptionId,
      tuple.externalCheckoutId
    ]))
    .digest("hex")
    .slice(0, 20);
  return digest.match(/.{4}/g)!.join("_");
}

export function validateCheckoutIssuanceUrl(url: string): { ok: true } | { ok: false; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, detail: "checkout issuance URL must be a valid HTTPS URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, detail: "checkout issuance URL must use https://" };
  }
  return { ok: true };
}

export async function runCheckoutIssuanceSmoke(input: CheckoutIssuanceSmokeInput): Promise<CheckoutIssuanceSmokeResult> {
  const requestResult = buildCheckoutIssuanceSmokeRequestResult(input);
  if (!requestResult.ok) return failure(requestResult.errorCode, requestResult.detail);
  const { requestPreview } = requestResult;

  const urlCheck = validateCheckoutIssuanceUrl(input.url);
  if (!urlCheck.ok) return failure("invalid_url", urlCheck.detail, { requestPreview });

  const outputPath = input.outputPath
    ? resolveConfinedProofOutputPath(input.cwd ?? process.cwd(), input.outputPath)
    : undefined;
  if (outputPath && !outputPath.ok) {
    return failure("invalid_output_path", outputPath.detail, { requestPreview });
  }

  if (!input.confirmLiveIssuance) {
    return failure(
      "confirm_live_issuance_required",
      "checkout issuance smoke requires --confirm-live-issuance true before reading the owner-held secret or sending a live POST",
      { requestPreview }
    );
  }

  const env = input.env ?? process.env;
  const secret = env[input.secretEnvName];
  if (!secret) {
    return failure(
      "missing_secret_env",
      "secret env var did not resolve to a non-empty value",
      { secretEnvName: input.secretEnvName, requestPreview }
    );
  }

  let response: Response;
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify(requestPreview),
      signal: AbortSignal.timeout(CHECKOUT_ISSUANCE_TIMEOUT_MS)
    });
  } catch {
    return failure(
      "fetch_failed",
      "checkout issuance request failed before receiving a response",
      { requestPreview }
    );
  }

  if (response.status !== 200) {
    return failure("unexpected_status", `checkout issuance returned HTTP ${response.status}`, {
      statusCode: response.status,
      requestPreview
    });
  }

  const bodyText = await readBoundedResponseText(response);
  if (!bodyText.ok) {
    return failure("response_too_large", bodyText.detail, {
      statusCode: response.status,
      requestPreview
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText.text) as Record<string, unknown>;
  } catch {
    return failure("invalid_json_response", "checkout issuance response was not JSON", {
      statusCode: response.status,
      requestPreview
    });
  }

  const proof = buildProofFromSuccess({
    url: input.url,
    releaseVersion: input.releaseVersion,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    statusCode: response.status,
    checkoutLookupKey: requestPreview.checkoutLookupKey,
    body
  });
  if (!proof.ok) {
    return failure("invalid_success_response", proof.detail, {
      statusCode: response.status,
      requestPreview
    });
  }

  if (outputPath?.ok) {
    mkdirSync(dirname(outputPath.absolutePath), { recursive: true });
    writeFileSync(outputPath.absolutePath, `${JSON.stringify(proof.proof, null, 2)}\n`);
  }

  return {
    ok: true,
    command: "checkout-issuance-smoke",
    proof: proof.proof,
    ...(input.outputPath ? { proofPath: input.outputPath } : {}),
    requestPreview: summarizeCheckoutIssuanceRequest(requestPreview),
    proofBoundary: "Redacted authenticated checkout issuance proof only; raw license keys and bearer secrets are never written."
  };
}

function buildProofFromSuccess(input: {
  url: string;
  releaseVersion: string;
  observedAt: string;
  statusCode: number;
  checkoutLookupKey: CheckoutLookupKey;
  body: Record<string, unknown>;
}): { ok: true; proof: AuthenticatedCheckoutIssuanceProof } | { ok: false; detail: string } {
  const status = input.body.status;
  const replayed = input.body.replayed;
  const licenseKey = input.body.licenseKey;
  const responseCheckoutLookupKey = input.body.checkoutLookupKey;
  if (status !== "issued") return { ok: false, detail: "checkout issuance response status was not issued" };
  if (typeof replayed !== "boolean") return { ok: false, detail: "checkout issuance response replayed was not boolean" };
  if (responseCheckoutLookupKey !== undefined && responseCheckoutLookupKey !== input.checkoutLookupKey) {
    return { ok: false, detail: "checkout issuance response checkoutLookupKey did not match the request" };
  }
  if (typeof licenseKey !== "string" || !licenseKey.startsWith("nd_live_")) {
    return { ok: false, detail: "checkout issuance response did not include an nd_live_ license key" };
  }
  return {
    ok: true,
    proof: {
      evidenceKind: "license_api_checkout_issuance_authenticated",
      releaseVersion: input.releaseVersion,
      observedAt: input.observedAt,
      method: "POST",
      url: input.url,
      statusCode: 200,
      redactedResponse: {
        status: "issued",
        replayed,
        checkoutLookupKey: input.checkoutLookupKey,
        issuedLicensePrefix: "nd_live_",
        issuedLicenseFingerprint: `sha256:${createHash("sha256").update(licenseKey).digest("hex")}`
      },
      captureContext: DEFAULT_CAPTURE_CONTEXT
    }
  };
}

function normalizeCheckoutLookupKey(input: string): CheckoutLookupKey {
  if (CHECKOUT_LOOKUP_KEYS.has(input)) return input as CheckoutLookupKey;
  throw new Error("checkoutLookupKey must be one of: neondiff_monthly, neondiff_yearly, neondiff_org_yearly");
}

function defaultIdempotencyKey(
  releaseVersion: string,
  checkoutLookupKey: CheckoutLookupKey,
  providerTuple: CheckoutProviderTuple
): string {
  return [
    "neondiff-smoke",
    releaseVersion,
    checkoutLookupKey,
    providerTuple.providerMode,
    checkoutProviderTupleFingerprint(providerTuple)
  ].join("-");
}

function summarizeCheckoutIssuanceRequest(
  preview: CheckoutIssuanceSmokeRequestPreview
): CheckoutIssuanceSmokeRequestSummary {
  return {
    checkoutLookupKey: preview.checkoutLookupKey,
    provider: preview.provider,
    providerMode: preview.providerMode
  };
}

class InvalidProviderTupleError extends Error {}

function readProviderTupleField(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidProviderTupleError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 160) {
    throw new InvalidProviderTupleError(`${field} is too long`);
  }
  return trimmed;
}

function resolveConfinedProofOutputPath(
  cwd: string,
  outputPath: string
): { ok: true; absolutePath: string } | { ok: false; detail: string } {
  if (isAbsolute(outputPath)) {
    return { ok: false, detail: "--output must be relative and stay within docs/evidence" };
  }
  const evidenceRoot = resolve(cwd, "docs", "evidence");
  const absolutePath = resolve(cwd, outputPath);
  const rel = relative(evidenceRoot, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, detail: "--output must be relative and stay within docs/evidence" };
  }
  if (existsSync(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
    return { ok: false, detail: "--output must not point at a symlink" };
  }
  if (hasSymlinkPathSegment(cwd, dirname(absolutePath))) {
    return { ok: false, detail: "--output parent must resolve within docs/evidence" };
  }
  const realCwd = realpathSync.native(cwd);
  const existingEvidenceBoundary = nearestExistingParent(evidenceRoot);
  if (existingEvidenceBoundary) {
    const realEvidenceBoundary = realpathSync.native(existingEvidenceBoundary);
    if (!isPathInsideOrEqual(realEvidenceBoundary, realCwd)) {
      return { ok: false, detail: "--output parent must resolve within docs/evidence" };
    }
  }
  const existingParent = nearestExistingParent(dirname(absolutePath));
  if (existingParent) {
    const realParent = realpathSync.native(existingParent);
    if (!isPathInsideOrEqual(realParent, realCwd)) {
      return { ok: false, detail: "--output parent must resolve within docs/evidence" };
    }
    if (existsSync(evidenceRoot)) {
      const realEvidenceRoot = realpathSync.native(evidenceRoot);
      if (!isPathInsideOrEqual(realParent, realEvidenceRoot)) {
        return { ok: false, detail: "--output parent must resolve within docs/evidence" };
      }
    }
  }
  return { ok: true, absolutePath };
}

async function readBoundedResponseText(response: Response): Promise<
  { ok: true; text: string } | { ok: false; detail: string }
> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
    return { ok: false, detail: `checkout issuance response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes` };
  }
  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, detail: `checkout issuance response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes` };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function nearestExistingParent(path: string): string | undefined {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function isPathInsideOrEqual(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasSymlinkPathSegment(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let current = root;
  for (const segment of rel.split(/[\\/]+/)) {
    if (!segment) continue;
    current = resolve(current, segment);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function failure(
  errorCode: CheckoutIssuanceSmokeResult extends infer R
    ? R extends { ok: false; errorCode: infer E }
      ? E
      : never
      : never,
  detail: string,
  extra: Partial<Extract<CheckoutIssuanceSmokeResult, { ok: false }>> = {}
): Extract<CheckoutIssuanceSmokeResult, { ok: false }> {
  return {
    ok: false,
    command: "checkout-issuance-smoke",
    errorCode,
    detail: redactSecrets(detail),
    proofBoundary: "No authenticated checkout issuance proof was produced.",
    ...redactFailureExtra(extra)
  };
}

function redactFailureExtra(
  extra: Partial<Extract<CheckoutIssuanceSmokeResult, { ok: false }>>
): Partial<Extract<CheckoutIssuanceSmokeResult, { ok: false }>> {
  const requestPreview = extra.requestPreview as CheckoutIssuanceSmokeRequestPreview | undefined;
  return {
    ...extra,
    ...(requestPreview
      ? { requestPreview: summarizeCheckoutIssuanceRequest(requestPreview) }
      : {}),
    ...(typeof extra.secretEnvName === "string"
      ? { secretEnvName: isSafeEnvName(extra.secretEnvName) ? extra.secretEnvName : "[redacted-secret]" }
      : {})
  };
}

function isSafeEnvName(input: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(input);
}
