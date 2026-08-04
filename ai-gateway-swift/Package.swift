// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AIGateway",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "AIGateway", targets: ["AIGateway"]),
    ],
    targets: [
        .target(
            name: "AIGateway",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .testTarget(name: "AIGatewayTests", dependencies: ["AIGateway"]),
    ]
)
