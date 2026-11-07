import { redactSecrets } from "./secrets.js";

export const FETCH_CAUSE_CHAIN_PATTERN = / \[cause-chain: [^\[\]]*\]/g;

export function stripFetchCauseChain(text: string): string {
  return text.replace(FETCH_CAUSE_CHAIN_PATTERN, "");
}

/** Bounded operator detail only; callers retain their original error text. Never throws. */
export function describeFetchErrorCauseChain(error: unknown): string {
  const items: string[] = [];
  try {
    collectCauseChain(error, items);
  } catch {
    // Detail only: a broken or hostile cause object must not replace the caller's error.
  }
  return truncate(items.join("; "), 320);
}

function collectCauseChain(error: unknown, items: string[]): void {
  if (!(error instanceof Error)) return;
  const seen = new Set<object>([error]);
  const add = (item: string) => {
    const clean = redactSecrets(item)
      .replace(/\[/g, "(")
      .replace(/\]/g, ")")
      .replace(/[\u0000-\u001f\u007f]/g, " ");
    items.push(truncate(clean, 160));
  };
  const addErrors = (value: unknown) => {
    const errors = fields(value)?.errors;
    if (!Array.isArray(errors)) return;
    for (let index = 0; index < Math.min(errors.length, 2); index += 1) {
      add(`errors[${index}]=${describeCause(errors[index])}`);
    }
  };

  addErrors(error);
  let cause: unknown = error.cause;
  for (let level = 1; cause; level += 1) {
    const object = fields(cause);
    if (object && seen.has(object)) {
      add("cycle");
      break;
    }
    if (level > 4) {
      add("depth-limit");
      break;
    }
    if (object) seen.add(object);
    if (level === 1) {
      const code = validCode(cause);
      if (code) add(`code=${code}`);
    } else {
      add(describeCause(cause));
    }
    addErrors(cause);
    cause = object?.cause;
  }
}

function fields(value: unknown): { code?: unknown; cause?: unknown; errors?: unknown } | undefined {
  return value !== null && typeof value === "object" ? value : undefined;
}

function validCode(value: unknown): string | undefined {
  const code = fields(value)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function describeCause(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const code = validCode(value);
  return code ? `${text} (code=${code})` : text;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}
