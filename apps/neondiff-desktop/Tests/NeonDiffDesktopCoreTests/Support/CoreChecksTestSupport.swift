import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

struct LegacyCoreCheckAssertion: Sendable {
    let message: String
    let passed: Bool
}

@MainActor
final class LegacyCoreChecksScenarioGate {
    static let shared = LegacyCoreChecksScenarioGate()

    private var isRunning = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func run<T>(_ operation: @MainActor () async throws -> T) async rethrows -> T {
        if isRunning {
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
            }
        } else {
            isRunning = true
        }

        defer { releaseNext() }
        return try await operation()
    }

    private func releaseNext() {
        if waiters.isEmpty {
            isRunning = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

final class LegacyCoreCheckRecorder {
    private(set) var assertions: [LegacyCoreCheckAssertion] = []

    func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        assertions.append(.init(message: message, passed: condition()))
    }
}

enum CoreChecksTestSupportError: Error {
    case expectedFailureMissing(String)
}

func checkedAsync<T>(_ message: String, _ operation: () async throws -> T) async throws -> T {
    try await operation()
}

func checkedCast<T>(_ value: Any, _ message: String) -> T {
    guard let value = value as? T else { preconditionFailure(message) }
    return value
}

func checkedValue<T>(_ value: T?, _ message: String) -> T {
    guard let value else { preconditionFailure(message) }
    return value
}

func awaitSemaphore(_ semaphore: DispatchSemaphore, timeout: DispatchTime) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(returning: semaphore.wait(timeout: timeout))
        }
    }
}

@discardableResult
func captureProviderVerificationFailure(
    _ message: String,
    _ operation: () throws -> Void
) throws -> Error {
    var capturedError: Error?
    do {
        try operation()
    } catch {
        capturedError = error
    }
    guard let capturedError else {
        throw CoreChecksTestSupportError.expectedFailureMissing(message)
    }
    return capturedError
}

final class CoreCLIFixture {
    let root: URL
    let cliURL: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("neondiff-desktop-core-tests-\(UUID().uuidString)", isDirectory: true)
        let packageBin = root.appendingPathComponent("node_modules/.bin", isDirectory: true)
        try FileManager.default.createDirectory(at: packageBin, withIntermediateDirectories: true)
        try """
        {"name":"neondiff","bin":{"neondiff":"dist/src/cli.js"}}
        """.write(to: root.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        cliURL = packageBin.appendingPathComponent("neondiff")
        try """
        #!/usr/bin/env bash
        if [[ "$1" == "stdin-check" ]]; then
          IFS= read -r input || true
          if [[ "$input" == "fixture-provider-value" ]]; then
            printf '{"ok":true,"receivedBytes":22}\n'
            exit 0
          fi
          printf '{"ok":false}\n'
          exit 2
        fi
        printf '{"command":"%s","args":%d}\n' "$1" "$#"
        """.write(to: cliURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cliURL.path)
    }
}

final class InMemoryProviderSecretStore: DesktopSecretStoring {
    var secrets: [String: String] = [:]

    func setSecret(_ secret: String, account: String) throws {
        secrets[account] = secret
    }

    func readSecret(account: String) throws -> String? {
        secrets[account]
    }

    func containsSecret(account: String) -> Bool {
        secrets[account] != nil
    }

    func deleteSecret(account: String) throws {
        secrets.removeValue(forKey: account)
    }
}

final class FakeProviderVerificationCLI: NeonDiffCLIClienting {
    var result: CLIRunResult
    var error: Error?
    private(set) var arguments: [String] = []
    private(set) var standardInput: Data?
    private(set) var timeout: TimeInterval?

    init(result: CLIRunResult) {
        self.result = result
    }

    func run(arguments: [String], timeout: TimeInterval) throws -> CLIRunResult {
        fatalError("provider verification must use the standard-input overload")
    }

    func run(arguments: [String], standardInput: Data?, timeout: TimeInterval) throws -> CLIRunResult {
        self.arguments = arguments
        self.standardInput = standardInput
        self.timeout = timeout
        if let error { throw error }
        return result
    }

