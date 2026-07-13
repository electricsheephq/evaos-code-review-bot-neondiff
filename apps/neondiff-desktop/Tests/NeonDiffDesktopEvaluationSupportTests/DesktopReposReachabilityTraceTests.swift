import Foundation
import Testing
@testable import NeonDiffDesktopEvaluationSupport

@Suite("Desktop Repositories reachability trace")
struct DesktopReposReachabilityTraceTests {
    @Test func acceptsStableReachableTrace() throws {
        let trace = makeTrace()

        #expect(try DesktopReposReachabilityValidator.validate(trace) == .reachable)
        #expect(try DesktopReposReachabilityTrace.decode(data: JSONEncoder().encode(trace)) == trace)
    }

    @Test func schemaRequiresSettledOuterClipAndBoundaryAncestryInEverySample() throws {
        let encoded = try JSONEncoder().encode(makeTrace())
        var object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        for key in ["preScrollSamples", "postScrollSamples"] {
            var samples = try #require(object[key] as? [[String: Any]])
            for index in samples.indices {
                samples[index].removeValue(forKey: "outerClip")
                samples[index].removeValue(forKey: "boundaryScrollAncestorCount")
            }
            object[key] = samples
        }
        let legacy = try JSONSerialization.data(withJSONObject: object)

        #expect(throws: Never.self) {
            try DesktopReposReachabilityTrace.decode(data: encoded)
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: legacy)
        }
    }

    @Test(arguments: [
        DesktopReposReachabilityRegion.table,
        .applyAllowlist,
        .boundaryBody
    ])
    func rejectsMissingSemanticRegion(region: DesktopReposReachabilityRegion) {
        let trace = makeTrace(preSamples: preScrollSamples().map { sample in
            sample.removing(region)
        })

        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(trace)
        }
    }

    @Test func rejectsNonfiniteAndDuplicateRegions() {
        var samples = preScrollSamples()
        samples[0] = DesktopReposReachabilitySample(
            elapsedMilliseconds: 0,
            viewport: .init(x: 0, y: 0, width: .infinity, height: 680),
            outerClip: samples[0].outerClip,
            boundaryScrollAncestorCount: samples[0].boundaryScrollAncestorCount,
            regions: samples[0].regions + [samples[0].regions[0]]
        )
        let trace = makeTrace(preSamples: samples)

        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(trace)
        }
    }

    @Test func rejectsFewerThanThreeSamplesAndDriftAboveOnePoint() {
        let tooFew = makeTrace(preSamples: Array(preScrollSamples().prefix(2)))
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(tooFew)
        }

        var drifting = preScrollSamples()
        drifting[2] = drifting[2].replacing(
            .table,
            frame: .init(x: 24, y: 24, width: 901.01, height: 360)
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(preSamples: drifting))
        }
    }

    @Test func rejectsWrongFixtureSizeReadinessCadenceWindowOrTolerance() {
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(ready: false))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(quiescent: false))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                requestedContentSize: .init(width: 1280, height: 800)
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                preScrollAcquisitionMilliseconds: 5_001
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                postScrollAcquisitionMilliseconds: 5_001
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(tolerancePoints: 1.01))
        }

        var wrongCadence = preScrollSamples()
        wrongCadence[2] = DesktopReposReachabilitySample(
            elapsedMilliseconds: 301,
            viewport: wrongCadence[2].viewport,
            outerClip: wrongCadence[2].outerClip,
            boundaryScrollAncestorCount: wrongCadence[2].boundaryScrollAncestorCount,
            regions: wrongCadence[2].regions
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(preSamples: wrongCadence))
        }

        let latePost = stableSamples().enumerated().map { index, sample in
            DesktopReposReachabilitySample(
                elapsedMilliseconds: 4_900 + index * 100,
                viewport: sample.viewport,
                outerClip: sample.outerClip,
                boundaryScrollAncestorCount: sample.boundaryScrollAncestorCount,
                regions: sample.regions
            )
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: latePost))
        }
    }

    @Test func rejectsFailedAcquisitionOrInvalidPressContract() {
        let incomplete = makeTrace(
            quiescent: false,
            preScrollAcquisitionMilliseconds: 5_001,
            postScrollAcquisitionMilliseconds: 5_001,
            acquisition: .init(status: .failed, failureReason: .cannotComplete),
            preSamples: [],
            scrollInteraction: nil,
            postSamples: []
        )
        #expect(throws: DesktopReposReachabilityValidationError.acquisitionFailed(.cannotComplete)) {
            try DesktopReposReachabilityValidator.validate(incomplete)
        }
        #expect(throws: DesktopReposReachabilityValidationError.acquisitionFailed(.semanticDuplicate)) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                acquisition: .init(status: .failed, failureReason: .semanticDuplicate)
            ))
        }

        #expect(throws: DesktopReposReachabilityValidationError.actionNotAdvertised) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(
                    actionAdvertised: false,
                    attemptCount: 0,
                    performResult: nil,
                    clipAfter: nil
                )
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(
                    actionAdvertised: false,
                    attemptCount: 2,
                    performResult: .success
                )
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.actionPerformFailed(.cannotComplete)) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(performResult: .cannotComplete)
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.actionPerformFailed(.actionUnsupported)) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(performResult: .actionUnsupported)
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(attemptCount: 0)
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(attemptCount: -1)
            ))
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(attemptCount: 2)
            ))
        }
    }

    @Test func successfulPressLedgerSurvivesPostActionAcquisitionFailures() throws {
        for reason in [
            DesktopReposReachabilityAcquisitionFailureReason.cannotComplete,
            .invalidElement,
            .permissionDenied,
            .invalidType,
            .ancestryUnavailable,
            .semanticChanged
        ] {
            let trace = makeTrace(
                quiescent: false,
                acquisition: .init(status: .failed, failureReason: reason),
                scrollInteraction: makeInteraction(clipAfter: nil),
                postSamples: []
            )
            let data = try JSONEncoder().encode(trace)
            let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let interaction = try #require(object["scrollInteraction"] as? [String: Any])
            let press = try #require(interaction["incrementPagePress"] as? [String: Any])

            #expect(press["attemptCount"] as? Int == 1)
            #expect(press["performResult"] as? String == "success")
            #expect(press["outerClipAfter"] is NSNull)
            #expect(throws: DesktopReposReachabilityValidationError.acquisitionFailed(reason)) {
                try DesktopReposReachabilityValidator.validate(trace)
            }
        }
    }

    @Test func checkerResultsClassifyActionGeometryAcquisitionAndContractFailures() throws {
        let cases: [(DesktopReposReachabilityValidationError, DesktopReposReachabilityCheckCategory, String)] = [
            (.actionNotAdvertised, .action, "action-not-advertised"),
            (.actionPerformFailed(.cannotComplete), .action, "action-perform-cannot-complete"),
            (.noUpwardMovement, .geometry, "no-upward-movement"),
            (.nonRigidMovement, .geometry, "non-rigid-movement"),
            (.pressInsufficient(.applyAllowlist), .geometry, "press-insufficient-apply-allowlist"),
            (.unstableOuterClip, .geometry, "unstable-outer-clip"),
            (.unstableScrollAncestry, .geometry, "unstable-scroll-ancestry"),
            (.acquisitionFailed(.semanticChanged), .acquisition, "acquisition-semantic-changed"),
            (.invalidContract, .contract, "invalid-contract")
        ]

        for (error, category, reasonCode) in cases {
            let result = DesktopReposReachabilityCheckResult.failure(error)
            #expect(result.schemaVersion == 1)
            #expect(!result.ok)
            #expect(result.status == .failed)
            #expect(result.category == category)
            #expect(result.reasonCode == reasonCode)
            let object = try #require(
                JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any]
            )
            #expect(Set(object.keys) == ["schemaVersion", "ok", "status", "category", "reasonCode"])
        }

        let success = DesktopReposReachabilityCheckResult.reachable
        #expect(success.ok)
        #expect(success.status == .reachable)
        #expect(success.category == .none)
        #expect(success.reasonCode == "none")
    }

    @Test func rejectsNoWrongOrNonrigidMovement() {
        #expect(throws: DesktopReposReachabilityValidationError.noUpwardMovement) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: preScrollSamples()))
        }
        let downward = preScrollSamples().map { $0.translated(y: 20) }
        #expect(throws: DesktopReposReachabilityValidationError.noUpwardMovement) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: downward))
        }
        let onlyTable = preScrollSamples().map {
            $0.replacing(.table, frame: .init(x: 24, y: 0, width: 900, height: 360))
        }
        #expect(throws: DesktopReposReachabilityValidationError.nonRigidMovement) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: onlyTable))
        }
        for frame in [
            DesktopReposReachabilityFrame(x: 26, y: 500, width: 180, height: 30),
            .init(x: 24, y: 500, width: 182, height: 30),
            .init(x: 24, y: 500, width: 180, height: 32)
        ] {
            let nonRigid = stableSamples().map { $0.replacing(.applyAllowlist, frame: frame) }
            #expect(throws: DesktopReposReachabilityValidationError.nonRigidMovement) {
                try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: nonRigid))
            }
        }
    }

    @Test func requiresRigidUpwardMovementStrictlyGreaterThanOnePoint() throws {
        let clip = DesktopReposReachabilityFrame(x: 20, y: 50, width: 1000, height: 580)
        let pre = preScrollSamples().map {
            $0
                .replacing(.applyAllowlist, frame: .init(x: 24, y: 600, width: 180, height: 30))
                .replacing(.boundaryBody, frame: .init(x: 24, y: 590.5, width: 760, height: 40))
        }

        #expect(throws: DesktopReposReachabilityValidationError.noUpwardMovement) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                tolerancePoints: 0.1,
                preSamples: pre,
                scrollInteraction: makeInteraction(clipBefore: clip, clipAfter: clip),
                postSamples: pre.map { $0.translated(y: -0.5) }
            ))
        }

        let exactlyOne = pre.map {
            $0.replacing(.boundaryBody, frame: .init(x: 24, y: 591, width: 760, height: 40))
        }
        #expect(throws: DesktopReposReachabilityValidationError.noUpwardMovement) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                tolerancePoints: 0.1,
                preSamples: exactlyOne,
                scrollInteraction: makeInteraction(clipBefore: clip, clipAfter: clip),
                postSamples: exactlyOne.map { $0.translated(y: -1) }
            ))
        }

        let beyondOne = pre.map {
            $0.replacing(.boundaryBody, frame: .init(x: 24, y: 591.1, width: 760, height: 40))
        }
        #expect(try DesktopReposReachabilityValidator.validate(makeTrace(
            tolerancePoints: 0.1,
            preSamples: beyondOne,
            scrollInteraction: makeInteraction(clipBefore: clip, clipAfter: clip),
            postSamples: beyondOne.map { $0.translated(y: -1.1) }
        )) == .reachable)
    }

    @Test func rejectsUnstableWindowClipAndWindowOnlyContainment() throws {
        let movedWindow = stableSamples().map { $0.replacingViewport(.init(x: 2, y: 0, width: 1040, height: 680)) }
        #expect(throws: DesktopReposReachabilityValidationError.unstableWindow) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: movedWindow))
        }
        let cumulativeWindowDrift = zip(stableSamples(), [1.0, 2.0, 2.0]).map { sample, x in
            sample.replacingViewport(.init(x: x, y: 0, width: 1040, height: 680))
        }
        #expect(throws: DesktopReposReachabilityValidationError.unstableWindow) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: cumulativeWindowDrift))
        }
        #expect(throws: DesktopReposReachabilityValidationError.unstableOuterClip) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(clipAfter: .init(x: 22, y: 50, width: 1000, height: 580))
            ))
        }
        let cumulativeClipDrift = zip(stableSamples(), [21.0, 22.0, 22.0]).map { sample, x in
            sample.replacingOuterClip(.init(x: x, y: 50, width: 1000, height: 580))
        }
        #expect(throws: DesktopReposReachabilityValidationError.unstableOuterClip) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                scrollInteraction: makeInteraction(
                    clipAfter: .init(x: 22, y: 50, width: 1000, height: 580)
                ),
                postSamples: cumulativeClipDrift
            ))
        }
        let staleImmediateClip = stableSamples().map {
            $0.replacingOuterClip(.init(x: 20, y: 50, width: 1000, height: 500))
        }
        #expect(throws: DesktopReposReachabilityValidationError.unstableOuterClip) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: staleImmediateClip))
        }
        var changedAncestry = stableSamples()
        changedAncestry[2] = changedAncestry[2].replacingBoundaryScrollAncestorCount(2)
        #expect(throws: DesktopReposReachabilityValidationError.unstableScrollAncestry) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: changedAncestry))
        }
        let onePointWindow = stableSamples().map {
            $0.replacingViewport(.init(x: 1, y: 0, width: 1040, height: 680))
        }
        #expect(try DesktopReposReachabilityValidator.validate(makeTrace(
            scrollInteraction: makeInteraction(
                clipAfter: .init(x: 21, y: 50, width: 1000, height: 580)
            ),
            postSamples: onePointWindow
        )) == .reachable)
        #expect(throws: DesktopReposReachabilityValidationError.outerClipOutsideWindow) {
            let outsideWindowClip = DesktopReposReachabilityFrame(x: -1, y: 50, width: 1000, height: 580)
            _ = try DesktopReposReachabilityValidator.validate(makeTrace(
                preSamples: preScrollSamples().map { $0.replacingOuterClip(outsideWindowClip) },
                scrollInteraction: makeInteraction(
                    clipBefore: outsideWindowClip,
                    clipAfter: outsideWindowClip
                ),
                postSamples: stableSamples().map { $0.replacingOuterClip(outsideWindowClip) }
            ))
        }
        let outsideClip = stableSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 640, width: 180, height: 30))
        }
        let beforeOutsideClip = preScrollSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 740, width: 180, height: 30))
        }
        #expect(throws: DesktopReposReachabilityValidationError.pressInsufficient(.applyAllowlist)) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                preSamples: beforeOutsideClip,
                postSamples: outsideClip
            ))
        }
        let boundaryStillOutside = stableSamples().map {
            $0.replacing(.boundaryBody, frame: .init(x: 24, y: 610, width: 760, height: 40))
        }
        let boundaryBefore = preScrollSamples().map {
            $0.replacing(.boundaryBody, frame: .init(x: 24, y: 710, width: 760, height: 40))
        }
        #expect(throws: DesktopReposReachabilityValidationError.pressInsufficient(.boundaryBody)) {
            try DesktopReposReachabilityValidator.validate(makeTrace(
                preSamples: boundaryBefore,
                postSamples: boundaryStillOutside
            ))
        }
    }

    @Test func rejectsApplyOrBoundaryOutsideViewport() {
        let outsideApply = stableSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 665, width: 180, height: 30))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: outsideApply))
        }

        let outsideBoundary = stableSamples().map {
            $0.replacing(.boundaryBody, frame: .init(x: 24, y: -20, width: 760, height: 40))
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: outsideBoundary))
        }
    }

    @Test func allowsApplyOutsideTheInitialViewportWhenPostScrollSampleIsReachable() throws {
        let preScroll = preScrollSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 640, width: 180, height: 30))
        }
        let postScroll = stableSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 540, width: 180, height: 30))
        }

        #expect(try DesktopReposReachabilityValidator.validate(makeTrace(
            preSamples: preScroll,
            postSamples: postScroll
        )) == .reachable)
    }

    @Test func encodedTraceContainsNoSemanticTextOrPaths() throws {
        let data = try JSONEncoder().encode(makeTrace())
        let text = String(decoding: data, as: UTF8.self)

        #expect(!text.contains("Apply Allowlist"))
        #expect(!text.contains("Repo changes"))
        #expect(!text.contains("/"))
        #expect(!text.contains("identifier"))
    }

    @Test func decodingFailsClosedOnUnknownFields() throws {
        let encoded = try JSONEncoder().encode(makeTrace())
        var object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object["visibleText"] = "must not survive typed decoding"
        let data = try JSONSerialization.data(withJSONObject: object)

        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: data)
        }
    }

    @Test func decodingFailsClosedOnNestedUnknownsAndMissingInactiveNull() throws {
        let encoded = try JSONEncoder().encode(makeTrace())
        let base = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        var unknownAcquisition = base
        var acquisition = try #require(unknownAcquisition["acquisition"] as? [String: Any])
        acquisition["unexpected"] = true
        unknownAcquisition["acquisition"] = acquisition
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(
                data: JSONSerialization.data(withJSONObject: unknownAcquisition)
            )
        }

        var unknownInteraction = base
        var interaction = try #require(unknownInteraction["scrollInteraction"] as? [String: Any])
        interaction["unexpected"] = true
        unknownInteraction["scrollInteraction"] = interaction
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(
                data: JSONSerialization.data(withJSONObject: unknownInteraction)
            )
        }

        var unknownPress = base
        interaction = try #require(unknownPress["scrollInteraction"] as? [String: Any])
        var press = try #require(interaction["incrementPagePress"] as? [String: Any])
        press["unexpected"] = true
        interaction["incrementPagePress"] = press
        unknownPress["scrollInteraction"] = interaction
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: JSONSerialization.data(withJSONObject: unknownPress))
        }

        var missingInactiveNull = base
        interaction = try #require(missingInactiveNull["scrollInteraction"] as? [String: Any])
        interaction.removeValue(forKey: "valueMutation")
        missingInactiveNull["scrollInteraction"] = interaction
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(
                data: JSONSerialization.data(withJSONObject: missingInactiveNull)
            )
        }

        var unknownSample = base
        var samples = try #require(unknownSample["preScrollSamples"] as? [[String: Any]])
        samples[0]["unexpected"] = true
        unknownSample["preScrollSamples"] = samples
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: JSONSerialization.data(withJSONObject: unknownSample))
        }

        var unknownRegion = base
        samples = try #require(unknownRegion["preScrollSamples"] as? [[String: Any]])
        var regions = try #require(samples[0]["regions"] as? [[String: Any]])
        regions[0]["unexpected"] = true
        samples[0]["regions"] = regions
        unknownRegion["preScrollSamples"] = samples
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: JSONSerialization.data(withJSONObject: unknownRegion))
        }

        var unknownFrame = base
        samples = try #require(unknownFrame["preScrollSamples"] as? [[String: Any]])
        regions = try #require(samples[0]["regions"] as? [[String: Any]])
        var frame = try #require(regions[0]["frame"] as? [String: Any])
        frame["unexpected"] = true
        regions[0]["frame"] = frame
        samples[0]["regions"] = regions
        unknownFrame["preScrollSamples"] = samples
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: JSONSerialization.data(withJSONObject: unknownFrame))
        }
    }

    @Test func interactionHasExplicitInactiveValueMutationAndUnambiguousPressBranch() throws {
        let data = try JSONEncoder().encode(makeTrace())
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let acquisition = try #require(object["acquisition"] as? [String: Any])
        let interaction = try #require(object["scrollInteraction"] as? [String: Any])

        #expect(interaction["mechanism"] as? String == "increment-page-press")
        #expect(interaction["valueMutation"] is NSNull)
        #expect(interaction["incrementPagePress"] is [String: Any])
        #expect(acquisition.keys.contains("failureReason"))
        #expect(acquisition["failureReason"] is NSNull)

        let failedData = try JSONEncoder().encode(makeTrace(
            acquisition: .init(status: .failed, failureReason: .cannotComplete),
            scrollInteraction: nil
        ))
        let failedObject = try #require(JSONSerialization.jsonObject(with: failedData) as? [String: Any])
        let failedAcquisition = try #require(failedObject["acquisition"] as? [String: Any])
        #expect(failedAcquisition["failureReason"] as? String == "cannot-complete")

        var ambiguous = object
        var ambiguousAcquisition = acquisition
        ambiguousAcquisition.removeValue(forKey: "failureReason")
        ambiguous["acquisition"] = ambiguousAcquisition
        let ambiguousData = try JSONSerialization.data(withJSONObject: ambiguous)
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(data: ambiguousData)
        }

        var inactiveBranch = object
        var invalidInteraction = interaction
        invalidInteraction["valueMutation"] = ["forbidden": true]
        inactiveBranch["scrollInteraction"] = invalidInteraction
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityTrace.decode(
                data: JSONSerialization.data(withJSONObject: inactiveBranch)
            )
        }
    }

    @Test func focusedCaptureTargetRejectsUnsupportedFixtureOrSize() throws {
        #expect(throws: DesktopReposReachabilityTargetError.unsupportedTarget) {
            try DesktopReposReachabilityTarget.requireSupported(
                fixtureId: "tab-providers",
                contentWidth: 1040,
                contentHeight: 680
            )
        }
        #expect(throws: DesktopReposReachabilityTargetError.unsupportedTarget) {
            try DesktopReposReachabilityTarget.requireSupported(
                fixtureId: "tab-repos",
                contentWidth: 1280,
                contentHeight: 800
            )
        }
        #expect(try DesktopReposReachabilityTarget.requireSupported(
            fixtureId: "tab-repos",
            contentWidth: 1040,
            contentHeight: 680
        ) == .tabRepos1040x680)
    }

    @Test func malformedMetadataIsNotMaskedByAcquisitionFailure() {
        let trace = makeTrace(
            schemaVersion: 999,
            acquisition: .init(status: .failed, failureReason: .cannotComplete),
            preSamples: [],
            scrollInteraction: nil,
            postSamples: []
        )

        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(trace)
        }
    }

    @Test func semanticFallbackMatchesRenderedAccessibilityValueExactly() {
        #expect(DesktopReposReachabilitySemanticContract.boundaryIdentifier == "neondiff-repos-boundary")
        #expect(DesktopReposReachabilitySemanticContract.applyAllowlistIdentifier == "neondiff-repo-apply-patch")
        #expect(
            DesktopReposReachabilitySemanticContract.boundaryValue
                == "Repo changes are written through config patch only; the desktop does not post reviews or bypass daemon gates."
        )
        #expect(DesktopReposReachabilitySemanticContract.applyAllowlistValue == "Apply Allowlist")
        #expect(DesktopReposReachabilitySemanticContract.matchesApplyAllowlist(
            isButton: true,
            identifier: "neondiff-repo-apply-patch",
            title: nil,
            description: nil,
            value: nil
        ))
        #expect(DesktopReposReachabilitySemanticContract.matchesApplyAllowlist(
            isButton: true,
            identifier: nil,
            title: "Apply Allowlist",
            description: nil,
            value: nil
        ))
        #expect(!DesktopReposReachabilitySemanticContract.matchesApplyAllowlist(
            isButton: false,
            identifier: "neondiff-repo-apply-patch",
            title: "Apply Allowlist",
            description: nil,
            value: nil
        ))
        #expect(DesktopReposReachabilitySemanticContract.matchesBoundaryBody(
            isStaticText: true,
            identifier: "neondiff-repos-boundary",
            description: nil,
            value: nil
        ))
        #expect(!DesktopReposReachabilitySemanticContract.matchesBoundaryBody(
            isStaticText: false,
            identifier: "neondiff-repos-boundary",
            description: nil,
            value: nil
        ))
    }

    @Test func semanticCandidateCardinalityFailsClosed() {
        #expect(DesktopReposReachabilitySemanticContract.tableRole == "AXOutline")
        #expect(DesktopReposReachabilitySemanticContract.matchesTable(role: "AXOutline"))
        #expect(!DesktopReposReachabilitySemanticContract.matchesTable(role: "AXTable"))
        #expect(!DesktopReposReachabilitySemanticContract.matchesTable(role: "AXScrollArea"))
        #expect(DesktopReposReachabilitySemanticContract.failureReason(
            tableCount: 1,
            applyAllowlistCount: 1,
            boundaryBodyCount: 1
        ) == nil)
        #expect(DesktopReposReachabilitySemanticContract.failureReason(
            tableCount: 2,
            applyAllowlistCount: 1,
            boundaryBodyCount: 1
        ) == .semanticDuplicate)
        #expect(DesktopReposReachabilitySemanticContract.failureReason(
            tableCount: 1,
            applyAllowlistCount: 0,
            boundaryBodyCount: 1
        ) == .semanticMissing)
    }

    @Test func stableCadenceRequiresThreeScheduledSamplesWithinBounds() {
        #expect(DesktopReposReachabilitySamplingContract.hasStableCadence([0, 100, 200]))
        #expect(!DesktopReposReachabilitySamplingContract.hasStableCadence([0, 100, 423]))
        #expect(!DesktopReposReachabilitySamplingContract.hasStableCadence([0, 100]))

        let delayed = zip(stableSamples(), [0, 100, 423]).map { sample, elapsed in
            DesktopReposReachabilitySample(
                elapsedMilliseconds: elapsed,
                viewport: sample.viewport,
                outerClip: sample.outerClip,
                boundaryScrollAncestorCount: sample.boundaryScrollAncestorCount,
                regions: sample.regions
            )
        }
        #expect(throws: DesktopReposReachabilityValidationError.invalidContract) {
            try DesktopReposReachabilityValidator.validate(makeTrace(preSamples: delayed))
        }
    }

    @Test func verticalScrollBarSelectionPrefersTheConvenienceAttribute() throws {
        let selection = try DesktopReposVerticalScrollBarSelectionContract.select(
            convenienceCandidate: .init(role: "AXScrollBar", orientation: "AXVerticalOrientation"),
            directChildren: [
                .init(role: nil, orientation: nil),
                .init(role: "AXScrollBar", orientation: "AXVerticalOrientation")
            ]
        )

        #expect(selection == .convenienceAttribute)
    }

    @Test func verticalScrollBarSelectionAcceptsOneExactDirectChild() throws {
        let selection = try DesktopReposVerticalScrollBarSelectionContract.select(
            convenienceCandidate: nil,
            directChildren: [
                .init(role: "AXGroup", orientation: nil),
                .init(role: "AXScrollBar", orientation: "AXHorizontalOrientation"),
                .init(role: "AXScrollBar", orientation: "AXVerticalOrientation")
            ]
        )

        #expect(selection == .directChild(index: 2))
    }

    @Test func verticalScrollBarSelectionRejectsHorizontalAndCannotSeeNestedDescendants() throws {
        #expect(try DesktopReposVerticalScrollBarSelectionContract.select(
            convenienceCandidate: nil,
            directChildren: [.init(role: "AXScrollBar", orientation: "AXHorizontalOrientation")]
        ) == .unsupported)

        // A group may contain a nested scrollbar in the real AX tree, but the
        // strict contract deliberately receives direct children only.
        #expect(try DesktopReposVerticalScrollBarSelectionContract.select(
            convenienceCandidate: nil,
            directChildren: [.init(role: "AXGroup", orientation: nil)]
        ) == .unsupported)
    }

    @Test func verticalScrollBarSelectionFailsClosedOnAmbiguousDirectChildren() {
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.ambiguousVerticalChildren) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: nil,
                directChildren: [
                    .init(role: "AXScrollBar", orientation: "AXVerticalOrientation"),
                    .init(role: "AXScrollBar", orientation: "AXVerticalOrientation")
                ]
            )
        }
    }

    @Test func verticalScrollBarSelectionFailsClosedOnMalformedRoleOrOrientation() {
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.missingRole) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: nil,
                directChildren: [.init(role: nil, orientation: nil)]
            )
        }
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.missingOrientation) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: nil,
                directChildren: [.init(role: "AXScrollBar", orientation: nil)]
            )
        }
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.invalidOrientation) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: nil,
                directChildren: [.init(role: "AXScrollBar", orientation: "AXDiagonalOrientation")]
            )
        }
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.invalidRole) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: .init(role: "AXGroup", orientation: "AXVerticalOrientation"),
                directChildren: []
            )
        }
        #expect(throws: DesktopReposVerticalScrollBarSelectionError.invalidOrientation) {
            try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: .init(role: "AXScrollBar", orientation: "AXHorizontalOrientation"),
                directChildren: []
            )
        }
    }
}

