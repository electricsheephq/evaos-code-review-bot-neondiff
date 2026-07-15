import Testing
@testable import NeonDiffDesktopAppCore

// Contract for issue #611: the semantic design tokens derived from the live
// production site (https://neondiff.com, captured 2026-07-15) must exist for
// both appearances and clear the WCAG accessibility floors documented in
// docs/design/live-site-design-source.md. The WCAG relative-luminance formula
// is implemented here so the floor is proven, not asserted by fiat.
@Suite struct NDDesignTokenContractTests {
    private func relativeLuminance(_ color: NDColorValue) -> Double {
        func linearize(_ channel: Double) -> Double {
            channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linearize(color.red)
            + 0.7152 * linearize(color.green)
            + 0.0722 * linearize(color.blue)
    }

    private func contrastRatio(_ lhs: NDColorValue, _ rhs: NDColorValue) -> Double {
        let a = relativeLuminance(lhs)
        let b = relativeLuminance(rhs)
        let lighter = max(a, b)
        let darker = min(a, b)
        return (lighter + 0.05) / (darker + 0.05)
    }

    @Test func allTenSemanticTokensExist() {
        let expected = [
            "background", "surface", "textPrimary", "textSecondary",
            "accentPrimary", "accentMagenta", "warning", "danger",
            "borderPrimary", "borderInput"
        ]
        let names = Set(NDDesignTokens.all.map(\.name))
        #expect(NDDesignTokens.all.count == expected.count)
        for token in expected {
            #expect(names.contains(token), "missing semantic token \(token)")
        }
    }

    @Test func darkAndLightDifferForKeyRoles() {
        for token in [NDDesignTokens.background, NDDesignTokens.textPrimary, NDDesignTokens.accentPrimary] {
            #expect(token.dark != token.light, "dark and light values must differ for a first-class light mode")
        }
    }

    @Test func contrastFloorsHoldInBothAppearances() {
        let floor = 4.5
        let darkText = contrastRatio(NDDesignTokens.textPrimary.dark, NDDesignTokens.background.dark)
        let darkAccent = contrastRatio(NDDesignTokens.accentPrimary.dark, NDDesignTokens.background.dark)
        let lightText = contrastRatio(NDDesignTokens.textPrimary.light, NDDesignTokens.background.light)
        let lightAccent = contrastRatio(NDDesignTokens.accentPrimary.light, NDDesignTokens.background.light)

        #expect(darkText >= floor, "textPrimary-on-background (dark) = \(darkText)")
        #expect(darkAccent >= floor, "accentPrimary-on-background (dark) = \(darkAccent)")
        #expect(lightText >= floor, "textPrimary-on-background (light) = \(lightText)")
        #expect(lightAccent >= floor, "accentPrimary-on-background (light) = \(lightAccent)")
    }
}
