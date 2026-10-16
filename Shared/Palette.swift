import Foundation

/// Buddy's colours, as 0xRRGGBB. He is a violet blob: a light lavender highlight
/// down to a deep purple, with a plum nose. The same values are used by the Mac
/// (his cursor, menu bar and report card) and by the website in `Web/style.css`
/// and `Web/face.js`, so both halves of him match exactly.
public enum Palette {
    public static let violet1: UInt32 = 0xC9B2FF  // light lavender
    public static let violet2: UInt32 = 0x9A6BFF  // vivid violet
    public static let violet3: UInt32 = 0x6C3FE0  // deep violet
    public static let violet4: UInt32 = 0x3A1E78  // dark purple
    public static let nose: UInt32 = 0x241042      // plum
    public static let ink: UInt32 = 0x17151F
    public static let inkSoft: UInt32 = 0xB9B2CC
    public static let panel: UInt32 = 0x1A1330

    public static let gradient: [UInt32] = [violet1, violet2, violet3, violet4]
    public static let gradientStops: [Double] = [0, 0.34, 0.68, 1]

    public static func rgb(_ hex: UInt32) -> (r: Double, g: Double, b: Double) {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }
}
