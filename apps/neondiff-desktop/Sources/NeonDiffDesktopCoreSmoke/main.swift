import Foundation
import NeonDiffDesktopCore

let service = "com.electricsheephq.NeonDiffDesktop.smoke.\(ProcessInfo.processInfo.processIdentifier)"
let store = KeychainSecretStore(service: service)
let providerAccount = "provider:zai"
let licenseAccount = "license:default"
let fakeProviderKey = "fixture-provider-secret-1234567890"
let fakeLicenseKey = "fixture-license-secret-1234567890"

do {
    try store.setSecret(fakeProviderKey, account: providerAccount)
    try store.setSecret(fakeLicenseKey, account: licenseAccount)
    guard try store.readSecret(account: providerAccount) == fakeProviderKey else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "provider keychain round-trip failed"])
    }
    guard store.containsSecret(account: licenseAccount) else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: "license keychain status failed"])
    }

    let command = NeonDiffCommandBuilder.daemonControl(
        action: "start",
        cliPath: "neondiff",
        configPath: "/tmp/config.local.json",
        launchdLabel: "com.example.neondiff",
        dryRun: true
    )
    guard command.commandLine.contains("--dry-run true"), !command.commandLine.contains("--confirm true") else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 3, userInfo: [NSLocalizedDescriptionKey: "daemon command is not dry-run safe"])
    }

    let fakeStatusJSON = """
    {
      "ok": false,
      "command": "daemon status",
      "launchdLabel": "com.example.neondiff",
      "runtimeOk": true,
      "status": {
        "ok": false,
        "checkedAt": "2026-07-03T00:00:00.000Z",
        "launchd": {
          "label": "com.example.neondiff",
          "state": "unknown"
        }
      }
    }
    """
    guard let parsed = DaemonStatusParser.parse(fakeStatusJSON, launchdLabel: "com.example.neondiff", fallbackCommand: command.commandLine) else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 4, userInfo: [NSLocalizedDescriptionKey: "fake status parse failed"])
    }
    guard parsed.0.healthState == "runtime_blocked", parsed.0.checkedAt == "2026-07-03T00:00:00.000Z" else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 5, userInfo: [NSLocalizedDescriptionKey: "fake status values did not map"])
    }

    let fakeConfigJSON = """
    {
      "ok": true,
      "command": "config inspect",
      "config": {
        "pilotRepos": ["electricsheephq/evaos-code-review-bot"],
        "repoProfiles": {
          "repos": {
            "electricsheephq/evaos-code-review-bot": {
              "enabled": true,
              "displayName": "NeonDiff"
            }
          }
        },
        "zcode": {
          "cliPath": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
          "appConfigPath": "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
          "model": "GLM-5.2"
        },
        "desktop": {
          "openAICompatibleEndpoint": "http://localhost:8000/v1",
          "updateChannel": "dev"
        }
      }
    }
    """
    guard let snapshot = ConfigInspectParser.parse(fakeConfigJSON, providerKeyStored: true, licenseKeyStored: true) else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 6, userInfo: [NSLocalizedDescriptionKey: "fake config parse failed"])
    }
    guard snapshot.repos.first?.profile == "NeonDiff", snapshot.providers.providerKeyStored, snapshot.license.keyStored else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 7, userInfo: [NSLocalizedDescriptionKey: "fake config values did not map"])
    }

    let repoProfileOnlyConfigJSON = """
    {
      "ok": true,
      "command": "config inspect",
      "config": {
        "pilotRepos": [],
        "repoProfiles": {
          "repos": {
            "owner/enabled": { "enabled": true },
            "owner/disabled": { "enabled": false }
          }
        },
        "zcode": {},
        "desktop": {}
      }
    }
    """
    guard let profileOnlySnapshot = ConfigInspectParser.parse(repoProfileOnlyConfigJSON, providerKeyStored: false, licenseKeyStored: false),
          profileOnlySnapshot.repos.map(\.name) == ["owner/enabled"] else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 8, userInfo: [NSLocalizedDescriptionKey: "repoProfiles fallback did not map"])
    }

    let fakeProductLicense = "NEONDIFF-1234567890-ABCDE"
    let fakeUnderscoreLicense = "NDL_PRIVATE_1234567890"
    let jsonLicense = "fixture-license-secret-1234567890"
    let redacted = NeonDiffRedactor.redact("token=\(fakeProviderKey)\nlicenseKey=\(fakeProductLicense)\nlicense=\(fakeUnderscoreLicense)\n{\"licenseKey\":\"\(jsonLicense)\"}")
    guard !redacted.contains(fakeProviderKey), !redacted.contains(fakeProductLicense), !redacted.contains(fakeUnderscoreLicense), !redacted.contains(jsonLicense) else {
        throw NSError(domain: "NeonDiffDesktopSmoke", code: 9, userInfo: [NSLocalizedDescriptionKey: "redaction failed"])
    }

    try store.deleteSecret(account: providerAccount)
    try store.deleteSecret(account: licenseAccount)
    print(#"{"ok":true,"keychainRoundTrip":true,"daemonDryRun":true,"fakeStatusParse":true,"fakeConfigParse":true,"repoProfilesFallback":true,"redaction":true}"#)
} catch {
    try? store.deleteSecret(account: providerAccount)
    try? store.deleteSecret(account: licenseAccount)
    fputs(#"{"ok":false,"error":"\#(NeonDiffRedactor.redact(error.localizedDescription))"}"# + "\n", stderr)
    exit(1)
}
