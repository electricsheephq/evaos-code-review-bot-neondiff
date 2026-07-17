public struct DesktopWindowContentSize: Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public enum DesktopWindowGeometryPolicy {
    public static func minimumContentSize(
        requested: DesktopWindowContentSize?
    ) -> DesktopWindowContentSize {
        requested ?? DesktopWindowContentSize(width: 1040, height: 680)
    }

    public static func targetFrameSize(
        requestedContent: DesktopWindowContentSize,
        currentFrame: DesktopWindowContentSize,
        currentContent: DesktopWindowContentSize
    ) -> DesktopWindowContentSize {
        DesktopWindowContentSize(
            width: requestedContent.width + Swift.max(0, currentFrame.width - currentContent.width),
            height: requestedContent.height + Swift.max(0, currentFrame.height - currentContent.height)
        )
    }

    public static func evaluationWindowHorizontalOrigin(
        visibleMinimumX: Double,
        visibleMaximumX: Double,
        windowWidth: Double,
        preferredInset: Double
    ) -> Double {
        Swift.min(
            visibleMinimumX + preferredInset,
            visibleMaximumX - windowWidth
        )
    }

    public static func shouldApply(
        current: DesktopWindowContentSize,
        requested: DesktopWindowContentSize,
        tolerance: Double = 0.5
    ) -> Bool {
        guard current.width.isFinite,
              current.height.isFinite,
              requested.width.isFinite,
              requested.height.isFinite else { return true }
        return Swift.abs(current.width - requested.width) > tolerance
            || Swift.abs(current.height - requested.height) > tolerance
    }
}
