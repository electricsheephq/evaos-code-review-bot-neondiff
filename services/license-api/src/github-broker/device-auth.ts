import { calculateJwkThumbprint, decodeJwt, importJWK, jwtVerify, type JWK } from "jose";
import { BrokerError } from "./errors.js";
import type { GitHubBrokerStore } from "./store.js";

const DEVICE_JWT_ALG = "ES256";
const MAX_DEVICE_TOKEN_AGE_SECONDS = 600;

/**
 * Validate a registration public JWK: it must be an EC P-256 public key with no
 * private component. The device id is its RFC 7638 thumbprint, computed the same
 * way on the client, so registration is idempotent and no server-assigned id has
 * to travel back before the device can authenticate.
 */
export async function deviceIdFromPublicJwk(publicKeyJwk: unknown): Promise<{ deviceId: string; publicJwk: JWK }> {
  if (typeof publicKeyJwk !== "object" || publicKeyJwk === null || Array.isArray(publicKeyJwk)) {
    throw new BrokerError("invalid_request", "publicKeyJwk must be a JSON object");
  }
  const jwk = publicKeyJwk as JWK & { d?: unknown };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new BrokerError("invalid_request", "publicKeyJwk must be an EC P-256 public key");
  }
  if (jwk.d !== undefined) {
    throw new BrokerError("invalid_request", "publicKeyJwk must not contain private key material");
  }
  const publicJwk: JWK = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const deviceId = await calculateJwkThumbprint(publicJwk, "sha256");
  return { deviceId, publicJwk };
}

/**
 * Authenticate a device-signed request. Extracts the device id from the token
 * subject, verifies the signature against the registered public key, and enforces
 * expiry. Every failure maps to a typed, fail-closed reason; the token itself is
 * never logged.
 */
export async function authenticateDevice(
  store: GitHubBrokerStore,
  authorizationHeader: string | string[] | undefined,
  now: Date
): Promise<string> {
  const token = bearerToken(authorizationHeader);
  if (!token) throw new BrokerError("invalid_device_credential", "a device-signed bearer token is required");

  let subject: string;
  try {
    const claims = decodeJwt(token);
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("missing subject");
    }
    subject = claims.sub;
  } catch {
    throw new BrokerError("invalid_device_credential", "device credential is malformed");
  }

  const device = store.getDevice(subject);
  if (!device) throw new BrokerError("device_not_registered", "device is not registered");

  let key: Awaited<ReturnType<typeof importJWK>>;
  try {
    key = await importJWK(JSON.parse(device.public_jwk) as JWK, DEVICE_JWT_ALG);
  } catch {
    throw new BrokerError("invalid_device_credential", "device key could not be loaded");
  }

  try {
    await jwtVerify(token, key, {
      algorithms: [DEVICE_JWT_ALG],
      subject,
      currentDate: now,
      clockTolerance: 5,
      maxTokenAge: MAX_DEVICE_TOKEN_AGE_SECONDS
    });
  } catch {
    throw new BrokerError("invalid_device_credential", "device credential failed verification");
  }

  store.touchDevice(subject, now.toISOString());
  return subject;
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix) || value.length === prefix.length) return undefined;
  return value.slice(prefix.length);
}
