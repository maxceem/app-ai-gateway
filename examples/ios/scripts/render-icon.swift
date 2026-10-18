// Renders the demo's app icon: the App AI Gateway shield with a DEMO ribbon.
//
//   swift examples/ios/scripts/render-icon.swift icon.png preview.png
//
// The first file is the full square, for the asset catalog; the second is
// masked to an icon's rounded corners, to look at. iOS refuses an icon with an
// alpha channel, so flatten the first before using it:
//
//   sips -s format jpeg icon.png --out icon.jpg
//   sips -s format png icon.jpg --out GatewayDemo/Assets.xcassets/AppIcon.appiconset/AppIcon.png

import SwiftUI
import AppKit

/// The App AI Gateway shield: 82 x 100, the same path as the console's brand mark.
struct Shield: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 82, sy = rect.height / 100
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy) }
        var path = Path()
        path.move(to: p(41, 0))
        path.addLine(to: p(82, 12))
        path.addLine(to: p(82, 52))
        path.addCurve(to: p(41, 100), control1: p(82, 71), control2: p(69.7, 90.3))
        path.addCurve(to: p(0, 52), control1: p(12.3, 90.3), control2: p(0, 71))
        path.addLine(to: p(0, 12))
        path.closeSubpath()
        return path
    }
}

let brand = Color(red: 0x23 / 255, green: 0x76 / 255, blue: 0xE4 / 255)

struct Icon: View {
    let shieldHeight: CGFloat = 820
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.24, green: 0.56, blue: 0.98), Color(red: 0.09, green: 0.36, blue: 0.82)],
                           startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [.white.opacity(0.22), .clear], center: UnitPoint(x: 0.3, y: 0.15), startRadius: 0, endRadius: 700)

            ZStack {
                Shield()
                    .fill(.white)
                    .frame(width: shieldHeight * 0.82, height: shieldHeight)
                    .shadow(color: .black.opacity(0.22), radius: 34, y: 18)
                Text("AI")
                    .font(.system(size: shieldHeight * 0.46, weight: .bold))
                    .tracking(shieldHeight * 0.46 * 0.01)
                    .foregroundStyle(brand)
                    .offset(y: shieldHeight * -0.06)
            }
            .offset(y: -8)

            // The DEMO ribbon across the bottom-right corner.
            ZStack {
                Rectangle()
                    .fill(LinearGradient(colors: [Color(red: 1.0, green: 0.70, blue: 0.16), Color(red: 1.0, green: 0.52, blue: 0.0)],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 1300, height: 158)
                    .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.45)).frame(height: 5).padding(.top, 12) }
                    .overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.45)).frame(height: 5).padding(.bottom, 12) }
                    .shadow(color: .black.opacity(0.25), radius: 18, y: 6)
                Text("DEMO")
                    .font(.system(size: 92, weight: .heavy))
                    .tracking(14)
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.18), radius: 2, y: 2)
            }
            .rotationEffect(.degrees(-45))
            .offset(x: 285, y: 285)
        }
        .frame(width: 1024, height: 1024)
        .clipped()
    }
}

@MainActor func render(_ path: String, mask: Bool) {
    let view = Icon()
        .clipShape(RoundedRectangle(cornerRadius: mask ? 229 : 0, style: .continuous))
        .frame(width: 1024, height: 1024)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 1
    guard let image = renderer.cgImage else { fatalError("render failed") }
    let rep = NSBitmapImageRep(cgImage: image)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

MainActor.assumeIsolated {
    render(CommandLine.arguments[1], mask: false)
    render(CommandLine.arguments[2], mask: true)
}
