# Desktop UI Evaluation

Issue #515 establishes the deterministic baseline used before NeonDiff Desktop
changes visual structure. The catalog is public-safe test input, not customer
configuration and not release proof by itself.

## Current Contract

The versioned catalog is `fixtures/ui/catalog.json`. It names one deterministic
fixture for each current tab and onboarding step:

- Overview, Repos, Providers, License, Logs, Policy, and Settings;
- Welcome, Provider, Daemon, License, and Done onboarding steps.

Fixtures pin a clock, locale, appearance, selected surface, redacted readiness
state, expected actions, and safe visible copy. They contain only credential
presence booleans. The loader rejects unknown fields, unsupported versions,
non-canonical identifiers, secret-shaped values, author-machine paths,
symlinked fixture files, duplicate catalog entries, and oversized input.
Later onboarding fixtures must also satisfy the real flow's already-completed
provider and daemon prerequisites. The License step is explicitly blocked on
API-backed activation, Done requires an active credential-backed entitlement,
and every post-onboarding tab fixture is activated. They are reachable
mandatory-activation flow snapshots, not arbitrary combinations of fields.

In this nominal slice, `expectedActions`, `scriptedOutcomes`, and `safeCopy` are
typed scenario metadata only. The runner does not click those actions or assert
their rendered AX copy, enabled state, focus behavior, tooltip behavior, or
before/after geometry. A passing nominal packet is therefore a deterministic
visual-inventory seed, not an automated per-tab behavior evaluation.

The exact UI-test launch contract is:

```text
--ui-testing
--ui-fixture <absolute-path>
--content-size <width>x<height>
--disable-animations
```

The parser fails closed unless all four parts are present. Supported content
sizes are `1040x680`, `1280x800`, `1440x900`, `760x560`, and `560x700`.
The parser/catalog contract is implemented and tested in the isolated
evaluation-support target. The production executable does not depend on that
target. Debug bundles contain a separate resolver helper that validates and
normalizes fixtures before the app accepts them; release bundles omit the
helper entirely. A valid fixture launch uses deterministic in-memory adapters,
applies an AppCore initial-state snapshot, sets the requested content size once,
disables animation, and fails closed instead of falling through to live
Keychain, UserDefaults, CLI, GitHub, provider, daemon, or network adapters.

The CLT-compatible capture helper verifies non-prompting Screen Recording and
Accessibility grants, matches the exact PID and CG window number, invokes
`/usr/sbin/screencapture` explicitly, serializes a bounded redacted AX tree,
and corroborates app-authored geometry with CG bounds and PNG dimensions.

## Evidence Manifest

`DesktopEvaluationEvidenceManifest` binds a capture packet to:

- repository and exact 40-character source SHA;
- packet-relative app artifact path, build identity, and artifact SHA-256;
- fixture catalog SHA-256;
- macOS, Xcode, Swift, architecture, and backing scale, cross-checked against a
  separately hashed capture-host evidence document so later verification is
  portable across machines and toolchain upgrades;
- test count, duration, runner, and generic result-artifact SHA-256 (a Swift
  Testing log under Command Line Tools or a zipped `.xcresult` under hosted
  XCTest), plus the typed summary JSON that binds that result to exact HEAD;
- fixture, surface, onboarding step, appearance, requested content size, and
  actual window/content frames per case;
- screenshot, accessibility-tree, geometry, and app-authored readiness artifact
  paths and SHA-256s;
- an explicit `captured-no-reference` visual-baseline status per case, without
  fabricated similarity or changed-pixel metrics;
- passing secret and release-boundary scans;
- an explicit proof boundary and typed unresolved P0-P3 findings.

