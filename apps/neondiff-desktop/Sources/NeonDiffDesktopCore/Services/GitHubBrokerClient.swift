import CryptoKit
import Foundation

public struct GitHubBrokerPublicJWK: Codable, Equatable, Sendable {
    public let kty: String
    public let crv: String
    public let x: String
    public let y: String

    public init(kty: String = "EC", crv: String = "P-256", x: String, y: String) {
        self.kty = kty
        self.crv = crv
        self.x = x
        self.y = y
    }
}

public enum GitHubBrokerDeviceIdentityError: Error, LocalizedError, Equatable {
    case storedIdentityMissing
    case invalidStoredIdentity
    case identityGenerationFailed
    case identityStorageUnavailable
    case credentialSigningFailed

    public var errorDescription: String? {
        switch self {
        case .storedIdentityMissing:
            "The saved GitHub broker binding has no Keychain device identity. Reconnect explicitly to create a new binding."
        case .invalidStoredIdentity:
            "The stored GitHub broker device identity is invalid. Reconnect support is required; NeonDiff will not silently replace a bound identity."
        case .identityGenerationFailed:
            "NeonDiff could not create the GitHub broker device identity."
        case .identityStorageUnavailable:
            "NeonDiff could not access the stored GitHub broker device identity."
        case .credentialSigningFailed:
            "NeonDiff could not sign the GitHub broker device credential."
        }
    }
}

public struct GitHubBrokerDeviceCredential: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    fileprivate let token: String

    public var description: String { "GitHub broker device credential [REDACTED]" }
    public var debugDescription: String { description }

    @_spi(Testing) public var tokenForTesting: String { token }
}

public struct GitHubBrokerDeviceIdentity: @unchecked Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let deviceId: String
    public let publicKeyJWK: GitHubBrokerPublicJWK
    private let privateKey: P256.Signing.PrivateKey

    fileprivate init(privateKey: P256.Signing.PrivateKey) {
        self.privateKey = privateKey
        let raw = [UInt8](privateKey.publicKey.rawRepresentation)
        precondition(raw.count == 64)
        publicKeyJWK = GitHubBrokerPublicJWK(
            x: base64URL(raw[0..<32]),
            y: base64URL(raw[32..<64])
        )
        deviceId = Self.deviceId(for: publicKeyJWK)
    }

    public var description: String { "GitHub broker device \(deviceId)" }
    public var debugDescription: String { description }

    public func makeCredential(now: Date = Date()) throws -> GitHubBrokerDeviceCredential {
        let issuedAt = Int(now.timeIntervalSince1970)
        let header = try canonicalJSON([
            "alg": "ES256",
            "typ": "JWT"
        ])
        let payload = try canonicalJSON([
            "exp": issuedAt + 300,
            "iat": issuedAt,
            "sub": deviceId
        ])
        let encodedHeader = base64URL(header)
        let encodedPayload = base64URL(payload)
        let signingInput = Data("\(encodedHeader).\(encodedPayload)".utf8)
        do {
            let signature = try privateKey.signature(for: signingInput)
            return GitHubBrokerDeviceCredential(
                token: "\(encodedHeader).\(encodedPayload).\(base64URL(signature.rawRepresentation))"
            )
        } catch {
            throw GitHubBrokerDeviceIdentityError.credentialSigningFailed
        }
    }

    private static func deviceId(for jwk: GitHubBrokerPublicJWK) -> String {
        // RFC 7638 requires the lexicographically ordered required members.
        let canonical = #"{"crv":"\#(jwk.crv)","kty":"\#(jwk.kty)","x":"\#(jwk.x)","y":"\#(jwk.y)"}"#
        return base64URL(Data(SHA256.hash(data: Data(canonical.utf8))))
    }
}

public final class GitHubBrokerDeviceIdentityStore {
    public static let defaultAccount = "github-broker-device-p256"

    private let secretStore: any DesktopSecretStoring
    private let account: String
    private let lock = NSLock()

    public init(
        secretStore: any DesktopSecretStoring,
        account: String = GitHubBrokerDeviceIdentityStore.defaultAccount
    ) {
        self.secretStore = secretStore
        self.account = account
    }

