#if DEBUG
import AppKit
import Combine
import Foundation
import NeonDiffDesktopCore

struct DesktopEvaluationReadinessRequest {
    let fixtureId: String
    let outputURL: URL
    let surfaceStateURL: URL
    let renderLatch: DesktopEvaluationRenderLatch

    init(
        fixtureId: String,
        outputPath: String,
        renderLatch: DesktopEvaluationRenderLatch
    ) throws {
        let url = URL(fileURLWithPath: outputPath).standardizedFileURL
        let allowedParent = URL(fileURLWithPath: "/tmp", isDirectory: true).standardizedFileURL
        let parent = url.deletingLastPathComponent()
        let runRoot = parent.deletingLastPathComponent()
        guard url.isFileURL,
              runRoot.deletingLastPathComponent().path == allowedParent.path,
              runRoot.lastPathComponent.range(
                of: #"^neondiff-desktop-evaluation\.[A-Za-z0-9]{8}$"#,
                options: .regularExpression
              ) != nil,
              url.pathExtension == "json" else {
            throw DesktopEvaluationReadinessError.unsafeOutputPath
        }
        for directory in [runRoot, parent] {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw DesktopEvaluationReadinessError.unsafeOutputPath
            }
        }
        self.fixtureId = fixtureId
        self.outputURL = url
        self.surfaceStateURL = parent.appendingPathComponent("surface-state.json")
        self.renderLatch = renderLatch
    }
}

@MainActor
final class DesktopEvaluationRenderLatch {
    private(set) var isReady = false
    func markReady() { isReady = true }
}

@MainActor
final class DesktopEvaluationSurfaceStatus: ObservableObject {
    struct Snapshot: Equatable {
        let section: DesktopSection
        let generation: Int
        let rendered: Bool
        let quiescent: Bool
        let contentFrame: NSRect?
        let backingScale: CGFloat?
    }

    @Published private(set) var snapshot: Snapshot?

    var accessibilityIdentifier: String {
        guard let snapshot else {
            return "neondiff.evaluation.surface.unavailable"
        }
        let state = snapshot.quiescent ? "quiescent" : "pending"
        return "neondiff.evaluation.surface.\(snapshot.section.rawValue).\(snapshot.generation).\(state)"
    }

    var geometryAccessibilityValue: String {
        guard let snapshot,
              snapshot.quiescent,
              let contentFrame = snapshot.contentFrame,
              let backingScale = snapshot.backingScale else {
            return "contentFrame=unavailable;backingScale=unavailable"
        }
        let frameValues = [
            contentFrame.origin.x,
            contentFrame.origin.y,
            contentFrame.width,
            contentFrame.height
        ].map(Self.format)
        return "contentFrame=\(frameValues.joined(separator: ","));backingScale=\(Self.format(backingScale))"
    }

    @discardableResult
    func begin(section: DesktopSection) -> Int {
        if let snapshot, snapshot.section == section {
            return snapshot.generation
        }
        let generation = snapshot.map { $0.generation + 1 } ?? 0
        snapshot = Snapshot(
            section: section,
            generation: generation,
            rendered: false,
            quiescent: false,
            contentFrame: nil,
            backingScale: nil
        )
        return generation
    }

    func markRendered(section: DesktopSection) {
        let generation = begin(section: section)
        guard let snapshot,
              snapshot.section == section,
              snapshot.generation == generation,
              !snapshot.rendered else {
            return
        }
        self.snapshot = Snapshot(
            section: section,
            generation: generation,
            rendered: true,
            quiescent: false,
            contentFrame: nil,
            backingScale: nil
        )
    }

    func isRendered(section: DesktopSection, generation: Int) -> Bool {
        guard let snapshot else { return false }
        return snapshot.section == section
            && snapshot.generation == generation
            && snapshot.rendered
    }

    @discardableResult
    func markQuiescent(
        section: DesktopSection,
        generation: Int,
        sample: DesktopEvaluationGeometrySample
    ) -> Bool {
        guard let snapshot,
              snapshot.section == section,
              snapshot.generation == generation,
              snapshot.rendered else {
            return false
        }
        guard !snapshot.quiescent else { return true }
        self.snapshot = Snapshot(
            section: section,
            generation: generation,
            rendered: true,
            quiescent: true,
            contentFrame: sample.contentFrame,
            backingScale: sample.backingScale
        )
        return true
    }

    private static func format(_ value: CGFloat) -> String {
        String(
            format: "%.3f",
            locale: Locale(identifier: "en_US_POSIX"),
            Double(value)
        )
    }
}

enum DesktopEvaluationReadinessError: LocalizedError {
    case unsafeOutputPath
    case invalidGeometry

    var errorDescription: String? {
        switch self {
        case .unsafeOutputPath: "Evaluation readiness output must be inside a private capture workspace."
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

enum DesktopEvaluationSurfaceStateWriter {
    static func sample(window: NSWindow) -> DesktopEvaluationGeometrySample {
        DesktopEvaluationReadinessWriter.sample(window: window)
    }

    static func write(
        request: DesktopEvaluationReadinessRequest,
        window: NSWindow,
        sample: DesktopEvaluationGeometrySample,
        section: DesktopSection,
        surfaceGeneration: Int
    ) throws {
        guard surfaceGeneration >= 0,
              sample.windowFrame.width > 0,
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
            "section": section.rawValue,
            "surfaceGeneration": surfaceGeneration,
            "windowFrame": frame(sample.windowFrame),
            "contentFrame": frame(sample.contentFrame),
            "backingScale": sample.backingScale,
            "quiescent": true
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: request.surfaceStateURL, options: [.atomic])
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
