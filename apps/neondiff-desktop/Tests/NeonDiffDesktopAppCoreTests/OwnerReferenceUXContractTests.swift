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

    @Test func canonicalBrandAssetsAreOutlinedAndWiredIntoBothBundlePaths() throws {
        let root = sourceBoundaryPackageRoot()
        let brand = root.appendingPathComponent("Brand", isDirectory: true)
        let resources = root.appendingPathComponent(
            "Sources/NeonDiffDesktop/Resources",
            isDirectory: true
        )
        let sourceFiles = [
            "source/neondiff-wordmark-light-outline.svg",
            "source/neondiff-wordmark-dark-outline.svg",
            "source/neondiff-monogram-light-outline.svg",
            "source/neondiff-monogram-dark-outline.svg"
        ]
        let requiredFiles = sourceFiles + [
            "README.md",
            "PALETTE.json",
            "wordmark/neondiff-wordmark-light-1x.png",
            "wordmark/neondiff-wordmark-light-2x.png",
            "wordmark/neondiff-wordmark-dark-1x.png",
            "wordmark/neondiff-wordmark-dark-2x.png",
            "app-icon/light/neondiff-app-icon-light-1024.png",
            "app-icon/dark/neondiff-app-icon-dark-1024.png",
            "app-icon/NeonDiff.icns",
            "previews/neondiff-logo-system-overview.png",
            "previews/neondiff-macos-small-size-check.png"
        ]

        for relativePath in requiredFiles {
            #expect(sourceBoundaryFileExists(brand.appendingPathComponent(relativePath)))
        }
        for relativePath in sourceFiles {
            let source = try sourceBoundaryText(at: brand.appendingPathComponent(relativePath))
            #expect(!source.contains("<text"))
            #expect(!source.contains("font-family"))
            #expect(!source.contains(".ttf"))
            #expect(!source.contains(".otf"))
        }
        #expect(sourceBoundaryFileExists(resources.appendingPathComponent("NeonDiffWordmark.png")))
        #expect(sourceBoundaryFileExists(resources.appendingPathComponent("NeonDiff.icns")))
        #expect(sourceBoundaryFileExists(resources.appendingPathComponent("NeonDiff-Light.icns")))
        #expect(sourceBoundaryFileExists(resources.appendingPathComponent("NeonDiff-Dark.icns")))
        #expect(!sourceBoundaryFileExists(resources.appendingPathComponent("SAIBA-45.ttf")))
        #expect(!sourceBoundaryFileExists(resources.appendingPathComponent("SAIBA-45.otf")))

        let buildScript = try sourceBoundaryText(
            at: root.appendingPathComponent("script/build_and_run.sh")
        )
        #expect(buildScript.contains("CFBundleIconFile"))
        #expect(buildScript.contains("NeonDiff.icns"))
    }

    @Test func customerFacingReleaseNameIsSimplyNeonDiff() throws {
        let root = sourceBoundaryPackageRoot()
        let app = try sourceBoundaryText(
            at: root.appendingPathComponent(
                "Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift"
            )
        )
        let window = try sourceBoundaryText(
            at: root.appendingPathComponent(
                "Sources/NeonDiffDesktop/Support/NeonWindowConfigurator.swift"
            )
        )
        let content = try sourceBoundaryText(
            at: root.appendingPathComponent(
                "Sources/NeonDiffDesktop/Views/ContentView.swift"
            )
        )
        let project = try sourceBoundaryText(
            at: root.appendingPathComponent("NeonDiffDesktop.xcodeproj/project.pbxproj")
        )
        let bundler = try sourceBoundaryText(
            at: root.appendingPathComponent("script/build_and_run.sh")
        )
        let releaseProof = try sourceBoundaryText(
            at: root.appendingPathComponent("script/release-proof.sh")
        )

        #expect(app.contains(#"WindowGroup("NeonDiff")"#))
        #expect(app.contains(#"Button("Quit NeonDiff")"#))
        #expect(app.contains(#"Button("Close NeonDiff Window")"#))
        #expect(window.contains(#"window.title = "NeonDiff""#))
        #expect(content.contains(#".accessibilityLabel("NeonDiff root")"#))
        #expect(project.contains(#"INFOPLIST_KEY_CFBundleDisplayName = NeonDiff;"#))
        #expect(project.contains(#"INFOPLIST_KEY_CFBundleName = NeonDiff;"#))
        #expect(project.contains(#"PRODUCT_NAME = NeonDiffDesktop;"#))

        #expect(bundler.contains(#"APP_NAME="NeonDiff""#))
        #expect(bundler.contains(#"PRODUCT_NAME="NeonDiffDesktop""#))
        #expect(bundler.contains(#"<string>$PRODUCT_NAME</string>"#))
        #expect(bundler.contains(#"<string>$APP_NAME</string>"#))
        #expect(bundler.contains(#"BUNDLE_ID="com.electricsheephq.NeonDiffDesktop""#))

        #expect(releaseProof.contains(#"APP_NAME="NeonDiff""#))
        #expect(releaseProof.contains(#"EXECUTABLE_NAME="NeonDiffDesktop""#))
        #expect(releaseProof.contains(#"ARTIFACT_NAME="NeonDiff.app.zip""#))
        #expect(releaseProof.contains(#"ditto "$SOURCE_APP_BUNDLE" "$APP_BUNDLE""#))
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

    @Test func existingBotUsesReconciliationInsteadOfCleanSetupOrRawDiagnostics() throws {
        let views = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Views", isDirectory: true)
        let onboarding = try sourceBoundaryText(
            at: views.appendingPathComponent("OnboardingWizardView.swift")
        )
        let repos = try sourceBoundaryText(
            at: views.appendingPathComponent("ReposView.swift")
        )
        let provider = try sourceBoundaryText(
            at: views.appendingPathComponent("ProviderSettingsView.swift")
        )
        let activation = try sourceBoundaryText(
            at: views.appendingPathComponent("ActivationStateView.swift")
        )
        let activity = try sourceBoundaryText(
            at: views.appendingPathComponent("LogsView.swift")
        )
        let settings = try sourceBoundaryText(
            at: views.appendingPathComponent("SettingsPane.swift")
        )

        #expect(onboarding.contains("model.existingLocalBotReconciliationMode"))
        #expect(onboarding.contains("Existing Bot Detected"))
        #expect(onboarding.contains("setup will not initialize or overwrite the config"))
        #expect(onboarding.contains("model.verifyProviderKey()"))
        #expect(onboarding.contains("model.providerVerificationButtonTitle"))
        #expect(onboarding.contains(
            ".disabled(!model.canVerifyProviderKey || !model.productionUsefulWorkAvailable)"
        ))
        #expect(onboarding.contains(
            "if model.managedGitHubAvailable {\n"
                + "                        managedGitHubSection"
        ))
        #expect(onboarding.contains(
            "} else if model.byoGitHubCredentialOnboardingAvailable {\n"
                + "                        byoGitHubSection"
        ))
        #expect(repos.contains("Existing GitHub App Connection"))
        #expect(repos.contains("will not copy, migrate, or ask you to re-enter"))
        #expect(repos.contains(
            "if model.managedGitHubAvailable {\n"
                + "                    managedGitHubConnection"
        ))
        #expect(repos.contains(
            "} else if model.byoGitHubCredentialOnboardingAvailable {\n"
                + "                    byoGitHubCredentials"
        ))
        #expect(repos.contains("neondiff-existing-byo-github-verify"))
        #expect(repos.contains("model.verifyBYOGitHubAppCredentials()"))
        #expect(repos.contains("model.existingLocalBotBYOGitHubVerificationStatus"))
        #expect(provider.contains("model.selectedProviderRequiresAPIKey"))
        #expect(provider.contains("APP CONFIG LOADED"))
        #expect(provider.contains(
            "if model.selectedProviderRequiresAPIKey {\n"
                + "                        Text(model.providerVerificationStatus)"
        ))
        #expect(provider.contains(
            "if model.selectedProviderRequiresAPIKey,\n"
                + "                       let verification = model.providerVerification"
        ))
        #expect(activation.contains("neondiff.activation.existing-account"))
        #expect(activation.contains("model.existingAccountEntitlementSummaryReady"))
        #expect(activation.contains("model.existingAccountEntitlementNeedsCurrentAccessVerification"))
        #expect(activation.contains("Review repository access"))
        #expect(activation.contains("model.reviewExistingBotRepositoryAccess()"))
        #expect(activity.contains("OperatorSection(\"Current Activity\")"))
        #expect(activity.contains("model.githubSetupReady"))
        #expect(activity.contains("GitHub connection ready"))
        #expect(activity.contains("DisclosureGroup"))
        #expect(activity.contains("// ADVANCED DIAGNOSTICS"))
        #expect(settings.contains("Signed update, rollback, and installed-app proof"))
        #expect(!settings.contains("This dev build"))
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
        #expect(sidebar.contains("Menu"))
        #expect(sidebar.contains("neondiff-account-menu"))
        #expect(sidebar.contains("neondiff-account-option-"))
        #expect(sidebar.contains("neondiff-bot-option-"))
        #expect(sidebar.contains("THIS MAC"))
        #expect(sidebar.contains("accountStatus.uppercased()"))
        #expect(sidebar.contains("NEW BOT"))
        #expect(sidebar.contains("neondiff-new-bot"))
        #expect(sidebar.contains("Button {\n            isAccountPopoverPresented.toggle()"))
        #expect(sidebar.contains(".popover(isPresented: $isAccountPopoverPresented"))
        #expect(sidebar.contains(".accessibilityValue(selectedAccountName ?? \"No account selected\")"))
        #expect(sidebar.contains("ScrollView {\n                    VStack(alignment: .leading, spacing: 8)"))
        #expect(sidebar.contains(".frame(maxHeight: 360)"))
        #expect(sidebar.components(separatedBy: "isAccountPopoverPresented = false").count == 4)
        #expect(sidebar.contains("}\n            .frame(maxWidth: .infinity, alignment: .leading)\n            .contentShape(Rectangle())\n        }\n        .buttonStyle(.plain)"))
        #expect(!sidebar.contains(".accessibilityHidden(true)"))
        #expect(sidebar.contains("SYSTEM READINESS"))
        #expect(sidebar.contains("CONFIG + SECRETS STAY LOCAL"))
        #expect(sidebar.contains("neondiff-sidebar-readiness"))
        #expect(chrome.contains("ReferenceChromeStrip"))
        #expect(!chrome.contains(".ignoresSafeArea(.container, edges: .top)"))
        #expect(chrome.contains("WindowDragRegion"))
        #expect(!chrome.contains("ChromeCircuitBackdrop"))
        #expect(overview.contains("Ready for a dry run"))
        #expect(overview.contains("Existing bot configured"))
        #expect(overview.contains("design: .rounded"))
        for title in ["GITHUB APP", "PROVIDER", "LICENSE", "REPOSITORY"] {
            #expect(overview.contains(title))
        }
        #expect(overview.contains("ReferenceReadinessCard"))
        #expect(overview.contains("model.reopenOnboarding(at: .welcome)"))
        #expect(overview.contains("status: readiness.licenseStatus"))
        #expect(overview.contains(#""PUBLIC · FREE""#))
        #expect(overview.contains("model.licenseSetupReady"))
        #expect(overview.contains("model.productionUsefulWorkAvailable"))
        #expect(overview.contains(
            "canRunDryRun = model.productionUsefulWorkAvailable\n"
                + "            && model.providerSetupReady"
        ))
        #expect(overview.contains("Config and secrets stay on this Mac"))
        #expect(overview.contains("Model context follows your selected provider"))
        #expect(overview.contains("model.providerSetupReady"))
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