    /// Loads lazily from Keychain or creates the device identity on an explicit
    /// connect action. Never call this on the app launch path.
    public func loadOrCreate() throws -> GitHubBrokerDeviceIdentity {
        try lock.withLock {
            if let encoded = try readStoredIdentity() {
                return try decodeIdentity(encoded)
            }

            let key = P256.Signing.PrivateKey()
            let encoded = key.rawRepresentation.base64EncodedString()
            do {
                if try secretStore.createSecretIfAbsent(encoded, account: account) {
                    return GitHubBrokerDeviceIdentity(privateKey: key)
                }
            } catch {
                throw GitHubBrokerDeviceIdentityError.identityStorageUnavailable
            }

            // Another store instance won the atomic Keychain add. Discard this
            // generated key and rebind to the persisted winner.
            guard let winner = try readStoredIdentity() else {
                throw GitHubBrokerDeviceIdentityError.identityStorageUnavailable
            }
            return try decodeIdentity(winner)
        }
    }

    /// Loads a previously-created identity without rotating or creating one.
    /// Saved-binding verification must use this path so a missing Keychain item
    /// cannot silently orphan the server-side binding.
    public func loadExisting() throws -> GitHubBrokerDeviceIdentity {
        try lock.withLock {
            guard let encoded = try readStoredIdentity() else {
                throw GitHubBrokerDeviceIdentityError.storedIdentityMissing
            }
            return try decodeIdentity(encoded)
        }
    }

    private func readStoredIdentity() throws -> String? {
        do {
            return try secretStore.readSecret(account: account)
        } catch {
            throw GitHubBrokerDeviceIdentityError.identityStorageUnavailable
        }
    }

    private func decodeIdentity(_ encoded: String) throws -> GitHubBrokerDeviceIdentity {
        guard let raw = Data(base64Encoded: encoded),
              let key = try? P256.Signing.PrivateKey(rawRepresentation: raw)
        else {
            // A silently replaced identity would orphan or cross-bind the
            // server-side installation record, so corrupt state fails closed.
            throw GitHubBrokerDeviceIdentityError.invalidStoredIdentity
        }
        return GitHubBrokerDeviceIdentity(privateKey: key)
    }
}

public struct GitHubBrokerHTTPRequest: Sendable {
    public let method: String
    public let url: URL
    public let headers: [String: String]
    public let body: Data
    public let maximumResponseBytes: Int

    public init(
        method: String,
        url: URL,
        headers: [String: String],
        body: Data,
        maximumResponseBytes: Int
    ) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.maximumResponseBytes = maximumResponseBytes
    }
}

public struct GitHubBrokerHTTPResponse: Sendable {
    public let statusCode: Int
    public let url: URL
    public let headers: [String: String]
    public let body: Data

    public init(statusCode: Int, url: URL, headers: [String: String], body: Data) {
        self.statusCode = statusCode
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public protocol GitHubBrokerTransporting: Sendable {
    func send(_ request: GitHubBrokerHTTPRequest) async throws -> GitHubBrokerHTTPResponse
}

/// Production transport. Redirects are refused and both declared and received
/// response sizes are checked before any body reaches the broker decoder.
public final class URLSessionGitHubBrokerTransport: GitHubBrokerTransporting, @unchecked Sendable {
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.waitsForConnectivity = false
        session = URLSession(
            configuration: configuration,
            delegate: GitHubBrokerRedirectRejectingDelegate(),
            delegateQueue: nil
        )
    }

    public func send(_ request: GitHubBrokerHTTPRequest) async throws -> GitHubBrokerHTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        request.headers.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }

        let (bytes, response) = try await session.bytes(for: urlRequest)
        guard let http = response as? HTTPURLResponse, let responseURL = http.url else {
            throw GitHubBrokerClientError.invalidResponse
        }
        if http.expectedContentLength > Int64(request.maximumResponseBytes) {
            throw GitHubBrokerClientError.responseTooLarge
        }
        var data = Data()
        if http.expectedContentLength > 0 {
            data.reserveCapacity(min(Int(http.expectedContentLength), request.maximumResponseBytes))
        }
        for try await byte in bytes {
            guard data.count < request.maximumResponseBytes else {
                throw GitHubBrokerClientError.responseTooLarge
            }
            data.append(byte)
        }
        let headers = Dictionary(uniqueKeysWithValues: http.allHeaderFields.map {
            (String(describing: $0.key).lowercased(), String(describing: $0.value))
        })
        return GitHubBrokerHTTPResponse(
            statusCode: http.statusCode,
            url: responseURL,
            headers: headers,
            body: data
        )
    }
}

private final class GitHubBrokerRedirectRejectingDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public enum GitHubBrokerReason: String, Sendable {
    case invalidRequest = "invalid_request"
    case deviceNotRegistered = "device_not_registered"
    case invalidDeviceCredential = "invalid_device_credential"
    case stateNotFound = "state_not_found"
    case stateExpired = "state_expired"
    case stateReplayed = "state_replayed"
    case bindingNotFound = "binding_not_found"
    case installationNotFound = "installation_not_found"
    case installationUninstalled = "installation_uninstalled"
    case installationSuspended = "installation_suspended"
    case installationAuthorizationUnverified = "installation_authorization_unverified"
    case repoOutsideInstallation = "repo_outside_installation"
    case repoOutsideAuthorization = "repo_outside_authorization"
    case repoRenamedOrTransferred = "repo_renamed_or_transferred"
    case visibilityUnknown = "visibility_unknown"
    case entitlementMissing = "entitlement_missing"
    case entitlementExpired = "entitlement_expired"
    case entitlementRevoked = "entitlement_revoked"
    case entitlementInvalid = "entitlement_invalid"
    case entitlementScopeInsufficient = "entitlement_scope_insufficient"
    case entitlementSeatExhausted = "entitlement_seat_exhausted"
    case entitlementReplayConflict = "entitlement_replay_conflict"
    case entitlementServiceUnavailable = "entitlement_service_unavailable"
    case rateLimited = "rate_limited"
    case brokerUnavailable = "broker_unavailable"
}

public enum GitHubBrokerClientError: Error, LocalizedError, Equatable, Sendable {
    case invalidBaseURL
    case invalidRequest
    case transportUnavailable
    case invalidResponse
    case responseTooLarge
    case originMismatch
    case identityMismatch
    case scopeMismatch
    case permissionMismatch
    case server(reason: GitHubBrokerReason)

    public var errorDescription: String? {
        switch self {
        case .invalidBaseURL: "The GitHub broker URL is invalid."
        case .invalidRequest: "The GitHub broker request is invalid."
        case .transportUnavailable: "The GitHub broker is unavailable."
        case .invalidResponse: "The GitHub broker returned an invalid response."
        case .responseTooLarge: "The GitHub broker response exceeded the safety limit."
        case .originMismatch: "The GitHub broker response came from an unexpected origin."
        case .identityMismatch: "The GitHub broker registered a different device identity."
        case .scopeMismatch: "The GitHub broker returned a repository outside the requested scope."
        case .permissionMismatch: "The GitHub broker returned an unexpected permission set."
        case .server(let reason): "The GitHub broker refused the request: \(reason.rawValue)."
        }
    }
}

public struct GitHubBrokerPermissions: Equatable, Sendable {
    public let values: [String: String]

    public init(values: [String: String]) {
        self.values = values
    }

    public static let minimumReview = GitHubBrokerPermissions(values: [
        "actions": "read",
        "checks": "read",
        "contents": "read",
        "metadata": "read",
        "pull_requests": "write"
    ])
}

public struct GitHubBrokerConnection: Equatable, Sendable {
    public let installURL: URL
    public let state: String
    public let expiresAt: Date

    public init(installURL: URL, state: String, expiresAt: Date) {
        self.installURL = installURL
        self.state = state
        self.expiresAt = expiresAt
    }
}

public enum GitHubBrokerConnectionCompletion: Equatable, Sendable {
    case pending
    case bound(installationId: Int)
}

public enum GitHubBrokerRepositoryVisibility: String, Codable, Equatable, Sendable {
    case `public`
    case `private`
    case `internal`
    case unknown
}

public struct GitHubBrokerRepository: Codable, Equatable, Sendable {
    public let fullName: String
    public let visibility: GitHubBrokerRepositoryVisibility

    public init(fullName: String, visibility: GitHubBrokerRepositoryVisibility) {
        self.fullName = fullName
        self.visibility = visibility
    }
}

public struct GitHubBrokerRepositoryPage: Equatable, Sendable {
    public let installationId: Int
    public let page: Int
    public let repositories: [GitHubBrokerRepository]
    public let nextPage: Int?

