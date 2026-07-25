# NeonDiff design source of truth — live production website

Captured: 2026-07-15
Refreshed: 2026-07-26 (live palette and wordmark)
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
| background | #000 / #f4efe6 | #000000 | #F4EFE6 | window/content background |
| surface | #000 / #efeadd | #0A0F0C | #EFEADD | native cards and panels; evidence consoles may remain dark |
| textPrimary | #d9ffe6 / #0a1420 | #D9FFE6 | #0A1420 | primary text |
| textSecondary | #6d8a75 / #3a4756 | #6D8A75 | #3A4756 | secondary/muted text |
| accentPrimary | #39ff88 / #0e7490 | #39FF88 | #0E7490 | primary action, live/healthy status ONLY |
| accentMagenta | #ff2bd6 / #be185d | #FF2BD6 | #BE185D | PR identity, attention accents |
| warning | #ffcc33 / #b45309 | #FFCC33 | #92400E | warning text/icons; native light darkens the site orange for 4.5:1 small-text contrast |
| danger | #ff3b6b / #b91c1c | #FF3B6B | #B91C1C | destructive/error |
| borderPrimary | #39ff88 @ 22% / ink @ 16% | same | #0A1420 @ 26% | panel/console borders; strengthened for native light-mode separation |
| borderInput | #39ff88 @ 18% / ink @ 12% | same | #0A1420 @ 20% | field borders; strengthened for native light-mode separation |

Corners: the site renders square components. Native translation: sharp (0–2pt) corners on brand
surfaces (consoles, evidence panels, bracket buttons); standard macOS radii on system controls
(menus, sheets, alerts) — do not fight AppKit.

## Type system

| Site | Native | Rule |
|---|---|---|
| SAIBA-45 uppercase (wordmark/display) | First-party raster wordmark derived from the live site; no redistributable font binary. SF Pro Display for other brand moments | The live wordmark shape is used in app chrome and navigation. Do not use SAIBA for working-screen body text. |
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

Light mode is a first-class translation, not an inversion: the live site's warm-bone #F4EFE6
background, deep-ink #0A1420 text, cyan #0E7490 primary accent, warm paper surfaces, and low-alpha
ink borders. Evidence/terminal panels may remain dark, matching the live site, while ordinary native
controls stay on paper surfaces. Brand identity carries via the exact SAIBA wordmark, mono label
system, bracket CTA, panel structure, and status glyph language — not via neon-on-black.

## Accessibility floors

- Text contrast ≥ 4.5:1 in both appearances (large text ≥ 3:1). Measured (dark, on #000): textPrimary
  #D9FFE6 ≈ 19.4:1; accentPrimary #39FF88 ≈ 15.8:1; textSecondary #6D8A75 ≈ 5.5:1; accentMagenta
  #FF2BD6 ≈ 6.6:1. Light ratios are recomputed against the live #F4EFE6 background by
  `NDDesignTokenContractTests`.
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
