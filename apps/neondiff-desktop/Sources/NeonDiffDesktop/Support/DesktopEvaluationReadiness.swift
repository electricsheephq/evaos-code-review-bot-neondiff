#if DEBUG
import AppKit
import Combine
import Foundation
import NeonDiffDesktopAppCore
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
        let samples: [DesktopHostedGeometrySample]
    }

    @Published private(set) var snapshot: Snapshot?
    private var regionFrameState = GenerationBoundRegionFrameState()

    var accessibilityIdentifier: String {
        guard let snapshot else {
            return "neondiff.evaluation.surface.unavailable"
        }
        let state = snapshot.quiescent ? "quiescent" : "pending"
        return "neondiff.evaluation.surface.\(snapshot.section.rawValue).\(snapshot.generation).\(state)"
    }

    var geometryAccessibilityValue: String {
        guard geometryAccessibilityChunks.count == 4 else {
            return "neondiff-hosted-geometry-unavailable"
        }
        return "ndg2-chunks:4"
    }

    var geometryAccessibilityChunks: [DesktopHostedGeometryAccessibilityChunk] {
        guard let snapshot,
              snapshot.quiescent,
              snapshot.samples.count == 3,
              let data = DesktopHostedGeometryCompactTransport.encode(snapshot.samples) else {
            return []
        }
        return DesktopHostedGeometryCompactTransport.chunks(
            data,
            section: snapshot.section,
            generation: snapshot.generation
        )
    }

    @discardableResult
    func begin(section: DesktopSection) -> Int {
        if let snapshot, snapshot.section == section {
            return snapshot.generation
        }
        let generation = snapshot.map { $0.generation + 1 } ?? 0
        regionFrameState.begin(generation: generation)
        snapshot = Snapshot(
            section: section,
            generation: generation,
            rendered: false,
            quiescent: false,
            samples: []
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
            samples: []
        )
    }

    func isRendered(section: DesktopSection, generation: Int) -> Bool {
        guard let snapshot else { return false }
        return snapshot.section == section
            && snapshot.generation == generation
            && snapshot.rendered
    }

    func updateRegionFrames(_ frames: [String: CGRect], generation: Int) {
        _ = regionFrameState.replace(
            generation: generation,
            frames: frames,
            requiredIdentifiers: DesktopHostedGeometryRegionFrame.requiredIdentifiers
        )
    }

    func hostedGeometrySample(
        windowSample: DesktopEvaluationGeometrySample,
        section: DesktopSection,
        generation: Int,
        elapsedMilliseconds: Int
    ) -> DesktopHostedGeometrySample? {
        guard snapshot?.section == section,
              snapshot?.generation == generation,
              let regionFrames = regionFrameState.snapshot(
                  generation: generation,
                  requiredIdentifiers: DesktopHostedGeometryRegionFrame.requiredIdentifiers
              ) else {
            return nil
        }
        let regions = DesktopHostedGeometryRegionFrame.requiredIdentifiers.compactMap {
            identifier -> DesktopHostedGeometryRegionFrame? in
            guard let frame = regionFrames[identifier] else { return nil }
            return DesktopHostedGeometryRegionFrame(
                identifier: identifier,
                frame: DesktopHostedGeometryFrame(frame)
            )
        }
        guard regions.count == DesktopHostedGeometryRegionFrame.requiredIdentifiers.count else {
            return nil
        }
        return DesktopHostedGeometrySample(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: DesktopHostedGeometryFrame(windowSample.windowFrame),
            contentFrame: DesktopHostedGeometryFrame(windowSample.contentFrame),
            backingScale: Double(windowSample.backingScale),
            regions: regions
        )
    }

    @discardableResult
    func markQuiescent(
        section: DesktopSection,
        generation: Int,
        samples: [DesktopHostedGeometrySample]
    ) -> Bool {
        guard let snapshot,
              snapshot.section == section,
              snapshot.generation == generation,
              snapshot.rendered,
              samples.count == 3 else {
            return false
        }
        guard !snapshot.quiescent else { return true }
        self.snapshot = Snapshot(
            section: section,
            generation: generation,
            rendered: true,
            quiescent: true,
            samples: samples
        )
        return true
    }
}

private enum DesktopHostedGeometryCompactTransport {
    private static let magic: [UInt8] = [0x4E, 0x44, 0x47, 0x32]
    private static let sampleCount = 3
    private static let componentsPerSample = 21
    private static let encodedByteCount = 5 + sampleCount * (4 + componentsPerSample * 4)
    private static let chunkCount = 4
    private static let chunkByteCount = 68

