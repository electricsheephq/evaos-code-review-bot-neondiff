import SwiftUI
import NeonDiffDesktopAppCore

// MARK: - NeonDiff design contract (#611)
//
// Semantic token + type + component layer derived from the live production
// website (https://neondiff.com, captured 2026-07-15). Values live as pure
// sRGB in NeonDiffDesktopAppCore.NDDesignTokens (unit-tested for existence and
// WCAG contrast); this layer resolves them into SwiftUI for both appearances.
// See docs/design/live-site-design-source.md. This is additive translation, not
// a rewrite of the existing NeonDiffTheme operator styling.

/// Resolves the ten semantic roles into plain SwiftUI colors for a given
/// appearance. Built from SwiftUI's `\.colorScheme` (NOT an NSColor dynamic
/// provider) so it follows `.preferredColorScheme` and the evaluation fixture's
/// appearance override — an NSColor dynamic provider resolves against the
/// window/system appearance and silently ignores the SwiftUI scheme.
struct NDPalette {
    var scheme: ColorScheme

    private func resolve(_ token: NDSemanticColor) -> Color {
        let value = scheme == .dark ? token.dark : token.light
        return Color(.sRGB, red: value.red, green: value.green, blue: value.blue, opacity: value.opacity)
    }

    var background: Color { resolve(NDDesignTokens.background) }
    var surface: Color { resolve(NDDesignTokens.surface) }
    var textPrimary: Color { resolve(NDDesignTokens.textPrimary) }
    var textSecondary: Color { resolve(NDDesignTokens.textSecondary) }
    var accentPrimary: Color { resolve(NDDesignTokens.accentPrimary) }
    var accentMagenta: Color { resolve(NDDesignTokens.accentMagenta) }
    var warning: Color { resolve(NDDesignTokens.warning) }
    var danger: Color { resolve(NDDesignTokens.danger) }
    var borderPrimary: Color { resolve(NDDesignTokens.borderPrimary) }
    var borderInput: Color { resolve(NDDesignTokens.borderInput) }
}

/// The mono label/console type system — the strongest carry-over identity
/// element. Relative text styles so everything scales with Dynamic Type.
enum NDFont {
    /// Section labels, status chips, stat-row labels. Apply with `ndSectionLabel()`.
    static let label = Font.system(.caption, design: .monospaced).weight(.semibold)
    /// Console/key-value values.
    static let mono = Font.system(.footnote, design: .monospaced)
}

extension View {
    /// `SECTION // LABEL`-style uppercase mono header in working screens.
    func ndSectionLabel(_ palette: NDPalette) -> some View {
        self.font(NDFont.label)
            .tracking(1.8)
            .textCase(.uppercase)
            .foregroundStyle(palette.textSecondary)
    }
}

/// `[ TITLE ]` bracket CTA for the ONE primary action per screen. Square
/// corners, accentPrimary @6% fill, primary border @40% stepping to full alpha
/// under Increase Contrast, disabled/pressed states. Keyboard focus preserved.
struct NDBracketButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        NDBracketButtonBody(configuration: configuration)
    }

    private struct NDBracketButtonBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.colorScheme) private var colorScheme
        @Environment(\.colorSchemeContrast) private var contrast
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let palette = NDPalette(scheme: colorScheme)
            let increased = contrast == .increased
            let borderAlpha = increased ? 1.0 : (configuration.isPressed ? 0.7 : 0.4)
            let fillAlpha = configuration.isPressed ? 0.12 : 0.06

            HStack(spacing: 6) {
                Text("[").font(NDFont.label)
                configuration.label
                    .font(NDFont.label)
                    .textCase(.uppercase)
                    .tracking(1.8)
                Text("]").font(NDFont.label)
            }
            .foregroundStyle(palette.accentPrimary.opacity(isEnabled ? 1 : 0.45))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Rectangle().fill(palette.accentPrimary.opacity(isEnabled ? fillAlpha : 0.03)))
            .overlay(Rectangle().stroke(palette.accentPrimary.opacity(isEnabled ? borderAlpha : 0.25), lineWidth: 1))
            .contentShape(Rectangle())
        }
    }
}

