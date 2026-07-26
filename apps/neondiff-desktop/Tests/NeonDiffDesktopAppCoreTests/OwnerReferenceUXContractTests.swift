import Foundation
import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct OwnerReferenceUXContractTests {
    @Test func packagedWordmarkNeverUsesACompiledSwiftPMBuildPath() throws {
        let theme = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Views/NeonDiffTheme.swift")
        )

        let packagedLookup = try #require(theme.range(of: "Bundle.main.url("))
        let swiftPMSiblingLookup = try #require(
            theme.range(of: "Bundle.main.bundleURL.appendingPathComponent(")
        )

        #expect(packagedLookup.lowerBound < swiftPMSiblingLookup.lowerBound)
        #expect(theme.contains(#"let bundleName = "NeonDiffDesktop_NeonDiffDesktop""#))
        #expect(theme.contains(#"withExtension: "bundle""#))
        #expect(theme.contains("return packagedBundle"))
        #expect(!theme.contains("Bundle.module"))
    }

    @Test func setupUsesAnEscapableIntegratedPanelInsteadOfAModalSheet() throws {
        let views = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views", isDirectory: true)
        let content = try sourceBoundaryText(at: views.appendingPathComponent("ContentView.swift"))
        let onboarding = try sourceBoundaryText(at: views.appendingPathComponent("OnboardingWizardView.swift"))

        #expect(content.contains("ReferenceShellLayout("))
        #expect(content.contains("if model.isOnboardingPresented"))
        #expect(content.contains("reservedSetupWidth"))
        #expect(content.contains(".padding(.trailing, reservedSetupWidth)"))
        #expect(content.contains("OnboardingWizardView(model: model)"))
        #expect(content.contains("- ReferenceChromeStrip.height"))
        #expect(content.contains(".frame(height: ReferenceChromeStrip.height)"))
        #expect(!content.contains(".sheet(isPresented: $model.isOnboardingPresented)"))
        #expect(onboarding.contains("neondiff-onboarding-dismiss"))
        #expect(onboarding.contains("neondiff-onboarding-read-only-exit"))
        #expect(onboarding.contains("Continue Later"))
        #expect(!onboarding.contains(".safeAreaInset(edge: .bottom)"))
        #expect(onboarding.contains("private var daemonStep: some View {\n        ScrollView {"))
        #expect(onboarding.contains(".lineLimit(2)"))
        #expect(onboarding.contains(".truncationMode(.tail)"))
        #expect(onboarding.contains("STEP \\(currentStepNumber) OF \\(OnboardingStep.allCases.count)"))
    }

    @MainActor
    @Test func githubReadinessActionReopensTheGitHubStep() {
        let fixture = ModelDependencyFixture()
        fixture.model.onboardingFlow.currentStep = .done

        fixture.model.reopenOnboarding(at: .welcome)

        #expect(fixture.model.isOnboardingPresented)
        #expect(fixture.model.onboardingFlow.currentStep == .welcome)
    }

    @Test func shellAndHomeExposeTheOwnerReferenceHierarchy() throws {
        let views = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views", isDirectory: true)
        let sidebar = try sourceBoundaryText(at: views.appendingPathComponent("SidebarView.swift"))
        let overview = try sourceBoundaryText(at: views.appendingPathComponent("OverviewView.swift"))
        let chrome = try sourceBoundaryText(at: views.appendingPathComponent("ContentView.swift"))
        let theme = try sourceBoundaryText(at: views.appendingPathComponent("NeonDiffTheme.swift"))
        let app = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift")
        )
        let window = try sourceBoundaryText(
            at: sourceBoundaryPackageRoot()
                .appendingPathComponent("Sources/NeonDiffDesktop/Support/NeonWindowConfigurator.swift")
        )

        #expect(sidebar.contains("AI CODE REVIEW SYSTEM"))
        #expect(sidebar.contains("SYSTEM READINESS"))
        #expect(sidebar.contains("CONFIG + SECRETS STAY LOCAL"))
        #expect(sidebar.contains("neondiff-sidebar-readiness"))
        #expect(chrome.contains("ReferenceChromeStrip"))
        #expect(!chrome.contains(".ignoresSafeArea(.container, edges: .top)"))
        #expect(chrome.contains("WindowDragRegion"))
        #expect(!chrome.contains("ChromeCircuitBackdrop"))
        #expect(overview.contains("Ready for your first review"))
        #expect(overview.contains("design: .rounded"))
        for title in ["GITHUB APP", "PROVIDER", "LICENSE", "REPOSITORY"] {
            #expect(overview.contains(title))
        }
        #expect(overview.contains("ReferenceReadinessCard"))
        #expect(overview.contains("model.reopenOnboarding(at: .welcome)"))
        #expect(overview.contains("status: readiness.licenseStatus"))
        #expect(overview.contains(#""PUBLIC · FREE""#))
        #expect(overview.contains("model.currentRepositoryActivationReady"))
        #expect(overview.contains("Config and secrets stay on this Mac"))
        #expect(overview.contains("Model context follows your selected provider"))
        #expect(overview.contains("model.providerVerification?.isVerified == true"))
        #expect(!overview.contains("model.providers.providerKeyStored"))
        #expect(overview.contains(#"systemImage: "link""#))
        #expect(!overview.contains(#"systemImage: "arrow.triangle.branch""#))
        #expect(!overview.contains(#"systemImage: "mark-github""#))
        #expect(theme.contains("@Environment(\\.isEnabled) private var isEnabled"))
        #expect(theme.contains(".opacity(isEnabled ? 1 : 0.38)"))
        #expect(theme.contains("NDBrandWordmark"))
        #expect(!theme.contains("Bundle.module"))
        #expect(theme.contains("Bundle.main"))
        #expect(theme.contains("interfaceBorder"))
        #expect(!theme.contains(".fill(Color.black.opacity(0.38))"))
        #expect(chrome.contains("setupShadowColor"))
        #expect(chrome.contains(#"status: model.isOnboardingPresented ? "SETUP REQUIRED" : model.status.healthState"#))
        #expect(!chrome.contains("Text(updateController.badgeText.uppercased())"))
        #expect(app.contains(#"@AppStorage("neondiff.appearance")"#))
        #expect(app.contains("toggleAppearance"))
        #expect(app.contains("window?.appearance = colorScheme == .dark"))
        #expect(
            FileManager.default.fileExists(
                atPath: sourceBoundaryPackageRoot()
                    .appendingPathComponent("Sources/NeonDiffDesktop/Resources/NeonDiffWordmark.png")
                    .path
            )
        )
        #expect(
            !FileManager.default.fileExists(
                atPath: sourceBoundaryPackageRoot()
                    .appendingPathComponent("Sources/NeonDiffDesktop/Resources/SAIBA-45.ttf")
                    .path
            )
        )
        #expect(window.contains("@Environment(\\.colorScheme)"))
        #expect(window.contains("window.appearance ="))
        #expect(window.contains("referenceChrome.cgColor"))
        #expect(window.contains("window.backgroundColor = referenceChrome"))
        #expect(!window.contains("private let neonGreen"))
    }
}
