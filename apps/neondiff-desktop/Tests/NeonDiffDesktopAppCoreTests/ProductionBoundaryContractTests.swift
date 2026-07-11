import Testing

@Suite struct ProductionBoundaryContractTests {
    @Test func appCoreContainsNoExecutableOnlyOSDependencies() throws {
        let appCoreDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktopAppCore", isDirectory: true)
        let sourceFiles = sourceBoundarySwiftFiles(below: appCoreDirectory)

        #expect(!sourceFiles.isEmpty)

        let forbiddenTokens = [
            "import AppKit",
            "import SwiftUI",
            "import Sparkle",
            "import Security",
            "import XCTest",
            "NSPasteboard",
            "NSWorkspace",
            "FileManager.default",
            "UserDefaults.standard",
            "Task.sleep",
            "Date()",
            "NeonDiffCLIClient(",
            "ProviderVerificationService("
        ]

        for sourceFile in sourceFiles {
            let source = try sourceBoundaryText(at: sourceFile)
            for forbiddenToken in forbiddenTokens {
                #expect(!source.contains(forbiddenToken), Comment("\(sourceFile.lastPathComponent) contains \(forbiddenToken)"))
            }
        }
    }

    @Test func productionAdaptersExistOnlyInExecutableTarget() throws {
        let executableAdaptersDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktop/Adapters", isDirectory: true)
        let appCoreDirectory = sourceBoundaryPackageRoot()
            .appendingPathComponent("Sources/NeonDiffDesktopAppCore", isDirectory: true)
        let appCoreFileNames = sourceBoundarySwiftFiles(below: appCoreDirectory)
            .map(\.lastPathComponent)
        let adapterNames = [
            "AppKitClipboard",
            "AppKitURLOpener",
            "FoundationDesktopCLIExecutor",
            "FoundationDesktopDashboardLauncher",
            "UserDefaultsDesktopPreferences",
            "ContinuousDesktopClock",
            "ApplicationSupportFileWriter",
            "FoundationProviderVerifier"
        ]

        for adapterName in adapterNames {
            let executableAdapter = executableAdaptersDirectory
                .appendingPathComponent("\(adapterName).swift")

            #expect(sourceBoundaryFileExists(executableAdapter))
            #expect(!appCoreFileNames.contains("\(adapterName).swift"))
        }
    }
}