/// Secondary/tertiary actions on tokenized surfaces. Legible in both
/// appearances (textPrimary label, 1px borderInput outline, square corners per
/// the contract — the angled/bracket treatment is reserved for the ONE primary
/// action per screen). Not neon, so the bracket primary stays unambiguous.
struct NDSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        NDSecondaryButtonBody(configuration: configuration)
    }

    private struct NDSecondaryButtonBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.colorScheme) private var colorScheme
        @Environment(\.colorSchemeContrast) private var contrast
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let palette = NDPalette(scheme: colorScheme)
            let increased = contrast == .increased
            let borderColor = increased ? palette.accentPrimary : palette.borderInput
            configuration.label
                .font(.callout.weight(.medium))
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .foregroundStyle(palette.textPrimary.opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4))
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(Rectangle().fill(palette.surface.opacity(configuration.isPressed ? 0.6 : 1)))
                .overlay(Rectangle().stroke(borderColor, lineWidth: 1))
                .contentShape(Rectangle())
        }
    }
}

/// Console/evidence surface: surface background, 1px primary border, corner
/// ticks. Border steps to full-alpha accent under Increase Contrast. The
/// corner-tick flourish is the one decorative brand treatment a screen may
/// spend (neon budget), so it is reserved for evidence/log/review surfaces
/// where it is the sole treatment — the Overview reference screen spends its
/// budget on the bracket CTA instead. Downstream adoption is #520-owned.
struct NDConsolePanel<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        NDConsolePanelBody { content }
    }

    private struct NDConsolePanelBody<Inner: View>: View {
        @Environment(\.colorScheme) private var colorScheme
        @Environment(\.colorSchemeContrast) private var contrast
        private let inner: Inner

        init(@ViewBuilder inner: () -> Inner) {
            self.inner = inner()
        }

        var body: some View {
            let palette = NDPalette(scheme: colorScheme)
            let increased = contrast == .increased
            inner
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Rectangle().fill(palette.surface))
                .overlay(
                    Rectangle().stroke(increased ? palette.accentPrimary : palette.borderPrimary, lineWidth: 1)
                )
                .overlay(NDConsoleCornerTicks(color: palette.accentPrimary.opacity(increased ? 1 : 0.7)))
        }
    }
}

private struct NDConsoleCornerTicks: View {
    var color: Color

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            let length: CGFloat = 14
            Path { path in
                path.move(to: CGPoint(x: 0, y: length))
                path.addLine(to: .zero)
                path.addLine(to: CGPoint(x: length, y: 0))

                path.move(to: CGPoint(x: width - length, y: 0))
                path.addLine(to: CGPoint(x: width, y: 0))
                path.addLine(to: CGPoint(x: width, y: length))

                path.move(to: CGPoint(x: width, y: height - length))
                path.addLine(to: CGPoint(x: width, y: height))
                path.addLine(to: CGPoint(x: width - length, y: height))

                path.move(to: CGPoint(x: length, y: height))
                path.addLine(to: CGPoint(x: 0, y: height))
                path.addLine(to: CGPoint(x: 0, y: height - length))
            }
            .stroke(color, lineWidth: 1)
        }
        .allowsHitTesting(false)
    }
}

enum NeonDiffTheme {
    static let shell = Color(red: 0.020, green: 0.024, blue: 0.031)
    static let chrome = Color(red: 0.008, green: 0.014, blue: 0.012)
    static let sidebar = Color(red: 0.018, green: 0.030, blue: 0.025)
    static let panel = Color(red: 0.030, green: 0.047, blue: 0.039)
    static let panelActive = Color(red: 0.035, green: 0.082, blue: 0.055)
    static let panelRaised = Color(red: 0.050, green: 0.066, blue: 0.058)
    static let accent = Color(red: 0.224, green: 1.0, blue: 0.533)
    static let accentSoft = Color(red: 0.68, green: 0.91, blue: 0.78)
    static let cyan = Color(red: 0.0, green: 0.898, blue: 1.0)
    static let magenta = Color(red: 1.0, green: 0.169, blue: 0.839)
    static let textPrimary = Color(red: 0.90, green: 1.0, blue: 0.97)
    static let textSecondary = Color(red: 0.55, green: 0.70, blue: 0.62)
    static let stroke = Color(red: 0.10, green: 0.58, blue: 0.25)
    static let warning = Color(red: 1.0, green: 0.34, blue: 0.30)

    static let logoFont = Font.system(size: 26, weight: .black, design: .monospaced)
    static let headlineFont = Font.system(.headline, design: .monospaced).weight(.bold)
    static let badgeFont = Font.system(.caption, design: .monospaced).weight(.bold)
    static let commandFont = Font.system(.caption, design: .monospaced)

    static func displayFont(size: CGFloat) -> Font {
        .system(size: size, weight: .black, design: .monospaced)
    }

