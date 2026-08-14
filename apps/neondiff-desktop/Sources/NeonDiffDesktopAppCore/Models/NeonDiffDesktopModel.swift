import Combine
import Foundation
import NeonDiffDesktopCore

#if DEBUG
package struct DesktopModelInitialState {
    package let selectedSection: DesktopSection
    package let configPath: String
    package let cliPath: String
    package let status: DaemonStatus
    package let repos: [RepoMonitor]
    package let providers: ProviderSettings
    package let license: LicenseStatus
    package let github: GitHubConnectionStatus
    package let githubAuthorizationStatus: String
    package let logText: String
    package let onboardingFlow: OnboardingFlow
    package let isOnboardingPresented: Bool
    package let providerVerification: ProviderVerificationSnapshot?
    package let providerVerificationStatus: String
    package let providerConfigurationIsDirty: Bool
    package let providerVerificationInProgress: Bool

    package init(
        selectedSection: DesktopSection,
        configPath: String,
        cliPath: String,
        status: DaemonStatus,
        repos: [RepoMonitor],
        providers: ProviderSettings,
        license: LicenseStatus,
        github: GitHubConnectionStatus,
        githubAuthorizationStatus: String,
        logText: String,
        onboardingFlow: OnboardingFlow,
        isOnboardingPresented: Bool,
        providerVerification: ProviderVerificationSnapshot?,
        providerVerificationStatus: String,
        providerConfigurationIsDirty: Bool = false,
        providerVerificationInProgress: Bool = false
    ) {
        self.selectedSection = selectedSection
        self.configPath = configPath
        self.cliPath = cliPath
        self.status = status
        self.repos = repos
        self.providers = providers
        self.license = license
        self.github = github
        self.githubAuthorizationStatus = githubAuthorizationStatus
        self.logText = logText
        self.onboardingFlow = onboardingFlow
        self.isOnboardingPresented = isOnboardingPresented
        self.providerVerification = providerVerification
        self.providerVerificationStatus = providerVerificationStatus
        self.providerConfigurationIsDirty = providerConfigurationIsDirty
        self.providerVerificationInProgress = providerVerificationInProgress
    }
}
#endif

package enum ManagedGitHubConnectionState: Equatable, Sendable {
    case quarantined
    case disconnected
    case verificationRequired
    case connecting
    case awaitingAuthorization
    case installationSelectionRequired
    case bound(installationId: Int)
    case failed
}

package struct ManagedGitHubInstallationCandidate: Identifiable, Equatable, Sendable {
    package var id: Int { installationId }
    package let installationId: Int
    package let account: String
    package let repositoryCount: Int
}

