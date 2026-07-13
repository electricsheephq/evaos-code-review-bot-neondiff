import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import NeonDiffDesktopCore
import NeonDiffDesktopEvaluationSupport

private enum CaptureError: LocalizedError {
    case usage
    case unsafePath(String)
    case invalidReadyFile
    case unsupportedReachabilityTarget
    case permission(String)
    case window(String)
    case screenshot(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            "usage: NeonDiffDesktopCapture --pid <pid> --ready <ready.json> --output-dir <directory> [--repos-reachability]"
        case .unsafePath(let detail): "Unsafe capture path: \(detail)"
        case .invalidReadyFile: "Evaluation readiness file is invalid or does not match the target process."
        case .unsupportedReachabilityTarget:
            "Repositories reachability capture requires tab-repos at 1040x680."
        case .permission(let detail): "Capture permission is unavailable: \(detail)"
        case .window(let detail): "Target window is unavailable: \(detail)"
        case .screenshot(let detail): "Window screenshot failed: \(detail)"
        }
    }
}

private struct Frame: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct ReadyDocument: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let pid: Int32
    let windowNumber: Int
    let windowFrame: Frame
    let contentFrame: Frame
    let backingScale: Double
    let ready: Bool
}

private struct Options {
    let pid: Int32
    let readyURL: URL
    let outputDirectory: URL
    let capturesReposReachability: Bool

    static func parse(_ arguments: [String]) throws -> Options {
        func value(_ flag: String) throws -> String {
            guard arguments.filter({ $0 == flag }).count == 1,
                  let index = arguments.firstIndex(of: flag),
                  arguments.indices.contains(index + 1),
                  !arguments[index + 1].hasPrefix("--") else {
                throw CaptureError.usage
            }
            return arguments[index + 1]
        }
        let capturesReposReachability = arguments.contains("--repos-reachability")
        guard arguments.filter({ $0 == "--repos-reachability" }).count <= 1,
              arguments.count == (capturesReposReachability ? 8 : 7),
              let pid = Int32(try value("--pid")),
              pid > 0 else {
            throw CaptureError.usage
        }
        return Options(
            pid: pid,
            readyURL: URL(fileURLWithPath: try value("--ready")).standardizedFileURL,
            outputDirectory: URL(fileURLWithPath: try value("--output-dir"), isDirectory: true).standardizedFileURL,
            capturesReposReachability: capturesReposReachability
        )
    }
}

private struct ReposFocusedEvidence {
    let reachability: [String: String]
    let scrollCapabilities: [String: String]
}

private struct CaptureRunner {
    let options: Options

    func run() throws -> [String: Any] {
        let ready = try loadReady()
        if options.capturesReposReachability {
            do {
                _ = try DesktopReposReachabilityTarget.requireSupported(
                    fixtureId: ready.fixtureId,
                    contentWidth: ready.contentFrame.width,
                    contentHeight: ready.contentFrame.height
                )
            } catch {
                throw CaptureError.unsupportedReachabilityTarget
            }
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureError.permission("Screen Recording")
        }
        guard AXIsProcessTrusted() else {
            throw CaptureError.permission("Accessibility")
        }
        let window = try windowInfo(number: ready.windowNumber)
        let screenshotURL = options.outputDirectory.appendingPathComponent("screenshot.png")
        let accessibilityURL = options.outputDirectory.appendingPathComponent("accessibility.json")
        let geometryURL = options.outputDirectory.appendingPathComponent("geometry.json")

        try captureScreenshot(windowNumber: ready.windowNumber, outputURL: screenshotURL)
        let image = try screenshotImage(at: screenshotURL)
        let ax = try accessibilityTree(pid: options.pid)
        let axData = try JSONSerialization.data(withJSONObject: ax.tree, options: [.prettyPrinted, .sortedKeys])
        try axData.write(to: accessibilityURL, options: [.atomic])

        let geometry: [String: Any] = [
            "schemaVersion": 1,
            "fixtureId": ready.fixtureId,
            "pid": ready.pid,
            "windowNumber": ready.windowNumber,
            "appWindowFrame": frameDictionary(ready.windowFrame),
            "appContentFrame": frameDictionary(ready.contentFrame),
            "cgWindowBounds": frameDictionary(window.bounds),
            "backingScale": ready.backingScale,
            "accessibilityNodeCount": ax.nodeCount,
            "accessibilityTruncated": false,
            "screenshotPixels": ["width": image.pixelsWide, "height": image.pixelsHigh]
        ]
        let geometryData = try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
        try geometryData.write(to: geometryURL, options: [.atomic])
        let reposFocusedEvidence = try writeReposFocusedEvidenceIfRequired(ready: ready)

        var result: [String: Any] = [
            "ok": true,
            "fixtureId": ready.fixtureId,
            "windowNumber": ready.windowNumber,
            "screenshot": try evidence(screenshotURL),
            "accessibility": try evidence(accessibilityURL),
            "geometry": try evidence(geometryURL)
        ]
        if let reposFocusedEvidence {
            result["reachability"] = reposFocusedEvidence.reachability
            result["scrollCapabilities"] = reposFocusedEvidence.scrollCapabilities
        }
        return result
    }

