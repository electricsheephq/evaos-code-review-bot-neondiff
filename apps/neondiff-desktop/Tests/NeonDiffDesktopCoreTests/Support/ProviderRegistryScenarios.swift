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
        let providerPatchZCode = providerPatchObject?["zcode"] as? [String: Any]
        let providerPatchRegistry = providerPatchObject?["providers"] as? [String: Any]
        let providerPatchEntries = providerPatchRegistry?["providers"] as? [String: Any]
        let selectedProviderPatch = providerPatchEntries?["gateway"] as? [String: Any]
        context.expect(selectedProviderPatch?["baseUrl"] as? String == "https://saved.example/v1", "provider patch uses the selected saved registry target")
        context.expect(providerPatchZCode?["providerId"] == nil, "direct provider patch preserves the existing ZCode execution provider")
        context.expect(providerPatchZCode?["model"] as? String == "zcode-model", "direct provider patch preserves the existing ZCode execution model")
        context.expect(!providerPatchText.contains("https://legacy.example/v1"), "legacy desktop endpoint cannot enter the provider registry patch")
        context.expect(
            Set(providerPatchObject?.keys.map { $0 } ?? []) == Set(["zcode", "providers"])
                && Set(providerPatchZCode?.keys.map { $0 } ?? []) == Set(["cliPath", "appConfigPath", "model"])
                && Set(providerPatchRegistry?.keys.map { $0 } ?? []) == Set(["defaultProviderId", "providers"])
                && Set(providerPatchEntries?.keys.map { $0 } ?? []) == Set(["gateway"])
                && Set(selectedProviderPatch?.keys.map { $0 } ?? []) == Set(["baseUrl", "model"]),
            "provider registry patch contains only the explicit non-secret schema"
        )
    }

    let zcodeManagedSnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","config":{"zcode":{"model":"zcode-model","cliPath":"zcode","appConfigPath":"zcode.json","providerId":"prior-zcode"},"providers":{"defaultProviderId":"zcode","providers":{"zcode":{"enabled":true,"adapter":"zcode","displayName":"ZCode","model":"zcode-model","authMode":"zcode-app-config"}}}}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    if let providerSettings = zcodeManagedSnapshot?.providers {
        let providerPatchData = try ProviderRegistryPatchBuilder.data(for: providerSettings)
        let providerPatchObject = try JSONSerialization.jsonObject(with: providerPatchData) as? [String: Any]
        let providerPatchZCode = providerPatchObject?["zcode"] as? [String: Any]
        let providerPatchRegistry = providerPatchObject?["providers"] as? [String: Any]
        let providerPatchEntries = providerPatchRegistry?["providers"] as? [String: Any]
        let selectedProviderPatch = providerPatchEntries?["zcode"] as? [String: Any]
        context.expect(
            providerPatchZCode?["providerId"] as? String == "zcode"
                && providerPatchZCode?["model"] as? String == "zcode-model",
            "ZCode-managed provider patch binds the exact selected execution provider and model"
        )
        context.expect(
            selectedProviderPatch?["baseUrl"] == nil,
            "ZCode app-config patch preserves an omitted endpoint instead of writing an invalid empty URL"
        )
    } else {
        context.expect(false, "ZCode-managed registry snapshot remains parseable")
    }

    let zcodeManagedEndpointSnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","config":{"zcode":{"model":"zcode-model","cliPath":"zcode","appConfigPath":"zcode.json","providerId":"zcode"},"providers":{"defaultProviderId":"zcode","providers":{"zcode":{"enabled":true,"adapter":"zcode","displayName":"ZCode","baseUrl":"https://zcode.example/v1","model":"zcode-model","authMode":"zcode-app-config"}}}}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    if let providerSettings = zcodeManagedEndpointSnapshot?.providers {
        let providerPatchData = try ProviderRegistryPatchBuilder.data(for: providerSettings)
        let providerPatchObject = try JSONSerialization.jsonObject(with: providerPatchData) as? [String: Any]
        let providerPatchRegistry = providerPatchObject?["providers"] as? [String: Any]
        let providerPatchEntries = providerPatchRegistry?["providers"] as? [String: Any]
        let selectedProviderPatch = providerPatchEntries?["zcode"] as? [String: Any]
        context.expect(
            selectedProviderPatch?["baseUrl"] as? String == "https://zcode.example/v1",
            "ZCode app-config patch preserves an explicit nonempty endpoint"
        )
    } else {
        context.expect(false, "ZCode-managed registry snapshot with an endpoint remains parseable")
    }

    let emptyModelSnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config inspect","revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"zcode":{"model":"fallback-model","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"gateway","providers":{"gateway":{"enabled":true,"adapter":"openai-compatible","displayName":"Gateway","baseUrl":"https://saved.example/v1","model":"","authMode":"api-key-env"}}}}}"#,
        providerKeyStored: true,
        licenseKeyStored: false
    )
    if let providerSettings = emptyModelSnapshot?.providers {
        let providerPatchData = try ProviderRegistryPatchBuilder.data(
            for: providerSettings
        )
        let providerPatchObject = try JSONSerialization.jsonObject(
            with: providerPatchData
        ) as? [String: Any]
        let providerPatchZCode = providerPatchObject?["zcode"]
            as? [String: Any]
        context.expect(
            providerPatchZCode?["model"] as? String == "fallback-model",
            "empty registry models fall back to the current ZCode model"
        )
    } else {
        context.expect(
            false,
            "empty-model registry snapshot remains parseable for safe fallback"
        )
    }

      return context.assertions
  }
