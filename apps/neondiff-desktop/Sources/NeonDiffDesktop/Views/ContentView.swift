import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct ContentView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController
    let preferredColorScheme: ColorScheme?
    let rootAccessibilityIdentifier: String
    let onSurfaceReady: (() -> Void)?

    init(
        model: NeonDiffDesktopModel,
        updateController: NeonUpdateController,
        preferredColorScheme: ColorScheme? = .dark,
        rootAccessibilityIdentifier: String = "neondiff.desktop.root",
        onSurfaceReady: (() -> Void)? = nil
    ) {
        self.model = model
        self.updateController = updateController
        self.preferredColorScheme = preferredColorScheme
        self.rootAccessibilityIdentifier = rootAccessibilityIdentifier
        self.onSurfaceReady = onSurfaceReady
    }

    var body: some View {
        ZStack(alignment: .top) {
            OperatorBackdrop()
            EvaluationRootAccessibilityMarker(identifier: rootAccessibilityIdentifier)
            Rectangle()
                .fill(NeonDiffTheme.accent)
                .frame(height: 34)
                .shadow(color: NeonDiffTheme.accent.opacity(0.80), radius: 8, y: 1)
                .ignoresSafeArea(.container, edges: .top)

            VStack(spacing: 0) {
                NeonChromeStrip(model: model, updateController: updateController)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("neondiff-chrome")
                    .ignoresSafeArea(.container, edges: .top)

                HStack(spacing: 0) {
                    SidebarView(selection: $model.selectedSection)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("neondiff-sidebar")
                        .frame(width: 230)

                    Rectangle()
                        .fill(NeonDiffTheme.stroke.opacity(0.55))
                        .frame(width: 1)

                    DetailView(
                        model: model,
                        updateController: updateController,
                        onSurfaceReady: model.isOnboardingPresented ? nil : onSurfaceReady
                    )
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("neondiff-detail")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .tint(NeonDiffTheme.accent)
        .buttonStyle(OperatorButtonStyle())
        .preferredColorScheme(preferredColorScheme)
        .sheet(isPresented: $model.isOnboardingPresented) {
            OnboardingWizardView(model: model)
                .frame(minWidth: 760, minHeight: 560)
                .buttonStyle(OperatorButtonStyle())
                .tint(NeonDiffTheme.accent)
                .preferredColorScheme(preferredColorScheme)
                .interactiveDismissDisabled(model.onboardingFlow.currentStep != .done)
                .onAppear { onSurfaceReady?() }
        }
    }
}

private struct EvaluationRootAccessibilityMarker: View {
    let identifier: String

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("NeonDiff Desktop root")
            .accessibilityIdentifier(identifier)
            .allowsHitTesting(false)
    }
}

private struct DetailView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController
    let onSurfaceReady: (() -> Void)?

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                OperatorSectionHeader(title: model.selectedSection.title, status: model.status.healthState)
                    .padding(.horizontal, 22)
                    .padding(.top, 18)
                    .padding(.bottom, 8)

                Group {
                    switch model.selectedSection {
                    case .overview: OverviewView(model: model)
                    case .repos: ReposView(model: model)
                    case .providers: ProviderSettingsView(model: model)
                    case .license: LicenseView(model: model)
                    case .logs: LogsView(model: model)
                    case .policy: PolicyView(model: model)
                    case .settings: SettingsPane(model: model, updateController: updateController)
                    }
                }
                .onAppear { onSurfaceReady?() }
            }
        }
    }
}

private struct NeonChromeStrip: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(NeonDiffTheme.accent)
                .frame(height: 28)
                .shadow(color: NeonDiffTheme.accent.opacity(0.54), radius: 8, y: 1)

            HStack(spacing: 14) {
                Color.clear
                    .frame(width: 78)

                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("NEON")
                        .foregroundStyle(NeonDiffTheme.chrome)
                    Text("DIFF")
                        .foregroundStyle(NeonDiffTheme.shell)
                }
                .font(NeonDiffTheme.displayFont(size: 20))
                .lineLimit(1)
                .minimumScaleFactor(0.75)

                Text("[ DESKTOP OPERATOR ]")
                    .font(NeonDiffTheme.badgeFont)
                    .foregroundStyle(NeonDiffTheme.chrome.opacity(0.76))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)

                Rectangle()
                    .fill(NeonDiffTheme.chrome.opacity(0.45))
                    .frame(width: 1, height: 24)

                OperatorBadge(text: model.status.healthState, color: NeonDiffTheme.statusColor(model.status.healthState))

                Spacer(minLength: 10)

                HStack(spacing: 10) {
                    OperatorBadge(text: updateController.badgeText, color: updateController.isConfigured ? NeonDiffTheme.cyan : NeonDiffTheme.textSecondary)

                    Button {
                        updateController.checkForUpdates()
                    } label: {
                        Label("Check", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(OperatorButtonStyle())
                    .disabled(!updateController.canCheckForUpdates)
                    .help(updateController.statusText)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background {
                    AngularRectangle(corner: 8)
                        .fill(NeonDiffTheme.chrome.opacity(0.92))
                }
            }
            .padding(.trailing, 16)
            .frame(height: 54)
            .background {
                ZStack {
                    NeonDiffTheme.accent
                    ChromeCircuitBackdrop()
                }
            }
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(NeonDiffTheme.chrome.opacity(0.82))
                    .frame(height: 2)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct ChromeCircuitBackdrop: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            path.move(to: CGPoint(x: size.width * 0.62, y: 0))
            path.addLine(to: CGPoint(x: size.width * 0.71, y: size.height))
            path.move(to: CGPoint(x: size.width * 0.80, y: 0))
            path.addLine(to: CGPoint(x: size.width * 0.98, y: size.height))
            context.stroke(path, with: .color(NeonDiffTheme.chrome.opacity(0.20)), lineWidth: 0.8)

            var ticks = Path()
            let spacing: CGFloat = 34
            var x: CGFloat = 0
            while x < size.width {
                ticks.move(to: CGPoint(x: x, y: size.height - 8))
                ticks.addLine(to: CGPoint(x: x + 12, y: size.height - 8))
                x += spacing
            }
            context.stroke(ticks, with: .color(NeonDiffTheme.chrome.opacity(0.18)), lineWidth: 0.7)
        }
        .allowsHitTesting(false)
    }
}
