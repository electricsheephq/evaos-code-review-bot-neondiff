import SwiftUI
import NeonDiffDesktopAppCore

struct LogsView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView(.vertical) {
            pageContent
        }
        .accessibilityIdentifier("neondiff-logs-outer-scroll")
        .scrollContentBackground(.hidden)
        .scrollIndicators(.visible, axes: .vertical)
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Button { model.refreshStatus() } label: {
                    Label("Refresh Status Logs", systemImage: "arrow.clockwise")
                }
                Button { model.copyCommand(model.statusCommand) } label: {
                    Label("Copy Last Command", systemImage: "doc.on.doc")
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Redacted Output")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.accentSoft)

                TextEditor(text: $model.logText)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .textSelection(.enabled)
                    .frame(height: 360)
                    .padding(8)
                    .background(Color.black.opacity(0.42))
                    .overlay {
                        AngularRectangle(corner: 10)
                            .stroke(NeonDiffTheme.stroke.opacity(0.7), lineWidth: 0.8)
                    }
                    .clipShape(AngularRectangle(corner: 10))
            }
            .operatorPanel()

            OperatorSection("Display Safety") {
                Text("Output is redacted before display. Raw provider keys, license keys, tokens, private keys, and credential URLs must not appear here.")
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .overlay(alignment: .bottom) {
            PageBottomSentinel(section: "logs")
        }
    }
}
