import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
struct DesktopSetupReadiness {
    let isRestoring: Bool
    let github: Bool
    let provider: Bool
    let license: Bool
    let licenseStatus: String
    let repository: Bool
    let repositoryName: String
    let canRunDryRun: Bool

    init(model: NeonDiffDesktopModel) {
        isRestoring = model.isExistingLocalBotRestoreInProgress
        github = model.githubSetupReady
        provider = model.providerSetupReady
        let publicRepositoryLicenseNotRequired = model.selectedManagedGitHubRepository
            .flatMap { selectedRepository in
                model.managedGitHubRepositories.first {
                    $0.fullName == selectedRepository
                }
            }?.visibility == .public
        let licenseIsActive = model.licenseSetupReady
        license = publicRepositoryLicenseNotRequired || licenseIsActive
        licenseStatus = publicRepositoryLicenseNotRequired
            ? "PUBLIC · FREE"
            : (licenseIsActive ? "ACTIVE" : "ACTIVATION REQUIRED")
        repository = model.repositorySetupReady
        repositoryName = model.selectedManagedGitHubRepository
            ?? model.repos.first(where: \.enabled)?.name
            ?? "owner/repository"
        canRunDryRun = model.productionUsefulWorkAvailable
            && model.providerSetupReady
    }

    private var gates: [Bool] { [github, provider, license, repository] }

    var completedCount: Int { gates.filter { $0 }.count }
    var totalCount: Int { gates.count }
    var isComplete: Bool { completedCount == totalCount }
}

