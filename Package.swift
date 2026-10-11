// swift-tools-version:5.9
// Builds the Mac menu bar app. The phone app is a website (Web/) served by this
// same app, so there is no Xcode project to open any more — just this package.
import PackageDescription

let package = Package(
    name: "Buddy",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "BuddyMac", targets: ["BuddyMac"]),
    ],
    targets: [
        .target(name: "BuddyShared", path: "Shared", exclude: ["Fonts"]),
        // The phone app is the website in Web/, served by the little bridge in
        // companion/ (browsers need HTTP and HTTPS, which is the bridge's job),
        // so the Mac target has no resources of its own.
        .executableTarget(
            name: "BuddyMac",
            dependencies: ["BuddyShared"],
            path: "Mac/Sources/BuddyMac"
        ),
    ]
)
