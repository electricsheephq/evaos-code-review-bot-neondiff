import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct ProductionBoundaryContractTests {
    @MainActor
    @Test func quarantinedProductionModelBlocksUsefulWorkAndPseudoActivation() throws {
        let fixture = ModelDependencyFixture(productionBoundary: .quarantined)
        fixture.model.pendingLicenseKey = "fixture-license-value"

        fixture.model.previewStartDaemon()
        fixture.model.startDaemon()
        fixture.model.verifyProviderKey()
        fixture.model.storeLicenseKey()
        fixture.model.activateLicenseForOnboarding()
        fixture.model.completeOnboarding()

        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.providerVerifier.calls.isEmpty)
        #expect(!fixture.secretStore.containsSecret(account: "license/default"))
        #expect(fixture.model.onboardingFlow.licenseActivation != .activated)
        #expect(fixture.model.isOnboardingPresented)
        #expect(fixture.model.lastError?.contains("activation broker") == true)
    }

    @Test func sourceBoundaryHelpersRejectDirectoriesNamedLikeSwiftFiles() throws {
        try withSourceBoundaryDirectoryFixture { root, fakeSource in
            #expect(sourceBoundarySwiftFiles(below: root).isEmpty)
            #expect(!sourceBoundaryFileExists(fakeSource))
        }
    }

    @Test func appCoreContainsNoExecutableOnlyOSDependencies() throws {
        let appCoreDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktopAppCore", isDirectory: true)
        let sourceFiles = sourceBoundarySwiftFiles(below: appCoreDirectory)

        #expect(!sourceFiles.isEmpty)

        let forbiddenTokens = [
            "import AppKit",
            "import SwiftUI",
            "import Sparkle",
            "import Security",
            "import XCTest",
            "NSPasteboard",
            "NSWorkspace",
            "FileManager.default",
            "UserDefaults.standard",
            "Task.sleep",
            "Date()",
            "NeonDiffCLIClient(",
            "ProviderVerificationService("
        ]

        for sourceFile in sourceFiles {
            let source = try sourceBoundaryText(at: sourceFile)
            for forbiddenToken in forbiddenTokens {
                #expect(!source.contains(forbiddenToken), Comment("\(sourceFile.lastPathComponent) contains \(forbiddenToken)"))
            }
        }
    }

    @Test func productionAdaptersExistOnlyInExecutableTarget() throws {
        let executableAdaptersDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Adapters", isDirectory: true)
        let appCoreDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktopAppCore", isDirectory: true)
        let appCoreFileNames = sourceBoundarySwiftFiles(below: appCoreDirectory)
            .map(\.lastPathComponent)
        let adapterNames = [
            "AppKitClipboard",
            "AppKitURLOpener",
            "FoundationDesktopCLIExecutor",
            "FoundationDesktopDashboardLauncher",
            "UserDefaultsDesktopPreferences",
            "ContinuousDesktopClock",
            "ApplicationSupportFileWriter",
            "FoundationProviderVerifier"
        ]

        for adapterName in adapterNames {
            let executableAdapter = executableAdaptersDirectory
                .appendingPathComponent("\(adapterName).swift")

            #expect(sourceBoundaryFileExists(executableAdapter))
            #expect(!appCoreFileNames.contains("\(adapterName).swift"))
        }
    }

    @Test func updaterCannotStartBeforeNativeActivationBrokerProof() throws {
        let updaterSource = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Support/NeonUpdateController.swift")
        let source = try sourceBoundaryText(at: updaterSource)

        #expect(!source.contains("SPUStandardUpdaterController"))
        #expect(!source.contains("startingUpdater"))
        #expect(source.contains("Updates blocked pending native activation proof"))
    }
}