    func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        fatalError("provider verification never launches detached")
    }
}

enum FixtureProviderTransportError: Error {
    case unavailable
}


final class GitHubFixtureURLProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var requestBodies: [String] = []
private static let lock = NSLock()

static func reset() {
    lock.lock()
    requests.removeAll()
    requestBodies.removeAll()
    lock.unlock()
}

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix("github.local") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let capturedBody = Self.captureBody(from: request)
        Self.lock.lock()
        Self.requests.append(request)
        Self.requestBodies.append(capturedBody)
        Self.lock.unlock()

        let path = request.url?.path ?? ""
        let query = request.url?.query ?? ""
        let statusCode = 200
        let payload: String
        switch path {
        case "/login/device/code":
            payload = """
            {
              "device_code": "device-fixture",
              "user_code": "WDJB-MJHT",
              "verification_uri": "https://github.com/login/device",
              "expires_in": 900,
              "interval": 5
            }
            """
        case "/login/oauth/access_token":
            if capturedBody.contains("grant_type=refresh_token") {
                payload = """
                {
                  "access_token": "fixture-refreshed-access-token",
                  "refresh_token": "fixture-refreshed-refresh-token",
                  "expires_in": 28800,
                  "refresh_token_expires_in": 15811200,
                  "token_type": "bearer"
                }
                """
            } else {
                payload = """
                {
                  "access_token": "fixture-access-token",
                  "refresh_token": "fixture-refresh-token",
                  "expires_in": 28800,
                  "refresh_token_expires_in": 15811200,
                  "token_type": "bearer"
                }
                """
            }
        case "/user":
            payload = #"{"login":"octo-user"}"#
        case "/user/installations":
            if query.contains("page=2") {
                payload = #"{"installations":[{"id":43,"account":{"login":"second-org"}}]}"#
            } else if query.contains("page=3") {
                payload = #"{"installations":[]}"#
            } else {
                payload = #"{"installations":[{"id":42,"account":{"login":"octo-org"}}]}"#
            }
        case "/user/installations/42/repositories":
            if query.contains("page=2") {
                payload = #"{"repositories":[]}"#
            } else {
                payload = """
                {
                  "repositories": [
                    {
                      "full_name": "octo-org/private-repo",
                      "visibility": "private",
                      "private": true,
                      "permissions": {
                        "admin": false,
                        "push": false,
                        "pull": true
                      }
                    }
                  ]
                }
                """
            }
        case "/user/installations/43/repositories":
            if query.contains("page=2") {
                payload = #"{"repositories":[]}"#
            } else {
                payload = """
                {
                  "repositories": [
                    {
                      "full_name": "second-org/public-repo",
                      "visibility": "public",
                      "private": false,
                      "permissions": {
                        "admin": false,
                        "push": true,
                        "pull": true
                      }
                    }
                  ]
                }
                """
            }
        default:
            payload = #"{"message":"unexpected fixture path"}"#
        }

        let data = Data(payload.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func captureBody(from request: URLRequest) -> String {
        if let body = request.httpBody {
            return String(data: body, encoding: .utf8) ?? ""
        }
        guard let stream = request.httpBodyStream else { return "" }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: bufferSize)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

final class GitHubRateLimitURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "rate-limit.github.local"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let payload = Data(#"{"message":"API rate limit exceeded","token":"must-not-surface"}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "X-RateLimit-Remaining": "0"
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}


func encodedProviderEnvelope(
    detail: String = "Verified provider with redacted metadata.",
    troubleshooting: [String] = [],
    diagnostic: Any? = nil
) throws -> String {
    var envelope: [String: Any] = [
        "ok": true,
        "command": "providers verify",
        "checkedAt": "2026-07-10T12:03:00.000Z",
        "providerId": "zcode-glm",
        "state": "healthy",
        "mode": "openai_compatible_models",
        "detail": detail,
        "redacted": true,
        "troubleshooting": troubleshooting
    ]
    if let diagnostic {
        envelope["diagnostic"] = diagnostic
    }
    let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    return checkedValue(String(data: data, encoding: .utf8), "provider envelope serializes as UTF-8")
}
