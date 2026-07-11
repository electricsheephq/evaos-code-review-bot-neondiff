import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct AppCoreImportTests {
    @Test func moduleIsImportable() {
        #expect(NeonDiffDesktopAppCoreModule.contractVersion == 1)
    }
}
