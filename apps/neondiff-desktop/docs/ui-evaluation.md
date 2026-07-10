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

The exact UI-test launch contract is:

```text
--ui-testing
--ui-fixture <absolute-path>
--content-size <width>x<height>
--disable-animations
```

The parser fails closed unless all four parts are present. Supported content
sizes are `1040x680`, `1280x800`, `1440x900`, `760x560`, and `560x700`.
At this stage the parser/catalog contract is implemented and tested in the
isolated evaluation-support target. The production app does not link that
target. DEBUG-only app/model wiring and launched capture remain required before
these arguments may be treated as an executable user-interface test path.

## Evidence Manifest

`DesktopEvaluationEvidenceManifest` binds a capture packet to:

- repository and exact 40-character source SHA;
- absolute app artifact path, build identity, and artifact SHA-256;
- fixture catalog SHA-256;
- macOS, Xcode, Swift, architecture, and backing scale;
- test count, duration, and `.xcresult` SHA-256;
- fixture, surface, onboarding step, appearance, requested content size, and
  actual window/content frames per case;
- screenshot, accessibility-tree, and geometry artifact paths and SHA-256s;
- SSIM, changed-pixel percentage, largest changed-region percentage, and mask
  version per golden;
- passing secret and release-boundary scans;
- an explicit proof boundary and typed unresolved P2/P3 findings.

The manifest allows the same fixture at different canonical sizes but rejects a
duplicate `(fixture, appearance, size, scale)` case. It rejects unknown fields,
malformed hashes, non-canonical sizes, unsafe evidence paths, failed scans,
golden results below the specified thresholds, unresolved P0/P1 findings, and
empty proof boundaries. Canonical packets belong in the dated external evidence
directory and CI artifacts; raw screenshots, AX trees, and geometry output do
not belong in the repository.

## Validation

From the repository root:

```bash
swift run --package-path apps/neondiff-desktop NeonDiffDesktopFixtureChecks
npx vitest run tests/desktop-evaluation-boundary.test.ts tests/swift-ci-velocity.test.ts
swift build --package-path apps/neondiff-desktop -c release --product NeonDiffDesktop
release_bin="$(swift build --package-path apps/neondiff-desktop -c release --show-bin-path)"
npm run check:desktop-fixture-boundary -- "$release_bin/NeonDiffDesktop"
NEONDIFF_DESKTOP_DIST_DIR="$PWD/apps/neondiff-desktop/dist-release" \
  apps/neondiff-desktop/script/build_and_run.sh release-bundle-check
npm run check:desktop-fixture-boundary -- apps/neondiff-desktop/dist-release/NeonDiffDesktop.app
```

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
- license absent/public, active-private, and private-blocked states;
- logs empty, populated, and error states;
- policy loaded, dirty, and previewed states;
- public and private onboarding modes;
- native chrome and Settings-window state.

Every case must settle explicitly before capture and produce screenshot, AX,
and geometry hashes at minimum and baseline sizes. Full XCUITest coverage and
the importable app-model target are owned by #516. Until that toolchain and the
launched capture matrix land, this contract does not prove layout stability,
accessibility, signed/notarized distribution, browser/native parity, or GA.
