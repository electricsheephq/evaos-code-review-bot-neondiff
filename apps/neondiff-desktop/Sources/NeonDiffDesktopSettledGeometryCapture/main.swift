import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import NeonDiffDesktopCore
import NeonDiffDesktopEvaluationSupport

private enum CaptureFailure: Error {
    case usage
    case unsafeInput
    case invalidReady
    case permissionDenied
    case messagingTimeoutUnavailable
    case windowMismatch
    case semanticMissing
    case semanticDuplicate
    case semanticChanged
    case invalidType
    case acquisitionTimeout
    case actionUnavailable
    case actionFailed
    case outputFailed

    var reasonCode: String {
        switch self {
        case .usage: "usage"
        case .unsafeInput: "unsafe-input"
        case .invalidReady: "invalid-ready"
        case .permissionDenied: "permission-denied"
        case .messagingTimeoutUnavailable: "messaging-timeout-unavailable"
        case .windowMismatch: "window-mismatch"
        case .semanticMissing: "semantic-missing"
        case .semanticDuplicate: "semantic-duplicate"
        case .semanticChanged: "semantic-changed"
        case .invalidType: "invalid-type"
        case .acquisitionTimeout: "acquisition-timeout"
        case .actionUnavailable: "action-unavailable"
        case .actionFailed: "action-failed"
        case .outputFailed: "output-failed"
        }
    }
}

private struct ReadyDocument: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let pid: Int32
    let windowNumber: Int
    let windowFrame: DesktopSettledGeometryFrame
    let contentFrame: DesktopSettledGeometryFrame
    let backingScale: Double
    let ready: Bool
}

private struct Options {
    let pid: Int32
    let readyURL: URL
    let outputURL: URL

    static func parse(_ arguments: [String]) throws -> Self {
        func rawValue(_ flag: String) throws -> String {
            guard arguments.filter({ $0 == flag }).count == 1,
                  let index = arguments.firstIndex(of: flag),
                  arguments.indices.contains(index + 1),
                  !arguments[index + 1].hasPrefix("--") else {
                throw CaptureFailure.usage
            }
            return arguments[index + 1]
        }
        guard arguments.count == 7,
              let pid = Int32(try rawValue("--pid")),
              pid > 0 else {
            throw CaptureFailure.usage
        }
        let readyURL = try canonicalAbsoluteURL(try rawValue("--ready"))
        let outputURL = try canonicalAbsoluteURL(try rawValue("--output"))
        guard readyURL.lastPathComponent == "ready.json",
              outputURL.lastPathComponent == "settled-geometry.json" else {
            throw CaptureFailure.unsafeInput
        }
        return Self(pid: pid, readyURL: readyURL, outputURL: outputURL)
    }

    private static func canonicalAbsoluteURL(_ raw: String) throws -> URL {
        guard !raw.contains("\0"), NSString(string: raw).isAbsolutePath else {
            throw CaptureFailure.unsafeInput
        }
        let standardized = URL(fileURLWithPath: raw).standardizedFileURL
        guard standardized.isFileURL,
              standardized.path.hasPrefix("/"),
              standardized.path == raw else {
            throw CaptureFailure.unsafeInput
        }
        return standardized
    }
}

private struct SettledGeometryRunner {
    private static let tolerance = 1.0
    private static let sampleIntervalMilliseconds = 100
    private static let maximumAcquisitionMilliseconds = 5_000

    let options: Options

