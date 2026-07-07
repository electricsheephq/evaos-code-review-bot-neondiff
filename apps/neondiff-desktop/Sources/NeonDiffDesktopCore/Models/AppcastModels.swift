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
    public var releases: [AppcastRelease]

    private enum CodingKeys: String, CodingKey {
        case channel
        case title
        case feedURL = "feed_url"
        case releases
    }

    public init(channel: AppcastChannel, title: String, feedURL: String, releases: [AppcastRelease]) {
        self.channel = channel
        self.title = title
        self.feedURL = feedURL
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
        guard let latest = latestRelease() else { return [] }
        let remaining = releases.filter { $0 != latest }.sorted(by: compareVersionsDescending)
        return [latest] + remaining
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
    return lhs.build > rhs.build
}

private func versionParts(_ value: String) -> [Int] {
    value
        .split { !$0.isNumber }
        .map { Int($0) ?? 0 }
}
