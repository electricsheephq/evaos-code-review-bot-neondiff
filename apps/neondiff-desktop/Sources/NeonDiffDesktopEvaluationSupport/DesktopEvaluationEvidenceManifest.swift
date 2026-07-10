import Foundation
import NeonDiffDesktopCore

public struct DesktopEvaluationEvidenceManifest: Codable, Equatable, Sendable {
    public struct Artifact: Codable, Equatable, Sendable {
        public let path: String
        public let sha256: String
        public let buildIdentity: String
    }

    public struct Platform: Codable, Equatable, Sendable {
        public let macOSVersion: String
        public let xcodeVersion: String
        public let swiftVersion: String
        public let architecture: String
        public let backingScale: Double
    }

    public struct TestSummary: Codable, Equatable, Sendable {
        public let testCount: Int
        public let durationSeconds: Double
        public let xcresultSHA256: String
    }

    public struct EvidenceFile: Codable, Equatable, Sendable {
        public let path: String
        public let sha256: String
    }

    public struct Frame: Codable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }

    public struct GoldenMetrics: Codable, Equatable, Sendable {
        public let ssim: Double
        public let changedPixelPercent: Double
        public let largestChangedRegionPercent: Double
        public let maskVersion: String
    }

    public struct Case: Codable, Equatable, Sendable {
        public let fixtureId: String
        public let section: DesktopSection
        public let onboardingStep: OnboardingStep?
        public let appearance: DesktopEvaluationAppearance
        public let requestedContentSize: DesktopEvaluationContentSize
        public let actualWindowFrame: Frame
        public let actualContentFrame: Frame
        public let screenshot: EvidenceFile
        public let accessibility: EvidenceFile
        public let geometry: EvidenceFile
        public let goldenMetrics: GoldenMetrics
        public let expectedState: DesktopEvaluationHealth
    }

    public enum FindingSeverity: String, Codable, Sendable {
        case p0 = "P0"
        case p1 = "P1"
        case p2 = "P2"
        case p3 = "P3"
    }

    public struct UnresolvedFinding: Codable, Equatable, Sendable {
        public let id: String
        public let severity: FindingSeverity
        public let owner: String
        public let recordedAt: String
        public let reason: String
    }

    public struct Scans: Codable, Equatable, Sendable {
        public let secretScanPassed: Bool
        public let releaseBoundaryPassed: Bool
    }

    public let schemaVersion: Int
    public let generatedAt: String
    public let repository: String
    public let headSHA: String
    public let artifact: Artifact
    public let catalogSHA256: String
    public let platform: Platform
    public let testSummary: TestSummary
    public let cases: [Case]
    public let scans: Scans
    public let proofBoundary: String
    public let unresolvedFindings: [UnresolvedFinding]

    public static func decode(data: Data) throws -> DesktopEvaluationEvidenceManifest {
        guard data.count <= 1024 * 1024 else {
            throw DesktopEvaluationFixtureError.oversized
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw DesktopEvaluationFixtureError.invalidJSON
        }
        guard let root = object as? [String: Any] else {
            throw DesktopEvaluationFixtureError.invalidJSON
        }
        try validateShape(root)
        try DesktopEvaluationFixture.validatePublicSafeContent(object, path: "manifest")
        let manifest: DesktopEvaluationEvidenceManifest
        do {
            manifest = try JSONDecoder().decode(DesktopEvaluationEvidenceManifest.self, from: data)
        } catch {
            throw DesktopEvaluationFixtureError.invalidValue("evidence manifest schema")
        }
        try manifest.validate()
        return manifest
    }

    private func validate() throws {
        guard schemaVersion == 1 else {
            throw DesktopEvaluationFixtureError.unsupportedSchemaVersion(schemaVersion)
        }
        guard ISO8601DateFormatter().date(from: generatedAt) != nil,
              repository.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil,
              Self.isHash(headSHA, length: 40),
              Self.isSafeArtifactPath(artifact.path),
              Self.isHash(artifact.sha256),
              !artifact.buildIdentity.isEmpty,
              artifact.buildIdentity.utf8.count <= 256,
              Self.isHash(catalogSHA256) else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest identity")
        }
        guard !platform.macOSVersion.isEmpty,
              !platform.xcodeVersion.isEmpty,
              !platform.swiftVersion.isEmpty,
              ["arm64", "x86_64"].contains(platform.architecture),
              [1.0, 2.0, 3.0].contains(platform.backingScale) else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest platform")
        }
        guard testSummary.testCount == cases.count,
              testSummary.testCount > 0,
              testSummary.durationSeconds >= 0,
              testSummary.durationSeconds.isFinite,
              Self.isHash(testSummary.xcresultSHA256) else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest test summary")
        }
        var caseIdentities = Set<String>()
        for item in cases {
            let identity = "\(item.fixtureId)|\(item.appearance.rawValue)|\(item.requestedContentSize.width)x\(item.requestedContentSize.height)|\(platform.backingScale)"
            guard caseIdentities.insert(identity).inserted,
                  item.fixtureId.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
                  DesktopEvaluationContentSize.canonical.contains(item.requestedContentSize),
                  Self.isValidFrame(item.actualWindowFrame),
                  Self.isValidFrame(item.actualContentFrame),
                  item.actualContentFrame.width <= item.actualWindowFrame.width,
                  item.actualContentFrame.height <= item.actualWindowFrame.height else {
                throw DesktopEvaluationFixtureError.invalidValue("manifest case")
            }
            for evidence in [item.screenshot, item.accessibility, item.geometry] {
                guard Self.isSafeRelativePath(evidence.path), Self.isHash(evidence.sha256) else {
                    throw DesktopEvaluationFixtureError.invalidValue("manifest evidence file")
                }
            }
            guard item.goldenMetrics.ssim >= 0.995,
                  item.goldenMetrics.ssim <= 1,
                  item.goldenMetrics.changedPixelPercent >= 0,
                  item.goldenMetrics.changedPixelPercent <= 0.5,
                  item.goldenMetrics.largestChangedRegionPercent >= 0,
                  item.goldenMetrics.largestChangedRegionPercent <= 0.25,
                  item.goldenMetrics.maskVersion.range(of: #"^[a-z0-9][a-z0-9.-]{0,63}$"#, options: .regularExpression) != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("manifest golden metrics")
            }
        }
        guard scans.secretScanPassed, scans.releaseBoundaryPassed else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest scans must pass")
        }
        for finding in unresolvedFindings {
            guard finding.severity != .p0,
                  finding.severity != .p1,
                  finding.id.range(of: #"^[A-Za-z0-9_.-]{1,64}$"#, options: .regularExpression) != nil,
                  !finding.owner.isEmpty,
                  !finding.reason.isEmpty,
                  ISO8601DateFormatter().date(from: finding.recordedAt) != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("manifest unresolved finding")
            }
        }
        guard !proofBoundary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              proofBoundary.utf8.count <= 1024 else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest proofBoundary")
        }
    }

    private static func isHash(_ value: String, length: Int = 64) -> Bool {
        value.count == length
            && value.range(of: "^[a-f0-9]{\(length)}$", options: .regularExpression) != nil
    }

    private static func isSafeArtifactPath(_ value: String) -> Bool {
        value.hasPrefix("/Applications/")
            && !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
            && value.utf8.count <= 512
    }

    private static func isSafeRelativePath(_ value: String) -> Bool {
        !value.isEmpty
            && !value.hasPrefix("/")
            && !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
            && value.utf8.count <= 512
    }

    private static func isValidFrame(_ frame: Frame) -> Bool {
        [frame.x, frame.y, frame.width, frame.height].allSatisfy(\.isFinite)
            && frame.width > 0
            && frame.height > 0
    }

    private static func validateShape(_ root: [String: Any]) throws {
        try requireOnly(root, allowed: ["schemaVersion", "generatedAt", "repository", "headSHA", "artifact", "catalogSHA256", "platform", "testSummary", "cases", "scans", "proofBoundary", "unresolvedFindings"], path: "manifest")
        try requireObject(root["artifact"], allowed: ["path", "sha256", "buildIdentity"], path: "manifest.artifact")
        try requireObject(root["platform"], allowed: ["macOSVersion", "xcodeVersion", "swiftVersion", "architecture", "backingScale"], path: "manifest.platform")
        try requireObject(root["testSummary"], allowed: ["testCount", "durationSeconds", "xcresultSHA256"], path: "manifest.testSummary")
        try requireObject(root["scans"], allowed: ["secretScanPassed", "releaseBoundaryPassed"], path: "manifest.scans")
        guard let cases = root["cases"] as? [Any] else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest cases")
        }
        for (index, value) in cases.enumerated() {
            let item = try object(value, path: "manifest.cases[\(index)]")
            try requireOnly(item, allowed: ["fixtureId", "section", "onboardingStep", "appearance", "requestedContentSize", "actualWindowFrame", "actualContentFrame", "screenshot", "accessibility", "geometry", "goldenMetrics", "expectedState"], path: "manifest.cases[\(index)]")
            try requireObject(item["requestedContentSize"], allowed: ["width", "height"], path: "manifest.cases[\(index)].requestedContentSize")
            for name in ["actualWindowFrame", "actualContentFrame"] {
                try requireObject(item[name], allowed: ["x", "y", "width", "height"], path: "manifest.cases[\(index)].\(name)")
            }
            for name in ["screenshot", "accessibility", "geometry"] {
                try requireObject(item[name], allowed: ["path", "sha256"], path: "manifest.cases[\(index)].\(name)")
            }
            try requireObject(item["goldenMetrics"], allowed: ["ssim", "changedPixelPercent", "largestChangedRegionPercent", "maskVersion"], path: "manifest.cases[\(index)].goldenMetrics")
        }
        guard let findings = root["unresolvedFindings"] as? [Any] else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest unresolvedFindings")
        }
        for (index, value) in findings.enumerated() {
            try requireObject(value, allowed: ["id", "severity", "owner", "recordedAt", "reason"], path: "manifest.unresolvedFindings[\(index)]")
        }
    }

    private static func object(_ value: Any?, path: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else {
            throw DesktopEvaluationFixtureError.invalidValue(path)
        }
        return object
    }

    private static func requireObject(_ value: Any?, allowed: Set<String>, path: String) throws {
        try requireOnly(try object(value, path: path), allowed: allowed, path: path)
    }

    private static func requireOnly(_ object: [String: Any], allowed: Set<String>, path: String) throws {
        if let field = object.keys.sorted().first(where: { !allowed.contains($0) }) {
            throw DesktopEvaluationFixtureError.unknownField(path: path, field: field)
        }
    }
}
