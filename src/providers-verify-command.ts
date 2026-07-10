import { loadConfig, type BotConfig } from "./config.js";
import {
  verifyProviderApiKey,
  type ProviderApiKeyVerificationInput,
  type ProviderApiKeyVerificationResult
} from "./local-dashboard.js";
import { isProviderId } from "./providers.js";
import { readSecretFromStdin } from "./secret-stdin.js";

export interface ProvidersVerifyCommandInput {
  configPath?: string | string[];
  providerId?: string | string[];
  apiKeyStdin?: string | string[];
  allowRemoteSmoke?: string | string[];
  stdin: NodeJS.ReadableStream;
}

export interface ProvidersVerifyCommandDependencies {
  loadConfig: (path?: string) => BotConfig;
  verifyProviderApiKey: (input: ProviderApiKeyVerificationInput) => Promise<ProviderApiKeyVerificationResult>;
  readSecretFromStdin: typeof readSecretFromStdin;
}

export type ProvidersVerifyCommandOutput = ProviderApiKeyVerificationResult | {
  ok: false;
  command: "providers verify";
  error: string;
};

export interface ProvidersVerifyCommandExecution {
  output: ProvidersVerifyCommandOutput;
  exitCode: 0 | 1;
}

const defaultDependencies: ProvidersVerifyCommandDependencies = {
  loadConfig,
  verifyProviderApiKey,
  readSecretFromStdin
};

export async function runProvidersVerifyCommand(
  input: ProvidersVerifyCommandInput,
  dependencyOverrides: Partial<ProvidersVerifyCommandDependencies> = {}
): Promise<ProvidersVerifyCommandExecution> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const configPath = parseOptionalSingleValue(input.configPath, "--config");
  const providerId = parseOptionalSingleValue(input.providerId, "--provider");
  if (providerId && !isProviderId(providerId)) {
    return {
      output: {
        ok: false,
        command: "providers verify",
        error: "--provider must be a stable provider identifier"
      },
      exitCode: 1
    };
  }
  if (input.apiKeyStdin === undefined || !parseBooleanValue(input.apiKeyStdin, "--api-key-stdin")) {
    throw new Error("providers verify requires --api-key-stdin true");
  }

  const config = dependencies.loadConfig(configPath);
  const apiKey = await dependencies.readSecretFromStdin(input.stdin);
  const result = await dependencies.verifyProviderApiKey({
    command: "providers verify",
    config,
    ...(providerId ? { providerId } : {}),
    apiKey,
    allowRemoteSmoke: input.allowRemoteSmoke === undefined
      ? false
      : parseBooleanValue(input.allowRemoteSmoke, "--allow-remote-smoke")
  });
  return {
    output: result,
    exitCode: result.ok && result.state === "healthy" ? 0 : 1
  };
}

function parseOptionalSingleValue(value: string | string[] | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return parseSingleValue(value, label);
}

function parseBooleanValue(value: string | string[], label: string): boolean {
  const parsed = parseSingleValue(value, label);
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function parseSingleValue(value: string | string[], label: string): string {
  if (Array.isArray(value)) throw new Error(`${label} must be provided once`);
  return value;
}
