import Testing

@Suite struct ModelHarnessMigrationLedgerTests {
    @Test func everyLegacyAssertionMapsOnceToAConcreteTestFunction() throws {
        #expect(modelHarnessMigrationLedger.count == 85)
        #expect(Set(modelHarnessMigrationLedger.map(\.message)).count == 85)

        let sources = try Dictionary(uniqueKeysWithValues: Set(modelHarnessMigrationLedger.map(\.fileName)).map {
            ($0, try modelHarnessMigrationSource(fileName: $0))
        })
        for entry in modelHarnessMigrationLedger {
            let source = try #require(sources[entry.fileName])
            let body = try #require(modelHarnessFunctionBody(entry.testFunction, in: source))
            let exactComment = "// \(entry.message)"
            #expect(body.split(separator: "\n").contains { $0.hasSuffix(exactComment) })

            let totalMappings = sources.values.reduce(into: 0) { count, source in
                count += source.split(separator: "\n").count {
                    $0.hasSuffix(exactComment)
                }
            }
            #expect(totalMappings == 1)
        }
    }
}
