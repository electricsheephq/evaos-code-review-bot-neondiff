import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct ContentView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController
    let preferredColorScheme: ColorScheme?
    let rootAccessibilityIdentifier: String
    let enablesEvaluationRegionBindings: Bool
    let onSurfaceReady: ((DesktopSection) -> Void)?
#if DEBUG
    let evaluationSurfaceStatus: DesktopEvaluationSurfaceStatus?
#endif

#if DEBUG
    init(
        model: NeonDiffDesktopModel,
        updateController: NeonUpdateController,
        preferredColorScheme: ColorScheme? = .dark,
        rootAccessibilityIdentifier: String = "neondiff.desktop.root",
        enablesEvaluationRegionBindings: Bool = false,
        onSurfaceReady: ((DesktopSection) -> Void)? = nil,
        evaluationSurfaceStatus: DesktopEvaluationSurfaceStatus? = nil
    ) {
        self.model = model
        self.updateController = updateController
        self.preferredColorScheme = preferredColorScheme
        self.rootAccessibilityIdentifier = rootAccessibilityIdentifier
        self.enablesEvaluationRegionBindings = enablesEvaluationRegionBindings
        self.onSurfaceReady = onSurfaceReady
        self.evaluationSurfaceStatus = evaluationSurfaceStatus
    }
#else
    init(
        model: NeonDiffDesktopModel,
        updateController: NeonUpdateController,
        preferredColorScheme: ColorScheme? = .dark,
        rootAccessibilityIdentifier: String = "neondiff.desktop.root",
        enablesEvaluationRegionBindings: Bool = false,
        onSurfaceReady: ((DesktopSection) -> Void)? = nil
    ) {
        self.model = model
        self.updateController = updateController
        self.preferredColorScheme = preferredColorScheme
        self.rootAccessibilityIdentifier = rootAccessibilityIdentifier
        self.enablesEvaluationRegionBindings = enablesEvaluationRegionBindings
        self.onSurfaceReady = onSurfaceReady
    }
#endif

    var body: some View {
#if DEBUG
        if let evaluationSurfaceStatus {
            EvaluationRegionFrameCollector(status: evaluationSurfaceStatus) { generation in
                content(evaluationSurfaceGeneration: generation)
            }
        } else {
            content(evaluationSurfaceGeneration: nil)
        }
#else
        content(evaluationSurfaceGeneration: nil)
#endif
    }

    private func content(evaluationSurfaceGeneration: Int?) -> some View {
        ZStack(alignment: .top) {
            OperatorBackdrop()
            EvaluationRootAccessibilityMarker(identifier: rootAccessibilityIdentifier)
#if DEBUG
            if let evaluationSurfaceStatus {
                EvaluationSurfaceAccessibilityMarker(status: evaluationSurfaceStatus)
            }
#endif
            Rectangle()
                .fill(NeonDiffTheme.accent)
                .frame(height: 34)
                .shadow(color: NeonDiffTheme.accent.opacity(0.80), radius: 8, y: 1)
                .ignoresSafeArea(.container, edges: .top)

            VStack(spacing: 0) {
                NeonChromeStrip(model: model, updateController: updateController)
                    .ignoresSafeArea(.container, edges: .top)
                    .evaluationAccessibilityRegion(
                        "neondiff-chrome",
                        enabled: enablesEvaluationRegionBindings,
                        generation: evaluationSurfaceGeneration
                    )

                HStack(spacing: 0) {
                    SidebarView(selection: $model.selectedSection)
                        .frame(width: 230)
                        .evaluationAccessibilityRegion(
                            "neondiff-sidebar",
                            enabled: enablesEvaluationRegionBindings,
                            generation: evaluationSurfaceGeneration
                        )

                    Rectangle()
                        .fill(NeonDiffTheme.stroke.opacity(0.55))
                        .frame(width: 1)

                    DetailView(
                        model: model,
                        updateController: updateController,
                        onSurfaceReady: model.isOnboardingPresented ? nil : onSurfaceReady
                    )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .evaluationAccessibilityRegion(
                            "neondiff-detail",
                            enabled: enablesEvaluationRegionBindings,
                            generation: evaluationSurfaceGeneration
                        )
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
                .onAppear { onSurfaceReady?(model.selectedSection) }
        }
    }
}

private extension View {
    @ViewBuilder
    func evaluationAccessibilityRegion(
        _ identifier: String,
        enabled: Bool,
        generation: Int?
    ) -> some View {
        if enabled {
            accessibilityElement(children: .contain)
                .accessibilityIdentifier(identifier)
#if DEBUG
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: EvaluationRegionFramesPreferenceKey.self,
                            value: generation.map {
                                [
                                    identifier: EvaluationRegionFramePreference(
                                        generation: $0,
                                        frame: proxy.frame(in: .global)
                                    )
                                ]
                            } ?? [:]
                        )
                    }
                }
#endif
        } else {
            self
        }
    }
}

#if DEBUG
private struct EvaluationRegionFrameCollector<Content: View>: View {
    @ObservedObject var status: DesktopEvaluationSurfaceStatus
    let content: (Int?) -> Content

    init(
        status: DesktopEvaluationSurfaceStatus,
        @ViewBuilder content: @escaping (Int?) -> Content
    ) {
        self.status = status
        self.content = content
    }

    var body: some View {
        content(status.snapshot?.generation)
            .onPreferenceChange(EvaluationRegionFramesPreferenceKey.self) { frames in
                guard let generation = status.snapshot?.generation else {
                    return
                }
                let generations = Set(frames.values.map(\.generation))
                guard generations == Set([generation]) else {
                    status.updateRegionFrames([:], generation: generation)
                    return
                }
                status.updateRegionFrames(
                    frames.mapValues(\.frame),
                    generation: generation
                )
            }
    }
}

private struct EvaluationRegionFramesPreferenceKey: PreferenceKey {
    static let defaultValue: [String: EvaluationRegionFramePreference] = [:]

    static func reduce(
        value: inout [String: EvaluationRegionFramePreference],
        nextValue: () -> [String: EvaluationRegionFramePreference]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct EvaluationRegionFramePreference: Equatable {
    let generation: Int
    let frame: CGRect
}
#endif

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

#if DEBUG
private struct EvaluationSurfaceAccessibilityMarker: View {
    @ObservedObject var status: DesktopEvaluationSurfaceStatus

    var body: some View {
        ZStack {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("NeonDiff Desktop evaluation surface state")
                .accessibilityIdentifier(status.accessibilityIdentifier)
                .accessibilityValue(status.geometryAccessibilityValue)
                .allowsHitTesting(false)
            ForEach(status.geometryAccessibilityChunks) { chunk in
                EvaluationSurfaceGeometryChunkMarker(chunk: chunk)
            }
        }
        .frame(width: 1, height: 1)
        .allowsHitTesting(false)
    }
}

private struct EvaluationSurfaceGeometryChunkMarker: View {
    let chunk: DesktopHostedGeometryAccessibilityChunk

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("NeonDiff Desktop evaluation geometry chunk")
            .accessibilityIdentifier(chunk.identifier)
            .accessibilityValue(chunk.value)
            .allowsHitTesting(false)
    }
}
#endif

private struct DetailView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController
    let onSurfaceReady: ((DesktopSection) -> Void)?

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
                .modifier(
                    SurfaceIdentityModifier(
                        section: model.selectedSection,
                        enabled: onSurfaceReady != nil
                    )
                )
                .onAppear { onSurfaceReady?(model.selectedSection) }
            }
        }
    }
}

private struct SurfaceIdentityModifier: ViewModifier {
    let section: DesktopSection
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.id(section)
        } else {
            content
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
