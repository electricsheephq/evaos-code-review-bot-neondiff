import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runProviderRegistryParsingAndPatchContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let providerRegistrySnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"zcode-model","cliPath":"zcode","appConfigPath":"zcode.json"},"desktop":{"openAICompatibleEndpoint":"https://legacy.example/v1"},"providers":{"defaultProviderId":"gateway","providers":{"gateway":{"enabled":true,"adapter":"openai-compatible","displayName":"Gateway","baseUrl":"https://saved.example/v1","model":"saved-model","authMode":"api-key-env"},"disabled":{"enabled":false,"adapter":"openai-compatible","displayName":"Disabled","baseUrl":"https://disabled.example/v1","model":"disabled-model","authMode":"api-key-env"},"zcode":{"enabled":true,"adapter":"zcode","displayName":"ZCode","model":"zcode-model","authMode":"zcode-app-config"}}}}}"#,
        providerKeyStored: true,
        licenseKeyStored: false
    )
    context.expect(providerRegistrySnapshot?.providers.selectedProviderId == "gateway", "config inspect maps providers.defaultProviderId")
    context.expect(providerRegistrySnapshot?.providers.selectedRegistryTarget?.baseUrl == "https://saved.example/v1", "saved registry base URL is authoritative")
    context.expect(providerRegistrySnapshot?.providers.openAICompatibleEndpoint == "https://legacy.example/v1", "legacy desktop endpoint remains parsed only for compatibility")
    context.expect(providerRegistrySnapshot?.providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true, "enabled openai-compatible api-key-env target is eligible")
    context.expect(providerRegistrySnapshot?.providers.registryTargets.first(where: { $0.id == "disabled" })?.isAPIKeyVerificationEligible == false, "disabled registry target is ineligible")
    context.expect(providerRegistrySnapshot?.providers.registryTargets.first(where: { $0.id == "zcode" })?.isAPIKeyVerificationEligible == false, "non-compatible adapter is ineligible")
    if let providerSettings = providerRegistrySnapshot?.providers {
        let providerPatchData = try ProviderRegistryPatchBuilder.data(for: providerSettings)
        let providerPatchText = String(data: providerPatchData, encoding: .utf8) ?? ""
        let providerPatchObject = try JSONSerialization.jsonObject(with: providerPatchData) as? [String: Any]
        let providerPatchRegistry = providerPatchObject?["providers"] as? [String: Any]
        let providerPatchEntries = providerPatchRegistry?["providers"] as? [String: Any]
        let selectedProviderPatch = providerPatchEntries?["gateway"] as? [String: Any]
        context.expect(selectedProviderPatch?["baseUrl"] as? String == "https://saved.example/v1", "provider patch uses the selected saved registry target")
        context.expect(!providerPatchText.contains("https://legacy.example/v1"), "legacy desktop endpoint cannot enter the provider registry patch")
        context.expect(!providerPatchText.lowercased().contains("apikey"), "provider registry patch contains no secret-bearing key field")
    }

      return context.assertions
  }
