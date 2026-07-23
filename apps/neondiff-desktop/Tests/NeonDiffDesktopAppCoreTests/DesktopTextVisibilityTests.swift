import Foundation
import Testing
@testable import NeonDiffDesktopAppCore

@Suite("Desktop text visibility")
struct DesktopTextVisibilityTests {
    private let text = "first line\nHOSTED_INNER_SCROLL_SAFE_TAIL_070"
    private let token = "HOSTED_INNER_SCROLL_SAFE_TAIL_070"

    @Test("accepts a terminal token fully contained in the visible UTF-16 range")
    func acceptsFullyVisibleToken() {
        let tokenRange = (text as NSString).range(of: token)

        #expect(
            DesktopTextVisibility.visibleRange(
                tokenRange,
                fullyContainsTokenIn: text,
                terminalToken: token
            )
        )
    }

    @Test("rejects a terminal token that is only partially visible")
    func rejectsPartiallyVisibleToken() {
        let tokenRange = (text as NSString).range(of: token)
        let partialRange = NSRange(
            location: tokenRange.location + 1,
            length: tokenRange.length - 1
        )

        #expect(
            !DesktopTextVisibility.visibleRange(
                partialRange,
                fullyContainsTokenIn: text,
                terminalToken: token
            )
        )
    }

    @Test("rejects an absent token and invalid visible ranges")
    func rejectsAbsentTokenAndInvalidRanges() {
        #expect(
            !DesktopTextVisibility.visibleRange(
                NSRange(location: 0, length: (text as NSString).length),
                fullyContainsTokenIn: text,
                terminalToken: "absent"
            )
        )
        #expect(
            !DesktopTextVisibility.visibleRange(
                NSRange(location: NSNotFound, length: 0),
                fullyContainsTokenIn: text,
                terminalToken: token
            )
        )
        #expect(
            !DesktopTextVisibility.visibleRange(
                NSRange(location: 0, length: (text as NSString).length + 1),
                fullyContainsTokenIn: text,
                terminalToken: token
            )
        )
    }
}
