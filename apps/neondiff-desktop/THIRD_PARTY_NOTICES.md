# Third-Party Notices

## Sparkle

- Project: Sparkle
- Upstream: https://github.com/sparkle-project/Sparkle
- Package requirement: `from: "2.9.0"`
- Bundled notice: `Sources/NeonDiffDesktop/Resources/Legal/SPARKLE-LICENSE.txt`
- License: MIT-style Sparkle license plus bundled external dependency notices.

NeonDiff Desktop links Sparkle only for the dormant update-scaffold target. Real
update feeds, signing keys, and release-channel activation remain out of scope
for this development MVP.

This target does not bundle the SAIBA-45 font or other GPL font assets. The
custom chrome uses native system monospaced fonts for the NeonDiff wordmark,
headings, badges, and operator text.
