import Foundation
import NeonDiffDesktopCore

package protocol DesktopProviderVerifying: Sendable {
    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot
}
