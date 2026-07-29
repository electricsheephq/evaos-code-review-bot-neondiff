import Foundation

public enum ProviderRegistryPatchBuilderError: LocalizedError {
    case missingSelectedProvider

    public var errorDescription: String? {
        "Select a saved provider registry entry before generating a patch."
    }
}

public enum ProviderRegistryPatchBuilder {
    public static func data(for providers: ProviderSettings) throws -> Data {
        guard let target = providers.selectedRegistryTarget else {
            throw ProviderRegistryPatchBuilderError.missingSelectedProvider
        }
        let selectedModel = target.model
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
            ? providers.zcodeModel
            : target.model
        var zcodePatch: [String: Any] = [
            "cliPath": providers.zcodeCliPath,
            "appConfigPath": providers.zcodeAppConfigPath,
            "model": providers.zcodeModel
        ]
        if target.authMode == "zcode-app-config" {
            zcodePatch["model"] = selectedModel
            zcodePatch["providerId"] = target.id
        }
        var providerPatches: [String: [String: Any]] = [:]
        for registryTarget in providers.registryTargets {
            let model = registryTarget.id == target.id
                ? selectedModel
                : registryTarget.model
            var providerPatch: [String: Any] = [
                "enabled": registryTarget.enabled,
                "adapter": registryTarget.adapter,
                "displayName": registryTarget.displayName,
                "authMode": registryTarget.authMode,
                "model": model
            ]
            if registryTarget.authMode != "zcode-app-config"
                || !registryTarget.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                providerPatch["baseUrl"] = registryTarget.baseUrl
            }
            providerPatches[registryTarget.id] = providerPatch
        }
        let patch: [String: Any] = [
            "zcode": zcodePatch,
            "providers": [
                "defaultProviderId": target.id,
                "providers": providerPatches
            ]
        ]
        return try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
    }
}
