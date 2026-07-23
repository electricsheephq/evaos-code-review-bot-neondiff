import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Phase1RunSpec, Phase1ResourceMonitorModule } from "./phase1-screening-runner.js";

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

export async function importVerifiedModule<T>(path: string, expectedSha256: string, label: string, afterVerify?: () => void): Promise<T> {
  if (!path.endsWith(".js")) throw new Error(`${label} must be a pinned built JavaScript artifact`);
  const canonicalPath = realpathSync(path);
  if (canonicalPath !== path) throw new Error(`${label} must use its canonical path`);
  const source = readFileSync(canonicalPath);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash("sha256").update(source).digest("hex") !== expectedSha256) {
    throw new Error(`${label} SHA-256 does not match the immutable plan`);
  }
  const loadNonce = randomUUID();
  const verifiedUrl = new URL(pathToFileURL(canonicalPath));
  verifiedUrl.searchParams.set("sha256", expectedSha256);
  verifiedUrl.searchParams.set("load", loadNonce);
  const href = verifiedUrl.href;
  const isVerifiedRequest = (value: string): boolean => {
    try {
      const candidate = new URL(value);
      return candidate.protocol === "file:" && candidate.searchParams.get("sha256") === expectedSha256 && candidate.searchParams.get("load") === loadNonce;
    } catch { return false; }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isVerifiedRequest(specifier)) return { url: href, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (isVerifiedRequest(url)) return { format: "module", source, shortCircuit: true };
      return nextLoad(url, context);
    }
  });
  try {
    afterVerify?.();
    return await import(href) as T;
  } finally {
    hooks.deregister();
  }
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
  const runnerCandidate = fileURLToPath(new URL("./phase1-screening-runner.js", import.meta.url));
  const runtimeCandidate = fileURLToPath(new URL("./linux-phase1-runtime.js", import.meta.url));
  if (!existsSync(runnerCandidate) || !existsSync(runtimeCandidate)) throw new Error("characterization must run from pinned built JavaScript artifacts");
  const runnerPath = realpathSync(runnerCandidate);
  const runtimePath = realpathSync(runtimeCandidate);
  assertCharacterizationLoadedArtifacts(plan, {
    entrypointPath: fileURLToPath(import.meta.url),
    runnerPath
  });
  if (!runtimePath.endsWith(".js")) throw new Error("characterization must run from the pinned built JavaScript artifact");
  if (sha256File(runtimePath) !== plan.runtimeSha256) throw new Error("loaded Linux runtime SHA-256 does not match the immutable plan");
  if (plan.spec.target.ownershipVerifierSha256 !== plan.runtimeSha256) throw new Error("target ownership verifier is not bound to the loaded Linux runtime");
  if (realpathSync(plan.monitorModule.modulePath) !== runtimePath || plan.monitorModule.moduleSha256 !== plan.runtimeSha256 || plan.monitorModule.exportName !== "createGex44ResourceMonitor") {
    throw new Error("resource monitor identity is not bound to the loaded Linux runtime");
  }
  assertMonitorNvidiaBinding(plan.nvidiaSmiSha256, plan.monitorModule);
  const runner = await importVerifiedModule<typeof import("./phase1-screening-runner.js")>(runnerPath, plan.spec.harness.runnerSha256, "screening runner");
  const runtime = await importVerifiedModule<typeof import("./linux-phase1-runtime.js")>(runtimePath, plan.runtimeSha256, "Linux characterization runtime");
  const { createLlamaServerExecutableAdapter, runPhase1Screen } = runner;
  const { assertGex44LinuxPreflight, verifyLinuxListenerOwnership, verifyLinuxProcessIdentity } = runtime;
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

export function invokedModuleUrl(path: string | undefined): string {
  try {
    return path ? pathToFileURL(realpathSync(path)).href : "";
  } catch {
    return "";
  }
}

const invokedPath = invokedModuleUrl(process.argv[1]);
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown characterization failure";
    process.stderr.write(`${message.replace(/[\r\n]+/g, " ").slice(0, 512)}\n`);
    process.exitCode = 1;
  });
}
