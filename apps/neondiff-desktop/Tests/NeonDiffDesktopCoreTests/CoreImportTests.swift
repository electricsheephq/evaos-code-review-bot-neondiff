import Foundation
import Testing
@testable import NeonDiffDesktopCore

@Suite struct CoreImportTests {
    @Test func moduleIsImportable() {
        #expect(NeonDiffCommandBuilder.configInspect(
            cliPath: "neondiff",
            configPath: "fixture.json"
        ).commandLine.contains("config inspect"))
    }

    @Test func providerDefaultsStayUnderTheLocalUserHome() {
        let expected = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/zcode/config.json")
            .path
        let settings = ProviderSettings()

        #expect(settings.zcodeAppConfigPath == expected)
        #expect(!settings.zcodeAppConfigPath.hasPrefix("/Volumes/"))
    }
}
