import Foundation

public enum AppcastChannel: String, Codable, CaseIterable, Hashable {
    case beta
    case stable
}

public enum AppcastSignatureState: String, Codable, Hashable {
    case absent
    case present
    case invalidFixture
}

public enum AppcastUpdateStatus: String, Codable, CaseIterable, Hashable {
    case noUpdate = "no_update"
    case updateAvailable = "update_available"
    case blockedByLicense = "blocked_by_license"
    case networkError = "network_error"
    case signatureError = "signature_error"
    case feedInvalid = "feed_invalid"
    case unsupportedChannel = "unsupported_channel"
}

public struct AppcastRelease: Codable, Equatable, Hashable {
    public var version: String
    public var build: String
    public var title: String
    public var pubDate: String
    public var artifactURL: String
    public var artifactLength: Int
    public var minimumSystemVersion: String
    public var channel: AppcastChannel
    public var edSignature: String?
    public var signatureState: AppcastSignatureState
    public var rollbackTo: String?

    private enum CodingKeys: String, CodingKey {
        case version
        case build
        case title
        case pubDate = "pub_date"
        case artifactURL = "artifact_url"
        case artifactLength = "artifact_length"
        case minimumSystemVersion = "minimum_system_version"
        case channel
        case edSignature = "ed_signature"
        case signatureState = "signature_state"
        case rollbackTo = "rollback_to"
    }

    public init(
        version: String,
        build: String,
        title: String,
        pubDate: String,
        artifactURL: String,
        artifactLength: Int,
        minimumSystemVersion: String,
        channel: AppcastChannel,
        edSignature: String? = nil,
        signatureState: AppcastSignatureState = .absent,
        rollbackTo: String? = nil
    ) {
        self.version = version
        self.build = build
        self.title = title
        self.pubDate = pubDate
        self.artifactURL = artifactURL
        self.artifactLength = artifactLength
        self.minimumSystemVersion = minimumSystemVersion
        self.channel = channel
        self.edSignature = edSignature
        self.signatureState = signatureState
        self.rollbackTo = rollbackTo
    }
}

public struct AppcastManifest: Codable, Equatable {
    public var channel: AppcastChannel
    public var title: String
    public var feedURL: String
    public var expectedStatus: AppcastUpdateStatus?
    public var releases: [AppcastRelease]

    private enum CodingKeys: String, CodingKey {
        case channel
        case title
        case feedURL = "feed_url"
        case expectedStatus = "expected_status"
        case releases
    }

    public init(
        channel: AppcastChannel,
        title: String,
        feedURL: String,
        expectedStatus: AppcastUpdateStatus? = nil,
        releases: [AppcastRelease]
    ) {
        self.channel = channel
        self.title = title
        self.feedURL = feedURL
        self.expectedStatus = expectedStatus
        self.releases = releases
    }

    public static func load(from url: URL) throws -> AppcastManifest {
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        return try decoder.decode(AppcastManifest.self, from: data)
    }

    public func latestRelease() -> AppcastRelease? {
        let channelReleases = releases.filter { $0.channel == channel }
        if let pinned = rollbackPinnedRelease(in: channelReleases) {
            return pinned
        }
        return channelReleases.sorted(by: compareVersionsDescending).first
    }

    public func releasesForAppcast() -> [AppcastRelease] {
        let channelReleases = releases.filter { $0.channel == channel }
        if let pinned = rollbackPinnedRelease(in: channelReleases) {
            return channelReleases
                .filter { release in
                    release.rollbackTo == nil && !compareVersionsDescending(release, pinned)
                }
                .sorted(by: compareVersionsDescending)
        }
        guard let latest = latestRelease() else { return [] }
        let remaining = channelReleases.filter { $0 != latest }.sorted(by: compareVersionsDescending)
        return [latest] + remaining
    }