private func makeTrace(
    schemaVersion: Int = 2,
    ready: Bool = true,
    quiescent: Bool = true,
    requestedContentSize: DesktopEvaluationContentSize = .init(width: 1040, height: 680),
    preScrollAcquisitionMilliseconds: Int = 200,
    postScrollAcquisitionMilliseconds: Int = 200,
    tolerancePoints: Double = 1,
    acquisition: DesktopReposReachabilityAcquisition = .init(status: .complete, failureReason: nil),
    preSamples: [DesktopReposReachabilitySample] = preScrollSamples(),
    scrollInteraction: DesktopReposScrollInteraction? = makeInteraction(),
    postSamples: [DesktopReposReachabilitySample] = stableSamples()
) -> DesktopReposReachabilityTrace {
    DesktopReposReachabilityTrace(
        schemaVersion: schemaVersion,
        fixture: .tabRepos,
        ready: ready,
        quiescent: quiescent,
        requestedContentSize: requestedContentSize,
        sampleIntervalMilliseconds: 100,
        preScrollAcquisitionMilliseconds: preScrollAcquisitionMilliseconds,
        postScrollAcquisitionMilliseconds: postScrollAcquisitionMilliseconds,
        tolerancePoints: tolerancePoints,
        acquisition: acquisition,
        preScrollSamples: preSamples,
        scrollInteraction: scrollInteraction,
        postScrollSamples: postSamples
    )
}

