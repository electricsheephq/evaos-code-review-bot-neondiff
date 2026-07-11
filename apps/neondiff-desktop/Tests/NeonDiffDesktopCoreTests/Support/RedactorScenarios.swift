import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runCanonicalRedactorCorpusContracts() async throws -> [LegacyCoreCheckAssertion] {
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
    let credentialShapedEnvelopes = try [
        encodedProviderEnvelope(detail: "Bearer " + "gh" + "p_" + String(repeating: "1", count: 36)),
        encodedProviderEnvelope(troubleshooting: ["api_key=" + "sk-" + "proj-" + String(repeating: "2", count: 20)]),
        encodedProviderEnvelope(diagnostic: ["nested": ["message": "github" + "_pat_" + String(repeating: "3", count: 30)]]),
        encodedProviderEnvelope(diagnostic: ["nested": ["message": "-----BEGIN " + "PRIVATE" + " KEY-----"]])
    ]
    for (index, envelope) in credentialShapedEnvelopes.enumerated() {
        escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
        let failure = try captureProviderVerificationFailure("credential-shaped envelope \(index)") {
            _ = try escapedSecretService.verify(
                account: providerSecretAccount,
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(failure.localizedDescription == ProviderVerificationError.secretInProcessOutput.localizedDescription, "credential-shaped output fails with a fixed redacted error")
        context.expect(!failure.localizedDescription.contains("1234567890"), "credential rejection error contains no credential fragment")
    }

    let canonicalRedactorSensitiveEnvelopes = try [
        encodedProviderEnvelope(detail: "See https://operator:provider-password@example.com/v1/models"),
        encodedProviderEnvelope(troubleshooting: ["Retry https://example.com/callback?access_token=abcdefghijklmnop"]),
        encodedProviderEnvelope(diagnostic: ["nested": ["message": "cookie=abcdefghijklmnop"]]),
        encodedProviderEnvelope(diagnostic: ["nested": ["message": "session: abcdefghijklmnop"]]),
        encodedProviderEnvelope(diagnostic: ["https://operator:provider-password@example.com": "benign value"])
    ]
    for (index, envelope) in canonicalRedactorSensitiveEnvelopes.enumerated() {
        escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
        let failure = try captureProviderVerificationFailure("canonical-redactor-sensitive envelope \(index)") {
            _ = try escapedSecretService.verify(
                account: providerSecretAccount,
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(
            failure.localizedDescription == ProviderVerificationError.secretInProcessOutput.localizedDescription,
            "canonical redactor changes reject detail, troubleshooting, and nested output with a fixed error"
        )
        context.expect(!failure.localizedDescription.contains("abcdefghijklmnop"), "canonical redactor rejection exposes no credential fragment")
    }

    escapedSecretCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: try encodedProviderEnvelope(
            detail: "Provider metadata endpoint is healthy.",
            troubleshooting: ["Retry after confirming the saved provider selection."],
            diagnostic: ["nested": ["message": "modelCount=4; mode=metadata_only"]]
        ),
        stderr: ""
    )
    _ = try escapedSecretService.verify(
        account: providerSecretAccount,
        expectedProviderId: "zcode-glm",
        arguments: providerVerificationArguments,
        timeout: 15
    )
    context.expect(true, "canonical redactor leaves benign detail, troubleshooting, and nested metadata accepted")

    context.expect(
        CanonicalSecretRuleCorpus.sensitive.count == CanonicalSecretRuleCorpus.ruleIDs.count,
        "canonical Swift secret corpus covers every generated Node rule"
    )
    for fixture in CanonicalSecretRuleCorpus.sensitive {
        let locations: [(String, Any)] = [
            ("detail", fixture.text),
            ("troubleshooting", [fixture.text]),
            ("nested value", ["nested": ["message": fixture.text]]),
            ("nested key", ["nested": [fixture.text: "public-safe fixture metadata"]])
        ]
        for (location, value) in locations {
            let envelope: String
            switch location {
            case "detail":
                envelope = try encodedProviderEnvelope(detail: value as! String)
            case "troubleshooting":
                envelope = try encodedProviderEnvelope(troubleshooting: value as! [String])
            default:
                envelope = try encodedProviderEnvelope(diagnostic: value)
            }
            escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
            let failure = try captureProviderVerificationFailure("canonical \(fixture.id) in \(location)") {
                _ = try escapedSecretService.verify(
                    account: providerSecretAccount,
                    expectedProviderId: "zcode-glm",
                    arguments: providerVerificationArguments,
                    timeout: 15
                )
            }
            context.expect(
                failure.localizedDescription == ProviderVerificationError.secretInProcessOutput.localizedDescription,
                "canonical \(fixture.id) fails closed in \(location) with the fixed redacted error"
            )
            context.expect(
                !failure.localizedDescription.contains(fixture.text),
                "canonical \(fixture.id) rejection never echoes the matched text"
            )
        }
    }

    for fixture in CanonicalSecretRuleCorpus.benign {
        let envelopes = try [
            encodedProviderEnvelope(detail: fixture.text),
            encodedProviderEnvelope(troubleshooting: [fixture.text]),
            encodedProviderEnvelope(diagnostic: ["nested": ["message": fixture.text]]),
            encodedProviderEnvelope(diagnostic: ["nested": [fixture.text: "public-safe fixture metadata"]])
        ]
        for envelope in envelopes {
            escapedSecretCLI.result = CLIRunResult(exitCode: 0, stdout: envelope, stderr: "")
            _ = try escapedSecretService.verify(
                account: providerSecretAccount,
                expectedProviderId: "zcode-glm",
                arguments: providerVerificationArguments,
                timeout: 15
            )
        }
        context.expect(true, "canonical benign \(fixture.id) stays accepted across decoded keys and values")
    }

    let standaloneSafeLiteralReferences = [
        "Set NEONDIFF_PROVIDER_API_KEY before running verification.",
        "Required: `NEONDIFF_PROVIDER_API_KEY`.",
        "Read NEONDIFF_PROVIDER_API_KEY, then continue."
    ]
    for text in standaloneSafeLiteralReferences {
        context.expect(
            !CanonicalSecretScanner.containsSecretLikeText(text),
            "standalone safe environment identifier remains public-safe: \(text)"
        )
    }
    let sensitiveSafeLiteralAssignments = [
        "NEONDIFF_PROVIDER_API_KEY=abcdefghijklmnop",
        "NEONDIFF_PROVIDER_API_KEY = abcdefghijklmnop",
        #""NEONDIFF_PROVIDER_API_KEY": "abcdefghijklmnop""#,
        "'NEONDIFF_PROVIDER_API_KEY' : 'abcdefghijklmnop'",
        "token=NEONDIFF_PROVIDER_API_KEY"
    ]
    for text in sensitiveSafeLiteralAssignments {
        context.expect(
            CanonicalSecretScanner.containsSecretLikeText(text),
            "assignment-shaped safe environment identifier remains scannable"
        )
    }

    escapedSecretCLI.result = CLIRunResult(
        exitCode: 0,
        stdout: try encodedProviderEnvelope().replacingOccurrences(of: #""providerId":"zcode-glm""#, with: #""providerId":"other-provider""#),
        stderr: ""
    )

      return context.assertions
  }