    public init(
        installationId: Int,
        page: Int,
        repositories: [GitHubBrokerRepository],
        nextPage: Int?
    ) {
        self.installationId = installationId
        self.page = page
        self.repositories = repositories
        self.nextPage = nextPage
    }
}

public protocol GitHubBrokerConnecting: Sendable {
    func register(identity: GitHubBrokerDeviceIdentity) async throws
    func startConnection(identity: GitHubBrokerDeviceIdentity) async throws -> GitHubBrokerConnection
    func completeConnection(
        identity: GitHubBrokerDeviceIdentity,
        state: String
    ) async throws -> GitHubBrokerConnectionCompletion
    func authorizeExistingInstallation(
        identity: GitHubBrokerDeviceIdentity,
        state: String,
        installationId: Int,
        userAccessToken: String
    ) async throws -> Int
    func listRepositories(
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int,
        page: Int
    ) async throws -> GitHubBrokerRepositoryPage
}

public struct GitHubInstallationAccessGrant: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let expiresAt: Date
    public let repositories: [String]
    public let permissions: GitHubBrokerPermissions
    private let token: String
    private let expiresAtText: String

    fileprivate init(
        token: String,
        expiresAt: Date,
        expiresAtText: String,
        repositories: [String],
        permissions: GitHubBrokerPermissions
    ) {
        self.token = token
        self.expiresAt = expiresAt
        self.expiresAtText = expiresAtText
        self.repositories = repositories
        self.permissions = permissions
    }

    public func withToken<T>(_ body: (String) throws -> T) rethrows -> T {
        try body(token)
    }

    public var description: String {
        "GitHub installation grant for \(repositories.joined(separator: ", ")) (expires \(expiresAtText))"
    }

    public var debugDescription: String { description }
}

public struct GitHubBrokerClient: GitHubBrokerConnecting, Sendable {
    public static let maximumResponseBytes = 64 * 1024

    private let baseURL: URL
    private let transport: any GitHubBrokerTransporting
    private let now: @Sendable () -> Date

