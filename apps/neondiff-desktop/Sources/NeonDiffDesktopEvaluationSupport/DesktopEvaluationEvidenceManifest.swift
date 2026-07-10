import Foundation
import NeonDiffDesktopCore

public struct DesktopEvaluationEvidenceManifest: Codable, Equatable, Sendable {
    public struct Artifact: Codable, Equatable, Sendable {
        public let path: String
        public let sha256: String
        public let buildIdentity: String
    }

    public struct EvidenceFile: Codable, Equatable, Sendable {
        public let path: String
        public let sha256: String
    }

    public struct Case: Codable, Equatable, Sendable {
        public let fixtureId: String
        public let section: DesktopSection
        public let onboardingStep: OnboardingStep?
        public let contentSize: DesktopEvaluationContentSize
        public let screenshot: EvidenceFile
        public let accessibility: EvidenceFile
        public let geometry: EvidenceFile
        public let expectedState: String
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
    public let cases: [Case]
    public let scans: Scans
    public let proofBoundary: String

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
        guard ISO8601DateFormatter().date(from: generatedAt) != nil else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest generatedAt")
        }
        guard repository.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest repository")
        }
        guard Self.isHash(headSHA, length: 40) else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest headSHA")
        }
        guard artifact.path.hasPrefix("/"), Self.isHash(artifact.sha256), !artifact.buildIdentity.isEmpty else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest artifact")
        }
        guard Self.isHash(catalogSHA256), !cases.isEmpty else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest catalog or cases")
        }
        var fixtureIds = Set<String>()
        for item in cases {
            guard fixtureIds.insert(item.fixtureId).inserted,
                  item.fixtureId.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
                  DesktopEvaluationContentSize.canonical.contains(item.contentSize),
                  !item.expectedState.isEmpty else {
                throw DesktopEvaluationFixtureError.invalidValue("manifest case")
            }
            for evidence in [item.screenshot, item.accessibility, item.geometry] {
                guard Self.isSafeRelativePath(evidence.path), Self.isHash(evidence.sha256) else {
                    throw DesktopEvaluationFixtureError.invalidValue("manifest evidence file")
                }
            }
        }
        guard scans.secretScanPassed, scans.releaseBoundaryPassed else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest scans must pass")
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

    private static func isSafeRelativePath(_ value: String) -> Bool {
        !value.isEmpty
            && !value.hasPrefix("/")
            && !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
            && value.utf8.count <= 512
    }

    private static func validateShape(_ root: [String: Any]) throws {
        try requireOnly(root, allowed: ["schemaVersion", "generatedAt", "repository", "headSHA", "artifact", "catalogSHA256", "cases", "scans", "proofBoundary"], path: "manifest")
        try requireObject(root["artifact"], allowed: ["path", "sha256", "buildIdentity"], path: "manifest.artifact")
        try requireObject(root["scans"], allowed: ["secretScanPassed", "releaseBoundaryPassed"], path: "manifest.scans")
        guard let cases = root["cases"] as? [Any] else {
            throw DesktopEvaluationFixtureError.invalidValue("manifest cases")
        }
        for (index, value) in cases.enumerated() {
            let item = try object(value, path: "manifest.cases[\(index)]")
            try requireOnly(item, allowed: ["fixtureId", "section", "onboardingStep", "contentSize", "screenshot", "accessibility", "geometry", "expectedState"], path: "manifest.cases[\(index)]")
            try requireObject(item["contentSize"], allowed: ["width", "height"], path: "manifest.cases[\(index)].contentSize")
            for name in ["screenshot", "accessibility", "geometry"] {
                try requireObject(item[name], allowed: ["path", "sha256"], path: "manifest.cases[\(index)].\(name)")
            }
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
