import Testing
@_spi(Testing) import NeonDiffDesktopCore

@MainActor
@Suite(.serialized) struct ProviderRegistryTests {
@Test func providerRegistryParsingAndPatchContracts() async throws {
    assertLegacyCoreCheckScenario(
        .providerRegistryParsingAndPatchContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runProviderRegistryParsingAndPatchContracts() }
    )
}

@Test func configInspectMapsTheActiveCodexRuntime() throws {
    let snapshot = try #require(ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"codexRuntime":{"enabled":true,"cliPath":"/Users/m1/.local/bin/codex","model":"gpt-5.6-sol","reasoningEffort":"high","timeoutMs":600000,"maxOutputBytes":20971520,"contextWindowTokens":128000},"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"zcode","displayName":"ZCode","model":"GLM-5.2","authMode":"zcode-app-config"}}}}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    ))

    #expect(snapshot.providers.codexRuntime.enabled)
    #expect(snapshot.providers.codexRuntime.cliPath == "/Users/m1/.local/bin/codex")
    #expect(snapshot.providers.codexRuntime.model == "gpt-5.6-sol")
    #expect(snapshot.providers.codexRuntime.reasoningEffort == "high")
    #expect(snapshot.providers.codexRuntime.isReady)

    let incomplete = try #require(ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"codexRuntime":{"enabled":true},"providers":{"defaultProviderId":"zcode-glm","providers":{}}}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    ))
    #expect(!incomplete.providers.codexRuntime.isReady)
}
}
