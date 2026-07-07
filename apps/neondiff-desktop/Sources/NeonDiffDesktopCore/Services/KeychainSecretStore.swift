import Foundation
import Security

public protocol DesktopSecretStoring {
    func setSecret(_ secret: String, account: String) throws
    func readSecret(account: String) throws -> String?
    func containsSecret(account: String) -> Bool
    func deleteSecret(account: String) throws
}

public enum KeychainSecretError: Error, LocalizedError {
    case unexpectedStatus(OSStatus)
    case invalidData

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status): "Keychain operation failed with status \(status)"
        case .invalidData: "Keychain item did not contain UTF-8 text"
        }
    }
}

public final class KeychainSecretStore: DesktopSecretStoring {
    public let service: String

    public init(service: String = "com.electricsheephq.NeonDiffDesktop.secrets") {
        self.service = service
    }

    public func setSecret(_ secret: String, account: String) throws {
        let data = Data(secret.utf8)
        let query = baseQuery(account: account)
        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainSecretError.unexpectedStatus(status) }
    }

    public func readSecret(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainSecretError.unexpectedStatus(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretError.invalidData
        }
        return value
    }

    public func containsSecret(account: String) -> Bool {
        (try? readSecret(account: account)) != nil
    }

    public func deleteSecret(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecretError.unexpectedStatus(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
