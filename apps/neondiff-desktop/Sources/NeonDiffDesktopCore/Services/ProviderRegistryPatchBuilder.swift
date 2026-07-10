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
        let patch: [String: Any] = [
            "zcode": [
                "cliPath": providers.zcodeCliPath,
                "appConfigPath": providers.zcodeAppConfigPath,
                "model": providers.zcodeModel
            ],
            "providers": [
                "defaultProviderId": target.id,
                "providers": [
                    target.id: [
                        "baseUrl": target.baseUrl,
                        "model": target.model
                    ]
                ]
            ]
        ]
        return try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
    }
}
