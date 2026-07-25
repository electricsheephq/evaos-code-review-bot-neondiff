import AppKit
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
    let appearanceLabel: String
    let appearanceToggleAvailable: Bool
    let toggleAppearance: () -> Void
    @Environment(\.colorScheme) private var colorScheme
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
        appearanceLabel: String = "DARK",
        appearanceToggleAvailable: Bool = true,
        toggleAppearance: @escaping () -> Void = {},
        evaluationSurfaceStatus: DesktopEvaluationSurfaceStatus? = nil
    ) {
        self.model = model
        self.updateController = updateController
        self.preferredColorScheme = preferredColorScheme
        self.rootAccessibilityIdentifier = rootAccessibilityIdentifier
        self.enablesEvaluationRegionBindings = enablesEvaluationRegionBindings
        self.onSurfaceReady = onSurfaceReady
        self.appearanceLabel = appearanceLabel
        self.appearanceToggleAvailable = appearanceToggleAvailable
        self.toggleAppearance = toggleAppearance
        self.evaluationSurfaceStatus = evaluationSurfaceStatus
    }
#else
    init(
        model: NeonDiffDesktopModel,
        updateController: NeonUpdateController,
        preferredColorScheme: ColorScheme? = .dark,
        rootAccessibilityIdentifier: String = "neondiff.desktop.root",
        enablesEvaluationRegionBindings: Bool = false,
        onSurfaceReady: ((DesktopSection) -> Void)? = nil,
        appearanceLabel: String = "DARK",
        appearanceToggleAvailable: Bool = true,
        toggleAppearance: @escaping () -> Void = {}
    ) {
        self.model = model
        self.updateController = updateController
        self.preferredColorScheme = preferredColorScheme
        self.rootAccessibilityIdentifier = rootAccessibilityIdentifier
        self.enablesEvaluationRegionBindings = enablesEvaluationRegionBindings
        self.onSurfaceReady = onSurfaceReady
        self.appearanceLabel = appearanceLabel
        self.appearanceToggleAvailable = appearanceToggleAvailable
        self.toggleAppearance = toggleAppearance
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
#if DEBUG
        let shell = ReferenceShellLayout(
            model: model,
            updateController: updateController,
            evaluationSurfaceGeneration: evaluationSurfaceGeneration,
            rootAccessibilityIdentifier: rootAccessibilityIdentifier,
            enablesEvaluationRegionBindings: enablesEvaluationRegionBindings,
            onSurfaceReady: onSurfaceReady,
            appearanceLabel: appearanceLabel,
            appearanceToggleAvailable: appearanceToggleAvailable,
            toggleAppearance: toggleAppearance,
            evaluationSurfaceStatus: evaluationSurfaceStatus
        )
#else
        let shell = ReferenceShellLayout(
            model: model,
            updateController: updateController,
            evaluationSurfaceGeneration: evaluationSurfaceGeneration,
            rootAccessibilityIdentifier: rootAccessibilityIdentifier,
            enablesEvaluationRegionBindings: enablesEvaluationRegionBindings,
            onSurfaceReady: onSurfaceReady,
            appearanceLabel: appearanceLabel,
            appearanceToggleAvailable: appearanceToggleAvailable,
            toggleAppearance: toggleAppearance
        )
#endif
        return shell
        .tint(NDPalette(scheme: colorScheme).accentPrimary)
        .buttonStyle(OperatorButtonStyle())
        .preferredColorScheme(preferredColorScheme)
        .onExitCommand {
            model.dismissOnboardingPanel()
        }
    }
}

private struct ReferenceShellLayout: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController
    let evaluationSurfaceGeneration: Int?
    let rootAccessibilityIdentifier: String
    let enablesEvaluationRegionBindings: Bool
    let onSurfaceReady: ((DesktopSection) -> Void)?
    let appearanceLabel: String
    let appearanceToggleAvailable: Bool
    let toggleAppearance: () -> Void
    @Environment(\.colorScheme) private var colorScheme
#if DEBUG
    let evaluationSurfaceStatus: DesktopEvaluationSurfaceStatus?
