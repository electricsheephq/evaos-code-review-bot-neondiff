import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runProviderVerificationTransportAndStrictEnvelopeContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
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
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
        !fakeProviderCLI.arguments.joined(separator: " ").contains(fixtureProviderSecret),
        "provider secret never enters argv"
    )
    context.expect(
        fakeProviderCLI.standardInput == Data(fixtureProviderSecret.utf8),
        "provider secret is supplied only on stdin"
    )
    context.expect(fakeProviderCLI.timeout == 15, "provider verification preserves the bounded process timeout")
    context.expect(providerVerification.state == .healthy, "only a healthy exact envelope parses as verified")
    context.expect(providerVerification.isVerified, "healthy exact provider verification is the only verified pass")
    context.expect(providerVerification.command == "providers verify", "provider verification preserves the strict command discriminator")
    context.expect(providerVerification.providerId == "zcode-glm", "provider verification preserves redacted provider metadata")
    context.expect(
        !String(reflecting: providerVerification).contains(fixtureProviderSecret),
        "provider verification snapshot retains no provider secret"
    )
    context.expect(
        !providerVerification.detail.contains(fixtureProviderSecret)
            && providerVerification.troubleshooting.allSatisfy { !$0.contains(fixtureProviderSecret) },
        "provider verification presentation metadata retains no provider secret"
    )

    let stableConfigRevision = String(repeating: "d", count: 64)
    fakeProviderCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: healthyProviderVerificationJSON.replacingOccurrences(
            of: #""troubleshooting":[]"#,
            with: #""troubleshooting":[],"configRevision":"\#(stableConfigRevision)""#
        ),
        stderr: ""
    )
    let revisionBoundVerification = try providerVerificationService.verify(
        account: providerSecretAccount,
        expectedProviderId: "zcode-glm",
        expectedConfigRevision: stableConfigRevision,
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
        revisionBoundVerification.configRevision == stableConfigRevision,
        "provider verification preserves the exact stable config revision"
    )
    let revisionMismatchFailure = captureProviderVerificationFailure("config revision mismatch") {
        _ = try providerVerificationService.verify(
            account: providerSecretAccount,
            expectedProviderId: "zcode-glm",
            expectedConfigRevision: String(repeating: "e", count: 64),
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
        revisionMismatchFailure is ProviderVerificationError,
        "provider verification fails closed when the CLI result is from a different config revision"
    )
    fakeProviderCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: healthyProviderVerificationJSON,
        stderr: ""
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
        context.expect(false, "wrong-command verification must fail")
    } catch {
        retainedProviderVerification = nil
    }
    context.expect(retainedProviderVerification == nil, "wrong-command failure clears a prior provider result")

    retainedProviderVerification = providerVerification
    fakeProviderCLI.error = FixtureProviderTransportError.unavailable
    do {
        retainedProviderVerification = try providerVerificationService.verify(
            account: providerSecretAccount,
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
        context.expect(false, "transport verification must fail")
    } catch {
        retainedProviderVerification = nil
    }
    context.expect(retainedProviderVerification == nil, "transport failure clears a prior provider result")
    fakeProviderCLI.error = nil

    fakeProviderCLI.result = CLIRunResult(
        exitCode: 1,
        stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:01:00.000Z","providerId":"github-copilot","state":"configured_unverified","mode":"metadata_only","detail":"Provider metadata passed; API-key verification is not applicable.","redacted":true,"troubleshooting":["Choose an API-key provider for a live check."]}"#,
        stderr: ""
    )
    let configuredProviderVerification = try providerVerificationService.verify(
        account: providerSecretAccount,
        expectedProviderId: "github-copilot",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
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
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
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
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
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
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
        escapedSecretCLI.standardInput == Data(escapedOperationalSecret.utf8),
        "provider verification trims Keychain whitespace exactly once before stdin submission"
    )
    context.expect(
        !escapedSecretCLI.arguments.joined(separator: " ").contains(escapedOperationalSecret),
        "normalized operational secret remains absent from argv"
    )
    context.expect(
        !String(reflecting: escapedSafeSnapshot).contains(escapedOperationalSecret),
        "normalized operational secret remains absent from retained snapshots"
    )
    let ecmaScriptNonWhitespaceSecret = "\u{0085}fixture-provider-value\u{0085}"
    try escapedSecretStore.setSecret(ecmaScriptNonWhitespaceSecret, account: providerSecretAccount)
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(
        escapedSecretCLI.standardInput == Data(ecmaScriptNonWhitespaceSecret.utf8),
        "provider normalization does not trim non-ECMAScript next-line characters"
    )
    try escapedSecretStore.setSecret(whitespaceWrappedSecret, account: providerSecretAccount)


    escapedSecretCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: try encodedProviderEnvelope(),
        stderr: ""
    )
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(true, "benign redacted provider metadata remains accepted")

    context.expect(
        ProviderKeychainAccount.account(providerId: "zcode-glm") == "provider/zcode-glm/api-key",
        "provider Keychain account is scoped to a validated provider id"
    )
    for invalidProviderId in ["", ".", "..", "../provider", "provider/key", "sk-1234567890abcdef"] {
        context.expect(
            ProviderKeychainAccount.account(providerId: invalidProviderId) == nil,
            "invalid or secret-shaped provider id fails closed for Keychain account derivation"
        )
    }


      return context.assertions
  }

  @MainActor
  func runProviderVerificationEscapingAndBudgetContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let providerSecretAccount = "provider/glm/api-key"
    let healthyProviderVerificationJSON = #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:00:00.000Z","providerId":"zcode-glm","state":"healthy","mode":"openai_compatible_models","detail":"Verified Z.AI GLM with a redacted /models check.","redacted":true,"keySource":"submitted","check":{"providerId":"zcode-glm","ok":true,"adapter":"openai-compatible","enabled":true,"model":"glm-4.5","authMode":"api-key-env","smokeAttempted":true,"readMode":"openai_compatible_models","apiKeyEnv":"Z_AI_API_KEY","modelCount":4},"troubleshooting":[]}"#
    let providerVerificationArguments = [
        "providers", "verify", "--api-key-stdin", "true", "--allow-remote-smoke", "true", "--json"
    ]
    let escapedOperationalSecret = "fixture\"slash\\line\ncontrol\u{0001}雪"
    let whitespaceWrappedSecret = "\u{FEFF} \t\(escapedOperationalSecret)\r\n \u{FEFF}"
    let escapedSecretStore = InMemoryProviderSecretStore()
    try escapedSecretStore.setSecret(whitespaceWrappedSecret, account: providerSecretAccount)
    let escapedSecretCLI = FakeProviderVerificationCLI(
        result: CLIRunResult(exitCode: 0, stdout: healthyProviderVerificationJSON, stderr: "")
    )
    let escapedSecretService = ProviderVerificationService(keychain: escapedSecretStore, cli: escapedSecretCLI)
    escapedSecretCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: try encodedProviderEnvelope().replacingOccurrences(of: #""providerId":"zcode-glm""#, with: #""providerId":"other-provider""#),
        stderr: ""
    )
    let wrongProviderFailure = captureProviderVerificationFailure("wrong provider healthy envelope") {
        _ = try escapedSecretService.verify(
            account: providerSecretAccount,
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(wrongProviderFailure.localizedDescription == ProviderVerificationError.providerMismatch.localizedDescription, "wrong-provider healthy output is rejected explicitly")
    context.expect(!wrongProviderFailure.localizedDescription.contains("other-provider"), "wrong-provider error is fixed and redacted")

    escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: healthyProviderVerificationJSON, stderr: "")

    let escapedSecretEnvelopes = try [
        encodedProviderEnvelope(detail: escapedOperationalSecret),
        encodedProviderEnvelope(troubleshooting: ["retry: \(escapedOperationalSecret)"]),
        encodedProviderEnvelope(diagnostic: ["nested": ["message": escapedOperationalSecret]])
    ]
    context.expect(
        escapedSecretEnvelopes.allSatisfy { !$0.contains(escapedOperationalSecret) },
        "JSON escaping hides the operational secret from raw substring checks"
    )
    for (index, envelope) in escapedSecretEnvelopes.enumerated() {
        escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
        let failure = captureProviderVerificationFailure("decoded escaped secret envelope \(index)") {
            _ = try escapedSecretService.verify(
                account: providerSecretAccount,
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(
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
    context.expect(
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
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
        !deeplyNestedFailure.localizedDescription.contains(escapedOperationalSecret),
        "deep nesting budget failure remains fixed and redacted"
    )

    let wideDiagnostic = Array(repeating: "bounded-safe-diagnostic", count: 5_000)
    let wideEnvelope = try encodedProviderEnvelope(diagnostic: wideDiagnostic)
    escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: wideEnvelope, stderr: "")
    let wideBudgetFailure = captureProviderVerificationFailure("provider diagnostic node budget") {
        _ = try escapedSecretService.verify(
            account: providerSecretAccount,
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }
    context.expect(
        !wideBudgetFailure.localizedDescription.contains(escapedOperationalSecret),
        "node budget failure remains fixed and redacted"
    )

    var deepSensitiveKeyDiagnostic: Any = ["api" + "Key": "[REDACTED]"]
    for _ in 0..<31 {
        deepSensitiveKeyDiagnostic = ["nested": deepSensitiveKeyDiagnostic]
    }
    context.expect(
        ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(deepSensitiveKeyDiagnostic),
        "sensitive key names are detected at the bounded depth limit"
    )

    var benignDepthLimitDiagnostic: Any = "bounded-safe-diagnostic"
    for _ in 0..<31 {
        benignDepthLimitDiagnostic = ["nested": benignDepthLimitDiagnostic]
    }
    context.expect(
        !ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(benignDepthLimitDiagnostic),
        "benign output is accepted at the bounded depth limit"
    )
    benignDepthLimitDiagnostic = ["nested": benignDepthLimitDiagnostic]
    benignDepthLimitDiagnostic = ["nested": benignDepthLimitDiagnostic]
    context.expect(
        ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(benignDepthLimitDiagnostic),
        "benign output beyond the depth limit fails closed"
    )

    var wideSensitiveKeyDiagnostic: [String: Any] = [:]
    for index in 0..<4_090 {
        wideSensitiveKeyDiagnostic["field-\(index)"] = "safe"
    }
    wideSensitiveKeyDiagnostic["access" + "Token"] = "[REDACTED]"
    context.expect(
        ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(wideSensitiveKeyDiagnostic),
        "wide output containing a sensitive key fails closed within the node budget"
    )

    let benignWideDiagnostic = Dictionary(
        uniqueKeysWithValues: (0..<128).map { ("field-\($0)", "safe") }
    )
    context.expect(
        !ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(benignWideDiagnostic),
        "benign wide output below the node limit remains accepted"
    )
    let overLimitBenignWideDiagnostic = Dictionary(
        uniqueKeysWithValues: (0..<4_200).map { ("field-\($0)", "safe") }
    )
    context.expect(
        ProviderVerificationParser.decodedOutputContainsSecretLikeMaterialForTesting(overLimitBenignWideDiagnostic),
        "benign wide output beyond the node limit fails closed"
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
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }

    let missingProviderSecretStore = InMemoryProviderSecretStore()
    let missingProviderSecretService = ProviderVerificationService(
        keychain: missingProviderSecretStore,
        cli: escapedSecretCLI
    )
    _ = captureProviderVerificationFailure("missing Keychain provider secret") {
        _ = try missingProviderSecretService.verify(
            account: providerSecretAccount,
            expectedProviderId: "zcode-glm",
            arguments: providerVerificationArguments,
            timeout: 15
        )
    }


      return context.assertions
  }
