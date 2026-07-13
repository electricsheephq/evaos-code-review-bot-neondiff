import Foundation
import NeonDiffDesktopEvaluationSupport

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: NeonDiffDesktopManifestChecks <manifest.json>\n".utf8))
    exit(64)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let manifestData: Data
do {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard url.isFileURL,
          url.path.hasPrefix("/"),
          values.isRegularFile == true,
          values.isSymbolicLink != true else {
        throw CocoaError(.fileReadInvalidFileName)
    }
    manifestData = try Data(contentsOf: url, options: [.mappedIfSafe])
} catch {
    FileHandle.standardError.write(Data("manifest must be an absolute regular non-symlink file\n".utf8))
    exit(65)
}

let manifest = try DesktopEvaluationEvidenceManifest.decode(
    data: manifestData
)
let result: [String: Any] = [
    "ok": true,
    "schemaVersion": manifest.schemaVersion,
    "headSHA": manifest.headSHA,
    "caseCount": manifest.cases.count,
    "fixtureCount": Set(manifest.cases.map(\.fixtureId)).count
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