private func makeInteraction(
    actionAdvertised: Bool = true,
    attemptCount: Int = 1,
    performResult: DesktopReposScrollActionResult? = .success,
    clipBefore: DesktopReposReachabilityFrame = .init(x: 20, y: 50, width: 1000, height: 580),
    clipAfter: DesktopReposReachabilityFrame? = .init(x: 20, y: 50, width: 1000, height: 580)
) -> DesktopReposScrollInteraction {
    .init(
        mechanism: .incrementPagePress,
        incrementPagePress: .init(
            actionAdvertised: actionAdvertised,
            attemptCount: attemptCount,
            performResult: performResult,
            outerClipBefore: clipBefore,
            outerClipAfter: clipAfter
        ),
        valueMutation: nil
    )
}

private func preScrollSamples() -> [DesktopReposReachabilitySample] {
    (0..<3).map { index in
        DesktopReposReachabilitySample(
            elapsedMilliseconds: index * 100,
            viewport: .init(x: 0, y: 0, width: 1040, height: 680),
            outerClip: .init(x: 20, y: 50, width: 1000, height: 580),
            boundaryScrollAncestorCount: 1,
            regions: [
                .init(id: .table, frame: .init(x: 24, y: 100, width: 900, height: 360)),
                .init(id: .applyAllowlist, frame: .init(x: 24, y: 600, width: 180, height: 30)),
                .init(id: .boundaryBody, frame: .init(x: 24, y: 650, width: 760, height: 40))
            ]
        )
    }
}

