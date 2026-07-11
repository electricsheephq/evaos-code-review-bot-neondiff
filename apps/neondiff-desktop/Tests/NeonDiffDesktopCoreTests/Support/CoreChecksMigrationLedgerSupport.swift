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
    .onboardingFlowContracts: .init(assertionCount: 10, sortedMessageSHA256: "c5ba559e388905b38fda89cf21c1ff2bccca392dec2f827588b0fdcfa21d2a8d"),
    .cliResolutionAndStandardInputContracts: .init(assertionCount: 5, sortedMessageSHA256: "905317318e872cdbb40a315287265524c03bb9833225852c344f866b970dc9db"),
    .cliCancellationContracts: .init(assertionCount: 10, sortedMessageSHA256: "f01d08e8d59093c74193406a4ad18aec5569447eaa924a28858f149e6e015e6f"),
    .cliStandardInputTimeoutContracts: .init(assertionCount: 14, sortedMessageSHA256: "ddd5b166d183319ea477171185bd713c05baffe65bf1f66f2f8908246f2b6c22"),
    .cliCleanupDeadlineAndOutputContracts: .init(assertionCount: 15, sortedMessageSHA256: "119af28fc994298a1f6aadf74e50fd06e8ff50f03d8d80b9ac0090d8e5780858"),
    .githubDeviceFlowTransportContracts: .init(assertionCount: 14, sortedMessageSHA256: "351e4087df270522a2acb1d4872389d1d275bd32ff8ba89c3e5b93b9cd8bc51a"),
    .detachedCommandLaunchContracts: .init(assertionCount: 4, sortedMessageSHA256: "22e122292016c1526c876ae8bafc7bf75343588786d9796f06c2b15d1fe3d17b"),
    .githubRecoveryRepositoryAndRateLimitContracts: .init(assertionCount: 29, sortedMessageSHA256: "7e8dc26a3c8d899bc5497a4198a7c32dc2d0298da5b82ca4d65e9791716eb450"),
    .configInspectAndPatchContracts: .init(assertionCount: 27, sortedMessageSHA256: "537f57b1515b583e871f88b9df52438af52709de4e8acf66f36fffd4b86b6df0"),
    .providerRegistryParsingAndPatchContracts: .init(assertionCount: 9, sortedMessageSHA256: "9c8216564d1e3fb401cbf2c5c8cc8db17dcea9f2f2297f9c4c0ac26479f7ec41"),
    .providerVerificationTransportAndStrictEnvelopeContracts: .init(assertionCount: 37, sortedMessageSHA256: "8a31e05ce98c94a5c4cff0d01e9257758a778fa3dea9b792370beb6992c2ae67"),
    .canonicalRedactorCorpusContracts: .init(assertionCount: 195, sortedMessageSHA256: "aa59c4bd36916df3b58b8e1a4853aac9f67675c513edf60808b23b3f4bfcf4a6"),
    .providerVerificationEscapingAndBudgetContracts: .init(assertionCount: 20, sortedMessageSHA256: "1e23a46f76f0ad3ba40bb8fef3200e684f1b9526a270e96dd4bd114744767b39")
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
        #expect(messages.count == 389)
        #expect(Set(messages).count == 295)
        #expect(coreChecksSHA256(messages.sorted()) == "09bac066ca56654a62415feb63a95d509af72f6f9e72dbe942e6e231291d31b0")
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
