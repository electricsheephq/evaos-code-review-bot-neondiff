import { redactSecrets } from "./secrets.js";

export interface DaemonLogEvent {
  event: string;
  level?: "info" | "error";
  [key: string]: unknown;
}

export function formatDaemonLog(input: DaemonLogEvent, now = new Date()): string {
  const { level = "info", ...rest } = input;
  return JSON.stringify({
    ts: now.toISOString(),
    level,
    ...redactRecord(rest)
  });
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactObject(entry)]));
}

function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry));
  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}
