import { execSync } from "node:child_process";

export function runUntrustedCommand(untrustedInput: string): string {
  return execSync(untrustedInput, { encoding: "utf8" });
}