    private func loadReady() throws -> ReadyDocument {
        try requireRegularFile(options.readyURL, label: "ready file")
        try requireDirectory(options.outputDirectory, label: "output directory")
        let data = try Data(contentsOf: options.readyURL, options: [.mappedIfSafe])
        guard data.count <= 64 * 1024,
              let ready = try? JSONDecoder().decode(ReadyDocument.self, from: data),
              ready.schemaVersion == 1,
              ready.ready,
              ready.pid == options.pid,
              ready.fixtureId.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil,
              ready.windowNumber > 0,
              ready.backingScale > 0 else {
            throw CaptureError.invalidReadyFile
        }
        return ready
    }

    private func writeReposFocusedEvidenceIfRequired(ready: ReadyDocument) throws -> ReposFocusedEvidence? {
        guard options.capturesReposReachability else { return nil }
        let tracer = DesktopReposReachabilityAXTracer(pid: options.pid, ready: ready)
        let trace = tracer.capture()
        let scrollCapabilities = tracer.captureScrollCapabilities()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let reachabilityData = try encoder.encode(trace)
        let reachabilityURL = options.outputDirectory.appendingPathComponent("reachability.json")
        try reachabilityData.write(to: reachabilityURL, options: [.atomic])
        let capabilitiesData = try encoder.encode(scrollCapabilities.validated())
        let capabilitiesURL = options.outputDirectory.appendingPathComponent("scroll-capabilities.json")
        try capabilitiesData.write(to: capabilitiesURL, options: [.atomic])
        let status: String
        do {
            _ = try DesktopReposReachabilityValidator.validate(trace)
            status = "reachable"
        } catch DesktopReposReachabilityValidationError.acquisitionFailed {
            status = "acquisition-failed"
        } catch {
            status = "unreachable"
        }
        return ReposFocusedEvidence(
            reachability: [
                "path": reachabilityURL.lastPathComponent,
                "sha256": try sha256(reachabilityURL),
                "status": status
            ],
            scrollCapabilities: [
                "path": capabilitiesURL.lastPathComponent,
                "sha256": try sha256(capabilitiesURL)
            ]
        )
    }

