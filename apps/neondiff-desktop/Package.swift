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
        .library(name: "NeonDiffDesktopCore", targets: ["NeonDiffDesktopCore"])
    ],
    targets: [
        .target(name: "NeonDiffDesktopCore"),
        .executableTarget(
            name: "NeonDiffDesktop",
            dependencies: ["NeonDiffDesktopCore"]
        ),
        .executableTarget(
            name: "NeonDiffDesktopCoreSmoke",
            dependencies: ["NeonDiffDesktopCore"]
        )
    ]
)