    static func statusColor(_ value: String) -> Color {
        let normalized = value.lowercased()
        if normalized.contains("ok") || normalized.contains("stored") || normalized.contains("ready") || normalized.contains("active") {
            return accent
        }
        if normalized.contains("missing") || normalized.contains("blocked") || normalized.contains("error") || normalized.contains("unknown") {
            return warning
        }
        return accentSoft
    }
}

struct AngularRectangle: Shape {
    var corner: CGFloat = 14

    func path(in rect: CGRect) -> Path {
        let cut = min(corner, rect.width / 3, rect.height / 3)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + cut, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - cut, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + cut))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - cut))
        path.addLine(to: CGPoint(x: rect.maxX - cut, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + cut, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - cut))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + cut))
        path.closeSubpath()
        return path
    }
}

struct OperatorBackdrop: View {
    var body: some View {
        ZStack {
            NeonDiffTheme.shell

            Canvas { context, size in
                var grid = Path()
                let spacing: CGFloat = 36
                var x: CGFloat = 0
                while x <= size.width {
                    grid.move(to: CGPoint(x: x, y: 0))
                    grid.addLine(to: CGPoint(x: x, y: size.height))
                    x += spacing
                }
                var y: CGFloat = 0
                while y <= size.height {
                    grid.move(to: CGPoint(x: 0, y: y))
                    grid.addLine(to: CGPoint(x: size.width, y: y))
                    y += spacing
                }
                context.stroke(grid, with: .color(NeonDiffTheme.accent.opacity(0.055)), lineWidth: 0.6)

                var scanlines = Path()
                y = 0
                while y <= size.height {
                    scanlines.move(to: CGPoint(x: 0, y: y))
                    scanlines.addLine(to: CGPoint(x: size.width, y: y))
                    y += 7
                }
                context.stroke(scanlines, with: .color(NeonDiffTheme.accent.opacity(0.032)), lineWidth: 0.35)

                var diagonal = Path()
                diagonal.move(to: CGPoint(x: size.width * 0.70, y: 0))
                diagonal.addLine(to: CGPoint(x: size.width, y: size.height * 0.26))
                diagonal.move(to: CGPoint(x: size.width * 0.77, y: size.height))
                diagonal.addLine(to: CGPoint(x: size.width, y: size.height * 0.76))
                context.stroke(diagonal, with: .color(NeonDiffTheme.accent.opacity(0.18)), lineWidth: 0.8)
            }
        }
        .ignoresSafeArea()
    }
}

struct OperatorSectionHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var title: String
    var status: String

    /// macOS does not scale `@ScaledMetric` from SwiftUI's dynamic-type override,
    /// so resolve the shared title size directly from the environment.
    private var sectionTitleSize: CGFloat {
        switch dynamicTypeSize {
        case .xSmall: 11
        case .small: 12
        case .medium, .large: 13
        case .xLarge: 14
        case .xxLarge: 15
        case .xxxLarge: 16
        case .accessibility1: 18
        case .accessibility2: 20
        case .accessibility3: 23
        case .accessibility4: 26
        case .accessibility5: 30
        default: 13
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("NEONDIFF")
                    .font(NeonDiffTheme.logoFont)
                    .foregroundStyle(NeonDiffTheme.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Text(title)
                    .font(.system(size: sectionTitleSize, weight: .bold, design: .monospaced))
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                    .accessibilityIdentifier("neondiff-section-title")
            }

            Spacer(minLength: 16)

            HStack(spacing: 8) {
                OperatorBadge(text: "DEV MVP")
                OperatorBadge(text: status, color: NeonDiffTheme.statusColor(status))
            }
        }
        .operatorPanel(padding: 16, active: true)
    }
}

struct OperatorBadge: View {
    var text: String
    var color: Color = NeonDiffTheme.accent

    var body: some View {
        Text(text.uppercased())
            .font(NeonDiffTheme.badgeFont)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                AngularRectangle(corner: 6)
                    .fill(color.opacity(0.10))
            )
            .overlay {
                AngularRectangle(corner: 6)
                    .stroke(color.opacity(0.72), lineWidth: 0.8)
            }
    }
}

struct OperatorSection<Content: View>: View {
    var title: String
    private let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(NeonDiffTheme.headlineFont)
                .foregroundStyle(NeonDiffTheme.accentSoft)
            content
        }
        .operatorPanel()
    }
}