    public func dryRunStatus(
        currentBuild: String,
        allowedChannels: Set<AppcastChannel> = Set(AppcastChannel.allCases),
        licenseAllowsPrivateArtifacts: Bool = true,
        networkAvailable: Bool = true
    ) -> AppcastUpdateStatus {
        guard networkAvailable else { return .networkError }
        guard !releases.isEmpty else { return .feedInvalid }
        guard allowedChannels.contains(channel) else { return .unsupportedChannel }
        guard let latest = latestRelease() else { return .feedInvalid }
        if !licenseAllowsPrivateArtifacts && latest.artifactURL.contains("/private/") {
            return .blockedByLicense
        }
        if latest.signatureState == .invalidFixture {
            return .signatureError
        }
        return compareBuilds(latest.build, currentBuild) == .orderedDescending ? .updateAvailable : .noUpdate
    }
}

private struct ParsedAppcastVersion {
    var core: [Int]
    var prerelease: [String]?
}

private func rollbackPinnedRelease(in releases: [AppcastRelease]) -> AppcastRelease? {
    let rollbackSources = releases
        .filter { $0.rollbackTo != nil }
        .sorted(by: compareVersionsDescending)
    guard let rollbackTarget = rollbackSources.first?.rollbackTo else { return nil }
    return releases.first(where: { $0.version == rollbackTarget })
}

private func compareVersionsDescending(_ lhs: AppcastRelease, _ rhs: AppcastRelease) -> Bool {
    let versionComparison = compareVersions(lhs.version, rhs.version)
    if versionComparison != .orderedSame {
        return versionComparison == .orderedDescending
    }
    return compareBuilds(lhs.build, rhs.build) == .orderedDescending
}

private func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
    let left = parseVersion(lhs)
    let right = parseVersion(rhs)
    for index in 0..<max(left.core.count, right.core.count) {
        let leftPart = index < left.core.count ? left.core[index] : 0
        let rightPart = index < right.core.count ? right.core[index] : 0
        if leftPart == rightPart { continue }
        return leftPart > rightPart ? .orderedDescending : .orderedAscending
    }
    switch (left.prerelease, right.prerelease) {
    case (nil, nil):
        return .orderedSame
    case (nil, _?):
        return .orderedDescending
    case (_?, nil):
        return .orderedAscending
    case let (leftIdentifiers?, rightIdentifiers?):
        return comparePrerelease(leftIdentifiers, rightIdentifiers)
    }
}

private func parseVersion(_ value: String) -> ParsedAppcastVersion {
    let version = value.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    let parts = version.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    let core = parts.first?
        .split(separator: ".")
        .map { Int($0) ?? 0 } ?? []
    let prerelease = parts.count > 1
        ? parts[1].split(separator: ".").map(String.init)
        : nil
    return ParsedAppcastVersion(core: core, prerelease: prerelease)
}

private func comparePrerelease(_ lhs: [String], _ rhs: [String]) -> ComparisonResult {
    for index in 0..<max(lhs.count, rhs.count) {
        guard index < lhs.count else { return .orderedAscending }
        guard index < rhs.count else { return .orderedDescending }
        let leftIdentifier = lhs[index]
        let rightIdentifier = rhs[index]
        if leftIdentifier == rightIdentifier { continue }
        let leftNumeric = Int(leftIdentifier)
        let rightNumeric = Int(rightIdentifier)
        switch (leftNumeric, rightNumeric) {
        case let (left?, right?):
            return left > right ? .orderedDescending : .orderedAscending
        case (_?, nil):
            return .orderedAscending
        case (nil, _?):
            return .orderedDescending
        case (nil, nil):
            return leftIdentifier > rightIdentifier ? .orderedDescending : .orderedAscending
        }
    }
    return .orderedSame
}

private func compareBuilds(_ lhs: String, _ rhs: String) -> ComparisonResult {
    if let left = Int(lhs), let right = Int(rhs) {
        if left == right { return .orderedSame }
        return left > right ? .orderedDescending : .orderedAscending
    }
    return lhs.compare(rhs, options: [.numeric])
}
