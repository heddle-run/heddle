// swift-tools-version: 5.10
import PackageDescription

// The apps' shared core. The macOS menu bar app and the iOS app speak the
// same runtime — the CLI over stdout for one, heddle-server over SSE for the
// other — and the frames on either wire are the same `serializeEvent` shapes.
// This package holds the logic those shapes imply (decoding, reducing,
// record state, answer rendering) once, so a front end adds only its
// transport and its UI.
let package = Package(
    name: "HeddleCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "HeddleCore", targets: ["HeddleCore"])
    ],
    targets: [
        .target(name: "HeddleCore"),
        .testTarget(
            name: "HeddleCoreTests",
            dependencies: ["HeddleCore"]
        ),
    ]
)
