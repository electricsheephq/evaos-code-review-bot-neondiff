import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { LicenseStore } from "./store.js";
import {
  issueCheckoutLicense,
  malformedIssuanceResult,
  parseIssuanceRequest,
  validateBearerSecret
} from "./issuance.js";
import {
  activate,
  deactivate,
  malformedResult,
  RateLimiter,
  rateLimitedResult,
  validate,
  type LicenseRequest,
  type ServiceResult
} from "./service.js";
import {
  issueLifecycleLicense,
  parseLifecycleIssuanceRequest,
  type LifecycleOidcVerifier
} from "./oidc-lifecycle.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface LicenseHttpOptions {
  store: LicenseStore;
  rateLimiter?: RateLimiter;
  issuanceSecret?: string;
  lifecycleOidcVerifier?: LifecycleOidcVerifier;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

type Handler = (store: LicenseStore, req: LicenseRequest, now: Date) => ServiceResult;

const ROUTES: Record<string, Handler> = {
  "/v1/license/activate": activate,
  "/v1/license/validate": validate,
  "/v1/license/deactivate": deactivate
};

/**
 * Build the request listener for the license API. Kept transport-thin: parse,
 * validate shape, per-key rate-limit, dispatch to the pure service functions,
 * serialize. Never logs or echoes the raw license key.
 */
export function createLicenseRequestListener(options: LicenseHttpOptions) {
  const now = options.now ?? (() => new Date());
  const rateLimiter =
    options.rateLimiter ?? new RateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET" && req.url === "/healthz") {
      return writeJson(res, 200, { status: "ok" });
    }
    const path = req.url?.split("?")[0];
    if (req.method === "POST" && path === "/v1/admin/licenses/issue") {
      return handleIssuanceRequest(options, req, res);
    }
    if (req.method === "POST" && path === "/v1/admin/licenses/issue-lifecycle") {
      return handleLifecycleIssuanceRequest(options, req, res);
    }

    const route = path ? ROUTES[path] : undefined;
    if (req.method !== "POST" || !route) {
      return writeResult(res, malformedResult("unknown route"), 404);
    }

    let parsed: LicenseRequest;
    try {
      parsed = parseRequest(await readBody(req));
    } catch (error) {
      return writeResult(res, malformedResult(error instanceof Error ? error.message : "malformed request body"));
    }

    // Per-key sliding window; the hot validate path is what the client polls.
    const rateLimitKey = createHash("sha256").update(parsed.licenseKey).digest("hex");
    if (!rateLimiter.allow(rateLimitKey, Date.now())) {
      return writeResult(res, rateLimitedResult());
    }

    try {
      return writeResult(res, route(options.store, parsed, now()));
    } catch {
      // Never surface internal error text (could contain no key, but stay safe) → 500 server.
      return writeJson(res, 500, { status: "server", detail: "internal error" });
    }
  };
}

async function handleLifecycleIssuanceRequest(
  options: LicenseHttpOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!options.issuanceSecret || !options.lifecycleOidcVerifier) {
    return writeJson(res, 503, { status: "server", detail: "lifecycle issuance is not configured" });
  }
  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length === "Bearer ".length) {
    return writeJson(res, 401, { status: "unauthorized", detail: "lifecycle issuance authorization failed" });
  }
  try {
    const claims = await options.lifecycleOidcVerifier.verify(authorization.slice("Bearer ".length));
    const request = parseLifecycleIssuanceRequest(await readBody(req));
    return writeResult(
      res,
      issueLifecycleLicense({
        store: options.store,
        request,
        claims,
        issuanceSecret: options.issuanceSecret,
        now: (options.now ?? (() => new Date()))()
      })
    );
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("request body"))) {
      return writeResult(res, malformedIssuanceResult(error.message));
    }
    if (error instanceof Error && /^(unexpected|releaseVersion|candidateHead|packShasum|packIntegrity)/.test(error.message)) {
      return writeResult(res, malformedIssuanceResult(error.message));
    }
    return writeJson(res, 401, { status: "unauthorized", detail: "lifecycle issuance authorization failed" });
  }
}

async function handleIssuanceRequest(
  options: LicenseHttpOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!options.issuanceSecret) {
    return writeJson(res, 503, { status: "server", detail: "license issuance is not configured" });
  }
  if (!validateBearerSecret(req.headers.authorization, options.issuanceSecret)) {
    return writeJson(res, 401, { status: "unauthorized", detail: "license issuance authorization failed" });
  }

  try {
    const parsed = parseIssuanceRequest(await readBody(req));
    return writeResult(res, issueCheckoutLicense(options.store, parsed, options.issuanceSecret));
  } catch (error) {
    return writeResult(
      res,
      malformedIssuanceResult(error instanceof Error ? error.message : "malformed request body")
    );
  }
}

export function startLicenseServer(options: LicenseHttpOptions & { port?: number; host?: string }): Promise<{ server: Server; url: string }> {
  const server = createServer(createLicenseRequestListener(options));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function parseRequest(raw: string): LicenseRequest {
  const parsed = raw ? (JSON.parse(raw) as unknown) : {};
  if (typeof parsed !== "object" || parsed === null) throw new Error("request body must be a JSON object");
  const body = parsed as Record<string, unknown>;
  const licenseKey = body.licenseKey;
  const machineId = body.machineId;
  if (typeof licenseKey !== "string" || licenseKey.trim().length === 0) throw new Error("licenseKey is required");
  if (typeof machineId !== "string" || machineId.trim().length === 0) throw new Error("machineId is required");
  const repo = typeof body.repo === "string" && body.repo.length > 0 ? body.repo : undefined;
  return { licenseKey: licenseKey.trim(), machineId: machineId.trim(), repo };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeResult(res: ServerResponse, result: ServiceResult, overrideStatus?: number): void {
  writeJson(res, overrideStatus ?? result.httpStatus, result.body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}
