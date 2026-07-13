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

    @Test(arguments: [
        DesktopReposReachabilityRegion.table,
        .applyAllowlist,
        .boundaryBody
    ])
    func rejectsMissingSemanticRegion(region: DesktopReposReachabilityRegion) {
        let trace = makeTrace(preSamples: stableSamples().map { sample in
            sample.removing(region)
        })

        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(trace)
        }
    }

    @Test func rejectsNonfiniteAndDuplicateRegions() {
        var samples = stableSamples()
        samples[0] = DesktopReposReachabilitySample(
            elapsedMilliseconds: 0,
            viewport: .init(x: 0, y: 0, width: .infinity, height: 680),
            regions: samples[0].regions + [samples[0].regions[0]]
        )
        let trace = makeTrace(preSamples: samples)

        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(trace)
        }
    }

    @Test func rejectsFewerThanThreeSamplesAndDriftAboveOnePoint() {
        let tooFew = makeTrace(preSamples: Array(stableSamples().prefix(2)))
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(tooFew)
        }

        var drifting = stableSamples()
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

        var wrongCadence = stableSamples()
        wrongCadence[2] = DesktopReposReachabilitySample(
            elapsedMilliseconds: 301,
            viewport: wrongCadence[2].viewport,
            regions: wrongCadence[2].regions
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(preSamples: wrongCadence))
        }

        let latePost = stableSamples().enumerated().map { index, sample in
            DesktopReposReachabilitySample(
                elapsedMilliseconds: 4_900 + index * 100,
                viewport: sample.viewport,
                regions: sample.regions
            )
        }
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(postSamples: latePost))
        }
    }

    @Test func rejectsMissingOrUnsupportedOuterScroll() {
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(outerScroll: nil))
        }
        #expect(throws: DesktopReposReachabilityValidationError.missingOuterScroll) {
            try DesktopReposReachabilityTrace.decode(data: JSONEncoder().encode(makeTrace(outerScroll: nil)))
        }

        let incomplete = makeTrace(
            quiescent: false,
            preScrollAcquisitionMilliseconds: 5_001,
            postScrollAcquisitionMilliseconds: 5_001,
            acquisition: .init(status: .failed, failureReason: .cannotComplete),
            preSamples: [],
            outerScroll: nil,
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

        let unsupported = DesktopReposOuterScrollObservation(
            verticalScrollBarSupported: false,
            minimumValue: nil,
            maximumValue: nil,
            valueBeforeScroll: nil,
            valueAfterScroll: nil,
            setToMaximumSucceeded: false
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(outerScroll: unsupported))
        }

        let noMovement = DesktopReposOuterScrollObservation(
            verticalScrollBarSupported: true,
            minimumValue: 0,
            maximumValue: 1,
            valueBeforeScroll: 0,
            valueAfterScroll: 0,
            setToMaximumSucceeded: true
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(outerScroll: noMovement))
        }

        let noRange = DesktopReposOuterScrollObservation(
            verticalScrollBarSupported: true,
            minimumValue: 1,
            maximumValue: 1,
            valueBeforeScroll: 1,
            valueAfterScroll: 1,
            setToMaximumSucceeded: true
        )
        #expect(throws: DesktopReposReachabilityValidationError.self) {
            try DesktopReposReachabilityValidator.validate(makeTrace(outerScroll: noRange))
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
        let preScroll = stableSamples().map {
            $0.replacing(.applyAllowlist, frame: .init(x: 24, y: 700, width: 180, height: 30))
        }

        #expect(try DesktopReposReachabilityValidator.validate(makeTrace(preSamples: preScroll)) == .reachable)
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

    @Test func nilOuterScrollHasAnExplicitUnambiguousWireKey() throws {
        let data = try JSONEncoder().encode(makeTrace(outerScroll: nil))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let acquisition = try #require(object["acquisition"] as? [String: Any])

        #expect(object.keys.contains("outerScroll"))
        #expect(object["outerScroll"] is NSNull)
        #expect(acquisition.keys.contains("failureReason"))
        #expect(acquisition["failureReason"] is NSNull)

        let failedData = try JSONEncoder().encode(makeTrace(
            acquisition: .init(status: .failed, failureReason: .cannotComplete),
            outerScroll: nil
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
            outerScroll: nil,
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
}

private func makeTrace(
    schemaVersion: Int = 1,
    ready: Bool = true,
    quiescent: Bool = true,
    requestedContentSize: DesktopEvaluationContentSize = .init(width: 1040, height: 680),
    preScrollAcquisitionMilliseconds: Int = 200,
    postScrollAcquisitionMilliseconds: Int = 200,
    tolerancePoints: Double = 1,
    acquisition: DesktopReposReachabilityAcquisition = .init(status: .complete, failureReason: nil),
    preSamples: [DesktopReposReachabilitySample] = stableSamples(),
    outerScroll: DesktopReposOuterScrollObservation? = .init(
        verticalScrollBarSupported: true,
        minimumValue: 0,
        maximumValue: 1,
        valueBeforeScroll: 0,
        valueAfterScroll: 1,
        setToMaximumSucceeded: true
    ),
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
        outerScroll: outerScroll,
        postScrollSamples: postSamples
    )
}

private func stableSamples() -> [DesktopReposReachabilitySample] {
    (0..<3).map { index in
        DesktopReposReachabilitySample(
            elapsedMilliseconds: index * 100,
            viewport: .init(x: 0, y: 0, width: 1040, height: 680),
            regions: [
                .init(id: .table, frame: .init(x: 24, y: 100, width: 900, height: 360)),
                .init(id: .applyAllowlist, frame: .init(x: 24, y: 500, width: 180, height: 30)),
                .init(id: .boundaryBody, frame: .init(x: 24, y: 600, width: 760, height: 40))
            ]
        )
    }
}

private extension DesktopReposReachabilitySample {
    func removing(_ id: DesktopReposReachabilityRegion) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            regions: regions.filter { $0.id != id }
        )
    }

    func replacing(_ id: DesktopReposReachabilityRegion, frame: DesktopReposReachabilityFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            regions: regions.map { region in
                region.id == id ? .init(id: id, frame: frame) : region
            }
        )
    }
}
