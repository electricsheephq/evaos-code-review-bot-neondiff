# NeonDiff brand assets v1

This directory is the repository source of truth for the owner-approved
2026-07-26 NeonDiff logo and macOS monogram system. It does not establish an
installed-app, signed distribution, beta, or release claim.

## Provenance

- Product spelling: `NeonDiff`; wordmark spelling: `NEONDIFF`.
- Visual source: the live NeonDiff website identity and the owner-approved
  `2026-07-26-logo-system-v1` and `2026-07-26-macos-monogram-v1` handoffs.
- Wordmark/monogram glyph shape: SAIBA-45. The committed SVGs contain outlined
  paths only; no SAIBA font file is redistributed.
- Technical UI typography remains JetBrains Mono under the OFL where used. No
  font binary is required by these logo or icon assets.

## Runtime use

- `wordmark/` contains the canonical light/dark transparent exports.
- `app-icon/light` and `app-icon/dark` contain the approved 1024-point masters
  and legacy iconsets.
- The packaged resources include separate `NeonDiff-Light.icns` and
  `NeonDiff-Dark.icns` files so both owner-approved renditions travel with the
  native app source. `NeonDiff.icns` remains the default bundle icon for the
  macOS 14-compatible custom bundle path.
- Icon Composer is intentionally not required for this bounded intake: first
  launch presents a separate Apple license agreement. Adaptive installed-icon
  behavior is not claimed until it is implemented and proved separately.
- `app-icon/NeonDiff.icns` is the macOS 14-compatible fallback used by the
  custom SwiftPM bundle script.
- The packaged `Resources/NeonDiffWordmark.png` is a deliberate runtime copy of
  the approved light wordmark and is rendered as a template by SwiftUI.

## Canonical checksums

| Asset | SHA-256 |
| --- | --- |
| Light wordmark 1x | `f4688800de72ff98b2a2e490d8f765301b2afa07113dceb628aa1624494ee6e9` |
| Light wordmark 2x | `13d83b5575c88b81635bc324cf3363be643716f72e172c9916bcb21f87883a59` |
| Dark wordmark 1x | `d1fc5eb34fdbe2967e866d22c0e62b48002be1ccdcf490c864a3c8ec0b49ff70` |
| Dark wordmark 2x | `65a3912771d104b1959aff75c9653956dea2bb5adf0684dbd722bea022d5005b` |
| Light app-icon master | `c73cfbe13482080b86e637cbe483ba59069a11ea1add57de9cea7d608e88e3eb` |
| Dark app-icon master | `bbf80d563232f94ea7f1a9535a24fbdc9cb498b38864038497e3ab161f7acc27` |
| Legacy fallback ICNS | `d9e4c99511665fdc9c66cb37767fe5d9dbacff25c7b84a2e73a90929b42e9ff4` |
| Dark ICNS | `b608fe13e8460d0fe674855666ea3d6c0e26d7d010a334d2502ea199166a9ae5` |

Run `./verify-assets.sh` from this directory for public-safe dimension,
checksum, iconset, and font-exclusion checks.
