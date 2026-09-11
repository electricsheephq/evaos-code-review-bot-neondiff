import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { redactSecrets } from "./secrets.js";
import {
  selectAndSealPhase1Cohort,
  verifyPhase1CohortSeal,
  type Phase1CohortSelectionOptions,
  type Phase1SelectionProfile
} from "./phase1-cohort-selection.js";

export type Phase1CohortSelectionCliResult =
  | {
    ok: true;
    command: "select" | "verify";
    selectionProfile: Phase1SelectionProfile;
    manifestSha256: string;
  }
  | { ok: true; command: "help"; usage: string };

export function runPhase1CohortSelectionCli(args: string[]): Phase1CohortSelectionCliResult {
  const command = args[0];
  if ((command === "--help" || command === "-h") && args.length === 1) {
    return { ok: true, command: "help", usage: usage() };
  }
  if (command !== "select" && command !== "verify") throw new Error(usage());
  const options = parseOptions(args.slice(1));
  const result = command === "select"
    ? selectAndSealPhase1Cohort(options)
    : verifyPhase1CohortSeal(options);
  return {
    ok: true,
    command,
    selectionProfile: result.selectionProfile,
    manifestSha256: result.manifestSha256
  };
}

function parseOptions(args: string[]): Phase1CohortSelectionOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage());
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set([
    "--candidate-pool", "--candidate-pool-sha256", "--policy", "--policy-sha256",
    "--output-dir", "--allowed-output-root"
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
  const candidatePoolPath = values.get("--candidate-pool");
  const candidatePoolSha256 = values.get("--candidate-pool-sha256");
  const policyPath = values.get("--policy");
  const policySha256 = values.get("--policy-sha256");
  const outputDir = values.get("--output-dir");
  const allowedOutputRoot = values.get("--allowed-output-root");
  if (!candidatePoolPath || !candidatePoolSha256 || !policyPath || !policySha256 || !outputDir || !allowedOutputRoot) throw new Error(usage());
  return {
    candidatePoolPath: resolve(candidatePoolPath),
    candidatePoolSha256,
    policyPath: resolve(policyPath),
    policySha256,
    outputDir: resolve(outputDir),
    allowedOutputRoot: resolve(allowedOutputRoot)
  };
}

function usage(): string {
  return "usage: phase1-cohort-selection <select|verify> --candidate-pool <path> --candidate-pool-sha256 <sha256> --policy <path> --policy-sha256 <sha256> --output-dir <path> --allowed-output-root <path>; pinned policy selects stratified_transport or natural_quality";
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    process.stdout.write(`${JSON.stringify(runPhase1CohortSelectionCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: redactSecrets(message) })}\n`);
    process.exitCode = 1;
  }
}
