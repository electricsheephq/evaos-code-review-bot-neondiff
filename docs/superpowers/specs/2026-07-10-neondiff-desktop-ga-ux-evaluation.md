# NeonDiff Desktop GA UX Evaluation And Modernization

Status: proposed execution contract  
Tracker: [#514](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/514)  
Milestone: [v1.1 — Real Mac Desktop Launch](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/milestone/11)

## Goal

Make NeonDiff Desktop stable, understandable, testable, and modern enough for a
real GA candidate. Establish deterministic interaction, geometry,
accessibility, and state proof before broad visual redesign.

The native SwiftUI app remains the product baseline. The browser dashboard is
not embedded as a replacement. The website is a related visual reference, not
a pixel-matching requirement.

## Resume Identity And Tracking

- Implementation repo: `electricsheephq/evaos-code-review-bot-neondiff`
- Roadmap: #103
- UX/evaluation epic: #514
- Browser/native direction: #503
- Signed desktop blockers: #116 and #449
- Child execution issues: #515 through #524
- Evidence root:
  `<local-evidence-root>/neondiff-v1.1/<date>/ga-ux/`

`<local-evidence-root>` is a contributor-selected, ignored artifact directory.
CI uploads the matching manifest and public-safe artifacts through the workflow
rather than depending on a workstation path.

GitHub issues, PRs, checks, releases, and milestone #11 are execution truth.
This document defines the product and proof contract; it does not replace the
issue graph.

## Current State

The current app is an advanced native operator console, but it applies its
retro HUD language to nearly every surface. Dense mono text, green borders,
angular cards, scanlines, internal CLI details, issue references, and equal
button weights make the app read like a development tool rather than a guided
product.

Existing screenshots prove visual density and inconsistent information
hierarchy. They do not prove the reported click-to-click window resizing. A
valid bug claim requires an exact artifact, click sequence, window/content
frame trace, accessibility tree, and settled-state timing.

The existing Swift package has executable check harnesses but no real test
target. `NeonDiffDesktopModel` belongs to the executable target, so the model
cannot be imported by a normal test target. The compile harness remains an
acceptable temporary gate until AppCore extraction is complete.

## Critical Invariants

- Provider verification remains explicit-click only.
- Provider keys remain in Keychain and travel only through bounded stdin.
- Preview, confirmed Apply, exact config revision, and readback gates remain.
- Fixtures contain key-presence booleans, never secret material.
- UI-test hooks and fixture content are absent from release artifacts.
- No test mutates live config, Keychain, GitHub, provider, daemon, or posting
  state unless a separately scoped installed-candidate scenario requires it.
- Public setup does not require a license. Private setup cannot enter an
  unavailable activation dead end.
- Screenshot approval cannot replace interaction, geometry, accessibility, or
  installed-artifact proof.
- #503 stays open until browser/native parity is independently measured.

## Execution Order

### Phase 1: Establish The Baseline

Issue #515 owns a deterministic fixture and evidence manifest for every current
surface. Each fixture records the selected tab or onboarding step, fixed clock
and locale, runtime/GitHub/provider/license state, scripted outcomes, delays,
expected actions, and safe public copy.

PR #513 is a hard baseline prerequisite because it adds the provider
verification states required by this matrix. #515 captures its canonical
pre-redesign baseline only from an exact `main` SHA that contains #513. Existing
issue-488 captures remain labeled historical pre-merge evidence; they do not
substitute for the canonical post-merge baseline.

The launch contract is:

```text
--ui-testing
--ui-fixture <absolute-path>
--content-size <width>x<height>
--disable-animations
```

The app must isolate defaults, disable state restoration, replace external
actions with recording fakes, and emit no secret-shaped accessibility or
visual content.

### Phase 2: Make App Logic Importable

Issue #516 owns the full-Xcode structure:

```text
NeonDiffDesktopCore
        ↓
NeonDiffDesktopAppCore
        ↓
NeonDiffDesktop executable
```

`NeonDiffDesktopAppCore` owns the model and coordinators. Operating-system
effects are injected behind clipboard, URL-opening, CLI/dashboard, preferences,
clock, and file-writing protocols. AppKit adapters and the composition root
stay in the executable.

The package/project adds:

- `NeonDiffDesktopCoreTests`
- `NeonDiffDesktopAppCoreTests`
- hosted `NeonDiffDesktopUITests`

The compile harness is removed only after all its assertions are migrated and
pass in the real targets.

### Phase 3: Prove Geometry And Accessibility

Issues #517 and #518 establish blocking geometry, scroll reachability,
accessibility, keyboard, focus, tooltip, appearance, and motion checks before
the redesign changes component geometry.

Canonical content sizes:

- minimum: `1040×680`
- baseline: `1280×800`
- wide: `1440×900`
- onboarding: `760×560`
- Settings: `560×700`

Record `NSWindow.frame`, `contentLayoutRect`, chrome, sidebar, detail header,
major sections, action rows, scroll viewports/content, and bottom sentinels
only after the fixture reports explicit quiescence: all scripted delays,
observable tasks, sheets, titlebar configuration, and state insertions are
complete. Then sample frames every 100ms and require three consecutive
unchanged samples within a five-second timeout. Timeout, missing quiescence, or
late frame change fails the scenario; two idle run-loop turns alone are not a
settled-state signal.

### Phase 4: Redesign The Product Flow

Issue #519 owns the first-success path:

1. Welcome and choose public or private mode.
2. Run CLI/config/Keychain/GitHub readiness checks.
3. Connect GitHub.
4. Select repositories.
5. Choose a provider preset.
6. Store and verify credentials when required.
7. Accept a recommended review policy.
8. Run one dry-run review.
9. Start monitoring only after dry-run success.
10. Show readiness and the next recommended action.

Presets and safe defaults come first. Endpoint, model, auth, path, and CLI
equivalent details live under Advanced disclosures. Progress persists and
resumes. Completion means first dry-run success or a clearly named recoverable
blocker.

### Phase 5: Apply Neon Precision

Issue #520 owns the shared brand contract:

- native macOS body/control typography;
- mono only for code, logs, commands, and identifiers;
- carbon neutrals with scarce neon proof/primary accents;
- semantic cyan, magenta, amber, and red;
- quiet separators and `6/10/14pt` radius hierarchy;
- 4pt spacing base with `8/12/16/24/32` rhythm;
- functional `80–180ms` transitions with no layout motion;
- system-aware light/dark and accessibility appearances;
- at most one decorative HUD element per screen.

Issues #521 through #523 then modernize the shell/Home, Repositories/Providers,
and Policy/License/Logs/Settings in bounded, independently reviewable slices.

### Phase 6: Operate The GA Gate

Issue #524 owns the PR, nightly, usability, and release-candidate evaluation
lanes. The release lane tests the exact packaged artifact rather than rebuilding
from source.

## Required State Matrix

Use pairwise scenarios rather than a full Cartesian product.

- Home: initial, checking, ready, degraded, offline, stale.
- Repositories: disconnected, authorizing, empty, discovered, selected,
  rate-limited, permission-blocked, public/private/license states.
- Providers: empty registry, key missing/stored, dirty, previewing, applying,
  verifying, cancelling, healthy, unverified, blocked, restart-required.
- Policy: unloaded, loading, clean, dirty, invalid, preview-authorized,
  externally stale, applying, rollback-ready, failed.
- License: absent, stored, pending, active, invalid, offline.
- Activity/Logs: empty, loading, populated, truncated, redacted failure.
- Settings: invalid path, unsaved, saved, update checking/available/failed.
- Onboarding: fresh public/private, resume, provider failure, GitHub failure,
  dry-run failure, complete.

## Cross-Tab Continuity Scenarios

1. Config inspection hydrates every dependent surface consistently.
2. Provider edits survive a tab round trip.
3. Provider or config-path changes invalidate preview and verification.
4. Verification/cancellation disables conflicting mutations across tabs.
5. Cleanup-required state remains visible and blocking everywhere.
6. Policy Apply stays bound to the exact previewed snapshot across navigation.
7. Repository selection becomes durable only after Preview/Apply.
8. Onboarding completion is reflected by Home without a hidden refresh.
9. Activity/errors/last command remain consistent across their consumers.
10. Repeatedly switching every tab preserves selection, edits, and geometry.

## Validation Gates

### Pull Requests

- Core and AppCore tests.
- App build.
- Critical XCUITest fixtures.
- Minimum and baseline geometry/scroll gates.
- Accessibility tree, IDs, labels, enabled state, and keyboard flow.
- No screenshot retry.

### Nightly

- Complete pairwise state matrix.
- All canonical sizes.
- Golden comparisons.
- Full accessibility and appearance audit.

### Release Candidate

- Exact packaged artifact SHA.
- Supported macOS versions and architectures.
- Manual tab-by-tab script.
- VoiceOver and multi-monitor checks.
- Signed/notarized/installed-app proof remains owned by #116/#449.

## Thresholds

- Zero failed tests, crashes, hangs, or unexplained retries.
- Settled window and major-region frame drift no more than 1pt.
- Zero clipped, overlapping, or unreachable non-scroll controls.
- Every scroll surface reaches its bottom sentinel.
- Zero missing or duplicate interactive accessibility identifiers.
- Zero empty labels, secret-shaped AX text, or critical AX violations.
- Interactive controls are at least `24×24pt`.
- Golden screenshots have exact dimensions, SSIM at least `0.995`, no more
  than `0.5%` materially changed pixels, and no unapproved connected changed
  region larger than `0.25%`.
- At least four of five representative evaluators complete public first-run
  without facilitator help; median time is under ten minutes with prepared
  credentials.
- No open P0/P1 usability finding. Every P2 waiver records owner, date, and
  reason.

## Evidence Manifest

Each run records:

- repo and head SHA;
- app artifact SHA-256;
- fixture catalog SHA;
- macOS, Xcode, Swift, architecture, and backing scale;
- requested and actual window/content sizes;
- test count, duration, and `.xcresult` hash;
- PNG, accessibility-tree, and geometry hashes;
- golden metrics and mask version;
- secret and release-artifact fixture scans;
- explicit proof boundary and unresolved findings.

## Stop Conditions

Stop GA progression for reproducible geometry drift, clipped critical controls,
missing first-run prerequisites, stale cross-tab state, unsafe fixture content,
fixture hooks in release artifacts, unreviewed golden updates, open P0/P1
usability findings, or any attempt to infer signed/notarized/parity readiness
from this suite alone.

## Proof Boundary

Completing this contract proves scoped native desktop UX readiness. It does not
by itself prove browser/native parity, signed or notarized distribution,
Sparkle/appcast updates, customer readiness, or v1.1 release completion.
