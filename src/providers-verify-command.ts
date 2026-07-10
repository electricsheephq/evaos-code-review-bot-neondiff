import { loadConfig, type BotConfig } from "./config.js";
import {
  verifyProviderApiKey,
  type ProviderApiKeyVerificationInput,
  type ProviderApiKeyVerificationResult
} from "./local-dashboard.js";
import { isProviderId } from "./providers.js";
import { readSecretFromStdin } from "./secret-stdin.js";
import { loadConfigAtRevision } from "./config-cli.js";

export interface ProvidersVerifyCommandInput {
  configPath?: string | string[];
  providerId?: string | string[];
  apiKeyStdin?: string | string[];
  allowRemoteSmoke?: string | string[];
  expectedConfigRevision?: string | string[];
  stdin: NodeJS.ReadableStream;
}

export interface ProvidersVerifyCommandDependencies {
  loadConfig: (path?: string) => BotConfig;
  verifyProviderApiKey: (input: ProviderApiKeyVerificationInput) => Promise<ProviderApiKeyVerificationResult>;
  readSecretFromStdin: typeof readSecretFromStdin;
  loadConfigAtRevision: (path: string) => { config: BotConfig; revision: string };
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
  readSecretFromStdin,
  loadConfigAtRevision
};

export async function runProvidersVerifyCommand(
  input: ProvidersVerifyCommandInput,
  dependencyOverrides: Partial<ProvidersVerifyCommandDependencies> = {}
): Promise<ProvidersVerifyCommandExecution> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const configPath = parseOptionalSingleValue(input.configPath, "--config");
  const providerId = parseOptionalSingleValue(input.providerId, "--provider");
  const expectedConfigRevision = parseOptionalSingleValue(
    input.expectedConfigRevision,
    "--expected-config-revision"
  );
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

  let config: BotConfig;
  let initialConfigRevision: string | undefined;
  if (expectedConfigRevision !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedConfigRevision)) {
      throw new Error("--expected-config-revision must be a lowercase SHA-256 value");
    }
    if (!configPath) {
      throw new Error("--expected-config-revision requires --config");
    }
    const loaded = dependencies.loadConfigAtRevision(configPath);
    if (loaded.revision !== expectedConfigRevision) {
      return {
        output: {
          ok: false,
          command: "providers verify",
          error: "config revision changed; reload and apply provider settings before verification"
        },
        exitCode: 1
      };
    }
    config = loaded.config;
    initialConfigRevision = loaded.revision;
  } else if (configPath) {
    const loaded = dependencies.loadConfigAtRevision(configPath);
    config = loaded.config;
    initialConfigRevision = loaded.revision;
  } else {
    config = dependencies.loadConfig(configPath);
  }

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
  if (configPath && initialConfigRevision !== undefined) {
    let finalRevision: string;
    try {
      finalRevision = dependencies.loadConfigAtRevision(configPath).revision;
    } catch {
      return configRevisionDriftResult(
        providerId ?? config.providers!.defaultProviderId,
        initialConfigRevision
      );
    }
    if (finalRevision !== initialConfigRevision) {
      return configRevisionDriftResult(
        providerId ?? config.providers!.defaultProviderId,
        finalRevision
      );
    }
  }
  const output = initialConfigRevision === undefined
    ? result
    : { ...result, configRevision: initialConfigRevision };
  return {
    output,
    exitCode: output.ok && output.state === "healthy" ? 0 : 1
  };
}

function configRevisionDriftResult(
  providerId: string,
  configRevision: string
): ProvidersVerifyCommandExecution {
  return {
    output: {
      ok: false,
      command: "providers verify",
      checkedAt: new Date().toISOString(),
      providerId,
      state: "blocked",
      mode: "metadata_only",
      detail: "Config changed during provider verification; reload and verify again.",
      redacted: true,
      troubleshooting: ["Reload current config before retrying provider verification."],
      configRevision
    },
    exitCode: 1
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