    func run() throws -> DesktopSettledGeometryTrace {
        let ready = try loadReady()
        guard AXIsProcessTrusted() else { throw CaptureFailure.permissionDenied }
        let systemWide = AXUIElementCreateSystemWide()
        guard AXUIElementSetMessagingTimeout(systemWide, 1.0) == .success else {
            throw CaptureFailure.messagingTimeoutUnavailable
        }
        defer { _ = AXUIElementSetMessagingTimeout(systemWide, 0) }

        var coordinator = DesktopSettledGeometryScenarioCoordinator(
            scenario: .overviewReposOverview
        )
        var checkpoints: [DesktopSettledGeometryCheckpoint] = []
        var actions: [DesktopSettledGeometryNavigationAction] = []

        for (index, section) in DesktopSettledGeometryScenario.overviewReposOverview.sections.enumerated() {
            let checkpoint = try acquireCheckpoint(index: index, section: section, ready: ready)
            checkpoints.append(checkpoint)
            switch try coordinator.recordQuiescent(section: section) {
            case .navigate(let nextSection):
                actions.append(try performNavigation(
                    index: actions.count,
                    from: section,
                    to: nextSection,
                    ready: ready
                ))
            case .complete:
                break
            }
        }
        guard coordinator.isComplete else { throw CaptureFailure.invalidType }

        let trace = DesktopSettledGeometryTrace(
            schemaVersion: 1,
            scenario: .overviewReposOverview,
            fixtureId: ready.fixtureId,
            pid: ready.pid,
            windowNumber: ready.windowNumber,
            coordinateSpace: .globalTopLeft,
            requestedContentSize: .init(width: 1040, height: 680),
            tolerancePoints: Self.tolerance,
            sampleIntervalMilliseconds: Self.sampleIntervalMilliseconds,
            navigationActions: actions,
            checkpoints: checkpoints
        )
        do {
            _ = try DesktopSettledGeometryValidator.validate(trace)
        } catch {
            throw CaptureFailure.invalidType
        }
        try write(trace)
        return trace
    }

    private func loadReady() throws -> ReadyDocument {
        try requireRegularNonSymlink(options.readyURL)
        try requirePrivateDirectory(options.outputURL.deletingLastPathComponent())
        guard !pathEntryExists(options.outputURL) else { throw CaptureFailure.unsafeInput }
        let data = try Data(contentsOf: options.readyURL, options: [.mappedIfSafe])
        guard data.count <= 64 * 1024,
              strictReadyShape(data),
              let ready = try? JSONDecoder().decode(ReadyDocument.self, from: data),
              ready.schemaVersion == 1,
              ready.fixtureId == "tab-overview",
              ready.pid == options.pid,
              ready.pid > 0,
              ready.windowNumber > 0,
              ready.windowNumber <= Int(CGWindowID.max),
              ready.ready,
              ready.backingScale.isFinite,
              ready.backingScale > 0,
              abs(ready.contentFrame.width - 1040) <= Self.tolerance,
              abs(ready.contentFrame.height - 680) <= Self.tolerance else {
            throw CaptureFailure.invalidReady
        }
        return ready
    }

    private func strictReadyShape(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == [
                  "schemaVersion", "fixtureId", "pid", "windowNumber", "windowFrame",
                  "contentFrame", "backingScale", "ready"
              ],
              strictFrameShape(root["windowFrame"]),
              strictFrameShape(root["contentFrame"]) else {
            return false
        }
        return true
    }

    private func strictFrameShape(_ value: Any?) -> Bool {
        guard let frame = value as? [String: Any] else { return false }
        return Set(frame.keys) == ["x", "y", "width", "height"]
    }

