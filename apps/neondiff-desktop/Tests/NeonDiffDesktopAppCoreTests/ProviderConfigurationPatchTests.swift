import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite struct ProviderConfigurationPatchTests {
    @Test func dirtyEditRequiresExactPreviewAndConfirmedApplyReadback() throws {
        let fixture = try ProviderModelFixture.makeLoaded()

        #expect(fixture.model.canVerifyProviderKey) // saved loaded eligible provider enables Verify
        fixture.model.providers.selectedProviderBaseUrl = "https://edited.example/v1"
        #expect(!fixture.model.canVerifyProviderKey) // dirty provider edits disable Verify
        #expect(fixture.model.canPreviewProviderConfig) // dirty provider edit enables preview
        #expect(
            fixture.model.providerPatchPreviewCommand.commandLine.contains("--expected-revision")
                && fixture.model.providerPatchPreviewCommand.commandLine.contains(ProviderModelFixture.loadedRevision)
        ) // provider Preview uses the loaded compare-and-swap revision

        let previewJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://edited.example/v1","model":"fixture-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: previewJSON, stderr: ""),
            mode: .preview
        )
        #expect(!fixture.model.canVerifyProviderKey) // preview-only provider settings cannot be verified
        #expect(fixture.model.canApplyProviderConfig) // exact successful preview enables Apply
        #expect(
            fixture.model.providerPatchApplyCommand.commandLine.contains("--expected-revision")
                && fixture.model.providerPatchApplyCommand.commandLine.contains(ProviderModelFixture.loadedRevision)
        ) // provider Apply remains bound to the previewed revision
        #expect(fixture.model.providerPatchApplyCommand.commandLine.contains("--confirm true")) // provider Apply uses the confirmed reversible config patch contract

        let applyJSON = #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://edited.example/v1","model":"fixture-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: applyJSON, stderr: ""),
            mode: .apply
        )
        #expect(fixture.model.canVerifyProviderKey) // exact live apply/readback enables Verify
    }

    @Test func successfulLiveConfigWriteInvalidatesVerification() throws {
        let fixture = try ProviderModelFixture.makeLoaded()
        fixture.model.providerVerification = healthyProviderSnapshot()
        let before = String(repeating: "b", count: 64)
        let after = String(repeating: "c", count: 64)
        let patchJSON = #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(before)","revisionAfter":"\#(after)","config":{"pilotRepos":[]}}"#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: patchJSON, stderr: ""),
            fallbackCommand: "neondiff config patch",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false
        )

        #expect(fixture.model.providerVerification == nil) // successful live config write invalidates prior verification
        #expect(fixture.model.providerVerificationStatus.contains("changed")) // successful live config write explains invalidation
    }

    @Test func onlyOwningProviderPatchResponseConsumesPendingProof() throws {
        let fixture = try ProviderModelFixture.makeLoaded()
        fixture.model.providers.selectedProviderBaseUrl = "https://owned-proof.example/v1"
        fixture.model.stageProviderPatchProofForTesting(mode: .preview)
        #expect(fixture.model.isConfigPatchInProgress) // provider patch proof records an active owning invocation

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: #"{"ok":true,"command":"daemon status","state":"running"}"#, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false
        )
        fixture.model.attemptOverlappingProviderPatchForTesting()
        #expect(fixture.model.isConfigPatchInProgress) // an unrelated completion and rejected overlap cannot consume the active provider proof

        let previewJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://owned-proof.example/v1","model":"fixture-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyStagedProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: previewJSON, stderr: "")
        )
        #expect(!fixture.model.isConfigPatchInProgress) // only the owning provider patch response completes the operation
        #expect(fixture.model.canApplyProviderConfig) // the owning provider patch response consumes its exact proof
    }
}
