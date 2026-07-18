import CryptoKit
import Foundation
import Testing
@_spi(Testing) import NeonDiffDesktopCore

private let brokerCredentialResponseField = ["to", "ken"].joined()

@Suite struct GitHubBrokerClientTests {
    @Test func keychainIdentityIsStableAndSignsVerifiableShortLivedCredentials() throws {
        let secrets = BrokerMemorySecretStore()
        let store = GitHubBrokerDeviceIdentityStore(
            secretStore: secrets,
            account: "broker-device-fixture"
        )

        let first = try store.loadOrCreate()
        let second = try store.loadOrCreate()

        #expect(first.deviceId == second.deviceId)
        #expect(first.publicKeyJWK == second.publicKeyJWK)
        #expect(first.publicKeyJWK.kty == "EC")
        #expect(first.publicKeyJWK.crv == "P-256")
        #expect(first.publicKeyJWK.x.isEmpty == false)
        #expect(first.publicKeyJWK.y.isEmpty == false)
        #expect(Array(secrets.values.keys) == ["broker-device-fixture"])
        #expect(String(describing: first) == "GitHub broker device \(first.deviceId)")
        #expect(String(describing: first).contains(secrets.values["broker-device-fixture"] ?? "") == false)

        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let credential = try first.makeCredential(now: now)
        let compactCredential = credential.tokenForTesting
        let segments = compactCredential.split(separator: ".", omittingEmptySubsequences: false)
        #expect(segments.count == 3)
        #expect(String(describing: credential) == "GitHub broker device credential [REDACTED]")

        let header = try #require(decodeBase64URLJSON(String(segments[0])))
        let payload = try #require(decodeBase64URLJSON(String(segments[1])))
        #expect(header["alg"] as? String == "ES256")
        #expect(header["typ"] as? String == "JWT")
        #expect(payload["sub"] as? String == first.deviceId)
        #expect(payload["iat"] as? Int == Int(now.timeIntervalSince1970))
        #expect(payload["exp"] as? Int == Int(now.timeIntervalSince1970) + 300)

        let publicKey = try P256.Signing.PublicKey(
            rawRepresentation: jwkRawRepresentation(first.publicKeyJWK)
        )
        let signature = try P256.Signing.ECDSASignature(
            rawRepresentation: try #require(decodeBase64URL(String(segments[2])))
        )
        let signingInput = Data("\(segments[0]).\(segments[1])".utf8)
        #expect(publicKey.isValidSignature(signature, for: signingInput))
    }