private func stableSamples() -> [DesktopReposReachabilitySample] {
    (0..<3).map { index in
        DesktopReposReachabilitySample(
            elapsedMilliseconds: index * 100,
            viewport: .init(x: 0, y: 0, width: 1040, height: 680),
            outerClip: .init(x: 20, y: 50, width: 1000, height: 580),
            boundaryScrollAncestorCount: 1,
            regions: [
                .init(id: .table, frame: .init(x: 24, y: 0, width: 900, height: 360)),
                .init(id: .applyAllowlist, frame: .init(x: 24, y: 500, width: 180, height: 30)),
                .init(id: .boundaryBody, frame: .init(x: 24, y: 550, width: 760, height: 40))
            ]
        )
    }
}

private extension DesktopReposReachabilitySample {
    func translated(y delta: Double) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            outerClip: outerClip,
            boundaryScrollAncestorCount: boundaryScrollAncestorCount,
            regions: regions.map { region in
                .init(id: region.id, frame: .init(
                    x: region.frame.x,
                    y: region.frame.y + delta,
                    width: region.frame.width,
                    height: region.frame.height
                ))
            }
        )
    }

    func replacingViewport(_ frame: DesktopReposReachabilityFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: frame,
            outerClip: outerClip,
            boundaryScrollAncestorCount: boundaryScrollAncestorCount,
            regions: regions
        )
    }

    func replacingOuterClip(_ frame: DesktopReposReachabilityFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            outerClip: frame,
            boundaryScrollAncestorCount: boundaryScrollAncestorCount,
            regions: regions
        )
    }

    func replacingBoundaryScrollAncestorCount(_ count: Int) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            outerClip: outerClip,
            boundaryScrollAncestorCount: count,
            regions: regions
        )
    }

    func removing(_ id: DesktopReposReachabilityRegion) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            outerClip: outerClip,
            boundaryScrollAncestorCount: boundaryScrollAncestorCount,
            regions: regions.filter { $0.id != id }
        )
    }

    func replacing(_ id: DesktopReposReachabilityRegion, frame: DesktopReposReachabilityFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            outerClip: outerClip,
            boundaryScrollAncestorCount: boundaryScrollAncestorCount,
            regions: regions.map { region in
                region.id == id ? .init(id: id, frame: frame) : region
            }
        )
    }
}
