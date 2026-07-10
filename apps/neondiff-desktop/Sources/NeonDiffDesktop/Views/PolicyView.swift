import SwiftUI
import NeonDiffDesktopCore

struct PolicyView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                OperatorSection("Control Center Status") {
                    Text(model.controlCenterStatus)
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                    Button { model.inspectConfig() } label: {
                        Label("Load Current Config", systemImage: "doc.text.magnifyingglass")
                    }
                    .disabled(model.isConfigPatchInProgress || model.isConfigInspectInProgress)
                    .accessibilityIdentifier("neondiff-control-load")
                }

                OperatorSection("PR Review And Daemon") {
                    Toggle("Skip draft pull requests", isOn: $model.controlCenter.skipDrafts)
                    Stepper(
                        "Poll interval: \(model.controlCenter.pollIntervalMs / 1_000)s",
                        value: $model.controlCenter.pollIntervalMs,
                        in: 1_000...3_600_000,
                        step: 1_000
                    )
                    Stepper(
                        "Max concurrent reviews: \(model.controlCenter.reviewMaxActiveRuns)",
                        value: $model.controlCenter.reviewMaxActiveRuns,
                        in: 1...32
                    )
                    Stepper(
                        "Review lease TTL: \(model.controlCenter.reviewLeaseTtlMs / 60_000)m",
                        value: $model.controlCenter.reviewLeaseTtlMs,
                        in: 60_000...7_200_000,
                        step: 60_000
                    )
                    Stepper(
                        "Max inline comments: \(model.controlCenter.maxInlineComments)",
                        value: $model.controlCenter.maxInlineComments,
                        in: 1...100
                    )
                    Text("PR review repositories remain in the Repos pane. These settings never modify the separate issue-enrichment allowlist.")
                        .font(.caption)
                        .foregroundStyle(NeonDiffTheme.textSecondary)
                }

                OperatorSection("Issue Enrichment") {
                    Toggle("Enable issue enrichment", isOn: $model.controlCenter.issueEnrichmentEnabled)
                    Toggle("Allow App-authored issue comments", isOn: $model.controlCenter.issuePostComment)
                        .disabled(!model.controlCenter.issueEnrichmentEnabled)
                    Toggle(
                        "Process existing open issues on activation",
                        isOn: $model.controlCenter.issueProcessExistingOnActivation
                    )
                    .disabled(!model.controlCenter.issueEnrichmentEnabled)

                    HStack(spacing: 10) {
                        TextField("owner/repo", text: $model.pendingIssueRepoName)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("neondiff-issue-repo-input")
                        Button { model.addPendingIssueRepo() } label: {
                            Label("Add Issue Repo", systemImage: "plus.circle")
                        }
                        .accessibilityIdentifier("neondiff-issue-repo-add")
                    }

                    ForEach(model.controlCenter.issueAllowlist, id: \.self) { repo in
                        HStack {
                            Label(repo, systemImage: "exclamationmark.bubble")
                            Spacer()
                            Button { model.removeIssueRepo(repo) } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("neondiff-issue-repo-remove-\(repo)")
                        }
                    }

                    Stepper(
                        "Issues per cycle: \(model.controlCenter.issueMaxIssuesPerCycle)",
                        value: $model.controlCenter.issueMaxIssuesPerCycle,
                        in: 1...100
                    )
                    Stepper(
                        "Comments per cycle: \(model.controlCenter.issueMaxCommentsPerCycle)",
                        value: $model.controlCenter.issueMaxCommentsPerCycle,
                        in: 0...100
                    )
                    Stepper(
                        "Global issues per cycle: \(model.controlCenter.issueGlobalMaxIssuesPerCycle)",
                        value: $model.controlCenter.issueGlobalMaxIssuesPerCycle,
                        in: 1...500
                    )
                    Stepper(
                        "Global comments per cycle: \(model.controlCenter.issueGlobalMaxCommentsPerCycle)",
                        value: $model.controlCenter.issueGlobalMaxCommentsPerCycle,
                        in: 0...500
                    )
                    Stepper(
                        "Issue max active runs: \(model.controlCenter.issueMaxActiveRuns)",
                        value: $model.controlCenter.issueMaxActiveRuns,
                        in: 1...16
                    )
                    Stepper(
                        "Issue lease TTL: \(model.controlCenter.issueLeaseTtlMs / 60_000)m",
                        value: $model.controlCenter.issueLeaseTtlMs,
                        in: 60_000...7_200_000,
                        step: 60_000
                    )
                    Stepper(
                        "Cooldown: \(model.controlCenter.issueCooldownMs / 60_000)m",
                        value: $model.controlCenter.issueCooldownMs,
                        in: 60_000...86_400_000,
                        step: 60_000
                    )
                    Stepper(
                        "Burst window: \(model.controlCenter.issueBurstWindowMs / 60_000)m",
                        value: $model.controlCenter.issueBurstWindowMs,
                        in: 60_000...86_400_000,
                        step: 60_000
                    )
                    Stepper(
                        "Issues per burst: \(model.controlCenter.issueMaxIssuesPerBurst)",
                        value: $model.controlCenter.issueMaxIssuesPerBurst,
                        in: 1...500
                    )
                    Stepper(
                        "Lookback: \(model.controlCenter.issueLookbackMs / 60_000)m",
                        value: $model.controlCenter.issueLookbackMs,
                        in: 60_000...86_400_000,
                        step: 60_000
                    )
                }

                OperatorSection("Preview, Apply, Rollback") {
                    if let validationError = model.controlCenterValidationError {
                        Label(validationError, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(NeonDiffTheme.warning)
                    } else {
                        Label("Native validation passed; the CLI performs canonical validation again.", systemImage: "checkmark.shield")
                            .foregroundStyle(NeonDiffTheme.accent)
                    }
                    HStack(spacing: 10) {
                        Button { model.previewControlCenterPatch() } label: {
                            Label("Preview", systemImage: "eye")
                        }
                        .disabled(!model.canPreviewControlCenter)
                        .opacity(model.canPreviewControlCenter ? 1 : 0.45)
                        .accessibilityIdentifier("neondiff-control-preview")

                        Button { model.applyControlCenterPatch() } label: {
                            Label("Apply", systemImage: "checkmark.square")
                        }
                        .disabled(!model.canApplyControlCenter)
                        .opacity(model.canApplyControlCenter ? 1 : 0.45)
                        .accessibilityIdentifier("neondiff-control-apply")

                        Button { model.rollbackControlCenterPatch() } label: {
                            Label("Apply Last Rollback", systemImage: "arrow.uturn.backward.circle")
                        }
                        .disabled(!model.canRollbackControlCenter)
                        .opacity(model.canRollbackControlCenter ? 1 : 0.45)
                        .accessibilityIdentifier("neondiff-control-rollback")
                    }
                    Text("Apply is enabled only for the exact settings snapshot that passed Preview. The rollback patch contains only these non-secret desktop-safe fields.")
                        .font(.caption)
                        .foregroundStyle(NeonDiffTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                OperatorSection("Proof Boundary") {
                    Label("No direct review or issue posting from this screen", systemImage: "checkmark.shield")
                    Label("Daemon stale-head, duplicate, secret, license, and posting gates stay authoritative", systemImage: "checkmark.shield")
                    Label("Provider and license keys remain in Keychain", systemImage: "checkmark.shield")
                }
                .foregroundStyle(NeonDiffTheme.textSecondary)
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}

struct CommandPanel: View {
    var commands: [DesktopCommand]
    var copy: (DesktopCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CLI Equivalents")
                .font(NeonDiffTheme.headlineFont)
                .foregroundStyle(NeonDiffTheme.accentSoft)
            ForEach(commands) { command in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(command.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NeonDiffTheme.textPrimary)
                        OperatorCommandText(text: command.commandLine)
                    }
                    Spacer()
                    Button {
                        copy(command)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .help("Copy command")
                }
                .operatorPanel(padding: 10)
            }
        }
    }
}
