# NeonDiff design source of truth — live production website

Captured: 2026-07-15
Source: https://neondiff.com (live production site; computed-style token extraction + full-page review)
Owner ratification: the current live website is the ONLY approved visual source (epic #610, issue #611).
The unshipped website redesign is rejected. Browser-dashboard parity and WebView product UI are rejected.
The advanced native SwiftUI Mac app is the product surface; this document defines how the live site's
brand translates into native macOS — translation, not pixel cloning.

## Design authority

- Canonical brand reference: https://neondiff.com as captured 2026-07-15.
- Product UI: native SwiftUI macOS app (`apps/neondiff-desktop`). Native interaction, typography,
  accessibility, navigation, and window behavior always win over web mimicry.
- The rejected unshipped website redesign ("industrial workstation", carbon neutrals, 6/10/14pt radii)
  must not be implemented anywhere. Where older issues describe it, this document supersedes the
  aesthetic description (#520 reconciles against this contract).
- Marketing theater (animated review console, glitch effects, hero scale) belongs to the website, not
  the app. The app earns trust through calm, legible, native surfaces that carry the same identity.

## Token table

Raw live-site values → semantic roles → native mapping. Dark appearance is the brand-native mode.

| Role | Site value (dark) | Native dark | Native light | Usage |
|---|---|---|---|---|
| background | #000 | #000000 | #FAFAF8 | window/content background |
| surface | #000 + green-tinted border | #0A0F0C | #FFFFFF | cards, consoles, panels |
| textPrimary | #d9ffe6 | #D9FFE6 | #1A211C | primary text |
| textSecondary | #6d8a75 | #6D8A75 | #5A6B5F | secondary/muted text |
| accentPrimary | #39ff88 | #39FF88 | #0F7A3D | primary action, live/healthy status ONLY |
| accentMagenta | #ff2bd6 | #FF2BD6 | #B01E96 | PR identity, attention accents |
| warning | #ffcc33 | #FFCC33 | #8A6D00 | warning text/icons |
| danger | #ff3b6b | #FF3B6B | #C21E44 | destructive/error |
| borderPrimary | #39ff88 @ 22% | same | #0F7A3D @ 35% | panel/console borders |
| borderInput | #39ff88 @ 18% | same | #0F7A3D @ 30% | field borders |

Corners: the site renders square components. Native translation: sharp (0–2pt) corners on brand
surfaces (consoles, evidence panels, bracket buttons); standard macOS radii on system controls
(menus, sheets, alerts) — do not fight AppKit.

## Type system

| Site | Native | Rule |
|---|---|---|
| Orbitron 500 uppercase (display) | SF Pro Display, heavy tracking uppercase — or nothing | Brand display voice is for brand moments only (About, onboarding welcome). Never in working screens. |
| Inter (body) | SF Pro Text (system default) | All body/control text is system type at system sizes. |
| JetBrains Mono uppercase, ~2.6px tracking @ 10–11px (labels/nav/status) | SF Mono, semibold, 11pt equivalent, tracking 1.5–2.0, uppercase | Section labels, status chips, key-value stat rows, console text. This is the strongest carry-over identity element. |

Dynamic Type: all roles must scale with the user's text size; the mono label system uses relative
text styles, not fixed pixel sizes.

## Component translation

| Live-site motif | Native translation |
|---|---|
| `[ BRACKET CTA ]` button (1px primary border @40%, 6% fill, square, mono uppercase) | `NDBracketButtonStyle` for the ONE primary action per screen; keyboard focus ring preserved; standard buttons elsewhere |
| Console/terminal card (thin green border, corner tick marks, mono content) | Evidence/log/review surfaces: `NDConsolePanel` container with 1px borderPrimary + corner ticks |
| `SECTION // LABEL` mono headers | Section headers in working screens: uppercase SF Mono textSecondary |
| Key-value stat rows (label left, mono value right) | `LabeledContent` styled with mono values — status/readiness rows |
| ◆ / ◇ / ● status glyphs | Status indicators alongside semantic color (never color alone) |
| `[✓]` / `[→]` roadmap markers | Checklist/step rows in onboarding and readiness lists |
| Traffic-light dots on cards | Do not clone — macOS already has window chrome |

## Neon budget

- accentPrimary (#39FF88) appears ONLY as: the one primary action per screen, live/healthy status,
  and panel borders at reduced alpha. Never body text, never large fills, never multiple competing
  green elements.
- accentMagenta is rarer still: PR identity and attention moments.
- At most ONE decorative brand treatment per screen (a corner-ticked panel OR a bracket CTA header
  moment — not both stacked).
- Empty/loading/error states use textSecondary + semantic colors, not neon.

## Forbidden clones

- No scanlines, glitch/chromatic-aberration, or animated marketing console in working screens.
- No WebView/browser-embedded product surfaces (rejected direction).
- No cloning of HTML layout/spacing; native spacing and hit targets govern.
- No clipped/angled corners on standard form controls; brand corner-clipping is reserved for the
  primary bracket CTA.
- No dark-only design: every screen must be fully designed in both appearances.

## Light mode

Light mode is a first-class translation, not an inversion: near-white background, ink-green text,
accentPrimary darkened to #0F7A3D (4.5:1+ on white), borders at higher alpha to survive light
backgrounds. Brand identity carries via the mono label system, bracket CTA, panel structure, and
status glyph language — not via neon-on-black.

## Accessibility floors

- Text contrast ≥ 4.5:1 in both appearances (large text ≥ 3:1). Measured (dark, on #000): textPrimary
  #D9FFE6 ≈ 19.4:1; accentPrimary #39FF88 ≈ 15.8:1; textSecondary #6D8A75 ≈ 5.5:1; accentMagenta
  #FF2BD6 ≈ 6.6:1. Measured (light, on #FAFAF8): textPrimary #1A211C ≈ 15.7:1; accentPrimary #0F7A3D
  ≈ 5.2:1; textSecondary #5A6B5F ≈ 5.4:1.
  Method: these ratios use the WCAG 2.x relative-luminance formula computed in-repo by
  `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/NDDesignTokenContractTests.swift` — the
  reproducible proof any reader can run (`cd apps/neondiff-desktop && swift test --filter NDDesignTokenContractTests`).
  It fails the build below the 4.5:1 floor for textPrimary/background and accentPrimary/background in both
  appearances, and runs in CI on every head (Swift Desktop Gate → "Swift core, AppCore, and evaluation-support
  tests"). Rendered screenshot artifacts are held outside the repo per the evidence-retention/secret boundary and
  are not required to verify these numbers.
- Status is never conveyed by color alone (glyph + text always).
- Full VoiceOver labels on all reference-screen controls; keyboard reachability preserved.
- Respects Reduce Motion (no brand animation), Increase Contrast (borders step up to full alpha),
  and Dynamic Type.

## Reference screen

`OverviewView` (default landing tab) demonstrates this contract: tokenized colors/type, mono section
labels, status rows with glyphs, and one bracket primary action as the screen's single decorative brand
treatment (per the neon budget: the readiness panel is a plain tokenized surface, not corner-ticked, so
it does not stack a second treatment against the bracket CTA). The corner-ticked console (`NDConsolePanel`)
is reserved for evidence/log surfaces where it is the sole treatment. Structural redesign of Home
hierarchy remains owned by #521; onboarding by #519; the full component system by #520 (grounded in this
document).

## Contract enforcement

`npm run check:design-source` (scripts/check-design-source-contract.mjs) fails the build if this
document is missing/stripped or if retired-direction claims (dashboard-as-first-run-surface,
browser-dashboard parity, WebView product UI) reappear in README.md, docs/SETUP.md, or
docs/neondiff-desktop.md.
