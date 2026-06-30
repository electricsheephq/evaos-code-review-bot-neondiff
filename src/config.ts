import { existsSync, readFileSync } from "node:fs";

export interface BotConfig {
  pilotRepos: string[];
  pollIntervalMs: number;
  skipDrafts: boolean;
  workRoot: string;
  statePath: string;
  evidenceDir: string;
  zcode: {
    cliPath: string;
    appConfigPath: string;
    model: string;
    providerId?: string;
    timeoutMs: number;
    maxPatchBytes: number;
    retryMaxRetries: number;
  };
  github: {
    appId?: string;
    privateKeyPath?: string;
    token?: string;
  };
}

const DEFAULT_CONFIG: BotConfig = {
  pilotRepos: ["electricsheephq/WorldOS", "100yenadmin/evaOS-GUI"],
  pollIntervalMs: 90_000,
  skipDrafts: true,
  workRoot: "/Volumes/LEXAR/repos/evaos-code-review-bot/runtime",
  statePath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/state/reviews.sqlite",
  evidenceDir: "/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence",
  zcode: {
    cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
    model: "GLM-5.2",
    timeoutMs: 180_000,
    maxPatchBytes: 80_000,
    retryMaxRetries: 0
  },
  github: {}
};

export function loadConfig(configPath?: string): BotConfig {
  const fromFile = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const merged = deepMerge(DEFAULT_CONFIG, fromFile) as BotConfig;

  merged.github.appId = process.env.EVAOS_REVIEW_BOT_APP_ID ?? merged.github.appId;
  merged.github.privateKeyPath = process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH ?? merged.github.privateKeyPath;
  merged.github.token = process.env.GITHUB_TOKEN ?? merged.github.token;

  return merged;
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return overlay ?? base;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
