import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct ProductionBoundaryContractTests {
    @MainActor
    @Test func quarantinedProductionModelBlocksUsefulWorkAndPseudoActivation() throws {
        let fixture = ModelDependencyFixture(productionBoundary: .quarantined)
        fixture.model.pendingLicenseKey = "fixture-license-value"

        fixture.model.previewStartDaemon()
        fixture.model.previewStopDaemon()
        fixture.model.startDaemon()
        fixture.model.stopDaemon()
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

    @MainActor
    @Test func quarantineIgnoresLegacyCompletionAndOffersNonPersistentReadOnlyEscape() throws {
        let fixture = ModelDependencyFixture(
            preferenceBools: ["neondiff.hasCompletedOnboarding": true],
            productionBoundary: .quarantined
        )

        #expect(fixture.model.isOnboardingPresented)
        fixture.model.openReadOnlyAppFromQuarantinedOnboarding()
        #expect(!fixture.model.isOnboardingPresented)
        #expect(fixture.preferences.bool(forKey: "neondiff.hasCompletedOnboarding"))
        #expect(!fixture.preferences.bool(forKey: "neondiff.hasCompletedActivationOnboarding.v2"))
        #expect(fixture.model.logText.contains("read-only setup surface"))
        #expect(fixture.model.logText.contains("Native activation broker proof is not available"))
    }

    @MainActor
    @Test func verifiedActivationCompletionWritesOnlyTheVersionedProofStamp() throws {
        let fixture = ModelDependencyFixture(productionBoundary: .testVerified)
        fixture.model.onboardingFlow.licenseActivation = .activated

        fixture.model.completeOnboarding()

        #expect(!fixture.model.isOnboardingPresented)
        #expect(fixture.preferences.bool(forKey: "neondiff.hasCompletedActivationOnboarding.v2"))
        #expect(!fixture.preferences.bool(forKey: "neondiff.hasCompletedOnboarding"))
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

    @Test func productionCompositionRootResolvesOnlyTheSignedBuildBoundary() throws {
        let compositionRoot = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/App/NeonDiffDesktopCompositionRoot.swift")
        let source = try sourceBoundaryText(at: compositionRoot)

        #expect(source.contains("DesktopProductionBoundary.resolve("))
        #expect(source.contains("Bundle.main.infoDictionary ?? [:]"))
        #expect(source.contains("GitHubBrokerClient(baseURL: $0)"))
        #expect(source.contains("productionBoundary: productionBoundary"))
        #expect(!source.contains("productionBoundary: .testVerified"))
        #expect(!source.contains("productionBoundary: .testManaged"))
    }

    @Test func evaluationRootIdentifierDoesNotOverrideDescendantActionIdentifiers() throws {
        let contentView = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views/ContentView.swift")
        let source = try sourceBoundaryText(at: contentView)

        #expect(source.contains("EvaluationRootAccessibilityMarker(identifier: rootAccessibilityIdentifier)"))
        #expect(source.contains("private struct EvaluationRootAccessibilityMarker: View"))
        #expect(source.contains(".accessibilityIdentifier(identifier)"))
        #expect(!source.contains(".accessibilityIdentifier(rootAccessibilityIdentifier)"))
    }

    @Test func managedOnboardingExposesRepositoryApplyAction() throws {
        let onboardingView = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views/OnboardingWizardView.swift")
        let source = try sourceBoundaryText(at: onboardingView)

        #expect(source.contains("model.applyRepoAllowlistPatch()"))
        #expect(source.contains("neondiff-onboarding-repository-apply"))
    }

    @Test func managedSafetyStopIsNotDisabledByUsefulWorkProofLoss() throws {
        let viewsDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views", isDirectory: true)
        let source = try ["OverviewView.swift", "OnboardingWizardView.swift"]
            .map { try sourceBoundaryText(at: viewsDirectory.appendingPathComponent($0)) }
            .joined(separator: "\n")

        #expect(source.contains("model.productionDaemonStopAvailable"))
        #expect(!source.contains("Button { model.stopDaemon() } label:")
            || source.contains(".disabled(!model.productionDaemonStopAvailable)"))
    }
}
