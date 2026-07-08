export interface EnvAliasInput {
  primaryName: string;
  legacyName: string;
  valueLabel: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveEnvAlias(input: EnvAliasInput): string | undefined {
  const env = input.env ?? process.env;
  const primaryValue = normalizeEnvValue(env[input.primaryName]);
  const legacyValue = normalizeEnvValue(env[input.legacyName]);
  if (primaryValue !== undefined && legacyValue !== undefined && primaryValue !== legacyValue) {
    throw new Error(
      `${input.primaryName} and ${input.legacyName} are both set with different values for ${input.valueLabel}; unset one or set them to the same value.`
    );
  }
  return primaryValue ?? legacyValue;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}