    static func encode(_ samples: [DesktopHostedGeometrySample]) -> Data? {
        guard samples.count == sampleCount else { return nil }
        var data = Data(magic + [UInt8(sampleCount)])
        for sample in samples {
            guard sample.elapsedMilliseconds >= 0,
                  let elapsed = UInt32(exactly: sample.elapsedMilliseconds) else {
                return nil
            }
            let orderedRegions = DesktopHostedGeometryRegionFrame.requiredIdentifiers.compactMap {
                identifier in
                sample.regions.first(where: { $0.identifier == identifier })
            }
            guard orderedRegions.count == DesktopHostedGeometryRegionFrame.requiredIdentifiers.count else {
                return nil
            }
            let components = sample.windowFrame.compactComponents
                + sample.contentFrame.compactComponents
                + [sample.backingScale]
                + orderedRegions.flatMap { $0.frame.compactComponents }
            guard components.count == componentsPerSample,
                  components.allSatisfy(\.isFinite) else {
                return nil
            }
            data.appendLittleEndian(elapsed)
            for component in components {
                let compact = Float(component)
                guard compact.isFinite else { return nil }
                data.appendLittleEndian(compact.bitPattern)
            }
        }
        guard data.count == encodedByteCount else { return nil }
        return data
    }

    static func chunks(
        _ data: Data,
        section: DesktopSection,
        generation: Int
    ) -> [DesktopHostedGeometryAccessibilityChunk] {
        guard data.count == encodedByteCount else { return [] }
        let chunks = (0..<chunkCount).compactMap { index
            -> DesktopHostedGeometryAccessibilityChunk? in
            let lowerBound = index * chunkByteCount
            let upperBound = min(lowerBound + chunkByteCount, data.count)
            guard lowerBound < upperBound else { return nil }
            let encoded = data.subdata(in: lowerBound..<upperBound).base64EncodedString()
            let value = "ndg2:\(index):\(chunkCount):\(encoded)"
            guard value.utf8.count <= 128 else { return nil }
            return DesktopHostedGeometryAccessibilityChunk(
                identifier: "neondiff.evaluation.geometry.\(section.rawValue).\(generation).\(index)",
                value: value
            )
        }
        guard chunks.count == chunkCount else { return [] }
        return chunks
    }
}

struct DesktopHostedGeometryAccessibilityChunk: Identifiable, Equatable {
    let identifier: String
    let value: String

    var id: String { identifier }
}

struct DesktopHostedGeometryFrame: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: CGRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }

    fileprivate var compactComponents: [Double] {
        [x, y, width, height]
    }

    var isFiniteAndNonempty: Bool {
        [x, y, width, height, x + width, y + height].allSatisfy(\.isFinite)
            && width > 0
            && height > 0
    }

    func approximatelyEquals(_ other: Self) -> Bool {
        abs(x - other.x) <= 0.5
            && abs(y - other.y) <= 0.5
            && abs(width - other.width) <= 0.5
            && abs(height - other.height) <= 0.5
    }
}

private extension Data {
    mutating func appendLittleEndian(_ value: UInt32) {
        append(UInt8(truncatingIfNeeded: value))
        append(UInt8(truncatingIfNeeded: value >> 8))
        append(UInt8(truncatingIfNeeded: value >> 16))
        append(UInt8(truncatingIfNeeded: value >> 24))
    }
}

struct DesktopHostedGeometryRegionFrame: Codable, Equatable {
    static let requiredIdentifiers = [
        "neondiff-chrome",
        "neondiff-sidebar",
        "neondiff-detail"
    ]

    let identifier: String
    let frame: DesktopHostedGeometryFrame
}

struct DesktopHostedGeometrySample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let windowFrame: DesktopHostedGeometryFrame
    let contentFrame: DesktopHostedGeometryFrame
    let backingScale: Double
    let regions: [DesktopHostedGeometryRegionFrame]

    func withElapsedMilliseconds(_ value: Int) -> Self {
        Self(
            elapsedMilliseconds: value,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            backingScale: backingScale,
            regions: regions
        )
    }

    func approximatelyEquals(_ other: Self) -> Bool {
        windowFrame.approximatelyEquals(other.windowFrame)
            && contentFrame.approximatelyEquals(other.contentFrame)
            && abs(backingScale - other.backingScale) <= 0.01
            && regions.count == other.regions.count
            && regions.allSatisfy { region in
                other.regions.first(where: { $0.identifier == region.identifier })
                    .map { region.frame.approximatelyEquals($0.frame) } == true
            }
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
