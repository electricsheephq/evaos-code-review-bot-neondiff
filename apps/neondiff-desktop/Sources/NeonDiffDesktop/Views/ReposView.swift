import SwiftUI
import NeonDiffDesktopCore

struct ReposView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button("Load From Config") { model.inspectConfig() }
                Button("Refresh Runtime") { model.refreshStatus() }
            }

            Table(model.repos) {
                TableColumn("Repository") { repo in
                    Text(repo.name)
                        .textSelection(.enabled)
                }
                TableColumn("Enabled") { repo in
                    Image(systemName: repo.enabled ? "checkmark.circle.fill" : "pause.circle")
                        .foregroundStyle(repo.enabled ? .green : .secondary)
                }
                TableColumn("Profile", value: \.profile)
                TableColumn("Last Review", value: \.lastReview)
            }

            Text("Repo changes are written through `config patch` only; the desktop does not post reviews or bypass daemon gates.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(24)
    }
}
