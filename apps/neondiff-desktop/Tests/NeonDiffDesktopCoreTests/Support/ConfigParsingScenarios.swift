import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runConfigInspectAndPatchContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let controlCenterSnapshot = ConfigInspectParser.parse(
        #"""
        {
          "ok": true,
          "command": "config inspect",
          "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "config": {
            "pilotRepos": ["owner/review-repo"],
            "pollIntervalMs": 120000,
            "skipDrafts": false,
            "reviewConcurrency": { "maxActiveRuns": 2, "leaseTtlMs": 600000 },
            "reviewGate": { "maxInlineComments": 12 },
            "issueEnrichment": {
              "enabled": true,
              "postIssueComment": false,
              "allowlist": ["owner/issues-repo"],
              "maxIssuesPerCycle": 4,
              "maxCommentsPerCycle": 1,
              "globalMaxIssuesPerCycle": 4,
              "globalMaxCommentsPerCycle": 1,
              "maxActiveRuns": 1,
              "leaseTtlMs": 900000,
              "cooldownMs": 3600000,
              "burstWindowMs": 3600000,
              "maxIssuesPerBurst": 8,
              "lookbackMs": 600000,
              "processExistingOpenIssuesOnActivation": false
            }
          }
        }
        """#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    context.expect(controlCenterSnapshot?.policy.pollIntervalMs == 120_000, "config inspect parses daemon poll interval")
    context.expect(controlCenterSnapshot?.revision == String(repeating: "a", count: 64), "config inspect preserves the compare-and-swap revision")
    context.expect(controlCenterSnapshot?.policy.reviewMaxActiveRuns == 2, "config inspect parses review concurrency")
    context.expect(controlCenterSnapshot?.policy.issueAllowlist == ["owner/issues-repo"], "issue-enrichment allowlist remains separate from review repos")
    context.expect(controlCenterSnapshot?.repos.map(\.name) == ["owner/review-repo"], "PR review allowlist remains in the repo selector")
    let failedInspectJSON = #"{"ok":false,"command":"config inspect","error":"config changed while reading; retry"}"#
    context.expect(
        ConfigInspectParser.error(failedInspectJSON) == "config changed while reading; retry",
        "structured inspect failures expose a bounded retry message"
    )
    context.expect(
        ConfigInspectParser.parse(failedInspectJSON, providerKeyStored: false, licenseKeyStored: false) == nil,
        "failed inspect responses cannot install a config snapshot"
    )
    let expectedPatchRevision = String(repeating: "b", count: 64)
    let successfulPatchJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","warning":"remove the owned lock","config":{"pilotRepos":[]}}"#
    let successfulPatchSnapshot = ConfigInspectParser.parse(
        successfulPatchJSON,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    context.expect(successfulPatchSnapshot != nil, "successful config patch envelopes parse")
    context.expect(successfulPatchSnapshot?.warning == "remove the owned lock", "config patch cleanup warnings remain visible to the native caller")
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: successfulPatchSnapshot,
            expectedRevision: expectedPatchRevision,
            mode: .preview
        ) == expectedPatchRevision,
        "preview proof binds both response revisions to the requested revision"
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: successfulPatchSnapshot,
            expectedRevision: expectedPatchRevision,
            mode: .apply
        ) == nil,
        "an Apply operation rejects a preview-shaped dry-run envelope"
    )
    let appliedRevision = String(repeating: "c", count: 64)
    let successfulApplySnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(appliedRevision)","config":{"pilotRepos":[]}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: successfulApplySnapshot,
            expectedRevision: expectedPatchRevision,
            mode: .apply
        ) == appliedRevision,
        "Apply proof requires a typed live-write envelope and accepts its new SHA-256 revision"
    )
    let contradictoryNoOpSnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config patch","dryRun":false,"wrote":false,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(appliedRevision)","config":{"pilotRepos":[]}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: contradictoryNoOpSnapshot,
            expectedRevision: expectedPatchRevision,
            mode: .apply
        ) == nil,
        "a no-op Apply cannot claim a changed revision"
    )
    let contradictoryWriteSnapshot = ConfigInspectParser.parse(
        #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
        providerKeyStored: false,
        licenseKeyStored: false
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: contradictoryWriteSnapshot,
            expectedRevision: expectedPatchRevision,
            mode: .apply
        ) == nil,
        "a reported Apply write must advance the content revision"
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: successfulApplySnapshot,
            expectedRevision: expectedPatchRevision.uppercased(),
            mode: .apply
        ) == nil,
        "uppercase or otherwise malformed revisions cannot authorize Apply"
    )
    context.expect(
        ConfigInspectParser.parse(
            #"{"ok":true,"command":"daemon status","revisionBefore":"\#(expectedPatchRevision)","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
            providerKeyStored: false,
            licenseKeyStored: false
        ) == nil,
        "wrong-command envelopes cannot authorize a config patch"
    )
    context.expect(
        ConfigPatchProofValidator.revisionAfter(
            snapshot: ConfigInspectParser.parse(
                #"{"ok":true,"command":"config patch","revisionBefore":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","revisionAfter":"\#(expectedPatchRevision)","config":{"pilotRepos":[]}}"#,
                providerKeyStored: false,
                licenseKeyStored: false
            ),
            expectedRevision: expectedPatchRevision,
            mode: .apply
        ) == nil,
        "mismatched patch revision proof fails closed"
    )

    var desiredControlCenter = DesktopControlCenterSettings()
    desiredControlCenter.pollIntervalMs = 120_000
    desiredControlCenter.skipDrafts = false
    desiredControlCenter.reviewMaxActiveRuns = 2
    desiredControlCenter.reviewLeaseTtlMs = 600_000
    desiredControlCenter.maxInlineComments = 12
    desiredControlCenter.issueEnrichmentEnabled = true
    desiredControlCenter.issuePostComment = false
    desiredControlCenter.issueAllowlist = ["owner/issues-repo"]
    desiredControlCenter.issueMaxIssuesPerCycle = 4
    desiredControlCenter.issueMaxCommentsPerCycle = 1

    context.expect(DesktopControlCenterPatchBuilder.validationError(for: desiredControlCenter) == nil, "valid control-center settings pass native validation")
    let desiredPatchData = try DesktopControlCenterPatchBuilder.data(for: desiredControlCenter)
    let desiredPatch: [String: Any] = checkedCast(
        try JSONSerialization.jsonObject(with: desiredPatchData),
        "desired control-center patch must serialize to a JSON object"
    )
    context.expect(desiredPatch["pilotRepos"] == nil, "control-center patch never couples issue enrichment to the PR allowlist")
    let desiredIssuePatch = desiredPatch["issueEnrichment"] as? [String: Any]
    context.expect(desiredIssuePatch?["allowlist"] as? [String] == ["owner/issues-repo"], "control-center patch writes only the issue-enrichment allowlist")

    let rollbackSettings = checkedValue(controlCenterSnapshot, "control-center fixture must parse").policy
    let rollbackPatchData = try DesktopControlCenterPatchBuilder.data(for: rollbackSettings)
    let rollbackPatch: [String: Any] = checkedCast(
        try JSONSerialization.jsonObject(with: rollbackPatchData),
        "rollback control-center patch must serialize to a JSON object"
    )
    let rollbackIssuePatch = rollbackPatch["issueEnrichment"] as? [String: Any]
    context.expect(rollbackPatch["pollIntervalMs"] as? Int == 120_000, "rollback patch preserves the loaded daemon baseline")
    context.expect(rollbackIssuePatch?["allowlist"] as? [String] == ["owner/issues-repo"], "rollback patch preserves the loaded issue allowlist")
    context.expect(rollbackPatch["pilotRepos"] == nil, "rollback patch cannot modify the separate PR review allowlist")

    let previewSnapshot = DesktopControlCenterSnapshot(
        settings: desiredControlCenter,
        configPath: "/tmp/config-a.json"
    )
    var editedAfterPreview = desiredControlCenter
    editedAfterPreview.pollIntervalMs += 1_000
    context.expect(
        previewSnapshot != DesktopControlCenterSnapshot(settings: editedAfterPreview, configPath: "/tmp/config-a.json"),
        "an edit made after preview cannot match the immutable preview snapshot"
    )
    context.expect(
        previewSnapshot != DesktopControlCenterSnapshot(settings: desiredControlCenter, configPath: "/tmp/config-b.json"),
        "a preview for one config path cannot authorize a different config target"
    )
    let revisionBoundCommand = NeonDiffCommandBuilder.configPatch(
        cliPath: "/tmp/neondiff",
        configPath: "/tmp/config-a.json",
        inputPath: "/tmp/patch.json",
        dryRun: false,
        expectedRevision: String(repeating: "a", count: 64)
    )
    context.expect(revisionBoundCommand.commandLine.contains("--expected-revision"), "live control-center commands expose their revision guard")

    var invalidControlCenter = desiredControlCenter
    invalidControlCenter.issueMaxIssuesPerCycle = 1
    invalidControlCenter.issueMaxCommentsPerCycle = 2
    context.expect(
        DesktopControlCenterPatchBuilder.validationError(for: invalidControlCenter)?.contains("comments per cycle") == true,
        "native validation blocks issue comment caps above issue caps"
    )


      return context.assertions
  }
