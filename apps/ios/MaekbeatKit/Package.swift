// swift-tools-version:5.10
import PackageDescription

// Everything the iOS app does lives in this library, so everything the iOS app
// does is measurable by the coverage gate (apps/ios/scripts/coverage-gate.sh).
// The app target in ../Maekbeat.xcodeproj is the @main shell and nothing else —
// the same rule apps/web holds for src/main.tsx, one target further out.
//
// macOS is a supported platform purely so `swift test` gives a fast local loop;
// the gate itself runs on the iOS Simulator, which is where the app ships.
let package = Package(
    name: "MaekbeatKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MaekbeatKit", targets: ["MaekbeatKit"])
    ],
    targets: [
        .target(name: "MaekbeatKit"),
        .testTarget(name: "MaekbeatKitTests", dependencies: ["MaekbeatKit"])
    ]
)
