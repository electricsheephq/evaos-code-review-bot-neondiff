import Foundation
import Testing
@testable import NeonDiffDesktopEvaluationSupport

@Suite("Desktop Repositories scroll capabilities")
struct DesktopReposScrollCapabilitiesTests {
    @Test func exposesSDKIndependentPublicScrollToVisibleActionName() {
        #expect(
            DesktopReposScrollCapabilityContract.scrollToVisibleActionName
                == "AXScrollToVisible"
        )
    }

    @Test func reducesMacOS26ActionNamesToSanitizedBooleans() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 26,
            boundaryActionNames: ["AXScrollToVisible", "AXShowMenu"],
            verticalScrollBarResolved: true,
            scrollBarActionNames: ["AXIncrement"],
            incrementPageResolved: true,
            incrementPageActionNames: ["AXPress"],
            scrollToVisibleActionName: "AXScrollToVisible",
            incrementActionName: "AXIncrement",
            pressActionName: "AXPress"
        )

        #expect(capabilities.acquisition == .init(status: .complete, failureReason: nil))
        #expect(capabilities.fixture == .tabRepos)
        #expect(capabilities.requestedContentSize == .init(width: 1040, height: 680))
        #expect(capabilities.scrollToVisibleActionAvailable)
        #expect(capabilities.boundaryAdvertisesScrollToVisible == true)
        #expect(capabilities.outerVerticalScrollBarResolved == true)
        #expect(capabilities.outerVerticalScrollBarAdvertisesIncrement == true)
        #expect(capabilities.outerVerticalIncrementPageResolved == true)
        #expect(capabilities.outerVerticalIncrementPageAdvertisesPress == true)
    }

    @Test func recordsScrollToVisibleAsUnavailableBelowMacOS26WithoutInspectingBoundaryActions() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 15,
            boundaryActionNames: nil,
            verticalScrollBarResolved: false,
            scrollBarActionNames: nil,
            incrementPageResolved: false,
            incrementPageActionNames: nil,
            scrollToVisibleActionName: nil,
            incrementActionName: "AXIncrement",
            pressActionName: "AXPress"
        )

        #expect(!capabilities.scrollToVisibleActionAvailable)
        #expect(capabilities.boundaryAdvertisesScrollToVisible == false)
        #expect(capabilities.outerVerticalScrollBarResolved == false)
        #expect(capabilities.outerVerticalScrollBarAdvertisesIncrement == false)
        #expect(capabilities.outerVerticalIncrementPageResolved == false)
        #expect(capabilities.outerVerticalIncrementPageAdvertisesPress == false)
    }

    @Test func requiresActionNamesOnlyForCapabilitiesThatWereAvailableAndResolved() {
        #expect(throws: DesktopReposScrollCapabilityContractError.missingBoundaryActionNames) {
            try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: 26,
                boundaryActionNames: nil,
                verticalScrollBarResolved: false,
                scrollBarActionNames: nil,
                incrementPageResolved: false,
                incrementPageActionNames: nil,
                scrollToVisibleActionName: "AXScrollToVisible",
                incrementActionName: "AXIncrement",
                pressActionName: "AXPress"
            )
        }
        #expect(throws: DesktopReposScrollCapabilityContractError.missingScrollBarActionNames) {
            try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: 26,
                boundaryActionNames: [],
                verticalScrollBarResolved: true,
                scrollBarActionNames: nil,
                incrementPageResolved: false,
                incrementPageActionNames: nil,
                scrollToVisibleActionName: "AXScrollToVisible",
                incrementActionName: "AXIncrement",
                pressActionName: "AXPress"
            )
        }
        #expect(throws: DesktopReposScrollCapabilityContractError.missingIncrementPageActionNames) {
            try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: 26,
                boundaryActionNames: [],
                verticalScrollBarResolved: true,
                scrollBarActionNames: [],
                incrementPageResolved: true,
                incrementPageActionNames: nil,
                scrollToVisibleActionName: "AXScrollToVisible",
                incrementActionName: "AXIncrement",
                pressActionName: "AXPress"
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
        #expect(object["outerVerticalIncrementPageResolved"] is NSNull)
        #expect(object["outerVerticalIncrementPageAdvertisesPress"] is NSNull)
        #expect(try DesktopReposScrollCapabilities.decode(data: data) == capabilities)
    }

    @Test func wireContractContainsOnlySanitizedCapabilityFacts() throws {
        let capabilities = try DesktopReposScrollCapabilityContract.evaluate(
            osMajorVersion: 26,
            boundaryActionNames: ["AXScrollToVisible"],
            verticalScrollBarResolved: true,
            scrollBarActionNames: [],
            incrementPageResolved: true,
            incrementPageActionNames: [],
            scrollToVisibleActionName: "AXScrollToVisible",
            incrementActionName: "AXIncrement",
            pressActionName: "AXPress"
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
            "outerVerticalScrollBarAdvertisesIncrement",
            "outerVerticalIncrementPageResolved",
            "outerVerticalIncrementPageAdvertisesPress"
        ]))
        let text = String(decoding: data, as: UTF8.self)
        #expect(!text.contains("AXScrollToVisible"))
        #expect(!text.contains("AXIncrement"))
        #expect(!text.contains("AXPress"))
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

    @Test func selectsOnlyOneExactDirectIncrementPageChild() throws {
        let selection = try DesktopReposIncrementPageSelectionContract.select(
            directChildren: [
                .init(role: "AXValueIndicator", subrole: nil),
                .init(role: "AXButton", subrole: "AXDecrementPage"),
                .init(role: "AXButton", subrole: "AXIncrementPage"),
                .init(role: "AXButton", subrole: "AXIncrementArrow")
            ]
        )
        #expect(selection == .directChild(index: 2))
    }

    @Test func arrowsSubstitutionsAndUnknownSubrolesDoNotResolveIncrementPage() throws {
        #expect(try DesktopReposIncrementPageSelectionContract.select(directChildren: [
            .init(role: "AXButton", subrole: "AXIncrementArrow"),
            .init(role: "AXButton", subrole: "AXUnknown")
        ]) == .unsupported)
        #expect(try DesktopReposIncrementPageSelectionContract.select(directChildren: []) == .unsupported)
    }

    @Test func incrementPageSelectionFailsClosedOnMalformedOrDuplicateChildren() {
        #expect(throws: DesktopReposIncrementPageSelectionError.missingRole) {
            try DesktopReposIncrementPageSelectionContract.select(directChildren: [
                .init(role: nil, subrole: "AXIncrementPage")
            ])
        }
        #expect(throws: DesktopReposIncrementPageSelectionError.missingSubrole) {
            try DesktopReposIncrementPageSelectionContract.select(directChildren: [
                .init(role: "AXButton", subrole: nil)
            ])
        }
        #expect(throws: DesktopReposIncrementPageSelectionError.invalidIncrementPageRole) {
            try DesktopReposIncrementPageSelectionContract.select(directChildren: [
                .init(role: "AXCheckBox", subrole: "AXIncrementPage")
            ])
        }
        #expect(throws: DesktopReposIncrementPageSelectionError.duplicateIncrementPage) {
            try DesktopReposIncrementPageSelectionContract.select(directChildren: [
                .init(role: "AXButton", subrole: "AXIncrementPage"),
                .init(role: "AXButton", subrole: "AXIncrementPage")
            ])
        }
    }

    @Test func capabilityCrossFieldsRejectPageWithoutScrollbarAndPressWithoutPage() {
        let base = DesktopReposScrollCapabilities(
            osMajorVersion: 26,
            acquisition: .init(status: .complete, failureReason: nil),
            scrollToVisibleActionAvailable: true,
            boundaryAdvertisesScrollToVisible: false,
            outerVerticalScrollBarResolved: false,
            outerVerticalScrollBarAdvertisesIncrement: false,
            outerVerticalIncrementPageResolved: true,
            outerVerticalIncrementPageAdvertisesPress: false
        )
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try base.validated()
        }
        let pressWithoutPage = DesktopReposScrollCapabilities(
            osMajorVersion: 26,
            acquisition: .init(status: .complete, failureReason: nil),
            scrollToVisibleActionAvailable: true,
            boundaryAdvertisesScrollToVisible: false,
            outerVerticalScrollBarResolved: true,
            outerVerticalScrollBarAdvertisesIncrement: false,
            outerVerticalIncrementPageResolved: false,
            outerVerticalIncrementPageAdvertisesPress: true
        )
        #expect(throws: DesktopReposScrollCapabilitiesValidationError.invalidContract) {
            try pressWithoutPage.validated()
        }
    }
}
