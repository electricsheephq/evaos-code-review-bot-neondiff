import SwiftUI
import NeonDiffDesktopCore

struct ContentView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ZStack {
            OperatorBackdrop()
            HStack(spacing: 0) {
                SidebarView(selection: $model.selectedSection)
                    .frame(width: 230)

                Rectangle()
                    .fill(NeonDiffTheme.stroke.opacity(0.55))
                    .frame(width: 1)

                DetailView(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .tint(NeonDiffTheme.accent)
        .buttonStyle(OperatorButtonStyle())
        .preferredColorScheme(.dark)
    }
}

private struct DetailView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ZStack {
            OperatorBackdrop()
            VStack(spacing: 0) {
                OperatorSectionHeader(title: model.selectedSection.title, status: model.status.healthState)
                    .padding(.horizontal, 22)
                    .padding(.top, 20)
                    .padding(.bottom, 8)

                Group {
                    switch model.selectedSection {
                    case .overview: OverviewView(model: model)
                    case .repos: ReposView(model: model)
                    case .providers: ProviderSettingsView(model: model)
                    case .license: LicenseView(model: model)
                    case .logs: LogsView(model: model)
                    case .policy: PolicyView(model: model)
                    case .settings: SettingsPane(model: model)
                    }
                }
            }
        }
    }
}