    private func requireRegularNonSymlink(_ url: URL) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw CaptureFailure.unsafeInput
        }
    }

    private func requirePrivateDirectory(_ url: URL) throws {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values.isDirectory == true,
              values.isSymbolicLink != true,
              let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue,
              mode & 0o077 == 0 else {
            throw CaptureFailure.unsafeInput
        }
    }

    private func pathEntryExists(_ url: URL) -> Bool {
        var metadata = stat()
        return url.path.withCString { lstat($0, &metadata) } == 0
    }

    private func write(_ trace: DesktopSettledGeometryTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try encoder.encode(trace).write(to: options.outputURL, options: [.atomic])
        } catch {
            throw CaptureFailure.outputFailed
        }
    }

    private func acquireCheckpoint(
        index: Int,
        section: DesktopSection,
        ready: ReadyDocument
    ) throws -> DesktopSettledGeometryCheckpoint {
        let phaseStarted = DispatchTime.now().uptimeNanoseconds
        var lastFailure: CaptureFailure = .semanticMissing
        while elapsedMilliseconds(since: phaseStarted) <= Self.maximumAcquisitionMilliseconds {
            do {
                let samplingStarted = DispatchTime.now().uptimeNanoseconds
                var samples: [DesktopSettledGeometrySample] = []
                for sampleIndex in 0..<3 {
                    try waitUntil(
                        samplingStarted + UInt64(sampleIndex * Self.sampleIntervalMilliseconds) * 1_000_000
                    )
                    let elapsed = elapsedMilliseconds(since: samplingStarted)
                    samples.append(try sample(section: section, elapsed: elapsed, ready: ready))
                }
                guard stable(samples), validCadence(samples) else {
                    lastFailure = .semanticChanged
                    continue
                }
                let acquisition = elapsedMilliseconds(since: phaseStarted)
                guard acquisition <= Self.maximumAcquisitionMilliseconds else { break }
                return .init(
                    index: index,
                    section: section,
                    ready: true,
                    quiescent: true,
                    acquisitionMilliseconds: acquisition,
                    samples: samples
                )
            } catch let failure as CaptureFailure {
                lastFailure = failure
                usleep(100_000)
            } catch {
                lastFailure = .invalidType
                usleep(100_000)
            }
        }
        if lastFailure == .permissionDenied { throw lastFailure }
        throw CaptureFailure.acquisitionTimeout
    }

    private func sample(
        section: DesktopSection,
        elapsed: Int,
        ready: ReadyDocument
    ) throws -> DesktopSettledGeometrySample {
        let binding = try semanticBinding(section: section, ready: ready)
        let windowFrame = try elementFrame(binding.window)
        let contentFrame: DesktopSettledGeometryFrame
        do {
            contentFrame = try DesktopSettledGeometryCoordinateNormalizer.normalizeContentFrame(
                appKitWindowFrame: ready.windowFrame,
                appKitContentFrame: ready.contentFrame,
                axWindowFrame: windowFrame,
                tolerancePoints: Self.tolerance
            )
        } catch {
            throw CaptureFailure.windowMismatch
        }
        var regions: [DesktopSettledGeometryRegionFrame] = []
        for region in DesktopSettledGeometryRegion.allCases {
            guard let element = binding.regions[region] else { continue }
            regions.append(.init(id: region, frame: try elementFrame(element)))
        }
        return .init(
            elapsedMilliseconds: elapsed,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            regions: regions
        )
    }

    private func performNavigation(
        index: Int,
        from: DesktopSection,
        to: DesktopSection,
        ready: ReadyDocument
    ) throws -> DesktopSettledGeometryNavigationAction {
        let identifier = "neondiff-sidebar-section-\(to.rawValue)"
        let initial = try semanticBinding(section: from, ready: ready)
        let initialTarget = try uniqueElement(
            in: initial.window,
            identifier: identifier,
            expectedRole: kAXButtonRole as String
        )
        let advertised = try actionNames(initialTarget).contains(
            NSAccessibility.Action.press.rawValue
        )
        guard advertised else { throw CaptureFailure.actionUnavailable }

        let current = try semanticBinding(section: from, ready: ready)
        let currentTarget = try uniqueElement(
            in: current.window,
            identifier: identifier,
            expectedRole: kAXButtonRole as String
        )
        guard sameBinding(initial, current), CFEqual(initialTarget, currentTarget) else {
            throw CaptureFailure.semanticChanged
        }
        let currentAdvertised = try actionNames(currentTarget).contains(
            NSAccessibility.Action.press.rawValue
        )
        guard currentAdvertised == advertised else { throw CaptureFailure.semanticChanged }

        let result = AXUIElementPerformAction(
            currentTarget,
            NSAccessibility.Action.press.rawValue as CFString
        )
        guard result == .success else { throw CaptureFailure.actionFailed }
        return .init(
            index: index,
            fromSection: from,
            toSection: to,
            controlIdentifier: identifier,
            actionAdvertised: true,
            attemptCount: 1,
            performResult: .success
        )
    }

    private func semanticBinding(
        section: DesktopSection,
        ready: ReadyDocument
    ) throws -> SemanticBinding {
        let window = try verifiedWindow(ready: ready)
        let required: [(DesktopSettledGeometryRegion, String)] = section == .repos
            ? [
                (.chrome, kAXGroupRole as String),
                (.sidebar, kAXGroupRole as String),
                (.detail, kAXGroupRole as String),
                (.reposOuterScroll, kAXScrollAreaRole as String),
                (.reposBottomSentinel, kAXStaticTextRole as String)
            ]
            : [
                (.chrome, kAXGroupRole as String),
                (.sidebar, kAXGroupRole as String),
                (.detail, kAXGroupRole as String),
                (.overviewSentinel, kAXButtonRole as String)
            ]
        var regions: [DesktopSettledGeometryRegion: AXUIElement] = [:]
        for (region, role) in required {
            regions[region] = try uniqueElement(
                in: window,
                identifier: region.accessibilityIdentifier,
                expectedRole: role
            )
        }
        return SemanticBinding(window: window, regions: regions)
    }

    private func verifiedWindow(ready: ReadyDocument) throws -> AXUIElement {
        let expectedFrame = try cgWindowFrame(number: ready.windowNumber)
        let application = AXUIElementCreateApplication(options.pid)
        try requireTargetPID(application)
        let rawWindows = try requiredAttribute(application, kAXWindowsAttribute as CFString)
        guard CFGetTypeID(rawWindows) == CFArrayGetTypeID(),
              let windows = rawWindows as? [AXUIElement] else {
            throw CaptureFailure.invalidType
        }
        var matches: [AXUIElement] = []
        for window in windows {
            try requireTargetPID(window)
            guard try optionalString(window, kAXRoleAttribute as CFString) == (kAXWindowRole as String) else {
                continue
            }
            if framesMatch(try elementFrame(window), expectedFrame) {
                matches.append(window)
            }
        }
        guard matches.count == 1, let window = matches.first else {
            throw CaptureFailure.windowMismatch
        }
        let frame = try elementFrame(window)
        guard abs(frame.width - ready.windowFrame.width) <= Self.tolerance,
              abs(frame.height - ready.windowFrame.height) <= Self.tolerance else {
            throw CaptureFailure.windowMismatch
        }
        return window
    }

    private func cgWindowFrame(number: Int) throws -> DesktopSettledGeometryFrame {
        guard number > 0,
              let raw = CGWindowListCopyWindowInfo(
                  .optionIncludingWindow,
                  CGWindowID(number)
              ) as? [[String: Any]],
              raw.count == 1,
              let info = raw.first,
              (info[kCGWindowNumber as String] as? NSNumber)?.intValue == number,
              (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == options.pid,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary else {
            throw CaptureFailure.windowMismatch
        }
        var frame = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(bounds as CFDictionary, &frame),
              frame.origin.x.isFinite,
              frame.origin.y.isFinite,
              frame.width.isFinite,
              frame.height.isFinite,
              frame.width > 0,
              frame.height > 0 else {
            throw CaptureFailure.windowMismatch
        }
        return .init(x: frame.origin.x, y: frame.origin.y, width: frame.width, height: frame.height)
    }

    private func uniqueElement(
        in window: AXUIElement,
        identifier: String,
        expectedRole: String
    ) throws -> AXUIElement {
        var candidates: [AXUIElement] = []
        var remaining = 10_000
        var visited = Set<CFHashCode>()
        try visit(
            window,
            identifier: identifier,
            depth: 0,
            remaining: &remaining,
            visited: &visited,
            candidates: &candidates
        )
        guard candidates.count == 1, let candidate = candidates.first else {
            throw candidates.isEmpty ? CaptureFailure.semanticMissing : CaptureFailure.semanticDuplicate
        }
        guard try optionalString(candidate, kAXRoleAttribute as CFString) == expectedRole else {
            throw CaptureFailure.invalidType
        }
        return candidate
    }

    private func visit(
        _ element: AXUIElement,
        identifier: String,
        depth: Int,
        remaining: inout Int,
        visited: inout Set<CFHashCode>,
        candidates: inout [AXUIElement]
    ) throws {
        guard depth <= 32, remaining > 0 else { throw CaptureFailure.invalidType }
        try requireTargetPID(element)
        guard visited.insert(CFHash(element)).inserted else { throw CaptureFailure.invalidType }
        remaining -= 1
        if try optionalString(element, kAXIdentifierAttribute as CFString) == identifier {
            candidates.append(element)
        }
        guard let rawChildren = try optionalAttribute(element, kAXChildrenAttribute as CFString) else {
            return
        }
        guard CFGetTypeID(rawChildren) == CFArrayGetTypeID(),
              let children = rawChildren as? [AXUIElement] else {
            throw CaptureFailure.invalidType
        }
        for child in children {
            try visit(
                child,
                identifier: identifier,
                depth: depth + 1,
                remaining: &remaining,
                visited: &visited,
                candidates: &candidates
            )
        }
    }

    private func sameBinding(_ lhs: SemanticBinding, _ rhs: SemanticBinding) -> Bool {
        guard CFEqual(lhs.window, rhs.window), lhs.regions.count == rhs.regions.count else {
            return false
        }
        return lhs.regions.allSatisfy { region, element in
            rhs.regions[region].map { CFEqual(element, $0) } == true
        }
    }

    private func stable(_ samples: [DesktopSettledGeometrySample]) -> Bool {
        guard samples.count == 3, let baseline = samples.first else { return false }
        let baselineRegions = Dictionary(uniqueKeysWithValues: baseline.regions.map { ($0.id, $0.frame) })
        return samples.dropFirst().allSatisfy { sample in
            guard framesMatch(baseline.windowFrame, sample.windowFrame),
                  framesMatch(baseline.contentFrame, sample.contentFrame),
                  sample.regions.count == baseline.regions.count else {
                return false
            }
            let regions = Dictionary(uniqueKeysWithValues: sample.regions.map { ($0.id, $0.frame) })
            return baselineRegions.allSatisfy { region, frame in
                regions[region].map { framesMatch(frame, $0) } == true
            }
        }
    }

    private func validCadence(_ samples: [DesktopSettledGeometrySample]) -> Bool {
        guard samples.count == 3,
              let first = samples.first,
              first.elapsedMilliseconds >= 0,
              first.elapsedMilliseconds <= 25 else {
            return false
        }
        return zip(samples, samples.dropFirst()).allSatisfy { lhs, rhs in
            let delta = rhs.elapsedMilliseconds.subtractingReportingOverflow(lhs.elapsedMilliseconds)
            return !delta.overflow && delta.partialValue >= 90 && delta.partialValue <= 125
        }
    }

    private func framesMatch(
        _ lhs: DesktopSettledGeometryFrame,
        _ rhs: DesktopSettledGeometryFrame
    ) -> Bool {
        abs(lhs.x - rhs.x) <= Self.tolerance
            && abs(lhs.y - rhs.y) <= Self.tolerance
            && abs(lhs.width - rhs.width) <= Self.tolerance
            && abs(lhs.height - rhs.height) <= Self.tolerance
    }

    private func waitUntil(_ deadline: UInt64) throws {
        let now = DispatchTime.now().uptimeNanoseconds
        guard deadline >= now else { return }
        let microseconds = (deadline - now) / 1_000
        guard microseconds <= UInt64(UInt32.max) else { throw CaptureFailure.invalidType }
        if microseconds > 0 { usleep(useconds_t(microseconds)) }
    }

    private func elapsedMilliseconds(since start: UInt64) -> Int {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now >= start else { return Int.max }
        let milliseconds = (now - start) / 1_000_000
        return milliseconds > UInt64(Int.max) ? Int.max : Int(milliseconds)
    }

    private func elementFrame(_ element: AXUIElement) throws -> DesktopSettledGeometryFrame {
        let position = try pointValue(requiredAttribute(element, kAXPositionAttribute as CFString))
        let size = try sizeValue(requiredAttribute(element, kAXSizeAttribute as CFString))
        guard position.x.isFinite,
              position.y.isFinite,
              size.width.isFinite,
              size.height.isFinite,
              size.width > 0,
              size.height > 0 else {
            throw CaptureFailure.invalidType
        }
        return .init(x: position.x, y: position.y, width: size.width, height: size.height)
    }

    private func requireTargetPID(_ element: AXUIElement) throws {
        var elementPID: pid_t = 0
        let result = AXUIElementGetPid(element, &elementPID)
        guard result == .success else { throw mapAXError(result) }
        guard elementPID == options.pid else { throw CaptureFailure.invalidType }
    }

    private func actionNames(_ element: AXUIElement) throws -> [String] {
        try requireTargetPID(element)
        var raw: CFArray?
        let result = AXUIElementCopyActionNames(element, &raw)
        guard result == .success, let raw,
              CFGetTypeID(raw) == CFArrayGetTypeID(),
              let names = raw as? [String] else {
            throw mapAXError(result)
        }
        return names
    }

    private func optionalString(_ element: AXUIElement, _ attribute: CFString) throws -> String? {
        guard let raw = try optionalAttribute(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == CFStringGetTypeID() else { throw CaptureFailure.invalidType }
        return raw as? String
    }

    private func pointValue(_ raw: CFTypeRef) throws -> CGPoint {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { throw CaptureFailure.invalidType }
        var point = CGPoint.zero
        guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else {
            throw CaptureFailure.invalidType
        }
        return point
    }

    private func sizeValue(_ raw: CFTypeRef) throws -> CGSize {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { throw CaptureFailure.invalidType }
        var size = CGSize.zero
        guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else {
            throw CaptureFailure.invalidType
        }
        return size
    }

    private func requiredAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFTypeRef {
        guard let value = try optionalAttribute(element, attribute) else {
            throw CaptureFailure.semanticMissing
        }
        return value
    }

    private func optionalAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFTypeRef? {
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &raw)
        switch result {
        case .success:
            guard let raw else { throw CaptureFailure.invalidType }
            return raw
        case .noValue, .attributeUnsupported:
            return nil
        default:
            throw mapAXError(result)
        }
    }

    private func mapAXError(_ error: AXError) -> CaptureFailure {
        switch error {
        case .apiDisabled: .permissionDenied
        case .cannotComplete: .semanticChanged
        case .invalidUIElement, .invalidUIElementObserver: .semanticChanged
        case .attributeUnsupported, .noValue: .semanticMissing
        default: .invalidType
        }
    }

    private struct SemanticBinding {
        let window: AXUIElement
        let regions: [DesktopSettledGeometryRegion: AXUIElement]
    }
}

private func emitStatus(ok: Bool, status: String, reasonCode: String) {
    let payload: [String: Any] = [
        "schemaVersion": 1,
        "ok": ok,
        "status": status,
        "reasonCode": reasonCode
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        return
    }
    let handle = ok ? FileHandle.standardOutput : FileHandle.standardError
    handle.write(data)
    handle.write(Data("\n".utf8))
}

do {
    let options = try Options.parse(CommandLine.arguments)
    _ = try SettledGeometryRunner(options: options).run()
    emitStatus(ok: true, status: "complete", reasonCode: "none")
} catch let failure as CaptureFailure {
    emitStatus(ok: false, status: "failed", reasonCode: failure.reasonCode)
    exit(1)
} catch {
    emitStatus(ok: false, status: "failed", reasonCode: "unexpected-error")
    exit(1)
}
