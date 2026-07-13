# NeonDiff Desktop Evaluation Capture Foundation

Related issue: #515

## Goal

Make the existing public-safe fixture contract executable in a DEBUG app and
produce repeatable native screenshot, accessibility, and geometry evidence from
one exact SwiftPM-built artifact. This is the capture foundation; the full
state-matrix expansion remains a following #515 slice.

## Implementation

1. Add fail-closed launch-context loading for absolute regular fixture files.
2. Add a DEBUG-only executable adapter and deterministic in-memory dependencies;
   malformed evaluation arguments must never fall through to live adapters.
3. Add a DEBUG-only AppCore state seam for model invariants, exact content-size,
   locale, appearance, animation, and readiness/geometry emission.
4. Add a CLT-compatible capture sidecar using exact PID/window identity,
   Accessibility APIs, and `/usr/sbin/screencapture`.
5. Evolve the evidence manifest to hash the typed exact-head summary separately
   from its Swift Testing log result, and define the app-bundle tree-hash
   algorithm without pretending a `.xcresult` exists.
6. Build one exact debug bundle and capture the nominal catalog at 1040x680 and
   1280x800 into dated external evidence.

## Gates

- Swift evaluation/AppCore/Core tests and fixture checks.
- Focused TypeScript boundary tests, build, actionlint, secret scan.
- Release executable, AppCore object/module, and release bundle remain free of
  evaluation hooks and fixture data.
- Capture preflights must pass without prompting; every case needs one PNG, AX
  JSON, geometry JSON, and stable hashes.

## Proof Boundary

This slice proves deterministic nominal native capture from an exact debug
artifact. It does not prove the full #515 async/error/overflow matrix, full
Xcode/XCUITest, signed/notarized distribution, Sparkle/appcast, browser/native
parity, GA readiness, or v1.1 completion.
