import { createHash, createHmac } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { LicenseStore } from "./store.js";
import type { ServiceResult } from "./service.js";

export interface LifecycleOidcClaims {
  repository: string;
  repository_id: string;
  sha: string;
  run_id: string;
  iat: number;
  [claim: string]: unknown;
}

export interface LifecycleOidcVerifier {
  verify(token: string): Promise<LifecycleOidcClaims>;
}

export interface LifecycleIssuanceRequest {
  releaseVersion: string;
  candidateHead: string;
  packShasum: string;
  packIntegrity: string;
}

export class LifecycleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleRequestError";
  }
}

const REQUEST_FIELDS = new Set([
  "releaseVersion",
  "candidateHead",
  "packShasum",
  "packIntegrity"
]);

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const LIFECYCLE_AUDIENCE = "neondiff-license-lifecycle";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const EXACT_STRING_CLAIMS = {
  repository: "electricsheephq/evaos-code-review-bot-neondiff",
  repository_id: "1285247004",
  repository_owner_id: "268512935",
  ref: "refs/heads/main",
  ref_type: "branch",
  workflow_ref:
    "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/license-lifecycle-proof.yml@refs/heads/main",
  environment: "license-lifecycle-production",
  sub: "repo:electricsheephq/evaos-code-review-bot-neondiff:environment:license-lifecycle-production",
  event_name: "workflow_dispatch",
  runner_environment: "github-hosted"
} as const;

export function createGitHubActionsOidcVerifier(options: {
  jwksUrl?: string;
  now?: () => Date;
  /** Test-only override; production keeps a cooldown against unknown-kid refetch abuse. */
  cooldownDuration?: number;
} = {}): LifecycleOidcVerifier {
  const now = options.now ?? (() => new Date());
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl ?? GITHUB_OIDC_JWKS), {
    cooldownDuration: options.cooldownDuration ?? 30_000,
    timeoutDuration: 5_000
  });
  return {
    async verify(token: string): Promise<LifecycleOidcClaims> {
      const currentDate = now();
      const { payload } = await jwtVerify(token, jwks, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: LIFECYCLE_AUDIENCE,
        algorithms: ["RS256"],
        clockTolerance: 5,
        maxTokenAge: "5m",
        currentDate,
        requiredClaims: [
          "iat",
          "nbf",
          "exp",
          "repository",
          "repository_id",
          "repository_owner_id",
          "ref",
          "ref_type",
          "ref_protected",
          "workflow_ref",
          "environment",
          "sub",
          "event_name",
          "runner_environment",
          "sha",
          "run_id"
        ]
      });
      return validateLifecycleClaims(payload, currentDate);
    }
  };
}

function validateLifecycleClaims(payload: JWTPayload, now: Date): LifecycleOidcClaims {
  if (payload.iss !== GITHUB_OIDC_ISSUER || payload.aud !== LIFECYCLE_AUDIENCE) {
    throw new Error("OIDC issuer or audience mismatch");
  }
  for (const [claim, expected] of Object.entries(EXACT_STRING_CLAIMS)) {
    if (payload[claim] !== expected) throw new Error(`OIDC ${claim} claim mismatch`);
  }
  if (payload.ref_protected !== "true" && payload.ref_protected !== true) {
    throw new Error("OIDC ref_protected claim mismatch");
  }
  if (typeof payload.sha !== "string" || !/^[a-f0-9]{40}$/.test(payload.sha)) {
    throw new Error("OIDC sha claim is invalid");
  }
  if (typeof payload.run_id !== "string" || !/^\d{1,20}$/.test(payload.run_id)) {
    throw new Error("OIDC run_id claim is invalid");
  }
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.nbf) || !Number.isInteger(payload.exp)) {
    throw new Error("OIDC timestamp claims are invalid");
  }
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (iat > nowSeconds + 5 || nowSeconds - iat > 300) throw new Error("OIDC iat is outside the allowed window");
  if (exp <= iat || exp - iat > 300) throw new Error("OIDC exp is outside the allowed window");
  return payload as LifecycleOidcClaims;
}

