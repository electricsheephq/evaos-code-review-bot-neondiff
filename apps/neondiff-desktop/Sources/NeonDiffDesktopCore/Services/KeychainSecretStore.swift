import Foundation
import Security

public protocol DesktopSecretStoring {
    func setSecret(_ secret: String, account: String) throws
    func readSecret(account: String) throws -> String?
    func readSecret(account: String, allowUserInteraction: Bool) throws -> String?
    func containsSecret(account: String) -> Bool
    func deleteSecret(account: String) throws
}

public extension DesktopSecretStoring {
    func readSecret(account: String, allowUserInteraction: Bool) throws -> String? {
        guard allowUserInteraction else { return nil }
        return try readSecret(account: account)
    }
}

@_spi(Testing) public enum KeychainSecretQueryOperation {
    case contains
    case read(allowUserInteraction: Bool)
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
    private let lockRegistry = NSLock()
    private var accountLocks: [String: NSLock] = [:]

    public init(service: String = "com.electricsheephq.NeonDiffDesktop.secrets") {
        self.service = service
    }

    public func setSecret(_ secret: String, account: String) throws {
        let lock = accountLock(for: account)
        lock.lock()
        defer { lock.unlock() }
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
        try readSecret(account: account, allowUserInteraction: true)
    }

    public func readSecret(account: String, allowUserInteraction: Bool) throws -> String? {
        let lock = accountLock(for: account)
        lock.lock()
        defer { lock.unlock() }
        let query = Self.query(
            service: service,
            account: account,
            operation: .read(allowUserInteraction: allowUserInteraction)
        )

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if !allowUserInteraction && status == errSecInteractionNotAllowed { return nil }
        guard status == errSecSuccess else { throw KeychainSecretError.unexpectedStatus(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretError.invalidData
        }
        return value
    }

    public func containsSecret(account: String) -> Bool {
        let lock = accountLock(for: account)
        lock.lock()
        defer { lock.unlock() }
        let query = Self.query(service: service, account: account, operation: .contains)
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    public func deleteSecret(account: String) throws {
        let lock = accountLock(for: account)
        lock.lock()
        defer { lock.unlock() }
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecretError.unexpectedStatus(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        Self.baseQuery(service: service, account: account)
    }

    private func accountLock(for account: String) -> NSLock {
        lockRegistry.withLock {
            if let lock = accountLocks[account] { return lock }
            let lock = NSLock()
            accountLocks[account] = lock
            return lock
        }
    }

    @_spi(Testing) public static func query(
        service: String,
        account: String,
        operation: KeychainSecretQueryOperation
    ) -> [String: Any] {
        var query = baseQuery(service: service, account: account)
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        switch operation {
        case .contains:
            query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        case .read(let allowUserInteraction):
            query[kSecReturnData as String] = true
            if !allowUserInteraction {
                query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
            }
        }
        return query
    }

    private static func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

}
