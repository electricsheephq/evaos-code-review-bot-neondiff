import Testing

enum LegacyCoreChecksScenario: String, CaseIterable, Sendable {
    case onboardingFlowContracts
    case cliResolutionAndStandardInputContracts
    case cliCancellationContracts
    case cliStandardInputTimeoutContracts
    case cliCleanupDeadlineAndOutputContracts
    case githubDeviceFlowTransportContracts
    case detachedCommandLaunchContracts
    case githubRecoveryRepositoryAndRateLimitContracts
    case configInspectAndPatchContracts
    case providerRegistryParsingAndPatchContracts
    case providerVerificationTransportAndStrictEnvelopeContracts
    case canonicalRedactorCorpusContracts
    case providerVerificationEscapingAndBudgetContracts
}

struct LegacyCoreChecksScenarioInventory: Sendable {
    let assertionCount: Int
    let sortedMessageSHA256: String
}

let legacyCoreChecksScenarioInventory: [LegacyCoreChecksScenario: LegacyCoreChecksScenarioInventory] = [
    .onboardingFlowContracts: .init(assertionCount: 10, sortedMessageSHA256: "fa52ef66cfc15da0fc622891de083cb4f8c6989b75cda294aa0dce7965ffed11"),
    .cliResolutionAndStandardInputContracts: .init(assertionCount: 6, sortedMessageSHA256: "562eaee1dd13c170588d3482b5a822bf6e1fe6d363d2221c908f47e857cf8889"),
    .cliCancellationContracts: .init(assertionCount: 10, sortedMessageSHA256: "4d93d68b30b32e326aad8d2f93dacf515d346cc3fb373a1a9061f829f3c0c0ad"),
    .cliStandardInputTimeoutContracts: .init(assertionCount: 14, sortedMessageSHA256: "a979b18020324519db8eb863c445a7bd2ca9d3a61f7f8e6a447a3742527864d4"),
    .cliCleanupDeadlineAndOutputContracts: .init(assertionCount: 15, sortedMessageSHA256: "8c562230f44b6c485ddbb0a3f414bb193a05f53a22207445c9da3590b39b2989"),
    .githubDeviceFlowTransportContracts: .init(assertionCount: 14, sortedMessageSHA256: "7d747813edd367f1c3d9cbe0082b2ae9b1f56d1fd7d6217c3141fc503967e422"),
    .detachedCommandLaunchContracts: .init(assertionCount: 4, sortedMessageSHA256: "d2256a821d4f0eecfba2db5484b48e617ae10a09a007626268a76e82dbb70ddb"),
    .githubRecoveryRepositoryAndRateLimitContracts: .init(assertionCount: 29, sortedMessageSHA256: "bc27311a9264ba1b20622afabc316a78e48f1ea8539bff071564faaebf8a4092"),
    .configInspectAndPatchContracts: .init(assertionCount: 27, sortedMessageSHA256: "c963178d0c437cf22ab1e5cec966440761ac87c1730a9c5cd2ddc3107932393c"),
    .providerRegistryParsingAndPatchContracts: .init(assertionCount: 12, sortedMessageSHA256: "6e1aedf761fbafb911a260182d8e81110ab90f26ad1f26d26dfd8faf190529ef"),
    .providerVerificationTransportAndStrictEnvelopeContracts: .init(assertionCount: 37, sortedMessageSHA256: "27b74eecdf695f4be3fca3d9bf1090c8c41a2d27b1ca20e0e3ad47e6da28199e"),
    .canonicalRedactorCorpusContracts: .init(assertionCount: 195, sortedMessageSHA256: "b1af4e9101e9255b709cf93af983827cb367a7f37d1993940f004b0da2591c41"),
    .providerVerificationEscapingAndBudgetContracts: .init(assertionCount: 20, sortedMessageSHA256: "aabd8511ab77476e062c96210aee2ccafabaae2489d31fb44a7545313af56f1a")
]

enum LegacyCoreChecksExecution {
    @TaskLocal static var aggregate: LegacyCoreChecksAggregate?
}

@MainActor
final class LegacyCoreChecksAggregate: @unchecked Sendable {
    private var scenarioCounts: [LegacyCoreChecksScenario: Int] = [:]
    private var messages: [String] = []
    private var scenarioMessages: [LegacyCoreChecksScenario: [String]] = [:]

    func record(_ scenario: LegacyCoreChecksScenario, assertions: [LegacyCoreCheckAssertion]) {
        scenarioCounts[scenario, default: 0] += 1
        messages.append(contentsOf: assertions.map(\.message))
        scenarioMessages[scenario, default: []].append(contentsOf: assertions.map(\.message))
    }

    func verifyComplete() {
        #expect(LegacyCoreChecksScenario.allCases.count == 13)
        #expect(scenarioCounts.count == 13)
        for scenario in LegacyCoreChecksScenario.allCases {
            #expect(scenarioCounts[scenario] == 1, Comment("scenario \(scenario.rawValue) must execute exactly once"))
            let expected = legacyCoreChecksScenarioInventory[scenario]
            let values = scenarioMessages[scenario, default: []]
            #expect(values.count == expected?.assertionCount, Comment("scenario \(scenario.rawValue) assertion count"))
            #expect(coreChecksSHA256(values.sorted()) == expected?.sortedMessageSHA256, Comment("scenario \(scenario.rawValue) message inventory"))
        }
        #expect(messages.count == 393)
        #expect(Set(messages).count == 299)
        #expect(coreChecksSHA256(messages.sorted()) == "3b058009d4feec1492e1f9d55e1f1de2bf44461c45046936f8171a9fcec168ce")
    }
}

@MainActor
func assertLegacyCoreCheckScenario(
    _ scenario: LegacyCoreChecksScenario,
    function: String,
    _ assertions: [LegacyCoreCheckAssertion]
) {
    let currentFunction = String(function.prefix { $0 != "(" })
    #expect(currentFunction == scenario.rawValue, Comment("scenario mapping must match executing test function"))
    #expect(!assertions.isEmpty, Comment("scenario \(scenario.rawValue) must retain legacy assertions"))
    LegacyCoreChecksExecution.aggregate?.record(scenario, assertions: assertions)
    for assertion in assertions {
        #expect(assertion.passed, Comment(rawValue: assertion.message))
    }
}
