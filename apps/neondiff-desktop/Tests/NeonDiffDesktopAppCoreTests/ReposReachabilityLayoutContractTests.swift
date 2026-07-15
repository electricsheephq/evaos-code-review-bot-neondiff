import Foundation
import CoreGraphics
import Testing
@testable import NeonDiffDesktopAppCore

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

    @Test func hostedRegionFramesInvalidateAcrossGenerationsAndBadSnapshots() throws {
        let required = ["chrome", "sidebar", "detail"]
        let valid: [String: CGRect] = [
            "chrome": CGRect(x: 0, y: 0, width: 1040, height: 82),
            "sidebar": CGRect(x: 0, y: 82, width: 230, height: 598),
            "detail": CGRect(x: 231, y: 82, width: 809, height: 598)
        ]
        var state = GenerationBoundRegionFrameState()

        state.begin(generation: 0)
        let acceptedGeneration0 = state.replace(
            generation: 0,
            frames: valid,
            requiredIdentifiers: required
        )
        #expect(acceptedGeneration0)
        #expect(state.snapshot(generation: 0, requiredIdentifiers: required) != nil)

        state.begin(generation: 1)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == nil)
        let acceptedMissing = state.replace(
            generation: 1,
            frames: ["chrome": valid["chrome"]!],
            requiredIdentifiers: required
        )
        #expect(!acceptedMissing)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == nil)

        var invalid = valid
        invalid["detail"] = CGRect.zero
        let acceptedInvalid = state.replace(
            generation: 1,
            frames: invalid,
            requiredIdentifiers: required
        )
        #expect(!acceptedInvalid)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == nil)
        let acceptedStale = state.replace(
            generation: 0,
            frames: valid,
            requiredIdentifiers: required
        )
        #expect(!acceptedStale)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == nil)

        let acceptedGeneration1 = state.replace(
            generation: 1,
            frames: valid,
            requiredIdentifiers: required
        )
        #expect(acceptedGeneration1)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == valid)
        let acceptedInvalidation = state.replace(
            generation: 1,
            frames: ["chrome": valid["chrome"]!],
            requiredIdentifiers: required
        )
        #expect(!acceptedInvalidation)
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == nil)
    }

    @Test func hostedRegionPreferenceRoutingPreservesGenerationFreshness() throws {
        #expect(
            GenerationBoundRegionFrameRouting.route(
                currentGeneration: 1,
                observedGenerations: [1],
                framesAreEmpty: false
            ) == .replace(generation: 1)
        )
        #expect(
            GenerationBoundRegionFrameRouting.route(
                currentGeneration: 1,
                observedGenerations: [0],
                framesAreEmpty: false
            ) == .replace(generation: 0)
        )
        #expect(
            GenerationBoundRegionFrameRouting.route(
                currentGeneration: 1,
                observedGenerations: [],
                framesAreEmpty: true
            ) == .invalidate(generation: 1)
        )
        #expect(
            GenerationBoundRegionFrameRouting.route(
                currentGeneration: 1,
                observedGenerations: [0, 1],
                framesAreEmpty: false
            ) == .invalidate(generation: 1)
        )
        #expect(
            GenerationBoundRegionFrameRouting.route(
                currentGeneration: 2,
                observedGenerations: [0, 1],
                framesAreEmpty: false
            ) == .ignore
        )

        let required = ["chrome", "sidebar", "detail"]
        let valid: [String: CGRect] = [
            "chrome": CGRect(x: 0, y: 0, width: 1040, height: 82),
            "sidebar": CGRect(x: 0, y: 82, width: 230, height: 598),
            "detail": CGRect(x: 231, y: 82, width: 809, height: 598)
        ]
        var state = GenerationBoundRegionFrameState()
        state.begin(generation: 1)
        let acceptedCurrent = state.replace(
            generation: 1,
            frames: valid,
            requiredIdentifiers: required
        )
        #expect(acceptedCurrent)

        let staleRoute = GenerationBoundRegionFrameRouting.route(
            currentGeneration: 1,
            observedGenerations: [0],
            framesAreEmpty: false
        )
        if case let .replace(observedGeneration) = staleRoute {
            let acceptedStale = state.replace(
                generation: observedGeneration,
                frames: valid,
                requiredIdentifiers: required
            )
            #expect(!acceptedStale)
        } else {
            Issue.record("Expected a stale packet to preserve its observed generation")
        }
        #expect(state.snapshot(generation: 1, requiredIdentifiers: required) == valid)
    }

    @Test func settledGeometryRunnerUsesTheReadinessApprovedPrivateWorkspacePrefix() throws {
        let runner = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("scripts/capture-settled-geometry.sh")
        )
        let readiness = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift")
        )

        #expect(runner.contains(#"/tmp/neondiff-desktop-evaluation.XXXXXXXX"#))
        #expect(readiness.contains(#"^neondiff-desktop-evaluation\.[A-Za-z0-9]{8}$"#))
    }
}
