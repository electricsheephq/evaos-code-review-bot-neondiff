import SwiftUI
import NeonDiffDesktopCore

struct SidebarView: View {
    @Binding var selection: DesktopSection

    var body: some View {
        List(DesktopSection.allCases, selection: $selection) { section in
            Label(section.title, systemImage: section.systemImage)
                .tag(section)
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 190, ideal: 220)
    }
}
