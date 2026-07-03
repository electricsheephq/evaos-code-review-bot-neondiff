import SwiftUI

struct LogsView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button("Refresh Status Logs") { model.refreshStatus() }
                Button("Copy Last Command") { model.copyCommand(model.statusCommand) }
            }

            TextEditor(text: $model.logText)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(minHeight: 420)
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(.quaternary)
                }

            Text("Output is redacted before display. Raw provider keys, license keys, tokens, private keys, and credential URLs must not appear here.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(24)
    }
}
