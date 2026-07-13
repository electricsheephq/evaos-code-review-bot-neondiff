import Foundation
import Testing
@testable import NeonDiffDesktopEvaluationSupport

@Suite("Desktop Repositories scroll capabilities")
struct DesktopReposScrollCapabilitiesTests {
    @Test func reducesMacOS26ActionNamesToSanitizedBooleans() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 26,
            boundaryActionNames: ["AXScrollToVisible", "AXShowMenu"],
            verticalScrollBarResolved: true,
            scrollBarActionNames: ["AXIncrement"],
            scrollToVisibleActionName: "AXScrollToVisible",
            incrementActionName: "AXIncrement"
        )

        #expect(capabilities.acquisition == .init(status: .complete, failureReason: nil))
        #expect(capabilities.fixture == .tabRepos)
        #expect(capabilities.requestedContentSize == .init(width: 1040, height: 680))
        #expect(capabilities.scrollToVisibleActionAvailable)
        #expect(capabilities.boundaryAdvertisesScrollToVisible == true)
        #expect(capabilities.outerVerticalScrollBarResolved == true)
        #expect(capabilities.outerVerticalScrollBarAdvertisesIncrement == true)
    }

    @Test func recordsScrollToVisibleAsUnavailableBelowMacOS26WithoutInspectingBoundaryActions() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 15,
            boundaryActionNames: nil,
            verticalScrollBarResolved: false,
            scrollBarActionNames: nil,
            scrollToVisibleActionName: nil,
            incrementActionName: "AXIncrement"
        )

        #expect(!capabilities.scrollToVisibleActionAvailable)
        #expect(capabilities.boundaryAdvertisesScrollToVisible == false)
        #expect(capabilities.outerVerticalScrollBarResolved == false)
        #expect(capabilities.outerVerticalScrollBarAdvertisesIncrement == false)
    }

    @Test func requiresActionNamesOnlyForCapabilitiesThatWereAvailableAndResolved() {
        #expect(throws: DesktopReposScrollCapabilityContractError.missingBoundaryActionNames) {
            try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: 26,
                boundaryActionNames: nil,
                verticalScrollBarResolved: false,
                scrollBarActionNames: nil,
                scrollToVisibleActionName: "AXScrollToVisible",
                incrementActionName: "AXIncrement"
            )
        }
        #expect(throws: DesktopReposScrollCapabilityContractError.missingScrollBarActionNames) {
            try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: 26,
                boundaryActionNames: [],
                verticalScrollBarResolved: true,
                scrollBarActionNames: nil,
                scrollToVisibleActionName: "AXScrollToVisible",
                incrementActionName: "AXIncrement"
            )
        }
    }

    @Test func failedAcquisitionUsesExplicitNullCapabilitiesRatherThanFalse() throws {
        let capabilities = DesktopReposScrollCapabilities.failed(
            osMajorVersion: 26,
            reason: .attributeUnavailable
        )
        let data = try JSONEncoder().encode(capabilities)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(object["boundaryAdvertisesScrollToVisible"] is NSNull)
        #expect(object["outerVerticalScrollBarResolved"] is NSNull)
        #expect(object["outerVerticalScrollBarAdvertisesIncrement"] is NSNull)
        #expect(try DesktopReposScrollCapabilities.decode(data: data) == capabilities)
    }

    @Test func wireContractContainsOnlySanitizedCapabilityFacts() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 26,
            boundaryActionNames: ["AXScrollToVisible"],
            verticalScrollBarResolved: true,
            scrollBarActionNames: [],
            scrollToVisibleActionName: "AXScrollToVisible",
            incrementActionName: "AXIncrement"
        )
        let data = try JSONEncoder().encode(capabilities)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(Set(object.keys) == Set([
            "schemaVersion",
            "fixture",
            "requestedContentSize",
            "osMajorVersion",
            "acquisition",
            "scrollToVisibleActionAvailable",
            "boundaryAdvertisesScrollToVisible",
            "outerVerticalScrollBarResolved",
            "outerVerticalScrollBarAdvertisesIncrement"
        ]))
        let text = String(decoding: data, as: UTF8.self)
        #expect(!text.contains("AXScrollToVisible"))
        #expect(!text.contains("AXIncrement"))
        #expect(!text.contains("actionNames"))
        #expect(!text.contains("path"))
        #expect(!text.contains("identifier"))

        var unknown = object
        unknown["rawActions"] = ["must-not-decode"]
        let unknownData = try JSONSerialization.data(withJSONObject: unknown)
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try DesktopReposScrollCapabilities.decode(data: unknownData)
        }

        var wrongTarget = object
        wrongTarget["fixture"] = "tab-providers"
        let wrongTargetData = try JSONSerialization.data(withJSONObject: wrongTarget)
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try DesktopReposScrollCapabilities.decode(data: wrongTargetData)
        }

        var unknownSize = object
        var size = try #require(unknownSize["requestedContentSize"] as? [String: Any])
        size["scale"] = 2
        unknownSize["requestedContentSize"] = size
        let unknownSizeData = try JSONSerialization.data(withJSONObject: unknownSize)
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try DesktopReposScrollCapabilities.decode(data: unknownSizeData)
        }

        let oversized = Data(repeating: 0x20, count: 4_097)
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try DesktopReposScrollCapabilities.decode(data: oversized)
        }
    }
}
