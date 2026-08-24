import Darwin
import Foundation
import NeonDiffDesktopAppCore
import Security

enum FoundationTrustedBundledWorker {
    private static let appRequirementText =
        #"anchor apple generic and identifier "com.electricsheephq.NeonDiffDesktop" and certificate leaf[subject.OU] = "TC6MS3T6NN""#
    private static let workerRequirementText =
        #"anchor apple generic and certificate leaf[subject.OU] = "TC6MS3T6NN""#

    static func executionContext(
        bundle: Bundle = .main
    ) -> DesktopLocalBotExecutionContext? {
        DesktopTrustedBundledWorkerContract.executionContext(
            appBundleURL: bundle.bundleURL,
            appSignatureIsValid: validateAppSignature,
            sealedFileIsValid: isSafeSealedWorker
        )
    }

    static func nativeVerificationCapability(
        bundle: Bundle = .main,
        productionBoundary: DesktopProductionBoundary
    ) -> DesktopNativeVerificationCapability {
        DesktopNativeVerificationCapability.resolve(
            productionBoundary: productionBoundary,
            appBundleURL: bundle.bundleURL,
            appSignatureIsValid: validateAppSignature,
            sealedFileIsValid: isSafeSealedWorker
        )
    }

    static func runningProcessIsTrusted(
        _ processIdentifier: Int32,
        bundle: Bundle = .main
    ) -> Bool {
        guard validateAppSignature(bundle.bundleURL),
              processIdentifier > 0,
              let requirement = requirement(workerRequirementText)
        else {
            return false
        }
        let attributes = [
            kSecGuestAttributePid as String:
                NSNumber(value: processIdentifier)
        ] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(
            nil,
            attributes,
            SecCSFlags(),
            &code
        ) == errSecSuccess,
        let code
        else {
            return false
        }
        return SecCodeCheckValidity(
            code,
            SecCSFlags(rawValue: kSecCSStrictValidate),
            requirement
        ) == errSecSuccess
    }

    private static func validateAppSignature(_ bundleURL: URL) -> Bool {
        guard bundleURL.standardizedFileURL.path
            == DesktopTrustedBundledWorkerContract.expectedBundlePath,
              let requirement = requirement(appRequirementText)
        else {
            return false
        }
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(
            bundleURL as CFURL,
            SecCSFlags(),
            &staticCode
        ) == errSecSuccess,
        let staticCode
        else {
            return false
        }
        let flags = SecCSFlags(
            rawValue:
                kSecCSCheckAllArchitectures
                | kSecCSStrictValidate
                | kSecCSCheckNestedCode
        )
        return SecStaticCodeCheckValidity(
            staticCode,
            flags,
            requirement
        ) == errSecSuccess
    }

    private static func requirement(
        _ text: String
    ) -> SecRequirement? {
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(
            text as CFString,
            SecCSFlags(),
            &requirement
        ) == errSecSuccess
        else {
            return nil
        }
        return requirement
    }

    private static func isSafeSealedWorker(_ url: URL) -> Bool {
        let standardized = url.standardizedFileURL
        guard standardized.resolvingSymlinksInPath().path
            == standardized.path
        else {
            return false
        }
        var entry = stat()
        return lstat(standardized.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && (entry.st_mode & 0o022) == 0
            && entry.st_size > 1024 * 1024
            && entry.st_size <= 250 * 1024 * 1024
            && FileManager.default.isExecutableFile(
                atPath: standardized.path
            )
    }
}
