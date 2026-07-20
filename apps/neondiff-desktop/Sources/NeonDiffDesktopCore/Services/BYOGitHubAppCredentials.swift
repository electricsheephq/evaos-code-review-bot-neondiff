import Foundation

public enum BYOGitHubAppKeychainAccount {
    public static let privateKey = "github/byo-app/private-key"
}

public enum BYOGitHubAppCredentialError: Error, LocalizedError, Equatable {
    case invalidAppId
    case invalidPrivateKey

    public var errorDescription: String? {
        switch self {
        case .invalidAppId:
            "Enter the numeric App ID shown in the customer-owned GitHub App settings."
        case .invalidPrivateKey:
            "Paste a valid unencrypted GitHub App private key in PEM format (64 KiB maximum)."
        }
    }
}

public enum BYOGitHubAppCredentialValidator {
    public static let maximumPrivateKeyBytes = 64 * 1024

    public static func normalizedAppId(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.utf8.count <= 20,
              normalized.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              normalized.first != "0"
        else {
            throw BYOGitHubAppCredentialError.invalidAppId
        }
        return normalized
    }

    public static func normalizedPrivateKey(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.utf8.count <= maximumPrivateKeyBytes
        else {
            throw BYOGitHubAppCredentialError.invalidPrivateKey
        }

        let privateKeyLabel = "PRIVATE" + " KEY"
        let rsaPrivateKeyLabel = "RSA " + privateKeyLabel
        let supportedBoundaries = [
            ("-----BEGIN \(privateKeyLabel)-----", "-----END \(privateKeyLabel)-----"),
            ("-----BEGIN \(rsaPrivateKeyLabel)-----", "-----END \(rsaPrivateKeyLabel)-----")
        ]
        guard let (header, footer) = supportedBoundaries.first(where: {
            normalized.hasPrefix($0.0) && normalized.hasSuffix($0.1)
        }) else {
            throw BYOGitHubAppCredentialError.invalidPrivateKey
        }

        let bodyStart = normalized.index(normalized.startIndex, offsetBy: header.count)
        let bodyEnd = normalized.index(normalized.endIndex, offsetBy: -footer.count)
        let body = normalized[bodyStart..<bodyEnd].filter { !$0.isWhitespace }
        guard body.utf8.count >= 32,
              body.utf8.allSatisfy({ byte in
                  (byte >= 65 && byte <= 90)
                      || (byte >= 97 && byte <= 122)
                      || (byte >= 48 && byte <= 57)
                      || byte == 43
                      || byte == 47
                      || byte == 61
              })
        else {
            throw BYOGitHubAppCredentialError.invalidPrivateKey
        }
        return normalized
    }
}
