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
            let existingProviderId = providers.zcodeProviderId
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !existingProviderId.isEmpty {
                zcodePatch["providerId"] = existingProviderId
            }
        }
        var providerPatches: [String: [String: Any]] = [:]
        for registryTarget in providers.registryTargets {
            let model = registryTarget.id == target.id
                ? selectedModel
                : registryTarget.model
            var providerPatch: [String: Any] = [
                "enabled": registryTarget.enabled,
                "adapter": registryTarget.adapter,
                "authMode": registryTarget.authMode
            ]
            if !isRedactedMetadata(registryTarget.displayName) {
                providerPatch["displayName"] = registryTarget.displayName
            }
            if !isRedactedMetadata(model) {
                providerPatch["model"] = model
            }
            if !registryTarget.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !isRedactedMetadata(registryTarget.baseUrl)
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

    private static func isRedactedMetadata(_ value: String) -> Bool {
        value.contains("[redacted-secret]") || value.contains("[env-var-name]")
    }
}
