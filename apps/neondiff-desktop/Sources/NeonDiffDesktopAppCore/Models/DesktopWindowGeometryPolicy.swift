public struct DesktopWindowContentSize: Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public struct DesktopWindowOrigin: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum DesktopWindowGeometryPolicy {
    public static let productionDefaultContentSize =
        DesktopWindowContentSize(width: 1200, height: 760)

    public static func minimumContentSize(
        requested: DesktopWindowContentSize?
    ) -> DesktopWindowContentSize {
        requested ?? DesktopWindowContentSize(width: 760, height: 560)
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

    public static func productionLaunchFrameSize(
        currentFrame: DesktopWindowContentSize,
        currentContent: DesktopWindowContentSize,
        visibleFrame: DesktopWindowContentSize
    ) -> DesktopWindowContentSize {
        let target = targetFrameSize(
            requestedContent: productionDefaultContentSize,
            currentFrame: currentFrame,
            currentContent: currentContent
        )
        return DesktopWindowContentSize(
            width: Swift.min(target.width, visibleFrame.width),
            height: Swift.min(target.height, visibleFrame.height)
        )
    }

    public static func centeredOrigin(
        frameSize: DesktopWindowContentSize,
        visibleOrigin: DesktopWindowOrigin,
        visibleFrame: DesktopWindowContentSize
    ) -> DesktopWindowOrigin {
        DesktopWindowOrigin(
            x: visibleOrigin.x + Swift.max(0, (visibleFrame.width - frameSize.width) / 2),
            y: visibleOrigin.y + Swift.max(0, (visibleFrame.height - frameSize.height) / 2)
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
