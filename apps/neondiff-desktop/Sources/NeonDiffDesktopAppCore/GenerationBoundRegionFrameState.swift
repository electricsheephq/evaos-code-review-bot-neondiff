import CoreGraphics

public struct GenerationBoundRegionFrameState {
    private var activeGeneration: Int?
    private var frames: [String: CGRect]?

    public init() {}

    public mutating func begin(generation: Int) {
        guard activeGeneration != generation else { return }
        activeGeneration = generation
        frames = nil
    }

    @discardableResult
    public mutating func replace(
        generation: Int,
        frames candidate: [String: CGRect],
        requiredIdentifiers: [String]
    ) -> Bool {
        guard generation == activeGeneration else { return false }
        let required = Set(requiredIdentifiers)
        guard required.count == requiredIdentifiers.count,
              Set(candidate.keys) == required,
              candidate.values.allSatisfy(Self.isValid) else {
            frames = nil
            return false
        }
        frames = candidate
        return true
    }

    public func snapshot(
        generation: Int,
        requiredIdentifiers: [String]
    ) -> [String: CGRect]? {
        guard generation == activeGeneration,
              let frames,
              Set(frames.keys) == Set(requiredIdentifiers) else {
            return nil
        }
        return frames
    }

    private static func isValid(_ frame: CGRect) -> Bool {
        [
            frame.origin.x,
            frame.origin.y,
            frame.width,
            frame.height,
            frame.maxX,
            frame.maxY
        ].allSatisfy(\.isFinite) && frame.width > 0 && frame.height > 0
    }
}