/// Owner-reference Home surface for #657.
///
/// This keeps the existing model and safety actions intact while replacing the
/// operator-console-first hierarchy with a customer-facing readiness path:
/// GitHub App → provider → license → repository. Diagnostics remain available
/// under an explicit disclosure instead of competing with the next action.
struct OverviewView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let nd = NDPalette(scheme: colorScheme)
        let readiness = DesktopSetupReadiness(model: model)

        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero(palette: nd, readiness: readiness)

                VStack(spacing: 8) {
                    ReferenceReadinessCard(
                        title: "GITHUB APP",
                        systemImage: "link",
                        status: readiness.isRestoring
                            ? "CHECKING"
                            : (readiness.github ? "CONNECTED" : "NOT CONNECTED"),
                        isReady: readiness.github,
                        actionTitle: readiness.isRestoring
                            ? "WAIT"
                            : (readiness.github ? "VIEW" : "CONNECT"),
                        isDisabled: readiness.isRestoring
                    ) {
                        model.reopenOnboarding(at: .welcome)
                    }

                    ReferenceReadinessCard(
                        title: "PROVIDER",
                        systemImage: "cloud",
                        status: readiness.isRestoring
                            ? "CHECKING"
                            : (readiness.provider ? "CONFIGURED" : "SETUP REQUIRED"),
                        isReady: readiness.provider,
                        actionTitle: readiness.isRestoring
                            ? "WAIT"
                            : (readiness.provider ? "MANAGE" : "SET UP"),
                        isDisabled: readiness.isRestoring
                    ) {
                        model.selectedSection = .providers
                    }

                    ReferenceReadinessCard(
                        title: "LICENSE",
                        systemImage: "key",
                        status: readiness.isRestoring ? "CHECKING" : readiness.licenseStatus,
                        isReady: readiness.license,
                        actionTitle: readiness.isRestoring ? "WAIT" : "VIEW",
                        isDisabled: readiness.isRestoring
                    ) {
                        model.selectedSection = .license
                    }

                    ReferenceReadinessCard(
                        title: "REPOSITORY",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        status: readiness.isRestoring
                            ? "CHECKING"
                            : (readiness.repository ? "APPLIED" : "NOT APPLIED"),
                        isReady: readiness.repository,
                        actionTitle: readiness.isRestoring
                            ? "WAIT"
                            : (readiness.repository ? "MANAGE" : "ADD"),
                        isDisabled: readiness.isRestoring
                    ) {
                        model.selectedSection = .repos
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 14) {
                        repositoryPanel(palette: nd, readiness: readiness)
                        recentActivityPanel(palette: nd, readiness: readiness)
                    }

                    VStack(spacing: 14) {
                        repositoryPanel(palette: nd, readiness: readiness)
                        recentActivityPanel(palette: nd, readiness: readiness)
                    }
                }

                if let lastError = model.lastError, !lastError.isEmpty {
                    ReferenceMessagePanel(
                        systemImage: "exclamationmark.triangle.fill",
                        text: lastError,
                        color: nd.danger
                    )
                }

                advancedDiagnostics(palette: nd)

                HStack(spacing: 8) {
                    Image(systemName: "lock")
                    Text("Config and secrets stay on this Mac. Model context follows your selected provider.")
                    Spacer()
                    Text("LOCAL-FIRST")
                        .foregroundStyle(nd.accentPrimary)
                }
                .font(.system(.caption2, design: .monospaced).weight(.medium))
                .foregroundStyle(nd.textSecondary)
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "overview")
            }
        }
        .background(nd.background)
        .accessibilityIdentifier("neondiff-overview-outer-scroll")
        .scrollContentBackground(.hidden)
    }

    private func hero(palette: NDPalette, readiness: DesktopSetupReadiness) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("// SYSTEM STATUS")
                .ndSectionLabel(palette)
                .foregroundStyle(NeonDiffTheme.cyan)

            Text(heroTitle(readiness))
                .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                .foregroundStyle(palette.accentPrimary)
                .minimumScaleFactor(0.72)
                .lineLimit(2)

            Text(heroDetail(readiness))
                .font(.body)
                .foregroundStyle(palette.textPrimary.opacity(0.78))

            HStack(spacing: 10) {
                Text(readiness.isRestoring
                    ? "CHECKING LOCAL SETUP"
                    : "\(readiness.completedCount) OF \(readiness.totalCount) READY")
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .foregroundStyle(palette.textSecondary)

                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.borderInput)
                        Capsule()
                            .fill(palette.accentPrimary)
                            .frame(
                                width: proxy.size.width
                                    * CGFloat(readiness.completedCount)
                                    / CGFloat(readiness.totalCount)
                            )
                    }
                }
                .frame(height: 4)
            }
            .frame(maxWidth: 360)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private func heroTitle(_ readiness: DesktopSetupReadiness) -> String {
        if readiness.isRestoring {
            return "Restoring this Mac"
        }
        if readiness.canRunDryRun {
            return "Ready for a dry run"
        }
        if readiness.isComplete {
            return "Existing bot configured"
        }
        return "Set up your first review"
    }

    private func heroDetail(_ readiness: DesktopSetupReadiness) -> String {
        if readiness.isRestoring {
            return "Checking your authorized account, existing bot, and local configuration before showing setup actions."
        }
        if readiness.canRunDryRun {
            return "Start with a dry run before any live GitHub post."
        }
        if readiness.isComplete {
            return "NeonDiff found this bot’s existing account, GitHub, provider, entitlement, and repository setup. Reverify current access before running new work."
        }
        return "Complete the remaining steps below. You can leave setup at any time and return here."
    }

    private func repositoryPanel(
        palette: NDPalette,
        readiness: DesktopSetupReadiness
    ) -> some View {
        ReferenceHomePanel(title: "// REPOSITORY", palette: palette) {
            Text(readiness.isRestoring ? "Checking existing bot…" : readiness.repositoryName)
                .font(.system(.title3, design: .monospaced).weight(.medium))
                .foregroundStyle(
                    readiness.repository ? palette.accentPrimary : palette.textSecondary
                )
                .lineLimit(1)

            Text(readiness.isRestoring
                ? "Reading the selected bot’s applied repository configuration."
                : (readiness.repository
                    ? (readiness.canRunDryRun
                        ? "Applied and ready for a dry-run review."
                        : "Applied in the selected local bot config.")
                    : "Choose and apply one repository to begin."))
                .font(.callout)
                .foregroundStyle(palette.textSecondary)

            Button {
                model.selectedSection = .repos
            } label: {
                Label(
                    readiness.isRestoring
                        ? "Checking Repository"
                        : (readiness.repository ? "Manage Repository" : "Add Repository"),
                    systemImage: "plus.circle"
                )
            }
            .buttonStyle(ReferenceOutlineButtonStyle())
            .disabled(readiness.isRestoring)
        }
        .frame(maxWidth: .infinity, minHeight: 174, alignment: .topLeading)
    }

    private func recentActivityPanel(
        palette: NDPalette,
        readiness: DesktopSetupReadiness
    ) -> some View {
        ReferenceHomePanel(title: "// RECENT ACTIVITY", palette: palette) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .font(.title2)
                    .foregroundStyle(palette.accentPrimary)

                VStack(alignment: .leading, spacing: 5) {
                    Text("Welcome to NeonDiff")
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                        .foregroundStyle(palette.textPrimary)
                    Text(readiness.isRestoring
                        ? "Restoring existing bot setup on this Mac."
                        : (readiness.canRunDryRun
                            ? "Setup is ready for a dry run."
                            : (readiness.isComplete
                                ? "Existing bot setup detected on this Mac."
                                : "Let’s finish your setup.")))
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                }

                Spacer()
                Text("NOW")
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .foregroundStyle(palette.accentPrimary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 174, alignment: .topLeading)
    }

    private func advancedDiagnostics(palette: NDPalette) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 14) {
                Text("Local operator actions stay available here, away from the first-review path.")
                    .font(.callout)
                    .foregroundStyle(palette.textSecondary)

                CommandPanel(commands: [
                    model.dashboardServerCommand,
                    model.dashboardCommand,
                    model.statusCommand,
                    model.startDaemonDryRunCommand,
                    model.stopDaemonDryRunCommand,
                    model.configInspectCommand
                ], copy: model.copyCommand)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { diagnosticButtons }
                    VStack(alignment: .leading, spacing: 10) { diagnosticButtons }
                }
            }
            .padding(.top, 12)
        } label: {
            Text("// ADVANCED DIAGNOSTICS")
                .ndSectionLabel(palette)
        }
        .padding(16)
        .background(palette.surface)
        .overlay(Rectangle().stroke(palette.interfaceBorder, lineWidth: 1))
    }

    @ViewBuilder
    private var diagnosticButtons: some View {
        Button { model.startDashboardServer() } label: {
            Label("Start Dashboard", systemImage: "play.circle")
        }
        .accessibilityIdentifier("neondiff-overview-start-dashboard")

        Button { model.openDashboard() } label: {
            Label("Open Dashboard", systemImage: "macwindow")
        }
        .accessibilityIdentifier("neondiff-overview-open-dashboard")

        Button { model.refreshStatus() } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
        }
        .accessibilityIdentifier("neondiff-refresh-status")

        Button { model.inspectConfig() } label: {
            Label("Load Config", systemImage: "doc.text.magnifyingglass")
        }
        .accessibilityIdentifier("neondiff-load-config")

        Button { model.previewStartDaemon() } label: {
            Label("Preview Start", systemImage: "play.circle")
        }
        .disabled(!model.productionUsefulWorkAvailable)
        .accessibilityIdentifier("neondiff-preview-start-daemon")

        Button { model.previewStopDaemon() } label: {
            Label("Preview Stop", systemImage: "stop.circle")
        }
        .disabled(!model.productionDaemonStopAvailable)
        .accessibilityIdentifier("neondiff-preview-stop-daemon")
    }

}

