import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

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

        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero(palette: nd)

                VStack(spacing: 8) {
                    ReferenceReadinessCard(
                        title: "GITHUB APP",
                        systemImage: "link",
                        status: githubReady ? "CONNECTED" : "NOT CONNECTED",
                        isReady: githubReady,
                        actionTitle: githubReady ? "VIEW" : "CONNECT"
                    ) {
                        model.isOnboardingPresented = true
                    }

                    ReferenceReadinessCard(
                        title: "PROVIDER",
                        systemImage: "cloud",
                        status: providerReady ? "CONFIGURED" : "SETUP REQUIRED",
                        isReady: providerReady,
                        actionTitle: providerReady ? "MANAGE" : "SET UP"
                    ) {
                        model.selectedSection = .providers
                    }

                    ReferenceReadinessCard(
                        title: "LICENSE",
                        systemImage: "key",
                        status: licenseReady ? "ACTIVE" : "ACTIVATION REQUIRED",
                        isReady: licenseReady,
                        actionTitle: "VIEW"
                    ) {
                        model.selectedSection = .license
                    }

                    ReferenceReadinessCard(
                        title: "REPOSITORY",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        status: repositoryReady ? "SELECTED" : "NOT SELECTED",
                        isReady: repositoryReady,
                        actionTitle: repositoryReady ? "MANAGE" : "ADD"
                    ) {
                        model.selectedSection = .repos
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 14) {
                        repositoryPanel(palette: nd)
                        recentActivityPanel(palette: nd)
                    }

                    VStack(spacing: 14) {
                        repositoryPanel(palette: nd)
                        recentActivityPanel(palette: nd)
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
                    Text("Your data stays on this Mac. Secrets remain in Keychain.")
                    Spacer()
                    Text("LOCAL-FIRST")
                        .foregroundStyle(nd.accentPrimary)
                }
                .font(.system(size: 10, weight: .medium, design: .monospaced))
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

    private func hero(palette: NDPalette) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("// SYSTEM STATUS")
                .ndSectionLabel(palette)
                .foregroundStyle(NeonDiffTheme.cyan)

            Text(readinessCount == 4 ? "Ready for your first review" : "Set up your first review")
                .font(.system(size: 32, weight: .semibold, design: .rounded))
                .foregroundStyle(palette.accentPrimary)
                .minimumScaleFactor(0.72)
                .lineLimit(2)

            Text(readinessCount == 4
                ? "Your review path is configured. Start with a dry run before any live GitHub post."
                : "Complete the remaining steps below. You can leave setup at any time and return here.")
                .font(.body)
                .foregroundStyle(palette.textPrimary.opacity(0.78))

            HStack(spacing: 10) {
                Text("\(readinessCount) OF 4 READY")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(palette.textSecondary)

                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.borderInput)
                        Capsule()
                            .fill(palette.accentPrimary)
                            .frame(width: proxy.size.width * CGFloat(readinessCount) / 4)
                    }
                }
                .frame(height: 4)
            }
            .frame(maxWidth: 360)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private func repositoryPanel(palette: NDPalette) -> some View {
        ReferenceHomePanel(title: "// REPOSITORY", palette: palette) {
            Text(repositoryName)
                .font(.system(size: 20, weight: .medium, design: .monospaced))
                .foregroundStyle(repositoryReady ? palette.accentPrimary : palette.textSecondary)
                .lineLimit(1)

            Text(repositoryReady ? "Ready for a dry-run review." : "Choose one repository to begin.")
                .font(.callout)
                .foregroundStyle(palette.textSecondary)

            Button {
                model.selectedSection = .repos
            } label: {
                Label(repositoryReady ? "Manage Repository" : "Add Repository", systemImage: "plus.circle")
            }
            .buttonStyle(ReferenceOutlineButtonStyle())
        }
        .frame(maxWidth: .infinity, minHeight: 174, alignment: .topLeading)
    }

    private func recentActivityPanel(palette: NDPalette) -> some View {
        ReferenceHomePanel(title: "// RECENT ACTIVITY", palette: palette) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.circle")
                    .font(.title2)
                    .foregroundStyle(palette.accentPrimary)

                VStack(alignment: .leading, spacing: 5) {
                    Text("Welcome to NeonDiff")
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                        .foregroundStyle(palette.textPrimary)
                    Text(readinessCount == 4 ? "Setup is ready for a dry run." : "Let’s finish your setup.")
                        .font(.callout)
                        .foregroundStyle(palette.textSecondary)
                }

                Spacer()
                Text("NOW")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
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

    private var githubReady: Bool {
        model.byoGitHubCredentialsVerified || managedGitHubReady
    }

    private var managedGitHubReady: Bool {
        if case .bound = model.managedGitHubConnectionState { return true }
        return false
    }

    private var providerReady: Bool {
        model.providerVerification?.isVerified == true
    }

    private var licenseReady: Bool {
        model.activationState == .active || model.onboardingFlow.licenseActivation == .activated
    }

    private var repositoryReady: Bool {
        model.selectedManagedGitHubRepository != nil || !model.repos.filter(\.enabled).isEmpty
    }

    private var readinessCount: Int {
        [githubReady, providerReady, licenseReady, repositoryReady].filter { $0 }.count
    }

    private var repositoryName: String {
        model.selectedManagedGitHubRepository
            ?? model.repos.first(where: \.enabled)?.name
            ?? "owner/repository"
    }
}

private struct ReferenceReadinessCard: View {
    let title: String
    let systemImage: String
    let status: String
    let isReady: Bool
    let actionTitle: String
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
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.textPrimary)
                HStack(spacing: 6) {
                    Circle()
                        .fill(isReady ? palette.accentPrimary : palette.warning)
                        .frame(width: 7, height: 7)
                    Text(status)
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
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
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
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
