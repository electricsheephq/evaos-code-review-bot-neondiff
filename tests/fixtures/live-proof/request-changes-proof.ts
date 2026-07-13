import { execSync } from "node:child_process";

export function runUntrustedCommand(untrustedInput: string): string {
  // Live proof fixture: deliberately unsafe and never eligible to merge.
  return execSync(untrustedInput, { encoding: "utf8" });
}