The manifest allows the same fixture at different canonical sizes but rejects a
duplicate `(fixture, appearance, size, scale)` case. Test count and capture-case
count are recorded independently. It requires at least one capture case and a
unique packet-relative path for every screenshot, AX tree, and geometry file.
It rejects unknown fields, malformed hashes, non-canonical sizes, URL-like or
ambiguous evidence paths, failed scans, mislabeled comparison evidence, and
empty proof boundaries. Schema 2 records a newly captured baseline with no
reference; later comparison metrics require a schema that binds the exact
reference artifact rather than comparing a file to itself. Typed P0/P1 findings
remain truthful; the GA gate, not the evidence decoder, stops progression on
those results. Canonical packets belong in the dated external evidence
directory and CI artifacts; raw screenshots, AX trees, and geometry output do
not belong in the repository.

Manifest schema 2 defines app artifact SHA-256 as `sha256-tree-v1`: a
bytewise-path-sorted stream of directory, symlink-target, regular-file content
hash, size, and executable-bit records. Timestamps and ownership are excluded;
absolute or escaping symlinks are rejected. This avoids ambiguously hashing
only the app executable while labeling it as the bundle hash.

During capture, the exact-head resolver emits a normalized document for every
copied fixture. The packet hashes both raw and normalized fixture data. The
final verifier never executes packet-provided code: it applies its trusted
strict schema/public-safety/reachable-onboarding validator to both documents and
requires their canonical forms to match. Catalog/hash agreement alone is not
accepted.

## Validation

From the repository root:

```bash
swift run --package-path apps/neondiff-desktop NeonDiffDesktopFixtureChecks
apps/neondiff-desktop/scripts/run-required-swift-test-suite.sh NeonDiffDesktopEvaluationSupportTests
npx vitest run tests/desktop-evaluation-boundary.test.ts tests/swift-ci-velocity.test.ts
swift build --package-path apps/neondiff-desktop -c release --product NeonDiffDesktop
release_bin="$(swift build --package-path apps/neondiff-desktop -c release --show-bin-path)"
npm run check:desktop-fixture-boundary -- "$release_bin/NeonDiffDesktop"
NEONDIFF_DESKTOP_DIST_DIR="$PWD/apps/neondiff-desktop/dist-release" \
  apps/neondiff-desktop/script/build_and_run.sh release-bundle-check
npm run check:desktop-fixture-boundary -- apps/neondiff-desktop/dist-release/NeonDiffDesktop.app
```

After focused tests are recorded and the worktree is clean, create the nominal
two-size packet with:

```bash
apps/neondiff-desktop/scripts/capture-evaluation-baseline.sh \
  --output /absolute/evidence/path
```

The runner executes and types the required Swift suites itself, builds one exact
debug bundle, validates the release boundary from the same source, launches
every catalog fixture in a fresh process at 1040x680 and 1280x800, captures
PNG/AX/geometry, scans the packet text, builds schema-2 `manifest.json`, and
validates both schema and all referenced bytes. It rechecks clean HEAD state
after build and immediately before manifest emission.

Those two sizes cover the main-window minimum and baseline only. The onboarding
760x560, Settings 560x700, and wide 1440x900 captures, plus click-to-click
geometry traces, remain #515/#517 work and are not implied by this packet.

## Focused #517 Repos Reachability Proof

The Repos-only runner is a focused partial #517 proof outside the canonical #515 packet.
From a clean exact HEAD, give it a fresh absolute output path:

```bash
apps/neondiff-desktop/scripts/capture-repos-reachability.sh \
  --output /absolute/fresh/evidence/path
```

The runner creates a private `/tmp` workspace, keeps SwiftPM DEBUG products and
the launched app there, builds one app bundle plus the capture and reachability
checker products, and launches only the public-safe `tab-repos` fixture at
`1040x680`. Only this focused runner passes the explicit
`--repos-reachability` opt-in to the capture helper, so canonical #515 captures
keep their existing byte and artifact shape. The runner waits boundedly for
app-authored readiness, captures the window, AX tree, geometry, and
`reachability.json`, plus a separate `scroll-capabilities.json`, terminates its
children, runs the checker against the absolute reachability path, and scans
the focused evidence for secret-shaped text. The capability packet is bound to
the `tab-repos` fixture and requested `1040x680` content size, is capped at 4096
bytes, and contains only schema/OS metadata, typed acquisition state, and
sanitized capability booleans. It uses `AXUIElementCopyActionNames` only to
check the verified Boundary and outer vertical scrollbar; it does not perform
accessibility actions. Missing, malformed, or failed action-name acquisition is
a typed acquisition failure rather than a false capability result. It never
reads live configuration, Keychain, GitHub, provider, daemon, network, or
customer state.

