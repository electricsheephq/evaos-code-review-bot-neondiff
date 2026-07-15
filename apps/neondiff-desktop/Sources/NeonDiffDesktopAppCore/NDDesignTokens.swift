import Foundation

// Semantic design tokens for issue #611, derived from the live production
// website (https://neondiff.com, captured 2026-07-15). These are pure sRGB
// values with no SwiftUI/AppKit dependency so they can be unit-tested for
// existence and WCAG contrast, and consumed by the SwiftUI theme layer
// (NeonDiffTheme.NDColor) for appearance resolution. See
// docs/design/live-site-design-source.md for the authoritative token table.

package struct NDColorValue: Equatable, Sendable {
    package let red: Double
    package let green: Double
    package let blue: Double
    package let opacity: Double

    package init(red: Double, green: Double, blue: Double, opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    /// 24-bit `0xRRGGBB` sRGB value, optionally at a reduced alpha.
    package init(hex: UInt32, opacity: Double = 1) {
        self.red = Double((hex >> 16) & 0xFF) / 255
        self.green = Double((hex >> 8) & 0xFF) / 255
        self.blue = Double(hex & 0xFF) / 255
        self.opacity = opacity
    }
}

/// A semantic role expressed in both the brand-native dark appearance and the
/// first-class light translation (never a naive inversion).
package struct NDSemanticColor: Sendable {
    package let dark: NDColorValue
    package let light: NDColorValue

    package init(dark: NDColorValue, light: NDColorValue) {
        self.dark = dark
        self.light = light
    }
}

package enum NDDesignTokens {
    package static let background = NDSemanticColor(dark: NDColorValue(hex: 0x000000), light: NDColorValue(hex: 0xFAFAF8))
    package static let surface = NDSemanticColor(dark: NDColorValue(hex: 0x0A0F0C), light: NDColorValue(hex: 0xFFFFFF))
    package static let textPrimary = NDSemanticColor(dark: NDColorValue(hex: 0xD9FFE6), light: NDColorValue(hex: 0x1A211C))
    package static let textSecondary = NDSemanticColor(dark: NDColorValue(hex: 0x6D8A75), light: NDColorValue(hex: 0x5A6B5F))
    package static let accentPrimary = NDSemanticColor(dark: NDColorValue(hex: 0x39FF88), light: NDColorValue(hex: 0x0F7A3D))
    package static let accentMagenta = NDSemanticColor(dark: NDColorValue(hex: 0xFF2BD6), light: NDColorValue(hex: 0xB01E96))
    package static let warning = NDSemanticColor(dark: NDColorValue(hex: 0xFFCC33), light: NDColorValue(hex: 0x8A6D00))
    package static let danger = NDSemanticColor(dark: NDColorValue(hex: 0xFF3B6B), light: NDColorValue(hex: 0xC21E44))
    package static let borderPrimary = NDSemanticColor(dark: NDColorValue(hex: 0x39FF88, opacity: 0.22), light: NDColorValue(hex: 0x0F7A3D, opacity: 0.35))
    package static let borderInput = NDSemanticColor(dark: NDColorValue(hex: 0x39FF88, opacity: 0.18), light: NDColorValue(hex: 0x0F7A3D, opacity: 0.30))

    /// Stable name → value listing for contract enforcement.
    package static let all: [(name: String, color: NDSemanticColor)] = [
        ("background", background),
        ("surface", surface),
        ("textPrimary", textPrimary),
        ("textSecondary", textSecondary),
        ("accentPrimary", accentPrimary),
        ("accentMagenta", accentMagenta),
        ("warning", warning),
        ("danger", danger),
        ("borderPrimary", borderPrimary),
        ("borderInput", borderInput)
    ]
}
