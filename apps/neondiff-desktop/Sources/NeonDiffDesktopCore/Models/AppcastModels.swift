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
        if let rollbackTarget = channelReleases.compactMap(\.rollbackTo).last,
           let pinned = channelReleases.first(where: { $0.version == rollbackTarget }) {
            return pinned
        }
        return channelReleases.sorted(by: compareVersionsDescending).first
    }

    public func releasesForAppcast() -> [AppcastRelease] {
        let channelReleases = releases.filter { $0.channel == channel }
        if let rollbackTarget = channelReleases.compactMap(\.rollbackTo).last,
           let pinned = channelReleases.first(where: { $0.version == rollbackTarget }) {
            return channelReleases
                .filter { release in
                    release.rollbackTo == nil && !compareVersionsDescending(release, pinned)
                }
                .sorted(by: compareVersionsDescending)
        }
        guard let latest = latestRelease() else { return [] }
        let remaining = releases.filter { $0 != latest }.sorted(by: compareVersionsDescending)
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

private func compareVersionsDescending(_ lhs: AppcastRelease, _ rhs: AppcastRelease) -> Bool {
    let lhsParts = versionParts(lhs.version)
    let rhsParts = versionParts(rhs.version)
    for index in 0..<max(lhsParts.count, rhsParts.count) {
        let left = index < lhsParts.count ? lhsParts[index] : 0
        let right = index < rhsParts.count ? rhsParts[index] : 0
        if left != right { return left > right }
    }
    return compareBuilds(lhs.build, rhs.build) == .orderedDescending
}

private func versionParts(_ value: String) -> [Int] {
    value
        .split { !$0.isNumber }
        .map { Int($0) ?? 0 }
}

private func compareBuilds(_ lhs: String, _ rhs: String) -> ComparisonResult {
    if let left = Int(lhs), let right = Int(rhs) {
        if left == right { return .orderedSame }
        return left > right ? .orderedDescending : .orderedAscending
    }
    return lhs.compare(rhs, options: [.numeric])
}
