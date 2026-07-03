import SwiftUI
import NeonDiffDesktopCore

struct ContentView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $model.selectedSection)
        } detail: {
            DetailView(model: model)
        }
    }
}

private struct DetailView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
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
        .navigationTitle(model.selectedSection.title)
    }
}
