import Foundation
import NeonDiffDesktopCore

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    if condition() {
        return true
    }
    fputs("check failed: \(message)\n", stderr)
    exit(1)
}

var providerFlow = OnboardingFlow()
check(providerFlow.currentStep == .welcome, "flow starts at welcome")
providerFlow.advance()
check(providerFlow.currentStep == .provider, "welcome advances to provider")
check(!providerFlow.canAdvance, "provider step requires a stored provider key")
providerFlow.providerKeyStored = true
check(providerFlow.canAdvance, "provider step advances after key storage")

var publicFlow = OnboardingFlow(providerKeyStored: true)
publicFlow.currentStep = .license
publicFlow.mode = .publicReposOnly
publicFlow.licenseActivation = .servicePending
check(publicFlow.canAdvance, "public repo path can finish while license service is pending")
publicFlow.advance()
check(publicFlow.currentStep == .done, "public repo path finishes from license step")

var privateFlow = OnboardingFlow(providerKeyStored: true)
privateFlow.currentStep = .license
privateFlow.mode = .privateRepos
privateFlow.licenseActivation = .servicePending
check(!privateFlow.canAdvance, "private repo path cannot fake activation while service is pending")
check(privateFlow.licenseActivation != .activated, "pending service is not activated")

var daemonFlow = OnboardingFlow(providerKeyStored: true)
daemonFlow.currentStep = .daemon
check(!daemonFlow.canAdvance, "daemon step requires bootstrap/status check")
daemonFlow.daemonBootstrapChecked = true
check(daemonFlow.canAdvance, "daemon step advances after bootstrap/status check")

let tempRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("neondiff-desktop-core-checks-\(UUID().uuidString)", isDirectory: true)
let packageBin = tempRoot.appendingPathComponent("node_modules/.bin", isDirectory: true)
try FileManager.default.createDirectory(at: packageBin, withIntermediateDirectories: true)
try """
{"name":"neondiff","bin":{"neondiff":"dist/src/cli.js"}}
""".write(to: tempRoot.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
let localCLI = packageBin.appendingPathComponent("neondiff")
try """
#!/usr/bin/env bash
printf '{"command":"%s","args":%d}\\n' "$1" "$#"
""".write(to: localCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: localCLI.path)
defer { try? FileManager.default.removeItem(at: tempRoot) }

let nestedBundleURL = tempRoot
    .appendingPathComponent("apps/neondiff-desktop/dist/NeonDiffDesktop.app", isDirectory: true)
check(
    NeonDiffCLIResolver.findPackageRoot(startingAt: nestedBundleURL)?.standardizedFileURL == tempRoot.standardizedFileURL,
    "CLI resolver discovers the repo package root from a local app bundle path"
)

check(
    NeonDiffCLIResolver.resolveExecutablePath("neondiff", workingDirectory: tempRoot)?.standardizedFileURL == localCLI.standardizedFileURL,
    "local package CLI is preferred over GUI PATH fallback"
)

print("NeonDiffDesktopCoreChecks passed")
