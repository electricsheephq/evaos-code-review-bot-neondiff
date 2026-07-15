import SwiftUI
import NeonDiffDesktopCore

struct SidebarView: View {
    @Binding var selection: DesktopSection

    var body: some View {
        ZStack {
            NeonDiffTheme.sidebar

            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("ND")
                        .font(.system(size: 34, weight: .black, design: .monospaced))
                        .foregroundStyle(NeonDiffTheme.accent)
                    Text("Operator Console")
                        .font(NeonDiffTheme.badgeFont)
                        .foregroundStyle(NeonDiffTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .operatorPanel(padding: 12, active: true)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(DesktopSection.allCases) { section in
                        Button {
                            selection = section
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: section.systemImage)
                                    .frame(width: 18)
                                Text(section.title)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.callout.weight(selection == section ? .semibold : .regular))
                            .foregroundStyle(selection == section ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                            .background {
                                AngularRectangle(corner: 8)
                                    .fill(selection == section ? NeonDiffTheme.panelActive.opacity(0.92) : Color.clear)
                            }
                            .overlay {
                                AngularRectangle(corner: 8)
                                    .stroke(selection == section ? NeonDiffTheme.accent.opacity(0.78) : NeonDiffTheme.stroke.opacity(0.18), lineWidth: 0.7)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(section.title)
                        .accessibilityIdentifier("neondiff-sidebar-section-\(section.rawValue)")
                    }
                }

                Spacer(minLength: 12)

                VStack(alignment: .leading, spacing: 8) {
                    OperatorBadge(text: "NO LIVE POSTING")
                    Text("Dry-run-first desktop shell.")
                        .font(.caption)
                        .foregroundStyle(NeonDiffTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .operatorPanel(padding: 12)
            }
            .padding(.horizontal, 14)
            .padding(.top, 18)
            .padding(.bottom, 14)
        }
    }
}
