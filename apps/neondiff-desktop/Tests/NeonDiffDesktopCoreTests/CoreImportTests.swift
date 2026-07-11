import Testing
@testable import NeonDiffDesktopCore

@Suite struct CoreImportTests {
    @Test func moduleIsImportable() {
        #expect(NeonDiffCommandBuilder.configInspect(
            cliPath: "neondiff",
            configPath: "fixture.json"
        ).commandLine.contains("config inspect"))
    }
}
