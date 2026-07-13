import {
  CheckoutBindingConflictError,
  CheckoutBindingNotFoundError,
  CheckoutBindingPolicyError,
  CheckoutBindingTransientError,
  CheckoutBindingWrongSourceError,
  LicenseStore,
  checkoutIssuanceFingerprint,
  type BindCheckoutSubscriptionInput,
  type IssueLicenseInput,
  type LicenseRecord,
  type RepoVisibilityScope
} from "./store.js";

/**
 * Admin issuance CLI (no payment rails — this is how keys are minted until/if
 * Stripe is ever added). Commands:
 *   issue  --plan <p> --scope <public|private|all> [--seats N] [--expires <iso>]
 *          [--private-repo-allowed <true|false>] [--update-entitlement]
 *   revoke --key <k> [--reason <text>]
 *   list
 *   show   --key <k>
 *   bind-checkout-subscription --issuance-idempotency-key <ref>
 *          --provider stripe --provider-account-id <id> --provider-mode <test|live>
 *          --external-subscription-id <id> --external-checkout-id <id> [--dry-run]
 *
 * `issue` prints the raw key EXACTLY ONCE; only the sha256 hash is stored.
 * `list`/`show` never print raw keys.
 */
export function runAdmin(argv: string[], store: LicenseStore, out: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "issue":
      return cmdIssue(flags, store, out);
    case "revoke":
      return cmdRevoke(flags, store, out);
    case "list":
      return cmdList(store, out);
    case "show":
      return cmdShow(flags, store, out);
    case "bind-checkout-subscription":
      return cmdBindCheckoutSubscription(rest, store, out);
    default:
      out(usage());
      return command ? 2 : 0;
  }
}

function cmdBindCheckoutSubscription(
  args: string[],
  store: LicenseStore,
  out: (line: string) => void
): number {
  const parsed = parseCheckoutBindingFlags(args);
  if (!parsed) {
    out(JSON.stringify({ result: "invalid" }));
    return 2;
  }
  const issuanceFingerprint = checkoutIssuanceFingerprint(parsed.input.issuanceIdempotencyKey);
  try {
    out(JSON.stringify(store.bindCheckoutSubscription(parsed.input, { dryRun: parsed.dryRun })));
    return 0;
  } catch (error) {
    let result: "invalid" | "not_found" | "wrong_source" | "conflict" | "unavailable";
    let code: number;
    if (error instanceof CheckoutBindingPolicyError) {
      result = "invalid";
      code = 2;
    } else if (error instanceof CheckoutBindingNotFoundError) {
      result = "not_found";
      code = 1;
    } else if (error instanceof CheckoutBindingWrongSourceError) {
      result = "wrong_source";
      code = 1;
    } else if (error instanceof CheckoutBindingConflictError) {
      result = "conflict";
      code = 1;
    } else if (error instanceof CheckoutBindingTransientError) {
      result = "unavailable";
      code = 1;
    } else {
      result = "unavailable";
      code = 1;
    }
    out(JSON.stringify({ result, issuanceFingerprint }));
    return code;
  }
}

function parseCheckoutBindingFlags(
  args: string[]
): { input: BindCheckoutSubscriptionInput; dryRun: boolean } | undefined {
  const valueFlags = new Set([
    "issuance-idempotency-key",
    "provider",
    "provider-account-id",
    "provider-mode",
    "external-subscription-id",
    "external-checkout-id"
  ]);
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      if (dryRun || (args[index + 1] !== undefined && !args[index + 1]!.startsWith("--"))) {
        return undefined;
      }
      dryRun = true;
      continue;
    }
    if (!arg?.startsWith("--")) return undefined;
    const name = arg.slice(2);
    if (!valueFlags.has(name) || values.has(name)) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    values.set(name, value);
    index += 1;
  }
  if ([...valueFlags].some((name) => !values.has(name))) return undefined;
  return {
    input: {
      issuanceIdempotencyKey: values.get("issuance-idempotency-key")!,
      provider: values.get("provider")! as "stripe",
      providerAccountId: values.get("provider-account-id")!,
      providerMode: values.get("provider-mode")! as "test" | "live",
      externalSubscriptionId: values.get("external-subscription-id")!,
      externalCheckoutId: values.get("external-checkout-id")!
    },
    dryRun
  };
}

