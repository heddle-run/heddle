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
        // zlib as Apple ships it — a system library, not a package dependency.
        // The bundle reader inflates with it; the archive itself is hand-rolled
        // ustar, the same zero-dependency stance the TS writer takes.
        .systemLibrary(name: "CZlib", path: "Sources/CZlib"),
        .target(
            name: "HeddleCore",
            dependencies: ["CZlib"],
            // The embedded engine artifact, refreshed by the repo's
            // update-engine-artifact.sh. `.copy` keeps the subdirectory the
            // code looks it up by — named anything but "Resources", because a
            // top-level Resources/ inside the built bundle reads to codesign
            // as a malformed deep bundle, and iOS bundles are shallow.
            resources: [.copy("EngineResources")]
        ),
        .testTarget(
            name: "HeddleCoreTests",
            dependencies: ["HeddleCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
