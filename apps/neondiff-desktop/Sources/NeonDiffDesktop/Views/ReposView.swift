import SwiftUI
import NeonDiffDesktopCore

struct ReposView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Button { model.inspectConfig() } label: {
                    Label("Load From Config", systemImage: "doc.text.magnifyingglass")
                }
                Button { model.refreshStatus() } label: {
                    Label("Refresh Runtime", systemImage: "arrow.clockwise")
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Monitored Repositories")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.accentSoft)

                Table(model.repos) {
                    TableColumn("Repository") { repo in
                        Text(repo.name)
                            .textSelection(.enabled)
                    }
                    TableColumn("Enabled") { repo in
                        Image(systemName: repo.enabled ? "checkmark.circle.fill" : "pause.circle")
                            .foregroundStyle(repo.enabled ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary)
                    }
                    TableColumn("Profile", value: \.profile)
                    TableColumn("Last Review", value: \.lastReview)
                }
                .scrollContentBackground(.hidden)
                .frame(minHeight: 360)
            }
            .operatorPanel()

            OperatorSection("Boundary") {
                Text("Repo changes are written through `config patch` only; the desktop does not post reviews or bypass daemon gates.")
                    .operatorBodyText()
            }
        }
        .padding(24)
    }
}
