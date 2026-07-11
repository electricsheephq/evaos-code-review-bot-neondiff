import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

final class FoundationProviderVerifier: DesktopProviderVerifying, @unchecked Sendable {
    private let secretStore: any DesktopSecretStoring

    init(secretStore: any DesktopSecretStoring) {
        self.secretStore = secretStore
    }

    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        let service = ProviderVerificationService(
            keychain: secretStore,
            cli: NeonDiffCLIClient(
                executablePath: executablePath,
                workingDirectory: NeonDiffCLIResolver.defaultWorkingDirectory()
            )
        )
        return try await service.verifyCancellable(
            account: account,
            expectedProviderId: expectedProviderId,
            expectedConfigRevision: expectedConfigRevision,
            arguments: arguments,
            timeout: timeout
        )
    }
}
