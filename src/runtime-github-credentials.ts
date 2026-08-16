import { AsyncLocalStorage } from "node:async_hooks";
import { createPrivateKey } from "node:crypto";
import { readSecretFromStdin } from "./secret-stdin.js";

export interface RuntimeGitHubCredentials {
  appId: string;
  privateKey: string;
  licenseKey?: string;
  licenseMachineId?: string;
}

interface RuntimeGitHubCredentialInput {
  command?: string;
  subcommand?: string;
  appId?: string | string[];
  privateKeyStdin?: string | string[];
  stdin: NodeJS.ReadableStream;
}

const storage = new AsyncLocalStorage<RuntimeGitHubCredentials>();

export async function resolveRuntimeGitHubCredentials(
  input: RuntimeGitHubCredentialInput
): Promise<RuntimeGitHubCredentials | undefined> {
  const hasAppId = input.appId !== undefined;
  const hasPrivateKeyStdin = input.privateKeyStdin !== undefined;
  if (!hasAppId && !hasPrivateKeyStdin) return undefined;

  const supportedCommand = input.command === "review-pr"
    || (input.command === "daemon" && input.subcommand === undefined);
  if (!supportedCommand) {
    throw new Error(
      "GitHub App private-key stdin is supported only for review-pr or the raw daemon process"
    );
  }
  if (Array.isArray(input.appId) || input.appId === undefined) {
    throw new Error("--github-app-id must be supplied exactly once");
  }
  if (Array.isArray(input.privateKeyStdin) || input.privateKeyStdin !== "true") {
    throw new Error("--github-app-private-key-stdin must be supplied exactly once with value true");
  }
  const appId = input.appId.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(appId)) {
    throw new Error("--github-app-id must be one positive ASCII numeric App ID of at most 20 digits");
  }

  let privateKey: string;
  try {
    privateKey = await readSecretFromStdin(input.stdin, 64 * 1024, 5_000);
  } catch (error) {
    throw new Error((error instanceof Error
      ? error.message
      : "GitHub App private-key stdin could not be read")
      .replaceAll("provider secret", "GitHub App private-key"));
  }
  validatePrivateKey(privateKey);
  return { appId, privateKey };
}

export async function resolveRuntimeCredentialEnvelope(input: {
  command?: string;
  subcommand?: string;
  runtimeCredentialsStdin?: string | string[];
  stdin: NodeJS.ReadableStream;
}): Promise<RuntimeGitHubCredentials | undefined> {
  if (input.runtimeCredentialsStdin === undefined) return undefined;
  const supportedCommand = input.command === "review-pr"
    || input.command === "issue-enrichment-run"
    || (input.command === "daemon" && input.subcommand === undefined);
  if (!supportedCommand) {
    throw new Error(
      "runtime credential stdin is supported only for review-pr, issue-enrichment-run, or the raw daemon process"
    );
  }
  if (Array.isArray(input.runtimeCredentialsStdin)
    || input.runtimeCredentialsStdin !== "true") {
    throw new Error("--runtime-credentials-stdin must be supplied exactly once with value true");
  }
  const raw = await readSecretFromStdin(input.stdin, 72 * 1024, 5_000);
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("runtime credential stdin must be one valid JSON envelope");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("runtime credential stdin must be one JSON object");
  }
  const record = envelope as Record<string, unknown>;
  if (Object.keys(record).length !== 5
    || ![
      "schemaVersion",
      "githubAppId",
      "githubPrivateKey",
      "licenseKey",
      "licenseMachineId"
    ].every((key) => Object.prototype.hasOwnProperty.call(record, key))
    || record.schemaVersion !== 2
    || typeof record.githubAppId !== "string"
    || typeof record.githubPrivateKey !== "string"
    || typeof record.licenseKey !== "string"
    || typeof record.licenseMachineId !== "string") {
    throw new Error("runtime credential stdin has an unsupported schema");
  }
  const appId = record.githubAppId.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(appId)) {
    throw new Error("runtime credential App ID must be one positive ASCII numeric value");
  }
  const privateKey = record.githubPrivateKey.trim();
  validatePrivateKey(privateKey);
  const licenseKey = record.licenseKey.trim();
  if (!/^nd_live_[A-Za-z0-9_-]{8,}$/.test(licenseKey)) {
    throw new Error("runtime credential license key must be one valid production key");
  }
  const licenseMachineId = record.licenseMachineId.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(licenseMachineId)) {
    throw new Error("runtime credential license machine ID must be one RFC 7638 SHA-256 broker device id");
  }
  return {
    appId,
    privateKey,
    licenseKey,
    licenseMachineId
  };
}

export async function withRuntimeGitHubCredentials<T>(
  credentials: RuntimeGitHubCredentials | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!credentials) return operation();
  return storage.run(credentials, operation);
}

export function applyRuntimeGitHubCredentials(
  github: {
    appId?: string;
    privateKey?: string;
    privateKeyPath?: string;
    token?: string;
  }
): void {
  const credentials = storage.getStore();
  if (!credentials) return;
  github.appId = credentials.appId;
  github.privateKeyPath = undefined;
  github.token = undefined;
  Object.defineProperty(github, "privateKey", {
    value: credentials.privateKey,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

export function readRuntimeLicenseKey(): string | undefined {
  return storage.getStore()?.licenseKey;
}

export function readRuntimeLicenseMachineId(): string | undefined {
  return storage.getStore()?.licenseMachineId;
}

function validatePrivateKey(privateKey: string): void {
  const privateKeyLabel = "PRIVATE" + " KEY";
  const rsaPrivateKeyLabel = "RSA " + privateKeyLabel;
  const supportedBoundaries = [
    [`-----BEGIN ${privateKeyLabel}-----`, `-----END ${privateKeyLabel}-----`],
    [`-----BEGIN ${rsaPrivateKeyLabel}-----`, `-----END ${rsaPrivateKeyLabel}-----`]
  ] as const;
  if (!supportedBoundaries.some(
    ([header, footer]) => privateKey.startsWith(header) && privateKey.endsWith(footer)
  )) {
    throw new Error("GitHub App private-key stdin must be one unencrypted PKCS#1 or PKCS#8 PEM");
  }
  try {
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== "rsa") throw new Error("unsupported key type");
  } catch {
    throw new Error("GitHub App private-key stdin must be one valid unencrypted RSA private key");
  }
}
