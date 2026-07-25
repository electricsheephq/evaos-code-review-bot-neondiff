import SwiftUI
import NeonDiffDesktopCore

struct SidebarView: View {
    @Binding var selection: DesktopSection
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)

        ZStack {
            palette.surface

            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    NDBrandWordmark(size: 22)
                    Text("AI CODE REVIEW SYSTEM")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .tracking(0.9)
                        .foregroundStyle(palette.textSecondary)
                }
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
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(palette.accentPrimary)
                        Spacer()
                        Circle()
                            .fill(palette.warning)
                            .frame(width: 7, height: 7)
                    }

                    Text("COMPLETE SETUP TO REVIEW")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(palette.textSecondary)

                    Capsule()
                        .fill(palette.interfaceBorder)
                    .frame(height: 4)
                }
                .padding(12)
                .background(palette.background.opacity(0.72))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(palette.interfaceBorder, lineWidth: 1)
                )
                .accessibilityIdentifier("neondiff-sidebar-readiness")

                Label("YOUR DATA STAYS LOCAL", systemImage: "lock")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.textSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 16)
        }
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
                    .font(.system(size: 12, weight: selection == section ? .semibold : .regular, design: .monospaced))
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
