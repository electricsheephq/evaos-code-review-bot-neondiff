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

func expectManifestFailure(_ message: String, data: Data) {
    do {
        _ = try DesktopEvaluationEvidenceManifest.decode(data: data)
        fputs("check failed: \(message) did not fail\n", stderr)
        exit(1)
    } catch {
        check(!error.localizedDescription.isEmpty, "\(message) returns a bounded diagnostic")
    }
}

func mutatedManifest(_ data: Data, _ mutate: (inout [String: Any]) -> Void) throws -> Data {
    guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw DesktopEvaluationFixtureError.invalidJSON
    }
    mutate(&object)
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
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
        "license": {"entitlement": "active", "credentialPresent": true, "updateChannel": "dev"},
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

let unreachableDoneFixture = try mutatedManifest(validFixture) { object in
    object["surface"] = ["section": "overview", "onboardingStep": "done"]
    var state = object["state"] as! [String: Any]
    state["provider"] = NSNull()
    object["state"] = state
}
expectFixtureFailure("unreachable onboarding done state", data: unreachableDoneFixture)

let unactivatedDoneFixture = try mutatedManifest(validFixture) { object in
    object["surface"] = ["section": "overview", "onboardingStep": "done"]
    var state = object["state"] as! [String: Any]
    state["license"] = ["entitlement": "not activated", "credentialPresent": false, "updateChannel": "dev"]
    object["state"] = state
}
expectFixtureFailure("unactivated onboarding done state", data: unactivatedDoneFixture)

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

let nonISOClockFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "2026-07-10T12:00:00Z", with: "0")
        .utf8
)
expectFixtureFailure("non-ISO fixture clock", data: nonISOClockFixture)

let offsetClockFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "2026-07-10T12:00:00Z", with: "2026-07-10T12:00:00+07:00")
        .utf8
)
expectFixtureFailure("non-canonical offset fixture clock", data: offsetClockFixture)

let invalidCalendarClockFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "2026-07-10T12:00:00Z", with: "2026-02-30T12:00:00Z")
        .utf8
)
expectFixtureFailure("invalid calendar fixture clock", data: invalidCalendarClockFixture)

let stringContentSizeFixture = try mutatedManifest(validFixture) { object in
    var environment = object["environment"] as! [String: Any]
    environment["contentSize"] = ["width": "1040", "height": "680"]
    object["environment"] = environment
}
expectFixtureFailure("string fixture content size", data: stringContentSizeFixture)

let nonStringFixtureID = try mutatedManifest(validFixture) { object in
    object["id"] = 1
}
expectFixtureFailure("non-string fixture id", data: nonStringFixtureID)

let nonStringProviderURL = try mutatedManifest(validFixture) { object in
    var state = object["state"] as! [String: Any]
    var provider = state["provider"] as! [String: Any]
    provider["baseURL"] = ["https://example.com"]
    state["provider"] = provider
    object["state"] = state
}
expectFixtureFailure("non-string provider base URL", data: nonStringProviderURL)

let hostlessProviderURL = try mutatedManifest(validFixture) { object in
    var state = object["state"] as! [String: Any]
    var provider = state["provider"] as! [String: Any]
    provider["baseURL"] = "https://"
    state["provider"] = provider
    object["state"] = state
}
expectFixtureFailure("hostless provider base URL", data: hostlessProviderURL)

let offsetRepositoryTimestamp = try mutatedManifest(validFixture) { object in
    var state = object["state"] as! [String: Any]
    var repositories = state["repositories"] as! [[String: Any]]
    repositories[0]["lastReview"] = "2026-07-10T11:55:00+07:00"
    state["repositories"] = repositories
    object["state"] = state
}
expectFixtureFailure("non-canonical repository timestamp", data: offsetRepositoryTimestamp)

let invalidCalendarRepositoryTimestamp = try mutatedManifest(validFixture) { object in
    var state = object["state"] as! [String: Any]
    var repositories = state["repositories"] as! [[String: Any]]
    repositories[0]["lastReview"] = "2026-02-30T11:55:00Z"
    state["repositories"] = repositories
    object["state"] = state
}
expectFixtureFailure("invalid calendar repository timestamp", data: invalidCalendarRepositoryTimestamp)