    private func requireRegularFile(_ url: URL, label: String) throws {
        guard url.isFileURL, url.path.hasPrefix("/") else { throw CaptureError.unsafePath(label) }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw CaptureError.unsafePath(label)
        }
    }

    private func requireDirectory(_ url: URL, label: String) throws {
        guard url.isFileURL, url.path.hasPrefix("/") else { throw CaptureError.unsafePath(label) }
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw CaptureError.unsafePath(label)
        }
    }

    private func windowInfo(number: Int) throws -> (bounds: Frame, ownerPID: Int32) {
        guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(number)) as? [[String: Any]],
              let item = raw.first,
              let ownerPID = item[kCGWindowOwnerPID as String] as? Int32,
              ownerPID == options.pid,
              let layer = item[kCGWindowLayer as String] as? Int,
              layer == 0,
              let boundsDictionary = item[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else {
            throw CaptureError.window("exact PID/window identity mismatch")
        }
        return (
            Frame(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height),
            ownerPID
        )
    }

    private func captureScreenshot(windowNumber: Int, outputURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-l\(windowNumber)", outputURL.path]
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        try process.run()
        if completed.wait(timeout: .now() + 5) == .timedOut {
            process.terminate()
            if completed.wait(timeout: .now() + 1) == .timedOut {
                Darwin.kill(process.processIdentifier, SIGKILL)
                _ = completed.wait(timeout: .now() + 1)
            }
            throw CaptureError.screenshot("screencapture timed out")
        }
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw CaptureError.screenshot("/usr/sbin/screencapture exited \(process.terminationStatus)")
        }
    }

    private func screenshotImage(at url: URL) throws -> NSBitmapImageRep {
        guard let data = try? Data(contentsOf: url),
              let image = NSBitmapImageRep(data: data),
              image.pixelsWide > 0,
              image.pixelsHigh > 0 else {
            throw CaptureError.screenshot("PNG is missing or blank")
        }
        return image
    }

    private func accessibilityTree(pid: Int32) throws -> (tree: [String: Any], nodeCount: Int) {
        let application = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(application, 1.0) == .success else {
            throw CaptureError.window("could not bound Accessibility messaging")
        }
        var windowsValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowsValue)
        guard result == .success,
              let windows = windowsValue as? [AXUIElement],
              windows.count == 1,
              let window = windows.first else {
            throw CaptureError.window("expected exactly one Accessibility window")
        }
        var remainingNodes = 10_000
        var truncated = false
        let tree = serialize(
            element: window,
            depth: 0,
            remainingNodes: &remainingNodes,
            truncated: &truncated
        )
        guard !truncated else {
            throw CaptureError.window("Accessibility tree exceeded the depth or node bound")
        }
        return (tree, 10_000 - remainingNodes)
    }

    private func serialize(
        element: AXUIElement,
        depth: Int,
        remainingNodes: inout Int,
        truncated: inout Bool
    ) -> [String: Any] {
        guard depth <= 24, remainingNodes > 0 else {
            truncated = true
            return [:]
        }
        remainingNodes -= 1
        var node: [String: Any] = [:]
        for (key, attribute) in stringAttributes {
            if let value = attributeValue(element, attribute: attribute) as? String, !value.isEmpty {
                node[key] = NeonDiffRedactor.redact(value)
            }
        }
        for (key, attribute) in booleanAttributes {
            if let value = attributeValue(element, attribute: attribute) as? Bool {
                node[key] = value
            }
        }
        if let position = pointValue(attributeValue(element, attribute: kAXPositionAttribute as CFString)),
           let size = sizeValue(attributeValue(element, attribute: kAXSizeAttribute as CFString)) {
            node["frame"] = ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
        }
        if let children = attributeValue(element, attribute: kAXChildrenAttribute as CFString) as? [AXUIElement],
           !children.isEmpty {
            node["children"] = children.map {
                serialize(
                    element: $0,
                    depth: depth + 1,
                    remainingNodes: &remainingNodes,
                    truncated: &truncated
                )
            }
        }
        return node
    }

    private var stringAttributes: [(String, CFString)] {
        [
            ("role", kAXRoleAttribute as CFString),
            ("subrole", kAXSubroleAttribute as CFString),
            ("identifier", kAXIdentifierAttribute as CFString),
            ("title", kAXTitleAttribute as CFString),
            ("description", kAXDescriptionAttribute as CFString),
            ("value", kAXValueAttribute as CFString)
        ]
    }

    private var booleanAttributes: [(String, CFString)] {
        [
            ("enabled", kAXEnabledAttribute as CFString),
            ("focused", kAXFocusedAttribute as CFString),
            ("selected", kAXSelectedAttribute as CFString)
        ]
    }

    private func attributeValue(_ element: AXUIElement, attribute: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
    }

    private func pointValue(_ value: CFTypeRef?) -> CGPoint? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
    }

    private func sizeValue(_ value: CFTypeRef?) -> CGSize? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
    }

    private func evidence(_ url: URL) throws -> [String: String] {
        ["path": url.lastPathComponent, "sha256": try sha256(url)]
    }

    private func sha256(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func frameDictionary(_ frame: Frame) -> [String: Double] {
        ["x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height]
    }
}

private struct DesktopReposReachabilityAXTracer {
    private static let intervalNanoseconds: UInt64 = 100_000_000
    private static let maximumAcquisitionMilliseconds = 5_000
    private static let tolerance = 1.0

    let pid: Int32
    let ready: ReadyDocument

    func capture() -> DesktopReposReachabilityTrace {
        let systemWide = AXUIElementCreateSystemWide()
        let timeoutInstalled = AXUIElementSetMessagingTimeout(systemWide, 1.0) == .success
        defer {
            if timeoutInstalled {
                _ = AXUIElementSetMessagingTimeout(systemWide, 0)
            }
        }

        var pre = PhaseAcquisition.empty
        var post = PhaseAcquisition.empty
        var scrollInteraction: DesktopReposScrollInteraction?
        var failure: DesktopReposReachabilityAcquisitionFailureReason?
        if timeoutInstalled {
            do {
                let binding = try incrementPagePressBinding()
                pre = acquireStableSamples(binding: binding.semantic)
                failure = pre.failure
                if failure == nil {
                    scrollInteraction = try performIncrementPagePress(binding)
                }
            } catch let reason as Failure {
                failure = reason
            } catch {
                failure = .invalidType
            }
            if failure == nil,
               scrollInteraction?.incrementPagePress?.performResult == .success {
                post = acquireStableSamples()
                failure = post.failure
            }
        } else {
            failure = .messagingTimeoutUnavailable
        }

        // The ready document is emitted only after the DEBUG fixture render
        // latch and three stable 100 ms readiness samples have completed.
        let readinessGatePassed = ready.ready
        let acquisition = DesktopReposReachabilityAcquisition(
            status: failure == nil ? .complete : .failed,
            failureReason: failure
        )
        return DesktopReposReachabilityTrace(
            schemaVersion: 2,
            fixture: .tabRepos,
            ready: readinessGatePassed,
            quiescent: readinessGatePassed && pre.stable && post.stable,
            requestedContentSize: DesktopEvaluationContentSize(width: 1040, height: 680),
            sampleIntervalMilliseconds: 100,
            preScrollAcquisitionMilliseconds: pre.durationMilliseconds,
            postScrollAcquisitionMilliseconds: post.durationMilliseconds,
            tolerancePoints: Self.tolerance,
            acquisition: acquisition,
            preScrollSamples: pre.samples,
            scrollInteraction: scrollInteraction,
            postScrollSamples: post.samples
        )
    }

    func captureScrollCapabilities() -> DesktopReposScrollCapabilities {
        let osMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        let systemWide = AXUIElementCreateSystemWide()
        let timeoutInstalled = AXUIElementSetMessagingTimeout(systemWide, 1.0) == .success
        guard timeoutInstalled else {
            return .failed(osMajorVersion: osMajorVersion, reason: .messagingTimeoutUnavailable)
        }
        defer { _ = AXUIElementSetMessagingTimeout(systemWide, 0) }

        do {
            let window = try verifiedWindow()
            let elements = try semanticElements(in: window)
            guard let outerScrollArea = try outermostScrollArea(
                from: elements.boundaryBody,
                to: window
            ) else {
                throw Failure.ancestryUnavailable
            }

            let boundaryActionNames: [String]?
            let scrollToVisibleActionName: String?
            if osMajorVersion >= 26 {
                if #available(macOS 26.0, *) {
                    boundaryActionNames = try actionNames(elements.boundaryBody)
                    scrollToVisibleActionName = NSAccessibility.Action.scrollToVisibleAction.rawValue
                } else {
                    throw Failure.invalidType
                }
            } else {
                boundaryActionNames = nil
                scrollToVisibleActionName = nil
            }

            let verticalScrollBar = try verticalScrollBar(in: outerScrollArea)
            let scrollBarActionNames = try verticalScrollBar.map(actionNames)
            let incrementPage: AXUIElement?
            if let verticalScrollBar {
                incrementPage = try incrementPageButton(in: verticalScrollBar)
            } else {
                incrementPage = nil
            }
            let incrementPageActionNames = try incrementPage.map(actionNames)
            return try DesktopReposScrollCapabilityContract.evaluate(
                osMajorVersion: osMajorVersion,
                boundaryActionNames: boundaryActionNames,
                verticalScrollBarResolved: verticalScrollBar != nil,
                scrollBarActionNames: scrollBarActionNames,
                incrementPageResolved: incrementPage != nil,
                incrementPageActionNames: incrementPageActionNames,
                scrollToVisibleActionName: scrollToVisibleActionName,
                incrementActionName: NSAccessibility.Action.increment.rawValue,
                pressActionName: NSAccessibility.Action.press.rawValue
            )
        } catch let reason as Failure {
            return .failed(osMajorVersion: osMajorVersion, reason: reason)
        } catch {
            return .failed(osMajorVersion: osMajorVersion, reason: .invalidType)
        }
    }

    private func acquireStableSamples(binding providedBinding: SemanticBinding? = nil) -> PhaseAcquisition {
        let phaseStarted = DispatchTime.now().uptimeNanoseconds
        let binding: SemanticBinding
        do {
            if let providedBinding {
                binding = providedBinding
            } else {
                let window = try verifiedWindow()
                binding = SemanticBinding(window: window, elements: try semanticElements(in: window))
            }
        } catch let reason as DesktopReposReachabilityAcquisitionFailureReason {
            return PhaseAcquisition(
                samples: [],
                durationMilliseconds: milliseconds(
                    from: phaseStarted,
                    to: DispatchTime.now().uptimeNanoseconds
                ),
                stable: false,
                failure: reason
            )
        } catch {
            return PhaseAcquisition(
                samples: [],
                durationMilliseconds: milliseconds(
                    from: phaseStarted,
                    to: DispatchTime.now().uptimeNanoseconds
                ),
                stable: false,
                failure: .invalidType
            )
        }

        let samplingStarted = DispatchTime.now().uptimeNanoseconds
        guard milliseconds(from: phaseStarted, to: samplingStarted) <= Self.maximumAcquisitionMilliseconds else {
            return PhaseAcquisition(
                samples: [],
                durationMilliseconds: milliseconds(from: phaseStarted, to: samplingStarted),
                stable: false,
                failure: .timeout
            )
        }
        var rolling: [DesktopReposReachabilitySample] = []
        while true {
            let beforeSample = DispatchTime.now().uptimeNanoseconds
            let elapsedBeforeSample = milliseconds(from: phaseStarted, to: beforeSample)
            guard elapsedBeforeSample <= Self.maximumAcquisitionMilliseconds else {
                return PhaseAcquisition(
                    samples: rolling,
                    durationMilliseconds: elapsedBeforeSample,
                    stable: false,
                    failure: .timeout
                )
            }
            let elapsed = milliseconds(from: samplingStarted, to: beforeSample)
            switch sample(binding: binding, elapsedMilliseconds: elapsed) {
            case .success(let value):
                rolling.append(value)
            case .failure(let reason):
                return PhaseAcquisition(
                    samples: rolling,
                    durationMilliseconds: milliseconds(
                        from: phaseStarted,
                        to: DispatchTime.now().uptimeNanoseconds
                    ),
                    stable: false,
                    failure: reason
                )
            }
            if rolling.count > DesktopReposReachabilitySamplingContract.minimumStableSampleCount {
                rolling.removeFirst()
            }
            let duration = milliseconds(from: phaseStarted, to: DispatchTime.now().uptimeNanoseconds)
            if rolling.count == DesktopReposReachabilitySamplingContract.minimumStableSampleCount,
               DesktopReposReachabilitySamplingContract.hasStableCadence(
                   rolling.map(\.elapsedMilliseconds)
               ),
               samplesMatch(rolling[0], rolling[1]),
               samplesMatch(rolling[0], rolling[2]),
               duration <= Self.maximumAcquisitionMilliseconds {
                return PhaseAcquisition(samples: rolling, durationMilliseconds: duration, stable: true, failure: nil)
            }
            guard duration <= Self.maximumAcquisitionMilliseconds else {
                return PhaseAcquisition(samples: rolling, durationMilliseconds: duration, stable: false, failure: .timeout)
            }
            let now = DispatchTime.now().uptimeNanoseconds
            let nextDeadline = max(beforeSample + Self.intervalNanoseconds, now)
            if nextDeadline > now {
                usleep(useconds_t((nextDeadline - now) / 1_000))
            }
        }
    }

    private func incrementPagePressBinding() throws -> ScrollBehaviorBinding {
        let window = try verifiedWindow()
        let elements = try semanticElements(in: window)
        guard let scrollArea = try outermostScrollArea(from: elements.boundaryBody, to: window),
              let scrollBar = try verticalScrollBar(in: scrollArea),
              let incrementPage = try incrementPageButton(in: scrollBar) else {
            throw Failure.semanticMissing
        }
        let advertised = try actionNames(incrementPage).contains(NSAccessibility.Action.press.rawValue)
        return ScrollBehaviorBinding(
            semantic: .init(window: window, elements: elements),
            incrementPage: incrementPage,
            actionAdvertised: advertised,
            outerClipBefore: try elementFrame(scrollArea)
        )
    }

    private func performIncrementPagePress(
        _ binding: ScrollBehaviorBinding
    ) throws -> DesktopReposScrollInteraction {
        guard binding.actionAdvertised else {
            return DesktopReposScrollInteraction(
                mechanism: .incrementPagePress,
                incrementPagePress: .init(
                    actionAdvertised: false,
                    attemptCount: 0,
                    performResult: nil,
                    outerClipBefore: binding.outerClipBefore,
                    outerClipAfter: nil
                ),
                valueMutation: nil
            )
        }
        try requireTargetPID(binding.incrementPage)
        guard try actionNames(binding.incrementPage).contains(NSAccessibility.Action.press.rawValue) else {
            return DesktopReposScrollInteraction(
                mechanism: .incrementPagePress,
                incrementPagePress: .init(
                    actionAdvertised: false,
                    attemptCount: 0,
                    performResult: nil,
                    outerClipBefore: binding.outerClipBefore,
                    outerClipAfter: nil
                ),
                valueMutation: nil
            )
        }
        let result = AXUIElementPerformAction(
            binding.incrementPage,
            NSAccessibility.Action.press.rawValue as CFString
        )
        let performResult = scrollActionResult(result)
        var clipAfter: DesktopReposReachabilityFrame?
        if result == .success {
            let window = try verifiedWindow()
            let elements = try semanticElements(in: window)
            guard let scrollArea = try outermostScrollArea(from: elements.boundaryBody, to: window) else {
                throw Failure.ancestryUnavailable
            }
            clipAfter = try elementFrame(scrollArea)
        }
        return DesktopReposScrollInteraction(
            mechanism: .incrementPagePress,
            incrementPagePress: .init(
                actionAdvertised: true,
                attemptCount: 1,
                performResult: performResult,
                outerClipBefore: binding.outerClipBefore,
                outerClipAfter: clipAfter
            ),
            valueMutation: nil
        )
    }

    private func scrollActionResult(_ error: AXError) -> DesktopReposScrollActionResult {
        switch error {
        case .success: return .success
        case .cannotComplete: return .cannotComplete
        case .actionUnsupported: return .actionUnsupported
        case .invalidUIElement, .invalidUIElementObserver: return .invalidElement
        case .apiDisabled: return .permissionDenied
        default: return .otherError
        }
    }

    private func milliseconds(from start: UInt64, to end: UInt64) -> Int {
        Int((end - start) / 1_000_000)
    }

    private func sample(
        binding: SemanticBinding,
        elapsedMilliseconds: Int
    ) -> Result<DesktopReposReachabilitySample, DesktopReposReachabilityAcquisitionFailureReason> {
        do {
            let viewport = try elementFrame(binding.window)
            let pairs: [(DesktopReposReachabilityRegion, AXUIElement)] = [
                (.table, binding.elements.table),
                (.applyAllowlist, binding.elements.applyAllowlist),
                (.boundaryBody, binding.elements.boundaryBody)
            ]
            let regions = try pairs.map { id, element in
                DesktopReposReachabilityRegionFrame(id: id, frame: try elementFrame(element))
            }
            return .success(DesktopReposReachabilitySample(
                elapsedMilliseconds: elapsedMilliseconds,
                viewport: viewport,
                regions: regions
            ))
        } catch let reason as DesktopReposReachabilityAcquisitionFailureReason {
            return .failure(reason)
        } catch {
            return .failure(.invalidType)
        }
    }

    private func samplesMatch(
        _ lhs: DesktopReposReachabilitySample,
        _ rhs: DesktopReposReachabilitySample
    ) -> Bool {
        guard framesMatch(lhs.viewport, rhs.viewport), lhs.regions.count == rhs.regions.count else {
            return false
        }
        let right = Dictionary(uniqueKeysWithValues: rhs.regions.map { ($0.id, $0.frame) })
        return lhs.regions.allSatisfy { region in
            right[region.id].map { framesMatch(region.frame, $0) } == true
        }
    }

    private func framesMatch(
        _ lhs: DesktopReposReachabilityFrame,
        _ rhs: DesktopReposReachabilityFrame
    ) -> Bool {
        abs(lhs.x - rhs.x) <= Self.tolerance
            && abs(lhs.y - rhs.y) <= Self.tolerance
            && abs(lhs.width - rhs.width) <= Self.tolerance
            && abs(lhs.height - rhs.height) <= Self.tolerance
    }

    private func verticalScrollBar(in scrollArea: AXUIElement) throws -> AXUIElement? {
        if let rawScrollBar = try optionalAttribute(
            scrollArea,
            kAXVerticalScrollBarAttribute as CFString
        ) {
            guard CFGetTypeID(rawScrollBar) == AXUIElementGetTypeID() else {
                throw Failure.invalidType
            }
            let scrollBar = rawScrollBar as! AXUIElement
            try requireTargetPID(scrollBar)
            let candidate = DesktopReposVerticalScrollBarCandidate(
                role: try optionalString(scrollBar, kAXRoleAttribute as CFString),
                orientation: try optionalString(scrollBar, kAXOrientationAttribute as CFString)
            )
            do {
                guard try DesktopReposVerticalScrollBarSelectionContract.select(
                    convenienceCandidate: candidate,
                    directChildren: []
                ) == .convenienceAttribute else {
                    throw Failure.invalidType
                }
            } catch let error as DesktopReposVerticalScrollBarSelectionError {
                throw selectionFailure(error)
            }
            return scrollBar
        }

        guard let rawChildren = try optionalAttribute(
            scrollArea,
            kAXChildrenAttribute as CFString
        ) else {
            return nil
        }
        guard CFGetTypeID(rawChildren) == CFArrayGetTypeID(),
              let children = rawChildren as? [AXUIElement] else {
            throw Failure.invalidType
        }

        var candidates: [DesktopReposVerticalScrollBarCandidate] = []
        candidates.reserveCapacity(children.count)
        for child in children {
            try requireTargetPID(child)
            let role = try optionalString(child, kAXRoleAttribute as CFString)
            let orientation = role == (kAXScrollBarRole as String)
                ? try optionalString(child, kAXOrientationAttribute as CFString)
                : nil
            candidates.append(.init(role: role, orientation: orientation))
        }

        let selection: DesktopReposVerticalScrollBarSelection
        do {
            selection = try DesktopReposVerticalScrollBarSelectionContract.select(
                convenienceCandidate: nil,
                directChildren: candidates
            )
        } catch let error as DesktopReposVerticalScrollBarSelectionError {
            throw selectionFailure(error)
        }

        switch selection {
        case .convenienceAttribute:
            throw Failure.invalidType
        case .directChild(let index):
            guard children.indices.contains(index) else { throw Failure.invalidType }
            return children[index]
        case .unsupported:
            return nil
        }
    }

    private func selectionFailure(
        _ error: DesktopReposVerticalScrollBarSelectionError
    ) -> Failure {
        switch error {
        case .missingRole, .missingOrientation:
            return .attributeUnavailable
        case .invalidRole, .invalidOrientation:
            return .invalidType
        case .ambiguousVerticalChildren:
            return .semanticDuplicate
        }
    }

    private func incrementPageButton(in scrollBar: AXUIElement) throws -> AXUIElement? {
        guard let rawChildren = try optionalAttribute(
            scrollBar,
            kAXChildrenAttribute as CFString
        ) else {
            throw Failure.attributeUnavailable
        }
        guard CFGetTypeID(rawChildren) == CFArrayGetTypeID(),
              let children = rawChildren as? [AXUIElement] else {
            throw Failure.invalidType
        }

        var candidates: [DesktopReposIncrementPageCandidate] = []
        candidates.reserveCapacity(children.count)
        for child in children {
            try requireTargetPID(child)
            candidates.append(.init(
                role: try optionalString(child, kAXRoleAttribute as CFString),
                subrole: try optionalString(child, kAXSubroleAttribute as CFString)
            ))
        }

        let selection: DesktopReposIncrementPageSelection
        do {
            selection = try DesktopReposIncrementPageSelectionContract.select(
                directChildren: candidates
            )
        } catch let error as DesktopReposIncrementPageSelectionError {
            switch error {
            case .missingRole, .missingSubrole:
                throw Failure.attributeUnavailable
            case .invalidIncrementPageRole:
                throw Failure.invalidType
            case .duplicateIncrementPage:
                throw Failure.semanticDuplicate
            }
        }

        switch selection {
        case .directChild(let index):
            guard children.indices.contains(index) else { throw Failure.invalidType }
            return children[index]
        case .unsupported:
            return nil
        }
    }

    private func verifiedWindow() throws -> AXUIElement {
        let application = AXUIElementCreateApplication(pid)
        try requireTargetPID(application)
        let rawWindows = try requiredAttribute(application, kAXWindowsAttribute as CFString)
        guard CFGetTypeID(rawWindows) == CFArrayGetTypeID() else { throw Failure.invalidType }
        let windows = rawWindows as! [AXUIElement]
        guard windows.count == 1, let window = windows.first,
              try optionalString(window, kAXRoleAttribute as CFString) == (kAXWindowRole as String) else {
            throw Failure.windowMismatch
        }
        try requireTargetPID(window)
        let frame = try elementFrame(window)
        guard
              abs(frame.width - ready.windowFrame.width) <= Self.tolerance,
              abs(frame.height - ready.windowFrame.height) <= Self.tolerance else {
            throw Failure.windowMismatch
        }
        return window
    }

    private func semanticElements(in window: AXUIElement) throws -> SemanticElements {
        var candidates = SemanticCandidates()
        var remaining = 10_000
        var visited = Set<CFHashCode>()
        try visit(
            window,
            depth: 0,
            remaining: &remaining,
            visited: &visited,
            candidates: &candidates
        )
        if let reason = DesktopReposReachabilitySemanticContract.failureReason(
            tableCount: candidates.table.count,
            applyAllowlistCount: candidates.applyAllowlist.count,
            boundaryBodyCount: candidates.boundaryBody.count
        ) {
            throw reason
        }
        return SemanticElements(
            table: candidates.table[0],
            applyAllowlist: candidates.applyAllowlist[0],
            boundaryBody: candidates.boundaryBody[0]
        )
    }

    private func visit(
        _ element: AXUIElement,
        depth: Int,
        remaining: inout Int,
        visited: inout Set<CFHashCode>,
        candidates: inout SemanticCandidates
    ) throws {
        guard depth <= 32, remaining > 0 else { throw Failure.ancestryLimit }
        try requireTargetPID(element)
        let hash = CFHash(element)
        guard visited.insert(hash).inserted else { throw Failure.ancestryCycle }
        remaining -= 1

        let role = try optionalString(element, kAXRoleAttribute as CFString)
        let title = try optionalString(element, kAXTitleAttribute as CFString)
        let description = try optionalString(element, kAXDescriptionAttribute as CFString)
        let value = try optionalTextValue(element, kAXValueAttribute as CFString)
        let identifier = try optionalString(element, kAXIdentifierAttribute as CFString)
        if DesktopReposReachabilitySemanticContract.matchesTable(role: role) {
            candidates.table.append(element)
        }
        if DesktopReposReachabilitySemanticContract.matchesApplyAllowlist(
            isButton: role == (kAXButtonRole as String),
            identifier: identifier,
            title: title,
            description: description,
            value: value
        ) {
            candidates.applyAllowlist.append(element)
        }
        if DesktopReposReachabilitySemanticContract.matchesBoundaryBody(
            isStaticText: role == (kAXStaticTextRole as String),
            identifier: identifier,
            description: description,
            value: value
        ) {
            candidates.boundaryBody.append(element)
        }

        guard let rawChildren = try optionalAttribute(element, kAXChildrenAttribute as CFString) else { return }
        guard CFGetTypeID(rawChildren) == CFArrayGetTypeID() else { throw Failure.invalidType }
        let children = rawChildren as! [AXUIElement]
        for child in children {
            try visit(
                child,
                depth: depth + 1,
                remaining: &remaining,
                visited: &visited,
                candidates: &candidates
            )
        }
    }

    private func outermostScrollArea(
        from boundary: AXUIElement,
        to window: AXUIElement
    ) throws -> AXUIElement? {
        var current = boundary
        var outermost: AXUIElement?
        var visited = Set<CFHashCode>()
        for _ in 0..<64 {
            guard visited.insert(CFHash(current)).inserted else { throw Failure.ancestryCycle }
            guard let rawParent = try optionalAttribute(current, kAXParentAttribute as CFString) else {
                throw Failure.ancestryUnavailable
            }
            guard CFGetTypeID(rawParent) == AXUIElementGetTypeID() else { throw Failure.invalidType }
            let parent = rawParent as! AXUIElement
            try requireTargetPID(parent)
            if CFEqual(parent, window) {
                return outermost
            }
            if try optionalString(parent, kAXRoleAttribute as CFString) == (kAXScrollAreaRole as String) {
                outermost = parent
            }
            current = parent
        }
        throw Failure.ancestryLimit
    }

    private func requireTargetPID(_ element: AXUIElement) throws {
        var elementPID: pid_t = 0
        let result = AXUIElementGetPid(element, &elementPID)
        guard result == .success else { throw mapAXError(result) }
        guard elementPID == pid else { throw Failure.pidMismatch }
    }

    private func elementFrame(_ element: AXUIElement) throws -> DesktopReposReachabilityFrame {
        let rawPosition = try requiredAttribute(element, kAXPositionAttribute as CFString)
        let rawSize = try requiredAttribute(element, kAXSizeAttribute as CFString)
        let position = try pointValue(rawPosition)
        let size = try sizeValue(rawSize)
        guard
              position.x.isFinite,
              position.y.isFinite,
              size.width.isFinite,
              size.height.isFinite,
              size.width > 0,
              size.height > 0 else {
            throw Failure.invalidType
        }
        return DesktopReposReachabilityFrame(
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height
        )
    }

    private func optionalString(_ element: AXUIElement, _ attribute: CFString) throws -> String? {
        guard let raw = try optionalAttribute(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == CFStringGetTypeID() else { throw Failure.invalidType }
        return raw as? String
    }

    private func actionNames(_ element: AXUIElement) throws -> [String] {
        try requireTargetPID(element)
        var rawActionNames: CFArray?
        let result = AXUIElementCopyActionNames(element, &rawActionNames)
        guard result == .success else { throw mapAXError(result) }
        guard let rawActionNames else { throw Failure.attributeUnavailable }
        guard CFGetTypeID(rawActionNames) == CFArrayGetTypeID(),
              let names = rawActionNames as? [String],
              names.allSatisfy({ !$0.isEmpty }) else {
            throw Failure.invalidType
        }
        return names
    }

    private func optionalTextValue(_ element: AXUIElement, _ attribute: CFString) throws -> String? {
        guard let raw = try optionalAttribute(element, attribute),
              CFGetTypeID(raw) == CFStringGetTypeID() else { return nil }
        return raw as? String
    }

    private func numericValue(_ raw: CFTypeRef) throws -> Double {
        guard CFGetTypeID(raw) == CFNumberGetTypeID(),
              let value = (raw as? NSNumber)?.doubleValue,
              value.isFinite else { throw Failure.invalidType }
        return value
    }

    private func pointValue(_ raw: CFTypeRef) throws -> CGPoint {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { throw Failure.invalidType }
        var point = CGPoint.zero
        guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { throw Failure.invalidType }
        return point
    }

    private func sizeValue(_ raw: CFTypeRef) throws -> CGSize {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { throw Failure.invalidType }
        var size = CGSize.zero
        guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { throw Failure.invalidType }
        return size
    }

    private func requiredAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFTypeRef {
        guard let value = try optionalAttribute(element, attribute) else { throw Failure.attributeUnavailable }
        return value
    }

    private func optionalAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFTypeRef? {
        switch copyAttribute(element, attribute) {
        case .value(let value):
            return value
        case .failure(let error) where error == .noValue || error == .attributeUnsupported:
            return nil
        case .failure(let error):
            throw mapAXError(error)
        }
    }

    private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXReadResult {
        for attempt in 0..<3 {
            var raw: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(element, attribute, &raw)
            if result == .success, let raw { return .value(raw) }
            if result == .cannotComplete, attempt < 2 {
                usleep(20_000)
                continue
            }
            return .failure(result)
        }
        return .failure(.cannotComplete)
    }

    private func mapAXError(_ error: AXError) -> Failure {
        switch error {
        case .cannotComplete:
            return .cannotComplete
        case .invalidUIElement, .invalidUIElementObserver:
            return .invalidElement
        case .apiDisabled:
            return .permissionDenied
        case .attributeUnsupported, .noValue:
            return .attributeUnavailable
        default:
            return .invalidType
        }
    }

    private typealias Failure = DesktopReposReachabilityAcquisitionFailureReason

    private struct PhaseAcquisition {
        let samples: [DesktopReposReachabilitySample]
        let durationMilliseconds: Int
        let stable: Bool
        let failure: Failure?

        static let empty = PhaseAcquisition(samples: [], durationMilliseconds: 0, stable: false, failure: nil)
    }

    private struct SemanticBinding {
        let window: AXUIElement
        let elements: SemanticElements
    }

    private struct ScrollBehaviorBinding {
        let semantic: SemanticBinding
        let incrementPage: AXUIElement
        let actionAdvertised: Bool
        let outerClipBefore: DesktopReposReachabilityFrame
    }

    private struct SemanticElements {
        let table: AXUIElement
        let applyAllowlist: AXUIElement
        let boundaryBody: AXUIElement
    }

    private struct SemanticCandidates {
        var table: [AXUIElement] = []
        var applyAllowlist: [AXUIElement] = []
        var boundaryBody: [AXUIElement] = []
    }

    private enum AXReadResult {
        case value(CFTypeRef)
        case failure(AXError)
    }
}

do {
    let options = try Options.parse(CommandLine.arguments)
    let result = try CaptureRunner(options: options).run()
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
