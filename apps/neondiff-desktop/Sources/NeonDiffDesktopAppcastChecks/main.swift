import Foundation
import NeonDiffDesktopCore

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    if condition() {
        return true
    }
    fputs("check failed: \(message)\n", stderr)
    exit(1)
}

let fixtures = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("fixtures/appcast")

let stable = try AppcastManifest.load(from: fixtures.appendingPathComponent("stable.json"))
check(stable.channel == .stable, "stable fixture channel")
check(stable.latestRelease()?.version == "1.0.0", "stable latest release")
check(stable.expectedStatus == .updateAvailable, "stable expected status metadata")
let stableXML = try AppcastSerializer.serialize(stable)
check(stableXML.contains("xmlns:sparkle=\"http://www.andymatuschak.org/xml-namespaces/sparkle\""), "sparkle namespace")
check(stableXML.contains("sparkle:shortVersionString=\"1.0.0\""), "stable short version")

let beta = try AppcastManifest.load(from: fixtures.appendingPathComponent("beta.json"))
check(beta.channel == .beta, "beta fixture channel")
check(beta.expectedStatus == .updateAvailable, "beta expected status metadata")
let betaXML = try AppcastSerializer.serialize(beta)
check(betaXML.contains("<sparkle:channel>beta</sparkle:channel>"), "beta channel tag")
check(!betaXML.contains("sparkle:edSignature=\"\""), "dry-run does not emit empty signatures")

let rollback = try AppcastManifest.load(from: fixtures.appendingPathComponent("rollback.json"))
check(rollback.latestRelease()?.version == "1.0.0", "rollback pins prior stable")
let rollbackXML = try AppcastSerializer.serialize(rollback)
check(!rollbackXML.contains("NeonDiffDesktop-1.1.0.zip"), "rollback appcast excludes superseded build")

let signatureFailure = try AppcastManifest.load(from: fixtures.appendingPathComponent("signature-failure.json"))
check(signatureFailure.releases.contains { $0.signatureState == .invalidFixture }, "signature failure fixture is marked invalid")

for fixtureName in ["beta", "stable", "rollback", "signature-failure", "stale-version", "license-blocked"] {
    let manifest = try AppcastManifest.load(from: fixtures.appendingPathComponent("\(fixtureName).json"))
    let xml = try AppcastSerializer.serialize(manifest)
    check(xml.contains("<rss"), "\(fixtureName) serializes to rss")
    check(xml.contains("<enclosure"), "\(fixtureName) serializes enclosure")
}

for fixtureName in ["beta", "stable", "rollback", "signature-failure"] {
    let manifest = try AppcastManifest.load(from: fixtures.appendingPathComponent("\(fixtureName).json"))
    let actualXML = try AppcastSerializer.serialize(manifest).trimmingCharacters(in: .whitespacesAndNewlines)
    let expectedURL = fixtures.appendingPathComponent("expected/\(fixtureName).xml")
    let expectedXML = try String(contentsOf: expectedURL, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    check(actualXML == expectedXML, "\(fixtureName) matches committed appcast XML fixture")
}

let stale = try AppcastManifest.load(from: fixtures.appendingPathComponent("stale-version.json"))
let licenseBlocked = try AppcastManifest.load(from: fixtures.appendingPathComponent("license-blocked.json"))
let emptyFeed = AppcastManifest(
    channel: .stable,
    title: "Empty feed fixture",
    feedURL: "https://updates.neondiff.com/stable/appcast.xml",
    releases: []
)
check(AppcastUpdateStatus.allCases.map(\.rawValue).contains("signature_error"), "status taxonomy includes signature_error")
check(beta.dryRunStatus(currentBuild: "100") == .updateAvailable, "beta fixture status is update_available")
check(stable.dryRunStatus(currentBuild: "90") == .updateAvailable, "stable fixture status is update_available")
check(rollback.dryRunStatus(currentBuild: "90") == .updateAvailable, "rollback fixture status is update_available")
check(signatureFailure.dryRunStatus(currentBuild: "90") == .signatureError, "signature fixture status is signature_error")
check(stale.dryRunStatus(currentBuild: "100") == .noUpdate, "stale fixture status is no_update")
check(licenseBlocked.dryRunStatus(currentBuild: "90", licenseAllowsPrivateArtifacts: false) == .blockedByLicense, "license fixture status is blocked_by_license")
check(stable.dryRunStatus(currentBuild: "90", networkAvailable: false) == .networkError, "network outage status is network_error")
check(stable.dryRunStatus(currentBuild: "90", allowedChannels: [.beta]) == .unsupportedChannel, "channel filter status is unsupported_channel")
check(emptyFeed.dryRunStatus(currentBuild: "90") == .feedInvalid, "empty feed status is feed_invalid")

let mixedChannel = AppcastManifest(
    channel: .stable,
    title: "Mixed channel fixture",
    feedURL: "https://updates.neondiff.com/stable/appcast.xml",
    releases: [
        AppcastRelease(
            version: "1.0.0",
            build: "100",
            title: "Stable",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/stable/NeonDiffDesktop-1.0.0.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .stable
        ),
        AppcastRelease(
            version: "1.1.0-beta.1",
            build: "1101",
            title: "Beta",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/beta/NeonDiffDesktop-1.1.0-beta.1.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .beta
        )
    ]
)
let mixedChannelXML = try AppcastSerializer.serialize(mixedChannel)
check(!mixedChannelXML.contains("1.1.0-beta.1.zip"), "stable appcast excludes beta-channel release")

let finalBeatsPrerelease = AppcastManifest(
    channel: .stable,
    title: "Prerelease ordering fixture",
    feedURL: "https://updates.neondiff.com/stable/appcast.xml",
    releases: [
        AppcastRelease(
            version: "1.1.0-beta.1",
            build: "1101",
            title: "Beta",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/stable/NeonDiffDesktop-1.1.0-beta.1.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .stable
        ),
        AppcastRelease(
            version: "1.1.0",
            build: "1100",
            title: "Final",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/stable/NeonDiffDesktop-1.1.0.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .stable
        )
    ]
)
check(finalBeatsPrerelease.latestRelease()?.version == "1.1.0", "final release outranks matching prerelease")

let numericBuild = AppcastManifest(
    channel: .stable,
    title: "Build ordering fixture",
    feedURL: "https://updates.neondiff.com/stable/appcast.xml",
    releases: [
        AppcastRelease(
            version: "1.0.1",
            build: "9",
            title: "Build 9",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/stable/NeonDiffDesktop-1.0.1-9.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .stable
        ),
        AppcastRelease(
            version: "1.0.1",
            build: "10",
            title: "Build 10",
            pubDate: "Tue, 07 Jul 2026 00:00:00 +0000",
            artifactURL: "https://updates.neondiff.com/stable/NeonDiffDesktop-1.0.1-10.zip",
            artifactLength: 123,
            minimumSystemVersion: "14.0",
            channel: .stable
        )
    ]
)
check(numericBuild.latestRelease()?.build == "10", "numeric build ordering")

let dryRun = AppcastDryRun(fixture: fixtures.appendingPathComponent("beta.json"), output: nil)
let output = try dryRun.run()
check(output.contains("<rss"), "dry-run emits rss")
check(!output.contains("NEONDIFF_SPARKLE_PRIVATE_KEY"), "dry-run does not mention private key material")

print("NeonDiffDesktopAppcastChecks passed")