let unactivatedPostOnboardingFixture = try mutatedManifest(validFixture) { object in
    var state = object["state"] as! [String: Any]
    state["license"] = ["entitlement": "not activated", "credentialPresent": false, "updateChannel": "dev"]
    object["state"] = state
}
expectFixtureFailure("unactivated post-onboarding state", data: unactivatedPostOnboardingFixture)

let semanticOversizedFixture = try mutatedManifest(validFixture) { object in
    object["safeCopy"] = Array(repeating: String(repeating: "x", count: 3_000), count: 100)
}
expectFixtureFailure("semantic oversized fixture", data: semanticOversizedFixture)

var whitespacePaddedFixture = validFixture
whitespacePaddedFixture.append(Data(repeating: 0x20, count: 256 * 1_024))
expectFixtureFailure("whitespace-padded oversized fixture", data: whitespacePaddedFixture)

let unsupportedHealthFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: #""health": "healthy""#, with: #""health": "healty""#)
        .utf8
)
expectFixtureFailure("unsupported health state", data: unsupportedHealthFixture)

let unsupportedActionFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(of: "verify-provider", with: "verify-provider-typo")
        .utf8
)
expectFixtureFailure("unsupported expected action", data: unsupportedActionFixture)

let unknownContentSizeFieldFixture = Data(
    String(decoding: validFixture, as: UTF8.self)
        .replacingOccurrences(
            of: #""disableAnimations": true"#,
            with: #""disableAnimations": true, "contentSize": {"width": 1280, "height": 800, "scale": 2}"#
        )
        .utf8
)
expectFixtureFailure("unknown content-size field", data: unknownContentSizeFieldFixture)

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

let unknownEntryCatalogURL = temporaryCatalogRoot.appendingPathComponent("unknown-entry-catalog.json")
try #"{"schemaVersion":1,"entries":[{"id":"providers-verified","file":"providers-verified.json","sha256":"unexpected"}]}"#
    .write(to: unknownEntryCatalogURL, atomically: true, encoding: .utf8)
