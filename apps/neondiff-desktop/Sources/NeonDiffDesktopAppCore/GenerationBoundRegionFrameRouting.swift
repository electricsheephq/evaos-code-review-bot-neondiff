#if DEBUG
public enum GenerationBoundRegionFrameRouting: Equatable, Sendable {
    case replace(generation: Int)
    case invalidate(generation: Int)
    case ignore

    public static func route(
        currentGeneration: Int,
        observedGenerations: Set<Int>,
        framesAreEmpty: Bool
    ) -> Self {
        if framesAreEmpty {
            return .invalidate(generation: currentGeneration)
        }
        if observedGenerations.count == 1,
           let observedGeneration = observedGenerations.first {
            return .replace(generation: observedGeneration)
        }
        if observedGenerations.contains(currentGeneration) {
            return .invalidate(generation: currentGeneration)
        }
        return .ignore
    }
}
#endif
