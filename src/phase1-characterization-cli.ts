import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLlamaServerExecutableAdapter, phase1ScreeningRunnerModulePath, runPhase1Screen, type Phase1RunSpec, type Phase1ResourceMonitorModule } from "./phase1-screening-runner.js";
import { assertGex44LinuxPreflight, linuxRuntimeModulePath, verifyLinuxListenerOwnership, verifyLinuxProcessIdentity } from "./linux-phase1-runtime.js";

type CharacterizationPlan = {
  schemaVersion: "neondiff-phase1-characterization-plan/v1";
  spec: Phase1RunSpec;
  baseUrl: string;
  runtimeSha256: string;
  nvidiaSmiSha256: string;
  monitorModule: Phase1ResourceMonitorModule;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertPinnedLoadedJavaScript(actualPath: string, declaredPath: string, declaredSha256: string, label: string): void {
  if (!actualPath.endsWith(".js") || !declaredPath.endsWith(".js")) throw new Error(`${label} must be a pinned built JavaScript artifact`);
  const actual = realpathSync(actualPath);
  const declared = realpathSync(declaredPath);
  if (actual !== declared) throw new Error(`${label} loaded path does not match the immutable plan`);
  if (!/^[a-f0-9]{64}$/.test(declaredSha256) || sha256File(actual) !== declaredSha256) {
    throw new Error(`${label} SHA-256 does not match the immutable plan`);
  }
}

type LoadedArtifactPlan = {
  spec: {
    harness: {
      entrypointPath: string;
      entrypointSha256: string;
      runnerPath: string;
      runnerSha256: string;
    };
  };
};

export function assertMonitorNvidiaBinding(nvidiaSmiSha256: string, monitorModule: Phase1ResourceMonitorModule): void {
  if (!/^[a-f0-9]{64}$/.test(nvidiaSmiSha256) || monitorModule.factoryParameters?.nvidiaSmiSha256 !== nvidiaSmiSha256) {
    throw new Error("resource monitor nvidia-smi identity is not bound to the immutable plan");
  }
}

export function assertCharacterizationLoadedArtifacts(
  plan: LoadedArtifactPlan,
  loaded: { entrypointPath: string; runnerPath: string }
): void {
  assertPinnedLoadedJavaScript(loaded.entrypointPath, plan.spec.harness.entrypointPath, plan.spec.harness.entrypointSha256, "characterization entrypoint");
  assertPinnedLoadedJavaScript(loaded.runnerPath, plan.spec.harness.runnerPath, plan.spec.harness.runnerSha256, "screening runner");
}

function absoluteRegularFile(path: string, label: string): void {
  if (resolve(path) !== path || realpathSync(path) !== path || !statSync(path).isFile()) throw new Error(`${label} must be an absolute canonical regular file`);
}

function readPlan(path: string, expectedSha256: string): CharacterizationPlan {
  absoluteRegularFile(path, "characterization plan");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("characterization plan SHA-256 is invalid");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("characterization plan SHA-256 does not match");
  const plan = JSON.parse(bytes.toString("utf8")) as CharacterizationPlan;
  if (plan.schemaVersion !== "neondiff-phase1-characterization-plan/v1") throw new Error("characterization plan schema is unsupported");
  if (!plan.spec || !plan.monitorModule || typeof plan.baseUrl !== "string") throw new Error("characterization plan is incomplete");
  const harness = plan.spec.harness;
  if (!harness || typeof harness.entrypointPath !== "string" || typeof harness.entrypointSha256 !== "string"
    || typeof harness.runnerPath !== "string" || typeof harness.runnerSha256 !== "string") {
    throw new Error("characterization plan loaded JavaScript identities are incomplete");
  }
  return plan;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length !== 4 || argv[0] !== "--plan" || argv[2] !== "--sha256") throw new Error("usage: phase1-characterization-cli --plan <absolute-plan.json> --sha256 <digest>");
  const plan = readPlan(argv[1], argv[3]);
  assertCharacterizationLoadedArtifacts(plan, {
    entrypointPath: fileURLToPath(import.meta.url),
    runnerPath: phase1ScreeningRunnerModulePath()
  });
  const runtimePath = realpathSync(linuxRuntimeModulePath());
  if (!runtimePath.endsWith(".js")) throw new Error("characterization must run from the pinned built JavaScript artifact");
  if (sha256File(runtimePath) !== plan.runtimeSha256) throw new Error("loaded Linux runtime SHA-256 does not match the immutable plan");
  if (plan.spec.target.ownershipVerifierSha256 !== plan.runtimeSha256) throw new Error("target ownership verifier is not bound to the loaded Linux runtime");
  if (realpathSync(plan.monitorModule.modulePath) !== runtimePath || plan.monitorModule.moduleSha256 !== plan.runtimeSha256 || plan.monitorModule.exportName !== "createGex44ResourceMonitor") {
    throw new Error("resource monitor identity is not bound to the loaded Linux runtime");
  }
  assertMonitorNvidiaBinding(plan.nvidiaSmiSha256, plan.monitorModule);
  assertGex44LinuxPreflight(plan.nvidiaSmiSha256);
  const adapter = createLlamaServerExecutableAdapter({
    baseUrl: plan.baseUrl,
    ownershipVerifierSha256: plan.runtimeSha256,
    verifyListenerOwnership: verifyLinuxListenerOwnership,
    verifyProcessIdentity: verifyLinuxProcessIdentity
  });
  const summary = await runPhase1Screen(plan.spec, adapter, { monitorModule: plan.monitorModule });
  process.stdout.write(`${JSON.stringify({ runFingerprint: summary.runFingerprint, status: summary.status, claimClass: summary.claimClass })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown characterization failure";
    process.stderr.write(`${message.replace(/[\r\n]+/g, " ").slice(0, 512)}\n`);
    process.exitCode = 1;
  });
}
