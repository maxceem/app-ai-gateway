// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AppAIGateway",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "AppAIGateway", targets: ["AppAIGateway"]),
        // A separate library, so apps that don't talk to ElevenLabs agents
        // don't carry its audio code.
        .library(name: "AppAIGatewayElevenLabs", targets: ["AppAIGatewayElevenLabs"]),
    ],
    targets: [
        .target(
            name: "AppAIGateway",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .target(
            name: "AppAIGatewayElevenLabs",
            dependencies: ["AppAIGateway"],
            linkerSettings: [.linkedFramework("AVFoundation")]
        ),
        .testTarget(
            name: "AppAIGatewayTests",
            dependencies: ["AppAIGateway"],
            // Read by path, not bundled: the gateway's own tests read the same file.
            exclude: ["Fixtures"]
        ),
        .testTarget(
            name: "AppAIGatewayElevenLabsTests",
            dependencies: ["AppAIGatewayElevenLabs"]
        ),
    ]
)
