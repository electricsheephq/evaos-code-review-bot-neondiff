// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "NeonDiffDesktop",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "NeonDiffDesktop", targets: ["NeonDiffDesktop"]),
        .executable(name: "NeonDiffDesktopCoreSmoke", targets: ["NeonDiffDesktopCoreSmoke"]),
        .library(name: "NeonDiffDesktopCore", targets: ["NeonDiffDesktopCore"]),
        .library(name: "NeonDiffDesktopAppCore", targets: ["NeonDiffDesktopAppCore"]),
        .library(
            name: "NeonDiffDesktopEvaluationSupport",
            targets: ["NeonDiffDesktopEvaluationSupport"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0")
    ],
    targets: [
        .target(name: "NeonDiffDesktopCore"),
        .target(
            name: "NeonDiffDesktopAppCore",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .testTarget(
            name: "NeonDiffDesktopCoreTests",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .testTarget(
            name: "NeonDiffDesktopAppCoreTests",
            dependencies: ["NeonDiffDesktopAppCore", "NeonDiffDesktopCore"]
        ),
        .testTarget(
            name: "NeonDiffDesktopEvaluationSupportTests",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktop",
            dependencies: [
                "NeonDiffDesktopAppCore",
                "NeonDiffDesktopCore",
                .product(name: "Sparkle", package: "Sparkle")
            ],
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])
            ]
        ),
        .executableTarget(
            name: "NeonDiffDesktopCoreSmoke",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopCapture",
            dependencies: ["NeonDiffDesktopCore", "NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopSettledGeometryCapture",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopReachabilityChecks",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopGeometryChecks",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopFixtureResolve",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopFixtureChecks",
            dependencies: ["NeonDiffDesktopCore", "NeonDiffDesktopEvaluationSupport"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopManifestChecks",
            dependencies: ["NeonDiffDesktopEvaluationSupport"]
        ),
        .target(
            name: "NeonDiffDesktopEvaluationSupport",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopKeychainChecks",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopAppcastChecks",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopAppcastDryRun",
            dependencies: ["NeonDiffDesktopCore"]
        )
    ]
)