#endif

    var body: some View {
        GeometryReader { proxy in
            let compactSetup = proxy.size.width < 900
            let setupWidth = min(430, max(360, proxy.size.width * 0.34))
            let compactSetupHeight = max(
                0,
                proxy.size.height - ReferenceChromeStrip.height
            )
            let reservedSetupWidth =
                model.isOnboardingPresented && !compactSetup ? setupWidth : 0
            let setupShadowColor = colorScheme == .dark
                ? Color.black.opacity(0.72)
                : Color.black.opacity(0.16)

            ZStack(alignment: .trailing) {
                OperatorBackdrop()
                EvaluationRootAccessibilityMarker(identifier: rootAccessibilityIdentifier)
#if DEBUG
                if let evaluationSurfaceStatus {
                    EvaluationSurfaceAccessibilityMarker(status: evaluationSurfaceStatus)
                }
#endif

                VStack(spacing: 0) {
                    ReferenceChromeStrip(
                        appearanceLabel: appearanceLabel,
                        appearanceToggleAvailable: appearanceToggleAvailable,
                        toggleAppearance: toggleAppearance
                    )
                    .evaluationAccessibilityRegion(
                        "neondiff-chrome",
                        enabled: enablesEvaluationRegionBindings,
                        generation: evaluationSurfaceGeneration
                    )

                    HStack(spacing: 0) {
                        SidebarView(
                            selection: $model.selectedSection,
                            readiness: DesktopSetupReadiness(model: model)
                        )
                            .frame(width: proxy.size.width < 980 ? 204 : 242)
                        .evaluationAccessibilityRegion(
                            "neondiff-sidebar",
                            enabled: enablesEvaluationRegionBindings,
                            generation: evaluationSurfaceGeneration
                        )

                        Rectangle()
                            .fill(NeonDiffTheme.stroke.opacity(0.34))
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
                .padding(.trailing, reservedSetupWidth)

                if model.isOnboardingPresented {
                    if compactSetup {
                        Color.black.opacity(0.52)
                            .ignoresSafeArea()
                            .allowsHitTesting(false)
                    }

                    OnboardingWizardView(model: model)
                        .frame(
                            width: compactSetup ? proxy.size.width : setupWidth,
                            height: compactSetup ? compactSetupHeight : proxy.size.height
                        )
                        .background(NeonDiffTheme.chrome)
                        .shadow(color: setupShadowColor, radius: 24, x: -8)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                        .onAppear { onSurfaceReady?(model.selectedSection) }
                }
            }
            .animation(.easeOut(duration: 0.18), value: model.isOnboardingPresented)
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
                switch GenerationBoundRegionFrameRouting.route(
                    currentGeneration: generation,
                    observedGenerations: generations,
                    framesAreEmpty: frames.isEmpty
                ) {
                case let .replace(observedGeneration):
                    status.updateRegionFrames(
                        frames.mapValues(\.frame),
                        generation: observedGeneration
                    )
                case let .invalidate(currentGeneration):
                    status.updateRegionFrames([:], generation: currentGeneration)
                case .ignore:
                    break
                }
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
                .accessibilityLabel(status.geometryAccessibilityManifest)
                .accessibilityIdentifier(status.accessibilityIdentifier)
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
            .accessibilityLabel(chunk.label)
            .accessibilityIdentifier(chunk.identifier)
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
                OperatorSectionHeader(
                    title: model.selectedSection.title,
                    status: model.isOnboardingPresented ? "SETUP REQUIRED" : model.status.healthState
                )
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
                .onAppear { onSurfaceReady?(model.selectedSection) }
                .modifier(
                    SurfaceIdentityModifier(
                        section: model.selectedSection,
                        enabled: onSurfaceReady != nil
                    )
                )
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

private struct ReferenceChromeStrip: View {
    static let height: CGFloat = 48

    let appearanceLabel: String
    let appearanceToggleAvailable: Bool
    let toggleAppearance: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)

        HStack(spacing: 14) {
            Color.clear
                .frame(width: 120, height: 1)

            Spacer()

            Button(action: toggleAppearance) {
                HStack(spacing: 6) {
                    Image(systemName: appearanceLabel == "LIGHT" ? "sun.max" : "moon")
                    Text("[\(appearanceLabel)]")
                }
                .font(NeonDiffTheme.badgeFont)
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.accentPrimary)
            .disabled(!appearanceToggleAvailable)
            .help("Switch the NeonDiff appearance.")
            .accessibilityLabel("Switch to \(appearanceLabel == "LIGHT" ? "dark" : "light") mode")
            .accessibilityIdentifier("neondiff-appearance-toggle")
        }
        .overlay {
            NDBrandWordmark(size: 18)
                .allowsHitTesting(false)
        }
        .padding(.leading, 258)
        .padding(.trailing, 18)
        .frame(height: ReferenceChromeStrip.height)
        .background(palette.background)
        .background {
            WindowDragRegion()
                .accessibilityHidden(true)
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(palette.interfaceBorder)
                .frame(height: 1)
        }
    }
}

private struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        WindowDragNSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private final class WindowDragNSView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
