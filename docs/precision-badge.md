# Precision Badge

The precision badge is NeonDiff's public proof object for calibration without
overclaiming. It can be published while the system is still learning, but it
must stay gray and say `calibrating (n=...)` until the existing
public-confidence gate passes and a human flips public display mode.

## Public States

| State | Badge message | Public meaning |
| --- | --- | --- |
| Calibrating | `calibrating (n=<validated findings>)` | NeonDiff is collecting and aggregating outcome labels. No public precision percentage has been earned yet. |
| Calibrated | `<precision>% (n=<validated findings>)` | The aggregate passed the public-confidence gate and a human set `confidenceCalibration.publicDisplay.mode` to `"calibrated"`. |

The calibrating state is the default, public-safe state. It is intentionally a
gray badge: useful enough to show that NeonDiff measures itself, but conservative
enough not to imply calibrated accuracy.

The `n` denominator counts validated findings only. It excludes explicit-control
and unvalidated outcome labels so the public badge denominator matches the
calibration aggregate used for the precision gate.

When calibrated display is enabled, the percentage is the strongest calibrated
confidence-bin Wilson lower bound used by the public-confidence gate, floored to
a whole percent for display. It is not an all-findings precision claim. The `n`
value remains the total validated finding count behind the aggregate packet.

## Public Percentage Gate

No public percentage may appear in `docs/badges/precision.json` unless all of
these are true:

- `neondiff calibration-aggregate` produced a current aggregate.
- The aggregate passes the public-confidence floors in
  [calibration-loop.md](calibration-loop.md): at least 100 labeled findings, 30
  P0/P1 labels, 10 explicit negative-control scenarios, and the strongest
  calibrated confidence-bin Wilson lower bound of at least 0.95.
- A human reviewed the evidence and set
  `confidenceCalibration.publicDisplay.mode` to `"calibrated"`.
- Config validation accepts the same evidence at load time.

If any condition is missing, stale, malformed, or below threshold, the badge
falls back to gray `calibrating (n=...)`. The tool must not expose raw confidence
values, model self-ratings, or a best-case estimate as a public precision claim.

The checked-in `docs/badges/precision.json` starts as a below-gate placeholder
with `n=0`. After main has a real aggregate packet available, regenerate and
commit the file from the outcome-label store rather than hand-editing the count.

## Generate The Endpoint JSON

Regenerate the badge after each aggregate run:

```bash
mkdir -p docs/badges
neondiff badge \
  --config config.local.json \
  --output docs/badges/precision.json
```

The generated file is a Shields endpoint payload. The below-gate shape is:

```json
{
  "schemaVersion": 1,
  "label": "NeonDiff precision",
  "message": "calibrating (n=42)",
  "color": "lightgrey"
}
```

When the gate and human flip both pass, the tool may emit a percentage in the
same endpoint shape. Do not hand-edit the JSON to add or raise a percentage.
Regenerate it from the aggregate so the badge remains tied to evidence.

## README Badge Snippet

Use the generated JSON through Shields' endpoint badge:

```md
[![NeonDiff precision](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Felectricsheephq%2Fevaos-code-review-bot-neondiff%2Fmain%2Fdocs%2Fbadges%2Fprecision.json)](docs/precision-badge.md)
```

If a fork, prerelease branch, or docs site publishes the JSON from another raw
URL, keep the same `docs/badges/precision.json` path and change only the encoded
endpoint URL.

## Self-Attestation Contract

The badge is self-attested: it reports NeonDiff's own measured aggregate, not a
vendor benchmark or a claim of parity with another reviewer.

The generator is un-inflatable by tool design:

- no flag accepts a public precision percentage;
- no flag flips `confidenceCalibration.publicDisplay.mode`;
- below-gate or uncalibrated input always renders gray;
- the public file contains only badge display fields, not raw labels, secrets,
  or review text.

This does not make arbitrary hand edits impossible. The review rule is simple:
percentage changes to `docs/badges/precision.json` are valid only when they come
from regenerating the file after a passing aggregate and the human calibrated
mode flip.
