import CoreText
import Foundation
import SwiftUI

enum NeonFontRegistry {
    static let saibaPostScriptName = "SAIBA-45"

    static func registerBundledFonts() {
        guard let fontURL = Bundle.module.url(
            forResource: "SAIBA-45-Regular",
            withExtension: "otf",
            subdirectory: "Fonts"
        ) else {
            return
        }

        CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
    }
}

extension Font {
    static func saiba(size: CGFloat) -> Font {
        .custom(NeonFontRegistry.saibaPostScriptName, size: size)
    }
}
