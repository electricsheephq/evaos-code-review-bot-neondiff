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
    case permission(String)
    case window(String)
    case screenshot(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            "usage: NeonDiffDesktopCapture --pid <pid> --ready <ready.json> --output-dir <directory> [--repos-reachability]"
        case .unsafePath(let detail): "Unsafe capture path: \(detail)"
        case .invalidReadyFile: "Evaluation readiness file is invalid or does not match the target process."
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

private struct CaptureRunner {
    let options: Options

    func run() throws -> [String: Any] {
        let ready = try loadReady()
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
        try writeReachabilityIfRequired(ready: ready)

        return [
            "ok": true,
            "fixtureId": ready.fixtureId,
            "windowNumber": ready.windowNumber,
            "screenshot": try evidence(screenshotURL),
            "accessibility": try evidence(accessibilityURL),
            "geometry": try evidence(geometryURL)
        ]
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

    private func writeReachabilityIfRequired(ready: ReadyDocument) throws {
        guard options.capturesReposReachability,
              ready.fixtureId == DesktopReposReachabilityFixture.tabRepos.rawValue,
              abs(ready.contentFrame.width - 1040) <= 1,
              abs(ready.contentFrame.height - 680) <= 1 else {
            return
        }
        let trace = DesktopReposReachabilityAXTracer(pid: options.pid, ready: ready).capture()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(trace)
        try data.write(
            to: options.outputDirectory.appendingPathComponent("reachability.json"),
            options: [.atomic]
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

        let pre: (samples: [DesktopReposReachabilitySample], durationMilliseconds: Int, stable: Bool) = timeoutInstalled
            ? acquireStableSamples()
            : (samples: [], durationMilliseconds: 0, stable: false)
        let scroll = timeoutInstalled ? scrollBoundaryAncestorToMaximum() : nil
        let post = timeoutInstalled ? acquireStableSamples() : (samples: [], durationMilliseconds: 0, stable: false)

        // The ready document is emitted only after the DEBUG fixture render
        // latch and three stable 100 ms readiness samples have completed.
        let readinessGatePassed = ready.ready
        return DesktopReposReachabilityTrace(
            schemaVersion: 1,
            fixture: .tabRepos,
            ready: readinessGatePassed,
            quiescent: readinessGatePassed && pre.stable,
            requestedContentSize: DesktopEvaluationContentSize(width: 1040, height: 680),
            sampleIntervalMilliseconds: 100,
            preScrollAcquisitionMilliseconds: pre.durationMilliseconds,
            postScrollAcquisitionMilliseconds: post.durationMilliseconds,
            tolerancePoints: Self.tolerance,
            preScrollSamples: pre.samples,
            outerScroll: scroll,
            postScrollSamples: post.samples
        )
    }

    private func acquireStableSamples() -> (
        samples: [DesktopReposReachabilitySample],
        durationMilliseconds: Int,
        stable: Bool
    ) {
        let started = DispatchTime.now().uptimeNanoseconds
        var nextDeadline = started
        var rolling: [DesktopReposReachabilitySample] = []
        while true {
            let beforeSample = DispatchTime.now().uptimeNanoseconds
            let elapsed = milliseconds(from: started, to: beforeSample)
            guard elapsed <= Self.maximumAcquisitionMilliseconds else {
                return (rolling, elapsed, false)
            }
            rolling.append(sample(elapsedMilliseconds: elapsed))
            if rolling.count > 3 { rolling.removeFirst() }
            let duration = milliseconds(from: started, to: DispatchTime.now().uptimeNanoseconds)
            if rolling.count == 3,
               samplesMatch(rolling[0], rolling[1]),
               samplesMatch(rolling[0], rolling[2]),
               duration <= Self.maximumAcquisitionMilliseconds {
                return (rolling, duration, true)
            }
            guard duration <= Self.maximumAcquisitionMilliseconds else {
                return (rolling, duration, false)
            }
            nextDeadline += Self.intervalNanoseconds
            let now = DispatchTime.now().uptimeNanoseconds
            if nextDeadline > now {
                usleep(useconds_t((nextDeadline - now) / 1_000))
            }
        }
    }

    private func milliseconds(from start: UInt64, to end: UInt64) -> Int {
        Int((end - start) / 1_000_000)
    }

    private func sample(elapsedMilliseconds: Int) -> DesktopReposReachabilitySample {
        guard let window = verifiedWindow(),
              let viewport = elementFrame(window),
              let elements = semanticElements(in: window) else {
            return DesktopReposReachabilitySample(
                elapsedMilliseconds: elapsedMilliseconds,
                viewport: DesktopReposReachabilityFrame(x: 0, y: 0, width: 0, height: 0),
                regions: []
            )
        }
        let pairs: [(DesktopReposReachabilityRegion, AXUIElement?)] = [
            (.table, elements.table),
            (.applyAllowlist, elements.applyAllowlist),
            (.boundaryBody, elements.boundaryBody)
        ]
        let regions = pairs.compactMap { id, element -> DesktopReposReachabilityRegionFrame? in
            guard let element, let frame = elementFrame(element) else { return nil }
            return DesktopReposReachabilityRegionFrame(id: id, frame: frame)
        }
        return DesktopReposReachabilitySample(
            elapsedMilliseconds: elapsedMilliseconds,
            viewport: viewport,
            regions: regions
        )
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

    private func scrollBoundaryAncestorToMaximum() -> DesktopReposOuterScrollObservation? {
        guard let window = verifiedWindow(),
              let boundary = semanticElements(in: window)?.boundaryBody,
              let scrollArea = outermostScrollArea(from: boundary, to: window) else {
            return nil
        }
        guard case .value(let rawScrollBar) = copyAttribute(scrollArea, kAXVerticalScrollBarAttribute as CFString),
              CFGetTypeID(rawScrollBar) == AXUIElementGetTypeID() else {
            return unsupportedScroll()
        }
        let scrollBar = rawScrollBar as! AXUIElement
        guard elementBelongsToTarget(scrollBar) else { return unsupportedScroll() }

        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(
            scrollBar,
            kAXValueAttribute as CFString,
            &settable
        ) == .success, settable.boolValue else {
            return unsupportedScroll()
        }
        guard case .value(let rawMinimum) = copyAttribute(scrollBar, kAXMinValueAttribute as CFString),
              case .value(let rawMaximum) = copyAttribute(scrollBar, kAXMaxValueAttribute as CFString),
              case .value(let rawBefore) = copyAttribute(scrollBar, kAXValueAttribute as CFString),
              let minimum = numericValue(rawMinimum),
              let maximum = numericValue(rawMaximum),
              let before = numericValue(rawBefore) else {
            return unsupportedScroll()
        }
        let setResult = AXUIElementSetAttributeValue(
            scrollBar,
            kAXValueAttribute as CFString,
            rawMaximum
        )
        guard setResult == .success,
              case .value(let rawReadback) = copyAttribute(scrollBar, kAXValueAttribute as CFString),
              let readback = numericValue(rawReadback) else {
            return DesktopReposOuterScrollObservation(
                verticalScrollBarSupported: true,
                minimumValue: minimum,
                maximumValue: maximum,
                valueBeforeScroll: before,
                valueAfterScroll: nil,
                setToMaximumSucceeded: false
            )
        }
        return DesktopReposOuterScrollObservation(
            verticalScrollBarSupported: true,
            minimumValue: minimum,
            maximumValue: maximum,
            valueBeforeScroll: before,
            valueAfterScroll: readback,
            setToMaximumSucceeded: abs(maximum - readback) <= 0.001
        )
    }

    private func unsupportedScroll() -> DesktopReposOuterScrollObservation {
        DesktopReposOuterScrollObservation(
            verticalScrollBarSupported: false,
            minimumValue: nil,
            maximumValue: nil,
            valueBeforeScroll: nil,
            valueAfterScroll: nil,
            setToMaximumSucceeded: false
        )
    }

    private func verifiedWindow() -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        guard elementBelongsToTarget(application),
              case .value(let rawWindows) = copyAttribute(application, kAXWindowsAttribute as CFString),
              CFGetTypeID(rawWindows) == CFArrayGetTypeID() else {
            return nil
        }
        let windows = rawWindows as! [AXUIElement]
        guard windows.count == 1, let window = windows.first,
              elementBelongsToTarget(window),
              stringValue(window, kAXRoleAttribute as CFString) == (kAXWindowRole as String),
              let frame = elementFrame(window),
              abs(frame.width - ready.windowFrame.width) <= Self.tolerance,
              abs(frame.height - ready.windowFrame.height) <= Self.tolerance else {
            return nil
        }
        return window
    }

    private func semanticElements(in window: AXUIElement) -> SemanticElements? {
        var result = SemanticElements()
        var remaining = 10_000
        var visited = Set<CFHashCode>()
        visit(
            window,
            depth: 0,
            remaining: &remaining,
            visited: &visited,
            result: &result
        )
        return result
    }

    private func visit(
        _ element: AXUIElement,
        depth: Int,
        remaining: inout Int,
        visited: inout Set<CFHashCode>,
        result: inout SemanticElements
    ) {
        guard depth <= 32, remaining > 0, elementBelongsToTarget(element) else { return }
        let hash = CFHash(element)
        guard visited.insert(hash).inserted else { return }
        remaining -= 1

        let role = stringValue(element, kAXRoleAttribute as CFString)
        let description = stringValue(element, kAXDescriptionAttribute as CFString)
        let value = stringValue(element, kAXValueAttribute as CFString)
        if result.table == nil, role == (kAXTableRole as String) {
            result.table = element
        }
        if result.applyAllowlist == nil,
           role == (kAXButtonRole as String),
           [description, value].compactMap({ $0 }).contains("Apply Allowlist") {
            result.applyAllowlist = element
        }
        if result.boundaryBody == nil,
           role == (kAXStaticTextRole as String),
           [description, value].compactMap({ $0 }).contains(where: {
               $0.contains("Repo changes are written through")
           }) {
            result.boundaryBody = element
        }

        guard case .value(let rawChildren) = copyAttribute(element, kAXChildrenAttribute as CFString),
              CFGetTypeID(rawChildren) == CFArrayGetTypeID() else { return }
        let children = rawChildren as! [AXUIElement]
        for child in children {
            visit(
                child,
                depth: depth + 1,
                remaining: &remaining,
                visited: &visited,
                result: &result
            )
        }
    }

    private func outermostScrollArea(
        from boundary: AXUIElement,
        to window: AXUIElement
    ) -> AXUIElement? {
        var current = boundary
        var outermost: AXUIElement?
        var visited = Set<CFHashCode>()
        for _ in 0..<64 {
            guard visited.insert(CFHash(current)).inserted,
                  case .value(let rawParent) = copyAttribute(current, kAXParentAttribute as CFString),
                  CFGetTypeID(rawParent) == AXUIElementGetTypeID() else {
                return nil
            }
            let parent = rawParent as! AXUIElement
            guard elementBelongsToTarget(parent) else { return nil }
            if CFEqual(parent, window) {
                return outermost
            }
            if stringValue(parent, kAXRoleAttribute as CFString) == (kAXScrollAreaRole as String) {
                outermost = parent
            }
            current = parent
        }
        return nil
    }

    private func elementBelongsToTarget(_ element: AXUIElement) -> Bool {
        var elementPID: pid_t = 0
        return AXUIElementGetPid(element, &elementPID) == .success && elementPID == pid
    }

    private func elementFrame(_ element: AXUIElement) -> DesktopReposReachabilityFrame? {
        guard case .value(let rawPosition) = copyAttribute(element, kAXPositionAttribute as CFString),
              case .value(let rawSize) = copyAttribute(element, kAXSizeAttribute as CFString),
              let position = pointValue(rawPosition),
              let size = sizeValue(rawSize),
              position.x.isFinite,
              position.y.isFinite,
              size.width.isFinite,
              size.height.isFinite,
              size.width > 0,
              size.height > 0 else {
            return nil
        }
        return DesktopReposReachabilityFrame(
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height
        )
    }

    private func stringValue(_ element: AXUIElement, _ attribute: CFString) -> String? {
        guard case .value(let raw) = copyAttribute(element, attribute),
              CFGetTypeID(raw) == CFStringGetTypeID() else { return nil }
        return raw as? String
    }

    private func numericValue(_ raw: CFTypeRef) -> Double? {
        guard CFGetTypeID(raw) == CFNumberGetTypeID() else { return nil }
        guard let value = (raw as? NSNumber)?.doubleValue, value.isFinite else { return nil }
        return value
    }

    private func pointValue(_ raw: CFTypeRef) -> CGPoint? {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(raw as! AXValue, .cgPoint, &point) ? point : nil
    }

    private func sizeValue(_ raw: CFTypeRef) -> CGSize? {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(raw as! AXValue, .cgSize, &size) ? size : nil
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

    private struct SemanticElements {
        var table: AXUIElement?
        var applyAllowlist: AXUIElement?
        var boundaryBody: AXUIElement?
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
