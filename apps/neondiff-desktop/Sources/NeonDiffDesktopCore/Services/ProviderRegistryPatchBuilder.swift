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
        var selectedProviderPatch: [String: Any] = [
            "model": selectedModel
        ]
        if target.authMode != "zcode-app-config"
            || !target.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            selectedProviderPatch["baseUrl"] = target.baseUrl
        }
        let patch: [String: Any] = [
            "zcode": zcodePatch,
            "providers": [
                "defaultProviderId": target.id,
                "providers": [
                    target.id: selectedProviderPatch
                ]
            ]
        ]
        return try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
    }
}
