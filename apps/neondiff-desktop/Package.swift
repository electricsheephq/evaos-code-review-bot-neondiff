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
        .library(name: "NeonDiffDesktopAppCore", targets: ["NeonDiffDesktopAppCore"])
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
            name: "NeonDiffDesktopFixtureChecks",
            dependencies: ["NeonDiffDesktopCore", "NeonDiffDesktopEvaluationSupport"]
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