Capture output remains in the private workspace until the helper exits
successfully and every required file is present. A fixture exit before
readiness, bounded readiness timeout, capture timeout, TCC denial, partial
capture, or source-HEAD drift leaves `focused-capture-status.json` marked
`incomplete`, does not publish a focused proof or safety `ok` marker, and does
not expose raw launch or capture logs. The final proof, safety result, and `ok`
marker are published only after the packet scan passes and a final clean
exact-HEAD check succeeds.

The current pre-fix result is the missing outer `AXScrollArea` ancestor. It is
classified as that expected RED only when the typed reachability acquisition is
`complete`, its failure reason is explicitly null, `outerScroll` is explicitly
null, and the checker reports the exact missing-scroll error. Acquisition
failures and unrelated checker failures remain ordinary checker failures.
Boundary is a sibling of Table, so a Table scroll does not satisfy the checker.
The DEBUG fixture may
mutate only its deterministic test UI to exercise scroll reachability; it does
not authorize live product or runtime mutation. A checker failure preserves
both `reachability.json` and `scroll-capabilities.json`.
The normalized checker status and public-safety result are written before the
runner returns the nonzero checker exit.

This focused packet does not prove:

- the rest of the fixture catalog, the second baseline size, wide, onboarding,
  Settings, or the remaining state matrix;
- successful clicks, scripted outcomes, keyboard focus order, tooltips,
  before/after geometry, or full issue #517 layout-stability and accessibility
  conformance;
- the canonical #515 schema-2 manifest, reference comparison, or full baseline;
- release-bundle isolation, signing, notarization, appcast, installed-app, live
  runtime, customer, browser/native parity, GA, or customer readiness.

Rebuilding the DEBUG app or capture helper can change its code requirement and
invalidate an existing macOS TCC Screen Recording or Accessibility grant. A TCC
failure limits this local dev proof; it is not a Repos reachability result and
must not be bypassed by touching privacy settings from the runner.

The Swift desktop gate runs the fixture checks whenever evaluation sources or
catalog files change. It keeps the normal debug bundle separate, stages an
explicit release bundle under `dist-release`, and scans only the release
executable/bundle for UI-test flags, fixture types, and the evaluation marker.
Any match fails the gate.

## Remaining #515 Capture Matrix

The nominal catalog is the schema seed, not the complete baseline. The next
DEBUG-only slice must add named fixtures and launched capture for:

- provider configured-unverified, blocked, dirty, and in-progress states;
- GitHub disconnected, device-code, connected, and recovery states;
- daemon healthy, degraded, and offline states;
- activation required, active, expired/revoked, offline-cache, and service-blocked states;
- logs empty, populated, and error states;
- policy loaded, dirty, and previewed states;
- public and private repository-selection modes after mandatory activation;
- native chrome and Settings-window state.

Every case must settle explicitly before capture and produce screenshot, AX,
and geometry hashes at minimum and baseline sizes. AppCore and real Core/AppCore
Swift Testing targets landed in #529. Xcode 26.6 is installed and selected on
the development host; hosted XCUITest/`.xcresult` coverage remains #516 and is
not blocked on installing Xcode. Until the expanded launched matrix
and later interaction gates land, this contract does not prove layout stability,
accessibility, signed/notarized distribution, browser/native parity, or GA.
Website/native alignment also remains #520 work; that issue must bind a dated
website repository SHA, screenshots, and an adopt/adapt/reject token mapping
before visual similarity is treated as measurable evidence.
