# Issue 488 Provider Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit native Verify API Key action that reads the stored Keychain secret, verifies the configured provider through NeonDiff's existing hardened smoke path, and retains only redacted result metadata.

**Architecture:** Add a bounded stdin-only secret reader and a `providers verify` CLI action that delegates to `verifyProviderApiKey`. Extend the Swift CLI client with standard-input support, put Keychain read plus strict result parsing in a testable core service, then expose redacted state in the native Providers pane.

**Tech Stack:** TypeScript/Node.js, Vitest, Swift 6/SwiftUI, macOS Security/Keychain, Foundation `Process` and `Pipe`.

## Global Constraints

- Raw provider keys never enter argv, process environment, config, stdout/stderr, logs, screenshots, or evidence.
- The submitted secret travels only from Keychain to the child process over bounded stdin.
- Reuse `verifyProviderApiKey`; do not create a second HTTP/provider verification transport.
- Only an exact successful redacted envelope with state `healthy` is a verified pass.
- Hosted verification requires explicit remote-smoke consent from the user action.
- No live daemon, review, issue-comment, signing, notarization, appcast, dist-tag, or release mutation.

---

### Task 1: Bounded stdin and public provider-verification CLI

**Files:**
- Create: `src/secret-stdin.ts`
- Create: `tests/secret-stdin.test.ts`
- Modify: `src/local-dashboard.ts`
- Modify: `src/cli.ts`
- Modify: `tests/local-dashboard.test.ts`
- Modify: `tests/public-cli.test.ts`

**Interfaces:**
- Produces: `readSecretFromStdin(stream: NodeJS.ReadableStream, maxBytes?: number): Promise<string>`.
- Produces: `providers verify` redacted JSON.
- Consumes: existing `verifyProviderApiKey`, optional `--provider`, and explicit `--allow-remote-smoke`.

- [ ] **Step 1: Write failing bounded-stdin tests**

```ts
it("reads one trimmed secret without echoing it", async () => {
  await expect(readSecretFromStdin(Readable.from(["fixture-provider-value\n"]), 64))
    .resolves.toBe("fixture-provider-value");
});

it("rejects empty and oversized stdin", async () => {
  await expect(readSecretFromStdin(Readable.from(["\n"]), 64)).rejects.toThrow("non-empty");
  await expect(readSecretFromStdin(Readable.from(["x".repeat(65)]), 64)).rejects.toThrow("64 bytes");
});
```

- [ ] **Step 2: Run the stdin tests and confirm the missing-module failure**

Run: `npm test -- tests/secret-stdin.test.ts`

Expected: FAIL because `src/secret-stdin.ts` does not exist.

- [ ] **Step 3: Implement the bounded reader**

```ts
export async function readSecretFromStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = 64 * 1024
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new Error(`provider secret stdin exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) throw new Error("provider secret stdin must be non-empty");
  return secret;
}
```

- [ ] **Step 4: Write failing CLI and redaction tests**

Spawn `providers verify` with stdin `fixture-provider-value\n` against a fixture loopback provider and assert:

```ts
expect(output).toMatchObject({
  command: "providers verify",
  redacted: true,
  providerId: "fixture-openai",
  state: expect.stringMatching(/^(healthy|blocked)$/)
});
expect(JSON.stringify(output)).not.toContain("fixture-provider-value");
```

Add local-dashboard coverage proving a command override changes only the discriminator and keeps redaction.

- [ ] **Step 5: Generalize the verifier command discriminator**

```ts
type ProviderVerificationCommand = "dashboard verify-provider" | "providers verify";

