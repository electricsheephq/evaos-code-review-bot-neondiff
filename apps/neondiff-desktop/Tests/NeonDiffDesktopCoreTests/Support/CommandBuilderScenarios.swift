import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runOnboardingFlowContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    var providerFlow = OnboardingFlow()
    context.expect(providerFlow.currentStep == .welcome, "flow starts at welcome")
    providerFlow.advance()
    context.expect(providerFlow.currentStep == .provider, "welcome advances to provider")
    context.expect(!providerFlow.canAdvance, "provider step requires a stored provider key")
    providerFlow.providerKeyStored = true
    context.expect(providerFlow.canAdvance, "provider step advances after key storage")

    var publicFlow = OnboardingFlow(providerKeyStored: true)
    publicFlow.currentStep = .license
    publicFlow.mode = .publicReposOnly
    publicFlow.licenseActivation = .servicePending
    context.expect(!publicFlow.canAdvance, "public repo path also requires verified activation")
    publicFlow.advance()
    context.expect(publicFlow.currentStep == .license, "public repo path remains blocked at license step")

    var privateFlow = OnboardingFlow(providerKeyStored: true)
    privateFlow.currentStep = .license
    privateFlow.mode = .privateRepos
    privateFlow.licenseActivation = .servicePending
    context.expect(!privateFlow.canAdvance, "private repo path cannot fake activation while service is pending")
    context.expect(privateFlow.licenseActivation != .activated, "pending service is not activated")

    var daemonFlow = OnboardingFlow(providerKeyStored: true)
    daemonFlow.currentStep = .daemon
    context.expect(!daemonFlow.canAdvance, "daemon step requires bootstrap/status check")
    daemonFlow.daemonBootstrapChecked = true
    context.expect(daemonFlow.canAdvance, "daemon step advances after bootstrap/status check")


      return context.assertions
  }

  @MainActor
  func runCliResolutionAndStandardInputContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let fixture = try CoreCLIFixture()
    let tempRoot = fixture.root
    defer { try? FileManager.default.removeItem(at: tempRoot) }
    let localCLI = fixture.cliURL
    let nestedBundleURL = tempRoot
        .appendingPathComponent("apps/neondiff-desktop/dist/NeonDiffDesktop.app", isDirectory: true)
    context.expect(
        NeonDiffCLIResolver.findPackageRoot(startingAt: nestedBundleURL)?.standardizedFileURL == tempRoot.standardizedFileURL,
        "CLI resolver discovers the repo package root from a local app bundle path"
    )

    context.expect(
        NeonDiffCLIResolver.resolveExecutablePath("neondiff", workingDirectory: tempRoot)?.standardizedFileURL == localCLI.standardizedFileURL,
        "local package CLI is preferred over GUI PATH fallback"
    )

    let standardInputCLI = NeonDiffCLIClient(executablePath: localCLI.path, workingDirectory: tempRoot)
    let standardInputResult = try standardInputCLI.run(
        arguments: ["stdin-check"],
        standardInput: Data("fixture-provider-value".utf8),
        timeout: 5
    )
    context.expect(standardInputResult.exitCode == 0, "CLI standard-input transport reaches the bounded child process")
    context.expect(standardInputResult.stdout.contains("\"receivedBytes\":22"), "CLI standard-input transport returns only redacted metadata")
    context.expect(!standardInputResult.stdout.contains("fixture-provider-value"), "CLI output never echoes standard input")


      return context.assertions
  }

  @MainActor
  func runCliCancellationContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let fixture = try CoreCLIFixture()
    let tempRoot = fixture.root
    defer { try? FileManager.default.removeItem(at: tempRoot) }
    let localCLI = fixture.cliURL
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
    context.expect(prelaunchGateReached == .success, "pre-launch cancellation fixture reaches its gate")
    prelaunchTask.cancel()
    prelaunchRelease.signal()
    var prelaunchCancelled = false
    do {
        _ = try await prelaunchTask.value
    } catch NeonDiffCLIError.cancelled {
        prelaunchCancelled = true
    } catch {
        throw error
    }
    context.expect(prelaunchCancelled, "pre-launch cancellation returns the typed cancellation result")
    context.expect(prelaunchWriteCalls == 0, "pre-launch cancellation writes zero secret bytes")

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
    context.expect(postLaunchInspectionFD >= 0, "post-launch cancellation duplicates its stdin inspection descriptor")
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
    context.expect(postLaunchGateReached == .success, "post-launch cancellation fixture reaches its pre-write gate")
    postLaunchTask.cancel()
    postLaunchRelease.signal()
    var postLaunchCancelled = false
    do {
        _ = try await postLaunchTask.value
    } catch NeonDiffCLIError.cancelled {
        postLaunchCancelled = true
    } catch {
        throw error
    }
    context.expect(postLaunchCancelled, "post-launch cancellation returns only after cleanup")
    context.expect(postLaunchWriteCalls == 0, "post-launch pre-write cancellation writes zero secret bytes")
    let postLaunchReadFlags = fcntl(postLaunchInspectionFD, F_GETFL)
    context.expect(postLaunchReadFlags >= 0 && fcntl(postLaunchInspectionFD, F_SETFL, postLaunchReadFlags | O_NONBLOCK) == 0, "post-launch inspection is nonblocking")
    var postLaunchBuffer = [UInt8](repeating: 0, count: 64)
    let postLaunchBytes = postLaunchBuffer.withUnsafeMutableBytes { Darwin.read(postLaunchInspectionFD, $0.baseAddress, $0.count) }
    _ = Darwin.close(postLaunchInspectionFD)
    context.expect(postLaunchBytes <= 0, "cancelled stdin carries no provider secret bytes")
    if FileManager.default.fileExists(atPath: postLaunchMarker.path) {
        let postLaunchPIDText = try String(contentsOf: postLaunchMarker, encoding: .utf8)
        let postLaunchPID = checkedValue(Int32(postLaunchPIDText.trimmingCharacters(in: .whitespacesAndNewlines)), "post-launch child records its pid")
        context.expect(kill(postLaunchPID, 0) != 0 && errno == ESRCH, "cancelled child is terminated and reaped before return")
    } else {
        context.expect(postLaunchCancelled, "child cancelled before script startup still completes bounded cleanup")
    }


      return context.assertions
  }

  @MainActor
  func runCliStandardInputTimeoutContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let fixture = try CoreCLIFixture()
    let tempRoot = fixture.root
    defer { try? FileManager.default.removeItem(at: tempRoot) }
    let stalledInputMarker = tempRoot.appendingPathComponent("stalled-input-child.pid")
    let stalledInputCLI = tempRoot.appendingPathComponent("stalled-input-cli")
    try """
    #!/usr/bin/env bash
    printf '%s\\n' "$$" > \(stalledInputMarker.path)
    trap '' TERM
    while :; do :; done
    """.write(to: stalledInputCLI, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stalledInputCLI.path)

    let stalledInputClockBase = DispatchTime.now()
    var stalledInputClockCalls = 0
    let stalledInputClient = NeonDiffCLIClient(
        executablePath: stalledInputCLI.path,
    workingDirectory: tempRoot,
    monotonicNow: {
        defer { stalledInputClockCalls += 1 }
        return stalledInputClockCalls < 12
            ? stalledInputClockBase
            : stalledInputClockBase + 2_000_000_000
    },
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
        throw error
    }
    let stalledInputElapsed = Date().timeIntervalSince(stalledInputStartedAt)
    context.expect(stalledInputTimedOut, "a child that never drains maximum-size stdin returns timedOut")
    context.expect(stalledInputElapsed < 3, "stdin delivery and process execution share the configured deadline")
    let stalledInputPIDText = try String(contentsOf: stalledInputMarker, encoding: .utf8)
    let stalledInputPID = checkedValue(
        Int32(stalledInputPIDText.trimmingCharacters(in: .whitespacesAndNewlines)),
        "stalled stdin child records its process id"
    )
    let stalledInputChildWasRunning = kill(stalledInputPID, 0) == 0
    if stalledInputChildWasRunning {
        _ = kill(stalledInputPID, SIGKILL)
    }
    context.expect(!stalledInputChildWasRunning, "timed-out stdin child is terminated and reaped")

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
    context.expect(saturatedInspectionReadFD >= 0, "saturated stdin fixture duplicates its inspection reader")
    let saturatedWriteFlags = fcntl(saturatedWriteFD, F_GETFL)
    context.expect(saturatedWriteFlags >= 0, "saturated stdin fixture reads pipe flags")
    context.expect(fcntl(saturatedWriteFD, F_SETFL, saturatedWriteFlags | O_NONBLOCK) == 0, "saturated stdin fixture enables nonblocking fill")
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
        context.expect(false, "saturated stdin fixture fills the pipe to EAGAIN")
    }
    context.expect(saturatedBytes > 0, "saturated stdin fixture preloads the pipe")
    context.expect(fcntl(saturatedWriteFD, F_SETFL, saturatedWriteFlags) == 0, "saturated stdin fixture restores blocking writes")

    let saturatedInputClockBase = DispatchTime.now()
    var saturatedInputClockCalls = 0
    let saturatedInputClient = NeonDiffCLIClient(
        executablePath: saturatedInputCLI.path,
        workingDirectory: tempRoot,
    standardInputPipeFactory: { saturatedInputPipe },
    monotonicNow: {
        defer { saturatedInputClockCalls += 1 }
        return saturatedInputClockCalls < 12
            ? saturatedInputClockBase
            : saturatedInputClockBase + 2_000_000_000
    },
    afterProcessLaunch: {
        let markerDeadline = Date().addingTimeInterval(1)
        while !FileManager.default.fileExists(atPath: saturatedInputMarker.path), Date() < markerDeadline {
            usleep(1_000)
        }
    }
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
        throw error
    }
    let saturatedInputElapsed = Date().timeIntervalSince(saturatedInputStartedAt)
    let saturatedInputPIDs = try String(contentsOf: saturatedInputMarker, encoding: .utf8)
        .split(whereSeparator: \.isWhitespace)
        .compactMap { Int32($0) }
    context.expect(saturatedInputPIDs.count == 1, "saturated stdin fixture records its child pid")

    let saturatedReadFlags = fcntl(saturatedInspectionReadFD, F_GETFL)
    context.expect(saturatedReadFlags >= 0, "saturated stdin fixture reads drain flags")
    context.expect(fcntl(saturatedInspectionReadFD, F_SETFL, saturatedReadFlags | O_NONBLOCK) == 0, "saturated stdin fixture enables nonblocking drain")
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
        context.expect(false, "saturated stdin fixture drains without read errors")
    }
    _ = Darwin.close(saturatedInspectionReadFD)
    context.expect(saturatedInputTimedOut, "a saturated stdin pipe shares the process timeout")
    context.expect(saturatedInputElapsed < 1.5, "stdin writer lifetime is bounded before run returns")
    context.expect(postReturnInputBytes == 0, "no stdin writer resumes after run returns")


      return context.assertions
  }

  @MainActor
  func runCliCleanupDeadlineAndOutputContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let fixture = try CoreCLIFixture()
    let tempRoot = fixture.root
    defer { try? FileManager.default.removeItem(at: tempRoot) }
    let stalledInputMarker = tempRoot.appendingPathComponent("stalled-input-child.pid")
    let stalledInputCLI = tempRoot.appendingPathComponent("stalled-input-cli")
    try """
    #!/usr/bin/env bash
    printf '%s\\n' "$$" > \(stalledInputMarker.path)
    trap '' TERM
    while :; do :; done
    """.write(to: stalledInputCLI, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stalledInputCLI.path)

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
        throw error
    }
    context.expect(cleanupFailedBoundedly, "unobserved process cleanup returns an explicit bounded error")
    context.expect(cleanupTerminateCalls == 1, "bounded process cleanup sends TERM once")
    context.expect(cleanupKillCalls == 1, "bounded process cleanup escalates to SIGKILL once")
    context.expect(cleanupWaitCalls == 2, "bounded process cleanup performs only its two bounded waits")

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
        throw error
    }
    context.expect(launchDeadlineTimedOut, "launch completing after the deadline returns timedOut")
    context.expect(launchDeadlineWriteCalls == 0, "launch completing after the deadline writes zero secret bytes")

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
        throw error
    }
    context.expect(interruptedWriteTimedOut, "EINTR retry observes the original absolute deadline")
    context.expect(interruptedWriteCalls == 1, "deadline is rechecked before retrying an interrupted secret write")

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
        context.expect(!message.contains("fixture-provider-value"), "EPIPE failure never echoes submitted stdin")
    } catch {
        throw error
    }
    context.expect(closedInputFailedSafely, "child-closes-stdin EPIPE is handled without SIGPIPE termination")
    let closedInputPIDText = try String(contentsOf: closedInputMarker, encoding: .utf8)
    let closedInputPID = checkedValue(
        Int32(closedInputPIDText.trimmingCharacters(in: .whitespacesAndNewlines)),
        "closed stdin child records its process id"
    )
    context.expect(kill(closedInputPID, 0) != 0 && errno == ESRCH, "EPIPE cleanup terminates and reaps the child")

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
    context.expect(inheritedOutputResult.exitCode == 0, "parent process exits successfully while a descendant inherits output")
    context.expect(inheritedOutputElapsed < 1.5, "inherited stdout and stderr cannot extend the bounded run")
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
    context.expect(!inheritedOutputChildWasRunning, "closing bounded output pipes leaves no inherited-output fixture")

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
        throw error
    }
    context.expect(oversizedOutputRejected, "CLI output collection enforces its per-stream cap")


      return context.assertions
  }