struct OperatorTextField: View {
    var title: String
    @Binding var text: String
    var secure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption)
                .foregroundStyle(NeonDiffTheme.textSecondary)
            field
                .textFieldStyle(.plain)
                .font(.body)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    AngularRectangle(corner: 7)
                        .fill(Color.black.opacity(0.38))
                )
                .overlay {
                    AngularRectangle(corner: 7)
                        .stroke(NeonDiffTheme.stroke.opacity(0.72), lineWidth: 0.7)
                }
        }
    }

    @ViewBuilder
    private var field: some View {
        if secure {
            SecureField(title, text: $text)
        } else {
            TextField(title, text: $text)
        }
    }
}

struct OperatorCommandText: View {
    var text: String
    var lineLimit: Int? = 3
    /// When set, the command text resolves `textSecondary` from the #611 token
    /// palette so it stays legible on tokenized light-mode surfaces. Legacy
    /// callers keep the dark operator color.
    var palette: NDPalette? = nil

    var body: some View {
        Text(text)
            .font(NeonDiffTheme.commandFont)
            .foregroundStyle(palette?.textSecondary ?? NeonDiffTheme.textSecondary)
            .textSelection(.enabled)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PageBottomSentinel: View {
    let section: String

    @ViewBuilder
    var body: some View {
        #if DEBUG
        if HostedEvaluationAccessibility.isActive {
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Bottom of \(section) page")
                .accessibilityIdentifier("neondiff-\(section)-page-bottom")
                .accessibilityRespondsToUserInteraction(false)
                .allowsHitTesting(false)
        }
        #endif
    }
}

#if DEBUG
private enum HostedEvaluationAccessibility {
    static let isActive = ProcessInfo.processInfo.arguments.contains("--ui-testing")
}
#endif

struct OperatorButtonStyle: ButtonStyle {
    var solid = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .foregroundStyle(foreground(isPressed: configuration.isPressed))
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                AngularRectangle(corner: 7)
                    .fill(fill(isPressed: configuration.isPressed))
            )
            .overlay {
                AngularRectangle(corner: 7)
                    .stroke(NeonDiffTheme.accent.opacity(configuration.isPressed ? 0.95 : 0.72), lineWidth: 0.8)
            }
    }

    private func foreground(isPressed: Bool) -> Color {
        if solid { return NeonDiffTheme.chrome }
        return isPressed ? NeonDiffTheme.shell : NeonDiffTheme.accent
    }

    private func fill(isPressed: Bool) -> Color {
        if solid { return NeonDiffTheme.accent.opacity(isPressed ? 0.78 : 1.0) }
        return isPressed ? NeonDiffTheme.accent : NeonDiffTheme.accent.opacity(0.08)
    }
}

private struct CornerTicks: View {
    var color: Color

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            let length: CGFloat = 18

            Path { path in
                path.move(to: CGPoint(x: 0, y: length))
                path.addLine(to: .zero)
                path.addLine(to: CGPoint(x: length, y: 0))

                path.move(to: CGPoint(x: width - length, y: 0))
                path.addLine(to: CGPoint(x: width, y: 0))
                path.addLine(to: CGPoint(x: width, y: length))

                path.move(to: CGPoint(x: width, y: height - length))
                path.addLine(to: CGPoint(x: width, y: height))
                path.addLine(to: CGPoint(x: width - length, y: height))

                path.move(to: CGPoint(x: length, y: height))
                path.addLine(to: CGPoint(x: 0, y: height))
                path.addLine(to: CGPoint(x: 0, y: height - length))
            }
            .stroke(color, lineWidth: 1.1)
        }
        .allowsHitTesting(false)
    }
}

private struct OperatorPanelModifier: ViewModifier {
    var padding: CGFloat
    var active: Bool

    func body(content: Content) -> some View {
        let shape = AngularRectangle(corner: active ? 18 : 12)
        content
            .padding(padding)
            .background {
                shape
                    .fill(active ? NeonDiffTheme.panelActive.opacity(0.88) : NeonDiffTheme.panel.opacity(0.88))
            }
            .overlay {
                shape
                    .stroke(active ? NeonDiffTheme.accent.opacity(0.74) : NeonDiffTheme.stroke.opacity(0.72), lineWidth: active ? 1.1 : 0.8)
            }
            .overlay {
                CornerTicks(color: (active ? NeonDiffTheme.accent : NeonDiffTheme.stroke).opacity(active ? 0.82 : 0.58))
            }
    }
}

extension View {
    func operatorPanel(padding: CGFloat = 16, active: Bool = false) -> some View {
        modifier(OperatorPanelModifier(padding: padding, active: active))
    }

    func operatorBodyText() -> some View {
        foregroundStyle(NeonDiffTheme.textSecondary)
            .font(.body)
    }
}