export interface ProviderApiKeyVerificationInput {
  command?: ProviderVerificationCommand;
  config: BotConfig;
  providerId?: string;
  apiKey?: string;
  allowRemoteSmoke?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ProviderApiKeyVerificationResult {
  command: ProviderVerificationCommand;
  ok: boolean;
  checkedAt: string;
  providerId: string;
  state: LocalDashboardReadinessState;
  mode: "metadata_only" | "openai_compatible_models";
  detail: string;
  redacted: true;
  keySource?: "submitted" | "env";
  check?: Omit<ProviderDoctorCheck, "error"> & { error?: string };
  troubleshooting: string[];
}
```

Compute `const command = input.command ?? "dashboard verify-provider"` once and use it in every return.

- [ ] **Step 6: Implement `providers verify`**

```ts
if (action === "verify") {
  const providerId = args.provider ? parseSingleArg(args.provider, "--provider") : undefined;
  const apiKeyStdin = parseBooleanArg(args["api-key-stdin"], "--api-key-stdin");
  if (!apiKeyStdin) throw new Error("providers verify requires --api-key-stdin true");
  const apiKey = await readSecretFromStdin(process.stdin);
  const result = await verifyProviderApiKey({
    command: "providers verify",
    config,
    ...(providerId ? { providerId } : {}),
    apiKey,
    allowRemoteSmoke: parseBooleanArg(args["allow-remote-smoke"], "--allow-remote-smoke")
  });
  console.log(stringifyRedactedJson(result));
  if (!result.ok || result.state !== "healthy") process.exitCode = 1;
  return;
}
```

Validate provider IDs, update help, and never include stdin in thrown errors.

- [ ] **Step 7: Run focused TypeScript proof**

```bash
npm test -- tests/secret-stdin.test.ts tests/local-dashboard.test.ts tests/public-cli.test.ts
npm run build
npm run check:secrets
```

Expected: all commands exit 0 and serialized output omits the fixture secret.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/secret-stdin.ts src/local-dashboard.ts src/cli.ts tests/secret-stdin.test.ts tests/local-dashboard.test.ts tests/public-cli.test.ts
git commit -m "feat(providers): verify API keys from bounded stdin"
```

### Task 2: Strict Swift process and verification service

**Files:**
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/ProviderVerificationService.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/NeonDiffCLIClient.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktopCoreChecks/main.swift`

**Interfaces:**
- Produces: `NeonDiffCLIClienting.run(arguments:standardInput:timeout:)`.
- Produces: redacted `ProviderVerificationSnapshot`.
- Produces: `ProviderVerificationService.verify(account:arguments:timeout:)`.

- [ ] **Step 1: Add failing core checks for stdin and strict parsing**

Use an in-memory secret store and fake CLI client:

```swift
let snapshot = try service.verify(
    account: "provider/glm/api-key",
    arguments: ["providers", "verify", "--api-key-stdin", "true"],
    timeout: 15
)
check(fakeCLI.arguments.joined(separator: " ").contains("fixture-provider-value") == false,
      "provider secret never enters argv")
check(fakeCLI.standardInput == Data("fixture-provider-value".utf8),
      "provider secret is supplied only on stdin")
check(snapshot.state == .healthy, "only a healthy exact envelope parses as verified")
```

Also reject wrong command, `redacted != true`, malformed JSON, nonzero exit, `configured_unverified`, and any serialized output containing the fixture secret.

- [ ] **Step 2: Run core checks and confirm compile failures**

Run: `swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreChecks`

Expected: FAIL because the new overload and service types do not exist.

- [ ] **Step 3: Add standard-input support**

```swift
public protocol NeonDiffCLIClienting {
    func run(arguments: [String], standardInput: Data?, timeout: TimeInterval) throws -> CLIRunResult
    func launchDetached(arguments: [String]) throws -> CLILaunchResult
}

public extension NeonDiffCLIClienting {
    func run(arguments: [String], timeout: TimeInterval) throws -> CLIRunResult {
        try run(arguments: arguments, standardInput: nil, timeout: timeout)
    }
}
```

Attach a `Pipe` only when input exists, run the process, write the bounded data, and close the write handle. Never copy input to `CLILaunchResult` or errors.

- [ ] **Step 4: Implement strict redacted parsing**

```swift
public enum ProviderVerificationState: String, Equatable, Sendable {
    case healthy
    case configuredUnverified = "configured_unverified"
    case blocked
}

public struct ProviderVerificationSnapshot: Equatable, Sendable {
    public let command: String
    public let providerId: String
    public let checkedAt: String
    public let state: ProviderVerificationState
    public let mode: String
    public let detail: String
    public let troubleshooting: [String]
}
```

Require `command == "providers verify"`, `redacted == true`, non-empty provider/time/detail, known state/mode, and no secret-like keys.

- [ ] **Step 5: Implement the Keychain-to-stdin service**

```swift
public final class ProviderVerificationService {
    private let keychain: DesktopSecretStoring
    private let cli: NeonDiffCLIClienting

