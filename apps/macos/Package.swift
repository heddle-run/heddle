// swift-tools-version: 5.10
import PackageDescription

// The menu bar app is a Swift Package rather than an .xcodeproj so it builds
// headless (`swift build`) in CI and for anyone without Xcode.app configured.
// make-app.sh wraps the built binary into Heddle.app with its Info.plist.
let package = Package(
    name: "Heddle",
    platforms: [.macOS(.v14)],
    dependencies: [
        // The protocol layer both apps share — frames, reducer, run records.
        // See apps/HeddleCore/README.md.
        .package(path: "../HeddleCore")
    ],
    targets: [
        .executableTarget(
            name: "Heddle",
            dependencies: [
                .product(name: "HeddleCore", package: "HeddleCore")
            ],
            path: "Sources/Heddle"
        ),
        .testTarget(
            name: "HeddleTests",
            dependencies: [
                "Heddle",
                .product(name: "HeddleCore", package: "HeddleCore"),
            ],
            path: "Tests/HeddleTests"
        ),
    ]
)
