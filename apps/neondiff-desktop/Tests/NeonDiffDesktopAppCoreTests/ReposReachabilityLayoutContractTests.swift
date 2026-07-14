import Foundation
import Testing

@Suite struct ReposReachabilityLayoutContractTests {
    @Test func reposPageKeepsApplyAndBoundaryReachableAtCompactHeights() throws {
        let reposView = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views/ReposView.swift")
        let source = try sourceBoundaryText(at: reposView)

        let outerScroll = try #require(source.range(of: "ScrollView(.vertical) {"))
        let outerBackground = try #require(
            source.range(
                of: ".scrollContentBackground(.hidden)",
                range: outerScroll.upperBound..<source.endIndex
            )
        )
        let outerIndicators = try #require(
            source.range(
                of: ".scrollIndicators(.visible, axes: .vertical)",
                range: outerBackground.upperBound..<source.endIndex
            )
        )
        let pageContent = try #require(source.range(of: "private var pageContent: some View"))
        let pageStack = try #require(
            source.range(
                of: "VStack(alignment: .leading, spacing: 14) {",
                range: pageContent.upperBound..<source.endIndex
            )
        )
        let readOnlyBoundary = try #require(source.range(of: ".disabled(!model.canEditProviderConfiguration)"))

        #expect(outerScroll.lowerBound < outerBackground.lowerBound)
        #expect(outerBackground.lowerBound < outerIndicators.lowerBound)
        #expect(outerIndicators.lowerBound < pageContent.lowerBound)
        #expect(pageContent.lowerBound < pageStack.lowerBound)
        #expect(pageStack.lowerBound < readOnlyBoundary.lowerBound)
        #expect(source.contains(".frame(height: 360)"))
        #expect(!source.contains(".frame(minHeight: 360)"))
        #expect(source.contains(".accessibilityIdentifier(\"neondiff-repos-outer-scroll\")"))
        #expect(source.contains(".accessibilityIdentifier(\"neondiff-repos-boundary\")"))
    }

    @Test func settledGeometryBindingsAreFixtureOnlyAndPreserveNativeRegions() throws {
        let contentView = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views/ContentView.swift")
        let source = try sourceBoundaryText(at: contentView)
        let app = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift")
        )
        let sidebar = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Views/SidebarView.swift")
        )

        for identifier in ["neondiff-chrome", "neondiff-sidebar", "neondiff-detail"] {
            #expect(source.contains("\"\(identifier)\""))
        }
        #expect(source.contains("enablesEvaluationRegionBindings: Bool = false"))
        #expect(source.contains("evaluationAccessibilityRegion("))
        #expect(source.contains("if enabled {"))
        #expect(source.components(separatedBy: "accessibilityElement(children: .contain)").count - 1 == 1)
        #expect(source.contains("SidebarView(selection: $model.selectedSection)"))
        #expect(source.contains("DetailView("))
        #expect(app.contains("enablesEvaluationRegionBindings: evaluationRegionBindingsEnabled"))
        #expect(app.contains("evaluationContext != nil"))
        #expect(sidebar.contains(#"neondiff-sidebar-section-\(section.rawValue)"#))
    }

    @Test func settledGeometryCaptureUsesOnlyTwoLedgeredPublicSamePIDPresses() throws {
        let source = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktopSettledGeometryCapture/main.swift")
        )

        #expect(source.components(separatedBy: "AXUIElementPerformAction(").count - 1 == 1)
        #expect(source.contains("attemptCount: 1"))
        #expect(source.contains("AXUIElementCopyActionNames"))
        #expect(source.contains("AXUIElementGetPid"))
        #expect(source.contains("CGWindowListCopyWindowInfo"))
        #expect(source.contains("ready.windowNumber <= Int(CGWindowID.max)"))
        #expect(source.contains("state.surfaceGeneration == expectedGeneration"))
        #expect(source.contains("state.section == expectedSection"))
        #expect(source.contains("state.quiescent"))
        #expect(source.contains(#"neondiff-sidebar-section-\(to.rawValue)"#))
        #expect(!source.contains("AXUIElementSetAttributeValue"))
        #expect(!source.contains("AXUIElementPostKeyboardEvent"))
        #expect(!source.contains("CGEventPost"))
        #expect(!source.contains("kAXTrustedCheckOptionPrompt"))
        #expect(!source.contains("CGRequestScreenCaptureAccess"))
    }

    @Test func debugSurfaceStateRearmsPerSectionWithFreshAppKitGeometry() throws {
        let configurator = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Support/NeonWindowConfigurator.swift")
        )
        let readiness = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift")
        )

        #expect(configurator.contains("evaluationSection"))
        #expect(configurator.contains("surfaceGeneration"))
        #expect(configurator.contains("sampleSurfaceState"))
        #expect(configurator.contains("DesktopEvaluationSurfaceStateWriter.sample(window: window)"))
        #expect(readiness.contains("surface-state.json"))
        #expect(readiness.contains("quiescent"))
    }
}