    public func verify(account: String, arguments: [String], timeout: TimeInterval) throws -> ProviderVerificationSnapshot {
        guard let secret = try keychain.readSecret(account: account), !secret.isEmpty else {
            throw ProviderVerificationError.missingKeychainSecret
        }
        let result = try cli.run(arguments: arguments, standardInput: Data(secret.utf8), timeout: timeout)
        return try ProviderVerificationParser.parse(result: result)
    }
}
```

Do not retain the secret on the service or snapshot.

- [ ] **Step 6: Run focused Swift proof**

```bash
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreChecks
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreSmoke
swift build --package-path apps/neondiff-desktop
```

Expected: checks print pass/`ok:true`; build exits 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/NeonDiffCLIClient.swift apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/ProviderVerificationService.swift apps/neondiff-desktop/Sources/NeonDiffDesktopCoreChecks/main.swift
git commit -m "feat(desktop): bridge Keychain provider verification over stdin"
```

### Task 3: Native model and Providers-pane action

**Files:**
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ProviderSettingsView.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktopCoreChecks/main.swift`

**Interfaces:**
- Consumes: `ProviderVerificationService` and `ProviderVerificationSnapshot`.
- Produces: `verifyProviderKey()`, `isProviderVerificationInProgress`, and redacted `providerVerification` state.

- [ ] **Step 1: Add failing service-state checks**

Prove a healthy result installs only redacted metadata, while wrong-command and transport failures clear the prior result. Assert the fake secret is absent from arguments, snapshot detail, troubleshooting, and serialized result text.

- [ ] **Step 2: Add model state and action**

```swift
@Published var providerVerification: ProviderVerificationSnapshot?
@Published var providerVerificationStatus = "Verify the stored API key when ready."
@Published var isProviderVerificationInProgress = false
```

`verifyProviderKey()` guards concurrency/missing Keychain state, builds only non-secret arguments, passes `--api-key-stdin true --allow-remote-smoke true`, runs off the main actor, installs only redacted success state, and clears prior state on every failure.

- [ ] **Step 3: Add the button and result card**

```swift
Button { model.verifyProviderKey() } label: {
    Label(model.isProviderVerificationInProgress ? "Verifying…" : "Verify API Key",
          systemImage: "checkmark.shield")
}
.disabled(!model.providers.providerKeyStored || model.isProviderVerificationInProgress)
```

Render provider ID, state badge, checked time, mode, redacted detail, and troubleshooting only from the snapshot.

- [ ] **Step 4: Run native checks and build**

```bash
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreChecks
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreSmoke
swift build --package-path apps/neondiff-desktop
```

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/neondiff-desktop/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ProviderSettingsView.swift apps/neondiff-desktop/Sources/NeonDiffDesktopCoreChecks/main.swift
git commit -m "feat(desktop): add redacted Verify API Key action"
```

### Task 4: Full-pane proof, docs, and PR gate

**Files:**
- Modify: `docs/neondiff-desktop.md`
- Modify: `docs/superpowers/plans/2026-07-10-issue-488-config-control-center.md`
- Create evidence under: `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/`

**Interfaces:**
- Consumes: completed native action and a redacted fixture result.
- Produces: unsigned full-pane proof and final #488 Slice B PR evidence.

- [ ] **Step 1: Document stdin-only transport and states**

Document that only `healthy` is verified, hosted calls require explicit click consent, metadata-only is non-success, and no raw key enters argv/env/config/log/evidence.

- [ ] **Step 2: Run the complete local gate**

```bash
npm test
npm run build
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreChecks
swift run --package-path apps/neondiff-desktop NeonDiffDesktopCoreSmoke
swift build --package-path apps/neondiff-desktop
npm run check:secrets
npm run check:public-claims
actionlint
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Produce unsigned visible proof without a real key**

Launch the debug app with fixture/injected redacted verification metadata. Capture the Providers pane and remaining configuration sections so evidence shows the Verify action and every Slice A section. Store PNGs only under the evidence directory and record SHA-256 values.

- [ ] **Step 4: Run two independent read-only reviews**

Require one spec/product review and one security/data-flow review. Resolve every P0-P2 and serious P3.

- [ ] **Step 5: Commit docs and open the Slice B PR**

```bash
git add docs/neondiff-desktop.md docs/superpowers/plans/2026-07-10-issue-488-config-control-center.md
git commit -m "docs(desktop): record provider verification proof"
git push -u origin codex/488-provider-key-verification
```

Open a PR linked to #488. Shepherd exact-head CI, CodeQL, CodeRabbit, evaOS status, top-level comments, and unresolved threads. Merge only when all are current-head clean.

- [ ] **Step 6: Close Slice B truthfully**

After merge, verify `origin/main` and post-merge checks, update #488 with PR/evidence links, and close #488 only if both slices are proven. Do not claim signed/notarized distribution, Sparkle/appcast, browser/native parity, customer readiness, or v1.1 completion.
