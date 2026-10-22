/** Stable npm releases from 1.1.0 use the lean workflow, without candidate ledgers. */
export function isLeanReleaseVersion(version: string | undefined): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? "");
  return match !== null && (BigInt(match[1]!) > 1n || (match[1] === "1" && BigInt(match[2]!) >= 1n));
}
