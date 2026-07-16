import Foundation

#if DEBUG
/// Pure UTF-16 range validation used by the DEBUG desktop fixture to prove
/// that a known terminal token is fully inside an AppKit text view's rendered
/// visible character range. The helper does not expose or persist text.
public enum DesktopTextVisibility {
    public static func visibleRange(
        _ visibleRange: NSRange,
        fullyContainsTokenIn text: String,
        terminalToken: String
    ) -> Bool {
        guard visibleRange.location != NSNotFound,
              !terminalToken.isEmpty else {
            return false
        }

        let utf16Text = text as NSString
        guard visibleRange.location >= 0,
              visibleRange.length >= 0,
              visibleRange.location <= utf16Text.length,
              visibleRange.length <= utf16Text.length - visibleRange.location else {
            return false
        }

        let tokenRange = utf16Text.range(of: terminalToken)
        guard tokenRange.location != NSNotFound else {
            return false
        }

        return tokenRange.location >= visibleRange.location
            && NSMaxRange(tokenRange) <= NSMaxRange(visibleRange)
    }
}
#endif
