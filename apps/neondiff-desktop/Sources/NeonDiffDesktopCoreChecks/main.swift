import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    if condition() {
        return true
    }
    fputs("check failed: \(message)\n", stderr)
    exit(1)
}

func checkedAsync<T>(_ message: String, _ operation: () async throws -> T) async -> T {
    do {
        return try await operation()
    } catch {
        fputs("check failed: \(message): \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
        exit(1)
    }
}

func checkedCast<T>(_ value: Any, _ message: String) -> T {
    guard let value = value as? T else {
        fputs("check failed: \(message)\n", stderr)
        exit(1)
    }
    return value
}

func checkedValue<T>(_ value: T?, _ message: String) -> T {
    guard let value else {
        fputs("check failed: \(message)\n", stderr)
        exit(1)
    }
    return value
}

func awaitSemaphore(_ semaphore: DispatchSemaphore, timeout: DispatchTime) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            continuation.resume(returning: semaphore.wait(timeout: timeout))
        }
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

@discardableResult
func captureProviderVerificationFailure(
    _ message: String,
    _ operation: () throws -> Void
) -> Error {
    do {
        try operation()
        fputs("check failed: \(message) did not fail\n", stderr)
        exit(1)
    } catch {
        return error
    }
}

var providerFlow = OnboardingFlow()
check(providerFlow.currentStep == .welcome, "flow starts at welcome")
providerFlow.advance()
check(providerFlow.currentStep == .provider, "welcome advances to provider")
check(!providerFlow.canAdvance, "provider step requires a stored provider key")
providerFlow.providerKeyStored = true
check(providerFlow.canAdvance, "provider step advances after key storage")

var publicFlow = OnboardingFlow(providerKeyStored: true)
publicFlow.currentStep = .license
publicFlow.mode = .publicReposOnly
publicFlow.licenseActivation = .servicePending
check(publicFlow.canAdvance, "public repo path can finish while license service is pending")
publicFlow.advance()
check(publicFlow.currentStep == .done, "public repo path finishes from license step")

var privateFlow = OnboardingFlow(providerKeyStored: true)
privateFlow.currentStep = .license
privateFlow.mode = .privateRepos
privateFlow.licenseActivation = .servicePending
check(!privateFlow.canAdvance, "private repo path cannot fake activation while service is pending")
check(privateFlow.licenseActivation != .activated, "pending service is not activated")

var daemonFlow = OnboardingFlow(providerKeyStored: true)
daemonFlow.currentStep = .daemon
check(!daemonFlow.canAdvance, "daemon step requires bootstrap/status check")
daemonFlow.daemonBootstrapChecked = true
check(daemonFlow.canAdvance, "daemon step advances after bootstrap/status check")

let tempRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("neondiff-desktop-core-checks-\(UUID().uuidString)", isDirectory: true)
let packageBin = tempRoot.appendingPathComponent("node_modules/.bin", isDirectory: true)
try FileManager.default.createDirectory(at: packageBin, withIntermediateDirectories: true)
try """
{"name":"neondiff","bin":{"neondiff":"dist/src/cli.js"}}
""".write(to: tempRoot.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
let localCLI = packageBin.appendingPathComponent("neondiff")
try """
#!/usr/bin/env bash
if [[ "$1" == "stdin-check" ]]; then
  IFS= read -r input || true
  if [[ "$input" == "fixture-provider-value" ]]; then
    printf '{"ok":true,"receivedBytes":22}\\n'
    exit 0
  fi
  printf '{"ok":false}\\n'
  exit 2
fi
printf '{"command":"%s","args":%d}\\n' "$1" "$#"
""".write(to: localCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: localCLI.path)
defer { try? FileManager.default.removeItem(at: tempRoot) }

let nestedBundleURL = tempRoot
    .appendingPathComponent("apps/neondiff-desktop/dist/NeonDiffDesktop.app", isDirectory: true)
check(
    NeonDiffCLIResolver.findPackageRoot(startingAt: nestedBundleURL)?.standardizedFileURL == tempRoot.standardizedFileURL,
    "CLI resolver discovers the repo package root from a local app bundle path"
)

check(
    NeonDiffCLIResolver.resolveExecutablePath("neondiff", workingDirectory: tempRoot)?.standardizedFileURL == localCLI.standardizedFileURL,
    "local package CLI is preferred over GUI PATH fallback"
)

let standardInputCLI = NeonDiffCLIClient(executablePath: localCLI.path, workingDirectory: tempRoot)
let standardInputResult = try standardInputCLI.run(
    arguments: ["stdin-check"],
    standardInput: Data("fixture-provider-value".utf8),
    timeout: 5
)
check(standardInputResult.exitCode == 0, "CLI standard-input transport reaches the bounded child process")
check(standardInputResult.stdout.contains("\"receivedBytes\":22"), "CLI standard-input transport returns only redacted metadata")
check(!standardInputResult.stdout.contains("fixture-provider-value"), "CLI output never echoes standard input")

let prelaunchEntered = DispatchSemaphore(value: 0)
let prelaunchRelease = DispatchSemaphore(value: 0)
var prelaunchWriteCalls = 0
let prelaunchClient = NeonDiffCLIClient(
    executablePath: localCLI.path,
    workingDirectory: tempRoot,
    standardInputWriter: { _, _, _ in
        prelaunchWriteCalls += 1
        return 0
    },
    beforeProcessLaunch: {
        prelaunchEntered.signal()
        _ = prelaunchRelease.wait(timeout: .now() + 2)
    }
)
let prelaunchTask = Task {
    try await prelaunchClient.runCancellable(
        arguments: ["stdin-check"],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 5
    )
}
let prelaunchGateReached = await awaitSemaphore(prelaunchEntered, timeout: .now() + 1)
check(prelaunchGateReached == .success, "pre-launch cancellation fixture reaches its gate")
prelaunchTask.cancel()
prelaunchRelease.signal()
var prelaunchCancelled = false
do {
    _ = try await prelaunchTask.value
} catch NeonDiffCLIError.cancelled {
    prelaunchCancelled = true
} catch {
    fputs("check failed: pre-launch cancellation returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(prelaunchCancelled, "pre-launch cancellation returns the typed cancellation result")
check(prelaunchWriteCalls == 0, "pre-launch cancellation writes zero secret bytes")

let postLaunchMarker = tempRoot.appendingPathComponent("post-launch-cancel-child.pid")
let postLaunchCLI = tempRoot.appendingPathComponent("post-launch-cancel-cli")
try """
#!/usr/bin/env bash
printf '%s\\n' "$$" > \(postLaunchMarker.path)
trap '' TERM
while :; do :; done
""".write(to: postLaunchCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: postLaunchCLI.path)
let postLaunchPipe = Pipe()
let postLaunchInspectionFD = dup(postLaunchPipe.fileHandleForReading.fileDescriptor)
check(postLaunchInspectionFD >= 0, "post-launch cancellation duplicates its stdin inspection descriptor")
let postLaunchEntered = DispatchSemaphore(value: 0)
let postLaunchRelease = DispatchSemaphore(value: 0)
var postLaunchWriteCalls = 0
let postLaunchClient = NeonDiffCLIClient(
    executablePath: postLaunchCLI.path,
    workingDirectory: tempRoot,
    standardInputPipeFactory: { postLaunchPipe },
    standardInputWriter: { descriptor, buffer, count in
        postLaunchWriteCalls += 1
        return Darwin.write(descriptor, buffer, count)
    },
    afterProcessLaunch: {
        postLaunchEntered.signal()
        _ = postLaunchRelease.wait(timeout: .now() + 2)
    }
)
let postLaunchTask = Task {
    try await postLaunchClient.runCancellable(
        arguments: [],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 5
    )
}
let postLaunchGateReached = await awaitSemaphore(postLaunchEntered, timeout: .now() + 1)
check(postLaunchGateReached == .success, "post-launch cancellation fixture reaches its pre-write gate")
postLaunchTask.cancel()
postLaunchRelease.signal()
var postLaunchCancelled = false
do {
    _ = try await postLaunchTask.value
} catch NeonDiffCLIError.cancelled {
    postLaunchCancelled = true
} catch {
    fputs("check failed: post-launch cancellation returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(postLaunchCancelled, "post-launch cancellation returns only after cleanup")
check(postLaunchWriteCalls == 0, "post-launch pre-write cancellation writes zero secret bytes")
let postLaunchReadFlags = fcntl(postLaunchInspectionFD, F_GETFL)
check(postLaunchReadFlags >= 0 && fcntl(postLaunchInspectionFD, F_SETFL, postLaunchReadFlags | O_NONBLOCK) == 0, "post-launch inspection is nonblocking")
var postLaunchBuffer = [UInt8](repeating: 0, count: 64)
let postLaunchBytes = postLaunchBuffer.withUnsafeMutableBytes { Darwin.read(postLaunchInspectionFD, $0.baseAddress, $0.count) }
_ = Darwin.close(postLaunchInspectionFD)
check(postLaunchBytes <= 0, "cancelled stdin carries no provider secret bytes")
if FileManager.default.fileExists(atPath: postLaunchMarker.path) {
    let postLaunchPIDText = try String(contentsOf: postLaunchMarker, encoding: .utf8)
    let postLaunchPID = checkedValue(Int32(postLaunchPIDText.trimmingCharacters(in: .whitespacesAndNewlines)), "post-launch child records its pid")
    check(kill(postLaunchPID, 0) != 0 && errno == ESRCH, "cancelled child is terminated and reaped before return")
} else {
    check(postLaunchCancelled, "child cancelled before script startup still completes bounded cleanup")
}

let stalledInputMarker = tempRoot.appendingPathComponent("stalled-input-child.pid")
let stalledInputCLI = tempRoot.appendingPathComponent("stalled-input-cli")
try """
#!/usr/bin/env bash
printf '%s\\n' "$$" > \(stalledInputMarker.path)
trap '' TERM
while :; do :; done
""".write(to: stalledInputCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stalledInputCLI.path)

let stalledInputClient = NeonDiffCLIClient(
    executablePath: stalledInputCLI.path,
    workingDirectory: tempRoot,
    afterProcessLaunch: {
        let markerDeadline = Date().addingTimeInterval(1)
        while !FileManager.default.fileExists(atPath: stalledInputMarker.path), Date() < markerDeadline {
            usleep(1_000)
        }
    }
)
let stalledInputStartedAt = Date()
var stalledInputTimedOut = false
do {
    _ = try stalledInputClient.run(
        arguments: [],
        standardInput: Data(repeating: 0x78, count: 64 * 1024),
        timeout: 1.5
    )
} catch NeonDiffCLIError.timedOut {
    stalledInputTimedOut = true
} catch {
    fputs("check failed: stalled stdin returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
let stalledInputElapsed = Date().timeIntervalSince(stalledInputStartedAt)
check(stalledInputTimedOut, "a child that never drains maximum-size stdin returns timedOut")
check(stalledInputElapsed < 3, "stdin delivery and process execution share the configured deadline")
let stalledInputPIDText = try String(contentsOf: stalledInputMarker, encoding: .utf8)
let stalledInputPID = checkedValue(
    Int32(stalledInputPIDText.trimmingCharacters(in: .whitespacesAndNewlines)),
    "stalled stdin child records its process id"
)
let stalledInputChildWasRunning = kill(stalledInputPID, 0) == 0
if stalledInputChildWasRunning {
    _ = kill(stalledInputPID, SIGKILL)
}
check(!stalledInputChildWasRunning, "timed-out stdin child is terminated and reaped")

let saturatedInputMarker = tempRoot.appendingPathComponent("saturated-input-child.pids")
let saturatedInputCLI = tempRoot.appendingPathComponent("saturated-input-cli")
try """
#!/usr/bin/env bash
printf '%s\\n' "$$" > \(saturatedInputMarker.path)
trap '' TERM
while :; do :; done
""".write(to: saturatedInputCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: saturatedInputCLI.path)

let saturatedInputPipe = Pipe()
let saturatedWriteFD = saturatedInputPipe.fileHandleForWriting.fileDescriptor
let saturatedReadFD = saturatedInputPipe.fileHandleForReading.fileDescriptor
let saturatedInspectionReadFD = dup(saturatedReadFD)
check(saturatedInspectionReadFD >= 0, "saturated stdin fixture duplicates its inspection reader")
let saturatedWriteFlags = fcntl(saturatedWriteFD, F_GETFL)
check(saturatedWriteFlags >= 0, "saturated stdin fixture reads pipe flags")
check(fcntl(saturatedWriteFD, F_SETFL, saturatedWriteFlags | O_NONBLOCK) == 0, "saturated stdin fixture enables nonblocking fill")
let saturatedSentinel = [UInt8](repeating: 0xA5, count: 4 * 1024)
var saturatedBytes = 0
while true {
    let written = saturatedSentinel.withUnsafeBytes { bytes in
        Darwin.write(saturatedWriteFD, bytes.baseAddress, bytes.count)
    }
    if written > 0 {
        saturatedBytes += written
        continue
    }
    if written == -1 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        break
    }
    check(false, "saturated stdin fixture fills the pipe to EAGAIN")
}
check(saturatedBytes > 0, "saturated stdin fixture preloads the pipe")
check(fcntl(saturatedWriteFD, F_SETFL, saturatedWriteFlags) == 0, "saturated stdin fixture restores blocking writes")

let saturatedInputClient = NeonDiffCLIClient(
    executablePath: saturatedInputCLI.path,
    workingDirectory: tempRoot,
    standardInputPipeFactory: { saturatedInputPipe }
)
let saturatedInputStartedAt = Date()
var saturatedInputTimedOut = false
do {
    _ = try saturatedInputClient.run(
        arguments: [],
        standardInput: Data(repeating: 0x78, count: 64 * 1024),
        timeout: 0.75
    )
} catch NeonDiffCLIError.timedOut {
    saturatedInputTimedOut = true
} catch {
    fputs("check failed: saturated stdin returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
let saturatedInputElapsed = Date().timeIntervalSince(saturatedInputStartedAt)
let saturatedInputPIDs = try String(contentsOf: saturatedInputMarker, encoding: .utf8)
    .split(whereSeparator: \.isWhitespace)
    .compactMap { Int32($0) }
check(saturatedInputPIDs.count == 1, "saturated stdin fixture records its child pid")

let saturatedReadFlags = fcntl(saturatedInspectionReadFD, F_GETFL)
check(saturatedReadFlags >= 0, "saturated stdin fixture reads drain flags")
check(fcntl(saturatedInspectionReadFD, F_SETFL, saturatedReadFlags | O_NONBLOCK) == 0, "saturated stdin fixture enables nonblocking drain")
var postReturnInputBytes = 0
var drainBuffer = [UInt8](repeating: 0, count: 4 * 1024)
let saturatedDrainDeadline = Date().addingTimeInterval(1)
while Date() < saturatedDrainDeadline {
    let count = drainBuffer.withUnsafeMutableBytes { bytes in
        Darwin.read(saturatedInspectionReadFD, bytes.baseAddress, bytes.count)
    }
    if count > 0 {
        postReturnInputBytes += drainBuffer.prefix(count).filter { $0 == 0x78 }.count
        continue
    }
    if count == 0 { break }
    if errno == EAGAIN || errno == EWOULDBLOCK {
        usleep(10_000)
        continue
    }
    check(false, "saturated stdin fixture drains without read errors")
}
_ = Darwin.close(saturatedInspectionReadFD)
check(saturatedInputTimedOut, "a saturated stdin pipe shares the process timeout")
check(saturatedInputElapsed < 1.5, "stdin writer lifetime is bounded before run returns")
check(postReturnInputBytes == 0, "no stdin writer resumes after run returns")

var cleanupTerminateCalls = 0
var cleanupKillCalls = 0
var cleanupWaitCalls = 0
var cleanupFailedBoundedly = false
do {
    try NeonDiffProcessCleanup.terminateAndReap(
        isRunning: { true },
        terminate: { cleanupTerminateCalls += 1 },
        kill: { cleanupKillCalls += 1 },
        waitForTermination: { _ in
            cleanupWaitCalls += 1
            return .timedOut
        }
    )
} catch NeonDiffCLIError.cleanupTimedOut {
    cleanupFailedBoundedly = true
} catch {
    fputs("check failed: bounded cleanup returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(cleanupFailedBoundedly, "unobserved process cleanup returns an explicit bounded error")
check(cleanupTerminateCalls == 1, "bounded process cleanup sends TERM once")
check(cleanupKillCalls == 1, "bounded process cleanup escalates to SIGKILL once")
check(cleanupWaitCalls == 2, "bounded process cleanup performs only its two bounded waits")

let injectedClockBase = DispatchTime.now().uptimeNanoseconds
var launchDeadlineClockCalls = 0
var launchDeadlineWriteCalls = 0
let launchDeadlineClient = NeonDiffCLIClient(
    executablePath: stalledInputCLI.path,
    workingDirectory: tempRoot,
    standardInputPipeFactory: { Pipe() },
    monotonicNow: {
        launchDeadlineClockCalls += 1
        return DispatchTime(
            uptimeNanoseconds: injectedClockBase + (launchDeadlineClockCalls == 1 ? 0 : 2_000_000_000)
        )
    },
    standardInputWriter: { _, _, _ in
        launchDeadlineWriteCalls += 1
        return 0
    }
)
var launchDeadlineTimedOut = false
do {
    _ = try launchDeadlineClient.run(
        arguments: [],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 1
    )
} catch NeonDiffCLIError.timedOut {
    launchDeadlineTimedOut = true
} catch {
    fputs("check failed: post-launch deadline returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(launchDeadlineTimedOut, "launch completing after the deadline returns timedOut")
check(launchDeadlineWriteCalls == 0, "launch completing after the deadline writes zero secret bytes")

var interruptedWriteCalls = 0
let interruptedWriteClient = NeonDiffCLIClient(
    executablePath: stalledInputCLI.path,
    workingDirectory: tempRoot,
    standardInputPipeFactory: { Pipe() },
    monotonicNow: {
        let offset: UInt64 = interruptedWriteCalls == 0 ? 100_000_000 : 2_000_000_000
        return DispatchTime(uptimeNanoseconds: injectedClockBase + offset)
    },
    standardInputWriter: { _, _, _ in
        interruptedWriteCalls += 1
        errno = EINTR
        return -1
    }
)
var interruptedWriteTimedOut = false
do {
    _ = try interruptedWriteClient.run(
        arguments: [],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 1
    )
} catch NeonDiffCLIError.timedOut {
    interruptedWriteTimedOut = true
} catch {
    fputs("check failed: interrupted stdin deadline returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(interruptedWriteTimedOut, "EINTR retry observes the original absolute deadline")
check(interruptedWriteCalls == 1, "deadline is rechecked before retrying an interrupted secret write")

let closedInputMarker = tempRoot.appendingPathComponent("closed-input-child.pid")
let closedInputCLI = tempRoot.appendingPathComponent("closed-input-cli")
try """
#!/usr/bin/env bash
exec 0<&-
printf '%s\\n' "$$" > \(closedInputMarker.path)
trap '' TERM
while :; do :; done
""".write(to: closedInputCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: closedInputCLI.path)
var closedInputClockCalls = 0
let closedInputClient = NeonDiffCLIClient(
    executablePath: closedInputCLI.path,
    workingDirectory: tempRoot,
    standardInputPipeFactory: { Pipe() },
    monotonicNow: {
        closedInputClockCalls += 1
        if closedInputClockCalls > 1 {
            let markerDeadline = Date().addingTimeInterval(1)
            while !FileManager.default.fileExists(atPath: closedInputMarker.path), Date() < markerDeadline {
                usleep(1_000)
            }
        }
        return DispatchTime.now()
    }
)
var closedInputFailedSafely = false
do {
    _ = try closedInputClient.run(
        arguments: [],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 2
    )
} catch NeonDiffCLIError.launchFailed(let message) {
    closedInputFailedSafely = true
    check(!message.contains("fixture-provider-value"), "EPIPE failure never echoes submitted stdin")
} catch {
    fputs("check failed: closed stdin returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(closedInputFailedSafely, "child-closes-stdin EPIPE is handled without SIGPIPE termination")
let closedInputPIDText = try String(contentsOf: closedInputMarker, encoding: .utf8)
let closedInputPID = checkedValue(
    Int32(closedInputPIDText.trimmingCharacters(in: .whitespacesAndNewlines)),
    "closed stdin child records its process id"
)
check(kill(closedInputPID, 0) != 0 && errno == ESRCH, "EPIPE cleanup terminates and reaps the child")

let inheritedOutputMarker = tempRoot.appendingPathComponent("inherited-output-child.pid")
let inheritedOutputCLI = tempRoot.appendingPathComponent("inherited-output-cli")
try """
#!/usr/bin/env bash
(
  while :; do
    printf 'fixture-stdout\\n' || exit 0
    printf 'fixture-stderr\\n' >&2 || exit 0
    /bin/sleep 0.02
  done
) &
printf '%s\\n' "$!" > \(inheritedOutputMarker.path)
exit 0
""".write(to: inheritedOutputCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: inheritedOutputCLI.path)
let inheritedOutputClient = NeonDiffCLIClient(executablePath: inheritedOutputCLI.path, workingDirectory: tempRoot)
let inheritedOutputStartedAt = Date()
let inheritedOutputResult = try inheritedOutputClient.run(arguments: [], standardInput: nil, timeout: 0.75)
let inheritedOutputElapsed = Date().timeIntervalSince(inheritedOutputStartedAt)
check(inheritedOutputResult.exitCode == 0, "parent process exits successfully while a descendant inherits output")
check(inheritedOutputElapsed < 1.5, "inherited stdout and stderr cannot extend the bounded run")
let inheritedOutputPIDText = try String(contentsOf: inheritedOutputMarker, encoding: .utf8)
let inheritedOutputPID = checkedValue(
    Int32(inheritedOutputPIDText.trimmingCharacters(in: .whitespacesAndNewlines)),
    "inherited output descendant records its process id"
)
let inheritedOutputExitDeadline = Date().addingTimeInterval(0.75)
while kill(inheritedOutputPID, 0) == 0, Date() < inheritedOutputExitDeadline {
    usleep(10_000)
}
let inheritedOutputChildWasRunning = kill(inheritedOutputPID, 0) == 0
if inheritedOutputChildWasRunning {
    _ = kill(inheritedOutputPID, SIGKILL)
}
check(!inheritedOutputChildWasRunning, "closing bounded output pipes leaves no inherited-output fixture")

let oversizedOutputCLI = tempRoot.appendingPathComponent("oversized-output-cli")
try """
#!/usr/bin/env bash
exec /usr/bin/head -c 1100000 /dev/zero
""".write(to: oversizedOutputCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: oversizedOutputCLI.path)
let oversizedOutputClient = NeonDiffCLIClient(executablePath: oversizedOutputCLI.path, workingDirectory: tempRoot)
var oversizedOutputRejected = false
do {
    _ = try oversizedOutputClient.run(arguments: [], standardInput: nil, timeout: 2)
} catch NeonDiffCLIError.outputTooLarge(let stream, let maxBytes) {
    oversizedOutputRejected = stream == "stdout" && maxBytes == 1024 * 1024
} catch {
    fputs("check failed: oversized output returned wrong error: \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
    exit(1)
}
check(oversizedOutputRejected, "CLI output collection enforces its per-stream cap")

final class GitHubFixtureURLProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var requestBodies: [String] = []
    private static let lock = NSLock()

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

let fixtureSessionConfig = URLSessionConfiguration.ephemeral
fixtureSessionConfig.protocolClasses = [GitHubFixtureURLProtocol.self]
let fixtureGitHubClient = GitHubDeviceAuthClient(
    githubBaseURL: URL(string: "https://github.local")!,
    apiBaseURL: URL(string: "https://api.github.local")!,
    session: URLSession(configuration: fixtureSessionConfig),
    now: { Date(timeIntervalSince1970: 1000) },
    pageSize: 1
)
let fixtureDeviceCode = await checkedAsync("GitHub client requests device code") {
    try await fixtureGitHubClient.requestDeviceCode(clientId: "Iv1.publicclientid123")
}
check(fixtureDeviceCode.userCode == "WDJB-MJHT", "GitHub client parses device authorization user code")
check(fixtureDeviceCode.expiresAt == Date(timeIntervalSince1970: 1900), "GitHub client maps device authorization expiry")
let fixtureToken = await checkedAsync("GitHub client polls device token") {
    try await fixtureGitHubClient.pollDeviceAuthorization(clientId: "Iv1.publicclientid123", deviceCode: fixtureDeviceCode.deviceCode)
}
if case .authorized(let token) = fixtureToken {
    check(token.accessToken == "fixture-access-token", "GitHub client parses device token response")
} else {
    check(false, "GitHub client did not parse authorized device token response")
}
let fixtureUser = await checkedAsync("GitHub client fetches current user") {
    try await fixtureGitHubClient.fetchCurrentUser(accessToken: "fixture-access-token")
}
check(fixtureUser.login == "octo-user", "GitHub client fetches current user")
let fixtureRepos = await checkedAsync("GitHub client lists accessible repositories") {
    try await fixtureGitHubClient.listAccessibleRepositories(accessToken: "fixture-access-token")
}
check(fixtureRepos.count == 2, "GitHub client lists accessible repositories across installation pages")
check(fixtureRepos.first?.fullName == "octo-org/private-repo", "GitHub client maps repository full name")
check(fixtureRepos.first?.permissionsSummary == "admin:false,push:false,pull:true", "GitHub client maps documented repository permissions")
check(fixtureRepos.last?.fullName == "second-org/public-repo", "GitHub client follows later installation pages")
let refreshedToken = await checkedAsync("GitHub client refreshes expiring user tokens") {
    try await fixtureGitHubClient.refreshUserToken(clientId: "Iv1.publicclientid123", refreshToken: "fixture-refresh-token")
}
check(refreshedToken.accessToken == "fixture-refreshed-access-token", "GitHub refresh token grant returns a new access token")
let fixtureRequests = GitHubFixtureURLProtocol.requests
let fixtureRequestBodies = GitHubFixtureURLProtocol.requestBodies
let deviceCodeBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, _ in request.url?.path == "/login/device/code" }?
    .1 ?? ""
check(deviceCodeBody.contains("client_id=Iv1.publicclientid123"), "GitHub device-code request includes the public client id")
let tokenBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, body in
        request.url?.path == "/login/oauth/access_token" && body.contains("device_code=device-fixture")
    }?
    .1 ?? ""
check(tokenBody.contains("device_code=device-fixture"), "GitHub token request includes the device code")
check(tokenBody.contains("grant_type=urn:ietf:params:oauth:grant-type:device_code"), "GitHub token request uses the device-code grant")
let refreshBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, body in
        request.url?.path == "/login/oauth/access_token" && body.contains("grant_type=refresh_token")
    }?
    .1 ?? ""
check(refreshBody.contains("refresh_token=fixture-refresh-token"), "GitHub refresh request includes the refresh token")
let authorizedAPIRequests = fixtureRequests.filter { $0.url?.host == "api.github.local" }
check(
    authorizedAPIRequests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access-token" },
    "GitHub API requests use the user access token authorization header"
)

let launchMarker = tempRoot.appendingPathComponent("dashboard-launch-marker.txt")
let launchScript = tempRoot.appendingPathComponent("dashboard-launcher")
try """
#!/usr/bin/env bash
printf '%s\\n' "$*" > \(launchMarker.path)
""".write(to: launchScript, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchScript.path)

let launchClient = NeonDiffCLIClient(executablePath: launchScript.path, workingDirectory: tempRoot)
let launchResult = try launchClient.launchDetached(arguments: ["dashboard", "--config", "config.local.json", "--open", "true"])
check(launchResult.processIdentifier > 0, "dashboard launcher returns a child process identifier")
let markerDeadline = Date().addingTimeInterval(3)
while !FileManager.default.fileExists(atPath: launchMarker.path), Date() < markerDeadline {
    try await Task.sleep(nanoseconds: 50_000_000)
}
check(FileManager.default.fileExists(atPath: launchMarker.path), "dashboard launcher writes its marker file")
let markerContents = try String(contentsOf: launchMarker, encoding: .utf8)
check(markerContents.contains("dashboard --config config.local.json --open true"), "dashboard launcher passes expected CLI arguments")

let authCode = GitHubDeviceAuthorizationCode(
    deviceCode: "device-code",
    userCode: "WDJB-MJHT",
    verificationURI: URL(string: "https://github.com/login/device")!,
    expiresAt: Date(timeIntervalSince1970: 1000),
    intervalSeconds: 5
)
check(authCode.userCode == "WDJB-MJHT", "device authorization exposes the user code for visible desktop setup")
check(authCode.intervalSeconds == 5, "device authorization preserves GitHub polling interval")

let pendingPoll = GitHubDeviceAuthorizationPollResult.pending(intervalSeconds: 5)
let slowedPoll = pendingPoll.applyingSlowDown()
check(slowedPoll.minimumNextPollIntervalSeconds == 10, "slow_down adds five seconds to the polling interval")

let discoveredRepos = GitHubRepositoryDiscovery.mergeConfiguredAndDiscoveredRepos(
    configured: [RepoMonitor(name: "owner/manual", enabled: true, profile: "selected")],
    discovered: [
        GitHubDiscoveredRepository(
            fullName: "owner/discovered",
            visibility: "private",
            installationId: 123,
            installationAccount: "owner",
            permissionsSummary: "metadata:read,pull_requests:write"
        )
    ]
)
check(
    discoveredRepos.map(\.name) == ["owner/discovered", "owner/manual"],
    "discovered repositories merge with configured allowlist without dropping manual repos"
)
check(
    discoveredRepos.first(where: { $0.name == "owner/discovered" })?.enabled == false,
    "discovered repositories are not enabled until the user selects them"
)

let fakeGitHubAccessToken = ["ghu", "fixture_token_12345678901234567890"].joined(separator: "_")
let fakeGitHubRefreshToken = ["ghr", "fixture_token_12345678901234567890"].joined(separator: "_")
let redactedGitHubTokens = NeonDiffRedactor.redact("access=\(fakeGitHubAccessToken) refresh=\(fakeGitHubRefreshToken)")
check(!redactedGitHubTokens.contains("ghu_fixture"), "GitHub user access tokens are redacted")
check(!redactedGitHubTokens.contains("ghr_fixture"), "GitHub refresh tokens are redacted")

let unauthorizedRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 401,
    headers: [:],
    requestPath: "/user/installations"
)
check(unauthorizedRecovery.action == .reconnect, "GitHub 401 tells the user to reconnect")
check(unauthorizedRecovery.status == "authorization expired", "GitHub 401 has a stable visible status")

let rateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: ["x-ratelimit-remaining": "0"],
    requestPath: "/user/installations"
)
check(rateLimitRecovery.action == .retryLater, "GitHub rate limits tell the user to retry later")
check(rateLimitRecovery.message.contains("rate limit"), "GitHub rate limits are named in the visible recovery copy")

let secondaryRateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: ["Retry-After": "60"],
    requestPath: "/user/installations"
)
check(secondaryRateLimitRecovery.action == .retryLater, "GitHub secondary rate limits are not mislabeled as organization policy")

let organizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: [:],
    requestPath: "/user/installations"
)
check(organizationRecovery.action == .installOrManageApp, "Ambiguous GitHub 403 responses use permission recovery without assuming org policy")
check(organizationRecovery.status == "permission denied", "Ambiguous GitHub 403 responses have a stable permission status")

let confirmedOrganizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: [:],
    requestPath: "/user/installations",
    responseBody: #"{"message":"Resource protected by organization SAML enforcement"}"#
)
check(confirmedOrganizationRecovery.action == .contactOrganizationOwner, "Confirmed GitHub org policy blocks name the organization-owner recovery")
check(confirmedOrganizationRecovery.message.contains("organization policy"), "Confirmed org policy blocks are distinct from permission denials")

let installationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 404,
    headers: [:],
    requestPath: "/user/installations/42/repositories"
)
check(installationRecovery.action == .installOrManageApp, "Missing installations point to GitHub App management")

check(
    GitHubAppInstallLink.url(botLogin: "evaos-code-review-bot[bot]")?.absoluteString
        == "https://github.com/apps/evaos-code-review-bot/installations/new",
    "GitHub App bot login maps to the selected-repository install URL"
)
check(GitHubAppInstallLink.url(botLogin: "configured GitHub App bot") == nil, "Placeholder bot labels do not become install URLs")
check(
    GitHubAppInstallLink.publicAppURL.absoluteString
        == "https://github.com/apps/evaos-code-review-bot/installations/new",
    "The public product has a stable selected-repository install URL when botLogin is omitted"
)

let publicRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/public-repo",
        visibility: "public",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:true"
    ),
    licenseEntitlement: "not activated"
)
check(publicRepoCue == .publicFree, "Public repositories show the free-path cue")

let privateRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/private-repo",
        visibility: "private",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:true"
    ),
    licenseEntitlement: "stored locally"
)
check(privateRepoCue == .licenseRequired, "Private repositories do not treat a stored key as active entitlement")

let unreadableRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/unreadable-repo",
        visibility: "private",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:false"
    ),
    licenseEntitlement: "active"
)
check(unreadableRepoCue == .insufficientReadAccess, "Unreadable repositories name the permissions blocker before license state")

let locallyExpiredDeviceCode = GitHubConnectionRecoveryClassifier.deviceCodeExpired
check(locallyExpiredDeviceCode.action == .reconnect, "Locally detected device-code expiry exposes reconnect recovery")
check(locallyExpiredDeviceCode.status == "device code expired", "Local and GitHub-returned device expiry share a stable status")

var refreshGate = GitHubLatestRequestGate()
let firstRefresh = refreshGate.begin()
let secondRefresh = refreshGate.begin()
check(!refreshGate.isCurrent(firstRefresh), "An older repository refresh cannot overwrite a newer refresh")
check(refreshGate.isCurrent(secondRefresh), "The newest repository refresh may update UI state")

let rateLimitSessionConfig = URLSessionConfiguration.ephemeral
rateLimitSessionConfig.protocolClasses = [GitHubRateLimitURLProtocol.self]
let rateLimitClient = GitHubDeviceAuthClient(
    apiBaseURL: URL(string: "https://rate-limit.github.local")!,
    session: URLSession(configuration: rateLimitSessionConfig)
)
do {
    _ = try await rateLimitClient.fetchCurrentUser(accessToken: "fixture-access-token")
    check(false, "GitHub client must reject a rate-limited API response")
} catch let error as GitHubDeviceAuthClientError {
    check(error.recovery?.action == .retryLater, "GitHub client carries the classified rate-limit recovery to the UI model")
    check(!error.localizedDescription.contains("must-not-surface"), "GitHub client does not surface raw API response bodies")
} catch {
    check(false, "GitHub client must expose a typed, actionable failure")
}

let controlCenterSnapshot = ConfigInspectParser.parse(
    #"""
    {
      "ok": true,
      "command": "config inspect",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "config": {
        "pilotRepos": ["owner/review-repo"],
        "pollIntervalMs": 120000,
        "skipDrafts": false,
        "reviewConcurrency": { "maxActiveRuns": 2, "leaseTtlMs": 600000 },
        "reviewGate": { "maxInlineComments": 12 },
        "issueEnrichment": {
          "enabled": true,
          "postIssueComment": false,
          "allowlist": ["owner/issues-repo"],
          "maxIssuesPerCycle": 4,
          "maxCommentsPerCycle": 1,
          "globalMaxIssuesPerCycle": 4,
          "globalMaxCommentsPerCycle": 1,
          "maxActiveRuns": 1,
          "leaseTtlMs": 900000,
          "cooldownMs": 3600000,
          "burstWindowMs": 3600000,
          "maxIssuesPerBurst": 8,
          "lookbackMs": 600000,
          "processExistingOpenIssuesOnActivation": false
        }
      }
    }
    """#,
    providerKeyStored: false,
    licenseKeyStored: false
)
check(controlCenterSnapshot?.policy.pollIntervalMs == 120_000, "config inspect parses daemon poll interval")
check(controlCenterSnapshot?.revision == String(repeating: "a", count: 64), "config inspect preserves the compare-and-swap revision")
check(controlCenterSnapshot?.policy.reviewMaxActiveRuns == 2, "config inspect parses review concurrency")
check(controlCenterSnapshot?.policy.issueAllowlist == ["owner/issues-repo"], "issue-enrichment allowlist remains separate from review repos")
check(controlCenterSnapshot?.repos.map(\.name) == ["owner/review-repo"], "PR review allowlist remains in the repo selector")
let providerRegistrySnapshot = ConfigInspectParser.parse(
    #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"zcode-model","cliPath":"zcode","appConfigPath":"zcode.json"},"desktop":{"openAICompatibleEndpoint":"https://legacy.example/v1"},"providers":{"defaultProviderId":"gateway","providers":{"gateway":{"enabled":true,"adapter":"openai-compatible","displayName":"Gateway","baseUrl":"https://saved.example/v1","model":"saved-model","authMode":"api-key-env"},"disabled":{"enabled":false,"adapter":"openai-compatible","displayName":"Disabled","baseUrl":"https://disabled.example/v1","model":"disabled-model","authMode":"api-key-env"},"zcode":{"enabled":true,"adapter":"zcode","displayName":"ZCode","model":"zcode-model","authMode":"zcode-app-config"}}}}}"#,
    providerKeyStored: true,
    licenseKeyStored: false
)
check(providerRegistrySnapshot?.providers.selectedProviderId == "gateway", "config inspect maps providers.defaultProviderId")
check(providerRegistrySnapshot?.providers.selectedRegistryTarget?.baseUrl == "https://saved.example/v1", "saved registry base URL is authoritative")
check(providerRegistrySnapshot?.providers.openAICompatibleEndpoint == "https://legacy.example/v1", "legacy desktop endpoint remains parsed only for compatibility")
check(providerRegistrySnapshot?.providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true, "enabled openai-compatible api-key-env target is eligible")
check(providerRegistrySnapshot?.providers.registryTargets.first(where: { $0.id == "disabled" })?.isAPIKeyVerificationEligible == false, "disabled registry target is ineligible")
check(providerRegistrySnapshot?.providers.registryTargets.first(where: { $0.id == "zcode" })?.isAPIKeyVerificationEligible == false, "non-compatible adapter is ineligible")
if let providerSettings = providerRegistrySnapshot?.providers {
    let providerPatchData = try ProviderRegistryPatchBuilder.data(for: providerSettings)
    let providerPatchText = String(data: providerPatchData, encoding: .utf8) ?? ""
    let providerPatchObject = try JSONSerialization.jsonObject(with: providerPatchData) as? [String: Any]
    let providerPatchRegistry = providerPatchObject?["providers"] as? [String: Any]
    let providerPatchEntries = providerPatchRegistry?["providers"] as? [String: Any]
    let selectedProviderPatch = providerPatchEntries?["gateway"] as? [String: Any]
    check(selectedProviderPatch?["baseUrl"] as? String == "https://saved.example/v1", "provider patch uses the selected saved registry target")
    check(!providerPatchText.contains("https://legacy.example/v1"), "legacy desktop endpoint cannot enter the provider registry patch")
    check(!providerPatchText.lowercased().contains("apikey"), "provider registry patch contains no secret-bearing key field")
}
let failedInspectJSON = #"{"ok":false,"command":"config inspect","error":"config changed while reading; retry"}"#
check(
    ConfigInspectParser.error(failedInspectJSON) == "config changed while reading; retry",
    "structured inspect failures expose a bounded retry message"
)
check(
    ConfigInspectParser.parse(failedInspectJSON, providerKeyStored: false, licenseKeyStored: false) == nil,
    "failed inspect responses cannot install a config snapshot"
)
let expectedPatchRevision = String(repeating: "b", count: 64)
let successfulPatchJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","warning":"remove the owned lock","config":{"pilotRepos":[]}}"#
let successfulPatchSnapshot = ConfigInspectParser.parse(
    successfulPatchJSON,
    providerKeyStored: false,
    licenseKeyStored: false
)
check(successfulPatchSnapshot != nil, "successful config patch envelopes parse")
check(successfulPatchSnapshot?.warning == "remove the owned lock", "config patch cleanup warnings remain visible to the native caller")
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: successfulPatchSnapshot,
        expectedRevision: expectedPatchRevision,
        mode: .preview
    ) == expectedPatchRevision,
    "preview proof binds both response revisions to the requested revision"
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: successfulPatchSnapshot,
        expectedRevision: expectedPatchRevision,
        mode: .apply
    ) == nil,
    "an Apply operation rejects a preview-shaped dry-run envelope"
)
let appliedRevision = String(repeating: "c", count: 64)
let successfulApplySnapshot = ConfigInspectParser.parse(
    #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(appliedRevision)","config":{"pilotRepos":[]}}"#,
    providerKeyStored: false,
    licenseKeyStored: false
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: successfulApplySnapshot,
        expectedRevision: expectedPatchRevision,
        mode: .apply
    ) == appliedRevision,
    "Apply proof requires a typed live-write envelope and accepts its new SHA-256 revision"
)
let contradictoryNoOpSnapshot = ConfigInspectParser.parse(
    #"{"ok":true,"command":"config patch","dryRun":false,"wrote":false,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(appliedRevision)","config":{"pilotRepos":[]}}"#,
    providerKeyStored: false,
    licenseKeyStored: false
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: contradictoryNoOpSnapshot,
        expectedRevision: expectedPatchRevision,
        mode: .apply
    ) == nil,
    "a no-op Apply cannot claim a changed revision"
)
let contradictoryWriteSnapshot = ConfigInspectParser.parse(
    #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
    providerKeyStored: false,
    licenseKeyStored: false
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: contradictoryWriteSnapshot,
        expectedRevision: expectedPatchRevision,
        mode: .apply
    ) == nil,
    "a reported Apply write must advance the content revision"
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: successfulApplySnapshot,
        expectedRevision: expectedPatchRevision.uppercased(),
        mode: .apply
    ) == nil,
    "uppercase or otherwise malformed revisions cannot authorize Apply"
)
check(
    ConfigInspectParser.parse(
        #"{"ok":true,"command":"daemon status","revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    ) == nil,
    "wrong-command envelopes cannot authorize a config patch"
)
check(
    ConfigPatchProofValidator.revisionAfter(
        snapshot: ConfigInspectParser.parse(
            #"{"ok":true,"command":"config patch","revisionBefore":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
            providerKeyStored: false,
            licenseKeyStored: false
        ),
        expectedRevision: expectedPatchRevision,
        mode: .apply
    ) == nil,
    "mismatched patch revision proof fails closed"
)

var desiredControlCenter = DesktopControlCenterSettings()
desiredControlCenter.pollIntervalMs = 120_000
desiredControlCenter.skipDrafts = false
desiredControlCenter.reviewMaxActiveRuns = 2
desiredControlCenter.reviewLeaseTtlMs = 600_000
desiredControlCenter.maxInlineComments = 12
desiredControlCenter.issueEnrichmentEnabled = true
desiredControlCenter.issuePostComment = false
desiredControlCenter.issueAllowlist = ["owner/issues-repo"]
desiredControlCenter.issueMaxIssuesPerCycle = 4
desiredControlCenter.issueMaxCommentsPerCycle = 1

check(DesktopControlCenterPatchBuilder.validationError(for: desiredControlCenter) == nil, "valid control-center settings pass native validation")
let desiredPatchData = try DesktopControlCenterPatchBuilder.data(for: desiredControlCenter)
let desiredPatch: [String: Any] = checkedCast(
    try JSONSerialization.jsonObject(with: desiredPatchData),
    "desired control-center patch must serialize to a JSON object"
)
check(desiredPatch["pilotRepos"] == nil, "control-center patch never couples issue enrichment to the PR allowlist")
let desiredIssuePatch = desiredPatch["issueEnrichment"] as? [String: Any]
check(desiredIssuePatch?["allowlist"] as? [String] == ["owner/issues-repo"], "control-center patch writes only the issue-enrichment allowlist")

let rollbackSettings = checkedValue(controlCenterSnapshot, "control-center fixture must parse").policy
let rollbackPatchData = try DesktopControlCenterPatchBuilder.data(for: rollbackSettings)
let rollbackPatch: [String: Any] = checkedCast(
    try JSONSerialization.jsonObject(with: rollbackPatchData),
    "rollback control-center patch must serialize to a JSON object"
)
let rollbackIssuePatch = rollbackPatch["issueEnrichment"] as? [String: Any]
check(rollbackPatch["pollIntervalMs"] as? Int == 120_000, "rollback patch preserves the loaded daemon baseline")
check(rollbackIssuePatch?["allowlist"] as? [String] == ["owner/issues-repo"], "rollback patch preserves the loaded issue allowlist")
check(rollbackPatch["pilotRepos"] == nil, "rollback patch cannot modify the separate PR review allowlist")

let previewSnapshot = DesktopControlCenterSnapshot(
    settings: desiredControlCenter,
    configPath: "/tmp/config-a.json"
)
var editedAfterPreview = desiredControlCenter
editedAfterPreview.pollIntervalMs += 1_000
check(
    previewSnapshot != DesktopControlCenterSnapshot(settings: editedAfterPreview, configPath: "/tmp/config-a.json"),
    "an edit made after preview cannot match the immutable preview snapshot"
)
check(
    previewSnapshot != DesktopControlCenterSnapshot(settings: desiredControlCenter, configPath: "/tmp/config-b.json"),
    "a preview for one config path cannot authorize a different config target"
)
let revisionBoundCommand = NeonDiffCommandBuilder.configPatch(
    cliPath: "/tmp/neondiff",
    configPath: "/tmp/config-a.json",
    inputPath: "/tmp/patch.json",
    dryRun: false,
    expectedRevision: String(repeating: "a", count: 64)
)
check(revisionBoundCommand.commandLine.contains("--expected-revision"), "live control-center commands expose their revision guard")

var invalidControlCenter = desiredControlCenter
invalidControlCenter.issueMaxIssuesPerCycle = 1
invalidControlCenter.issueMaxCommentsPerCycle = 2
check(
    DesktopControlCenterPatchBuilder.validationError(for: invalidControlCenter)?.contains("comments per cycle") == true,
    "native validation blocks issue comment caps above issue caps"
)

let providerSecretAccount = "provider/glm/api-key"
let fixtureProviderSecret = "fixture-provider-value"
let healthyProviderVerificationJSON = #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:00:00.000Z","providerId":"zcode-glm","state":"healthy","mode":"openai_compatible_models","detail":"Verified Z.AI GLM with a redacted /models check.","redacted":true,"keySource":"submitted","check":{"providerId":"zcode-glm","ok":true,"adapter":"openai-compatible","enabled":true,"model":"glm-4.5","authMode":"api-key-env","smokeAttempted":true,"readMode":"openai_compatible_models","apiKeyEnv":"Z_AI_API_KEY","modelCount":4},"troubleshooting":[]}"#
let providerSecretStore = InMemoryProviderSecretStore()
try providerSecretStore.setSecret(fixtureProviderSecret, account: providerSecretAccount)
let fakeProviderCLI = FakeProviderVerificationCLI(
    result: CLIRunResult(exitCode: 0, stdout: healthyProviderVerificationJSON, stderr: "")
)
let providerVerificationService = ProviderVerificationService(
    keychain: providerSecretStore,
    cli: fakeProviderCLI
)
let providerVerificationArguments = [
    "providers", "verify", "--api-key-stdin", "true", "--allow-remote-smoke", "true", "--json"
]
let providerVerification = try providerVerificationService.verify(
    account: providerSecretAccount,
    arguments: providerVerificationArguments,
    timeout: 15
)
check(
    !fakeProviderCLI.arguments.joined(separator: " ").contains(fixtureProviderSecret),
    "provider secret never enters argv"
)
check(
    fakeProviderCLI.standardInput == Data(fixtureProviderSecret.utf8),
    "provider secret is supplied only on stdin"
)
check(fakeProviderCLI.timeout == 15, "provider verification preserves the bounded process timeout")
check(providerVerification.state == .healthy, "only a healthy exact envelope parses as verified")
check(providerVerification.isVerified, "healthy exact provider verification is the only verified pass")
check(providerVerification.command == "providers verify", "provider verification preserves the strict command discriminator")
check(providerVerification.providerId == "zcode-glm", "provider verification preserves redacted provider metadata")
check(
    !String(reflecting: providerVerification).contains(fixtureProviderSecret),
    "provider verification snapshot retains no provider secret"
)
check(
    !providerVerification.detail.contains(fixtureProviderSecret)
        && providerVerification.troubleshooting.allSatisfy { !$0.contains(fixtureProviderSecret) },
    "provider verification presentation metadata retains no provider secret"
)

var retainedProviderVerification: ProviderVerificationSnapshot? = providerVerification
fakeProviderCLI.result = CLIRunResult(
    exitCode: 0,
    stdout: healthyProviderVerificationJSON.replacingOccurrences(
        of: "providers verify",
        with: "dashboard verify-provider"
    ),
    stderr: ""
)
do {
    retainedProviderVerification = try providerVerificationService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
    check(false, "wrong-command verification must fail")
} catch {
    retainedProviderVerification = nil
}
check(retainedProviderVerification == nil, "wrong-command failure clears a prior provider result")

retainedProviderVerification = providerVerification
fakeProviderCLI.error = FixtureProviderTransportError.unavailable
do {
    retainedProviderVerification = try providerVerificationService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
    check(false, "transport verification must fail")
} catch {
    retainedProviderVerification = nil
}
check(retainedProviderVerification == nil, "transport failure clears a prior provider result")
fakeProviderCLI.error = nil

fakeProviderCLI.result = CLIRunResult(
    exitCode: 1,
    stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:01:00.000Z","providerId":"github-copilot","state":"configured_unverified","mode":"metadata_only","detail":"Provider metadata passed; API-key verification is not applicable.","redacted":true,"troubleshooting":["Choose an API-key provider for a live check."]}"#,
    stderr: ""
)
let configuredProviderVerification = try providerVerificationService.verify(
    account: providerSecretAccount,
    arguments: providerVerificationArguments,
    timeout: 15
)
check(
    configuredProviderVerification.state == .configuredUnverified && !configuredProviderVerification.isVerified,
    "configured_unverified remains a visible typed non-success outcome"
)

fakeProviderCLI.result = CLIRunResult(
    exitCode: 1,
    stdout: #"{"ok":false,"command":"providers verify","checkedAt":"2026-07-10T12:02:00.000Z","providerId":"zcode-glm","state":"blocked","mode":"openai_compatible_models","detail":"Provider verification failed.","redacted":true,"troubleshooting":["Check provider credentials."]}"#,
    stderr: "provider verification did not prove health"
)
let blockedProviderVerification = try providerVerificationService.verify(
    account: providerSecretAccount,
    arguments: providerVerificationArguments,
    timeout: 15
)
check(
    blockedProviderVerification.state == .blocked && !blockedProviderVerification.isVerified,
    "blocked remains a visible typed non-success outcome"
)

let invalidProviderVerificationResults: [(String, CLIRunResult)] = [
    (
        "wrong command",
        CLIRunResult(
            exitCode: 0,
            stdout: healthyProviderVerificationJSON.replacingOccurrences(of: "providers verify", with: "dashboard verify-provider"),
            stderr: ""
        )
    ),
    (
        "unredacted envelope",
        CLIRunResult(
            exitCode: 0,
            stdout: healthyProviderVerificationJSON.replacingOccurrences(of: #""redacted":true"#, with: #""redacted":false"#),
            stderr: ""
        )
    ),
    ("malformed JSON", CLIRunResult(exitCode: 0, stdout: "{not-json", stderr: "")),
    (
        "healthy result with nonzero exit",
        CLIRunResult(exitCode: 1, stdout: healthyProviderVerificationJSON, stderr: "")
    ),
    (
        "nonhealthy result with zero exit",
        CLIRunResult(
            exitCode: 0,
            stdout: #"{"ok":false,"command":"providers verify","checkedAt":"2026-07-10T12:02:00.000Z","providerId":"zcode-glm","state":"blocked","mode":"openai_compatible_models","detail":"Provider verification failed.","redacted":true,"troubleshooting":[]}"#,
            stderr: ""
        )
    ),
    (
        "blocked result claiming ok",
        CLIRunResult(
            exitCode: 1,
            stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:02:00.000Z","providerId":"zcode-glm","state":"blocked","mode":"openai_compatible_models","detail":"Provider verification failed.","redacted":true,"troubleshooting":[]}"#,
            stderr: ""
        )
    ),
    (
        "unknown mode",
        CLIRunResult(
            exitCode: 0,
            stdout: healthyProviderVerificationJSON.replacingOccurrences(of: "openai_compatible_models", with: "raw_response"),
            stderr: ""
        )
    ),
    (
        "secret-like field",
        CLIRunResult(
            exitCode: 0,
            stdout: healthyProviderVerificationJSON.replacingOccurrences(of: #""troubleshooting":[]"#, with: #""apiKey":"[REDACTED]","troubleshooting":[]"#),
            stderr: ""
        )
    )
]
for (message, result) in invalidProviderVerificationResults {
    fakeProviderCLI.result = result
    let failure = captureProviderVerificationFailure(message) {
        _ = try providerVerificationService.verify(
            account: providerSecretAccount,
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    check(
        !failure.localizedDescription.contains(fixtureProviderSecret),
        "provider verification failures never echo the provider secret"
    )
}

fakeProviderCLI.result = CLIRunResult(
    exitCode: 1,
    stdout: healthyProviderVerificationJSON.replacingOccurrences(
        of: "Verified Z.AI GLM with a redacted /models check.",
        with: fixtureProviderSecret
    ),
    stderr: ""
)
let stdoutLeakFailure = captureProviderVerificationFailure("secret in serialized stdout") {
    _ = try providerVerificationService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !stdoutLeakFailure.localizedDescription.contains(fixtureProviderSecret),
    "serialized provider output containing the submitted secret is rejected without echo"
)

fakeProviderCLI.result = CLIRunResult(
    exitCode: 0,
    stdout: healthyProviderVerificationJSON,
    stderr: "transport failed for \(fixtureProviderSecret)"
)
let stderrLeakFailure = captureProviderVerificationFailure("secret in stderr") {
    _ = try providerVerificationService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !stderrLeakFailure.localizedDescription.contains(fixtureProviderSecret),
    "provider stderr containing the submitted secret is rejected without echo"
)

let escapedOperationalSecret = "fixture\"slash\\line\ncontrol\u{0001}雪"
let whitespaceWrappedSecret = "\u{FEFF} \t\(escapedOperationalSecret)\r\n \u{FEFF}"
let escapedSecretStore = InMemoryProviderSecretStore()
try escapedSecretStore.setSecret(whitespaceWrappedSecret, account: providerSecretAccount)
let escapedSecretCLI = FakeProviderVerificationCLI(
    result: CLIRunResult(exitCode: 0, stdout: healthyProviderVerificationJSON, stderr: "")
)
let escapedSecretService = ProviderVerificationService(keychain: escapedSecretStore, cli: escapedSecretCLI)
let escapedSafeSnapshot = try escapedSecretService.verify(
    account: providerSecretAccount,
    arguments: providerVerificationArguments,
    timeout: 15
)
check(
    escapedSecretCLI.standardInput == Data(escapedOperationalSecret.utf8),
    "provider verification trims Keychain whitespace exactly once before stdin submission"
)
check(
    !escapedSecretCLI.arguments.joined(separator: " ").contains(escapedOperationalSecret),
    "normalized operational secret remains absent from argv"
)
check(
    !String(reflecting: escapedSafeSnapshot).contains(escapedOperationalSecret),
    "normalized operational secret remains absent from retained snapshots"
)
let ecmaScriptNonWhitespaceSecret = "\u{0085}fixture-provider-value\u{0085}"
try escapedSecretStore.setSecret(ecmaScriptNonWhitespaceSecret, account: providerSecretAccount)
_ = try escapedSecretService.verify(
    account: providerSecretAccount,
    arguments: providerVerificationArguments,
    timeout: 15
)
check(
    escapedSecretCLI.standardInput == Data(ecmaScriptNonWhitespaceSecret.utf8),
    "provider normalization does not trim non-ECMAScript next-line characters"
)
try escapedSecretStore.setSecret(whitespaceWrappedSecret, account: providerSecretAccount)

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

let escapedSecretEnvelopes = try [
    encodedProviderEnvelope(detail: escapedOperationalSecret),
    encodedProviderEnvelope(troubleshooting: ["retry: \(escapedOperationalSecret)"]),
    encodedProviderEnvelope(diagnostic: ["nested": ["message": escapedOperationalSecret]])
]
check(
    escapedSecretEnvelopes.allSatisfy { !$0.contains(escapedOperationalSecret) },
    "JSON escaping hides the operational secret from raw substring checks"
)
for (index, envelope) in escapedSecretEnvelopes.enumerated() {
    escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
    let failure = captureProviderVerificationFailure("decoded escaped secret envelope \(index)") {
        _ = try escapedSecretService.verify(
            account: providerSecretAccount,
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    check(
        !failure.localizedDescription.contains(escapedOperationalSecret),
        "decoded secret rejection errors retain no normalized secret"
    )
}

let encodedSecretLiteralData = try JSONSerialization.data(
    withJSONObject: escapedOperationalSecret,
    options: [.fragmentsAllowed]
)
let encodedSecretLiteral = checkedValue(
    String(data: encodedSecretLiteralData, encoding: .utf8),
    "normalized provider secret serializes as a JSON string"
)
let encodedSecretStderrData = try JSONSerialization.data(
    withJSONObject: ["diagnostic": ["nested": escapedOperationalSecret]],
    options: [.sortedKeys]
)
let encodedSecretStderr = checkedValue(
    String(data: encodedSecretStderrData, encoding: .utf8),
    "nested provider stderr serializes as UTF-8"
)
let alternateEscapedSecretLiteral = encodedSecretLiteral
    .replacingOccurrences(of: "\\n", with: "\\u000a")
    .replacingOccurrences(of: "雪", with: "\\u96ea")
let escapedSecretStderrCases = [
    encodedSecretStderr,
    "provider diagnostic payload: \(encodedSecretLiteral)",
    "provider diagnostic payload: \(alternateEscapedSecretLiteral)"
]
check(
    escapedSecretStderrCases.allSatisfy { !$0.contains(escapedOperationalSecret) },
    "JSON escaping hides the normalized secret from raw stderr substring checks"
)
for (index, stderrText) in escapedSecretStderrCases.enumerated() {
    escapedSecretCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: healthyProviderVerificationJSON,
        stderr: stderrText
    )
    let failure = captureProviderVerificationFailure("escaped normalized secret stderr \(index)") {
        _ = try escapedSecretService.verify(
            account: providerSecretAccount,
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    check(
        !failure.localizedDescription.contains(escapedOperationalSecret),
        "escaped stderr rejection errors retain no normalized secret"
    )
}

let nestedSerializedSecretEnvelope = try encodedProviderEnvelope(
    diagnostic: ["serialized": encodedSecretLiteral]
)
escapedSecretCLI.result = CLIRunResult(
    exitCode: 0,
    stdout: nestedSerializedSecretEnvelope,
    stderr: ""
)
let nestedSerializedStdoutFailure = captureProviderVerificationFailure("nested serialized secret stdout") {
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !nestedSerializedStdoutFailure.localizedDescription.contains(escapedOperationalSecret),
    "nested serialized stdout rejection retains no normalized secret"
)

let nestedSerializedStderrData = try JSONSerialization.data(
    withJSONObject: ["diagnostic": ["serialized": encodedSecretLiteral]],
    options: [.sortedKeys]
)
let nestedSerializedStderr = checkedValue(
    String(data: nestedSerializedStderrData, encoding: .utf8),
    "nested serialized stderr encodes as UTF-8"
)
escapedSecretCLI.result = CLIRunResult(
    exitCode: 0,
    stdout: healthyProviderVerificationJSON,
    stderr: nestedSerializedStderr
)
let nestedSerializedStderrFailure = captureProviderVerificationFailure("nested serialized secret stderr") {
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !nestedSerializedStderrFailure.localizedDescription.contains(escapedOperationalSecret),
    "nested serialized stderr rejection retains no normalized secret"
)

var deeplyNestedDiagnostic: Any = encodedSecretLiteral
for _ in 0..<80 {
    deeplyNestedDiagnostic = [deeplyNestedDiagnostic]
}
let deeplyNestedEnvelope = try encodedProviderEnvelope(diagnostic: deeplyNestedDiagnostic)
escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: deeplyNestedEnvelope, stderr: "")
let deeplyNestedFailure = captureProviderVerificationFailure("deeply nested provider diagnostic") {
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !deeplyNestedFailure.localizedDescription.contains(escapedOperationalSecret),
    "deep nesting budget failure remains fixed and redacted"
)

let wideDiagnostic = Array(repeating: "bounded-safe-diagnostic", count: 5_000)
let wideEnvelope = try encodedProviderEnvelope(diagnostic: wideDiagnostic)
escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: wideEnvelope, stderr: "")
let wideBudgetFailure = captureProviderVerificationFailure("provider diagnostic node budget") {
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}
check(
    !wideBudgetFailure.localizedDescription.contains(escapedOperationalSecret),
    "node budget failure remains fixed and redacted"
)

let whitespaceOnlySecretStore = InMemoryProviderSecretStore()
try whitespaceOnlySecretStore.setSecret(" \t\r\n ", account: providerSecretAccount)
let whitespaceOnlySecretService = ProviderVerificationService(
    keychain: whitespaceOnlySecretStore,
    cli: escapedSecretCLI
)
_ = captureProviderVerificationFailure("whitespace-only normalized provider secret") {
    _ = try whitespaceOnlySecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}

let missingProviderSecretStore = InMemoryProviderSecretStore()
let missingProviderSecretService = ProviderVerificationService(
    keychain: missingProviderSecretStore,
    cli: fakeProviderCLI
)
_ = captureProviderVerificationFailure("missing Keychain provider secret") {
    _ = try missingProviderSecretService.verify(
        account: providerSecretAccount,
        arguments: providerVerificationArguments,
        timeout: 15
    )
}

print("NeonDiffDesktopCoreChecks passed")