expectCatalogFailure("unknown catalog entry field", url: unknownEntryCatalogURL)

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
      "schemaVersion": 2,
      "generatedAt": "2026-07-11T00:00:00Z",
      "repository": "electricsheephq/evaos-code-review-bot-neondiff",
      "headSHA": "ddbd45066473b833fcc8984dca0716ca9ef81e6d",
      "artifact": {
        "path": "artifacts/NeonDiffDesktop.app",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "hashAlgorithm": "sha256-tree-v1",
        "buildIdentity": "NeonDiffDesktop 1.1.0 fixture candidate"
      },
      "catalogSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "fixturesSHA256": "abababababababababababababababababababababababababababababababab",
      "platform": {
        "macOSVersion": "26.4",
        "xcodeVersion": "26.0",
        "swiftVersion": "6.2.4",
        "architecture": "arm64",
        "backingScale": 2.0,
        "evidence": {"path": "validation/platform.json", "sha256": "8989898989898989898989898989898989898989898989898989898989898989"}
      },
      "testSummary": {
        "testCount": 7,
        "durationSeconds": 4.25,
        "runner": "swift-testing",
        "summary": {
          "path": "tests/test-summary.json",
          "sha256": "5656565656565656565656565656565656565656565656565656565656565656"
        },
        "result": {
          "path": "tests/swift-testing.log",
          "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        }
      },
      "cases": [
        {
          "fixtureId": "tab-overview",
          "section": "overview",
          "onboardingStep": null,
          "appearance": "dark",
          "requestedContentSize": {"width": 1040, "height": 680},
          "actualWindowFrame": {"x": 20, "y": 20, "width": 1040, "height": 680},
          "actualContentFrame": {"x": 0, "y": 0, "width": 1040, "height": 680},
          "screenshot": {"path": "tab-overview-1040x680.png", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
          "accessibility": {"path": "tab-overview-1040x680.ax.json", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
          "geometry": {"path": "tab-overview-1040x680.geometry.json", "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
          "readiness": {"path": "tab-overview-1040x680.readiness.json", "sha256": "4545454545454545454545454545454545454545454545454545454545454545"},
          "visualBaseline": {"status": "captured-no-reference"},
          "expectedState": "healthy"
        },
        {
          "fixtureId": "tab-overview",
          "section": "overview",
          "onboardingStep": null,
          "appearance": "dark",
          "requestedContentSize": {"width": 1280, "height": 800},
          "actualWindowFrame": {"x": 20, "y": 20, "width": 1280, "height": 800},
          "actualContentFrame": {"x": 0, "y": 0, "width": 1280, "height": 800},
          "screenshot": {"path": "tab-overview-1280x800.png", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
          "accessibility": {"path": "tab-overview-1280x800.ax.json", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
          "geometry": {"path": "tab-overview-1280x800.geometry.json", "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
          "readiness": {"path": "tab-overview-1280x800.readiness.json", "sha256": "6767676767676767676767676767676767676767676767676767676767676767"},
          "visualBaseline": {"status": "captured-no-reference"},
          "expectedState": "healthy"
        }
      ],
      "scans": {
        "secretScanPassed": true,
        "releaseBoundaryPassed": true,
        "secretScan": {"path": "validation/packet-safety-scan.json", "sha256": "1212121212121212121212121212121212121212121212121212121212121212"},
        "releaseBoundary": {"path": "validation/release-boundary.log", "sha256": "3434343434343434343434343434343434343434343434343434343434343434"}
      },
      "proofBoundary": "Deterministic source-build baseline only; not signed, notarized, or GA proof.",
      "unresolvedFindings": []
    }
    """#.utf8
)
let manifest = try DesktopEvaluationEvidenceManifest.decode(data: validManifest)
check(manifest.headSHA == "ddbd45066473b833fcc8984dca0716ca9ef81e6d", "manifest pins exact source SHA")
check(manifest.cases.count == 2, "manifest permits one fixture at two canonical sizes")
check(manifest.cases.last?.requestedContentSize == DesktopEvaluationContentSize(width: 1280, height: 800), "manifest pins requested case geometry")

let oversizedManifestString = try mutatedManifest(validManifest) { object in
    var platform = object["platform"] as! [String: Any]
    platform["xcodeVersion"] = String(repeating: "x", count: 5_000)
    object["platform"] = platform
}
expectManifestFailure("oversized manifest string", data: oversizedManifestString)

var whitespacePaddedManifest = validManifest
whitespacePaddedManifest.append(Data(repeating: 0x20, count: 1024 * 1_024))
expectManifestFailure("whitespace-padded oversized manifest", data: whitespacePaddedManifest)

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

let unsafeManifestPath = Data(
    String(decoding: validManifest, as: UTF8.self)
        .replacingOccurrences(of: "artifacts/NeonDiffDesktop.app", with: "/Users/example/NeonDiffDesktop.app")
        .utf8
)
do {
    _ = try DesktopEvaluationEvidenceManifest.decode(data: unsafeManifestPath)
    check(false, "manifest rejects author-machine artifact paths")
} catch {
    check(!error.localizedDescription.isEmpty, "manifest path failure is diagnostic")
}

let secretShapedFixtureValue = ["gh", "p_", "fixture", "_secret_material"].joined()
let unsafeManifestSecret = Data(
    String(decoding: validManifest, as: UTF8.self)
        .replacingOccurrences(of: "Deterministic source-build baseline only", with: secretShapedFixtureValue)
        .utf8
)
do {
    _ = try DesktopEvaluationEvidenceManifest.decode(data: unsafeManifestSecret)
    check(false, "manifest rejects secret-shaped text")
} catch {
    check(!error.localizedDescription.isEmpty, "manifest secret failure is diagnostic")
}

let failingRunManifest = Data(
    String(decoding: validManifest, as: UTF8.self)
        .replacingOccurrences(
            of: #""unresolvedFindings": []"#,
            with: #""unresolvedFindings": [{"id":"layout-drift","severity":"P0","owner":"desktop-team","recordedAt":"2026-07-11T00:00:00Z","reason":"Baseline records the blocking drift for remediation."}]"#
        )
        .utf8
)
let failingManifest = try DesktopEvaluationEvidenceManifest.decode(data: failingRunManifest)
check(failingManifest.unresolvedFindings.first?.severity == .p0, "manifest truthfully records blocking findings")
check(failingManifest.cases.first?.visualBaseline.status == .capturedNoReference, "manifest does not fabricate a comparison for a fresh baseline")

let emptyCasesManifest = try mutatedManifest(validManifest) { object in
    object["cases"] = []
}
expectManifestFailure("manifest without capture cases", data: emptyCasesManifest)

let URLArtifactManifest = try mutatedManifest(validManifest) { object in
    var artifact = object["artifact"] as! [String: Any]
    artifact["path"] = "https://example.com/NeonDiffDesktop.app"
    object["artifact"] = artifact
}
expectManifestFailure("URL-like packet path", data: URLArtifactManifest)

let emptySegmentManifest = try mutatedManifest(validManifest) { object in
    var artifact = object["artifact"] as! [String: Any]
    artifact["path"] = "artifacts//NeonDiffDesktop.app"
    object["artifact"] = artifact
}
expectManifestFailure("empty packet path segment", data: emptySegmentManifest)

let duplicateEvidencePathManifest = try mutatedManifest(validManifest) { object in
    var cases = object["cases"] as! [[String: Any]]
    cases[1]["screenshot"] = cases[0]["screenshot"]
    object["cases"] = cases
}
expectManifestFailure("reused evidence artifact path", data: duplicateEvidencePathManifest)

let lineTerminatedEvidencePathManifest = try mutatedManifest(validManifest) { object in
    var cases = object["cases"] as! [[String: Any]]
    var screenshot = cases[0]["screenshot"] as! [String: Any]
    screenshot["path"] = "tab-overview-1040x680.png\n"
    cases[0]["screenshot"] = screenshot
    object["cases"] = cases
}
expectManifestFailure("line-terminated evidence artifact path", data: lineTerminatedEvidencePathManifest)

for lineSeparator in ["\r", "\r\n", "\u{2028}", "\u{2029}"] {
    let separatedPathManifest = try mutatedManifest(validManifest) { object in
        var artifact = object["artifact"] as! [String: Any]
        artifact["path"] = "artifacts/NeonDiffDesktop.app\(lineSeparator)"
        object["artifact"] = artifact
    }
    expectManifestFailure("line-separated artifact packet path", data: separatedPathManifest)
}

let caseAliasedEvidencePathManifest = try mutatedManifest(validManifest) { object in
    var cases = object["cases"] as! [[String: Any]]
    var screenshot = cases[1]["screenshot"] as! [String: Any]
    screenshot["path"] = "TAB-OVERVIEW-1040X680.PNG"
    cases[1]["screenshot"] = screenshot
    object["cases"] = cases
}
expectManifestFailure("case-aliased evidence artifact path", data: caseAliasedEvidencePathManifest)

let directoryCaseAliasedEvidencePathManifest = try mutatedManifest(validManifest) { object in
    var cases = object["cases"] as! [[String: Any]]
    var firstScreenshot = cases[0]["screenshot"] as! [String: Any]
    firstScreenshot["path"] = "captures/tab.png"
    cases[0]["screenshot"] = firstScreenshot
    var secondGeometry = cases[1]["geometry"] as! [String: Any]
    secondGeometry["path"] = "CAPTURES/TAB.PNG"
    cases[1]["geometry"] = secondGeometry
    object["cases"] = cases
}
expectManifestFailure("directory and cross-role case-aliased evidence path", data: directoryCaseAliasedEvidencePathManifest)

print("NeonDiffDesktop fixture checks passed")