    public init(
        baseURL: URL,
        transport: any GitHubBrokerTransporting = URLSessionGitHubBrokerTransport(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) throws {
        guard Self.isValidBaseURL(baseURL) else {
            throw GitHubBrokerClientError.invalidBaseURL
        }
        self.baseURL = baseURL
        self.transport = transport
        self.now = now
    }

    public func register(identity: GitHubBrokerDeviceIdentity) async throws {
        let response: RegisterResponse = try await post(
            path: "/device/register",
            body: [
                "publicKeyJwk": [
                    "kty": identity.publicKeyJWK.kty,
                    "crv": identity.publicKeyJWK.crv,
                    "x": identity.publicKeyJWK.x,
                    "y": identity.publicKeyJWK.y
                ]
            ],
            credential: nil
        )
        guard response.status == "registered", response.deviceId == identity.deviceId else {
            throw GitHubBrokerClientError.identityMismatch
        }
    }

    public func startConnection(identity: GitHubBrokerDeviceIdentity) async throws -> GitHubBrokerConnection {
        let response: StartResponse = try await post(
            path: "/github/connect/start",
            body: [:],
            credential: try identity.makeCredential(now: now())
        )
        guard response.status == "connect_started",
              let installURL = URL(string: response.installUrl),
              Self.isValidInstallURL(installURL, state: response.state),
              let expiresAt = parseBrokerDate(response.expiresAt),
              expiresAt > now(),
              expiresAt.timeIntervalSince(now()) <= 10 * 60 + 5
        else {
            throw GitHubBrokerClientError.invalidResponse
        }
        return GitHubBrokerConnection(installURL: installURL, state: response.state, expiresAt: expiresAt)
    }

    public func completeConnection(
        identity: GitHubBrokerDeviceIdentity,
        state: String
    ) async throws -> GitHubBrokerConnectionCompletion {
        guard Self.isOpaqueState(state) else {
            throw GitHubBrokerClientError.invalidRequest
        }
        let response: CompleteResponse = try await post(
            path: "/github/connect/complete",
            body: ["state": state],
            credential: try identity.makeCredential(now: now())
        )
        switch response.status {
        case "pending":
            guard response.installationId == nil else {
                throw GitHubBrokerClientError.invalidResponse
            }
            return .pending
        case "bound":
            guard let installationId = response.installationId, installationId > 0 else {
                throw GitHubBrokerClientError.invalidResponse
            }
            return .bound(installationId: installationId)
        default:
            throw GitHubBrokerClientError.invalidResponse
        }
    }

    public func authorizeExistingInstallation(
        identity: GitHubBrokerDeviceIdentity,
        state: String,
        installationId: Int,
        userAccessToken: String
    ) async throws -> Int {
        guard Self.isOpaqueState(state),
              installationId > 0,
              userAccessToken.isEmpty == false,
              userAccessToken.utf8.count <= 4_096,
              userAccessToken.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        else {
            throw GitHubBrokerClientError.invalidRequest
        }
        let response: AuthorizeExistingResponse = try await post(
            path: "/github/connect/authorize-existing",
            body: [
                "state": state,
                "installationId": installationId,
                "userAccessToken": userAccessToken
            ],
            credential: try identity.makeCredential(now: now())
        )
        guard response.status == "bound", response.installationId == installationId else {
            throw GitHubBrokerClientError.identityMismatch
        }
        return response.installationId
    }

    public func listRepositories(
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int,
        page: Int = 1
    ) async throws -> GitHubBrokerRepositoryPage {
        guard installationId > 0, (1...200).contains(page) else {
            throw GitHubBrokerClientError.invalidRequest
        }
        let response: RepositoryPageResponse = try await post(
            path: "/github/repositories",
            body: [
                "installationId": installationId,
                "page": page
            ],
            credential: try identity.makeCredential(now: now())
        )
        let repositoryNames = response.repositories.map(\.fullName)
        guard response.status == "listed",
              response.installationId == installationId,
              response.page == page,
              response.repositories.count <= 50,
              Set(repositoryNames).count == repositoryNames.count,
              repositoryNames.allSatisfy(Self.isCanonicalRepository),
              repositoryNames == repositoryNames.sorted(),
              response.nextPage == nil || response.nextPage == page + 1,
              response.nextPage.map({ (1...200).contains($0) }) ?? true
        else {
            throw GitHubBrokerClientError.scopeMismatch
        }
        return GitHubBrokerRepositoryPage(
            installationId: response.installationId,
            page: response.page,
            repositories: response.repositories,
            nextPage: response.nextPage
        )
    }

    public func issueToken(
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int,
        repositories: [String],
        activationKey: ActivationKeyMaterial? = nil
    ) async throws -> GitHubInstallationAccessGrant {
        guard installationId > 0,
              repositories.isEmpty == false,
              repositories.count <= 50,
              Set(repositories).count == repositories.count,
              repositories.allSatisfy(Self.isCanonicalRepository)
        else {
            throw GitHubBrokerClientError.invalidRequest
        }
        var body: [String: Any] = [
            "installationId": installationId,
            "repositories": repositories
        ]
        if let activationKey {
            activationKey.withRawValue { body["activationKey"] = $0 }
        }
        let response: TokenResponse = try await post(
            path: "/github/token",
            body: body,
            credential: try identity.makeCredential(now: now())
        )
        guard response.status == "issued",
              response.token.isEmpty == false,
              response.repositories == repositories
        else {
            throw GitHubBrokerClientError.scopeMismatch
        }
        let permissions = GitHubBrokerPermissions(values: response.permissions)
        guard permissions == .minimumReview else {
            throw GitHubBrokerClientError.permissionMismatch
        }
        guard let expiresAt = parseBrokerDate(response.expiresAt),
              expiresAt > now(),
              expiresAt.timeIntervalSince(now()) <= 3_700
        else {
            throw GitHubBrokerClientError.invalidResponse
        }
        return GitHubInstallationAccessGrant(
            token: response.token,
            expiresAt: expiresAt,
            expiresAtText: response.expiresAt,
            repositories: response.repositories,
            permissions: permissions
        )
    }

    private func post<T: Decodable>(
        path: String,
        body: [String: Any],
        credential: GitHubBrokerDeviceCredential?
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              Self.sameOrigin(url, baseURL),
              url.path == path
        else {
            throw GitHubBrokerClientError.invalidRequest
        }
        let encodedBody: Data
        do {
            encodedBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        } catch {
            throw GitHubBrokerClientError.invalidRequest
        }
        var headers = [
            "Accept": "application/json",
            "Content-Type": "application/json"
        ]
        if let credential {
            headers["Authorization"] = "Bearer \(credential.token)"
        }
        let request = GitHubBrokerHTTPRequest(
            method: "POST",
            url: url,
            headers: headers,
            body: encodedBody,
            maximumResponseBytes: Self.maximumResponseBytes
        )
        let response: GitHubBrokerHTTPResponse
        do {
            response = try await transport.send(request)
        } catch let error as GitHubBrokerClientError {
            throw error
        } catch {
            throw GitHubBrokerClientError.transportUnavailable
        }
        guard response.url == request.url else {
            throw GitHubBrokerClientError.originMismatch
        }
        guard response.body.count <= Self.maximumResponseBytes else {
            throw GitHubBrokerClientError.responseTooLarge
        }
        var normalizedHeaders: [String: String] = [:]
        for (name, value) in response.headers {
            let normalizedName = name.lowercased()
            guard normalizedHeaders[normalizedName] == nil else {
                throw GitHubBrokerClientError.invalidResponse
            }
            normalizedHeaders[normalizedName] = value.lowercased()
        }
        guard normalizedHeaders["content-type"]?.hasPrefix("application/json") == true else {
            throw GitHubBrokerClientError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw Self.serverError(from: response.body)
        }
        do {
            return try JSONDecoder().decode(T.self, from: response.body)
        } catch {
            throw GitHubBrokerClientError.invalidResponse
        }
    }

    private static func serverError(from body: Data) -> GitHubBrokerClientError {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              object["status"] as? String == "error",
              let rawReason = object["reason"] as? String,
              let reason = GitHubBrokerReason(rawValue: rawReason)
        else {
            return .invalidResponse
        }
        // Deliberately ignore server `detail`; only the typed reason crosses the
        // native public/error boundary.
        return .server(reason: reason)
    }

    private static func isValidBaseURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.isEmpty == false
            && url.user == nil
            && url.password == nil
            && url.query == nil
            && url.fragment == nil
            && (url.path.isEmpty || url.path == "/")
    }

