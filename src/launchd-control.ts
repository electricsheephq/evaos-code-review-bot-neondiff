export type LaunchctlResult = {
  command: string[];
  exitCode: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  signal?: string;
  observedExitCode?: number;
  acceptedAs?: "already_loaded";
};

export type LaunchctlExecutor = (command: string[]) => LaunchctlResult;

export type LaunchdControlResult = {
  ok: boolean;
  command: "daemon start" | "daemon stop";
  dryRun: boolean;
  launchdLabel: string;
  launchdTarget: string;
  launchdLoaded?: boolean;
  operation?: "bootstrap_then_kickstart" | "kickstart_existing" | "bootout_plist" | "bootout_service";
  plistPath?: string;
  warning?: string;
  plannedCommands?: string[][];
  results?: LaunchctlResult[];
  error?: string;
};

export type LaunchdControlDependencies = {
  executeLaunchctl: LaunchctlExecutor;
  plistExists: (path: string) => boolean;
  assertPlistLabelMatches: (path: string, launchdLabel: string) => void;
  plistWarning: (path: string) => string | undefined;
  launchdSessionError: () => string | undefined;
};

export function runLaunchdControlCommand(
  input: {
    action: "start" | "stop";
    dryRun: boolean;
    confirm: boolean;
    allowExternalPlist: boolean;
    launchdLabel: string;
    launchdTarget: string;
    launchdDomain: string;
    standardPlistPath: string;
    requestedPlistPath?: string;
  },
  dependencies: LaunchdControlDependencies
): LaunchdControlResult {
  const {
    action,
    dryRun,
    confirm,
    allowExternalPlist,
    launchdLabel,
    launchdTarget,
    launchdDomain,
    standardPlistPath,
    requestedPlistPath
  } = input;
  const command: "daemon start" | "daemon stop" = `daemon ${action}`;
  if (!dryRun && !confirm) {
    return {
      ok: false,
      command,
      dryRun,
      launchdLabel,
      launchdTarget,
      error: `daemon ${action} requires --confirm true when --dry-run false is used`
    };
  }
  if (requestedPlistPath) dependencies.assertPlistLabelMatches(requestedPlistPath, launchdLabel);
  const launchdLoaded = action === "start"
    ? inspectLaunchdServiceLoaded(launchdTarget, dependencies.executeLaunchctl)
    : undefined;
  const plistPath = action === "start" && launchdLoaded === false
    ? requestedPlistPath ?? (dependencies.plistExists(standardPlistPath) ? standardPlistPath : undefined)
    : action === "stop"
      ? requestedPlistPath
      : undefined;
  if (action === "start" && launchdLoaded === false && !plistPath && (dryRun || confirm)) {
    return {
      ok: false,
      command: "daemon start",
      dryRun,
      launchdLabel,
      launchdTarget,
      launchdLoaded,
      error: `launchd service is not loaded and no plist was found; pass --plist or install ${standardPlistPath}`
    };
  }
  if (action === "start" && plistPath && plistPath !== requestedPlistPath) {
    dependencies.assertPlistLabelMatches(plistPath, launchdLabel);
  }
  const commands = buildDaemonLaunchctlCommands({
    action,
    launchdDomain,
    launchdTarget,
    ...(plistPath ? { plistPath } : {})
  });
  const operation = daemonControlOperation(action, plistPath);
  // Auto-selected standard plists are trusted by this command contract. Only
  // an operator-supplied --plist participates in the external-path warning.
  const warning = plistPath && requestedPlistPath ? dependencies.plistWarning(plistPath) : undefined;
  const resultBase = {
    command,
    dryRun,
    launchdLabel,
    launchdTarget,
    ...(launchdLoaded !== undefined ? { launchdLoaded } : {}),
    operation,
    ...(plistPath ? { plistPath } : {}),
    ...(warning ? { warning } : {})
  };
  if (dryRun) {
    return { ok: true, ...resultBase, plannedCommands: commands };
  }
  const launchdSessionError = dependencies.launchdSessionError();
  if (launchdSessionError) {
    return { ok: false, ...resultBase, plannedCommands: commands, error: launchdSessionError };
  }
  if (warning && !allowExternalPlist) {
    return {
      ok: false,
      ...resultBase,
      plannedCommands: commands,
      error: `daemon ${action} requires --allow-external-plist true when --dry-run false uses a --plist outside the NeonDiff package root`
    };
  }
  const results = runLaunchctlPlan(commands, dependencies.executeLaunchctl, {
    acceptAlreadyLoadedBootstrap: action === "start",
    launchdTarget
  });
  return {
    ok: results.every((result) => result.exitCode === 0),
    ...resultBase,
    results
  };
}

export function inspectLaunchdServiceLoaded(
  launchdTarget: string,
  executeLaunchctl: LaunchctlExecutor
): boolean {
  const result = executeLaunchctl(["launchctl", "print", launchdTarget]);
  if (result.exitCode === 0) return true;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  if (detail.includes("could not find service") || detail.includes("service not found")) {
    return false;
  }
  throw new Error(
    `failed to inspect launchd service ${launchdTarget}` +
    (result.error ? `: ${result.error}` : detail.trim() ? `: ${detail.trim()}` : ` (exit ${result.exitCode})`)
  );
}

export function runLaunchctlPlan(
  commands: string[][],
  executeLaunchctl: LaunchctlExecutor,
  options?: { acceptAlreadyLoadedBootstrap?: boolean; launchdTarget?: string }
): LaunchctlResult[] {
  const results: LaunchctlResult[] = [];
  for (const command of commands) {
    const result = executeLaunchctl(command);
    if (
      result.exitCode !== 0 &&
      command[1] === "bootstrap" &&
      options?.acceptAlreadyLoadedBootstrap &&
      options.launchdTarget &&
      isAlreadyLoadedBootstrapFailure(result) &&
      inspectLaunchdServiceLoaded(options.launchdTarget, executeLaunchctl)
    ) {
      results.push({
        ...result,
        exitCode: 0,
        observedExitCode: result.exitCode,
        acceptedAs: "already_loaded"
      });
      continue;
    }
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
}

function isAlreadyLoadedBootstrapFailure(result: LaunchctlResult): boolean {
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  return detail.includes("service already bootstrapped") || detail.includes("service already loaded");
}

function buildDaemonLaunchctlCommands(input: {
  action: "start" | "stop";
  launchdDomain: string;
  launchdTarget: string;
  plistPath?: string;
}): string[][] {
  if (input.action === "start") {
    return [
      ...(input.plistPath ? [["launchctl", "bootstrap", input.launchdDomain, input.plistPath]] : []),
      ["launchctl", "kickstart", "-k", input.launchdTarget]
    ];
  }
  return input.plistPath
    ? [["launchctl", "bootout", input.launchdDomain, input.plistPath]]
    : [["launchctl", "bootout", input.launchdTarget]];
}

function daemonControlOperation(
  action: "start" | "stop",
  plistPath?: string
): "bootstrap_then_kickstart" | "kickstart_existing" | "bootout_plist" | "bootout_service" {
  if (action === "start") return plistPath ? "bootstrap_then_kickstart" : "kickstart_existing";
  return plistPath ? "bootout_plist" : "bootout_service";
}
