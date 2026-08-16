#if DEBUG
import AppKit
import Darwin
import Foundation
import NeonDiffDesktopCore

enum DesktopResolvedEvaluationAppearance: String, Codable {
    case dark
    case light
    case system
}

struct DesktopResolvedEvaluationFixture: Codable {
    struct Surface: Codable {
        let section: DesktopSection
        let onboardingStep: OnboardingStep?
    }

    struct Environment: Codable {
        let clock: String
        let locale: String
        let appearance: DesktopResolvedEvaluationAppearance
        let disableAnimations: Bool
    }

    struct Repository: Codable {
        let name: String
        let enabled: Bool
        let profile: String
        let lastReview: String
    }

    struct Provider: Codable {
        let id: String
        let displayName: String
        let adapter: String
        let authMode: String
        let baseURL: String
        let model: String
        let credentialPresent: Bool
        let verification: String
    }

    struct License: Codable {
        let entitlement: String
        let credentialPresent: Bool
        let updateChannel: String
    }

    struct GitHub: Codable {
        let connection: String
        let login: String?
        let repositoryCount: Int
    }

    struct State: Codable {
        let health: String
        let runtimeReady: Bool?
        let repositories: [Repository]
        let provider: Provider?
        let license: License
        let github: GitHub
        let logText: String
    }

    let schemaVersion: Int
    let id: String
    let surface: Surface
    let environment: Environment
    let state: State
}

struct DesktopResolvedEvaluationLaunchContext {
    let fixture: DesktopResolvedEvaluationFixture
    let contentSize: NSSize
    let textSizeMode: DesktopResolvedEvaluationTextSizeMode
    let disableAnimations: Bool
}

enum DesktopResolvedEvaluationTextSizeMode: String {
    case runnerDefault = "runner-default"
    case accessibility3
}

enum DesktopResolvedEvaluationLaunch {
    static func load(arguments: [String]) throws -> DesktopResolvedEvaluationLaunchContext? {
        let requiredFlags = ["--ui-testing", "--ui-fixture", "--content-size", "--disable-animations"]
        let optionalFlags = ["--text-size"]
        let evaluationFlags = requiredFlags + optionalFlags
        guard arguments.contains(where: evaluationFlags.contains) else { return nil }
        guard requiredFlags.allSatisfy({ flag in arguments.filter({ $0 == flag }).count == 1 }),
              optionalFlags.allSatisfy({ flag in arguments.filter({ $0 == flag }).count <= 1 }) else {
            throw DesktopResolvedEvaluationLaunchError.invalidArguments
        }
        guard let fixturePath = value(after: "--ui-fixture", in: arguments),
              fixturePath.hasPrefix("/"),
              let size = value(after: "--content-size", in: arguments),
              size.range(of: "^[0-9]+x[0-9]+$", options: .regularExpression) != nil else {
            throw DesktopResolvedEvaluationLaunchError.invalidArguments
        }
        let pieces = size.split(separator: "x")
        guard pieces.count == 2,
              let width = Int(pieces[0]),
              let height = Int(pieces[1]),
              [(1040, 680), (1280, 800), (1440, 900), (760, 560), (560, 700)]
                .contains(where: { $0 == (width, height) }) else {
            throw DesktopResolvedEvaluationLaunchError.invalidArguments
        }
        let textSizeValue = value(after: "--text-size", in: arguments)
        if arguments.contains("--text-size"), textSizeValue == nil {
            throw DesktopResolvedEvaluationLaunchError.invalidArguments
        }
        guard let textSizeMode = DesktopResolvedEvaluationTextSizeMode(
            rawValue: textSizeValue ?? DesktopResolvedEvaluationTextSizeMode.runnerDefault.rawValue
        ) else {
            throw DesktopResolvedEvaluationLaunchError.invalidArguments
        }
        let fixture = try resolveFixture(arguments: arguments)
        guard fixture.schemaVersion == 1, fixture.environment.disableAnimations else {
            throw DesktopResolvedEvaluationLaunchError.invalidFixture
        }
        return DesktopResolvedEvaluationLaunchContext(
            fixture: fixture,
            contentSize: NSSize(width: width, height: height),
            textSizeMode: textSizeMode,
            disableAnimations: true
        )
    }

    private static func resolveFixture(arguments: [String]) throws -> DesktopResolvedEvaluationFixture {
        let process = Process()
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("neondiff-fixture-resolver-\(UUID().uuidString).log")
        guard FileManager.default.createFile(
            atPath: outputURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw DesktopResolvedEvaluationLaunchError.resolver("could not create bounded resolver output")
        }
        defer { try? FileManager.default.removeItem(at: outputURL) }
        let combinedOutput = try FileHandle(forWritingTo: outputURL)
        defer { try? combinedOutput.close() }
        process.executableURL = try resolverURL()
        process.arguments = Array(arguments.dropFirst())
        process.standardOutput = combinedOutput
        process.standardError = combinedOutput
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        try process.run()
        var timedOut = false
        if exited.wait(timeout: .now() + 5) == .timedOut {
            timedOut = true
            process.terminate()
            if exited.wait(timeout: .now() + 1) == .timedOut {
                Darwin.kill(process.processIdentifier, SIGKILL)
                guard exited.wait(timeout: .now() + 1) == .success else {
                    throw DesktopResolvedEvaluationLaunchError.resolver("fixture resolver could not be terminated")
                }
            }
        }
        try combinedOutput.synchronize()
        let data = try Data(contentsOf: outputURL, options: [.mappedIfSafe])
        if timedOut {
            throw DesktopResolvedEvaluationLaunchError.resolver("fixture resolver timed out")
        }
        guard process.terminationReason == .exit,
              process.terminationStatus == 0,
              !data.isEmpty,
              data.count <= 256 * 1024 else {
            let detail = String(data: data.prefix(2048), encoding: .utf8) ?? "fixture resolver failed"
            throw DesktopResolvedEvaluationLaunchError.resolver(detail.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        do {
            return try JSONDecoder().decode(DesktopResolvedEvaluationFixture.self, from: data)
        } catch {
            throw DesktopResolvedEvaluationLaunchError.invalidFixture
        }
    }

    private static func resolverURL() throws -> URL {
        let executable = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0]).standardizedFileURL
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/NeonDiffDesktopFixtureResolve"),
            executable.deletingLastPathComponent().appendingPathComponent("NeonDiffDesktopFixtureResolve")
        ]
        for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
            let values = try candidate.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isExecutableKey])
            if values.isRegularFile == true, values.isSymbolicLink != true, values.isExecutable == true {
                return candidate
            }
        }
        throw DesktopResolvedEvaluationLaunchError.resolver("trusted fixture resolver is unavailable")
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        let value = arguments[index + 1]
        return value.hasPrefix("--") ? nil : value
    }
}

enum DesktopResolvedEvaluationLaunchError: LocalizedError {
    case invalidArguments
    case invalidFixture
    case resolver(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments: "UI-testing launch arguments are invalid."
        case .invalidFixture: "Resolved UI fixture is invalid."
        case .resolver(let detail): "UI fixture resolver failed: \(detail)"
        }
    }
}
#endif
