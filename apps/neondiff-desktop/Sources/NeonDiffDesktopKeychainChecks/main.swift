import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Security

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    guard condition() else {
        fputs("CHECK FAILED: \(message)\n", stderr)
        exit(1)
    }
    return true
}

let existenceQuery = KeychainSecretStore.query(
    service: "com.example.neondiff.keychain-checks",
    account: "provider",
    operation: .contains
)
check(existenceQuery[kSecReturnData as String] == nil, "startup existence checks never request secret data")
check(existenceQuery[kSecUseAuthenticationContext as String] == nil, "startup checks do not construct a LocalAuthentication context")
check(
    existenceQuery[kSecUseAuthenticationUI as String] as? String == kSecUseAuthenticationUISkip as String,
    "startup existence checks skip legacy Keychain items that would present UI"
)

let noninteractiveReadQuery = KeychainSecretStore.query(
    service: "com.example.neondiff.keychain-checks",
    account: "github/user-login",
    operation: .read(allowUserInteraction: false)
)
check(noninteractiveReadQuery[kSecReturnData as String] as? Bool == true, "noninteractive reads still request secret data")
check(noninteractiveReadQuery[kSecUseAuthenticationContext as String] == nil, "noninteractive reads do not construct a LocalAuthentication context")
check(
    noninteractiveReadQuery[kSecUseAuthenticationUI as String] as? String == kSecUseAuthenticationUISkip as String,
    "noninteractive reads skip legacy Keychain items that would present UI"
)

let interactiveReadQuery = KeychainSecretStore.query(
    service: "com.example.neondiff.keychain-checks",
    account: "github/user-token",
    operation: .read(allowUserInteraction: true)
)
check(interactiveReadQuery[kSecReturnData as String] as? Bool == true, "interactive reads request secret data")
check(interactiveReadQuery[kSecUseAuthenticationContext as String] == nil, "interactive reads leave Keychain UI policy at system default")

final class LegacySecretStoreFixture: DesktopSecretStoring {
    func setSecret(_ secret: String, account: String) throws {}
    func readSecret(account: String) throws -> String? { "legacy-fixture" }
    func containsSecret(account: String) -> Bool { true }
    func deleteSecret(account: String) throws {}
}

let legacySecretStore = LegacySecretStoreFixture()
let legacySecretValue = try legacySecretStore.readSecret(account: "provider", allowUserInteraction: false)
check(
    legacySecretValue == nil,
    "existing secret-store conformers cannot fall back to interactive reads when UI is disallowed"
)
let legacyInteractiveSecretValue = try legacySecretStore.readSecret(account: "provider", allowUserInteraction: true)
check(
    legacyInteractiveSecretValue == "legacy-fixture",
    "existing secret-store conformers retain interactive read behavior"
)

print("NeonDiffDesktopKeychainChecks passed")