    private static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        left.scheme?.lowercased() == right.scheme?.lowercased()
            && left.host?.lowercased() == right.host?.lowercased()
            && effectivePort(left) == effectivePort(right)
    }

    private static func isValidInstallURL(_ url: URL, state: String) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "github.com",
              url.user == nil,
              url.password == nil,
              url.fragment == nil,
              url.path.hasPrefix("/apps/"),
              url.path.hasSuffix("/installations/new"),
              isOpaqueState(state)
        else {
            return false
        }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .filter { $0.name == "state" }
            .map(\.value) == [state]
    }

    private static func isOpaqueState(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{8,256}$"#, options: .regularExpression) != nil
    }

    private static func isCanonicalRepository(_ value: String) -> Bool {
        value.range(
            of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#,
            options: .regularExpression
        ) != nil
    }
}

private struct RegisterResponse: Decodable {
    let status: String
    let deviceId: String
}

private struct StartResponse: Decodable {
    let status: String
    let installUrl: String
    let state: String
    let expiresAt: String
}

private struct CompleteResponse: Decodable {
    let status: String
    let installationId: Int?
}

private struct AuthorizeExistingResponse: Decodable {
    let status: String
    let installationId: Int
}

private struct RepositoryPageResponse: Decodable {
    let status: String
    let installationId: Int
    let page: Int
    let repositories: [GitHubBrokerRepository]
    let nextPage: Int?
}

private struct TokenResponse: Decodable {
    let status: String
    let token: String
    let expiresAt: String
    let repositories: [String]
    let permissions: [String: String]
}

private func canonicalJSON(_ object: [String: Any]) throws -> Data {
    do {
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    } catch {
        throw GitHubBrokerDeviceIdentityError.credentialSigningFailed
    }
}

private func base64URL<S: DataProtocol>(_ bytes: S) -> String {
    Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func parseBrokerDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}

private func effectivePort(_ url: URL) -> Int? {
    if let port = url.port { return port }
    switch url.scheme?.lowercased() {
    case "https": return 443
    case "http": return 80
    default: return nil
    }
}
