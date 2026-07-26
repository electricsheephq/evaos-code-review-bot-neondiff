import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct SidebarView: View {
    @Binding var selection: DesktopSection
    let readiness: DesktopSetupReadiness
    let accountCatalog: DesktopAccountWorkspaceCatalog
    let accountSelection: DesktopAccountWorkspaceSelection
    let selectAccount: (String) -> Void
    let selectBot: (String) -> Void
    let beginNewBot: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)

        ZStack {
            palette.surface

            VStack(alignment: .leading, spacing: 18) {
                accountMenu(palette: palette)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)

                VStack(alignment: .leading, spacing: 5) {
                    ForEach(DesktopSection.allCases.filter { $0 != .settings }) { section in
                        ReferenceSidebarItem(section: section, selection: $selection)
                    }
                }

                Rectangle()
                    .fill(palette.interfaceBorder)
                    .frame(height: 1)

                ReferenceSidebarItem(section: .settings, selection: $selection)

                Spacer(minLength: 12)

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("SYSTEM READINESS")
                            .font(.system(.caption2, design: .monospaced).weight(.semibold))
                            .foregroundStyle(palette.accentPrimary)
                        Spacer()
                        Circle()
                            .fill(readiness.isComplete ? palette.accentPrimary : palette.warning)
                            .frame(width: 7, height: 7)
                    }

                    Text(readiness.isComplete
                        ? "READY FOR A DRY RUN"
                        : "\(readiness.completedCount) OF \(readiness.totalCount) SETUP STEPS COMPLETE")
                        .font(.system(.caption2, design: .monospaced).weight(.medium))
                        .foregroundStyle(palette.textSecondary)

                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(palette.interfaceBorder)
                            Capsule()
                                .fill(readiness.isComplete
                                    ? palette.accentPrimary
                                    : palette.warning)
                                .frame(
                                    width: proxy.size.width
                                        * CGFloat(readiness.completedCount)
                                        / CGFloat(readiness.totalCount)
                                )
                        }
                    }
                    .frame(height: 4)
                }
                .padding(12)
                .background(palette.background.opacity(0.72))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(palette.interfaceBorder, lineWidth: 1)
                )
                .accessibilityIdentifier("neondiff-sidebar-readiness")

                Label("CONFIG + SECRETS STAY LOCAL", systemImage: "lock")
                    .font(.system(.caption2, design: .monospaced).weight(.medium))
                    .foregroundStyle(palette.textSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 16)
        }
    }

    @ViewBuilder
    private func accountMenu(palette: NDPalette) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                NDBrandWordmark(size: 22)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.textSecondary)
            }
            Text(selectedAccountName ?? "AI CODE REVIEW SYSTEM")
                .font(.system(.caption2, design: .monospaced).weight(.medium))
                .tracking(0.9)
                .foregroundStyle(palette.textSecondary)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
        .accessibilityHidden(true)
        .overlay {
            Menu {
                accountMenuEntries
            } label: {
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .accessibilityLabel("NeonDiff account and bot menu")
            .accessibilityIdentifier("neondiff-account-menu")
        }
    }

    @ViewBuilder
    private var accountMenuEntries: some View {
        switch accountCatalog {
        case .idle:
            Text("SIGN IN REQUIRED")
        case .loading:
            Text("LOADING ACCOUNTS…")
        case .failed:
            Text("ACCOUNT SERVICE UNAVAILABLE")
        case .loaded:
            if accountCatalog.accounts.isEmpty {
                Text("NO AUTHORIZED ACCOUNTS")
            } else {
                ForEach(accountCatalog.accounts) { account in
                    Button {
                        selectAccount(account.id)
                    } label: {
                        Label(
                            account.name,
                            systemImage: accountSelection.accountID == account.id
                                ? "checkmark.circle.fill"
                                : account.kind == .organization ? "building.2" : "person"
                        )
                    }
                    .accessibilityIdentifier("neondiff-account-option-\(account.id)")
                }

                if let selected = accountCatalog.accounts.first(where: {
                    $0.id == accountSelection.accountID
                }) {
                    Divider()
                    ForEach(selected.bots) { bot in
                        Button {
                            selectBot(bot.id)
                        } label: {
                            Label(
                                bot.appSlug,
                                systemImage: accountSelection.botID == bot.id
                                    ? "checkmark.square.fill"
                                    : bot.isAvailableOnThisMac ? "laptopcomputer" : "app.badge"
                            )
                        }
                        .disabled(bot.status == .revoked || bot.status == .suspended)
                        .accessibilityIdentifier("neondiff-bot-option-\(bot.id)")
                    }
                    Button {
                        beginNewBot()
                    } label: {
                        Label("NEW BOT", systemImage: "plus.circle")
                    }
                    .accessibilityIdentifier("neondiff-new-bot")
                }
            }
        }
    }

    private var selectedAccountName: String? {
        accountCatalog.accounts.first { $0.id == accountSelection.accountID }?.name.uppercased()
    }
}

private struct ReferenceSidebarItem: View {
    let section: DesktopSection
    @Binding var selection: DesktopSection
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)

        Button {
            selection = section
        } label: {
            HStack(spacing: 12) {
                Image(systemName: section.systemImage)
                    .frame(width: 20)
                Text(displayTitle)
                    .font(
                        .system(.callout, design: .monospaced)
                            .weight(selection == section ? .semibold : .regular)
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(selection == section ? palette.accentPrimary : palette.textPrimary.opacity(0.78))
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
            .background(selection == section ? palette.accentPrimary.opacity(0.075) : Color.clear)
            .overlay {
                RoundedRectangle(cornerRadius: 7)
                    .stroke(
                        selection == section ? palette.accentPrimary.opacity(0.72) : Color.clear,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
        .accessibilityIdentifier("neondiff-sidebar-section-\(section.rawValue)")
    }

    private var displayTitle: String {
        switch section {
        case .overview: "OVERVIEW"
        case .repos: "REPOSITORIES"
        case .providers: "PROVIDERS"
        case .license: "LICENSE"
        case .logs: "ACTIVITY"
        case .policy: "REVIEW POLICY"
        case .settings: "SETTINGS"
        }
    }
}