private struct ReferenceReadinessCard: View {
    let title: String
    let systemImage: String
    let status: String
    let isReady: Bool
    let actionTitle: String
    let isDisabled: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)

        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(palette.textPrimary)
                .frame(width: 44, height: 44)
                .background(palette.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(palette.interfaceBorder, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .foregroundStyle(palette.textPrimary)
                HStack(spacing: 6) {
                    Circle()
                        .fill(isReady ? palette.accentPrimary : palette.warning)
                        .frame(width: 7, height: 7)
                    Text(status)
                        .font(.system(.caption2, design: .monospaced).weight(.semibold))
                        .foregroundStyle(isReady ? palette.accentPrimary : palette.warning)
                }
            }

            Spacer(minLength: 12)

            Button(action: action) {
                HStack(spacing: 10) {
                    Text(actionTitle)
                    Image(systemName: "chevron.right")
                }
            }
            .buttonStyle(ReferenceOutlineButtonStyle())
            .disabled(isDisabled)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(palette.surface.opacity(0.82))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.interfaceBorder, lineWidth: 1)
        )
    }
}

private struct ReferenceHomePanel<Content: View>: View {
    let title: String
    let palette: NDPalette
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).ndSectionLabel(palette)
            content
        }
        .padding(16)
        .background(palette.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.interfaceBorder, lineWidth: 1)
        )
    }
}

private struct ReferenceMessagePanel: View {
    let systemImage: String
    let text: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
            Text(text)
                .font(.callout)
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(NeonDiffTheme.panel)
        .overlay(Rectangle().stroke(color.opacity(0.5), lineWidth: 1))
    }
}

private struct ReferenceOutlineButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        let palette = NDPalette(scheme: colorScheme)

        configuration.label
            .font(.system(.caption, design: .monospaced).weight(.semibold))
            .foregroundStyle(palette.accentPrimary.opacity(configuration.isPressed ? 0.65 : 1))
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(palette.accentPrimary.opacity(configuration.isPressed ? 0.12 : 0.045))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(palette.accentPrimary.opacity(0.66), lineWidth: 1)
            )
            .contentShape(Rectangle())
    }
}