    @Test func corruptStoredIdentityFailsClosedWithoutSilentRotation() throws {
        let secrets = BrokerMemorySecretStore()
        try secrets.setSecret("not-valid-private-key-material", account: "broker-device-fixture")
        let store = GitHubBrokerDeviceIdentityStore(
            secretStore: secrets,
            account: "broker-device-fixture"
        )

        #expect(throws: GitHubBrokerDeviceIdentityError.invalidStoredIdentity) {
            _ = try store.loadOrCreate()
        }
        #expect(secrets.values["broker-device-fixture"] == "not-valid-private-key-material")
    }

    @Test func brokerClientUsesExactOriginAndPreservesRepositoryScope() async throws {
        let secrets = BrokerMemorySecretStore()
        let identity = try GitHubBrokerDeviceIdentityStore(secretStore: secrets).loadOrCreate()
        let transport = ScriptedBrokerTransport(responses: [
            .json(
                url: "https://broker.example/device/register",
                body: ["status": "registered", "deviceId": identity.deviceId]
            ),
            .json(
                url: "https://broker.example/github/connect/start",
                body: [
                    "status": "connect_started",
                    "installUrl": "https://github.com/apps/neondiff/installations/new?state=opaque-state",
                    "state": "opaque-state",
                    "expiresAt": "2027-01-15T08:05:00Z"
                ]
            ),
            .json(
                url: "https://broker.example/github/connect/complete",
                body: ["status": "pending"]
            ),
            .json(
                url: "https://broker.example/github/connect/complete",
                body: ["status": "bound", "installationId": 4242]
            ),
            .json(
                url: "https://broker.example/github/token",
                body: [
                    "status": "issued",
                    brokerCredentialResponseField: "fixture-installation-value",
                    "expiresAt": "2027-01-15T08:50:00Z",
                    "repositories": ["octo/private"],
                    "permissions": [
                        "actions": "read",
                        "checks": "read",
                        "contents": "read",
                        "metadata": "read",
                        "pull_requests": "write"
                    ]
                ]
            )
        ])
        let client = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: transport,
            now: { Date(timeIntervalSince1970: 1_800_000_000) }
        )

        try await client.register(identity: identity)
        let connect = try await client.startConnection(identity: identity)
        #expect(connect.installURL.host == "github.com")
        #expect(connect.state == "opaque-state")
        #expect(try await client.completeConnection(identity: identity, state: connect.state) == .pending)
        #expect(try await client.completeConnection(identity: identity, state: connect.state) == .bound(installationId: 4242))

        let grant = try await client.issueToken(
            identity: identity,
            installationId: 4242,
            repositories: ["octo/private"]
        )
        #expect(grant.repositories == ["octo/private"])
        #expect(grant.permissions == GitHubBrokerPermissions.minimumReview)
        #expect(String(describing: grant) == "GitHub installation grant for octo/private (expires 2027-01-15T08:50:00Z)")
        #expect(String(describing: grant).contains("fixture-installation-value") == false)
        #expect(grant.withToken { $0 } == "fixture-installation-value")

        let requests = await transport.requests
        #expect(requests.count == 5)
        #expect(requests.allSatisfy { $0.url.scheme == "https" && $0.url.host == "broker.example" })
        #expect(requests[0].headers["Authorization"] == nil)
        #expect(requests.dropFirst().allSatisfy { request in
            request.headers["Authorization"]?.hasPrefix("Bearer ey") == true
        })
        let registration = try #require(
            JSONSerialization.jsonObject(with: requests[0].body) as? [String: Any]
        )
        let publicJWK = try #require(registration["publicKeyJwk"] as? [String: Any])
        #expect(publicJWK["d"] == nil)
        let tokenRequest = try #require(
            JSONSerialization.jsonObject(with: requests[4].body) as? [String: Any]
        )
        #expect(tokenRequest["repositories"] as? [String] == ["octo/private"])
        #expect(tokenRequest["permissions"] == nil)
    }

    @Test func brokerClientFailsClosedOnIdentityOriginBudgetAndScopeMismatch() async throws {
        let identity = try GitHubBrokerDeviceIdentityStore(
            secretStore: BrokerMemorySecretStore()
        ).loadOrCreate()

        let wrongIdentity = ScriptedBrokerTransport(responses: [
            .json(
                url: "https://broker.example/device/register",
                body: ["status": "registered", "deviceId": "different-device"]
            )
        ])
        let wrongIdentityClient = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: wrongIdentity
        )
        await expectBrokerError(.identityMismatch) {
            try await wrongIdentityClient.register(identity: identity)
        }

        let wrongOrigin = ScriptedBrokerTransport(responses: [
            .json(
                url: "https://evil.example/github/connect/start",
                body: [
                    "status": "connect_started",
                    "installUrl": "https://github.com/apps/neondiff/installations/new?state=opaque-state",
                    "state": "opaque-state",
                    "expiresAt": "2027-01-15T08:05:00Z"
                ]
            )
        ])
        let wrongOriginClient = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: wrongOrigin
        )
        await expectBrokerError(.originMismatch) {
            _ = try await wrongOriginClient.startConnection(identity: identity)
        }

        let oversized = ScriptedBrokerTransport(responses: [
            GitHubBrokerHTTPResponse(
                statusCode: 200,
                url: URL(string: "https://broker.example/github/connect/start")!,
                headers: ["content-type": "application/json"],
                body: Data(repeating: 0x41, count: GitHubBrokerClient.maximumResponseBytes + 1)
            )
        ])
        let oversizedClient = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: oversized
        )
        await expectBrokerError(.responseTooLarge) {
            _ = try await oversizedClient.startConnection(identity: identity)
        }

        let widenedScope = ScriptedBrokerTransport(responses: [
            .json(
                url: "https://broker.example/github/token",
                body: [
                    "status": "issued",
                    brokerCredentialResponseField: "fixture-installation-value",
                    "expiresAt": "2027-01-15T08:50:00Z",
                    "repositories": ["octo/private", "octo/not-requested"],
                    "permissions": [
                        "actions": "read",
                        "checks": "read",
                        "contents": "read",
                        "metadata": "read",
                        "pull_requests": "write"
                    ]
                ]
            )
        ])
        let widenedScopeClient = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: widenedScope
        )
        await expectBrokerError(.scopeMismatch) {
            _ = try await widenedScopeClient.issueToken(
                identity: identity,
                installationId: 4242,
                repositories: ["octo/private"]
            )
        }

        let widenedPermissions = ScriptedBrokerTransport(responses: [
            .json(
                url: "https://broker.example/github/token",
                body: [
                    "status": "issued",
                    brokerCredentialResponseField: "fixture-installation-value",
                    "expiresAt": "2027-01-15T08:50:00Z",
                    "repositories": ["octo/private"],
                    "permissions": [
                        "actions": "read",
                        "checks": "read",
                        "contents": "read",
                        "issues": "write",
                        "metadata": "read",
                        "pull_requests": "write"
                    ]
                ]
            )
        ])
        let widenedPermissionsClient = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: widenedPermissions
        )
        await expectBrokerError(.permissionMismatch) {
            _ = try await widenedPermissionsClient.issueToken(
                identity: identity,
                installationId: 4242,
                repositories: ["octo/private"]
            )
        }
    }

    @Test func brokerClientMapsServerReasonsWithoutReflectingDetail() async throws {
        let identity = try GitHubBrokerDeviceIdentityStore(
            secretStore: BrokerMemorySecretStore()
        ).loadOrCreate()
        let transport = ScriptedBrokerTransport(responses: [
            .json(
                statusCode: 403,
                url: "https://broker.example/github/token",
                body: [
                    "status": "error",
                    "reason": "entitlement_missing",
                    "detail": "sensitive upstream detail must not escape"
                ]
            )
        ])
        let client = try GitHubBrokerClient(
            baseURL: URL(string: "https://broker.example")!,
            transport: transport
        )

        do {
            _ = try await client.issueToken(
                identity: identity,
                installationId: 4242,
                repositories: ["octo/private"]
            )
            Issue.record("expected a typed server refusal")
        } catch let error as GitHubBrokerClientError {
            #expect(error == .server(reason: .entitlementMissing))
            #expect(error.localizedDescription.contains("sensitive upstream") == false)
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }
}

