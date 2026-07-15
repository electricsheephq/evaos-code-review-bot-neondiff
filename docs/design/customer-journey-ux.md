# NeonDiff native customer-journey UX blueprint v1

Companion journey spec to [docs/design/live-site-design-source.md](./live-site-design-source.md) (the
visual contract), authored for the #610 customer-journey milestone. This is the FLOW/state design that
#519 (onboarding), #521 (shell/Home), #522 (repos/providers), #612 (activation), and #613 (GitHub
connect) implement together.

## Product sentence

A normal person installs the app and gets their first useful PR review without touching a terminal —
public repos free, private repos after activation.

## The golden path (stage → screen → owner)

1. **Welcome** (first launch; brand moment — the ONE Orbitron/display allowance outside About).
   One decision, two cards in live-site stat-card language:
   `[ REVIEW PUBLIC REPOS — FREE ]` / `[ I NEED PRIVATE REPOS ]`, plus a quiet
   "I already have an Activation Key" link. No license wall here — path choice only. Owner: #519.
2. **System readiness** (silent). Checks run inline (network, daemon binary, Keychain access);
   surfaces ONLY on failure as a typed card with the fix action. Owner: #519.
3. **Connect GitHub** — states from #613: `idle → browser_handoff (GitHub's own install UI) →
   waiting_return → bound(account, repo-selection summary)`, error states typed
   (denied/cancelled/timeout/broker_unavailable/rate_limited → each with retry/cause copy).
   Zero App-creation/PEM/env language anywhere. Owner: #613 (native slice) inside #519's frame.
4. **Select repositories** — list from the installation with GitHub-authoritative `PUBLIC`/`PRIVATE`
   badges (mono chips). On the free path, private rows render locked with "Requires activation —
   private repos are paid" (teaches the model contextually; no upfront paywall). Owner: #522.
5. **Verify provider** — presets first (GLM/Z.ai default · Ollama local · BYOK hosted), key field →
   Keychain, explicit `[ VERIFY PROVIDER ]` click = the consent moment for one bounded hosted call
   (live-site promise). States: empty/stored/dirty/verifying/healthy/failed(cause+retry). Owner: #522.
6. **Activate (private branch only)** — entered only when the user chose private or clicked a locked
   private repo. States from #612: `public_free_skip / purchase_required / checkout_paused (LIVE
   TODAY — honest copy + notify option + "existing keys still activate") / checkout_pending /
   key_ready / activation_pending / active / invalid / expired / revoked / offline / service_error`,
   each with exactly one recovery action. `NeonDiff Activation Key` vs `Provider Key` naming is
   load-bearing everywhere. Owner: #612.
7. **First dry-run** — pick an open PR from a selected repo (or the sample fixture when none).
   Streaming output rendered in THE console panel (corner ticks, mono — the one decorative brand
   element of this screen). Success ends with the real decision:
   `[ ENABLE AUTOMATIC REVIEWS ]` (defaults visible and safe: new+updated PRs, skip drafts, concise
   profile, dry-run-first stays on until this click). Owner: #519 flow, #521 console styling per #611.
8. **Home = readiness, not a console** — persistent checklist as live-site-style stat rows:
   `GITHUB ◆ CONNECTED · REPOS 3 SELECTED · PROVIDER ◆ VERIFIED · PLAN PUBLIC-FREE (or ACTIVE/…) ·
   AUTO-REVIEW ● ON`, one primary action per aggregate state (e.g. not-connected → Connect;
   all-ready-but-off → Enable; degraded → the one fix). Recent activity list under it. Owner: #521.

## Rules (bind all lanes)

- ONE primary action per screen; it is the only bracket-style CTA (see #611 neon budget).
- Every state names its cause and its next action; no dead ends, no raw error strings.
- Resume-exact: relaunch/cancel/network-loss returns to the same stage with state intact (#612 AC6).
- The public path NEVER sees license/checkout UI (#519 AC, #614 AC2). The private branch appears
  contextually (chosen path or locked-repo tap), never as an upfront wall.
- Zero terminal, zero App-creation, zero PEM/env/config-file language in any customer-facing string.
- Advanced/operator controls live under a collapsed Advanced group (CLI paths, endpoints, raw config).
- Copy tone = the live site's plain-English confidence ("Each step starts on your box"), not
  dev-console jargon; keep the site's privacy promise visible at provider verify and first dry-run.

## State-ownership map (no lane invents states another lane owns)

| States | Owner issue | Consumed by |
|---|---|---|
| Connect/GitHub lifecycle | #613 | #519 flow, #521 Home rows |
| Activation/entitlement UX | #612 | #519 flow, #521 Home rows, #523 License pane |
| Repos + Providers workflows | #522 | #519 flow, #521 Home rows |
| Flow orchestration, Welcome, dry-run stage | #519 | — |
| Shell/Home/readiness hierarchy | #521 | all |
| Visual language/tokens | #611 (→ #520 system) | all |

Sequencing: #611 merged → #613 native connect states + #612 activation states (they slot into the
CURRENT wizard, not a rewritten one) → #519/#521/#522 structural redesign consumes everything.
This kills the "redesign onboarding before the design contract exists" rework risk flagged earlier.
