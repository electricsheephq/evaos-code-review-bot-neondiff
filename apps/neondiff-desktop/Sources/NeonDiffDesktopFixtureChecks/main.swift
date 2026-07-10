import Foundation
import NeonDiffDesktopCore
import NeonDiffDesktopEvaluationSupport

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    guard condition() else {
        fputs("check failed: \(message)\n", stderr)
        exit(1)
    }
    return true
}

func expectFixtureFailure(_ message: String, data: Data) {
    do {
        _ = try DesktopEvaluationFixture.decode(data: data)
        fputs("check failed: \(message) did not fail\n", stderr)
        exit(1)
    } catch {
        check(!error.localizedDescription.isEmpty, "\(message) returns a bounded diagnostic")
    }
}

func expectLaunchFailure(_ message: String, arguments: [String]) {
    do {
        _ = try DesktopEvaluationLaunchOptions.parse(arguments: arguments)
        fputs("check failed: \(message) did not fail\n", stderr)
        exit(1)
    } catch {
        check(!error.localizedDescription.isEmpty, "\(message) returns a bounded diagnostic")
    }
}

func expectCatalogFailure(_ message: String, url: URL) {
    do {
        _ = try DesktopEvaluationFixtureCatalog.load(from: url)
        fputs("check failed: \(message) did not fail\n", stderr)
        exit(1)
    } catch {
        check(!error.localizedDescription.isEmpty, "\(message) returns a bounded diagnostic")
    }
}