private final class BrokerMemorySecretStore: DesktopSecretStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]

    var values: [String: String] {
        lock.withLock { storage }
    }

    func setSecret(_ secret: String, account: String) throws {
        lock.withLock { storage[account] = secret }
    }

    func readSecret(account: String) throws -> String? {
        lock.withLock { storage[account] }
    }

    func containsSecret(account: String) -> Bool {
        lock.withLock { storage[account] != nil }
    }

    func deleteSecret(account: String) throws {
        _ = lock.withLock { storage.removeValue(forKey: account) }
    }
}

private actor ScriptedBrokerTransport: GitHubBrokerTransporting {
    private var scripted: [GitHubBrokerHTTPResponse]
    private(set) var requests: [GitHubBrokerHTTPRequest] = []

    init(responses: [GitHubBrokerHTTPResponse]) {
        scripted = responses
    }

    func send(_ request: GitHubBrokerHTTPRequest) async throws -> GitHubBrokerHTTPResponse {
        requests.append(request)
        guard scripted.isEmpty == false else {
            throw GitHubBrokerClientError.transportUnavailable
        }
        return scripted.removeFirst()
    }
}

private extension GitHubBrokerHTTPResponse {
    static func json(
        statusCode: Int = 200,
        url: String,
        body: [String: Any]
    ) -> GitHubBrokerHTTPResponse {
        GitHubBrokerHTTPResponse(
            statusCode: statusCode,
            url: URL(string: url)!,
            headers: ["content-type": "application/json"],
            body: try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        )
    }
}

private func decodeBase64URLJSON(_ value: String) -> [String: Any]? {
    guard let data = decodeBase64URL(value) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

private func decodeBase64URL(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
}

private func jwkRawRepresentation(_ jwk: GitHubBrokerPublicJWK) throws -> Data {
    var result = Data()
    result.append(try #require(decodeBase64URL(jwk.x)))
    result.append(try #require(decodeBase64URL(jwk.y)))
    return result
}

private func expectBrokerError<T>(
    _ expected: GitHubBrokerClientError,
    operation: () async throws -> T
) async {
    do {
        _ = try await operation()
        Issue.record("expected \(expected)")
    } catch let error as GitHubBrokerClientError {
        #expect(error == expected)
    } catch {
        Issue.record("unexpected error type: \(error)")
    }
}
