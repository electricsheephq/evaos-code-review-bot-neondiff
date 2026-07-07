import Foundation

public enum AppcastSerializer {
    public static func serialize(_ manifest: AppcastManifest) throws -> String {
        let items = manifest.releasesForAppcast().map(serializeItem).joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
          <channel>
            <title>\(xmlText(manifest.title))</title>
            <link>\(xmlText(manifest.feedURL))</link>
            <description>NeonDiff Desktop \(xmlText(manifest.channel.rawValue)) appcast</description>
        \(items)
          </channel>
        </rss>
        """
    }

    private static func serializeItem(_ release: AppcastRelease) -> String {
        let signatureAttribute = release.edSignature.map { " sparkle:edSignature=\"\(xmlAttribute($0))\"" } ?? ""
        let channelElement = release.channel == .beta ? "\n      <sparkle:channel>beta</sparkle:channel>" : ""
        return """
            <item>
              <title>\(xmlText(release.title))</title>
              <pubDate>\(xmlText(release.pubDate))</pubDate>\(channelElement)
              <sparkle:minimumSystemVersion>\(xmlText(release.minimumSystemVersion))</sparkle:minimumSystemVersion>
              <enclosure url="\(xmlAttribute(release.artifactURL))" length="\(release.artifactLength)" type="application/octet-stream" sparkle:version="\(xmlAttribute(release.build))" sparkle:shortVersionString="\(xmlAttribute(release.version))" sparkle:minimumSystemVersion="\(xmlAttribute(release.minimumSystemVersion))"\(signatureAttribute) />
            </item>
        """
    }
}

private func xmlText(_ value: String) -> String {
    xmlAttribute(value)
}

private func xmlAttribute(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}