let validFixture = Data(
    #"""
    {
      "schemaVersion": 1,
      "id": "providers-verified",
      "surface": {"section": "providers", "onboardingStep": null},
      "environment": {
        "clock": "2026-07-10T12:00:00Z",
        "locale": "en_US_POSIX",
        "appearance": "dark",
        "disableAnimations": true
      },
      "state": {
        "health": "healthy",
        "runtimeReady": true,
        "repositories": [
          {"name": "electric-sheep/example-public", "enabled": true, "profile": "default", "lastReview": "2026-07-10T11:55:00Z"}
        ],
        "provider": {
          "id": "zcode-glm",
          "displayName": "Z.AI GLM",
          "adapter": "openai-compatible",
          "authMode": "api-key-env",
          "baseURL": "https://api.z.ai/api/coding/paas/v4",
          "model": "glm-5",
          "credentialPresent": true,
          "verification": "healthy"
        },
        "license": {"entitlement": "public repositories", "credentialPresent": false, "updateChannel": "dev"},
        "github": {"connection": "connected", "login": "fixture-user", "repositoryCount": 1},
        "logText": "Fixture log: no live process was contacted."
      },
      "scriptedOutcomes": [],
      "expectedActions": ["verify-provider"],
      "safeCopy": ["Provider verified from deterministic fixture metadata."]
    }
    """#.utf8
)

let fixture = try DesktopEvaluationFixture.decode(data: validFixture)
check(fixture.schemaVersion == 1, "fixture schema version is explicit")
check(fixture.id == "providers-verified", "fixture id decodes")
check(fixture.surface.section == .providers, "fixture selects Providers")
check(fixture.environment.contentSize == nil, "content size remains a launch concern")
check(fixture.state.provider?.credentialPresent == true, "fixture stores presence metadata only")

let safeHyphenatedCopy = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "Provider verified from deterministic fixture metadata.", with: "Risk-aware fixture copy remains public-safe.")
        .utf8
)
_ = try DesktopEvaluationFixture.decode(data: safeHyphenatedCopy)

let unknownFieldFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: #""schemaVersion": 1,"#, with: #""schemaVersion": 1, "surprise": true,"#)
        .utf8
)
expectFixtureFailure("unknown fixture field", data: unknownFieldFixture)

let unknownNestedFieldFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: #""health": "healthy","#, with: #""unexpected": true, "health": "healthy","#)
        .utf8
)
expectFixtureFailure("unknown nested fixture field", data: unknownNestedFieldFixture)

let unsupportedFixtureVersion = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: #""schemaVersion": 1"#, with: #""schemaVersion": 2"#)
        .utf8
)
expectFixtureFailure("unsupported fixture schema", data: unsupportedFixtureVersion)

let secretFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "Fixture log: no live process was contacted.", with: "sk-fixture-secret-must-never-load")
        .utf8
)
expectFixtureFailure("secret-shaped fixture value", data: secretFixture)

let authorPathFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "Fixture log: no live process was contacted.", with: "/Users/example/private/config.local.json")
        .utf8
)
expectFixtureFailure("author-machine fixture path", data: authorPathFixture)

let unsafeIdentifierFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "providers-verified", with: "Providers / Verified")
        .utf8
)
expectFixtureFailure("unsafe fixture identifier", data: unsafeIdentifierFixture)

let normalLaunchOptions = try DesktopEvaluationLaunchOptions.parse(arguments: ["NeonDiffDesktop"])
check(normalLaunchOptions == nil, "normal launch has no evaluation options")
expectLaunchFailure(
    "incomplete UI-testing launch",
    arguments: ["NeonDiffDesktop", "--ui-testing", "--disable-animations"]
)
expectLaunchFailure(
    "relative UI fixture path",
    arguments: [
        "NeonDiffDesktop", "--ui-testing", "--ui-fixture", "fixtures/providers.json",
        "--content-size", "1280x800", "--disable-animations"
    ]
)
expectLaunchFailure(
    "non-canonical content size",
    arguments: [
        "NeonDiffDesktop", "--ui-testing", "--ui-fixture", "/tmp/providers.json",
        "--content-size", "999x777", "--disable-animations"
    ]
)

let launchOptions = try DesktopEvaluationLaunchOptions.parse(arguments: [
    "NeonDiffDesktop", "--ui-testing", "--ui-fixture", "/tmp/providers.json",
    "--content-size", "1280x800", "--disable-animations"
])
check(launchOptions?.fixtureURL.path == "/tmp/providers.json", "launch parser requires an absolute fixture path")
check(launchOptions?.contentSize == DesktopEvaluationContentSize(width: 1280, height: 800), "launch parser records canonical content size")
check(launchOptions?.disableAnimations == true, "launch parser requires disabled animations")

let canonicalSizes = Set(DesktopEvaluationContentSize.canonical.map { "\($0.width)x\($0.height)" })
check(canonicalSizes == ["1040x680", "1280x800", "1440x900", "760x560", "560x700"], "canonical geometry matrix is complete")

let packageRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
let catalogURL = packageRoot.appendingPathComponent("fixtures/ui/catalog.json")
let catalog = try DesktopEvaluationFixtureCatalog.load(from: catalogURL)
check(catalog.entries.count == 12, "catalog covers seven tabs and five onboarding steps")
check(Set(catalog.fixtures.map(\.surface.section)) == Set(DesktopSection.allCases), "catalog covers every desktop tab")
check(
    Set(catalog.fixtures.compactMap(\.surface.onboardingStep)) == Set(OnboardingStep.allCases),
    "catalog covers every onboarding step"
)
check(Set(catalog.fixtures.map(\.id)).count == catalog.fixtures.count, "catalog fixture ids are unique")

let temporaryCatalogRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("neondiff-evaluation-catalog-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: temporaryCatalogRoot, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporaryCatalogRoot) }
let temporaryFixtureURL = temporaryCatalogRoot.appendingPathComponent("providers-verified.json")
try validFixture.write(to: temporaryFixtureURL)
let duplicateCatalogURL = temporaryCatalogRoot.appendingPathComponent("duplicate-catalog.json")
try #"{"schemaVersion":1,"entries":[{"id":"providers-verified","file":"providers-verified.json"},{"id":"providers-verified","file":"providers-verified.json"}]}"#
    .write(to: duplicateCatalogURL, atomically: true, encoding: .utf8)
expectCatalogFailure("duplicate catalog entry", url: duplicateCatalogURL)

let symlinkCatalogRoot = temporaryCatalogRoot.appendingPathComponent("symlink", isDirectory: true)
try FileManager.default.createDirectory(at: symlinkCatalogRoot, withIntermediateDirectories: true)
let symlinkFixtureURL = symlinkCatalogRoot.appendingPathComponent("providers-verified.json")
try FileManager.default.createSymbolicLink(at: symlinkFixtureURL, withDestinationURL: temporaryFixtureURL)
let symlinkCatalogURL = symlinkCatalogRoot.appendingPathComponent("catalog.json")
try #"{"schemaVersion":1,"entries":[{"id":"providers-verified","file":"providers-verified.json"}]}"#
    .write(to: symlinkCatalogURL, atomically: true, encoding: .utf8)
expectCatalogFailure("symlinked catalog fixture", url: symlinkCatalogURL)

let validManifest = Data(
    #"""
    {
      "schemaVersion": 1,
      "generatedAt": "2026-07-11T00:00:00Z",
      "repository": "electricsheephq/evaos-code-review-bot-neondiff",
      "headSHA": "ddbd45066473b833fcc8984dca0716ca9ef81e6d",
      "artifact": {
        "path": "/Applications/NeonDiffDesktop.app",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "buildIdentity": "NeonDiffDesktop 1.1.0 fixture candidate"
      },
      "catalogSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cases": [
        {
          "fixtureId": "tab-overview",
          "section": "overview",
          "onboardingStep": null,
          "contentSize": {"width": 1280, "height": 800},
          "screenshot": {"path": "tab-overview.png", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
          "accessibility": {"path": "tab-overview.ax.json", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
          "geometry": {"path": "tab-overview.geometry.json", "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
          "expectedState": "healthy"
        }
      ],
      "scans": {"secretScanPassed": true, "releaseBoundaryPassed": true},
      "proofBoundary": "Deterministic source-build baseline only; not signed, notarized, or GA proof."
    }
    """#.utf8
)
let manifest = try DesktopEvaluationEvidenceManifest.decode(data: validManifest)
check(manifest.headSHA == "ddbd45066473b833fcc8984dca0716ca9ef81e6d", "manifest pins exact source SHA")
check(manifest.cases.first?.contentSize == DesktopEvaluationContentSize(width: 1280, height: 800), "manifest pins case geometry")

let invalidManifestHash = Data(
    String(decoding: validManifest, as: UTF8.self)
        .replacingOccurrences(of: String(repeating: "a", count: 64), with: "not-a-hash")
        .utf8
)
do {
    _ = try DesktopEvaluationEvidenceManifest.decode(data: invalidManifestHash)
    check(false, "manifest rejects malformed artifact hashes")
} catch {
    check(!error.localizedDescription.isEmpty, "manifest hash failure is diagnostic")
}

print("NeonDiffDesktop fixture checks passed")