@MainActor
package final class NeonDiffDesktopModel: ObservableObject {
    @Published package var selectedSection: DesktopSection = .overview
    @Published package var configPath: String {
        didSet {
            guard configPath != oldValue else { return }
            pendingRemovedRepoProfileNames.removeAll()
            selectedBYOReviewRepository = nil
            invalidateRepoApplicationProof()
            invalidateProviderConfigAuthorization()
            invalidateProviderVerificationContext()
            invalidateBYOGitHubVerificationContext()
            invalidateLocalWorkerReviewCompatibility()
            invalidateActivationForRepositoryChange()
        }
    }
    @Published package var cliPath: String {
        didSet {
            guard cliPath != oldValue else { return }
            invalidateProviderVerificationContext()
            invalidateBYOGitHubVerificationContext()
            invalidateLocalWorkerReviewCompatibility()
        }
    }
    @Published package var launchdLabel: String
    @Published package var status: DaemonStatus = .unknown
    @Published package private(set) var statusRefreshFailureMessage: String?
    @Published package var repos: [RepoMonitor] = [] {
        didSet {
            let oldAllowlist = oldValue.filter(\.enabled).map(\.name).sorted()
            let newAllowlist = repos.filter(\.enabled).map(\.name).sorted()
            guard oldAllowlist != newAllowlist else { return }
            invalidateRepoApplicationProof()
            invalidateBYOGitHubVerificationContext()
            invalidateActivationForRepositoryChange()
            reconcileBYOReviewRepository(enabledRepositories: newAllowlist)
        }
    }
    @Published package var providers = ProviderSettings() {
        didSet {
            guard providers != oldValue else { return }
            if providers.selectedProviderId != oldValue.selectedProviderId {
                refreshSelectedProviderKeyState()
            }
            invalidateProviderVerificationContext()
        }
    }
    @Published package var license = LicenseStatus()
    @Published package var controlCenter = DesktopControlCenterSettings()
    @Published package var controlCenterStatus = "Load current config before editing."
    @Published package var isControlCenterOperationInProgress = false
    @Published package private(set) var isConfigInitializationInProgress = false
    @Published package private(set) var configInitializationStatus = "Initialize a local config once on a clean install. Existing configs are never overwritten."
    @Published package var isConfigPatchInProgress = false
    @Published package var isConfigInspectInProgress = false
    @Published package var pendingIssueRepoName = ""
    @Published package var github = GitHubConnectionStatus()
    @Published package var githubAuthorizationCode: GitHubDeviceAuthorizationCode?
    @Published package var githubAuthorizationStatus = "not connected"
    @Published package var githubRecovery: GitHubConnectionRecovery?
    @Published package var discoveredGitHubRepos: [GitHubDiscoveredRepository] = []
    @Published package var isGitHubAuthorizationInProgress = false
    @Published package var isGitHubRepositoryRefreshInProgress = false
    @Published package var managedGitHubConnectionState: ManagedGitHubConnectionState = .quarantined
    @Published package var managedGitHubRepositories: [GitHubBrokerRepository] = []
    private var managedGitHubRepositoriesVerifiedAt: Date?
    @Published package var managedGitHubInstallationCandidates: [ManagedGitHubInstallationCandidate] = []
    @Published package var selectedManagedGitHubRepository: String?
    @Published package private(set) var selectedBYOReviewRepository: String?
    @Published package var managedGitHubRecovery: GitHubConnectionRecovery?
    @Published package var isManagedGitHubConnectionInProgress = false
    @Published package var pendingBYOGitHubAppId = ""
    @Published package var pendingBYOGitHubAppPrivateKey = ""
    @Published package private(set) var byoGitHubPrivateKeyStored = false
    @Published package private(set) var byoGitHubCredentialsVerified = false
    @Published package private(set) var isBYOGitHubVerificationInProgress = false
    @Published package private(set) var byoGitHubCredentialStatus = "Customer-owned GitHub App credentials are not stored."
    @Published package var pendingReviewPullNumber = "" {
        didSet {
            guard pendingReviewPullNumber != oldValue else { return }
            invalidateScopedReviewApproval()
        }
    }
    @Published package private(set) var isScopedReviewInProgress = false
    @Published package private(set) var scopedDryRunHeadSHA: String?
    @Published package private(set) var scopedReviewStatus = "Verify current access before running a dry review."
    @Published package private(set) var localWorkerReviewCompatibility: DesktopLocalWorkerReviewCompatibility = .unknown
    @Published package private(set) var currentLocalWorkerExecutionContexts:
        [DesktopLocalBotExecutionContext] = []
    @Published package private(set) var currentLocalBotConfigurations:
        [DesktopLocalBotConfiguration] = []
    @Published package private(set) var currentLocalBotExecutionConfigPaths:
        [String] = []
    @Published package private(set)
        var isKeychainWorkerLaunchAgentOperationInProgress = false
    @Published package private(set) var keychainWorkerLaunchAgentStatus =
        "Install and start the local review worker when setup is ready."
    package var localWorkerExecutionContextProvider:
        (@MainActor () -> [DesktopLocalBotExecutionContext])?
    @Published package var logText = "No logs loaded."
    @Published package var lastError: String?
    @Published package var lastCommandLine = ""
    @Published package var dashboardLaunchStatus = "not opened"
    @Published package var dashboardProcessIdentifier: Int32?
    @Published package var pendingRepoName = ""
    @Published package var pendingProviderKey = ""
    @Published package var providerVerification: ProviderVerificationSnapshot?
    @Published package var providerVerificationStatus = "Verify the stored API key when ready."
    @Published package var isProviderVerificationInProgress = false
    @Published package var isProviderVerificationCancelling = false
    @Published package private(set) var providerVerificationSafetyLatchMessage: String?
    @Published package var pendingLicenseKey = ""
    @Published package var onboardingFlow = OnboardingFlow()
    @Published package var isOnboardingPresented = false
    @Published package var accountWorkspaceCatalog: DesktopAccountWorkspaceCatalog = .idle
    @Published package private(set) var accountWorkspaceSelection = DesktopAccountWorkspaceSelection()
    @Published package private(set) var accountWorkspaceStatus = "Sign in to load your personal and organization accounts."
    @Published package private(set) var isAccountLinkInProgress = false
    @Published package private(set) var isAutomaticAccountWorkspaceRefreshInProgress = false
    @Published package private(set) var pendingNewBotPlan: DesktopNewBotPlan?

    // Issue #612 — native purchase-to-activation state. Restored from preferences
    // (its raw value) so onboarding resumes exactly across relaunch / cancel /
    // network loss (AC6). No Keychain read happens on the launch path; the
    // activation key is read lazily only when the user activates.
    @Published package var activationState: ActivationState = ActivationStateMachine.initialState
    @Published package private(set) var activationKeyRedactedPrefix: String?
    @Published package var pendingActivationKey = ""
    @Published package private(set) var activationVerifiedThisLaunch = false {
        didSet {
            if !activationVerifiedThisLaunch {
                activationUpdateEntitlementThisLaunch = false
                activationUpdateAuthorityVerifiedAt = nil
                activationUpdateAuthorityValidUntil = nil
            }
        }
    }
    private var activationUpdateEntitlementThisLaunch = false
    private var activationUpdateAuthorityVerifiedAt: Date?
    private var activationUpdateAuthorityValidUntil: Date?
    private var accountWorkspaceCatalogVerifiedAt: Date?
    private var activationVerifiedRepositoryThisLaunch: String?
    private var appliedRepoSelection: AppliedRepoSelection?
    private var scopedReviewTask: Task<Void, Never>?
    private var scopedDryRunApproval: ScopedReviewApproval?

    package var productionActivationBoundaryMessage: String {
        "Native activation broker proof is not available in this build. Provider verification, daemon control, updates, and onboarding completion remain blocked."
    }

    package var customerRuntimeBoundaryMessage: String {
        if byoGitHubCredentialOnboardingAvailable,
           repos.filter(\.enabled).count > 1,
           !reviewTargetRuntimeReady {
            let target = selectedBYOReviewRepository.map {
                "Activation can be verified for \($0), but "
            } ?? "Choose one Review Target for activation. "
            return "\(target)the existing worker still monitors multiple repositories. Native useful-work controls remain blocked until the runtime can be scoped without rewriting that worker."
        }
        if existingLocalBotSetupReady {
            return "Existing setup is configured. Before new work, reverify the current GitHub App access and repository-scoped entitlement for this launch."
        }
        if existingLocalBotIdentityReady {
            return "Existing bot identity is matched. Finish or recover the missing setup items, then reverify the current GitHub App access and repository-scoped entitlement before new work."
        }
        return productionActivationBoundaryMessage
    }

    package var currentRepositoryActivationReady: Bool {
        guard activationVerifiedThisLaunch,
              activationState == .active,
              let activationVerifiedRepositoryThisLaunch,
              let selectedReviewRepository
        else {
            return false
        }
        return selectedReviewRepository.lowercased()
            == activationVerifiedRepositoryThisLaunch.lowercased()
    }

    /// The repository the native app will activate. Existing BYO workers may
    /// monitor many repositories; choosing this target must never collapse or
    /// rewrite that worker allowlist. Runtime review scoping is a separate gate.
    package var selectedReviewRepository: String? {
        if managedGitHubAvailable {
            return selectedManagedGitHubRepository
        }
        if byoGitHubCredentialOnboardingAvailable {
            return selectedBYOReviewRepository
        }
        return uniqueSortedRepoNames(
            repos.filter(\.enabled).map(\.name)
        ).onlyElement
    }

    package var activationTargetSelectionRequired: Bool {
        byoGitHubCredentialOnboardingAvailable
            && selectedBYOReviewRepository == nil
            && repos.filter(\.enabled).count > 1
    }

    package var reviewTargetRuntimeReady: Bool {
        guard byoGitHubCredentialOnboardingAvailable else {
            return true
        }
        let enabledRepositories = uniqueSortedRepoNames(
            repos.filter(\.enabled).map(\.name)
        )
        guard let selectedBYOReviewRepository else {
            return false
        }
        let selectedTargetIsEnabled = enabledRepositories.contains {
            $0.caseInsensitiveCompare(
                selectedBYOReviewRepository
            ) == .orderedSame
        }
        guard selectedTargetIsEnabled else {
            return false
        }
        if enabledRepositories.count == 1 {
            return true
        }
        return existingLocalBotIdentityReady
            && selectedAccountWorkspace?.entitlement == .internalAdmin
    }

    /// Existing-account entitlement is useful setup context, but it must not
    /// replace the recovery control for a managed private/internal repository.
    /// Public managed repositories need no paid activation; every other beta
    /// path keeps the repository-scoped current-launch proof visible.
    package var existingAccountEntitlementSummaryReady: Bool {
        guard existingLocalBotIdentityReady,
              selectedAccountEntitlementSupportsCurrentPath
        else {
            return false
        }
        if managedGitHubAvailable {
            guard let selectedManagedGitHubRepository,
                  let repository = managedGitHubRepositories.first(where: {
                      $0.fullName == selectedManagedGitHubRepository
                  })
            else {
                return false
            }
            switch repository.visibility {
            case .public:
                return true
            case .private, .internal:
                return currentRepositoryActivationReady
            case .unknown:
                return false
            }
        }
        if byoGitHubCredentialOnboardingAvailable {
            return repositoryConfigurationReady
                && currentRepositoryActivationReady
        }
        return true
    }

    private var selectedAccountEntitlementSupportsCurrentPath: Bool {
        guard let accountEntitlement = selectedAccountWorkspace?.entitlement
        else {
            return false
        }
        switch accountEntitlement {
        case .paid, .internalAdmin, .trial:
            return true
        case .publicFree:
            guard managedGitHubAvailable,
                  let selectedManagedGitHubRepository,
                  let repository = managedGitHubRepositories.first(where: {
                      $0.fullName == selectedManagedGitHubRepository
                  })
            else {
                return false
            }
            return repository.visibility == .public
        case .none:
            return false
        }
    }

    /// The selected existing bot has server-authoritative account entitlement,
    /// but current-launch repository access still needs proof. This is a
    /// customer-facing recovery state only; it never unlocks useful work.
    package var existingAccountEntitlementNeedsCurrentAccessVerification: Bool {
        guard existingLocalBotIdentityReady,
              selectedAccountEntitlementSupportsCurrentPath
        else {
            return false
        }
        return !existingAccountEntitlementSummaryReady
    }

    package var productionUsefulWorkAvailable: Bool {
        guard dependencies.productionBoundary.nativeActivationBrokerVerified else {
            return false
        }
        guard !isSetupMutationBlocked else {
            return false
        }
        guard !isConfigPatchInProgress else {
            return false
        }
        if dependencies.productionBoundary.byoGitHubEnabled {
            if existingLocalBotReconciliationMode {
                guard selectedAccountEntitlementSupportsCurrentPath else {
                    return false
                }
            }
            guard byoGitHubCredentialOnboardingAvailable,
                  byoGitHubCredentialsVerified,
                  repositoryConfigurationReady,
                  currentRepositoryActivationReady,
                  scopedReviewTargetReady
            else { return false }
        }
        guard dependencies.productionBoundary.managedGitHubBrokerOrigin != nil else {
            return true
        }
        guard hasVerifiedManagedGitHubSelection,
              let selectedManagedGitHubRepository,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == selectedManagedGitHubRepository
              })
        else {
            return false
        }
        guard appliedRepoSelection == AppliedRepoSelection(
            repositories: [selectedManagedGitHubRepository],
            configPath: configPath
        ) else {
            return false
        }
        switch repository.visibility {
        case .public:
            return true
        case .private, .internal:
            return activationVerifiedThisLaunch
                && activationState == .active
                && activationVerifiedRepositoryThisLaunch == selectedManagedGitHubRepository
        case .unknown:
            return false
        }
    }

    /// A scoped `review-pr` command always carries one exact repository and PR.
    /// It can therefore use an explicitly selected repository from an existing
    /// multi-repository worker without widening or rewriting that worker.
    package var scopedReviewTargetReady: Bool {
        guard let selectedReviewRepository else { return false }
        return repos.contains {
            $0.enabled
                && $0.name.caseInsensitiveCompare(selectedReviewRepository)
                    == .orderedSame
        }
    }

    /// Starting the long-running daemon remains stricter than one scoped
    /// review. Customer BYO workers require one enabled repository. A verified
    /// existing internal-admin bot may retain its existing multi-repository
    /// allowlist while the current activation remains bound to one selected
    /// review target.
    package var productionDaemonStartAvailable: Bool {
        productionUsefulWorkAvailable
            && reviewTargetRuntimeReady
            && scopedReviewProviderReady
            && !isKeychainWorkerLaunchAgentOperationInProgress
            && (
                !dependencies.productionBoundary.byoGitHubEnabled
                    || existingLocalAgentAccessAvailable
                    || keychainWorkerLaunchAgentInstallAvailable
            )
    }

    package var keychainWorkerLaunchAgentInstallAvailable: Bool {
        dependencies.productionBoundary.byoGitHubEnabled
            && byoGitHubCredentialsStored
            && byoGitHubCredentialsVerified
            && storedBYOGitHubAppId != nil
            && localWorkerCLIAvailable
            && !isKeychainWorkerLaunchAgentOperationInProgress
    }

    package var daemonStartActionTitle: String {
        existingLocalAgentAccessAvailable
            ? "Start/Restart"
            : "Install & Start"
    }

    private var keychainWorkerLaunchAgentActive: Bool {
        guard matchingLocalBotConfigurationAvailable else { return false }
        return currentLocalWorkerExecutionContexts.contains { context in
            normalizedPath(context.configPath) == normalizedPath(configPath)
                && context.environmentOverrides.isEmpty
        }
    }

    package var scopedLiveReviewConfirmationAvailable: Bool {
        guard scopedReviewExecutionAvailable,
              !isScopedReviewInProgress,
              let approval = scopedDryRunApproval,
              let pullNumber = positivePendingReviewPullNumber,
              let selectedReviewRepository
        else {
            return false
        }
        return approval.repo.caseInsensitiveCompare(selectedReviewRepository)
                == .orderedSame
            && approval.pullNumber == pullNumber
            && approval.configPath == configPath
            && approval.configRevision == providerLoadedRevision
            && approval.workspaceGeneration == workspaceContextGeneration
            && isValidGitHubCommitSHA(approval.headSHA)
    }

    package var scopedReviewExecutionAvailable: Bool {
        productionUsefulWorkAvailable
            && existingLocalAgentAccessAvailable
            && localWorkerReviewCompatibility.isCompatible
            && scopedReviewProviderReady
    }

    package var localWorkerReviewUpdateRequired: Bool {
        localWorkerReviewCompatibility == .incompatible
    }

    package var localWorkerReviewCompatibilityCheckAvailable: Bool {
        existingLocalAgentAccessAvailable
            && localWorkerReviewCompatibility != .checking
            && !isScopedReviewInProgress
    }

    /// Resolve only the configured executable through the same fixed desktop
    /// resolver used by the production CLI client. An exact existing-agent
    /// execution context is already discovery-proven and remains eligible.
    package var localWorkerCLIAvailable: Bool {
        existingLocalAgentAccessAvailable
            || DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: cliPath,
                arguments: ["init", "--config", configPath],
                executionContexts: currentLocalWorkerExecutionContexts
            ) != nil
            || NeonDiffCLIResolver.resolveExecutablePath(
                cliPath,
                workingDirectory: dependencies.cliWorkingDirectory
            ) != nil
    }

    package var localWorkerCLIStatus: String {
        localWorkerCLIAvailable
            ? "Local worker command is available."
            : "Local worker command \(cliPath) is unavailable. Install the version-matched worker before continuing."
    }

    /// Stopping an already-running daemon is a safety remediation, not useful
    /// review work. Keep it available for a verified production build even if
    /// the current repository binding or entitlement proof has been revoked.
    package var productionDaemonStopAvailable: Bool {
        dependencies.productionBoundary.nativeActivationBrokerVerified
    }

    package var incompleteOnboardingEscapeAvailable: Bool {
        isOnboardingPresented
            && !dependencies.preferences.bool(forKey: onboardingCompletedKey)
    }

    /// Customer-facing repository readiness is intentionally stricter than
    /// selection. Managed repositories become ready only after the exact
    /// broker-authorized selection has been applied and read back from the
    /// active config path. BYO builds require verified credentials plus an
    /// enabled repository.
    package var repositoryConfigurationReady: Bool {
        let enabledRepositories = uniqueSortedRepoNames(
            repos.filter(\.enabled).map(\.name)
        )
        guard !enabledRepositories.isEmpty else { return false }

        if managedGitHubAvailable {
            guard hasVerifiedManagedGitHubSelection,
                  let selectedManagedGitHubRepository
            else {
                return false
            }
            return appliedRepoSelection == AppliedRepoSelection(
                repositories: [selectedManagedGitHubRepository],
                configPath: configPath
            )
        }

        if byoGitHubCredentialOnboardingAvailable {
            return byoGitHubCredentialsVerified
                && appliedRepoSelection == AppliedRepoSelection(
                    repositories: enabledRepositories,
                    configPath: configPath
                )
        }

        return appliedRepoSelection == AppliedRepoSelection(
            repositories: enabledRepositories,
            configPath: configPath
        )
    }

    package var managedGitHubAvailable: Bool {
        dependencies.productionBoundary.managedGitHubBrokerOrigin != nil
            && dependencies.githubBroker != nil
    }

    package var byoGitHubCredentialOnboardingAvailable: Bool {
        dependencies.productionBoundary.byoGitHubEnabled
            && dependencies.productionBoundary.managedGitHubBrokerOrigin == nil
    }

    package var byoGitHubAppIdStored: Bool {
        storedBYOGitHubAppId != nil
    }

    package var byoGitHubCredentialsStored: Bool {
        byoGitHubCredentialOnboardingAvailable
            && byoGitHubAppIdStored
            && byoGitHubPrivateKeyStored
    }

    package var existingLocalBotBYOGitHubVerificationAvailable: Bool {
        if existingLocalAgentAccessAvailable {
            return true
        }
        guard existingLocalBotIdentityReady,
              byoGitHubCredentialOnboardingAvailable,
              byoGitHubPrivateKeyStored,
              let bot = selectedBotInstallation,
              let storedAppID = storedBYOGitHubAppId
        else {
            return false
        }
        return storedAppID == String(bot.appID)
    }

    package var existingLocalBotCurrentAccessVerified: Bool {
        existingLocalAgentAccessAvailable
            && byoGitHubCredentialsVerified
            && currentRepositoryActivationReady
    }

    package var existingLocalAgentAccessAvailable: Bool {
        guard existingLocalBotIdentityReady,
              byoGitHubCredentialOnboardingAvailable,
              cliPath == "neondiff",
              matchingLocalBotConfigurationAvailable
        else {
            return false
        }
        return currentLocalBotExecutionConfigPaths.contains { path in
            normalizedPath(path) == normalizedPath(configPath)
        }
    }

    private var matchingLocalBotConfigurationAvailable: Bool {
        guard let bot = selectedBotInstallation else { return false }
        return currentLocalBotConfigurations.contains { configuration in
            configuration.appID == bot.appID
                && normalizedPath(configuration.configPath)
                    == normalizedPath(configPath)
        }
    }

    package var existingLocalBotBYOGitHubVerificationStatus: String {
        guard existingLocalBotIdentityReady,
              let bot = selectedBotInstallation
        else {
            return "The selected existing bot identity is not verified for this local config."
        }
        if existingLocalAgentAccessAvailable {
            return byoGitHubCredentialsVerified
                ? byoGitHubCredentialStatus
                : "The exact existing local agent is ready for current-access verification. Its private key will not be copied or printed."
        }
        if cliPath != "neondiff" {
            return "Reset the CLI setting to neondiff before reusing an existing local agent. Custom executables never receive its credential environment."
        }
        if matchingLocalBotConfigurationAvailable {
            return "The local agent needs recovery before reuse because its credential-safe execution context is unavailable."
        }
        guard let storedAppID = storedBYOGitHubAppId else {
            return "No app-owned Keychain App ID is stored for current-access verification."
        }
        guard storedAppID == String(bot.appID) else {
            return "The stored App ID does not match the selected existing bot. Select the matching bot or replace that bot's Keychain credential."
        }
        guard byoGitHubPrivateKeyStored else {
            return "The App ID matches, but its app-owned private key is missing from Keychain."
        }
        return byoGitHubCredentialStatus
    }

    package var managedGitHubStatusText: String {
        switch managedGitHubConnectionState {
        case .quarantined:
            "Unavailable in this signed build"
        case .disconnected:
            "Not connected"
        case .verificationRequired:
            "Saved binding requires server verification"
        case .connecting:
            "Creating Keychain-backed device binding"
        case .awaitingAuthorization:
            "Waiting for GitHub authorization"
        case .installationSelectionRequired:
            "Choose an authorized App installation"
        case .bound(let installationId):
            "Server binding verified · installation \(installationId)"
        case .failed:
            managedGitHubRecovery?.status ?? "Verification failed"
        }
    }

    package var isManagedGitHubBound: Bool {
        if case .bound = managedGitHubConnectionState { return true }
        return false
    }

    package var githubConnectionReady: Bool {
        if isManagedGitHubBound || byoGitHubCredentialsVerified {
            return true
        }
        return github.userTokenStored
            && github.authorizedUserLogin != nil
            && github.installationCount > 0
            && github.discoveredRepositoryCount > 0
    }

    package var canAdvanceOnboarding: Bool {
        if existingLocalBotReconciliationMode {
            return true
        }
        if dependencies.productionBoundary.managedGitHubBrokerOrigin != nil {
            guard hasVerifiedManagedGitHubSelection else { return false }
        }
        if dependencies.productionBoundary.byoGitHubEnabled {
            guard byoGitHubCredentialOnboardingAvailable,
                  byoGitHubCredentialsStored,
                  byoGitHubCredentialsVerified
            else { return false }
        }
        return onboardingFlow.canAdvance
    }

    private var hasVerifiedManagedGitHubSelection: Bool {
        guard case .bound = managedGitHubConnectionState,
              let selectedManagedGitHubRepository,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == selectedManagedGitHubRepository
              }),
              repository.visibility != .unknown
        else {
            return false
        }
        return repos.filter(\.enabled).map(\.name) == [selectedManagedGitHubRepository]
    }

    private let dependencies: DesktopAppDependencies
    private let activationLicenseClientOverride: (any ActivationLicenseClienting)?
    private var providerVerificationTask: Task<Void, Never>?
    private var providerVerificationRequestGeneration: UInt64 = 0
    private var providerVerificationContextGeneration: UInt64 = 0
    private var activeProviderVerificationRequestGeneration: UInt64?
    private var providerKeyRevision: UInt64 = 0
    private var byoGitHubCredentialRevision: UInt64 = 0
    private var githubAuthorizationTask: Task<Void, Never>?
    private var githubRepositoryRefreshTask: Task<Void, Never>?
    private var managedGitHubConnectionTask: Task<Void, Never>?
    private var localWorkerCompatibilityTask: Task<Void, Never>?
    private var localWorkerReviewCompatibilityGeneration: UInt64 = 0
    private var accountLinkTask: Task<Void, Never>?
    private var mostRecentAccountLinkTask: Task<Void, Never>?
    private var accountLinkGeneration: UInt64 = 0
    private var attemptedAutomaticAccountWorkspaceRefresh = false
    private var pendingManagedGitHubAuthorization: PendingManagedGitHubAuthorization?
    private var githubRepositoryRefreshGate = GitHubLatestRequestGate()
    private var controlCenterLoadedSnapshot: DesktopControlCenterSnapshot?
    private var controlCenterRollbackSnapshot: DesktopControlCenterSnapshot?
    private var previewedControlCenterSnapshot: DesktopControlCenterSnapshot?
    private var previewedControlCenterBaseline: DesktopControlCenterSnapshot?
    private var controlCenterLoadedRevision: String?
    private var controlCenterRollbackExpectedRevision: String?
    private var previewedControlCenterExpectedRevision: String?
    private var providerLoadedSnapshot: ProviderConfigurationSnapshot?
    private var providerLoadedRevision: String?
    private var previewedProviderSnapshot: ProviderConfigurationSnapshot?
    private var previewedProviderExpectedRevision: String?
    private var pendingProviderPatchProof: PendingProviderPatchProof?
    private var pendingRepoPatchProof: PendingRepoPatchProof?
    private var pendingRemovedRepoProfileNames = Set<String>()
    private var workspaceContextGeneration: UInt64 = 0
    private let accountWorkspacePreferenceKey = "neondiff.accountWorkspaceID"
    private let accountBotPreferenceKey = "neondiff.accountBotID"
    private let pendingNewBotPlanPreferenceKey = "neondiff.pendingNewBotPlan.v1"
    private static let configPathPreferenceKey = "neondiff.configPath"

    private struct PersistedPendingNewBotPlan: Codable {
        let schemaVersion: Int
        let accountID: String
        let botID: String
        let appSlug: String
        let configPath: String
    }

    package init(dependencies: DesktopAppDependencies, activationLicenseClient: (any ActivationLicenseClienting)? = nil) {
        self.dependencies = dependencies
        self.activationLicenseClientOverride = activationLicenseClient
        self.currentLocalWorkerExecutionContexts =
            dependencies.localBotExecutionContexts
        self.currentLocalBotConfigurations =
            dependencies.localBotConfigurations
        self.currentLocalBotExecutionConfigPaths =
            dependencies.localBotExecutionConfigPaths
        self.configPath = dependencies.preferences.string(forKey: Self.configPathPreferenceKey)
            ?? dependencies.fileWriter.applicationSupportDirectory
                .appendingPathComponent("config.local.json")
                .standardizedFileURL.path
        self.cliPath = dependencies.preferences.string(forKey: "neondiff.cliPath") ?? "neondiff"
        self.launchdLabel = dependencies.preferences.string(forKey: "neondiff.launchdLabel") ?? "com.electricsheephq.evaos-code-review-bot"
        let providerKeyStored = ProviderKeychainAccount.account(providerId: providers.selectedProviderId)
            .map(dependencies.secretStore.containsSecret(account:)) == true
        let githubUserTokenStored = dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
        let githubRefreshTokenStored = dependencies.secretStore.containsSecret(account: githubRefreshTokenAccount)
        let byoGitHubAppId = dependencies.preferences.string(forKey: byoGitHubAppIdPreferenceKey)
            .flatMap { try? BYOGitHubAppCredentialValidator.normalizedAppId($0) }
        self.providers.providerKeyStored = providerKeyStored
        self.license.keyStored = dependencies.secretStore.containsSecret(account: licenseKeyAccount)
        self.github.userTokenStored = githubUserTokenStored
        self.pendingBYOGitHubAppId = byoGitHubAppId ?? ""
        self.byoGitHubPrivateKeyStored = dependencies.secretStore.containsSecret(
            account: BYOGitHubAppKeychainAccount.privateKey
        )
        if byoGitHubAppId != nil, self.byoGitHubPrivateKeyStored {
            self.byoGitHubCredentialStatus = "App ID stored; private key is in Keychain. Worker verification has not run yet."
        }
        if githubUserTokenStored {
            self.github.installationState = "authorization stored; verify"
            self.githubAuthorizationStatus = "authorization stored; refresh repos to verify"
        } else if githubRefreshTokenStored {
            self.github.installationState = "authorization refresh available"
            self.githubAuthorizationStatus = "authorization refresh available"
        } else {
            self.github.installationState = "not connected"
        }
        self.github.authorizedUserLogin = nil
        if dependencies.productionBoundary.managedGitHubBrokerOrigin != nil {
            if dependencies.githubBroker == nil {
                self.managedGitHubConnectionState = .quarantined
            } else if Self.savedManagedGitHubInstallationId(
                preferences: dependencies.preferences
            ) != nil {
                self.managedGitHubConnectionState = .verificationRequired
            } else {
                self.managedGitHubConnectionState = .disconnected
            }
        } else {
            self.managedGitHubConnectionState = .quarantined
        }
        self.onboardingFlow = OnboardingFlow(providerKeyStored: providerKeyStored)
        self.isOnboardingPresented = !dependencies.preferences.bool(forKey: onboardingCompletedKey)
        // Resume-exact: restore the persisted activation state (rawValue) without
        // touching the Keychain on the launch path (v1.0.3 startup-stability rule).
        if let rawActivationState = dependencies.preferences.string(forKey: activationStateKey),
           let restored = ActivationState(rawValue: rawActivationState) {
            self.activationState = restored
        } else {
            self.activationState = ActivationStateMachine.initialState
        }
        self.lastCommandLine = statusCommand.commandLine
    }

    package var selectedAccountWorkspace: DesktopAccountWorkspace? {
        guard let accountID = accountWorkspaceSelection.accountID else { return nil }
        return accountWorkspaceCatalog.accounts.first { $0.id == accountID }
    }

    package var selectedBotInstallation: DesktopBotInstallation? {
        guard let botID = accountWorkspaceSelection.botID else { return nil }
        return selectedAccountWorkspace?.bots.first { $0.id == botID }
    }

    /// Setup truth for an existing worker is distinct from current-launch
    /// authorization to perform useful work. This becomes true only after a
    /// server-authoritative verified bot intersects the exact local config path
    /// discovered on this Mac. It never consumes local config as membership or
    /// installation authority.
    package var existingLocalBotIdentityReady: Bool {
        guard let account = selectedAccountWorkspace,
              account.role != nil,
              let bot = selectedBotInstallation,
              bot.status == .verified,
              bot.appID > 0,
              bot.githubInstallationID != nil,
              bot.githubAccountLogin?.trimmingCharacters(
                  in: .whitespacesAndNewlines
              ).isEmpty == false,
              let localConfigPath = bot.localConfigPath
        else {
            return false
        }
        return normalizedPath(localConfigPath) == normalizedPath(configPath)
    }

    /// Customer-facing connection status may reuse a verified existing bot
    /// identity. The stricter `githubConnectionReady` property remains the
    /// current-launch credential proof used by review authorization.
    package var githubSetupReady: Bool {
        githubConnectionReady || existingLocalBotIdentityReady
    }

    /// A loaded non-key provider such as ZCode's app-config adapter is already
    /// configured; asking for a NeonDiff Keychain API key is incorrect. API-key
    /// providers still require their app-owned Keychain state or a current
    /// verification result.
    package var providerSetupReady: Bool {
        guard providerLoadedSnapshot?.configPath == configPath,
              providerLoadedRevision != nil,
              providerLoadedSnapshot == currentProviderConfigurationSnapshot,
              let provider = providers.selectedRegistryTarget,
              provider.enabled
        else {
            return false
        }
        switch provider.authMode {
        case "zcode-app-config", "none":
            return true
        case "api-key-env":
            guard let verification = providerVerification else {
                return false
            }
            return verification.isVerified
                && verification.providerId == provider.id
                && verification.configRevision == providerLoadedRevision
        default:
            return false
        }
    }

    /// The current scoped-review bridge executes ZCode, so its authorization
    /// must be bound to the same app configuration ZCode will read. A provider
    /// verified through NeonDiff's separate API-key adapter remains valid for
    /// provider setup, but cannot authorize this bridge until direct adapter
    /// execution is supported.
    package var scopedReviewProviderReady: Bool {
        providerSetupReady
            && providers.selectedRegistryTarget?.authMode == "zcode-app-config"
            && !providers.zcodeProviderId
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
    }

    /// Account entitlement is server authority for the selected existing bot's
    /// setup display. It does not replace the exact current-launch activation
    /// checks in `currentRepositoryActivationReady` or
    /// `productionUsefulWorkAvailable`.
    package var licenseSetupReady: Bool {
        if currentRepositoryActivationReady {
            return true
        }
        guard existingLocalBotIdentityReady,
              let entitlement = selectedAccountWorkspace?.entitlement
        else {
            return false
        }
        switch entitlement {
        case .paid, .internalAdmin, .trial:
            return true
        case .publicFree:
            return selectedAccountEntitlementSupportsCurrentPath
        case .none:
            return false
        }
    }

    /// Update access is evaluated at the moment Sparkle starts a check. A
    /// current launch activation can authorize the paid beta channel directly.
    /// Otherwise the account catalog must be a current server response; stale
    /// or failed account state never unlocks an update. Public-free access is
    /// limited to a verified managed public repository.
    package var desktopUpdateAccess: DesktopUpdateAccess {
        let accountCatalogCurrent: Bool
        if case .loaded = accountWorkspaceCatalog {
            accountCatalogCurrent = DesktopUpdateAccessPolicy.accountCatalogIsCurrent(
                verifiedAt: accountWorkspaceCatalogVerifiedAt,
                now: dependencies.clock.now
            )
        } else {
            accountCatalogCurrent = false
        }

        let managedPublicRepositoryVerified: Bool
        if hasVerifiedManagedGitHubSelection,
           let selectedManagedGitHubRepository,
           let repository = managedGitHubRepositories.first(where: {
               $0.fullName == selectedManagedGitHubRepository
           }) {
            managedPublicRepositoryVerified = DesktopUpdateAccessPolicy
                .managedPublicRepositoryIsEligible(
                    isPublic: repository.visibility == .public,
                    verifiedAt: managedGitHubRepositoriesVerifiedAt,
                    now: dependencies.clock.now
                )
        } else {
            managedPublicRepositoryVerified = false
        }

        let activationAuthorityCurrent: Bool
        if let validUntil = activationUpdateAuthorityValidUntil {
            activationAuthorityCurrent = DesktopUpdateAccessPolicy.accountCatalogIsCurrent(
                verifiedAt: activationUpdateAuthorityVerifiedAt,
                now: dependencies.clock.now
            ) && dependencies.clock.now < validUntil
        } else {
            activationAuthorityCurrent = false
        }

        return DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: dependencies.productionBoundary.nativeActivationBrokerVerified,
            accountCatalogCurrent: accountCatalogCurrent,
            accountEntitlement: selectedAccountWorkspace?.entitlement,
            activationVerifiedThisLaunch: activationVerifiedThisLaunch,
            activationIsActive: activationState == .active,
            activationUpdateEntitlement: activationUpdateEntitlementThisLaunch,
            activationAuthorityCurrent: activationAuthorityCurrent,
            managedPublicRepositoryVerified: managedPublicRepositoryVerified
        )
    }

    /// Successful config inspection proves that the selected local config
    /// already contains and read back its repository allowlist. BYO credential
    /// verification remains a separate current-launch work gate.
    package var repositorySetupReady: Bool {
        if repositoryConfigurationReady {
            return true
        }
        let enabledRepositories = uniqueSortedRepoNames(
            repos.filter(\.enabled).map(\.name)
        )
        guard existingLocalBotIdentityReady,
              !enabledRepositories.isEmpty
        else {
            return false
        }
        return appliedRepoSelection == AppliedRepoSelection(
            repositories: enabledRepositories,
            configPath: configPath
        )
    }

    package var existingLocalBotSetupReady: Bool {
        existingLocalBotIdentityReady
            && githubSetupReady
            && providerSetupReady
            && licenseSetupReady
            && repositorySetupReady
    }

    package var existingLocalBotReconciliationMode: Bool {
        existingLocalBotIdentityReady
    }

    /// During launch, do not render the empty first-run state while an
    /// authorized account/local-bot intersection or its config is still being
    /// restored. This is presentation state only and grants no review
    /// authorization.
    package var isExistingLocalBotRestoreInProgress: Bool {
        isAutomaticAccountWorkspaceRefreshInProgress
            || (existingLocalBotIdentityReady && isConfigInspectInProgress)
    }

    /// A saved account identity failed to refresh. Keep this distinct from a
    /// proven first-run state so a transient authority failure cannot invite
    /// the customer to overwrite an existing setup.
    package var accountWorkspaceRestoreFailed: Bool {
        guard attemptedAutomaticAccountWorkspaceRefresh,
              !isAutomaticAccountWorkspaceRefreshInProgress,
              !isOnboardingPresented
        else {
            return false
        }
        if case .failed = accountWorkspaceCatalog {
            return true
        }
        return false
    }

    /// Customer setup writes remain closed while existing account/config truth
    /// is being restored or when that restore needs an explicit retry.
    package var isSetupMutationBlocked: Bool {
        isExistingLocalBotRestoreInProgress
            || accountWorkspaceRestoreFailed
            || isAccountLinkInProgress
    }

    /// Customer chrome should never present the internal sentinel `unknown` as
    /// if it were a meaningful product state.
    package var customerSurfaceStatus: String {
        if isOnboardingPresented {
            return "SETUP REQUIRED"
        }
        if isExistingLocalBotRestoreInProgress {
            return "RESTORING"
        }
        if accountWorkspaceRestoreFailed {
            return "ACCOUNT CHECK FAILED"
        }
        if status.healthState != DaemonStatus.unknown.healthState {
            return switch status.healthState {
            case "runtime_ok": "WORKER READY"
            case "runtime_blocked": "WORKER ATTENTION"
            case "coverage_blocked": "COVERAGE ATTENTION"
            default:
                status.healthState
                    .replacingOccurrences(of: "_", with: " ")
                    .uppercased()
            }
        }
        if existingLocalBotSetupReady {
            return "SETUP CONFIGURED"
        }
        if existingLocalBotIdentityReady {
            return "SETUP INCOMPLETE"
        }
        return "NOT CHECKED"
    }

    package var customerLocalWorkerStatusDetail: String {
        if isExistingLocalBotRestoreInProgress {
            return "Checking the selected bot’s local worker"
        }
        if statusRefreshFailureMessage != nil {
            return "Status check failed — retry"
        }
        if status == .unknown {
            return "Not checked yet — choose Refresh Activity"
        }
        return switch status.healthState {
        case "runtime_ok": "Running and ready"
        case "runtime_blocked":
            "Review worker needs attention — open Advanced Diagnostics"
        case "coverage_blocked": "Review coverage needs attention"
        default:
            status.healthState
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    package var selectedProviderRequiresAPIKey: Bool {
        providers.selectedRegistryTarget?.authMode == "api-key-env"
    }

    package var selectedAccountEntitlementLabel: String? {
        guard existingLocalBotIdentityReady,
              let entitlement = selectedAccountWorkspace?.entitlement
        else {
            return nil
        }
        return switch entitlement {
        case .paid: "Paid account"
        case .internalAdmin: "Internal administrator"
        case .trial: "Active trial"
        case .publicFree: "Public repositories only"
        case .none: "No active entitlement"
        }
    }

    package var accountLinkAvailable: Bool {
        dependencies.productionBoundary.accountLinkBrokerOrigin != nil
            && dependencies.accountLink != nil
    }

    package func connectNeonDiffAccount() {
        guard !isAccountLinkInProgress else { return }
        guard dependencies.productionBoundary.accountLinkBrokerOrigin != nil,
              let accountLink = dependencies.accountLink
        else {
            accountWorkspaceCatalog = .failed("NeonDiff account linking is unavailable in this build.")
            accountWorkspaceStatus = "NeonDiff account linking is unavailable in this build."
            return
        }

        accountLinkTask?.cancel()
        accountLinkGeneration &+= 1
        let generation = accountLinkGeneration
        isAccountLinkInProgress = true
        accountWorkspaceCatalog = .loading
        accountWorkspaceStatus = "Opening a secure NeonDiff sign-in in your browser…"
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let secretStore = self.dependencies.secretStore
                let identity = try await Self.loadAccountLinkDeviceIdentity(
                    secretStore: secretStore,
                    createIfMissing: true
                )
                try Task.checkCancellation()
                guard self.isCurrentAccountLink(generation) else { return }
                try await accountLink.registerAccountLinkIdentity(identity: identity)
                try Task.checkCancellation()
                guard self.isCurrentAccountLink(generation) else { return }
                let connection = try await accountLink.startAccountLink(identity: identity)
                try Task.checkCancellation()
                guard self.isCurrentAccountLink(generation) else { return }
                guard self.dependencies.urlOpener.open(connection.connectURL) else {
                    throw AccountLinkModelError.browserOpenFailed
                }
                self.accountWorkspaceStatus = "Finish sign-in in your browser. NeonDiff will continue automatically."

                var attempt = 0
                var retryDelaySeconds = 1.0
                let maximumAttempts = 80
                while self.dependencies.clock.now < connection.expiresAt,
                      attempt < maximumAttempts {
                    try Task.checkCancellation()
                    guard self.isCurrentAccountLink(generation) else { return }
                    do {
                        let snapshot = try await accountLink.loadAccountWorkspaces(
                            identity: identity,
                            state: connection.state
                        )
                        try Task.checkCancellation()
                        guard self.isCurrentAccountLink(generation) else { return }
                        self.applyAccountLinkSnapshot(snapshot)
                        self.isAccountLinkInProgress = false
                        self.accountLinkTask = nil
                        return
                    } catch GitHubBrokerClientError.server(reason: .accountLinkRequired) {
                        attempt += 1
                        let remaining = connection.expiresAt.timeIntervalSince(
                            self.dependencies.clock.now
                        )
                        guard remaining > 0 else { break }
                        try await self.dependencies.clock.sleep(
                            for: .seconds(min(retryDelaySeconds, remaining))
                        )
                        retryDelaySeconds = min(retryDelaySeconds * 2, 8)
                    } catch GitHubBrokerClientError.server(reason: .rateLimited) {
                        attempt += 1
                        retryDelaySeconds = 8
                        let remaining = connection.expiresAt.timeIntervalSince(
                            self.dependencies.clock.now
                        )
                        guard remaining > 0 else { break }
                        try await self.dependencies.clock.sleep(
                            for: .seconds(min(retryDelaySeconds, remaining))
                        )
                    }
                }
                throw AccountLinkModelError.expired
            } catch is CancellationError {
                guard self.isCurrentAccountLink(generation) else { return }
                self.isAccountLinkInProgress = false
                self.accountLinkTask = nil
            } catch {
                self.applyAccountLinkFailure(error, generation: generation)
            }
        }
        accountLinkTask = task
        mostRecentAccountLinkTask = task
    }

    package func refreshAccountWorkspacesOnLaunch() {
        guard !attemptedAutomaticAccountWorkspaceRefresh else { return }
        guard !isAccountLinkInProgress else { return }
        attemptedAutomaticAccountWorkspaceRefresh = true
        isAutomaticAccountWorkspaceRefreshInProgress = true
        if !dependencies.preferences.bool(forKey: onboardingCompletedKey) {
            isOnboardingPresented = false
        }
        refreshAccountWorkspaces()
    }

    package func cancelAccountLink() {
        accountLinkGeneration &+= 1
        accountLinkTask?.cancel()
        accountLinkTask = nil
        isAccountLinkInProgress = false
        accountWorkspaceCatalog = .idle
        accountWorkspaceStatus = "Account connection cancelled. You can continue locally or reconnect later."
        lastError = nil
        finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: false)
    }

    /// Refreshes an already-linked device without creating or rotating its
    /// Keychain identity. A missing identity remains an explicit connect state.
    package func refreshAccountWorkspaces() {
        guard !isAccountLinkInProgress else { return }
        if accountWorkspaceRestoreFailed {
            isAutomaticAccountWorkspaceRefreshInProgress = true
        }
        guard dependencies.productionBoundary.accountLinkBrokerOrigin != nil,
              let accountLink = dependencies.accountLink
        else {
            accountWorkspaceCatalog = .failed("NeonDiff account linking is unavailable in this build.")
            accountWorkspaceStatus = "NeonDiff account linking is unavailable in this build."
            finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: false)
            return
        }

        accountLinkTask?.cancel()
        accountLinkGeneration &+= 1
        let generation = accountLinkGeneration
        isAccountLinkInProgress = true
        accountWorkspaceCatalog = .loading
        accountWorkspaceStatus = "Refreshing authorized NeonDiff accounts…"
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let secretStore = self.dependencies.secretStore
                let identity = try await Self.loadAccountLinkDeviceIdentity(
                    secretStore: secretStore,
                    createIfMissing: false
                )
                try Task.checkCancellation()
                guard self.isCurrentAccountLink(generation) else { return }
                let snapshot = try await accountLink.loadAccountWorkspaces(identity: identity)
                try Task.checkCancellation()
                guard self.isCurrentAccountLink(generation) else { return }
                self.applyAccountLinkSnapshot(snapshot)
                self.isAccountLinkInProgress = false
                self.accountLinkTask = nil
                self.finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: true)
            } catch is CancellationError {
                guard self.isCurrentAccountLink(generation) else { return }
                self.isAccountLinkInProgress = false
                self.accountLinkTask = nil
                self.finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: false)
            } catch GitHubBrokerDeviceIdentityError.storedIdentityMissing {
                guard self.isCurrentAccountLink(generation) else { return }
                self.isAccountLinkInProgress = false
                self.accountLinkTask = nil
                self.accountWorkspaceCatalog = .idle
                self.accountWorkspaceStatus = "Connect your NeonDiff account to load personal and organization workspaces."
                self.finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: true)
            } catch is GitHubBrokerDeviceIdentityError {
                guard self.isCurrentAccountLink(generation) else { return }
                self.isAccountLinkInProgress = false
                self.accountLinkTask = nil
                let message = "The saved NeonDiff account link is unavailable. Reconnect to recover safely."
                self.accountWorkspaceCatalog = .failed(message)
                self.accountWorkspaceStatus = message
                self.lastError = message
                self.finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: false)
            } catch {
                self.applyAccountLinkFailure(error, generation: generation)
                self.finishAutomaticAccountWorkspaceRefresh(presentsOnboardingIfNeeded: false)
            }
        }
        accountLinkTask = task
        mostRecentAccountLinkTask = task
    }

    package func waitForAccountLinkOperation() async {
        await (accountLinkTask ?? mostRecentAccountLinkTask)?.value
    }

    private func applyAccountLinkSnapshot(_ snapshot: NeonDiffAccountWorkspaceSnapshot) {
        let localCandidates = currentLocalBotCandidates(snapshot: snapshot)
        let accounts = snapshot.accounts.map { account in
            DesktopAccountWorkspace(
                id: account.id,
                kind: DesktopAccountKind(rawValue: account.kind.rawValue)!,
                name: account.name,
                role: DesktopAccountRole(rawValue: account.role.rawValue),
                entitlement: DesktopAccountEntitlement(rawValue: account.entitlement.rawValue)!,
                bots: account.bots.map { bot in
                    DesktopBotInstallation(
                        id: bot.id,
                        appID: bot.appID,
                        appSlug: bot.appSlug,
                        mode: DesktopBotMode(rawValue: bot.mode.rawValue)!,
                        githubInstallationID: bot.githubInstallationID,
                        githubAccountLogin: bot.githubAccountLogin,
                        status: DesktopBotStatus(rawValue: bot.status.rawValue)!,
                        localConfigPath: nil
                    )
                }
            ).merging(localCandidates: localCandidates)
        }
        applyAccountWorkspaceCatalog(.loaded(accounts))

        if pendingNewBotPlan == nil,
           selectedBotInstallation == nil,
           let localBot = selectedAccountWorkspace?.bots.first(where: {
               $0.status == .verified && $0.localConfigPath != nil
           }) {
            selectBotInstallation(localBot.id)
        }
        accountWorkspaceStatus = accounts.isEmpty
            ? "No authorized NeonDiff accounts were returned."
            : "Account authority verified."
        lastError = nil
    }

    private func finishAutomaticAccountWorkspaceRefresh(
        presentsOnboardingIfNeeded: Bool
    ) {
        guard isAutomaticAccountWorkspaceRefreshInProgress else { return }
        isAutomaticAccountWorkspaceRefreshInProgress = false
        if pendingNewBotPlan != nil {
            isOnboardingPresented = true
            return
        }
        guard !dependencies.preferences.bool(forKey: onboardingCompletedKey) else {
            isOnboardingPresented = false
            return
        }
        guard presentsOnboardingIfNeeded else {
            isOnboardingPresented = false
            return
        }
        isOnboardingPresented = !existingLocalBotIdentityReady
    }

    private func currentLocalBotCandidates(
        snapshot: NeonDiffAccountWorkspaceSnapshot
    ) -> [DesktopLocalBotCandidate] {
        if dependencies.productionBoundary.managedGitHubBrokerOrigin != nil {
            guard let installationID = Self.savedManagedGitHubInstallationId(
                preferences: dependencies.preferences
            ) else {
                return []
            }
            guard dependencies.fileWriter.fileExists(at: URL(filePath: configPath)) else {
                return []
            }
            let managedMatches = snapshot.accounts.flatMap(\.bots).filter {
                $0.mode == .managed
                    && $0.githubInstallationID == Int64(installationID)
                    && $0.status == .verified
                    && $0.githubAccountLogin?.isEmpty == false
            }
            guard managedMatches.count == 1,
                  let managed = managedMatches.first,
                  let githubAccountLogin = managed.githubAccountLogin
            else {
                return []
            }
            return [DesktopLocalBotCandidate(
                botID: managed.id,
                appID: managed.appID,
                appSlug: managed.appSlug,
                githubAccountLogin: githubAccountLogin,
                configPath: URL(filePath: configPath).standardizedFileURL.path
            )]
        }

        guard dependencies.productionBoundary.byoGitHubEnabled else {
            return []
        }

        var candidates: [DesktopLocalBotCandidate] = []
        for configuration in currentLocalBotConfigurations {
            let configurationURL = URL(filePath: configuration.configPath)
                .standardizedFileURL
            guard dependencies.fileWriter.fileExists(at: configurationURL) else {
                continue
            }
            if let candidate = verifiedBYOLocalBotCandidate(
                appID: configuration.appID,
                configPath: configurationURL.path,
                snapshot: snapshot
            ) {
                candidates.append(candidate)
            }
        }

        if dependencies.fileWriter.fileExists(at: URL(filePath: configPath)),
           let rawAppID = dependencies.preferences.string(forKey: byoGitHubAppIdPreferenceKey),
           let appID = Int64(rawAppID),
           appID > 0 {
            if let candidate = verifiedBYOLocalBotCandidate(
                appID: appID,
                configPath: URL(filePath: configPath).standardizedFileURL.path,
                snapshot: snapshot
            ) {
                candidates.append(candidate)
            }
        }

        var seen = Set<String>()
        return candidates.filter {
            seen.insert("\($0.appID):\($0.configPath)").inserted
        }
    }

    private func verifiedBYOLocalBotCandidate(
        appID: Int64,
        configPath: String,
        snapshot: NeonDiffAccountWorkspaceSnapshot
    ) -> DesktopLocalBotCandidate? {
        let matches = snapshot.accounts.flatMap(\.bots).filter {
            $0.mode == .byo
                && $0.appID == appID
                && $0.status == .verified
                && $0.githubAccountLogin?.isEmpty == false
        }
        guard matches.count == 1,
              let matchedBot = matches.first,
              let githubAccountLogin = matchedBot.githubAccountLogin
        else {
            return nil
        }
        return DesktopLocalBotCandidate(
            botID: matchedBot.id,
            appID: appID,
            appSlug: matchedBot.appSlug,
            githubAccountLogin: githubAccountLogin,
            configPath: configPath
        )
    }

    private func applyAccountLinkFailure(_ error: Error, generation: UInt64) {
        guard isCurrentAccountLink(generation) else { return }
        isAccountLinkInProgress = false
        accountLinkTask = nil
        let message: String
        switch error {
        case AccountLinkModelError.browserOpenFailed:
            message = "NeonDiff could not open the secure account page. Retry or open it from a different browser."
        case AccountLinkModelError.expired,
             GitHubBrokerClientError.server(reason: .stateExpired):
            message = "The account connection expired. Start again when ready."
        case GitHubBrokerClientError.server(reason: .accountLinkRequired):
            message = "Connect your NeonDiff account to load personal and organization workspaces."
        case GitHubBrokerClientError.server(reason: .rateLimited):
            message = "Account linking is temporarily rate-limited. Wait a moment, then retry."
        default:
            message = "NeonDiff could not verify your account authority. Retry safely; local secrets were not changed."
        }
        accountWorkspaceCatalog = .failed(message)
        accountWorkspaceStatus = message
        lastError = message
    }

    private func isCurrentAccountLink(_ generation: UInt64) -> Bool {
        accountLinkGeneration == generation
    }

    private nonisolated static func loadAccountLinkDeviceIdentity(
        secretStore: any DesktopSecretStoring,
        createIfMissing: Bool
    ) async throws -> GitHubBrokerDeviceIdentity {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let store = GitHubBrokerDeviceIdentityStore(secretStore: secretStore)
                    let identity = try createIfMissing
                        ? store.loadOrCreate()
                        : store.loadExisting()
                    continuation.resume(returning: identity)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Installs a server-authoritative snapshot. Accounts without a membership
    /// are filtered by the catalog and can never become selectable client-side.
    package func applyAccountWorkspaceCatalog(_ catalog: DesktopAccountWorkspaceCatalog) {
        let previousSelectedAccount = selectedAccountWorkspace
        let previousSelectedBot = selectedBotInstallation
        if case .loaded = catalog {
            accountWorkspaceCatalogVerifiedAt = dependencies.clock.now
        } else {
            accountWorkspaceCatalogVerifiedAt = nil
        }
        accountWorkspaceCatalog = catalog
        guard !catalog.accounts.isEmpty else {
            accountWorkspaceSelection = DesktopAccountWorkspaceSelection()
            accountWorkspaceStatus = catalogFailureOrEmptyMessage(catalog)
            resetWorkspaceBoundRuntimeState()
            return
        }

        if let selectedAccountID = accountWorkspaceSelection.accountID,
           let selectedAccount = catalog.accounts.first(where: { $0.id == selectedAccountID }) {
            let selectedAuthorityChanged =
                previousSelectedAccount?.hasSameAuthority(as: selectedAccount)
                    != true
            if selectedAuthorityChanged {
                resetWorkspaceBoundRuntimeState()
            }
            if let selectedBotID = accountWorkspaceSelection.botID {
                if let pendingNewBotPlan,
                   pendingNewBotPlan.accountID == selectedAccountID,
                   pendingNewBotPlan.bot.id == selectedBotID,
                   previousSelectedAccount?.hasSameAuthority(as: selectedAccount) == true {
                    accountWorkspaceStatus = "New bot setup remains local until its server registration is verified."
                    return
                }
                guard let selectedBot = selectedAccount.bots.first(where: {
                    $0.id == selectedBotID
                        && ($0.status == .verified || $0.status == .pending)
                }) else {
                    resetWorkspaceBoundRuntimeState()
                    accountWorkspaceSelection.selectBot(nil)
                    pendingNewBotPlan = nil
                    dependencies.preferences.removeValue(forKey: accountBotPreferenceKey)
                    dependencies.preferences.removeValue(
                        forKey: pendingNewBotPlanPreferenceKey
                    )
                    accountWorkspaceStatus = "The selected bot is no longer authorized. Choose another bot or create a new one."
                    return
                }
                if selectedAuthorityChanged
                    || previousSelectedBot?.localConfigPath
                        != selectedBot.localConfigPath
                {
                    if !selectedAuthorityChanged {
                        resetWorkspaceBoundRuntimeState()
                    }
                    if let localConfigPath = selectedBot.localConfigPath {
                        configPath = localConfigPath
                        inspectConfig(
                            allowDuringAccountRestore: isAccountLinkInProgress
                        )
                    } else {
                        configPath = isolatedBotConfigPath(
                            accountID: selectedAccount.id,
                            appSlug: selectedBot.appSlug
                        )
                        accountWorkspaceStatus = "This bot is not configured on this Mac. Complete setup before use."
                        reopenOnboarding(at: .welcome)
                        return
                    }
                }
            }
            accountWorkspaceStatus = "Account authority verified."
            return
        }

        let saved = dependencies.preferences.string(forKey: accountWorkspacePreferenceKey)
        let initial = catalog.accounts.first(where: { $0.id == saved }) ?? catalog.accounts[0]
        let savedBotID = dependencies.preferences.string(forKey: accountBotPreferenceKey)
        selectAccountWorkspace(initial.id, clearSavedBot: false)
        if let restoredPlan = restoredPendingNewBotPlan(
            account: initial,
            savedBotID: savedBotID
        ) {
            pendingNewBotPlan = restoredPlan
            accountWorkspaceSelection.selectBot(restoredPlan.bot.id)
            configPath = restoredPlan.bot.localConfigPath ?? configPath
            accountWorkspaceStatus = "Restored the pending New Bot setup on this Mac."
            if dependencies.fileWriter.fileExists(at: URL(filePath: configPath)) {
                inspectConfig(allowDuringAccountRestore: true)
            } else {
                reopenOnboarding(at: .welcome)
            }
        } else if let savedBotID,
           initial.bots.contains(where: {
               $0.id == savedBotID
                   && ($0.status == .verified || $0.status == .pending)
           }) {
            let preservesPendingPlan = restoredPendingNewBotPlan(
                account: initial,
                savedBotID: savedBotID,
                requiresCurrentSelection: false
            ) != nil
            selectBotInstallation(
                savedBotID,
                preservesPendingNewBotPlan: preservesPendingPlan
            )
        } else {
            dependencies.preferences.removeValue(forKey: accountBotPreferenceKey)
            dependencies.preferences.removeValue(
                forKey: pendingNewBotPlanPreferenceKey
            )
            if initial.bots.isEmpty {
                beginNewBot()
            }
        }
    }

    package func selectAccountWorkspace(_ accountID: String) {
        selectAccountWorkspace(accountID, clearSavedBot: true)
    }

    private func selectAccountWorkspace(_ accountID: String, clearSavedBot: Bool) {
        guard accountWorkspaceCatalog.accounts.contains(where: { $0.id == accountID }) else {
            accountWorkspaceStatus = "That account is not available to this signed-in user."
            return
        }
        guard accountWorkspaceSelection.accountID != accountID else { return }

        resetWorkspaceBoundRuntimeState()
        accountWorkspaceSelection.selectAccount(accountID)
        pendingNewBotPlan = nil
        dependencies.preferences.set(accountID, forKey: accountWorkspacePreferenceKey)
        if clearSavedBot {
            dependencies.preferences.removeValue(forKey: accountBotPreferenceKey)
            dependencies.preferences.removeValue(
                forKey: pendingNewBotPlanPreferenceKey
            )
        }
        accountWorkspaceStatus = "Account selected. Choose an existing bot or create a new one."
    }

    package func selectBotInstallation(_ botID: String) {
        if accountWorkspaceSelection.botID == botID,
           let selectedBot = selectedBotInstallation,
           selectedBot.status == .verified || selectedBot.status == .pending {
            dependencies.preferences.removeValue(
                forKey: pendingNewBotPlanPreferenceKey
            )
            return
        }
        selectBotInstallation(botID, preservesPendingNewBotPlan: false)
    }

    private func selectBotInstallation(
        _ botID: String,
        preservesPendingNewBotPlan: Bool
    ) {
        guard let account = selectedAccountWorkspace,
              let bot = account.bots.first(where: { $0.id == botID }),
              bot.status == .verified || bot.status == .pending
        else {
            accountWorkspaceStatus = "That bot is not authorized for the selected account."
            return
        }
        guard accountWorkspaceSelection.botID != botID else { return }

        resetWorkspaceBoundRuntimeState()
        accountWorkspaceSelection.selectBot(botID)
        pendingNewBotPlan = nil
        if !preservesPendingNewBotPlan {
            dependencies.preferences.removeValue(
                forKey: pendingNewBotPlanPreferenceKey
            )
        }
        dependencies.preferences.set(botID, forKey: accountBotPreferenceKey)
        if let localConfigPath = bot.localConfigPath {
            configPath = localConfigPath
            accountWorkspaceStatus = "Local bot selected. Verify its config and GitHub binding before use."
            inspectConfig(
                allowDuringAccountRestore: isAccountLinkInProgress
            )
        } else {
            configPath = isolatedBotConfigPath(
                accountID: account.id,
                appSlug: bot.appSlug
            )
            accountWorkspaceStatus = "Bot selected. Complete setup on this Mac before use."
            reopenOnboarding(at: .welcome)
        }
    }

    package func beginNewBot(appSlug: String = "new-neondiff-bot") {
        guard let account = selectedAccountWorkspace else {
            accountWorkspaceStatus = "Choose an account before creating a bot."
            return
        }
        if pendingNewBotPlan == nil,
           let restoredPlan = restoredPendingNewBotPlan(
               account: account,
               savedBotID: nil,
               requiresCurrentSelection: false
           ) {
            resetWorkspaceBoundRuntimeState()
            pendingNewBotPlan = restoredPlan
            accountWorkspaceSelection.selectBot(restoredPlan.bot.id)
            configPath = restoredPlan.bot.localConfigPath ?? configPath
            dependencies.preferences.set(
                restoredPlan.bot.id,
                forKey: accountBotPreferenceKey
            )
            dependencies.preferences.set(
                configPath,
                forKey: Self.configPathPreferenceKey
            )
            persistPendingNewBotPlan(restoredPlan)
            accountWorkspaceStatus = "Resumed the pending New Bot setup on this Mac."
            reopenOnboarding(at: .welcome)
            if dependencies.fileWriter.fileExists(at: URL(filePath: configPath)) {
                inspectConfig()
            }
            return
        }
        do {
            var occupiedPaths = Set(account.bots.compactMap(\.localConfigPath))
            if let pendingPath = pendingNewBotPlan?.bot.localConfigPath {
                occupiedPaths.insert(pendingPath)
            }
            let plan = try DesktopNewBotPlan.make(
                account: account,
                appSlug: appSlug,
                applicationSupportDirectory: dependencies.fileWriter.applicationSupportDirectory,
                occupiedConfigPaths: occupiedPaths,
                fileExists: dependencies.fileWriter.fileExists(at:)
            )
            resetWorkspaceBoundRuntimeState()
            pendingNewBotPlan = plan
            accountWorkspaceSelection.selectBot(plan.bot.id)
            configPath = plan.bot.localConfigPath ?? configPath
            dependencies.preferences.set(plan.bot.id, forKey: accountBotPreferenceKey)
            dependencies.preferences.set(configPath, forKey: Self.configPathPreferenceKey)
            persistPendingNewBotPlan(plan)
            accountWorkspaceStatus = "New bot setup is isolated from existing bot configs."
            reopenOnboarding(at: .welcome)
        } catch {
            accountWorkspaceStatus = "A new bot setup could not be created safely."
        }
    }

    private func catalogFailureOrEmptyMessage(
        _ catalog: DesktopAccountWorkspaceCatalog
    ) -> String {
        switch catalog {
        case .idle:
            "Sign in to load your personal and organization accounts."
        case .loading:
            "Loading account authority…"
        case .loaded:
            "No authorized accounts were returned."
        case .failed(let message):
            message
        }
    }

    /// Runtime proof is account-bound. Switching accounts or bots invalidates
    /// it without deleting Keychain material; credentials must be reselected
    /// and reverified for the new context before useful work is available.
    private func resetWorkspaceBoundRuntimeState() {
        workspaceContextGeneration &+= 1
        activationRequestGeneration &+= 1
        githubAuthorizationTask?.cancel()
        githubAuthorizationTask = nil
        githubRepositoryRefreshTask?.cancel()
        githubRepositoryRefreshTask = nil
        _ = githubRepositoryRefreshGate.begin()
        managedGitHubConnectionTask?.cancel()
        managedGitHubConnectionTask = nil
        invalidateLocalWorkerReviewCompatibility()
        scopedReviewTask?.cancel()
        scopedReviewTask = nil
        pendingManagedGitHubAuthorization = nil
        isGitHubAuthorizationInProgress = false
        isGitHubRepositoryRefreshInProgress = false
        isManagedGitHubConnectionInProgress = false
        githubAuthorizationCode = nil
        githubRecovery = nil
        pendingBYOGitHubAppId = ""
        pendingBYOGitHubAppPrivateKey = ""
        byoGitHubCredentialRevision &+= 1
        isBYOGitHubVerificationInProgress = false
        isScopedReviewInProgress = false
        pendingReviewPullNumber = ""
        invalidateScopedReviewApproval()
        isConfigInitializationInProgress = false
        isConfigPatchInProgress = false
        isConfigInspectInProgress = false
        isControlCenterOperationInProgress = false
        configPath = unselectedWorkspaceConfigPath
        controlCenter = DesktopControlCenterSettings()
        pendingIssueRepoName = ""
        invalidateProviderConfigAuthorization()
        invalidateControlCenterAuthorization("Workspace changed. Load the selected bot config before editing.")
        invalidateProviderVerificationContext(
            status: "Verify the selected account's provider credential when ready."
        )
        repos = []
        providers = ProviderSettings()
        license = LicenseStatus()
        github = GitHubConnectionStatus()
        discoveredGitHubRepos = []
        managedGitHubRepositories = []
        managedGitHubRepositoriesVerifiedAt = nil
        managedGitHubInstallationCandidates = []
        selectedManagedGitHubRepository = nil
        selectedBYOReviewRepository = nil
        managedGitHubRecovery = nil
        managedGitHubConnectionState = managedGitHubAvailable ? .disconnected : .quarantined
        byoGitHubCredentialsVerified = false
        providerVerificationStatus = "Verify the selected account's provider credential when ready."
        activationVerifiedThisLaunch = false
        activationVerifiedRepositoryThisLaunch = nil
        activationState = ActivationStateMachine.initialState
        dependencies.preferences.set(activationState.rawValue, forKey: activationStateKey)
        activationKeyRedactedPrefix = nil
        pendingActivationKey = ""
        appliedRepoSelection = nil
        pendingRepoName = ""
        pendingProviderKey = ""
        pendingLicenseKey = ""
        onboardingFlow = OnboardingFlow(providerKeyStored: false)
        lastError = nil
    }

    private var unselectedWorkspaceConfigPath: String {
        dependencies.fileWriter.applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent("_unselected", isDirectory: true)
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path
    }

    private func normalizedPath(_ path: String) -> String {
        URL(filePath: path).standardizedFileURL.path
    }

    private func isolatedBotConfigPath(accountID: String, appSlug: String) -> String {
        dependencies.fileWriter.applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .appendingPathComponent(appSlug, isDirectory: true)
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path
    }

    private func restoredPendingNewBotPlan(
        account: DesktopAccountWorkspace,
        savedBotID: String?,
        requiresCurrentSelection: Bool = true
    ) -> DesktopNewBotPlan? {
        guard account.role != nil,
              let serialized = dependencies.preferences.string(
                forKey: pendingNewBotPlanPreferenceKey
              ),
              let data = serialized.data(using: .utf8),
              let persisted = try? JSONDecoder().decode(
                PersistedPendingNewBotPlan.self,
                from: data
              ),
              persisted.schemaVersion == 1,
              persisted.accountID == account.id,
              persisted.botID.range(
                of: "^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                options: .regularExpression
              ) != nil,
              persisted.appSlug.range(
                of: "^[a-z0-9][a-z0-9-]{0,99}$",
                options: .regularExpression
              ) != nil
        else {
            return nil
        }
        if requiresCurrentSelection {
            guard persisted.botID == savedBotID,
                  dependencies.preferences.string(
                      forKey: Self.configPathPreferenceKey
                  ) == persisted.configPath
            else {
                return nil
            }
        }

        let botsDirectory = dependencies.fileWriter.applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(account.id, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .standardizedFileURL
        let configURL = URL(filePath: persisted.configPath).standardizedFileURL
        let botDirectory = configURL.deletingLastPathComponent()
        let directoryName = botDirectory.lastPathComponent
        let resolvedBotsDirectory = botsDirectory.resolvingSymlinksInPath()
        let resolvedBotDirectory = botDirectory.resolvingSymlinksInPath()
        let resolvedBotParent = resolvedBotDirectory.deletingLastPathComponent()
        let resolvedConfigParent = configURL
            .resolvingSymlinksInPath()
            .deletingLastPathComponent()
        guard configURL.lastPathComponent == "config.local.json",
              botDirectory.deletingLastPathComponent() == botsDirectory,
              resolvedBotParent.path.caseInsensitiveCompare(
                  resolvedBotsDirectory.path
              ) == .orderedSame,
              resolvedConfigParent.path.caseInsensitiveCompare(
                  resolvedBotDirectory.path
              ) == .orderedSame,
              directoryName == persisted.appSlug
                || isNumberedNewBotDirectory(
                    directoryName,
                    appSlug: persisted.appSlug
                )
        else {
            return nil
        }
        let configPathIsOwned = accountWorkspaceCatalog.accounts
            .flatMap(\.bots)
            .compactMap(\.localConfigPath)
            .contains(where: {
                dependencies.fileWriter.pathsReferToSameFile(
                    URL(filePath: $0),
                    configURL
                )
            })
        guard !configPathIsOwned else {
            return nil
        }

        return DesktopNewBotPlan(
            accountID: account.id,
            bot: DesktopBotInstallation(
                id: persisted.botID,
                appID: 0,
                appSlug: persisted.appSlug,
                mode: .byo,
                githubInstallationID: nil,
                githubAccountLogin: nil,
                status: .pending,
                localConfigPath: configURL.path
            )
        )
    }

    private func persistPendingNewBotPlan(_ plan: DesktopNewBotPlan) {
        guard let configPath = plan.bot.localConfigPath,
              let data = try? JSONEncoder().encode(PersistedPendingNewBotPlan(
                schemaVersion: 1,
                accountID: plan.accountID,
                botID: plan.bot.id,
                appSlug: plan.bot.appSlug,
                configPath: configPath
              )),
              let serialized = String(data: data, encoding: .utf8)
        else {
            dependencies.preferences.removeValue(
                forKey: pendingNewBotPlanPreferenceKey
            )
            return
        }
        dependencies.preferences.set(
            serialized,
            forKey: pendingNewBotPlanPreferenceKey
        )
    }

    private func isNumberedNewBotDirectory(
        _ directoryName: String,
        appSlug: String
    ) -> Bool {
        let prefix = appSlug + "-"
        guard directoryName.hasPrefix(prefix),
              let suffix = Int(directoryName.dropFirst(prefix.count))
        else {
            return false
        }
        return suffix >= 2 && directoryName == "\(prefix)\(suffix)"
    }

    #if DEBUG
    package func applyInitialState(_ state: DesktopModelInitialState) {
        selectedSection = state.selectedSection
        configPath = state.configPath
        cliPath = state.cliPath
        status = state.status
        repos = state.repos
        providers = state.providers
        providers.providerKeyStored = state.providers.providerKeyStored
        license = state.license
        github = state.github
        githubAuthorizationStatus = state.githubAuthorizationStatus
        logText = state.logText
        onboardingFlow = state.onboardingFlow
        isOnboardingPresented = state.isOnboardingPresented
        providerVerification = state.providerVerification
        providerVerificationStatus = state.providerVerificationStatus
        isProviderVerificationInProgress = state.providerVerificationInProgress
        isProviderVerificationCancelling = false
        providerVerificationSafetyLatchMessage = nil
        previewedProviderSnapshot = nil
        previewedProviderExpectedRevision = nil
        if state.providers.registryTargets.isEmpty {
            providerLoadedSnapshot = nil
            providerLoadedRevision = nil
        } else {
            var loadedProviders = state.providers
            if state.providerConfigurationIsDirty {
                loadedProviders.selectedProviderModel += "-saved"
            }
            providerLoadedSnapshot = ProviderConfigurationSnapshot(
                providers: loadedProviders,
                configPath: configPath
            )
            providerLoadedRevision = state.providerVerification?.configRevision
                ?? String(repeating: "a", count: 64)
        }
        lastError = nil
        lastCommandLine = state.status.lastCommand
    }

    package func applyProviderVerificationVisualProofFixture() {
        selectedSection = .providers
        configPath = "/tmp/neondiff-visual-proof/config.local.json"
        cliPath = "neondiff"
        providers.zcodeModel = "glm-5"
        providers.zcodeCliPath = "/usr/local/bin/zcode"
        providers.zcodeAppConfigPath = "~/.config/zcode/config.json"
        providers.openAICompatibleEndpoint = "https://legacy-endpoint.invalid/v1"
        providers.selectedProviderId = "zcode-glm"
        providers.registryTargets = [
            ProviderRegistryTarget(
                id: "zcode-glm",
                displayName: "Z.AI GLM",
                enabled: true,
                adapter: "openai-compatible",
                authMode: "api-key-env",
                baseUrl: "https://api.z.ai/api/coding/paas/v4",
                model: "glm-5"
            )
        ]
        providers.providerKeyStored = true
        providerLoadedSnapshot = ProviderConfigurationSnapshot(
            providers: providers,
            configPath: configPath
        )
        providerLoadedRevision = String(repeating: "a", count: 64)
        providerVerification = ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-10T12:00:00Z",
            state: .healthy,
            mode: "openai_compatible_models",
            detail: "Provider responded with compatible model metadata. No secret value is retained.",
            troubleshooting: []
        )
        providerVerificationStatus = "Verified from redacted fixture metadata. No hosted request was made."
        isOnboardingPresented = false
    }
    #endif

    package var statusCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonStatus(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var dashboardCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var dashboardServerCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, openBrowser: false)
    }

    package var startDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var stopDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var startDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    package var stopDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    package var configInspectCommand: DesktopCommand {
        NeonDiffCommandBuilder.configInspect(cliPath: cliPath, configPath: configPath)
    }

    package var configInitializeCommand: DesktopCommand {
        NeonDiffCommandBuilder.configInitialize(cliPath: cliPath, configPath: configPath)
    }

    package var providerPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: providerPatchPath.path,
            expectedRevision: providerLoadedRevision
        )
    }

    package var providerPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: providerPatchPath.path,
            dryRun: false,
            expectedRevision: previewedProviderExpectedRevision
        )
    }

    package var repoSelectionPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path)
    }

    package var repoSelectionPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path, dryRun: false)
    }

    package var controlCenterPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            expectedRevision: controlCenterLoadedRevision
        )
    }

    package var controlCenterPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            dryRun: false,
            expectedRevision: previewedControlCenterExpectedRevision
        )
    }

    package var controlCenterRollbackCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterRollbackPath.path,
            dryRun: false,
            expectedRevision: controlCenterRollbackExpectedRevision
        )
    }

    package var controlCenterValidationError: String? {
        DesktopControlCenterPatchBuilder.validationError(for: controlCenter)
    }

    package var canPreviewControlCenter: Bool {
        controlCenterLoadedSnapshot?.configPath == configPath
            && controlCenterLoadedRevision != nil
            && controlCenterValidationError == nil
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canApplyControlCenter: Bool {
        canPreviewControlCenter
            && previewedControlCenterSnapshot == currentControlCenterSnapshot
            && previewedControlCenterBaseline?.configPath == configPath
            && previewedControlCenterExpectedRevision != nil
    }

    package var canRollbackControlCenter: Bool {
        controlCenterRollbackSnapshot?.configPath == configPath
            && controlCenterRollbackExpectedRevision != nil
            && controlCenterLoadedRevision == controlCenterRollbackExpectedRevision
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canVerifyProviderKey: Bool {
        providers.providerKeyStored
            && providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true
            && providerLoadedRevision != nil
            && providerLoadedSnapshot == currentProviderConfigurationSnapshot
            && previewedProviderSnapshot == nil
            && !isProviderVerificationInProgress
            && !isProviderVerificationCancelling
            && providerVerificationSafetyLatchMessage == nil
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canEditProviderConfiguration: Bool {
        !isSetupMutationBlocked
            && !isProviderVerificationInProgress
            && !isProviderVerificationCancelling
            && providerVerificationSafetyLatchMessage == nil
    }

    package var canPreviewProviderConfig: Bool {
        canEditProviderConfiguration
            && providerLoadedSnapshot?.configPath == configPath
            && providerLoadedRevision != nil
            && providerLoadedSnapshot != nil
            && providerLoadedSnapshot != desiredProviderConfigurationSnapshot
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canApplyProviderConfig: Bool {
        canEditProviderConfiguration
            && previewedProviderSnapshot == desiredProviderConfigurationSnapshot
            && previewedProviderExpectedRevision == providerLoadedRevision
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var providerVerificationButtonTitle: String {
        isProviderVerificationCancelling ? "Cancelling…" : (isProviderVerificationInProgress ? "Verifying…" : "Verify API Key")
    }

    private var currentProviderConfigurationSnapshot: ProviderConfigurationSnapshot {
        ProviderConfigurationSnapshot(providers: providers, configPath: configPath)
    }

    /// The provider registry and ZCode app config use distinct identifier
    /// namespaces. Preserve the execution binding loaded from ZCode instead of
    /// inventing one from the selected NeonDiff registry entry.
    private var desiredProviderConfigurationSnapshot: ProviderConfigurationSnapshot {
        ProviderConfigurationSnapshot(providers: providers, configPath: configPath)
    }

    private var currentControlCenterSnapshot: DesktopControlCenterSnapshot {
        DesktopControlCenterSnapshot(settings: controlCenter, configPath: configPath)
    }

    package var githubAppInstallURL: URL {
        GitHubAppInstallLink.url(botLogin: github.botLogin) ?? GitHubAppInstallLink.publicAppURL
    }

    package var githubRecoveryActionTitle: String {
        switch githubRecovery?.action {
        case .reconnect: "Reconnect GitHub"
        case .retryLater, .retry: "Retry Repository Discovery"
        case .installOrManageApp: "Install / Manage App"
        case .contactOrganizationOwner: "Manage App Access"
        case nil: "Retry"
        }
    }

    package var githubRecoveryShowsAction: Bool {
        githubRecovery?.action != .contactOrganizationOwner
    }

    package func persistLocalSettings() {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        dependencies.preferences.set(configPath, forKey: Self.configPathPreferenceKey)
        dependencies.preferences.set(cliPath, forKey: "neondiff.cliPath")
        dependencies.preferences.set(launchdLabel, forKey: "neondiff.launchdLabel")
        if controlCenterLoadedSnapshot?.configPath != configPath {
            previewedControlCenterSnapshot = nil
            previewedControlCenterBaseline = nil
            previewedControlCenterExpectedRevision = nil
            controlCenterStatus = "Config path changed. Load current config before editing."
        }
    }

    package func refreshStatus() {
        persistLocalSettings()
        statusRefreshFailureMessage = nil
        runCLI(arguments: ["daemon", "status", "--config", configPath, "--launchd-label", launchdLabel], displayCommand: statusCommand)
    }

    package func openDashboard() {
        launchDashboard(openBrowser: true)
    }

    package func startDashboardServer() {
        launchDashboard(openBrowser: false)
    }

    private func launchDashboard(openBrowser: Bool) {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            dashboardLaunchStatus = "restart required"
            return
        }
        persistLocalSettings()
        let command = openBrowser ? dashboardCommand : dashboardServerCommand
        lastCommandLine = command.commandLine
        dashboardLaunchStatus = openBrowser ? "opening browser" : "starting server"
        let executablePath = cliPath
        let arguments = NeonDiffCommandBuilder.dashboardArguments(
            configPath: configPath,
            launchdLabel: launchdLabel,
            openBrowser: openBrowser
        )
        let dashboard = dependencies.dashboard
        let workingDirectory = dependencies.cliWorkingDirectory

        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await dashboard.launch(
                    executablePath: executablePath,
                    arguments: arguments,
                    workingDirectory: workingDirectory
                )
                self.dashboardProcessIdentifier = result.processIdentifier
                self.dashboardLaunchStatus = openBrowser
                    ? "launched pid \(result.processIdentifier); browser opens the local HTML dashboard"
                    : "launched pid \(result.processIdentifier); local dashboard server started"
                self.lastError = nil
                self.logText = openBrowser
                    ? "Started NeonDiff local dashboard from the desktop launcher and opened the browser dashboard."
                    : "Started NeonDiff local dashboard server from the desktop launcher without opening a browser tab."
            } catch {
                self.dashboardProcessIdentifier = nil
                self.dashboardLaunchStatus = "failed"
                self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                self.logText = self.lastError ?? "Unknown dashboard launch error"
            }
        }
    }

    package func previewStartDaemon() {
        guard requireProductionDaemonStartAuthorization() else { return }
        if keychainWorkerLaunchAgentActive
            || (!existingLocalAgentAccessAvailable
                && keychainWorkerLaunchAgentInstallAvailable)
        {
            previewKeychainWorkerLaunchAgent()
            return
        }
        runCLI(arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: startDaemonDryRunCommand)
    }

    package func previewStopDaemon() {
        guard requireProductionDaemonStopAuthorization() else { return }
        runCLI(arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: stopDaemonDryRunCommand)
    }

    package func startDaemon() {
        guard requireProductionDaemonStartAuthorization() else { return }
        if keychainWorkerLaunchAgentActive
            || (!existingLocalAgentAccessAvailable
                && keychainWorkerLaunchAgentInstallAvailable)
        {
            installAndStartKeychainWorkerLaunchAgent()
            return
        }
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: startDaemonCommand
        )
    }

    package func checkLocalWorkerReviewCompatibility() {
        guard existingLocalAgentAccessAvailable else {
            invalidateLocalWorkerReviewCompatibility()
            scopedReviewStatus =
                "Connect a verified local NeonDiff agent before checking review compatibility."
            return
        }

        localWorkerCompatibilityTask?.cancel()
        let expectedConfigPath = configPath
        let expectedCLIPath = cliPath
        let expectedWorkspaceGeneration = workspaceContextGeneration
        let cli = dependencies.cli
        localWorkerReviewCompatibility = .checking
        scopedReviewStatus =
            "Checking whether the selected local worker supports exact dry-to-live review…"

        localWorkerCompatibilityTask = Task { [weak self] in
            do {
                let result = try await cli.run(
                    executablePath: expectedCLIPath,
                    arguments: [
                        "review-pr",
                        "--help",
                        "--config",
                        expectedConfigPath
                    ],
                    standardInput: nil,
                    timeout: 15
                )
                guard let self, !Task.isCancelled,
                      self.workspaceContextGeneration == expectedWorkspaceGeneration,
                      self.configPath == expectedConfigPath,
                      self.cliPath == expectedCLIPath
                else {
                    return
                }
                self.localWorkerCompatibilityTask = nil
                let report = result.exitCode == 0
                    ? DesktopLocalWorkerReviewCapabilityReport.parse(
                        result.stdout
                    )
                    : nil
                if let report, report.supportsExactDryToLiveReview {
                    self.localWorkerReviewCompatibility = .compatible(
                        packageVersion: report.licenseBoundary?.packageVersion
                    )
                    self.lastError = nil
                    self.scopedReviewStatus =
                        "Local worker supports exact config-revision dry and live review."
                } else {
                    self.localWorkerReviewCompatibility = .incompatible
                    self.invalidateScopedReviewApproval(preserveStatus: true)
                    self.lastError =
                        "This local NeonDiff worker must be updated before reviews can run."
                    self.scopedReviewStatus =
                        "Worker update required. View the update steps, then retry this check."
                }
            } catch {
                guard let self, !Task.isCancelled,
                      self.workspaceContextGeneration == expectedWorkspaceGeneration,
                      self.configPath == expectedConfigPath,
                      self.cliPath == expectedCLIPath
                else {
                    return
                }
                self.localWorkerCompatibilityTask = nil
                self.localWorkerReviewCompatibility = .incompatible
                self.invalidateScopedReviewApproval(preserveStatus: true)
                self.lastError =
                    "The local worker compatibility check failed safely."
                self.scopedReviewStatus =
                    "Worker check failed. View the update steps or retry the check."
            }
        }
    }

    package func openLocalWorkerUpdateGuide() {
        if dependencies.localBotDiscoveryProvider != nil {
            refreshLocalBotDiscovery()
            if localWorkerCLIAvailable {
                lastError = nil
                return
            }
        } else if let localWorkerExecutionContextProvider {
            currentLocalWorkerExecutionContexts =
                localWorkerExecutionContextProvider()
            if localWorkerCLIAvailable {
                lastError = nil
                return
            }
        }
        guard dependencies.urlOpener.open(dependencies.localWorkerUpdateGuideURL) else {
            lastError = "NeonDiff could not open the local worker installer guide."
            return
        }
        lastError = nil
    }

    private func previewKeychainWorkerLaunchAgent() {
        guard let request = keychainWorkerLaunchAgentRequest() else {
            return
        }
        let manager = dependencies.keychainWorkerLaunchAgentManager
        isKeychainWorkerLaunchAgentOperationInProgress = true
        keychainWorkerLaunchAgentStatus =
            "Validating the signed app, selected config, and sealed worker…"
        Task { [weak self] in
            do {
                let status = try await manager.preview(request: request)
                guard let self else { return }
                self.isKeychainWorkerLaunchAgentOperationInProgress = false
                self.keychainWorkerLaunchAgentStatus = status
                self.lastError = nil
            } catch {
                guard let self else { return }
                self.isKeychainWorkerLaunchAgentOperationInProgress = false
                self.lastError = NeonDiffRedactor.redact(
                    error.localizedDescription
                )
                self.keychainWorkerLaunchAgentStatus =
                    self.lastError ?? "Worker LaunchAgent preview failed."
            }
        }
    }

    private func installAndStartKeychainWorkerLaunchAgent() {
        guard let request = keychainWorkerLaunchAgentRequest() else {
            return
        }
        let manager = dependencies.keychainWorkerLaunchAgentManager
        isKeychainWorkerLaunchAgentOperationInProgress = true
        keychainWorkerLaunchAgentStatus =
            "Installing and starting the secret-free local review worker…"
        Task { [weak self] in
            do {
                let status = try await manager.installAndStart(
                    request: request
                )
                guard let self else { return }
                self.refreshLocalBotDiscovery()
                self.isKeychainWorkerLaunchAgentOperationInProgress = false
                self.keychainWorkerLaunchAgentStatus = status
                self.lastError = nil
                self.onboardingFlow.daemonBootstrapChecked = true
                self.checkLocalWorkerReviewCompatibility()
            } catch {
                guard let self else { return }
                self.isKeychainWorkerLaunchAgentOperationInProgress = false
                self.lastError = NeonDiffRedactor.redact(
                    error.localizedDescription
                )
                self.keychainWorkerLaunchAgentStatus =
                    self.lastError ?? "Worker LaunchAgent install failed."
                self.onboardingFlow.daemonBootstrapChecked = false
            }
        }
    }

    private func keychainWorkerLaunchAgentRequest()
        -> DesktopKeychainWorkerLaunchAgentRequest?
    {
        guard let appID = storedBYOGitHubAppId else {
            lastError =
                "Store and verify the customer-owned GitHub App before installing the worker service."
            keychainWorkerLaunchAgentStatus =
                lastError ?? "GitHub App setup required."
            return nil
        }
        guard let licenseMachineID = try? GitHubBrokerDeviceIdentityStore(
            secretStore: dependencies.secretStore
        ).loadExisting(allowUserInteraction: false).deviceId else {
            lastError =
                "The saved activation device identity is unavailable. Reconnect or reactivate before installing the worker service."
            keychainWorkerLaunchAgentStatus =
                lastError ?? "Activation device identity required."
            return nil
        }
        let homeDirectory = dependencies.fileWriter
            .applicationSupportDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        do {
            return try DesktopKeychainWorkerLaunchAgentRequest(
                appID: appID,
                licenseMachineID: licenseMachineID,
                configPath: configPath,
                launchdLabel: launchdLabel,
                homeDirectory: homeDirectory
            )
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            keychainWorkerLaunchAgentStatus =
                lastError ?? "The worker coordinates are invalid."
            return nil
        }
    }

    private func refreshLocalBotDiscovery() {
        guard let provider = dependencies.localBotDiscoveryProvider else {
            return
        }
        let snapshot = provider(launchdLabel)
        currentLocalBotConfigurations = snapshot.configurations
        currentLocalWorkerExecutionContexts = snapshot.executionContexts
        currentLocalBotExecutionConfigPaths = snapshot.executionContexts
            .map(\.configPath)
            .filter { !$0.isEmpty }
    }

    private var runtimeCredentialsForReviewRequired: Bool {
        dependencies.productionBoundary.byoGitHubEnabled
            && byoGitHubCredentialsStored
            && (
                !existingLocalAgentAccessAvailable
                    || keychainWorkerLaunchAgentActive
            )
    }

    private func runtimeCredentialsForReview() -> Data? {
        guard runtimeCredentialsForReviewRequired,
              byoGitHubCredentialsVerified,
              let appID = storedBYOGitHubAppId
        else {
            return nil
        }
        do {
            guard let privateKey = try dependencies.secretStore.readSecret(
                account: BYOGitHubAppKeychainAccount.privateKey,
                allowUserInteraction: false
            ),
            let licenseKey = try dependencies.secretStore.readSecret(
                account: activationKeyAccount,
                allowUserInteraction: false
            ),
            let licenseMachineID = try? GitHubBrokerDeviceIdentityStore(
                secretStore: dependencies.secretStore
            ).loadExisting(allowUserInteraction: false).deviceId else {
                throw BYOGitHubAppCredentialError.invalidPrivateKey
            }
            return try DesktopRuntimeCredentialEnvelope(
                appID: appID,
                privateKey: privateKey,
                licenseKey: licenseKey,
                licenseMachineID: licenseMachineID
            ).encodedData()
        } catch {
            lastError =
                "The GitHub App or API-backed activation credential could not be read safely from Keychain."
            scopedReviewStatus =
                "Review blocked before worker execution because Keychain access failed."
            return nil
        }
    }

    package func runScopedDryReview() {
        guard requireScopedReviewAuthorization() else { return }
        guard !isScopedReviewInProgress else { return }
        guard let repository = selectedReviewRepository,
              let pullNumber = positivePendingReviewPullNumber,
              let configRevision = providerLoadedRevision
        else {
            lastError = positivePendingReviewPullNumber == nil
                ? "Enter a positive pull request number."
                : "Reload the selected configuration before running a review."
            scopedReviewStatus = lastError ?? "Review setup required"
            return
        }

        let context = ScopedReviewApproval(
            repo: repository,
            pullNumber: pullNumber,
            headSHA: "",
            configPath: configPath,
            configRevision: configRevision,
            workspaceGeneration: workspaceContextGeneration,
            workerCompatibilityGeneration:
                localWorkerReviewCompatibilityGeneration
        )
        let runtimeCredentials = runtimeCredentialsForReview()
        if runtimeCredentialsForReviewRequired,
           runtimeCredentials == nil {
            return
        }
        var arguments = [
            "review-pr",
            "--config", configPath,
            "--repo", repository,
            "--pr", String(pullNumber),
            "--expected-config-revision", configRevision,
            "--dry-run", "true",
            "--zcode", "true"
        ]
        if runtimeCredentials != nil {
            arguments += [
                "--runtime-credentials-stdin", "true"
            ]
        }
        var standardInput = runtimeCredentials
        let executablePath = cliPath
        let cli = dependencies.cli
        invalidateScopedReviewApproval()
        isScopedReviewInProgress = true
        lastError = nil
        scopedReviewStatus =
            "Running a dry review for \(repository)#\(pullNumber)…"
        lastCommandLine = [
            shellQuote(cliPath), "review-pr",
            "--config", shellQuote(configPath),
            "--repo", shellQuote(repository),
            "--pr", String(pullNumber),
            "--expected-config-revision", shellQuote(configRevision),
            "--dry-run true --zcode true"
        ].joined(separator: " ")

        scopedReviewTask = Task.detached {
            defer {
                if let count = standardInput?.count {
                    standardInput?.resetBytes(in: 0..<count)
                }
            }
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: standardInput,
                    timeout: 600
                )
                await MainActor.run {
                    self.applyScopedDryReviewResult(
                        result,
                        expectedContext: context
                    )
                }
            } catch {
                await MainActor.run {
                    guard self.isCurrentWorkspace(
                        context.workspaceGeneration
                    ) else { return }
                    self.isScopedReviewInProgress = false
                    self.scopedReviewTask = nil
                    self.invalidateScopedReviewApproval()
                    self.lastError = "The scoped dry review failed safely."
                    self.scopedReviewStatus =
                        "Dry review failed. No GitHub review was posted."
                }
            }
        }
    }

    package func runScopedLiveReview() {
        guard requireScopedReviewAuthorization() else { return }
        guard scopedLiveReviewConfirmationAvailable,
              let approval = scopedDryRunApproval
        else {
            lastError =
                "Run a successful dry review for this exact repository and pull request before posting."
            scopedReviewStatus = lastError ?? "Dry review required"
            return
        }

        let runtimeCredentials = runtimeCredentialsForReview()
        if runtimeCredentialsForReviewRequired,
           runtimeCredentials == nil {
            return
        }
        var arguments = [
            "review-pr",
            "--config", approval.configPath,
            "--repo", approval.repo,
            "--pr", String(approval.pullNumber),
            "--head-sha", approval.headSHA,
            "--expected-config-revision", approval.configRevision,
            "--dry-run", "false",
            "--confirm", "true",
            "--zcode", "true"
        ]
        if runtimeCredentials != nil {
            arguments += [
                "--runtime-credentials-stdin", "true"
            ]
        }
        var standardInput = runtimeCredentials
        let executablePath = cliPath
        let cli = dependencies.cli
        isScopedReviewInProgress = true
        lastError = nil
        scopedReviewStatus =
            "Posting the approved review for \(approval.repo)#\(approval.pullNumber) at \(approval.headSHA.prefix(12))…"
        lastCommandLine = [
            shellQuote(cliPath), "review-pr",
            "--config", shellQuote(approval.configPath),
            "--repo", shellQuote(approval.repo),
            "--pr", String(approval.pullNumber),
            "--head-sha", shellQuote(approval.headSHA),
            "--expected-config-revision", shellQuote(approval.configRevision),
            "--dry-run false --confirm true --zcode true"
        ].joined(separator: " ")

        scopedReviewTask = Task.detached {
            defer {
                if let count = standardInput?.count {
                    standardInput?.resetBytes(in: 0..<count)
                }
            }
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: standardInput,
                    timeout: 600
                )
                await MainActor.run {
                    self.applyScopedLiveReviewResult(
                        result,
                        expectedApproval: approval
                    )
                }
            } catch {
                await MainActor.run {
                    guard self.isCurrentWorkspace(
                        approval.workspaceGeneration
                    ) else { return }
                    self.isScopedReviewInProgress = false
                    self.scopedReviewTask = nil
                    self.invalidateScopedReviewApproval()
                    self.lastError = "The scoped live review failed safely."
                    self.scopedReviewStatus =
                        "Live review failed. Check GitHub, then run a new dry review before retrying."
                }
            }
        }
    }

    package func stopDaemon() {
        guard requireProductionDaemonStopAuthorization() else { return }
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: stopDaemonCommand
        )
    }

    package func inspectConfig() {
        inspectConfig(allowDuringAccountRestore: false)
    }

    private func inspectConfig(allowDuringAccountRestore: Bool) {
        guard allowDuringAccountRestore || !isSetupMutationBlocked else {
            lastError = "Retry account verification before reading or changing local setup."
            return
        }
        guard !isProviderVerificationInProgress,
              !isProviderVerificationCancelling,
              providerVerificationSafetyLatchMessage == nil,
              !isConfigPatchInProgress,
              !isConfigInspectInProgress
        else {
            return
        }
        runCLI(
            arguments: ["config", "inspect", "--config", configPath],
            displayCommand: configInspectCommand,
            allowsSetupMutationDuringRestore: allowDuringAccountRestore
        )
    }

    package func initializeConfigForOnboarding() {
        guard byoGitHubCredentialOnboardingAvailable else {
            lastError = "Local config initialization is available only in the customer-owned GitHub App beta path."
            return
        }
        guard requireLocalWorkerCLI() else { return }
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        guard !isConfigInitializationInProgress, !isConfigPatchInProgress, !isConfigInspectInProgress else {
            lastError = "Another config operation is still running."
            return
        }
        configInitializationStatus = "Creating a new local config without overwriting existing data…"
        runCLI(
            arguments: ["init", "--config", configPath],
            displayCommand: configInitializeCommand
        )
    }

    package func addPendingIssueRepo() {
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        let repo = pendingIssueRepoName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isValidRepoName(repo) else {
            lastError = "Enter an issue-enrichment repository as owner/repo."
            return
        }
        if !controlCenter.issueAllowlist.contains(where: { $0.caseInsensitiveCompare(repo) == .orderedSame }) {
            controlCenter.issueAllowlist.append(repo)
            controlCenter.issueAllowlist.sort { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        }
        pendingIssueRepoName = ""
        lastError = nil
        controlCenterStatus = "Issue-enrichment allowlist changed locally; Preview is required before Apply."
    }

    package func removeIssueRepo(_ repo: String) {
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        controlCenter.issueAllowlist.removeAll { $0.caseInsensitiveCompare(repo) == .orderedSame }
        controlCenterStatus = "Issue-enrichment allowlist changed locally; Preview is required before Apply."
    }

    package func previewControlCenterPatch() {
        guard
            let baseline = controlCenterLoadedSnapshot,
            baseline.configPath == configPath,
            let expectedRevision = controlCenterLoadedRevision
        else {
            lastError = "Load current config before previewing control-center changes."
            return
        }
        let snapshot = currentControlCenterSnapshot
        let operation = ControlCenterOperation.preview(
            snapshot: snapshot,
            baseline: baseline,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(snapshot.settings, to: controlCenterPatchPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center patch generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterPatchPath.path,
                "--dry-run", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterPatchPreviewCommand
        )
    }

    package func applyControlCenterPatch() {
        guard
            let snapshot = previewedControlCenterSnapshot,
            let baseline = previewedControlCenterBaseline,
            let expectedRevision = previewedControlCenterExpectedRevision,
            snapshot == currentControlCenterSnapshot,
            baseline.configPath == configPath
        else {
            lastError = "Preview the current control-center settings before Apply."
            return
        }
        let operation = ControlCenterOperation.apply(
            snapshot: snapshot,
            baseline: baseline,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(snapshot.settings, to: controlCenterPatchPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center patch generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterPatchPath.path,
                "--dry-run", "false", "--confirm", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterPatchApplyCommand
        )
    }

    package func rollbackControlCenterPatch() {
        guard
            let rollback = controlCenterRollbackSnapshot,
            rollback.configPath == configPath,
            let expectedRevision = controlCenterRollbackExpectedRevision
        else {
            lastError = "No applied control-center change is available to roll back."
            return
        }
        let operation = ControlCenterOperation.rollback(
            snapshot: rollback,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(rollback.settings, to: controlCenterRollbackPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center rollback generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterRollbackPath.path,
                "--dry-run", "false", "--confirm", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterRollbackCommand
        )
    }

    package func previewProviderConfigPatch() {
        guard canPreviewProviderConfig else {
            lastError = "Load current config, make a provider change, then preview it."
            return
        }
        runProviderConfigPatch(dryRun: true)
    }

    package func applyProviderConfigPatch() {
        guard canApplyProviderConfig else {
            lastError = "Preview this exact provider configuration before applying it."
            return
        }
        runProviderConfigPatch(dryRun: false)
    }

    package func addPendingRepoToAllowlist() {
        guard !managedGitHubAvailable else {
            lastError = "Choose a repository from the verified GitHub App binding. Manual repository names are disabled in managed mode."
            return
        }
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        let repoName = pendingRepoName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isValidRepoName(repoName) else {
            lastError = "Enter a GitHub repository as owner/repo."
            return
        }
        if let index = repos.firstIndex(where: { $0.name.caseInsensitiveCompare(repoName) == .orderedSame }) {
            repos[index].enabled = true
        } else if let removedName = pendingRemovedRepoProfileNames.first(where: {
            $0.caseInsensitiveCompare(repoName) == .orderedSame
        }) {
            pendingRemovedRepoProfileNames.remove(removedName)
            repos.append(RepoMonitor(name: removedName, enabled: true, profile: "selected"))
            repos.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } else {
            repos.append(RepoMonitor(name: repoName, enabled: true, profile: "selected"))
            repos.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        pendingRepoName = ""
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    package func toggleRepoAllowlist(_ repo: RepoMonitor) {
        guard !managedGitHubAvailable else {
            lastError = "Managed mode keeps exactly one server-bound repository selected. Choose it from the verified repository list."
            return
        }
        guard canEditProviderConfiguration else {
            lastError = isSetupMutationBlocked
                ? "Retry account verification before changing repository setup."
                : (providerVerificationSafetyLatchMessage
                    ?? "Wait for provider verification cleanup before changing config.")
            return
        }
        guard let index = repos.firstIndex(where: { $0.id == repo.id }) else { return }
        repos[index].enabled.toggle()
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    package func selectBYOReviewRepository(fullName: String) {
        guard byoGitHubCredentialOnboardingAvailable,
              !managedGitHubAvailable,
              let repository = repos.first(where: {
                  $0.enabled
                      && $0.name.caseInsensitiveCompare(fullName) == .orderedSame
              })
        else {
            lastError = "Choose an enabled repository from the applied worker configuration."
            return
        }
        guard isAppliedBYOReviewRepository(repository.name) else {
            lastError = "Apply and read back this repository in the current worker config before using it as the activation target."
            return
        }
        if activationState == .activationPending {
            lastError = "Activation is already in progress for \(selectedBYOReviewRepository ?? repository.name). Wait for it to finish or cancel before changing the target."
            return
        }
        if let activatedRepository,
           activatedRepository.caseInsensitiveCompare(repository.name)
               != .orderedSame {
            lastError = "This device activation is bound to \(activatedRepository). Target rebinding is not supported in this beta; keep that target selected until a verified deactivate/rebind flow is available."
            return
        }
        guard selectedBYOReviewRepository?.caseInsensitiveCompare(repository.name)
                != .orderedSame
        else {
            return
        }
        invalidateScopedReviewApproval()
        invalidateActivationForRepositoryChange()
        selectedBYOReviewRepository = repository.name
        dependencies.preferences.set(
            repository.name,
            forKey: byoReviewRepositoryKey
        )
        dependencies.preferences.set(
            configPath,
            forKey: byoReviewRepositoryConfigPathKey
        )
        lastError = nil
        logText = "\(repository.name) selected as the native review target. The existing worker allowlist was not changed."
    }

    package func canSelectBYOReviewRepository(fullName: String) -> Bool {
        guard byoGitHubCredentialOnboardingAvailable,
              !managedGitHubAvailable,
              repos.contains(where: {
                  $0.enabled
                      && $0.name.caseInsensitiveCompare(fullName) == .orderedSame
              }),
              isAppliedBYOReviewRepository(fullName),
              activationState != .activationPending
        else {
            return false
        }
        guard let activatedRepository else {
            return true
        }
        return activatedRepository.caseInsensitiveCompare(fullName)
            == .orderedSame
    }

    package func githubAccessCue(for repo: RepoMonitor) -> GitHubRepositoryAccessCue? {
        if managedGitHubAvailable,
           let authoritative = managedGitHubRepositories.first(where: {
               $0.fullName == repo.name
           }) {
            switch authoritative.visibility {
            case .public:
                return .publicFree
            case .private, .internal:
                return activationState == .active ? .licenseActive : .licenseRequired
            case .unknown:
                return .insufficientReadAccess
            }
        }
        guard let discovered = discoveredGitHubRepos.first(where: {
            $0.fullName.caseInsensitiveCompare(repo.name) == .orderedSame
        }) else {
            return nil
        }
        return GitHubRepositoryAccessPolicy.cue(for: discovered, licenseEntitlement: license.entitlement)
    }

    package func removeRepoFromAllowlist(_ repo: RepoMonitor) {
        guard !managedGitHubAvailable else {
            lastError = "Managed mode repository scope comes from the verified GitHub App binding."
            return
        }
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        repos.removeAll { $0.id == repo.id }
        pendingRemovedRepoProfileNames.insert(repo.name)
        lastError = nil
        logText = "Repo removed locally. Preview or apply the config patch to persist it."
    }

    package func startGitHubAuthorization() {
        guard !isGitHubRepositoryRefreshInProgress else { return }
        guard let clientId = github.clientId?.trimmingCharacters(in: .whitespacesAndNewlines), !clientId.isEmpty else {
            lastError = "Set the public GitHub App client ID before connecting GitHub."
            githubAuthorizationStatus = "client id missing"
            return
        }
        githubAuthorizationTask?.cancel()
        githubAuthorizationCode = nil
        isGitHubAuthorizationInProgress = true
        githubAuthorizationStatus = "requesting device code"
        githubRecovery = nil
        lastError = nil
        let requestWorkspaceGeneration = workspaceContextGeneration
        githubAuthorizationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let code = try await dependencies.githubAuthenticator.requestDeviceCode(clientId: clientId)
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                githubAuthorizationCode = code
                githubAuthorizationStatus = "enter code \(code.userCode)"
                github.installationState = "waiting for GitHub authorization"
                logText = "Open \(code.verificationURI.absoluteString) and enter code \(code.userCode)."
                await pollGitHubAuthorization(
                    clientId: clientId,
                    code: code,
                    workspaceGeneration: requestWorkspaceGeneration
                )
            } catch {
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                isGitHubAuthorizationInProgress = false
                applyGitHubFailure(error, fallbackStatus: "authorization failed")
            }
        }
    }

    package func cancelGitHubAuthorization() {
        githubAuthorizationTask?.cancel()
        githubAuthorizationTask = nil
        isGitHubAuthorizationInProgress = false
        githubAuthorizationCode = nil
        githubAuthorizationStatus = "cancelled"
        github.installationState = github.userTokenStored ? "user authorized" : "not connected"
    }

    package func copyGitHubUserCode() {
        guard let userCode = githubAuthorizationCode?.userCode else { return }
        guard dependencies.clipboard.write(userCode) else {
            githubAuthorizationStatus = "device code copy failed"
            lastError = "Could not copy the GitHub device code. Copy it manually and retry."
            return
        }
        githubAuthorizationStatus = "code copied"
        lastError = nil
    }

    package func openGitHubDeviceVerification() {
        guard let verificationURI = githubAuthorizationCode?.verificationURI else { return }
        guard dependencies.urlOpener.open(verificationURI) else {
            githubAuthorizationStatus = "verification page open failed"
            lastError = "Could not open the GitHub verification page. Open the shown URL manually."
            return
        }
        githubAuthorizationStatus = "verification page opened"
        lastError = nil
    }

    package func openGitHubAppInstallation() {
        guard dependencies.urlOpener.open(githubAppInstallURL) else {
            githubAuthorizationStatus = "App installation page open failed"
            lastError = "Could not open the GitHub App installation page. Open it manually in your browser."
            return
        }
        githubAuthorizationStatus = "App installation page opened"
        lastError = nil
    }

    package func performGitHubRecoveryAction() {
        switch githubRecovery?.action {
        case .reconnect:
            startGitHubAuthorization()
        case .retryLater, .retry:
            refreshGitHubRepositories()
        case .installOrManageApp:
            openGitHubAppInstallation()
        case .contactOrganizationOwner:
            logText = githubRecovery?.message ?? "Ask an organization owner to approve GitHub App access."
        case nil:
            refreshGitHubRepositories()
        }
    }

    package func refreshGitHubRepositories() {
        guard !isGitHubRepositoryRefreshInProgress, !isGitHubAuthorizationInProgress else { return }
        githubRepositoryRefreshTask?.cancel()
        let requestGeneration = githubRepositoryRefreshGate.begin()
        let requestWorkspaceGeneration = workspaceContextGeneration
        isGitHubRepositoryRefreshInProgress = true
        githubRepositoryRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if githubRepositoryRefreshGate.isCurrent(requestGeneration) {
                    isGitHubRepositoryRefreshInProgress = false
                    githubRepositoryRefreshTask = nil
                }
            }
            do {
                githubAuthorizationStatus = "refreshing repositories"
                githubRecovery = nil
                let accessToken = try await gitHubAccessTokenForAPI(
                    workspaceGeneration: requestWorkspaceGeneration
                )
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                let user = try await dependencies.githubAuthenticator.fetchCurrentUser(accessToken: accessToken)
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                let discovered = try await dependencies.githubAuthenticator.listAccessibleRepositories(accessToken: accessToken)
                guard !Task.isCancelled, githubRepositoryRefreshGate.isCurrent(requestGeneration) else { return }
                applyGitHubDiscovery(user: user, discovered: discovered)
            } catch {
                guard !Task.isCancelled, githubRepositoryRefreshGate.isCurrent(requestGeneration) else { return }
                if error is GitHubDesktopAuthorizationStateError {
                    lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    logText = lastError ?? "Reconnect GitHub."
                    githubRecovery = GitHubConnectionRecovery(
                        status: "reconnect required",
                        message: lastError ?? "Reconnect GitHub before refreshing repositories.",
                        action: .reconnect
                    )
                    return
                }
                applyGitHubFailure(error, fallbackStatus: "repository refresh failed")
            }
        }
    }

    package func startManagedGitHubConnection() {
        guard let broker = dependencies.githubBroker,
              dependencies.productionBoundary.managedGitHubBrokerOrigin != nil
        else {
            managedGitHubConnectionState = .quarantined
            managedGitHubRecovery = GitHubConnectionRecovery(
                status: "managed GitHub unavailable",
                message: "Managed GitHub authorization is not enabled in this signed build.",
                action: .retryLater
            )
            lastError = managedGitHubRecovery?.message
            return
        }
        guard !isManagedGitHubConnectionInProgress else { return }

        managedGitHubConnectionTask?.cancel()
        isManagedGitHubConnectionInProgress = true
        managedGitHubConnectionState = .connecting
        managedGitHubRecovery = nil
        managedGitHubRepositories = []
        managedGitHubRepositoriesVerifiedAt = nil
        managedGitHubInstallationCandidates = []
        pendingManagedGitHubAuthorization = nil
        githubAuthorizationCode = nil
        selectedManagedGitHubRepository = nil
        lastError = nil

        let requestWorkspaceGeneration = workspaceContextGeneration
        managedGitHubConnectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if workspaceContextGeneration == requestWorkspaceGeneration {
                    isManagedGitHubConnectionInProgress = false
                    managedGitHubConnectionTask = nil
                }
            }
            do {
                let identity = try GitHubBrokerDeviceIdentityStore(
                    secretStore: dependencies.secretStore
                ).loadOrCreate()
                try await broker.register(identity: identity)
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                let connection = try await broker.startConnection(identity: identity)
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                guard dependencies.urlOpener.open(connection.installURL) else {
                    throw ManagedGitHubModelError.installPageOpenFailed
                }
                managedGitHubConnectionState = .awaitingAuthorization
                logText = "GitHub App installation opened. Complete authorization in GitHub; NeonDiff is waiting for the server binding."
                let installationId: Int
                switch try await broker.completeConnection(
                    identity: identity,
                    state: connection.state
                ) {
                case .bound(let callbackInstallationId):
                    installationId = callbackInstallationId
                case .pending:
                    guard let existingInstallationId = try await authorizeExistingManagedGitHubInstallation(
                        broker: broker,
                        identity: identity,
                        connection: connection,
                        workspaceGeneration: requestWorkspaceGeneration
                    ) else {
                        return
                    }
                    installationId = existingInstallationId
                }
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                dependencies.preferences.set(
                    String(installationId),
                    forKey: managedGitHubInstallationIdKey
                )
                try await loadManagedGitHubRepositories(
                    broker: broker,
                    identity: identity,
                    installationId: installationId,
                    workspaceGeneration: requestWorkspaceGeneration
                )
            } catch {
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                applyManagedGitHubFailure(error)
            }
        }
    }

    package func selectManagedGitHubInstallation(installationId: Int) {
        guard managedGitHubConnectionState == .installationSelectionRequired,
              !isManagedGitHubConnectionInProgress,
              let broker = dependencies.githubBroker,
              let pending = pendingManagedGitHubAuthorization,
              pending.candidates.contains(where: { $0.installationId == installationId })
        else {
            lastError = "Choose one of the GitHub App installations verified for this authorization."
            return
        }

        isManagedGitHubConnectionInProgress = true
        managedGitHubConnectionState = .connecting
        managedGitHubRecovery = nil
        lastError = nil
        let requestWorkspaceGeneration = workspaceContextGeneration
        managedGitHubConnectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if workspaceContextGeneration == requestWorkspaceGeneration {
                    pendingManagedGitHubAuthorization = nil
                    githubAuthorizationCode = nil
                    isManagedGitHubConnectionInProgress = false
                    managedGitHubConnectionTask = nil
                }
            }
            do {
                let boundInstallationId: Int
                switch try await broker.completeConnection(
                    identity: pending.identity,
                    state: pending.connection.state
                ) {
                case .bound(let callbackInstallationId):
                    boundInstallationId = callbackInstallationId
                case .pending:
                    boundInstallationId = try await authorizeExistingInstallationWithReplayReadback(
                        broker: broker,
                        identity: pending.identity,
                        connection: pending.connection,
                        installationId: installationId,
                        userAccessToken: pending.userAccessToken
                    )
                }
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                managedGitHubInstallationCandidates = []
                dependencies.preferences.set(
                    String(boundInstallationId),
                    forKey: managedGitHubInstallationIdKey
                )
                try await loadManagedGitHubRepositories(
                    broker: broker,
                    identity: pending.identity,
                    installationId: boundInstallationId,
                    workspaceGeneration: requestWorkspaceGeneration
                )
            } catch {
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                managedGitHubInstallationCandidates = []
                applyManagedGitHubFailure(error)
            }
        }
    }

    package func refreshManagedGitHubRepositories() {
        guard let broker = dependencies.githubBroker,
              dependencies.productionBoundary.managedGitHubBrokerOrigin != nil,
              let installationId = Self.savedManagedGitHubInstallationId(
                preferences: dependencies.preferences
              )
        else {
            managedGitHubConnectionState = .quarantined
            managedGitHubRecovery = GitHubConnectionRecovery(
                status: "connection required",
                message: "Connect GitHub before refreshing server-bound repositories.",
                action: .reconnect
            )
            lastError = managedGitHubRecovery?.message
            return
        }
        guard !isManagedGitHubConnectionInProgress else { return }

        managedGitHubConnectionTask?.cancel()
        isManagedGitHubConnectionInProgress = true
        managedGitHubConnectionState = .verificationRequired
        invalidateRepoApplicationProof()
        managedGitHubRecovery = nil
        managedGitHubRepositories = []
        managedGitHubRepositoriesVerifiedAt = nil
        selectedManagedGitHubRepository = nil
        lastError = nil

        let requestWorkspaceGeneration = workspaceContextGeneration
        managedGitHubConnectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if workspaceContextGeneration == requestWorkspaceGeneration {
                    isManagedGitHubConnectionInProgress = false
                    managedGitHubConnectionTask = nil
                }
            }
            do {
                let identity = try GitHubBrokerDeviceIdentityStore(
                    secretStore: dependencies.secretStore
                ).loadExisting()
                try await loadManagedGitHubRepositories(
                    broker: broker,
                    identity: identity,
                    installationId: installationId,
                    workspaceGeneration: requestWorkspaceGeneration
                )
            } catch {
                guard isCurrentWorkspace(requestWorkspaceGeneration) else { return }
                applyManagedGitHubFailure(error)
            }
        }
    }

    package func selectManagedGitHubRepository(fullName: String) {
        guard case .bound = managedGitHubConnectionState,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == fullName
              })
        else {
            lastError = "Refresh the server-bound GitHub repositories before selecting one."
            return
        }
        guard repository.visibility != .unknown else {
            lastError = "GitHub repository visibility is unavailable. NeonDiff fails closed until the broker returns authoritative visibility."
            return
        }

        invalidateRepoApplicationProof()
        selectedManagedGitHubRepository = repository.fullName
        for index in repos.indices {
            repos[index].enabled = false
        }
        if let index = repos.firstIndex(where: { $0.name == repository.fullName }) {
            repos[index].enabled = true
            repos[index].profile = repository.visibility.rawValue
        } else {
            repos.append(RepoMonitor(
                name: repository.fullName,
                enabled: true,
                profile: repository.visibility.rawValue,
                lastReview: "selected through managed GitHub broker"
            ))
            repos.sort {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        }

        switch repository.visibility {
        case .public:
            onboardingFlow.mode = .publicReposOnly
            enterActivation(for: .publicReposOnly)
            onboardingFlow.licenseActivation = .activated
        case .private, .internal:
            onboardingFlow.mode = .privateRepos
            if activationState == .active,
               !activationVerifiedThisLaunch
                || activationVerifiedRepositoryThisLaunch != repository.fullName {
                activationVerifiedThisLaunch = false
                activationVerifiedRepositoryThisLaunch = nil
                dependencies.preferences.set("", forKey: activationRepositoryKey)
                activationState = license.keyStored ? .keyReady : .purchaseRequired
                dependencies.preferences.set(activationState.rawValue, forKey: activationStateKey)
            }
            enterActivation(for: .privateRepos)
            onboardingFlow.licenseActivation = activationVerifiedThisLaunch
                    && activationState == .active
                    && activationVerifiedRepositoryThisLaunch == repository.fullName
                ? .activated
                : .servicePending
        case .unknown:
            break
        }
        managedGitHubRecovery = nil
        lastError = nil
        logText = "\(repository.fullName) selected from the authoritative GitHub App binding. Preview and apply the allowlist before review."
    }

    package func performManagedGitHubRecoveryAction() {
        switch managedGitHubRecovery?.action {
        case .installOrManageApp, .reconnect:
            startManagedGitHubConnection()
        case .retryLater, .retry:
            if Self.savedManagedGitHubInstallationId(preferences: dependencies.preferences) != nil {
                refreshManagedGitHubRepositories()
            } else {
                startManagedGitHubConnection()
            }
        case .contactOrganizationOwner:
            logText = managedGitHubRecovery?.message
                ?? "Ask an organization owner to approve the GitHub App installation."
        case nil:
            refreshManagedGitHubRepositories()
        }
    }

    package func previewRepoAllowlistPatch() {
        guard !managedGitHubAvailable || hasVerifiedManagedGitHubSelection else {
            lastError = "Verify the GitHub App binding and select exactly one server-bound repository before previewing the allowlist."
            return
        }
        runRepoSelectionPatch(dryRun: true)
    }

    package func applyRepoAllowlistPatch() {
        guard !managedGitHubAvailable || hasVerifiedManagedGitHubSelection else {
            lastError = "Verify the GitHub App binding and select exactly one server-bound repository before applying the allowlist."
            return
        }
        runRepoSelectionPatch(dryRun: false)
    }

    package func storeProviderKey() {
        guard !isSetupMutationBlocked else {
            lastError = "Retry account verification before changing provider setup."
            return
        }
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard let account = selectedProviderKeyAccount else {
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = "Select a valid provider before storing an API key."
            return
        }
        do {
            try dependencies.secretStore.setSecret(pendingProviderKey, account: account)
            pendingProviderKey = ""
            providerKeyRevision &+= 1
            invalidateProviderVerificationContext(status: "Stored key changed. Verify it when ready.")
            providers.providerKeyStored = true
            onboardingFlow.providerKeyStored = true
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func storeBYOGitHubAppCredentials() {
        defer { pendingBYOGitHubAppPrivateKey = "" }
        guard !isSetupMutationBlocked else {
            lastError = "Retry account verification before changing GitHub App setup."
            byoGitHubCredentialStatus = lastError ?? "Account check required"
            return
        }
        byoGitHubCredentialRevision &+= 1
        invalidateBYOGitHubVerificationContext()
        guard byoGitHubCredentialOnboardingAvailable else {
            lastError = "Customer-owned GitHub App onboarding is unavailable in this build."
            byoGitHubCredentialStatus = lastError ?? "Unavailable"
            return
        }

        do {
            let appId = try BYOGitHubAppCredentialValidator.normalizedAppId(
                pendingBYOGitHubAppId
            )
            let privateKey = try BYOGitHubAppCredentialValidator.normalizedPrivateKey(
                pendingBYOGitHubAppPrivateKey
            )
            try dependencies.secretStore.setSecret(
                privateKey,
                account: BYOGitHubAppKeychainAccount.privateKey
            )
            dependencies.preferences.set(appId, forKey: byoGitHubAppIdPreferenceKey)
            pendingBYOGitHubAppId = appId
            byoGitHubPrivateKeyStored = true
            lastError = nil
            byoGitHubCredentialStatus = "App ID stored; private key is in Keychain. Worker verification has not run yet."
            logText = "Customer-owned GitHub App credentials stored. The private key was not written to config or command arguments. Worker verification remains pending."
        } catch {
            byoGitHubPrivateKeyStored = dependencies.secretStore.containsSecret(
                account: BYOGitHubAppKeychainAccount.privateKey
            )
            lastError = error.localizedDescription
            byoGitHubCredentialStatus = "Credentials were not stored. Fix the App ID or private-key format and retry."
        }
    }

    package func clearBYOGitHubAppCredentials() {
        pendingBYOGitHubAppPrivateKey = ""
        guard !isSetupMutationBlocked else {
            pendingBYOGitHubAppId = ""
            lastError = "Retry account verification before changing GitHub App setup."
            byoGitHubCredentialStatus = lastError ?? "Account check required"
            return
        }
        pendingBYOGitHubAppId = ""
        byoGitHubCredentialRevision &+= 1
        invalidateBYOGitHubVerificationContext()
        do {
            try dependencies.secretStore.deleteSecret(
                account: BYOGitHubAppKeychainAccount.privateKey
            )
            dependencies.preferences.removeValue(forKey: byoGitHubAppIdPreferenceKey)
            byoGitHubPrivateKeyStored = false
            lastError = nil
            byoGitHubCredentialStatus = "Customer-owned GitHub App credentials are not stored."
            logText = "Customer-owned GitHub App credentials removed from this Mac."
        } catch {
            lastError = "The customer-owned GitHub App private key could not be removed from Keychain."
            byoGitHubCredentialStatus = lastError ?? "Removal failed"
        }
    }

    package func verifyBYOGitHubAppCredentials() {
        verifyBYOGitHubAppCredentials(
            repositoryScope: nil,
            source: .keychainStdin
        )
    }

    private func verifyBYOGitHubAppCredentials(
        repositoryScope: String?,
        source: BYOGitHubVerificationContext.CredentialSource
    ) {
        guard !isSetupMutationBlocked else {
            lastError = "Retry account verification before verifying GitHub App setup."
            byoGitHubCredentialStatus = lastError ?? "Account check required"
            return
        }
        guard requireLocalWorkerCLI() else {
            byoGitHubCredentialStatus = lastError ?? "Local worker unavailable"
            return
        }
        guard byoGitHubCredentialOnboardingAvailable else {
            lastError = "Customer-owned GitHub App verification is unavailable in this build."
            byoGitHubCredentialStatus = lastError ?? "Unavailable"
            return
        }
        guard !isBYOGitHubVerificationInProgress else { return }
        guard let appId = storedBYOGitHubAppId else {
            lastError = "Store a valid customer-owned GitHub App ID before verification."
            byoGitHubCredentialStatus = lastError ?? "App ID missing"
            return
        }

        let privateKey: String
        do {
            guard let stored = try dependencies.secretStore.readSecret(
                account: BYOGitHubAppKeychainAccount.privateKey,
                allowUserInteraction: true
            ) else {
                throw BYOGitHubAppCredentialError.invalidPrivateKey
            }
            privateKey = try BYOGitHubAppCredentialValidator.normalizedPrivateKey(stored)
        } catch {
            byoGitHubCredentialsVerified = false
            lastError = "The customer-owned GitHub App private key could not be read safely from Keychain."
            byoGitHubCredentialStatus = lastError ?? "Keychain read failed"
            return
        }

        var arguments = [
            "doctor", "github",
            "--config", configPath
        ]
        if let repositoryScope {
            arguments += ["--repo", repositoryScope]
        }
        arguments += [
            "--github-app-id", appId,
            "--github-app-private-key-stdin", "true",
            "--json"
        ]
        let repoArgument = repositoryScope.map {
            " --repo \(shellQuote($0))"
        } ?? ""
        let safeCommand = "\(shellQuote(cliPath)) doctor github --config \(shellQuote(configPath))\(repoArgument) --github-app-id \(shellQuote(appId)) --github-app-private-key-stdin true --json < [secure Keychain input]"
        let verificationContext = BYOGitHubVerificationContext(
            appId: appId,
            source: source,
            credentialRevision: byoGitHubCredentialRevision,
            cliPath: cliPath,
            configPath: configPath,
            repositories: repositoryScope.map { [$0] }
                ?? repos.filter(\.enabled).map(\.name).sorted(),
            workspaceGeneration: workspaceContextGeneration
        )
        var standardInput = Data(privateKey.utf8)
        let executablePath = cliPath
        let cli = dependencies.cli
        isBYOGitHubVerificationInProgress = true
        byoGitHubCredentialsVerified = false
        lastError = nil
        lastCommandLine = safeCommand
        byoGitHubCredentialStatus = repositoryScope == nil
            ? "Verifying the configured repositories against the customer-owned GitHub App installation…"
            : "Verifying the selected Review Target against the customer-owned GitHub App installation…"

        Task.detached {
            defer {
                standardInput.resetBytes(in: 0..<standardInput.count)
            }
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: standardInput,
                    timeout: 30
                )
                await MainActor.run {
                    self.applyBYOGitHubVerificationResult(result, expectedContext: verificationContext)
                }
            } catch {
                await MainActor.run {
                    guard self.isCurrentWorkspace(verificationContext.workspaceGeneration) else { return }
                    self.isBYOGitHubVerificationInProgress = false
                    self.byoGitHubCredentialsVerified = false
                    self.lastError = "Customer-owned GitHub App verification failed safely."
                    self.byoGitHubCredentialStatus = self.lastError ?? "Verification failed"
                    self.logText = "GitHub verification did not produce authoritative installation/repository proof."
                }
            }
        }
    }

    package func verifyExistingLocalBotGitHubAccess() {
        if existingLocalAgentAccessAvailable,
           selectedBotInstallation != nil
        {
            verifyGitHubAccessThroughExistingLocalAgent()
            return
        }
        if let bot = selectedBotInstallation,
           let storedAppID = storedBYOGitHubAppId,
           storedAppID == String(bot.appID),
           byoGitHubPrivateKeyStored,
           let targetRepository = selectedBYOReviewRepository,
           repos.contains(where: {
               $0.enabled
                   && $0.name.caseInsensitiveCompare(targetRepository)
                       == .orderedSame
           })
        {
            verifyBYOGitHubAppCredentials(
                repositoryScope: targetRepository,
                source: .keychainStdinExistingBot
            )
            return
        }
        let diagnosis = existingLocalBotBYOGitHubVerificationStatus
        lastError = diagnosis
        byoGitHubCredentialStatus = diagnosis
    }

    private func verifyGitHubAccessThroughExistingLocalAgent() {
        guard !isSetupMutationBlocked else {
            lastError = "Retry account verification before verifying GitHub App setup."
            byoGitHubCredentialStatus = lastError ?? "Account check required"
            return
        }
        guard !isBYOGitHubVerificationInProgress else { return }
        guard existingLocalAgentAccessAvailable,
              let bot = selectedBotInstallation
        else {
            lastError = "The selected bot does not match one exact configured local agent."
            byoGitHubCredentialStatus = lastError ?? "Local agent unavailable"
            return
        }
        guard let targetRepository = selectedBYOReviewRepository,
              repos.contains(where: {
                  $0.enabled
                      && $0.name.caseInsensitiveCompare(targetRepository)
                          == .orderedSame
              })
        else {
            lastError =
                "Select one configured review target before verifying current App access."
            byoGitHubCredentialStatus = lastError ?? "Review target required"
            return
        }
        let arguments = [
            "doctor", "github",
            "--config", configPath,
            "--repo", targetRepository,
            "--json"
        ]
        let verificationContext = BYOGitHubVerificationContext(
            appId: String(bot.appID),
            source: .existingLocalAgent,
            credentialRevision: byoGitHubCredentialRevision,
            cliPath: cliPath,
            configPath: configPath,
            repositories: [targetRepository],
            workspaceGeneration: workspaceContextGeneration
        )
        let executablePath = cliPath
        let cli = dependencies.cli
        isBYOGitHubVerificationInProgress = true
        byoGitHubCredentialsVerified = false
        lastError = nil
        lastCommandLine =
            "\(shellQuote(cliPath)) doctor github --config \(shellQuote(configPath)) --repo \(shellQuote(targetRepository)) --json"
        byoGitHubCredentialStatus =
            "Verifying current App installation access through the exact existing local agent…"

        Task.detached {
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: nil,
                    // Current agents honor --repo and return quickly. Older
                    // compatible local agents may ignore that filter and scan
                    // their full configured allowlist, so keep this read-only
                    // existing-agent probe bounded without killing valid proof.
                    timeout: 150
                )
                await MainActor.run {
                    self.applyBYOGitHubVerificationResult(
                        result,
                        expectedContext: verificationContext
                    )
                }
            } catch {
                await MainActor.run {
                    guard self.isCurrentWorkspace(
                        verificationContext.workspaceGeneration
                    ) else { return }
                    self.isBYOGitHubVerificationInProgress = false
                    self.byoGitHubCredentialsVerified = false
                    self.lastError =
                        "Existing local agent GitHub verification failed safely."
                    self.byoGitHubCredentialStatus =
                        self.lastError ?? "Verification failed"
                    self.logText =
                        "The existing local agent did not produce authoritative installation/repository proof. No credential was copied."
                }
            }
        }
    }

    private func applyBYOGitHubVerificationResult(
        _ result: CLIRunResult,
        expectedContext: BYOGitHubVerificationContext
    ) {
        guard isCurrentWorkspace(expectedContext.workspaceGeneration) else { return }
        isBYOGitHubVerificationInProgress = false
        let currentContext: BYOGitHubVerificationContext?
        switch expectedContext.source {
        case .keychainStdin:
            currentContext = storedBYOGitHubAppId.map { appId in
                BYOGitHubVerificationContext(
                    appId: appId,
                    source: .keychainStdin,
                    credentialRevision: byoGitHubCredentialRevision,
                    cliPath: cliPath,
                    configPath: configPath,
                    repositories: repos.filter(\.enabled).map(\.name).sorted(),
                    workspaceGeneration: workspaceContextGeneration
                )
            }
        case .keychainStdinExistingBot:
            currentContext = existingLocalBotIdentityReady
                ? selectedBotInstallation.flatMap { bot in
                    selectedBYOReviewRepository.flatMap { targetRepository in
                        guard let storedAppID = storedBYOGitHubAppId,
                              storedAppID == String(bot.appID),
                              repos.contains(where: {
                                  $0.enabled
                                      && $0.name.caseInsensitiveCompare(
                                          targetRepository
                                      ) == .orderedSame
                              })
                        else {
                            return nil
                        }
                        return BYOGitHubVerificationContext(
                            appId: storedAppID,
                            source: .keychainStdinExistingBot,
                            credentialRevision: byoGitHubCredentialRevision,
                            cliPath: cliPath,
                            configPath: configPath,
                            repositories: [targetRepository],
                            workspaceGeneration: workspaceContextGeneration
                        )
                    }
                }
                : nil
        case .existingLocalAgent:
            currentContext = existingLocalAgentAccessAvailable
                ? selectedBotInstallation.flatMap { bot in
                    selectedBYOReviewRepository.map { targetRepository in
                        BYOGitHubVerificationContext(
                            appId: String(bot.appID),
                            source: .existingLocalAgent,
                            credentialRevision: byoGitHubCredentialRevision,
                            cliPath: cliPath,
                            configPath: configPath,
                            repositories: [targetRepository],
                            workspaceGeneration: workspaceContextGeneration
                        )
                    }
                }
                : nil
        }
        guard currentContext == expectedContext else {
            byoGitHubCredentialsVerified = false
            lastError = "GitHub App verification context changed before the check completed."
            byoGitHubCredentialStatus = "Configuration changed. Verify App access again."
            logText = "Stale GitHub App verification evidence was discarded."
            return
        }
        let expectedCredentialSource: String
        switch expectedContext.source {
        case .keychainStdin, .keychainStdinExistingBot:
            expectedCredentialSource = "stdin"
        case .existingLocalAgent:
            expectedCredentialSource = "configured"
        }
        let report = result.stdout.data(using: .utf8).flatMap {
            try? JSONDecoder().decode(BYOGitHubDoctorReport.self, from: $0)
        }
        let expectedRepositories = normalizedExactRepoNames(
            expectedContext.repositories
        )
        let reportedRepositories = report.flatMap {
            normalizedExactRepoNames($0.github.readChecks.map(\.repo))
        }
        if let report,
           let expectedRepositories,
           !expectedRepositories.isEmpty,
           reportedRepositories == expectedRepositories,
           report.command == "doctor github",
           report.appCredentials.source == expectedCredentialSource
        {
            let unavailableProfiles = report.github.readChecks
                .filter {
                    $0.skippedByPolicy == "repo_profile_missing"
                        || $0.skippedByPolicy == "repo_profile_disabled"
                }
                .map(\.repo)
                .sorted {
                    $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
                }
            if !unavailableProfiles.isEmpty {
                byoGitHubCredentialsVerified = false
                lastError =
                    "NeonDiff repository policy is missing an enabled profile for \(unavailableProfiles.joined(separator: ", ")). Apply Repository again, then retry App verification."
                byoGitHubCredentialStatus = lastError ?? "Repository policy missing"
                logText =
                    "GitHub credentials and installation access were not accepted because the selected repository is missing an enabled local policy profile."
                return
            }
        }
        guard result.exitCode == 0,
              let report,
              let expectedRepositories,
              let reportedRepositories,
              !expectedRepositories.isEmpty,
              reportedRepositories == expectedRepositories,
              report.ok,
              report.command == "doctor github",
              report.appCredentials.source == expectedCredentialSource,
              report.appCredentials.appIdConfigured,
              report.appCredentials.privateKeyConfigured,
              report.github.canPostAsApp,
              report.github.readMode == "app_installation",
              !report.github.readChecks.isEmpty,
              report.github.readChecks.allSatisfy({ check in
                  check.skippedByPolicy == nil
                      && check.ok
                      && check.installationIdPresent
                      && check.appCanReadMetadata
                      && check.appCanReadPullRequests
              })
        else {
            byoGitHubCredentialsVerified = false
            lastError = "GitHub did not verify every configured repository through this App installation."
            byoGitHubCredentialStatus = lastError ?? "Verification failed"
            logText = "GitHub verification failed closed. Confirm the App installation, selected repositories, and required permissions."
            return
        }

        let repositories = report.github.readChecks.map(\.repo).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }.joined(separator: ", ")
        byoGitHubCredentialsVerified = true
        lastError = nil
        switch expectedContext.source {
        case .existingLocalAgent:
            byoGitHubCredentialStatus =
                "Verified existing local agent App installation access for \(repositories). Worker dry/live review has not run yet."
            logText =
                "Existing local agent GitHub App installation and repository access verified. No credential was copied and no review was executed or posted."
        case .keychainStdinExistingBot:
            byoGitHubCredentialStatus =
                "Verified App installation access for the selected Review Target \(repositories). Worker installation and dry/live review have not run yet."
            logText =
                "Selected existing-bot GitHub App installation access verified through the signed bundled worker. The full configured allowlist was not rewritten."
        case .keychainStdin:
            byoGitHubCredentialStatus =
                "Verified App installation access for \(repositories). Worker dry/live review has not run yet."
            logText =
                "Customer-owned GitHub App installation and repository access verified through the local CLI. No review was executed or posted."
        }

        if expectedContext.source == .existingLocalAgent,
           let readCheck = report.github.readChecks.first
        {
            verifyExistingLocalAgentEntitlement(
                expectedContext: expectedContext,
                visibility: readCheck.visibilityResult
            )
        }
    }

    private func verifyExistingLocalAgentEntitlement(
        expectedContext: BYOGitHubVerificationContext,
        visibility: String?
    ) {
        guard existingLocalAgentAccessAvailable,
              existingLocalBotIdentityReady,
              selectedAccountEntitlementSupportsCurrentPath,
              expectedContext.source == .existingLocalAgent,
              expectedContext.repositories.count == 1,
              let repository = expectedContext.repositories.first,
              selectedReviewRepository?.caseInsensitiveCompare(repository)
                  == .orderedSame
        else {
            isBYOGitHubVerificationInProgress = false
            lastError =
                "The existing account, local agent, or Review Target changed before entitlement verification."
            byoGitHubCredentialStatus =
                "GitHub access was verified, but current entitlement verification was cancelled safely."
            return
        }
        applyActivationEvent(.verifyExistingEntitlement)
        guard activationState == .activationPending else {
            isBYOGitHubVerificationInProgress = false
            lastError =
                "Finish or cancel the current activation attempt before verifying the existing local agent."
            byoGitHubCredentialStatus =
                "GitHub access was verified, but entitlement verification could not start."
            return
        }

        activationRequestGeneration &+= 1
        let activationGeneration = activationRequestGeneration
        let expectedWorkspaceGeneration = workspaceContextGeneration
        let expectedCLIPath = cliPath
        let expectedConfigPath = configPath
        let executablePath = cliPath
        let cli = dependencies.cli
        let arguments = [
            "license", "status",
            "--config", configPath,
            "--repo", repository,
            "--refresh", "true",
            "--json"
        ]
        isBYOGitHubVerificationInProgress = true
        byoGitHubCredentialStatus =
            "GitHub access verified. Checking the existing local agent's API-backed entitlement…"
        lastCommandLine =
            "\(shellQuote(cliPath)) license status --config \(shellQuote(configPath)) --repo \(shellQuote(repository)) --refresh true --json"

        Task.detached {
            let outcome: ActivationClientOutcome
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: nil,
                    timeout: 20
                )
                outcome = result.stdout.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ).isEmpty
                    ? .serviceError
                    : CLIActivationLicenseClient.classify(
                        stdout: result.stdout
                    )
            } catch let error as NeonDiffCLIError {
                switch error {
                case .timedOut, .cancelled, .cleanupTimedOut:
                    outcome = .offline
                case .launchFailed, .standardInputTooLarge, .outputTooLarge:
                    outcome = .serviceError
                }
            } catch {
                outcome = .offline
            }

            await MainActor.run {
                guard activationGeneration
                        == self.activationRequestGeneration
                else {
                    return
                }
                guard self.workspaceContextGeneration
                        == expectedWorkspaceGeneration,
                      self.cliPath == expectedCLIPath,
                      self.configPath == expectedConfigPath,
                      self.selectedReviewRepository?
                        .caseInsensitiveCompare(repository) == .orderedSame
                else {
                    self.isBYOGitHubVerificationInProgress = false
                    self.applyActivationEvent(.activationServiceError)
                    self.lastError =
                        "The local worker, config, or Review Target changed before entitlement verification finished."
                    self.byoGitHubCredentialStatus =
                        "GitHub access was verified, but stale entitlement proof was discarded. Verify existing access again."
                    return
                }
                self.isBYOGitHubVerificationInProgress = false
                let resolved =
                    self.resolveExistingLocalAgentEntitlementOutcome(
                        outcome,
                        visibility: visibility
                    )
                self.applyActivationEvent(
                    ActivationLicenseOutcomeMapping.event(for: resolved)
                )
                self.applyActivationOutcomeSideEffects(
                    resolved,
                    repository: repository,
                    activeLogMessage:
                        "Current repository entitlement verified through the existing local agent. No Activation Key was copied."
                )
                switch resolved {
                case .active:
                    self.byoGitHubCredentialStatus =
                        "Verified existing local agent App access and API-backed entitlement for \(repository)."
                default:
                    self.byoGitHubCredentialStatus =
                        "GitHub access is verified, but the existing local agent did not return an active entitlement for \(repository)."
                }
            }
        }
    }

    private func resolveExistingLocalAgentEntitlementOutcome(
        _ outcome: ActivationClientOutcome,
        visibility: String?
    ) -> ActivationClientOutcome {
        guard case let .active(summary) = outcome else { return outcome }
        switch visibility?.lowercased() {
        case "public":
            guard summary.repoVisibilityScope == "all"
                    || summary.repoVisibilityScope == "public"
                    || summary.repoVisibilityScope == "private"
            else {
                return .scopeConflict
            }
        case "private", "internal":
            guard summary.coversPrivateRepos else {
                return .scopeConflict
            }
        default:
            return .scopeConflict
        }
        return outcome
    }

    private func invalidateBYOGitHubVerificationContext() {
        invalidateScopedReviewApproval()
        guard byoGitHubCredentialOnboardingAvailable else { return }
        byoGitHubCredentialsVerified = false
        guard !isBYOGitHubVerificationInProgress else { return }
        if byoGitHubCredentialsStored {
            byoGitHubCredentialStatus = "Configuration changed. Verify App access again."
        }
    }

    package func clearProviderKey() {
        guard !isSetupMutationBlocked else {
            lastError = "Retry account verification before changing provider setup."
            return
        }
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard let account = selectedProviderKeyAccount else {
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = "Select a valid provider before clearing an API key."
            return
        }
        do {
            try dependencies.secretStore.deleteSecret(account: account)
            pendingProviderKey = ""
            providerKeyRevision &+= 1
            invalidateProviderVerificationContext(status: "Stored key cleared. Store a key before verification.")
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func verifyProviderKey() {
        guard requireProductionUsefulWorkAuthorization() else {
            providerVerification = nil
            providerVerificationStatus = lastError ?? productionActivationBoundaryMessage
            return
        }
        if let providerVerificationSafetyLatchMessage {
            providerVerification = nil
            providerVerificationStatus = providerVerificationSafetyLatchMessage
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard !isProviderVerificationInProgress else { return }
        guard let providerKeyAccount = selectedProviderKeyAccount,
              providers.providerKeyStored,
              dependencies.secretStore.containsSecret(account: providerKeyAccount)
        else {
            providerVerification = nil
            providerVerificationStatus = "Store a provider API key in Keychain before verification."
            lastError = "Provider verification requires a stored Keychain item."
            return
        }

        persistLocalSettings()
        guard let providerId = providers.selectedRegistryTarget?.id,
              let expectedRevision = providerLoadedRevision,
              canVerifyProviderKey
        else {
            providerVerification = nil
            providerVerificationStatus = "Apply and reload an eligible saved provider before verification."
            lastError = "Provider verification requires an applied openai-compatible api-key-env provider."
            return
        }
        let arguments = [
            "providers", "verify",
            "--config", configPath,
            "--provider", providerId,
            "--expected-config-revision", expectedRevision,
            "--api-key-stdin", "true",
            "--allow-remote-smoke", "true",
            "--json"
        ]
        let executablePath = cliPath
        let requestContext = currentProviderVerificationContext
        let requestContextGeneration = providerVerificationContextGeneration
        providerVerificationRequestGeneration &+= 1
        let requestGeneration = providerVerificationRequestGeneration
        let providerVerifier = dependencies.providerVerifier

        providerVerification = nil
        providerVerificationStatus = "Verifying the stored API key…"
        isProviderVerificationInProgress = true
        isProviderVerificationCancelling = false
        activeProviderVerificationRequestGeneration = requestGeneration
        lastError = nil
        lastCommandLine = "\(shellQuote(executablePath)) providers verify --config \(shellQuote(configPath)) --provider \(shellQuote(providerId)) --expected-config-revision \(shellQuote(expectedRevision)) --api-key-stdin true --allow-remote-smoke true --json < [secure Keychain input]"

        providerVerificationTask = Task { [weak self] in
            let outcome: Result<ProviderVerificationSnapshot, Error>
            do {
                outcome = .success(try await providerVerifier.verify(
                    executablePath: executablePath,
                    account: providerKeyAccount,
                    expectedProviderId: providerId,
                    expectedConfigRevision: expectedRevision,
                    arguments: arguments,
                    timeout: 15
                ))
            } catch {
                outcome = .failure(error)
            }

            guard let self else { return }
            let wasCancelled = Task.isCancelled
            guard self.activeProviderVerificationRequestGeneration == requestGeneration else { return }
            self.providerVerificationTask = nil
            self.activeProviderVerificationRequestGeneration = nil
            self.isProviderVerificationInProgress = false
            self.isProviderVerificationCancelling = false
            if case .failure(NeonDiffCLIError.cleanupTimedOut) = outcome {
                let message = "Provider verification process cleanup could not be proven. Restart NeonDiff before any further provider, config, or CLI operation."
                self.providerVerificationSafetyLatchMessage = message
                self.providerVerification = nil
                self.providerVerificationStatus = message
                self.lastError = message
                return
            }
            guard
                !wasCancelled,
                self.providerVerificationContextGeneration == requestContextGeneration,
                self.currentProviderVerificationContext == requestContext
            else {
                self.providerVerification = nil
                self.providerVerificationStatus = "Provider or config changed during verification. Verify again."
                self.lastError = nil
                return
            }
            switch outcome {
            case .success(let snapshot):
                self.providerVerification = snapshot
                self.lastError = nil
                switch snapshot.state {
                case .healthy:
                    self.providerVerificationStatus = "Provider API key verified."
                case .configuredUnverified:
                    self.providerVerificationStatus = "Provider is configured but not verified."
                case .blocked:
                    self.providerVerificationStatus = "Provider verification was blocked."
                }
            case .failure:
                self.providerVerification = nil
                self.providerVerificationStatus = "Verification failed safely. Confirm the stored key, provider config, and NeonDiff CLI, then retry."
                self.lastError = "Provider verification failed without retaining provider output."
            }
        }
    }

    private var currentProviderVerificationContext: ProviderVerificationRequestContext {
        ProviderVerificationRequestContext(
            configPath: configPath,
            cliPath: cliPath,
            providers: providers,
            loadedConfigRevision: controlCenterLoadedRevision,
            providerKeyRevision: providerKeyRevision
        )
    }

    private var selectedProviderKeyAccount: String? {
        ProviderKeychainAccount.account(providerId: providers.selectedProviderId)
    }

    private func refreshSelectedProviderKeyState() {
        let stored = selectedProviderKeyAccount.map(dependencies.secretStore.containsSecret(account:)) == true
        providers.providerKeyStored = stored
        onboardingFlow.providerKeyStored = stored
    }

    private func invalidateProviderVerificationContext(
        status: String = "Provider or config changed. Verify the stored key again."
    ) {
        providerVerificationContextGeneration &+= 1
        let isCancellingActiveRequest = isProviderVerificationInProgress
        if isCancellingActiveRequest {
            isProviderVerificationCancelling = true
            providerVerificationStatus = "Cancelling provider verification safely…"
            providerVerificationTask?.cancel()
        }
        providerVerification = nil
        if !isCancellingActiveRequest {
            providerVerificationStatus = status
        }
    }

    package func storeLicenseKey() {
        guard requireVerifiedNativeActivationBroker() else { return }
        do {
            try dependencies.secretStore.setSecret(pendingLicenseKey, account: licenseKeyAccount)
            pendingLicenseKey = ""
            license = LicenseStatus(keyStored: true, entitlement: "stored locally", updateChannel: license.updateChannel)
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func activateLicenseForOnboarding() {
        guard requireVerifiedNativeActivationBroker() else {
            onboardingFlow.licenseActivation = .servicePending
            license.entitlement = "activation unavailable"
            return
        }
        if !pendingLicenseKey.isEmpty {
            storeLicenseKey()
        }
        onboardingFlow.licenseActivation = .servicePending
        license.entitlement = "service pending"
        lastError = nil
        logText = "License activation is pending the hosted license service deployment."
    }

    // MARK: - Native activation handoff (#612)

    /// Managed production onboarding always uses the native return/redeem state
    /// machine. Outside that exact broker contract it remains preference-gated,
    /// preserving the existing rollback control for legacy/local builds.
    package var activationHandoffEnabled: Bool {
        managedGitHubAvailable
            || dependencies.productionBoundary.byoGitHubEnabled
            || dependencies.preferences.bool(forKey: activationHandoffEnabledKey)
    }

    /// Paid BYO production builds expose the public purchase surface. Other
    /// boundaries retain the explicit preference gate and honest paused state.
    package var activationCheckoutEnabled: Bool {
        dependencies.productionBoundary.byoGitHubEnabled
            || dependencies.preferences.bool(forKey: activationCheckoutEnabledKey)
    }

    package var activationPresentation: ActivationStatePresentation {
        ActivationStateMachine.presentation(for: activationState, redactedKeyPrefix: activationKeyRedactedPrefix)
    }

    private var activationLicenseClient: (any ActivationLicenseClienting)? {
        if let activationLicenseClientOverride { return activationLicenseClientOverride }
        // Keep the real adapter behind the rollout flag until production billing
        // and activation canaries pass. When enabled, it uses the CLI's explicit
        // no-local-state mode: the app-owned Keychain item remains the only raw
        // credential copy and the key crosses only over bounded stdin.
        let bundleEnablesActivation = dependencies.productionBoundary.byoGitHubEnabled
        let rolloutEnablesActivation = dependencies.preferences.bool(forKey: activationCliBackedEnabledKey)
        guard dependencies.productionBoundary.nativeActivationBrokerVerified,
              bundleEnablesActivation || rolloutEnablesActivation
        else {
            return nil
        }
        guard let selectedReviewRepository,
              repos.contains(where: {
                  $0.enabled
                      && $0.name.caseInsensitiveCompare(selectedReviewRepository)
                          == .orderedSame
              }),
              let identity = try? GitHubBrokerDeviceIdentityStore(
                secretStore: dependencies.secretStore
              ).loadOrCreate()
        else {
            return nil
        }
        return DesktopActivationLicenseClient(
            cli: dependencies.cli,
            executablePath: cliPath,
            configPath: configPath,
            machineId: identity.deviceId,
            repository: selectedReviewRepository
        )
    }

    /// Tags each activation attempt so a slow in-flight result that lands after a
    /// cancellation or a newer request is dropped (resume-exact race guard).
    private var activationRequestGeneration: UInt64 = 0

    package func applyActivationEvent(_ event: ActivationEvent) {
        let next = ActivationStateMachine.reduce(activationState, on: event)
        guard next != activationState else { return }
        if activationState == .active, next != .active {
            activationVerifiedThisLaunch = false
            activationVerifiedRepositoryThisLaunch = nil
            dependencies.preferences.set("", forKey: activationRepositoryKey)
        }
        activationState = next
        // Persist for resume-exact restore across relaunch / cancel / network loss.
        dependencies.preferences.set(next.rawValue, forKey: activationStateKey)
    }

    /// Enter the activation branch from the chosen onboarding path. The public
    /// path skips straight to a free, license-free state.
    package func enterActivation(for mode: OnboardingMode) {
        applyActivationEvent(mode == .publicReposOnly ? .choosePublicPath : .choosePrivatePath)
    }

    /// Align the activation entry state with the onboarding mode when the flow
    /// first reaches activation, so choosing Public Repos actually skips the
    /// license wall. Only flips between the two entry states — never disturbs a
    /// mid-flow or resumed state (resume-exact).
    package func syncActivationEntryFromOnboardingMode() {
        switch activationState {
        case .purchaseRequired where onboardingFlow.mode == .publicReposOnly:
            applyActivationEvent(.choosePublicPath)
        case .publicFreeSkip where onboardingFlow.mode == .privateRepos:
            applyActivationEvent(.choosePrivatePath)
        default:
            break
        }
    }

    package func beginActivationCheckout() {
        applyActivationEvent(activationCheckoutEnabled ? .beginCheckout : .checkoutUnavailable)
    }

    /// Open the public purchase surface without moving away from the existing-key
    /// entry state. Checkout returns a one-shot key in the browser, so the customer
    /// must still be able to paste that key here after returning to the app.
    package func openActivationCheckout() {
        guard activationCheckoutEnabled else {
            applyActivationEvent(.checkoutUnavailable)
            return
        }
        guard dependencies.urlOpener.open(DesktopReleaseRouting.activationCheckoutURL) else {
            lastError = "Could not open NeonDiff checkout. Visit neondiff.com to purchase an Activation Key."
            return
        }
        lastError = nil
    }

    package func cancelActivationCheckout() {
        // Invalidate any in-flight activation so its late result is ignored.
        activationRequestGeneration &+= 1
        applyActivationEvent(.checkoutCancelled)
    }

    /// Existing keys still activate while checkout is paused. The key is stored in
    /// the Keychain only; only a redacted prefix is retained in memory for display.
    package func provideExistingActivationKey() {
        if ActivationKeyMaterial(pendingActivationKey).isEmpty {
            guard dependencies.secretStore.containsSecret(account: activationKeyAccount) else {
                lastError = "Enter your \(ActivationTerminology.activationKey) to continue."
                return
            }
            pendingActivationKey = ""
        } else {
            guard persistPendingActivationKey(requireNonEmpty: true) else { return }
        }
        lastError = nil
        applyActivationEvent(.provideExistingKey)
    }

    /// Upsert the pasted key into the Keychain (single canonical item) and retain
    /// only a redacted prefix in memory. Returns false when there is nothing to
    /// store (or the store failed).
    @discardableResult
    private func persistPendingActivationKey(requireNonEmpty: Bool = false) -> Bool {
        let material = ActivationKeyMaterial(pendingActivationKey)
        guard !material.isEmpty else {
            if requireNonEmpty {
                lastError = "Enter your \(ActivationTerminology.activationKey) to continue."
            }
            return false
        }
        do {
            try dependencies.secretStore.setSecret(pendingActivationKey, account: activationKeyAccount)
            activationKeyRedactedPrefix = material.redactedPrefix
            pendingActivationKey = ""
            return true
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return false
        }
    }

    package func reenterActivationKey() {
        applyActivationEvent(.reenterKey)
    }

    package func renewActivation() {
        applyActivationEvent(.renew)
    }

    /// Single entry the UI calls for the one recovery action a state advertises.
    package func performActivationRecovery() async {
        guard let event = activationPresentation.recovery?.event else { return }
        switch event {
        case .beginCheckout, .checkoutUnavailable:
            beginActivationCheckout()
        case .provideExistingKey:
            provideExistingActivationKey()
        case .submitActivation:
            await submitActivation()
        case .checkoutCancelled:
            cancelActivationCheckout()
        case .reenterKey:
            reenterActivationKey()
        case .renew:
            renewActivation()
        case .retry:
            await retryActivation()
        default:
            applyActivationEvent(event)
        }
    }

    package func requestActivationNotifyWhenCheckoutReopens() {
        logText = "You'll be notified when \(ActivationTerminology.activationKey) checkout reopens. Existing keys still activate now."
    }

    @discardableResult
    private func prepareActivationSubmission() -> Bool {
        guard activationState == .keyReady else { return false }
        // A corrected/replacement key typed on the key-entry screen must be stored
        // (and thus used) before we activate — otherwise the previous, rejected key
        // would be retried.
        if !pendingActivationKey.isEmpty {
            guard persistPendingActivationKey() else { return false }
        }
        applyActivationEvent(.submitActivation)
        return true
    }

    /// The native button must publish `activation_pending` synchronously before
    /// Keychain or network work begins. This gives the installed UI an observable
    /// action boundary and leaves cancellation able to win before the task starts.
    package func beginActivationSubmission() {
        guard prepareActivationSubmission() else { return }
        Task { @MainActor [weak self] in
            guard let self, self.activationState == .activationPending else { return }
            await self.performActivation()
        }
    }

    package func submitActivation() async {
        guard prepareActivationSubmission() else { return }
        await performActivation()
    }

    package func retryActivation() async {
        guard activationState == .offline || activationState == .serviceError else { return }
        if !pendingActivationKey.isEmpty {
            guard persistPendingActivationKey() else { return }
        }
        applyActivationEvent(.retry)
        await performActivation()
    }

    /// Runs against `activation_pending`: read the key lazily from the Keychain
    /// (off the launch path) and hand it to the license client over bounded stdin.
    private func performActivation() async {
        activationRequestGeneration &+= 1
        let generation = activationRequestGeneration

        guard !activationTargetSelectionRequired else {
            applyActivationEvent(.activationServiceError)
            lastError = "Choose one Review Target in Repositories before activating. The existing worker allowlist will remain unchanged."
            return
        }
        let activationRepository = selectedReviewRepository
        if byoGitHubCredentialOnboardingAvailable {
            guard let activationRepository,
                  isAppliedBYOReviewRepository(activationRepository)
            else {
                applyActivationEvent(.activationServiceError)
                lastError = "Apply and read back the selected Review Target before activating."
                return
            }
            if let activatedRepository,
               activatedRepository.caseInsensitiveCompare(activationRepository)
                   != .orderedSame {
                applyActivationEvent(.activationServiceError)
                lastError = "This device may already be bound to \(activatedRepository) from an earlier activation attempt. Retry with that Review Target or complete a verified deactivate/rebind before switching repositories."
                return
            }
        }
        guard let client = activationLicenseClient else {
            // No CLI-backed validation available (default): never invoke the
            // file-persisting CLI. Land in a retryable state instead.
            applyActivationEvent(.activationServiceError)
            lastError = activationPresentation.cause
            return
        }
        let rawKey: String?
        do {
            rawKey = try dependencies.secretStore.readSecret(account: activationKeyAccount, allowUserInteraction: true)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            applyActivationEvent(.activationServiceError)
            return
        }
        guard let rawKey, !rawKey.isEmpty else {
            // Missing Keychain item mid-activation → back to key entry, not a dead
            // Activating state (reenterKey now transitions from activationPending).
            applyActivationEvent(.reenterKey)
            lastError = "No stored \(ActivationTerminology.activationKey) to activate. Enter it again."
            return
        }
        // Pin the device to the attempted repository before the network await.
        // A cancelled or lost response may still have bound the server, so
        // switching targets remains blocked until a verified rebind exists.
        if let activationRepository {
            dependencies.preferences.set(
                activationRepository,
                forKey: activationRepositoryKey
            )
        }
        let outcome: ActivationClientOutcome
        do {
            outcome = try await client.activate(key: ActivationKeyMaterial(rawKey))
        } catch {
            outcome = .offline
        }
        // Drop stale results after a cancellation or a newer activation request.
        guard generation == activationRequestGeneration else { return }
        let resolved = resolveActivationOutcome(outcome)
        applyActivationEvent(ActivationLicenseOutcomeMapping.event(for: resolved))
        applyActivationOutcomeSideEffects(
            resolved,
            repository: activationRepository
        )
    }

    /// A 200-`active` response can still be public-only or `privateRepoAllowed=false`,
    /// which the server review gate rejects for private repos. Downgrade such a
    /// scope-insufficient success to a scope conflict so the pane never reports
    /// private review as unlocked when it is not.
    private func resolveActivationOutcome(_ outcome: ActivationClientOutcome) -> ActivationClientOutcome {
        if case let .active(summary) = outcome, !summary.coversPrivateRepos {
            return .scopeConflict
        }
        return outcome
    }

    private func applyActivationOutcomeSideEffects(
        _ outcome: ActivationClientOutcome,
        repository: String?,
        activeLogMessage: String? = nil
    ) {
        switch outcome {
        case .active(let summary):
            let now = dependencies.clock.now
            activationUpdateAuthorityVerifiedAt = now
            let freshnessDeadline = now.addingTimeInterval(300)
            if let rawExpiry = summary.expiresAt {
                activationUpdateAuthorityValidUntil = ISO8601DateFormatter()
                    .date(from: rawExpiry)
                    .map { min($0, freshnessDeadline) }
            } else {
                activationUpdateAuthorityValidUntil = freshnessDeadline
            }
            activationUpdateEntitlementThisLaunch = summary.updateEntitlement
            activationVerifiedThisLaunch = true
            lastError = nil
            let scope = summary.repoVisibilityScope
            let plan = summary.plan.map { " · \($0)" } ?? ""
            license.entitlement = "active (\(scope)\(plan))"
            logText = activeLogMessage
                ?? "\(ActivationTerminology.activationKey) is active. Private repository review is unlocked."
            activationVerifiedRepositoryThisLaunch = repository
            if let repository {
                dependencies.preferences.set(repository, forKey: activationRepositoryKey)
            }
            // Let onboarding finish through the native handoff (Continue enables).
            onboardingFlow.licenseActivation = .activated
        case .scopeConflict:
            activationVerifiedThisLaunch = false
            activationVerifiedRepositoryThisLaunch = nil
            lastError = "This \(ActivationTerminology.activationKey) does not cover private repositories. Use a key with a private-repo entitlement."
        case .expired, .revoked, .invalid:
            activationVerifiedThisLaunch = false
            activationVerifiedRepositoryThisLaunch = nil
            dependencies.preferences.set("", forKey: activationRepositoryKey)
            lastError = activationPresentation.cause
        case .offline, .serviceError, .malformed:
            activationVerifiedThisLaunch = false
            activationVerifiedRepositoryThisLaunch = nil
            // Cause copy comes from the typed state presentation — never a raw
            // error string, and never any key material.
            lastError = activationPresentation.cause
        }
    }

    package func advanceOnboarding() {
        if existingLocalBotReconciliationMode {
            switch onboardingFlow.currentStep {
            case .welcome:
                onboardingFlow.currentStep = .provider
            case .provider:
                onboardingFlow.currentStep = .daemon
            case .daemon:
                onboardingFlow.currentStep = .license
            case .license:
                onboardingFlow.currentStep = .done
            case .done:
                if productionUsefulWorkAvailable && providerSetupReady {
                    completeOnboarding()
                } else {
                    dismissOnboardingPanel()
                }
            }
            return
        }
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        guard canAdvanceOnboarding else { return }
        if onboardingFlow.currentStep == .done {
            completeOnboarding()
            return
        }
        onboardingFlow.advance()
    }

    package func goBackOnboarding() {
        onboardingFlow.goBack()
    }

    package func completeOnboarding() {
        guard productionUsefulWorkAvailable,
              dependencies.productionBoundary.managedGitHubBrokerOrigin == nil
                || hasVerifiedManagedGitHubSelection,
              onboardingFlow.licenseActivation == .activated
        else {
            _ = requireVerifiedNativeActivationBroker()
            isOnboardingPresented = true
            return
        }
        dependencies.preferences.set(true, forKey: onboardingCompletedKey)
        isOnboardingPresented = false
    }

    package func openReadOnlyAppFromQuarantinedOnboarding() {
        guard incompleteOnboardingEscapeAvailable else { return }
        isOnboardingPresented = false
        lastError = nil
        logText = dependencies.productionBoundary.nativeActivationBrokerVerified
            ? "Opened the read-only setup surface. Finish GitHub, repository, provider, and activation setup before starting a review."
            : "Opened the read-only setup surface. \(productionActivationBoundaryMessage)"
    }

    /// Dismisses the integrated setup panel in every state. Incomplete users
    /// keep the existing read-only escape behavior; completed users reopening
    /// setup can close it without rewriting their completion proof.
    package func dismissOnboardingPanel() {
        guard isOnboardingPresented else { return }
        if incompleteOnboardingEscapeAvailable {
            openReadOnlyAppFromQuarantinedOnboarding()
        } else {
            isOnboardingPresented = false
        }
    }

    @discardableResult
    private func requireVerifiedNativeActivationBroker() -> Bool {
        guard dependencies.productionBoundary.nativeActivationBrokerVerified else {
            lastError = productionActivationBoundaryMessage
            logText = productionActivationBoundaryMessage
            return false
        }
        return true
    }

    @discardableResult
    private func requireProductionUsefulWorkAuthorization() -> Bool {
        guard productionUsefulWorkAvailable else {
            let message = dependencies.productionBoundary.nativeActivationBrokerVerified
                ? "Verify and apply the selected repository, then verify its current entitlement before running NeonDiff."
                : productionActivationBoundaryMessage
            lastError = message
            logText = message
            return false
        }
        return true
    }

    @discardableResult
    private func requireProductionDaemonStartAuthorization() -> Bool {
        guard productionDaemonStartAvailable else {
            lastError = reviewTargetRuntimeReady
                ? "Verify the selected repository, provider, and entitlement before starting the worker."
                : "This existing worker monitors multiple repositories. Run a scoped review from NeonDiff; daemon-wide start remains blocked."
            logText = lastError ?? "Daemon start is unavailable."
            return false
        }
        return true
    }

    @discardableResult
    private func requireScopedReviewAuthorization() -> Bool {
        guard requireProductionUsefulWorkAuthorization() else {
            return false
        }
        guard providerSetupReady else {
            lastError =
                "Verify the selected provider before running a review."
            scopedReviewStatus =
                lastError ?? "Provider verification required"
            return false
        }
        guard scopedReviewProviderReady else {
            lastError =
                "Scoped reviews currently require a provider backed by the verified ZCode app configuration."
            scopedReviewStatus =
                lastError ?? "ZCode provider configuration required"
            return false
        }
        guard existingLocalAgentAccessAvailable else {
            lastError =
                "Connect a verified local NeonDiff agent before running a scoped review."
            scopedReviewStatus = lastError ?? "Local agent required"
            return false
        }
        guard localWorkerReviewCompatibility.isCompatible else {
            lastError = localWorkerReviewCompatibility == .checking
                ? "Wait for the local worker compatibility check to finish."
                : "Update or recheck the selected local worker before running a review."
            scopedReviewStatus = lastError ?? "Worker compatibility required"
            return false
        }
        return true
    }

    package var positivePendingReviewPullNumber: Int? {
        let trimmed = pendingReviewPullNumber
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed), value > 0 else { return nil }
        return value
    }

    private func applyScopedDryReviewResult(
        _ result: CLIRunResult,
        expectedContext: ScopedReviewApproval
    ) {
        guard isCurrentWorkspace(expectedContext.workspaceGeneration) else {
            return
        }
        isScopedReviewInProgress = false
        scopedReviewTask = nil
        guard currentScopedReviewCoordinatesMatch(expectedContext),
              result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let report = try? JSONDecoder().decode(
                  ScopedReviewCommandReport.self,
                  from: data
              ),
              report.ok,
              report.command == "review-pr",
              report.dryRun,
              report.result.reviewed == 1,
              report.result.skippedProcessed == 0,
              report.scope.repo.caseInsensitiveCompare(expectedContext.repo)
                  == .orderedSame,
              report.scope.pullNumber == expectedContext.pullNumber,
              isValidGitHubCommitSHA(report.scope.headSha)
        else {
            invalidateScopedReviewApproval()
            lastError =
                "The dry review did not produce exact repository, pull request, and head proof."
            scopedReviewStatus =
                "Dry review failed closed. No live review is authorized."
            return
        }

        let approval = ScopedReviewApproval(
            repo: report.scope.repo,
            pullNumber: report.scope.pullNumber,
            headSHA: report.scope.headSha.lowercased(),
            configPath: expectedContext.configPath,
            configRevision: expectedContext.configRevision,
            workspaceGeneration: expectedContext.workspaceGeneration,
            workerCompatibilityGeneration:
                expectedContext.workerCompatibilityGeneration
        )
        scopedDryRunApproval = approval
        scopedDryRunHeadSHA = approval.headSHA
        lastError = nil
        scopedReviewStatus =
            "Dry review complete for \(approval.repo)#\(approval.pullNumber) at \(approval.headSHA.prefix(12)). Confirm to post this exact head."
    }

    private func applyScopedLiveReviewResult(
        _ result: CLIRunResult,
        expectedApproval: ScopedReviewApproval
    ) {
        guard isCurrentWorkspace(expectedApproval.workspaceGeneration) else {
            return
        }
        isScopedReviewInProgress = false
        scopedReviewTask = nil
        guard currentScopedReviewCoordinatesMatch(expectedApproval),
              scopedDryRunApproval == expectedApproval,
              result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let report = try? JSONDecoder().decode(
                  ScopedReviewCommandReport.self,
                  from: data
              ),
              report.ok,
              report.command == "review-pr",
              !report.dryRun,
              report.result.reviewed == 1,
              report.result.skippedProcessed == 0,
              report.scope.repo.caseInsensitiveCompare(expectedApproval.repo)
                  == .orderedSame,
              report.scope.pullNumber == expectedApproval.pullNumber,
              report.scope.headSha.caseInsensitiveCompare(
                  expectedApproval.headSHA
              ) == .orderedSame
        else {
            lastError =
                "GitHub did not confirm a live review for the exact approved head."
            scopedReviewStatus =
                "Live review failed closed. Re-run the dry review before retrying."
            invalidateScopedReviewApproval(preserveStatus: true)
            return
        }

        lastError = nil
        scopedReviewStatus =
            "Review posted for \(expectedApproval.repo)#\(expectedApproval.pullNumber) at \(expectedApproval.headSHA.prefix(12))."
        invalidateScopedReviewApproval(preserveStatus: true)
    }

    private func currentScopedReviewCoordinatesMatch(
        _ approval: ScopedReviewApproval
    ) -> Bool {
        guard approval.workspaceGeneration == workspaceContextGeneration,
              approval.workerCompatibilityGeneration
                == localWorkerReviewCompatibilityGeneration,
              localWorkerReviewCompatibility.isCompatible,
              approval.configPath == configPath,
              let selectedReviewRepository,
              selectedReviewRepository.caseInsensitiveCompare(approval.repo)
                  == .orderedSame,
              positivePendingReviewPullNumber == approval.pullNumber,
              providerLoadedRevision == approval.configRevision
        else {
            return false
        }
        return true
    }

    private func isValidGitHubCommitSHA(_ value: String) -> Bool {
        value.utf8.count == 40
            && value.utf8.allSatisfy {
                ($0 >= 48 && $0 <= 57)
                    || ($0 >= 65 && $0 <= 70)
                    || ($0 >= 97 && $0 <= 102)
            }
    }

    private func invalidateScopedReviewApproval(
        preserveStatus: Bool = false
    ) {
        scopedDryRunApproval = nil
        scopedDryRunHeadSHA = nil
        if !preserveStatus && !isScopedReviewInProgress {
            scopedReviewStatus =
                "Run a dry review before posting an exact pull request head."
        }
    }

    private func invalidateLocalWorkerReviewCompatibility() {
        localWorkerCompatibilityTask?.cancel()
        localWorkerCompatibilityTask = nil
        localWorkerReviewCompatibilityGeneration &+= 1
        localWorkerReviewCompatibility = .unknown
        invalidateScopedReviewApproval()
    }

    @discardableResult
    private func requireProductionDaemonStopAuthorization() -> Bool {
        guard productionDaemonStopAvailable else {
            lastError = productionActivationBoundaryMessage
            logText = productionActivationBoundaryMessage
            return false
        }
        return true
    }

    package func reopenOnboarding(at step: OnboardingStep? = nil) {
        if let step {
            onboardingFlow.currentStep = step
        }
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        isOnboardingPresented = true
    }

    package func reviewExistingBotRepositoryAccess() {
        guard existingAccountEntitlementNeedsCurrentAccessVerification else {
            return
        }
        reviewActivationTargetSelection()
    }

    package func reviewActivationTargetSelection() {
        selectedSection = .repos
        isOnboardingPresented = false
        lastError = nil
    }

    package func copyCommand(_ command: DesktopCommand) {
        _ = dependencies.clipboard.write(command.commandLine)
        lastCommandLine = command.commandLine
    }

    private func runCLI(
        arguments: [String],
        displayCommand: DesktopCommand,
        controlCenterOperation: ControlCenterOperation? = nil,
        providerPatchProof: PendingProviderPatchProof? = nil,
        repoPatchProof: PendingRepoPatchProof? = nil,
        allowsSetupMutationDuringRestore: Bool = false
    ) {
        if let providerVerificationSafetyLatchMessage {
            lastError = providerVerificationSafetyLatchMessage
            clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
            if controlCenterOperation != nil { isControlCenterOperationInProgress = false }
            return
        }
        let isConfigPatchCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "patch"
        let isConfigInspectCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "inspect"
        let isConfigInitializeCommand = arguments.first == "init"
        let isConfigOperation = isConfigInitializeCommand || isConfigPatchCommand || isConfigInspectCommand
        let isDaemonStatusCommand = arguments.count >= 2
            && arguments[0] == "daemon"
            && arguments[1] == "status"
        if isConfigOperation
            && isSetupMutationBlocked
            && !allowsSetupMutationDuringRestore {
            lastError = "Retry account verification before reading or changing local setup."
            clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
            if controlCenterOperation != nil { isControlCenterOperationInProgress = false }
            return
        }
        if isConfigOperation
            && (isProviderVerificationInProgress || isProviderVerificationCancelling) {
            lastError = "Wait for provider verification cleanup before changing config."
            clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
            if controlCenterOperation != nil { isControlCenterOperationInProgress = false }
            return
        }
        if isConfigOperation
            && (isConfigInitializationInProgress || isConfigPatchInProgress || isConfigInspectInProgress) {
            lastError = "Another config operation is still running."
            clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
            if controlCenterOperation != nil {
                controlCenterStatus = lastError ?? "Control-center command deferred."
                isControlCenterOperationInProgress = false
            }
            return
        }
        if isConfigInitializeCommand { isConfigInitializationInProgress = true }
        if isConfigPatchCommand { isConfigPatchInProgress = true }
        if isConfigInspectCommand { isConfigInspectInProgress = true }
        lastCommandLine = displayCommand.commandLine
        let executablePath = cliPath
        let cli = dependencies.cli
        let operationWorkspaceGeneration = workspaceContextGeneration
        Task.detached { [configPath, launchdLabel] in
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: nil,
                    timeout: 15
                )
                await MainActor.run {
                    guard self.workspaceContextGeneration == operationWorkspaceGeneration else {
                        return
                    }
                    self.applyCLIResult(
                        result,
                        fallbackCommand: displayCommand.commandLine,
                        configPath: configPath,
                        launchdLabel: launchdLabel,
                        isConfigInspectCommand: isConfigInspectCommand,
                        isConfigInitializeCommand: isConfigInitializeCommand,
                        isDaemonStatusCommand: isDaemonStatusCommand,
                        controlCenterOperation: controlCenterOperation,
                        providerPatchProof: providerPatchProof,
                        repoPatchProof: repoPatchProof
                    )
                    if isConfigInitializeCommand { self.isConfigInitializationInProgress = false }
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    if isConfigInspectCommand { self.isConfigInspectInProgress = false }
                    if controlCenterOperation != nil { self.isControlCenterOperationInProgress = false }
                    self.clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
                    self.clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
                }
            } catch {
                await MainActor.run {
                    guard self.workspaceContextGeneration == operationWorkspaceGeneration else {
                        return
                    }
                    self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    self.logText = self.lastError ?? "Unknown CLI error"
                    if isDaemonStatusCommand {
                        self.statusRefreshFailureMessage = self.lastError
                            ?? "Local worker status check failed."
                    }
                    if isConfigInitializeCommand {
                        self.isConfigInitializationInProgress = false
                        self.configInitializationStatus = self.lastError ?? "Local config initialization failed."
                    }
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    self.clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
                    self.clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
                    if isConfigInspectCommand {
                        self.invalidateProviderConfigAuthorization()
                        self.invalidateControlCenterAfterInspectFailure(self.lastError ?? "Config inspect failed.")
                        self.isConfigInspectInProgress = false
                    }
                    if controlCenterOperation != nil {
                        self.invalidateControlCenterAfterPatchFailure(
                            self.lastError ?? "Control-center command failed before a response was received."
                        )
                        self.isControlCenterOperationInProgress = false
                    }
                }
            }
        }
    }

    private func runProviderConfigPatch(dryRun: Bool) {
        guard !isConfigPatchInProgress, !isConfigInspectInProgress else {
            lastError = "Another config operation is still running."
            return
        }
        guard let expectedRevision = dryRun ? providerLoadedRevision : previewedProviderExpectedRevision else {
            lastError = "Load current config before changing provider settings."
            return
        }
        do {
            try writeProviderPatch()
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return
        }
        var arguments = [
            "config",
            "patch",
            "--config",
            configPath,
            "--input",
            providerPatchPath.path,
            "--dry-run",
            dryRun ? "true" : "false"
        ]
        arguments.append(contentsOf: ["--expected-revision", expectedRevision])
        let proof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: desiredProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: dryRun ? .preview : .apply
        )
        pendingProviderPatchProof = proof
        if !dryRun {
            arguments.append(contentsOf: ["--confirm", "true"])
        }
        runCLI(
            arguments: arguments,
            displayCommand: dryRun ? providerPatchPreviewCommand : providerPatchApplyCommand,
            providerPatchProof: proof
        )
    }

    private var providerPatchPath: URL {
        appSupportDirectory.appendingPathComponent("provider-settings-patch.json")
    }

    private var repoSelectionPatchPath: URL {
        appSupportDirectory.appendingPathComponent("repo-allowlist-patch.json")
    }

    private var controlCenterPatchPath: URL {
        appSupportDirectory.appendingPathComponent("control-center-patch.json")
    }

    private var controlCenterRollbackPath: URL {
        appSupportDirectory.appendingPathComponent("control-center-rollback.json")
    }

    private var appSupportDirectory: URL {
        dependencies.fileWriter.applicationSupportDirectory
    }

    private func writeProviderPatch() throws {
        let data = try ProviderRegistryPatchBuilder.data(for: providers)
        try dependencies.fileWriter.write(data, to: providerPatchPath)
    }

    private func writeControlCenterPatch(_ settings: DesktopControlCenterSettings, to path: URL) throws {
        let data = try DesktopControlCenterPatchBuilder.data(for: settings)
        try dependencies.fileWriter.write(data, to: path)
    }

    private func beginControlCenterOperation(_ operation: ControlCenterOperation) -> Bool {
        guard canEditProviderConfiguration else {
            lastError = "Wait for provider verification cleanup before changing config."
            return false
        }
        guard !isControlCenterOperationInProgress else {
            lastError = "Another control-center operation is still running."
            return false
        }
        isControlCenterOperationInProgress = true
        controlCenterStatus = operation.statusText
        return true
    }

    private func runControlCenterPatch(operation: ControlCenterOperation, arguments: [String], command: DesktopCommand) {
        runCLI(arguments: arguments, displayCommand: command, controlCenterOperation: operation)
    }

    private func runRepoSelectionPatch(dryRun: Bool) {
        guard requireLocalWorkerCLI() else { return }
        guard canEditProviderConfiguration else {
            lastError = "Wait for provider verification cleanup before changing config."
            return
        }
        guard !isConfigInitializationInProgress,
              !isConfigPatchInProgress,
              !isConfigInspectInProgress
        else {
            lastError = "Another config operation is still running."
            return
        }
        do {
            try writeRepoSelectionPatch()
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return
        }
        var arguments = [
            "config",
            "patch",
            "--config",
            configPath,
            "--input",
            repoSelectionPatchPath.path,
            "--dry-run",
            dryRun ? "true" : "false"
        ]
        if !dryRun {
            arguments.append(contentsOf: ["--confirm", "true"])
        }
        let proof: PendingRepoPatchProof?
        if !dryRun {
            appliedRepoSelection = nil
            proof = PendingRepoPatchProof(
                id: UUID(),
                repositories: uniqueSortedRepoNames(
                    repos.filter(\.enabled).map(\.name)
                ),
                removedProfileNames: pendingRemovedRepoProfileNames,
                managedRepository: managedGitHubAvailable
                    ? selectedManagedGitHubRepository
                    : nil,
                configPath: configPath
            )
            pendingRepoPatchProof = proof
        } else {
            proof = nil
        }
        runCLI(
            arguments: arguments,
            displayCommand: dryRun ? repoSelectionPatchPreviewCommand : repoSelectionPatchApplyCommand,
            repoPatchProof: proof
        )
    }

    @discardableResult
    private func requireLocalWorkerCLI() -> Bool {
        guard localWorkerCLIAvailable else {
            let message =
                "Local worker command \(cliPath) is unavailable. Choose Install / Update Local Worker before continuing."
            lastError = message
            logText = message
            configInitializationStatus = message
            return false
        }
        return true
    }

    private func gitHubAccessTokenForAPI(workspaceGeneration: UInt64) async throws -> String {
        guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
        guard let accessToken = try dependencies.secretStore.readSecret(account: githubUserTokenAccount), !accessToken.isEmpty else {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            clearStoredGitHubAuthorization(status: "connect GitHub first")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("Connect GitHub before refreshing accessible repositories.")
        }
        guard let expiresAt = readGitHubStoredDate(account: githubTokenExpiresAtAccount) else {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            return accessToken
        }
        if expiresAt > dependencies.clock.now.addingTimeInterval(60) {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            return accessToken
        }
        guard let clientId = github.clientId?.trimmingCharacters(in: .whitespacesAndNewlines), !clientId.isEmpty else {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired and the public client ID is missing. Reconnect GitHub after loading config.")
        }
        guard let refreshToken = try dependencies.secretStore.readSecret(account: githubRefreshTokenAccount), !refreshToken.isEmpty else {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired. Reconnect GitHub.")
        }
        if let refreshExpiresAt = readGitHubStoredDate(account: githubRefreshTokenExpiresAtAccount), refreshExpiresAt <= dependencies.clock.now {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            clearStoredGitHubAuthorization(status: "refresh expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub refresh token expired. Reconnect GitHub.")
        }
        githubAuthorizationStatus = "refreshing GitHub authorization"
        let refreshedToken: GitHubUserToken
        do {
            refreshedToken = try await dependencies.githubAuthenticator.refreshUserToken(clientId: clientId, refreshToken: refreshToken)
        } catch {
            guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
            clearStoredGitHubAuthorization(status: "refresh failed; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization refresh failed. Reconnect GitHub.")
        }
        guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
        try storeGitHubToken(refreshedToken)
        guard isCurrentWorkspace(workspaceGeneration) else { throw CancellationError() }
        githubAuthorizationStatus = "GitHub authorization refreshed"
        return refreshedToken.accessToken
    }

    private func pollGitHubAuthorization(
        clientId: String,
        code: GitHubDeviceAuthorizationCode,
        workspaceGeneration: UInt64
    ) async {
        var intervalSeconds = code.intervalSeconds
        while isCurrentWorkspace(workspaceGeneration)
            && dependencies.clock.now < code.expiresAt {
            do {
                try await dependencies.clock.sleep(for: .seconds(max(1, intervalSeconds)))
                guard isCurrentWorkspace(workspaceGeneration) else { return }
                let result = try await dependencies.githubAuthenticator.pollDeviceAuthorization(clientId: clientId, deviceCode: code.deviceCode)
                guard isCurrentWorkspace(workspaceGeneration) else { return }
                switch result {
                case .pending(let nextInterval):
                    intervalSeconds = max(1, nextInterval)
                    githubAuthorizationStatus = "waiting for authorization"
                case .authorized(let token):
                    let user = try await dependencies.githubAuthenticator.fetchCurrentUser(accessToken: token.accessToken)
                    guard isCurrentWorkspace(workspaceGeneration) else { return }
                    let discovered = try await dependencies.githubAuthenticator.listAccessibleRepositories(accessToken: token.accessToken)
                    guard isCurrentWorkspace(workspaceGeneration) else { return }
                    try storeGitHubToken(token)
                    applyGitHubDiscovery(user: user, discovered: discovered)
                    isGitHubAuthorizationInProgress = false
                    githubAuthorizationCode = nil
                    return
                case .failed(let error, let description):
                    isGitHubAuthorizationInProgress = false
                    githubAuthorizationStatus = error.rawValue
                    github.installationState = "authorization failed"
                    let recovery = GitHubConnectionRecoveryClassifier.deviceAuthorizationFailure(error, description: description)
                    githubRecovery = recovery
                    lastError = recovery.message
                    logText = recovery.message
                    return
                }
            } catch {
                guard isCurrentWorkspace(workspaceGeneration) else { return }
                isGitHubAuthorizationInProgress = false
                applyGitHubFailure(error, fallbackStatus: "authorization failed")
                return
            }
        }
        if isCurrentWorkspace(workspaceGeneration) {
            isGitHubAuthorizationInProgress = false
            let recovery = GitHubConnectionRecoveryClassifier.deviceCodeExpired
            githubAuthorizationStatus = recovery.status
            github.installationState = recovery.status
            githubRecovery = recovery
            lastError = recovery.message
            logText = recovery.message
        }
    }

    private func storeGitHubToken(_ token: GitHubUserToken) throws {
        try dependencies.secretStore.setSecret(token.accessToken, account: githubUserTokenAccount)
        if let refreshToken = token.refreshToken {
            try dependencies.secretStore.setSecret(refreshToken, account: githubRefreshTokenAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenAccount)
        }
        if let expiresAt = token.expiresAt {
            try dependencies.secretStore.setSecret(ISO8601DateFormatter().string(from: expiresAt), account: githubTokenExpiresAtAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubTokenExpiresAtAccount)
        }
        if let refreshTokenExpiresAt = token.refreshTokenExpiresAt {
            try dependencies.secretStore.setSecret(ISO8601DateFormatter().string(from: refreshTokenExpiresAt), account: githubRefreshTokenExpiresAtAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
        }
        github.userTokenStored = true
    }

    private func applyGitHubDiscovery(user: GitHubAuthenticatedUser, discovered: [GitHubDiscoveredRepository]) {
        discoveredGitHubRepos = discovered
        repos = GitHubRepositoryDiscovery.mergeConfiguredAndDiscoveredRepos(configured: repos, discovered: discovered)
        github.userTokenStored = true
        github.authorizedUserLogin = user.login
        github.installationCount = Set(discovered.map(\.installationId)).count
        github.discoveredRepositoryCount = discovered.count
        github.installationState = discovered.isEmpty
            ? "authorized as \(user.login); no accessible App repositories found"
            : "authorized as \(user.login); \(discovered.count) repositories available"
        githubRecovery = discovered.isEmpty ? GitHubConnectionRecoveryClassifier.noInstallations : nil
        githubAuthorizationStatus = "authorized as \(user.login)"
        lastError = nil
        logText = "GitHub connected as \(user.login). Select repositories, then preview or apply the allowlist patch."
        try? dependencies.secretStore.setSecret(user.login, account: githubUserLoginAccount)
    }

    private func clearStoredGitHubAuthorization(status: String) {
        try? dependencies.secretStore.deleteSecret(account: githubUserTokenAccount)
        try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenAccount)
        try? dependencies.secretStore.deleteSecret(account: githubTokenExpiresAtAccount)
        try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
        try? dependencies.secretStore.deleteSecret(account: githubUserLoginAccount)
        github.userTokenStored = false
        github.authorizedUserLogin = nil
        github.installationCount = 0
        github.discoveredRepositoryCount = 0
        github.installationState = status
        githubAuthorizationStatus = status
        githubAuthorizationCode = nil
        discoveredGitHubRepos = []
    }

    private func applyGitHubFailure(_ error: Error, fallbackStatus: String) {
        let recovery = (error as? GitHubDeviceAuthClientError)?.recovery
            ?? GitHubConnectionRecovery(
                status: fallbackStatus,
                message: NeonDiffRedactor.redact(error.localizedDescription),
                action: .retry
            )
        githubRecovery = recovery
        githubAuthorizationStatus = recovery.status
        github.installationState = recovery.status
        lastError = recovery.message
        logText = recovery.message
    }

    private func authorizeExistingManagedGitHubInstallation(
        broker: any GitHubBrokerConnecting,
        identity: GitHubBrokerDeviceIdentity,
        connection: GitHubBrokerConnection,
        workspaceGeneration: UInt64
    ) async throws -> Int? {
        guard let clientId = dependencies.productionBoundary.managedGitHubAppClientID?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !clientId.isEmpty
        else {
            throw ManagedGitHubModelError.clientIdMissing
        }
        let code = try await dependencies.githubAuthenticator.requestDeviceCode(clientId: clientId)
        guard isCurrentWorkspace(workspaceGeneration) else { return nil }
        githubAuthorizationCode = code
        managedGitHubConnectionState = .awaitingAuthorization
        logText = "Authorize NeonDiff at \(code.verificationURI.absoluteString) with code \(code.userCode). The user token is transient proof only; reviews use the GitHub App."

        var intervalSeconds = code.intervalSeconds
        while isCurrentWorkspace(workspaceGeneration),
              dependencies.clock.now < code.expiresAt,
              dependencies.clock.now < connection.expiresAt {
            try await dependencies.clock.sleep(for: .seconds(max(1, intervalSeconds)))
            guard isCurrentWorkspace(workspaceGeneration) else { return nil }
            switch try await broker.completeConnection(
                identity: identity,
                state: connection.state
            ) {
            case .bound(let callbackInstallationId):
                return callbackInstallationId
            case .pending:
                break
            }
            guard isCurrentWorkspace(workspaceGeneration) else { return nil }
            switch try await dependencies.githubAuthenticator.pollDeviceAuthorization(
                clientId: clientId,
                deviceCode: code.deviceCode
            ) {
            case .pending(let nextInterval):
                intervalSeconds = max(1, nextInterval)
                managedGitHubConnectionState = .awaitingAuthorization
            case .failed(let error, let description):
                throw GitHubDeviceAuthClientError.actionable(
                    GitHubConnectionRecoveryClassifier.deviceAuthorizationFailure(
                        error,
                        description: description
                    )
                )
            case .authorized(let token):
                let discovered = try await dependencies.githubAuthenticator.listAccessibleRepositories(
                    accessToken: token.accessToken
                )
                guard isCurrentWorkspace(workspaceGeneration) else { return nil }
                let grouped = Dictionary(grouping: discovered, by: \.installationId)
                let candidates: [ManagedGitHubInstallationCandidate] = grouped.compactMap { element -> ManagedGitHubInstallationCandidate? in
                    let installationId = element.key
                    let repositories = element.value
                    guard let first = repositories.first else { return nil }
                    return ManagedGitHubInstallationCandidate(
                        installationId: installationId,
                        account: first.installationAccount,
                        repositoryCount: Set(repositories.map(\.fullName)).count
                    )
                }.sorted { $0.installationId < $1.installationId }
                guard !candidates.isEmpty else {
                    throw ManagedGitHubModelError.noAuthorizedInstallations
                }
                githubAuthorizationCode = nil
                if candidates.count == 1, let candidate = candidates.first {
                    switch try await broker.completeConnection(
                        identity: identity,
                        state: connection.state
                    ) {
                    case .bound(let callbackInstallationId):
                        return callbackInstallationId
                    case .pending:
                        return try await authorizeExistingInstallationWithReplayReadback(
                            broker: broker,
                            identity: identity,
                            connection: connection,
                            installationId: candidate.installationId,
                            userAccessToken: token.accessToken
                        )
                    }
                }
                guard isCurrentWorkspace(workspaceGeneration) else { return nil }
                pendingManagedGitHubAuthorization = PendingManagedGitHubAuthorization(
                    identity: identity,
                    connection: connection,
                    userAccessToken: token.accessToken,
                    candidates: candidates
                )
                managedGitHubInstallationCandidates = candidates
                managedGitHubConnectionState = .installationSelectionRequired
                logText = "Choose the GitHub App installation to bind. NeonDiff will send the transient authorization proof only after that explicit choice."
                return nil
            }
        }
        throw ManagedGitHubModelError.authorizationExpired
    }

    private func authorizeExistingInstallationWithReplayReadback(
        broker: any GitHubBrokerConnecting,
        identity: GitHubBrokerDeviceIdentity,
        connection: GitHubBrokerConnection,
        installationId: Int,
        userAccessToken: String
    ) async throws -> Int {
        do {
            return try await broker.authorizeExistingInstallation(
                identity: identity,
                state: connection.state,
                installationId: installationId,
                userAccessToken: userAccessToken
            )
        } catch let error as GitHubBrokerClientError
            where error == .server(reason: .stateReplayed) {
            // The browser callback can consume the one-shot state after the
            // pre-submit completion poll but before this request wins its store
            // race. Resolve that one exact ambiguity with one authoritative,
            // device-authenticated readback; never retry or resubmit the token.
            switch try await broker.completeConnection(
                identity: identity,
                state: connection.state
            ) {
            case .bound(let callbackInstallationId):
                return callbackInstallationId
            case .pending:
                throw error
            }
        }
    }

    private func loadManagedGitHubRepositories(
        broker: any GitHubBrokerConnecting,
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int,
        workspaceGeneration: UInt64
    ) async throws {
        var pageNumber = 1
        var repositories: [GitHubBrokerRepository] = []
        while isCurrentWorkspace(workspaceGeneration) {
            let page = try await broker.listRepositories(
                identity: identity,
                installationId: installationId,
                page: pageNumber
            )
            guard isCurrentWorkspace(workspaceGeneration) else { return }
            guard page.installationId == installationId,
                  page.page == pageNumber
            else {
                throw GitHubBrokerClientError.scopeMismatch
            }
            repositories.append(contentsOf: page.repositories)
            guard let nextPage = page.nextPage else { break }
            guard nextPage == pageNumber + 1, nextPage <= 200 else {
                throw GitHubBrokerClientError.scopeMismatch
            }
            pageNumber = nextPage
        }
        guard isCurrentWorkspace(workspaceGeneration) else { return }
        let names = repositories.map(\.fullName)
        guard !repositories.isEmpty,
              Set(names).count == names.count
        else {
            throw ManagedGitHubModelError.noBoundRepositories
        }
        managedGitHubRepositories = repositories.sorted {
            $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending
        }
        managedGitHubRepositoriesVerifiedAt = dependencies.clock.now
        managedGitHubConnectionState = .bound(installationId: installationId)
        managedGitHubRecovery = nil
        lastError = nil
        logText = "\(repositories.count) server-bound GitHub repositories verified. Select one to continue."
    }

    private func isCurrentWorkspace(_ generation: UInt64) -> Bool {
        !Task.isCancelled && workspaceContextGeneration == generation
    }

    private func applyManagedGitHubFailure(_ error: Error) {
        invalidateRepoApplicationProof()
        pendingManagedGitHubAuthorization = nil
        managedGitHubInstallationCandidates = []
        githubAuthorizationCode = nil
        managedGitHubConnectionState = .failed
        managedGitHubRepositories = []
        managedGitHubRepositoriesVerifiedAt = nil
        selectedManagedGitHubRepository = nil
        let recovery: GitHubConnectionRecovery
        if let brokerError = error as? GitHubBrokerClientError {
            switch brokerError {
            case .server(reason: .rateLimited),
                 .server(reason: .brokerUnavailable),
                 .server(reason: .entitlementServiceUnavailable),
                 .transportUnavailable:
                recovery = GitHubConnectionRecovery(
                    status: "broker unavailable",
                    message: "The managed GitHub service is unavailable. No repository access was granted. Retry later.",
                    action: .retryLater
                )
            case .server(reason: .installationNotFound),
                 .server(reason: .installationUninstalled),
                 .server(reason: .installationSuspended),
                 .server(reason: .installationAuthorizationUnverified),
                 .server(reason: .bindingNotFound):
                recovery = GitHubConnectionRecovery(
                    status: "App installation unavailable",
                    message: "The GitHub App installation is missing, suspended, or no longer authorized. Reconnect and manage selected repository access.",
                    action: .installOrManageApp
                )
            default:
                recovery = GitHubConnectionRecovery(
                    status: "managed GitHub verification failed",
                    message: "Managed GitHub verification failed closed. Reconnect; if it persists, contact support with redacted diagnostics.",
                    action: .reconnect
                )
            }
        } else if let identityError = error as? GitHubBrokerDeviceIdentityError {
            recovery = GitHubConnectionRecovery(
                status: "device identity unavailable",
                message: "The Keychain-backed GitHub device identity is unavailable. NeonDiff did not create a replacement binding.",
                action: identityError == .storedIdentityMissing ? .reconnect : .retry
            )
        } else if let modelError = error as? ManagedGitHubModelError {
            recovery = modelError.recovery
        } else {
            recovery = GitHubConnectionRecovery(
                status: "managed GitHub verification failed",
                message: "Managed GitHub verification failed closed. Retry with the App installed on a selected repository.",
                action: .retry
            )
        }
        managedGitHubRecovery = recovery
        lastError = recovery.message
        logText = recovery.message
    }

    private static func savedManagedGitHubInstallationId(
        preferences: any DesktopPreferences
    ) -> Int? {
        guard let raw = preferences.string(forKey: managedGitHubInstallationIdKey),
              let installationId = Int(raw),
              installationId > 0
        else {
            return nil
        }
        return installationId
    }

    private var activatedRepository: String? {
        guard let repository = dependencies.preferences.string(
            forKey: activationRepositoryKey
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
        isValidRepoName(repository)
        else {
            return nil
        }
        return repository
    }

    private var storedBYOGitHubAppId: String? {
        guard let value = dependencies.preferences.string(forKey: byoGitHubAppIdPreferenceKey)
        else {
            return nil
        }
        return try? BYOGitHubAppCredentialValidator.normalizedAppId(value)
    }

    private func readGitHubStoredDate(account: String) -> Date? {
        Self.storedDate(secretStore: dependencies.secretStore, account: account)
    }

    private static func storedDate(secretStore: DesktopSecretStoring, account: String) -> Date? {
        guard let value = try? secretStore.readSecret(account: account) else {
            return nil
        }
        return ISO8601DateFormatter().date(from: value)
    }

    private func writeRepoSelectionPatch() throws {
        let selectedRepos = repos
            .filter(\.enabled)
            .map(\.name)
        let uniqueRepos = uniqueSortedRepoNames(selectedRepos)
        let configuredRepos = uniqueSortedRepoNames(
            repos.map(\.name) + Array(pendingRemovedRepoProfileNames)
        )
        let repoProfiles = Dictionary(
            uniqueKeysWithValues: configuredRepos.map { repository in
                let enabled = repos.contains {
                    $0.enabled
                        && $0.name.caseInsensitiveCompare(repository)
                            == .orderedSame
                }
                return (repository, ["enabled": enabled])
            }
        )
        let patch: [String: Any] = [
            "pilotRepos": uniqueRepos,
            "repoProfiles": [
                "repos": repoProfiles
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
        try dependencies.fileWriter.write(data, to: repoSelectionPatchPath)
    }

    private func reconcileBYOReviewRepository(
        enabledRepositories: [String]
    ) {
        guard byoGitHubCredentialOnboardingAvailable,
              !managedGitHubAvailable
        else {
            selectedBYOReviewRepository = nil
            return
        }
        let repositories = uniqueSortedRepoNames(
            enabledRepositories.filter(isValidRepoName)
        )
        if let selectedBYOReviewRepository,
           repositories.contains(where: {
               $0.caseInsensitiveCompare(selectedBYOReviewRepository)
                   == .orderedSame
           }) {
            return
        }
        let storedConfigPath = dependencies.preferences.string(
            forKey: byoReviewRepositoryConfigPathKey
        )
        let storedRepository = dependencies.preferences.string(
            forKey: byoReviewRepositoryKey
        )
        if storedConfigPath == configPath,
           let storedRepository,
           let matchedRepository = repositories.first(where: {
               $0.caseInsensitiveCompare(storedRepository) == .orderedSame
           }) {
            selectedBYOReviewRepository = matchedRepository
            return
        }
        selectedBYOReviewRepository = repositories.onlyElement
    }

    private func isAppliedBYOReviewRepository(_ fullName: String) -> Bool {
        guard let appliedRepoSelection,
              appliedRepoSelection.configPath == configPath
        else {
            return false
        }
        return appliedRepoSelection.repositories.contains {
            $0.caseInsensitiveCompare(fullName) == .orderedSame
        }
    }

    private func applyCLIResult(
        _ result: CLIRunResult,
        fallbackCommand: String,
        configPath: String,
        launchdLabel: String,
        isConfigInspectCommand: Bool,
        isConfigInitializeCommand: Bool = false,
        isDaemonStatusCommand: Bool = false,
        controlCenterOperation: ControlCenterOperation? = nil,
        providerPatchProof: PendingProviderPatchProof? = nil,
        repoPatchProof: PendingRepoPatchProof? = nil
    ) {
        guard !isConfigInspectCommand || self.configPath == configPath else {
            return
        }
        if let providerPatchProof,
           pendingProviderPatchProof?.id != providerPatchProof.id {
            return
        }
        if let repoPatchProof,
           pendingRepoPatchProof?.id != repoPatchProof.id {
            return
        }
        let redactedStdout = result.redactedStdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let redactedStderr = result.redactedStderr.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = result.exitCode == 0 ? nil : (redactedStderr.isEmpty ? redactedStdout : redactedStderr)
        logText = [result.redactedStdout, result.redactedStderr].filter { !$0.isEmpty }.joined(separator: "\n")

        let commandName = parseCommandName(result.stdout)
        if isConfigInitializeCommand {
            guard result.exitCode == 0, commandName == "init" else {
                lastError = lastError ?? "Local config initialization returned an invalid response."
                configInitializationStatus = lastError ?? "Local config initialization failed."
                return
            }
            configInitializationStatus = "Local config created. Add one repository, apply it, then verify App access."
        }
        var parsedSnapshot = (commandName == "config inspect" || commandName == "config patch")
            ? ConfigInspectParser.parse(
                result.stdout,
                providerKeyStored: false,
                licenseKeyStored: dependencies.secretStore.containsSecret(account: licenseKeyAccount),
                githubUserTokenStored: dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
            )
            : nil
        if var snapshot = parsedSnapshot {
            snapshot.providers.providerKeyStored = ProviderKeychainAccount.account(
                providerId: snapshot.providers.selectedProviderId
            ).map(dependencies.secretStore.containsSecret(account:)) == true
            parsedSnapshot = snapshot
        }
        var validatedPatchRevisionAfter: String?
        var validatedProviderRevisionAfter: String?
        if let providerPatchProof {
            validatedProviderRevisionAfter = ConfigPatchProofValidator.revisionAfter(
                snapshot: parsedSnapshot,
                expectedRevision: providerPatchProof.expectedRevision,
                mode: providerPatchProof.mode
            )
            guard result.exitCode == 0,
                  commandName == "config patch",
                  validatedProviderRevisionAfter != nil
            else {
                invalidateProviderConfigAuthorization()
                lastError = ConfigInspectParser.error(result.stdout, command: "config patch")
                    ?? lastError
                    ?? "Provider patch returned an invalid or stale response. Reload current config."
                return
            }
        }
        if let repoPatchProof {
            let appliedRepositories = uniqueSortedRepoNames(
                parsedSnapshot?.repos
                    .filter(\.enabled)
                    .map(\.name) ?? []
            )
            let repositoryAuthorityMatches = repoPatchProof.managedRepository.map {
                selectedManagedGitHubRepository == $0
                    && repoPatchProof.repositories == [$0]
            } ?? true
            guard result.exitCode == 0,
                  commandName == "config patch",
                  parsedSnapshot?.dryRun == false,
                  ConfigPatchProofValidator.revisionAfter(
                      snapshot: parsedSnapshot,
                      expectedRevision: parsedSnapshot?.revisionBefore ?? "",
                      mode: .apply
                  ) != nil,
                  appliedRepositories == repoPatchProof.repositories,
                  configPath == repoPatchProof.configPath,
                  repositoryAuthorityMatches
            else {
                invalidateRepoApplicationProof()
                lastError = ConfigInspectParser.error(result.stdout, command: "config patch")
                    ?? lastError
                    ?? "Repository allowlist apply returned invalid or mismatched readback. Apply the exact verified selection again."
                return
            }
        }
        if let operation = controlCenterOperation {
            validatedPatchRevisionAfter = ConfigPatchProofValidator.revisionAfter(
                snapshot: parsedSnapshot,
                expectedRevision: operation.expectedRevision,
                mode: operation.proofMode
            )
            guard
                result.exitCode == 0,
                commandName == "config patch",
                validatedPatchRevisionAfter != nil
            else {
                let patchError = ConfigInspectParser.error(result.stdout, command: "config patch")
                    ?? lastError
                    ?? "Config patch returned an invalid or mismatched response. Reload current config before further edits."
                invalidateControlCenterAfterPatchFailure(patchError)
                return
            }
        }
        if isConfigInspectCommand && (result.exitCode != 0 || commandName != "config inspect") {
            let inspectError = ConfigInspectParser.error(result.stdout)
                ?? lastError
                ?? "Config inspect returned an invalid response."
            invalidateProviderConfigAuthorization()
            invalidateControlCenterAfterInspectFailure(inspectError)
            return
        }
        if commandName == "config inspect" || commandName == "config patch" {
            if result.exitCode == 0,
               commandName == "config inspect",
               let inspectedRevision = parsedSnapshot?.revision,
               inspectedRevision != controlCenterLoadedRevision {
                invalidateProviderVerificationContext(status: "Config changed. Verify the stored provider key again.")
            }
            if result.exitCode == 0,
               commandName == "config patch",
               parsedSnapshot?.dryRun == false,
               parsedSnapshot?.wrote == true {
                invalidateProviderVerificationContext(status: "Config changed. Verify the stored provider key again.")
            }
            if result.exitCode == 0,
               commandName == "config patch",
               providerPatchProof == nil {
                invalidateProviderConfigAuthorization()
            }
            if let snapshot = parsedSnapshot {
                repos = snapshot.repos
                providers = snapshot.providers
                license = snapshot.license
                var parsedGitHub = snapshot.github
                parsedGitHub.userTokenStored = dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
                parsedGitHub.authorizedUserLogin = github.authorizedUserLogin
                parsedGitHub.installationCount = github.installationCount
                parsedGitHub.discoveredRepositoryCount = github.discoveredRepositoryCount
                if parsedGitHub.userTokenStored && parsedGitHub.installationState == "not connected" {
                    parsedGitHub.installationState = github.installationState
                }
                github = parsedGitHub
                if commandName == "config inspect" {
                    pendingRemovedRepoProfileNames.removeAll()
                    let inspectedRepositories = uniqueSortedRepoNames(
                        snapshot.repos
                            .filter(\.enabled)
                            .map(\.name)
                    )
                    reconcileBYOReviewRepository(
                        enabledRepositories: inspectedRepositories
                    )
                    appliedRepoSelection = self.configPath == configPath
                        && !inspectedRepositories.isEmpty
                        ? AppliedRepoSelection(
                            repositories: inspectedRepositories,
                            configPath: configPath
                        )
                        : nil
                    providerLoadedSnapshot = ProviderConfigurationSnapshot(
                        providers: snapshot.providers,
                        configPath: configPath
                    )
                    providerLoadedRevision = snapshot.revision
                    previewedProviderSnapshot = nil
                    previewedProviderExpectedRevision = nil
                    controlCenter = snapshot.policy
                    controlCenterLoadedSnapshot = DesktopControlCenterSnapshot(
                        settings: snapshot.policy,
                        configPath: configPath
                    )
                    controlCenterLoadedRevision = snapshot.revision
                    controlCenterRollbackSnapshot = nil
                    controlCenterRollbackExpectedRevision = nil
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if self.configPath == configPath {
                        controlCenterStatus = "Current config loaded. Edit settings, then Preview."
                    } else {
                        controlCenterStatus = "Config loaded from a previous path. Reload the current config before editing."
                    }
                    if existingLocalAgentAccessAvailable {
                        checkLocalWorkerReviewCompatibility()
                    } else {
                        invalidateLocalWorkerReviewCompatibility()
                    }
                }
            }
            if commandName == "config inspect", result.exitCode != 0 || parsedSnapshot == nil {
                let inspectError = ConfigInspectParser.error(result.stdout)
                    ?? lastError
                    ?? "Config inspect returned an invalid response."
                invalidateProviderConfigAuthorization()
                invalidateControlCenterAfterInspectFailure(inspectError)
                return
            }
            if commandName == "config patch",
               let providerPatchProof,
               let revisionAfter = validatedProviderRevisionAfter,
               let snapshot = parsedSnapshot {
                switch providerPatchProof.mode {
                case .preview:
                    previewedProviderSnapshot = providerPatchProof.snapshot
                    previewedProviderExpectedRevision = providerPatchProof.expectedRevision
                    providerVerificationStatus = "Provider preview passed. Apply this exact configuration before verification."
                case .apply:
                    providerLoadedSnapshot = ProviderConfigurationSnapshot(
                        providers: snapshot.providers,
                        configPath: configPath
                    )
                    providerLoadedRevision = revisionAfter
                    previewedProviderSnapshot = nil
                    previewedProviderExpectedRevision = nil
                    providerVerificationStatus = "Provider config applied and read back. Verification is enabled for eligible targets."
                }
                clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            }
            if commandName == "config patch", let repoPatchProof {
                pendingRemovedRepoProfileNames.subtract(
                    repoPatchProof.removedProfileNames
                )
                appliedRepoSelection = AppliedRepoSelection(
                    repositories: repoPatchProof.repositories,
                    configPath: repoPatchProof.configPath
                )
                clearPendingRepoPatchProof(ifOwnedBy: repoPatchProof)
                logText = "Repository allowlist applied and read back for \(repoPatchProof.repositories.joined(separator: ", "))."
            }
            if commandName == "config patch",
               let operation = controlCenterOperation,
               let revisionAfter = validatedPatchRevisionAfter {
                switch operation {
                case .preview(let snapshot, let baseline, let expectedRevision):
                    previewedControlCenterSnapshot = snapshot
                    previewedControlCenterBaseline = baseline
                    previewedControlCenterExpectedRevision = expectedRevision
                    controlCenterStatus = snapshot == currentControlCenterSnapshot
                        ? "Preview passed. Apply is enabled for this exact settings snapshot."
                        : "Preview passed for an earlier settings snapshot. Preview the current edits before Apply."
                case .apply(let snapshot, let baseline, _):
                    controlCenter = snapshot.settings
                    controlCenterLoadedSnapshot = snapshot
                    controlCenterLoadedRevision = revisionAfter
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if parsedSnapshot?.wrote == true {
                        controlCenterRollbackSnapshot = baseline
                        controlCenterRollbackExpectedRevision = revisionAfter
                        controlCenterStatus = self.configPath == snapshot.configPath
                            ? "Config applied. Apply Last Rollback is now available."
                            : "Config applied to the previously selected path. Return to that path to roll back, or load the current config."
                    } else {
                        if controlCenterRollbackSnapshot?.configPath != snapshot.configPath
                            || controlCenterRollbackExpectedRevision != revisionAfter {
                            controlCenterRollbackSnapshot = nil
                            controlCenterRollbackExpectedRevision = nil
                        }
                        controlCenterStatus = "No config changes were needed."
                    }
                case .rollback(let snapshot, _):
                    controlCenter = snapshot.settings
                    controlCenterLoadedSnapshot = snapshot
                    controlCenterLoadedRevision = revisionAfter
                    controlCenterRollbackSnapshot = nil
                    controlCenterRollbackExpectedRevision = nil
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if parsedSnapshot?.wrote == true {
                        controlCenterStatus = self.configPath == snapshot.configPath
                            ? "Rollback applied. Reload config before further edits."
                            : "Rollback applied to the previously selected path. Load the current config before further edits."
                    } else {
                        controlCenterStatus = "Config was already at the rollback target. Reload before further edits."
                    }
                }
                if let warning = parsedSnapshot?.warning {
                    lastError = NeonDiffRedactor.redact(warning)
                    controlCenterStatus = lastError ?? "Config patch completed with a lock-cleanup warning."
                }
                isControlCenterOperationInProgress = false
            }
            return
        }

        if let parsed = DaemonStatusParser.parse(result.stdout, launchdLabel: launchdLabel, fallbackCommand: fallbackCommand) {
            status = parsed.0
            statusRefreshFailureMessage = nil
            if isDaemonStatusCommand {
                // A valid status envelope may intentionally use a nonzero exit
                // when one or more runtime gates need attention. Keep the full
                // redacted envelope in `logText` for Advanced Diagnostics, but
                // do not surface that JSON as a generic customer error.
                lastError = nil
            }
            onboardingFlow.daemonBootstrapChecked = true
            if !parsed.1.isEmpty {
                repos = parsed.1
            }
        } else if isDaemonStatusCommand {
            let message = "Local worker status check failed. Retry or open Advanced Diagnostics."
            status = .unknown
            onboardingFlow.daemonBootstrapChecked = false
            lastError = message
            statusRefreshFailureMessage = message
        }
    }

    func applyCLIResultForTesting(
        _ result: CLIRunResult,
        fallbackCommand: String,
        configPath: String,
        launchdLabel: String,
        isConfigInspectCommand: Bool,
        isDaemonStatusCommand: Bool = false
    ) {
        applyCLIResult(
            result,
            fallbackCommand: fallbackCommand,
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: isConfigInspectCommand,
            isDaemonStatusCommand: isDaemonStatusCommand
        )
    }

    func applyProviderPatchResultForTesting(_ result: CLIRunResult, mode: ConfigPatchProofMode) {
        guard let expectedRevision = mode == .preview ? providerLoadedRevision : previewedProviderExpectedRevision else {
            return
        }
        pendingProviderPatchProof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: desiredProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: mode
        )
        let proof = pendingProviderPatchProof
        applyCLIResult(
            result,
            fallbackCommand: "neondiff config patch",
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: false,
            providerPatchProof: proof
        )
    }

    func stageProviderPatchProofForTesting(mode: ConfigPatchProofMode) {
        guard !isConfigPatchInProgress, !isConfigInspectInProgress else { return }
        guard let expectedRevision = mode == .preview ? providerLoadedRevision : previewedProviderExpectedRevision else {
            return
        }
        pendingProviderPatchProof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: desiredProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: mode
        )
        isConfigPatchInProgress = true
    }

    func applyStagedProviderPatchResultForTesting(_ result: CLIRunResult) {
        let proof = pendingProviderPatchProof
        applyCLIResult(
            result,
            fallbackCommand: "neondiff config patch",
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: false,
            providerPatchProof: proof
        )
        clearPendingProviderPatchProof(ifOwnedBy: proof)
        isConfigPatchInProgress = false
    }

    func attemptOverlappingProviderPatchForTesting() {
        runProviderConfigPatch(dryRun: true)
    }

    private func parseCommandName(_ jsonText: String) -> String? {
        guard
            let data = jsonText.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return root["command"] as? String
    }

    private func invalidateControlCenterAfterInspectFailure(_ message: String) {
        invalidateControlCenterAuthorization(message)
        controlCenterStatus = lastError ?? "Config inspect failed."
    }

    private func invalidateProviderConfigAuthorization() {
        providerLoadedSnapshot = nil
        providerLoadedRevision = nil
        previewedProviderSnapshot = nil
        previewedProviderExpectedRevision = nil
        pendingProviderPatchProof = nil
    }

    private func clearPendingProviderPatchProof(ifOwnedBy proof: PendingProviderPatchProof?) {
        guard let proof, pendingProviderPatchProof?.id == proof.id else { return }
        pendingProviderPatchProof = nil
    }

    private func clearPendingRepoPatchProof(ifOwnedBy proof: PendingRepoPatchProof?) {
        guard let proof, pendingRepoPatchProof?.id == proof.id else { return }
        pendingRepoPatchProof = nil
    }

    private func invalidateRepoApplicationProof() {
        appliedRepoSelection = nil
        pendingRepoPatchProof = nil
    }

    private func invalidateActivationForRepositoryChange() {
        activationRequestGeneration &+= 1
        if activationState == .activationPending {
            applyActivationEvent(.checkoutCancelled)
            onboardingFlow.licenseActivation = .servicePending
            lastError = "Repository context changed during activation. Review the current target, then retry safely."
        }
        guard activationVerifiedThisLaunch
                || activationVerifiedRepositoryThisLaunch != nil
        else {
            return
        }
        activationVerifiedThisLaunch = false
        activationVerifiedRepositoryThisLaunch = nil
        dependencies.preferences.set("", forKey: activationRepositoryKey)
        if activationState == .active {
            activationState = license.keyStored ? .keyReady : .purchaseRequired
            dependencies.preferences.set(
                activationState.rawValue,
                forKey: activationStateKey
            )
        }
        onboardingFlow.licenseActivation = .servicePending
    }

    private func invalidateControlCenterAfterPatchFailure(_ message: String) {
        invalidateControlCenterAuthorization(message)
        controlCenterStatus = lastError ?? "Config patch failed. Reload current config."
    }

    private func invalidateControlCenterAuthorization(_ message: String) {
        controlCenterLoadedSnapshot = nil
        controlCenterLoadedRevision = nil
        controlCenterRollbackSnapshot = nil
        controlCenterRollbackExpectedRevision = nil
        previewedControlCenterSnapshot = nil
        previewedControlCenterBaseline = nil
        previewedControlCenterExpectedRevision = nil
        lastError = NeonDiffRedactor.redact(message)
    }

}

private struct ProviderVerificationRequestContext: Equatable {
    let configPath: String
    let cliPath: String
    let providers: ProviderSettings
    let loadedConfigRevision: String?
    let providerKeyRevision: UInt64
}

private struct ProviderConfigurationSnapshot: Equatable, Sendable {
    let configPath: String
    let zcodeModel: String
    let zcodeCliPath: String
    let zcodeAppConfigPath: String
    let zcodeProviderId: String
    let selectedProviderId: String
    let registryTargets: [ProviderRegistryTarget]

    init(
        providers: ProviderSettings,
        configPath: String
    ) {
        self.configPath = configPath
        zcodeModel = providers.zcodeModel
        zcodeCliPath = providers.zcodeCliPath
        zcodeAppConfigPath = providers.zcodeAppConfigPath
        zcodeProviderId = providers.zcodeProviderId
        selectedProviderId = providers.selectedProviderId
        registryTargets = providers.registryTargets
    }
}

private struct PendingProviderPatchProof: Sendable {
    let id: UUID
    let snapshot: ProviderConfigurationSnapshot
    let expectedRevision: String
    let mode: ConfigPatchProofMode
}

private struct PendingRepoPatchProof: Sendable {
    let id: UUID
    let repositories: [String]
    let removedProfileNames: Set<String>
    let managedRepository: String?
    let configPath: String
}

private struct AppliedRepoSelection: Equatable, Sendable {
    let repositories: [String]
    let configPath: String
}

private enum ControlCenterOperation: Sendable {
    case preview(
        snapshot: DesktopControlCenterSnapshot,
        baseline: DesktopControlCenterSnapshot,
        expectedRevision: String
    )
    case apply(
        snapshot: DesktopControlCenterSnapshot,
        baseline: DesktopControlCenterSnapshot,
        expectedRevision: String
    )
    case rollback(snapshot: DesktopControlCenterSnapshot, expectedRevision: String)

    var statusText: String {
        switch self {
        case .preview: "Previewing control-center patch..."
        case .apply: "Applying validated control-center patch..."
        case .rollback: "Applying last control-center rollback..."
        }
    }

    var expectedRevision: String {
        switch self {
        case .preview(_, _, let expectedRevision),
             .apply(_, _, let expectedRevision),
             .rollback(_, let expectedRevision):
            expectedRevision
        }
    }

    var proofMode: ConfigPatchProofMode {
        switch self {
        case .preview: .preview
        case .apply, .rollback: .apply
        }
    }
}

private enum GitHubDesktopAuthorizationStateError: LocalizedError {
    case reconnectRequired(String)

    var errorDescription: String? {
        switch self {
        case .reconnectRequired(let message):
            message
        }
    }
}

private struct BYOGitHubDoctorReport: Decodable {
    let ok: Bool
    let command: String
    let appCredentials: Credentials
    let github: GitHub

    struct Credentials: Decodable {
        let appIdConfigured: Bool
        let privateKeyConfigured: Bool
        let source: String
    }

    struct GitHub: Decodable {
        let canPostAsApp: Bool
        let readMode: String
        let readChecks: [ReadCheck]
    }

    struct ReadCheck: Decodable {
        let repo: String
        let ok: Bool
        let visibilityResult: String?
        let skippedByPolicy: String?
        let installationIdPresent: Bool
        let appCanReadMetadata: Bool
        let appCanReadPullRequests: Bool

        enum CodingKeys: String, CodingKey {
            case repo
            case ok
            case visibilityResult = "visibility_result"
            case skippedByPolicy
            case installationIdPresent = "installation_id_present"
            case appCanReadMetadata = "app_can_read_metadata"
            case appCanReadPullRequests = "app_can_read_pull_requests"
        }
    }
}

private struct BYOGitHubVerificationContext: Equatable, Sendable {
    enum CredentialSource: Equatable, Sendable {
        case keychainStdin
        case keychainStdinExistingBot
        case existingLocalAgent
    }

    let appId: String
    let source: CredentialSource
    let credentialRevision: UInt64
    let cliPath: String
    let configPath: String
    let repositories: [String]
    let workspaceGeneration: UInt64
}

private struct ScopedReviewApproval: Equatable, Sendable {
    let repo: String
    let pullNumber: Int
    let headSHA: String
    let configPath: String
    let configRevision: String
    let workspaceGeneration: UInt64
    let workerCompatibilityGeneration: UInt64
}

private struct ScopedReviewCommandReport: Decodable {
    struct Scope: Decodable {
        let repo: String
        let pullNumber: Int
        let headSha: String
    }

    struct Result: Decodable {
        let reviewed: Int
        let skippedProcessed: Int

        private enum CodingKeys: String, CodingKey {
            case reviewed
            case skippedProcessed
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            reviewed = try values.decode(Int.self, forKey: .reviewed)
            skippedProcessed = try values.decodeIfPresent(
                Int.self,
                forKey: .skippedProcessed
            ) ?? 0
        }
    }

    let ok: Bool
    let command: String
    let dryRun: Bool
    let scope: Scope
    let result: Result
}

private let licenseKeyAccount = "license/default"
private let githubUserTokenAccount = "github/user-access-token"
private let githubRefreshTokenAccount = "github/user-refresh-token"
private let githubTokenExpiresAtAccount = "github/user-token-expires-at"
private let githubRefreshTokenExpiresAtAccount = "github/user-refresh-token-expires-at"
private let githubUserLoginAccount = "github/user-login"
private let onboardingCompletedKey = "neondiff.hasCompletedActivationOnboarding.v2"
// Issue #612 — native activation handoff. The activation state machine and the
// production license CLI share one canonical Keychain item; there is no second
// raw activation-key copy.
private let activationKeyAccount = "license/default"
private let activationStateKey = "neondiff.activationState.v1"
private let activationRepositoryKey = "neondiff.activationRepository.v1"
private let byoReviewRepositoryKey = "neondiff.byoReviewRepository.v1"
private let byoReviewRepositoryConfigPathKey = "neondiff.byoReviewRepositoryConfigPath.v1"
private let activationHandoffEnabledKey = "neondiff.activationHandoffEnabled"
private let activationCheckoutEnabledKey = "neondiff.activationCheckoutEnabled"
private let activationCliBackedEnabledKey = "neondiff.activationCliBackedValidation"
private let managedGitHubInstallationIdKey = "neondiff.managedGitHubInstallationId"
private let byoGitHubAppIdPreferenceKey = "neondiff.byoGitHubAppId"

private enum ManagedGitHubModelError: Error {
    case installPageOpenFailed
    case clientIdMissing
    case authorizationExpired
    case noAuthorizedInstallations
    case noBoundRepositories

    var recovery: GitHubConnectionRecovery {
        switch self {
        case .installPageOpenFailed:
            GitHubConnectionRecovery(
                status: "GitHub install page unavailable",
                message: "NeonDiff could not open the GitHub App installation page. No repository binding was granted.",
                action: .retry
            )
        case .clientIdMissing:
            GitHubConnectionRecovery(
                status: "GitHub App client ID unavailable",
                message: "This build is missing the official public GitHub App client ID required for managed authorization. Install a verified NeonDiff beta build before reconnecting.",
                action: .retry
            )
        case .authorizationExpired:
            GitHubConnectionRecovery(
                status: "GitHub authorization expired",
                message: "GitHub authorization expired before the server binding completed. Start a new connection.",
                action: .reconnect
            )
        case .noAuthorizedInstallations:
            GitHubConnectionRecovery(
                status: "no authorized App installation",
                message: "GitHub authorization succeeded, but no selected NeonDiff App repositories are accessible. Install or manage the App, then reconnect.",
                action: .installOrManageApp
            )
        case .noBoundRepositories:
            GitHubConnectionRecovery(
                status: "no bound repositories",
                message: "The GitHub App binding contains no selected repositories. Manage App access, then refresh.",
                action: .installOrManageApp
            )
        }
    }
}

private enum AccountLinkModelError: Error {
    case browserOpenFailed
    case expired
}

private struct PendingManagedGitHubAuthorization {
    let identity: GitHubBrokerDeviceIdentity
    let connection: GitHubBrokerConnection
    let userAccessToken: String
    let candidates: [ManagedGitHubInstallationCandidate]
}

private func isValidRepoName(_ value: String) -> Bool {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    return parts.allSatisfy { part in
        !part.isEmpty && part != "." && part != ".." && part.allSatisfy { character in
            character.isLetter || character.isNumber || character == "-" || character == "_" || character == "."
        }
    }
}

private func uniqueSortedRepoNames(_ names: [String]) -> [String] {
    var seen = Set<String>()
    return names
        .filter(isValidRepoName)
        .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        .filter { seen.insert($0.lowercased()).inserted }
}

private func normalizedExactRepoNames(_ names: [String]) -> [String]? {
    let normalized = names.map {
        $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
    guard normalized.allSatisfy(isValidRepoName),
          Set(normalized).count == normalized.count
    else {
        return nil
    }
    return normalized.sorted()
}

private extension Collection {
    var onlyElement: Element? {
        count == 1 ? first : nil
    }
}
