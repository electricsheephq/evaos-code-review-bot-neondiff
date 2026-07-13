import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import NeonDiffDesktopCore

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
            "usage: NeonDiffDesktopCapture --pid <pid> --ready <ready.json> --output-dir <directory>"
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
        guard arguments.count == 7,
              let pid = Int32(try value("--pid")),
              pid > 0 else {
            throw CaptureError.usage
        }
        return Options(
            pid: pid,
            readyURL: URL(fileURLWithPath: try value("--ready")).standardizedFileURL,
            outputDirectory: URL(fileURLWithPath: try value("--output-dir"), isDirectory: true).standardizedFileURL
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
