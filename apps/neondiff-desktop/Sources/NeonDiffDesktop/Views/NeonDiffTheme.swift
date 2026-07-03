import SwiftUI

enum NeonDiffTheme {
    static let shell = Color(red: 0.015, green: 0.018, blue: 0.016)
    static let sidebar = Color(red: 0.025, green: 0.032, blue: 0.028)
    static let panel = Color(red: 0.035, green: 0.052, blue: 0.043)
    static let panelActive = Color(red: 0.05, green: 0.095, blue: 0.065)
    static let panelRaised = Color(red: 0.055, green: 0.071, blue: 0.061)
    static let accent = Color(red: 0.22, green: 1.0, blue: 0.12)
    static let accentSoft = Color(red: 0.50, green: 1.0, blue: 0.42)
    static let textPrimary = Color(red: 0.91, green: 0.98, blue: 0.91)
    static let textSecondary = Color(red: 0.56, green: 0.70, blue: 0.57)
    static let stroke = Color(red: 0.16, green: 0.55, blue: 0.18)
    static let warning = Color(red: 1.0, green: 0.34, blue: 0.30)

    static let logoFont = Font.system(size: 24, weight: .black, design: .monospaced)
    static let headlineFont = Font.system(.headline, design: .monospaced).weight(.bold)
    static let badgeFont = Font.system(.caption, design: .monospaced).weight(.bold)
    static let commandFont = Font.system(.caption, design: .monospaced)

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
    var title: String
    var status: String

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("NEONDIFF")
                    .font(NeonDiffTheme.logoFont)
                    .foregroundStyle(NeonDiffTheme.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Text(title)
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
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

    var body: some View {
        Text(text)
            .font(NeonDiffTheme.commandFont)
            .foregroundStyle(NeonDiffTheme.textSecondary)
            .textSelection(.enabled)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct OperatorButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .foregroundStyle(configuration.isPressed ? NeonDiffTheme.shell : NeonDiffTheme.accent)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                AngularRectangle(corner: 7)
                    .fill(configuration.isPressed ? NeonDiffTheme.accent : NeonDiffTheme.accent.opacity(0.08))
            )
            .overlay {
                AngularRectangle(corner: 7)
                    .stroke(NeonDiffTheme.accent.opacity(configuration.isPressed ? 0.95 : 0.68), lineWidth: 0.8)
            }
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
