#if DEBUG
import AppKit
import Foundation

struct DesktopEvaluationReadinessRequest {
    let fixtureId: String
    let outputURL: URL
    let renderLatch: DesktopEvaluationRenderLatch

    init(
        fixtureId: String,
        outputPath: String,
        renderLatch: DesktopEvaluationRenderLatch
    ) throws {
        let url = URL(fileURLWithPath: outputPath).standardizedFileURL
        let allowedRoot = URL(fileURLWithPath: "/tmp/neondiff-desktop-evaluation", isDirectory: true)
            .standardizedFileURL
        guard url.isFileURL,
              url.path.hasPrefix(allowedRoot.path + "/"),
              url.pathExtension == "json" else {
            throw DesktopEvaluationReadinessError.unsafeOutputPath
        }
        let parent = url.deletingLastPathComponent()
        let values = try parent.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw DesktopEvaluationReadinessError.unsafeOutputPath
        }
        self.fixtureId = fixtureId
        self.outputURL = url
        self.renderLatch = renderLatch
    }
}

@MainActor
final class DesktopEvaluationRenderLatch {
    private(set) var isReady = false
    func markReady() { isReady = true }
}

enum DesktopEvaluationReadinessError: LocalizedError {
    case unsafeOutputPath
    case invalidGeometry

    var errorDescription: String? {
        switch self {
        case .unsafeOutputPath: "Evaluation readiness output must be a regular /tmp/neondiff-desktop-evaluation JSON path."
        case .invalidGeometry: "Evaluation window geometry is invalid."
        }
    }
}

struct DesktopEvaluationGeometrySample: Equatable {
    let windowFrame: NSRect
    let contentFrame: NSRect
    let backingScale: CGFloat

    func approximatelyEquals(_ other: DesktopEvaluationGeometrySample) -> Bool {
        Self.values(windowFrame).elementsEqual(Self.values(other.windowFrame), by: Self.nearlyEqual)
            && Self.values(contentFrame).elementsEqual(Self.values(other.contentFrame), by: Self.nearlyEqual)
            && Self.nearlyEqual(backingScale, other.backingScale)
    }

    private static func values(_ rect: NSRect) -> [CGFloat] {
        [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height]
    }

    private static func nearlyEqual(_ lhs: CGFloat, _ rhs: CGFloat) -> Bool {
        abs(lhs - rhs) <= 0.5
    }
}

enum DesktopEvaluationReadinessWriter {
    static func sample(window: NSWindow) -> DesktopEvaluationGeometrySample {
        DesktopEvaluationGeometrySample(
            windowFrame: window.frame,
            contentFrame: window.convertToScreen(window.contentLayoutRect),
            backingScale: window.backingScaleFactor
        )
    }

    static func write(
        request: DesktopEvaluationReadinessRequest,
        window: NSWindow,
        sample: DesktopEvaluationGeometrySample
    ) throws {
        guard sample.windowFrame.width > 0,
              sample.windowFrame.height > 0,
              sample.contentFrame.width > 0,
              sample.contentFrame.height > 0,
              sample.backingScale > 0 else {
            throw DesktopEvaluationReadinessError.invalidGeometry
        }
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "fixtureId": request.fixtureId,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "windowNumber": window.windowNumber,
            "windowFrame": frame(sample.windowFrame),
            "contentFrame": frame(sample.contentFrame),
            "backingScale": sample.backingScale,
            "ready": true
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: request.outputURL, options: [.atomic])
    }

    private static func frame(_ rect: NSRect) -> [String: Double] {
        [
            "x": rect.origin.x,
            "y": rect.origin.y,
            "width": rect.size.width,
            "height": rect.size.height
        ]
    }
}
#endif