export function parseLifecycleIssuanceRequest(raw: string): LifecycleIssuanceRequest {
  let parsed: unknown;
  try {
    parsed = raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    throw new LifecycleRequestError("request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LifecycleRequestError("request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const unexpected = Object.keys(body).filter((key) => !REQUEST_FIELDS.has(key));
  if (unexpected.length > 0) throw new LifecycleRequestError("unexpected request fields");

  const releaseVersion = requiredString(body, "releaseVersion");
  const candidateHead = requiredString(body, "candidateHead");
  const packShasum = requiredString(body, "packShasum");
  const packIntegrity = requiredString(body, "packIntegrity");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion)) {
    throw new LifecycleRequestError("releaseVersion must be a stable v-prefixed semver");
  }
  if (!/^[a-f0-9]{40}$/.test(candidateHead)) throw new LifecycleRequestError("candidateHead must be a full lowercase commit SHA");
  if (!/^[a-f0-9]{40}$/.test(packShasum)) throw new LifecycleRequestError("packShasum must be a lowercase SHA-1 digest");
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(packIntegrity);
  const integrityBytes = integrityMatch ? Buffer.from(integrityMatch[1], "base64") : undefined;
  if (
    !integrityMatch ||
    !integrityBytes ||
    integrityBytes.byteLength !== 64 ||
    integrityBytes.toString("base64") !== integrityMatch[1]
  ) {
    throw new LifecycleRequestError("packIntegrity must be an npm sha512 integrity value");
  }
  return { releaseVersion, candidateHead, packShasum, packIntegrity };
}

export function issueLifecycleLicense(input: {
  store: LicenseStore;
  request: LifecycleIssuanceRequest;
  claims: LifecycleOidcClaims;
  issuanceSecret: string;
  now: Date;
}): ServiceResult {
  if (input.request.candidateHead !== input.claims.sha) {
    return {
      httpStatus: 403,
      body: { status: "forbidden", detail: "candidate head is not the authorized workflow SHA" }
    };
  }
  const idempotencyKey = `github-oidc:${input.claims.repository_id}:${input.claims.run_id}`;
  const requestHash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
  const rawKey = [
    "nd",
    "live",
    createHmac("sha256", input.issuanceSecret)
      .update(`lifecycle-license:${idempotencyKey}`)
      .digest()
      .subarray(0, 24)
      .toString("base64url")
  ].join("_");
  const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
  try {
    const issued = input.store.issueIdempotentLicense(rawKey, {
      idempotencyKey,
      requestHash,
      source: "github_actions_oidc_lifecycle",
      externalRef: `${input.claims.repository}:${input.claims.run_id}`,
      plan: "release_lifecycle",
      repoVisibilityScope: "all",
      privateRepoAllowed: true,
      updateEntitlement: true,
      seats: 1,
      expiresAt
    });
    return {
      httpStatus: 200,
      body: {
        status: "issued",
        replayed: issued.replayed,
        licenseKey: issued.rawKey,
        licenseKeyHash: issued.record.licenseKeyHash,
        entitlement: {
          status: "active",
          repoVisibilityScope: issued.record.repoVisibilityScope,
          privateRepoAllowed: issued.record.privateRepoAllowed,
          updateEntitlement: issued.record.updateEntitlement,
          plan: issued.record.plan,
          seats: issued.record.seats,
          expiresAt: issued.record.expiresAt
        }
      }
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "license issuance failed";
    if (detail.includes("idempotency key")) {
      return {
        httpStatus: 409,
        body: { status: "conflict", detail: "workflow run was already used with different release data" }
      };
    }
    return { httpStatus: 500, body: { status: "server", detail: "license issuance failed" } };
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new LifecycleRequestError(`${field} is required`);
  if (value !== value.trim()) throw new LifecycleRequestError(`${field} must not have surrounding whitespace`);
  if (value.length > 256) throw new LifecycleRequestError(`${field} is too long`);
  return value;
}