function cmdIssue(flags: Flags, store: LicenseStore, out: (line: string) => void): number {
  const plan = flags.string("plan");
  const scope = flags.string("scope") as RepoVisibilityScope | undefined;
  if (!plan) return fail(out, "issue requires --plan");
  if (scope !== "public" && scope !== "private" && scope !== "all") {
    return fail(out, "issue requires --scope <public|private|all>");
  }
  const input: IssueLicenseInput = {
    plan,
    repoVisibilityScope: scope,
    ...(flags.has("seats") ? { seats: Number(flags.string("seats")) } : {}),
    ...(flags.has("expires") ? { expiresAt: flags.string("expires") } : {}),
    ...(flags.has("private-repo-allowed") ? { privateRepoAllowed: flags.string("private-repo-allowed") !== "false" } : {}),
    ...(flags.has("update-entitlement") ? { updateEntitlement: true } : {})
  };
  const { rawKey, record } = store.issueLicense(input);
  out("License issued. Store this key securely — it is shown only once:");
  out(`  key:   ${rawKey}`);
  out(`  hash:  ${record.licenseKeyHash}`);
  out(`  plan:  ${record.plan}`);
  out(`  scope: ${record.repoVisibilityScope} (privateRepoAllowed=${record.privateRepoAllowed})`);
  out(`  seats: ${record.seats}`);
  out(`  expiresAt: ${record.expiresAt ?? "never"}`);
  return 0;
}

function cmdRevoke(flags: Flags, store: LicenseStore, out: (line: string) => void): number {
  const key = flags.string("key");
  if (!key) return fail(out, "revoke requires --key");
  const ok = store.revokeLicense(key, flags.string("reason"));
  if (!ok) return fail(out, "no license matches the provided key");
  out("License revoked.");
  return 0;
}

function cmdList(store: LicenseStore, out: (line: string) => void): number {
  const licenses = store.listLicenses();
  if (licenses.length === 0) {
    out("No licenses issued.");
    return 0;
  }
  for (const record of licenses) out(formatLicense(record, store, false));
  return 0;
}

function cmdShow(flags: Flags, store: LicenseStore, out: (line: string) => void): number {
  const key = flags.string("key");
  if (!key) return fail(out, "show requires --key");
  const record = store.getLicenseByKey(key);
  if (!record) return fail(out, "no license matches the provided key");
  out(formatLicense(record, store, true));
  return 0;
}

function formatLicense(record: LicenseRecord, store: LicenseStore, withActivations: boolean): string {
  const parts = [
    `hash=${record.licenseKeyHash}`,
    `status=${record.status}`,
    `plan=${record.plan}`,
    `scope=${record.repoVisibilityScope}`,
    `privateRepoAllowed=${record.privateRepoAllowed}`,
    `seats=${record.seats}`,
    `activations=${store.countActivations(record.licenseKeyHash)}`,
    `expiresAt=${record.expiresAt ?? "never"}`,
    `createdAt=${record.createdAt}`
  ];
  if (record.revocationReason) parts.push(`revocationReason=${record.revocationReason}`);
  let line = parts.join(" ");
  if (withActivations) {
    for (const activation of store.listActivations(record.licenseKeyHash)) {
      line += `\n  machine=${activation.machineId} repo=${activation.repo ?? "-"} lastSeenAt=${activation.lastSeenAt}`;
    }
  }
  return line;
}

function usage(): string {
  return [
    "Usage: license-admin <command> [options]",
    "",
    "Commands:",
    "  issue  --plan <p> --scope <public|private|all> [--seats N] [--expires <iso>]",
    "         [--private-repo-allowed <true|false>] [--update-entitlement]",
    "  revoke --key <k> [--reason <text>]",
    "  list",
    "  show   --key <k>",
    "  bind-checkout-subscription --issuance-idempotency-key <ref> --provider stripe",
    "         --provider-account-id <id> --provider-mode <test|live>",
    "         --external-subscription-id <id> --external-checkout-id <id> [--dry-run]"
  ].join("\n");
}

function fail(out: (line: string) => void, message: string): number {
  out(`error: ${message}`);
  return 2;
}

interface Flags {
  has(name: string): boolean;
  string(name: string): string | undefined;
}

function parseFlags(args: string[]): Flags {
  const map = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(name, next);
      i += 1;
    } else {
      bare.add(name);
    }
  }
  return {
    has: (name) => map.has(name) || bare.has(name),
    string: (name) => map.get(name)
  };
}

// Executed directly (node admin.ts / dist/admin.js): open the configured DB and run.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("admin.ts") || process.argv[1]?.endsWith("admin.js")) {
  const dbPath = process.env.LICENSE_DB_PATH ?? "runtime/license.sqlite";
  const store = new LicenseStore(dbPath);
  const code = runAdmin(process.argv.slice(2), store);
  store.close();
  process.exit(code);
}
