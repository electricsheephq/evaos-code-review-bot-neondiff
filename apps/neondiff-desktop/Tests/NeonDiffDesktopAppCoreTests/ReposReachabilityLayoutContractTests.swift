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
        #expect(source.contains(".accessibilityIdentifier(\"neondiff-repos-boundary\")"))
    }
}
