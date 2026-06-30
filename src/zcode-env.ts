import { readFileSync } from "node:fs";

interface ResolveZCodeProviderEnvOptions {
  appConfigPath: string;
  model: string;
  providerId?: string;
}

export interface ResolvedZCodeProviderEnv {
  ZCODE_MODEL: string;
  ZCODE_BASE_URL: string;
  ZCODE_API_KEY: string;
  redacted: {
    providerId: string;
    model: string;
    baseURL: string;
    apiKey: string;
  };
}

export function resolveZCodeProviderEnv(options: ResolveZCodeProviderEnvOptions): ResolvedZCodeProviderEnv {
  const config = JSON.parse(readFileSync(options.appConfigPath, "utf8")) as {
    provider?: Record<string, ZCodeProviderConfig>;
  };
  const providers = Object.entries(config.provider ?? {});
  const match = providers.find(([providerId, provider]) => {
    if (options.providerId && providerId !== options.providerId) return false;
    return Boolean(
      provider.enabled &&
        provider.options?.apiKey &&
        provider.options.baseURL &&
        provider.models &&
        Object.prototype.hasOwnProperty.call(provider.models, options.model)
    );
  });

  if (!match) {
    throw new Error(`No enabled ZCode provider found for ${options.providerId ?? "any provider"}/${options.model}`);
  }

  const [providerId, provider] = match;
  const providerOptions = provider.options;
  if (!providerOptions?.apiKey || !providerOptions.baseURL) {
    throw new Error(`Selected ZCode provider ${providerId} is missing apiKey or baseURL.`);
  }

  return {
    ZCODE_MODEL: `${providerId}/${options.model}`,
    ZCODE_BASE_URL: providerOptions.baseURL,
    ZCODE_API_KEY: providerOptions.apiKey,
    redacted: {
      providerId,
      model: options.model,
      baseURL: providerOptions.baseURL,
      apiKey: `[redacted len=${providerOptions.apiKey.length}]`
    }
  };
}

interface ZCodeProviderConfig {
  enabled?: boolean;
  options?: {
    apiKey?: string;
    baseURL?: string;
  };
  models?: Record<string, unknown>;
}
