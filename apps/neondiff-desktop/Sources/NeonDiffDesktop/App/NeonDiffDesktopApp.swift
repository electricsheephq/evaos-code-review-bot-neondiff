import AppKit
import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@main
struct NeonDiffDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model: NeonDiffDesktopModel
    @StateObject private var updateController: NeonUpdateController
#if DEBUG
    private let evaluationContext: DesktopResolvedEvaluationLaunchContext?
    private let evaluationReadinessRequest: DesktopEvaluationReadinessRequest?
    private let evaluationRenderLatch: DesktopEvaluationRenderLatch?
    private let evaluationSurfaceStatus: DesktopEvaluationSurfaceStatus?
#endif

    init() {
#if DEBUG
        let context: DesktopResolvedEvaluationLaunchContext?
        do {
            context = try DesktopResolvedEvaluationLaunch.load(arguments: CommandLine.arguments)
        } catch {
            fatalError("NeonDiff Desktop evaluation launch rejected: \(error.localizedDescription)")
        }
        evaluationContext = context
        let renderLatch = context.map { _ in DesktopEvaluationRenderLatch() }
        evaluationRenderLatch = renderLatch
        evaluationSurfaceStatus = context.map { _ in DesktopEvaluationSurfaceStatus() }
        if let context,
           let renderLatch,
           let outputPath = ProcessInfo.processInfo.environment[
               "NEONDIFF_DESKTOP_EVALUATION_READY_PATH"
           ] {
            do {
                evaluationReadinessRequest = try DesktopEvaluationReadinessRequest(
                    fixtureId: context.fixture.id,
                    outputPath: outputPath,
                    renderLatch: renderLatch
                )
            } catch {
                fatalError("NeonDiff Desktop evaluation readiness rejected: \(error.localizedDescription)")
            }
        } else {
            evaluationReadinessRequest = nil
        }
        let initialModel = context.map(DesktopEvaluationModelAdapter.makeModel(context:))
            ?? NeonDiffDesktopCompositionRoot.makeModel()
        let initialUpdateController = NeonUpdateController()
#else
        let initialModel = NeonDiffDesktopCompositionRoot.makeModel()
        let initialUpdateController = NeonUpdateController()
#endif
        _model = StateObject(wrappedValue: initialModel)
        _updateController = StateObject(wrappedValue: initialUpdateController)
    }

    var body: some Scene {
        WindowGroup("NeonDiff Desktop") {
            contentView
                .frame(
                    minWidth: CGFloat(minimumContentSize.width),
                    minHeight: CGFloat(minimumContentSize.height)
                )
                .environment(\.locale, evaluationLocale)
                .transaction { transaction in
                    if disablesAnimations {
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                }
                .background(
                    windowConfigurator.allowsHitTesting(false)
                )
        }
        .commands {
            CommandMenu("NeonDiff") {
                Button("Open Local Dashboard") {
                    model.openDashboard()
                }
                .keyboardShortcut("d", modifiers: [.command])

                Button("Refresh Status") {
                    model.refreshStatus()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Copy Status Command") {
                    model.copyCommand(model.statusCommand)
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])

                Divider()

                Button("Check for Updates...") {
                    updateController.checkForUpdates()
                }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                .disabled(!updateController.canCheckForUpdates)
            }
        }

        Settings {
            ZStack {
                OperatorBackdrop()
                SettingsPane(model: model, updateController: updateController)
            }
            .buttonStyle(OperatorButtonStyle())
            .tint(NeonDiffTheme.accent)
            .preferredColorScheme(preferredColorScheme)
            .frame(width: 560)
        }
    }

    private var contentView: ContentView {
#if DEBUG
        ContentView(
            model: model,
            updateController: updateController,
            preferredColorScheme: preferredColorScheme,
            rootAccessibilityIdentifier: rootAccessibilityIdentifier,
            enablesEvaluationRegionBindings: evaluationRegionBindingsEnabled,
            onSurfaceReady: evaluationSurfaceReadyAction,
            evaluationSurfaceStatus: evaluationSurfaceStatus
        )
#else
        ContentView(
            model: model,
            updateController: updateController,
            preferredColorScheme: preferredColorScheme,
            rootAccessibilityIdentifier: rootAccessibilityIdentifier,
            enablesEvaluationRegionBindings: evaluationRegionBindingsEnabled,
            onSurfaceReady: evaluationSurfaceReadyAction
        )
#endif
    }

    private var requestedContentSize: NSSize? {
#if DEBUG
        evaluationContext.map {
            $0.contentSize
        }
#else
        nil
#endif
    }

    private var minimumContentSize: DesktopWindowContentSize {
#if DEBUG
        DesktopWindowGeometryPolicy.minimumContentSize(
            requested: evaluationContext.map {
                DesktopWindowContentSize(width: $0.contentSize.width, height: $0.contentSize.height)
            }
        )
#else
        DesktopWindowGeometryPolicy.minimumContentSize(requested: nil)
#endif
    }

    private var preferredColorScheme: ColorScheme? {
#if DEBUG
        switch evaluationContext?.fixture.environment.appearance {
        case .light: .light
        case .system: nil
        case .dark, nil: .dark
        }
#else
        .dark
#endif
    }

    private var evaluationLocale: Locale {
#if DEBUG
        evaluationContext.map { Locale(identifier: $0.fixture.environment.locale) } ?? .current
#else
        .current
#endif
    }

    private var disablesAnimations: Bool {
#if DEBUG
        evaluationContext?.disableAnimations == true
#else
        false
#endif
    }

    private var windowConfigurator: NeonWindowConfigurator {
#if DEBUG
        NeonWindowConfigurator(
            requestedContentSize: requestedContentSize,
            disablesAnimations: disablesAnimations,
            readinessRequest: evaluationReadinessRequest,
            evaluationSection: evaluationContext == nil ? nil : model.selectedSection,
            surfaceStatus: evaluationSurfaceStatus
        )
#else
        NeonWindowConfigurator(
            requestedContentSize: requestedContentSize,
            disablesAnimations: disablesAnimations
        )
#endif
    }

    private var rootAccessibilityIdentifier: String {
#if DEBUG
        evaluationContext.map { "neondiff.fixture.\($0.fixture.id)" }
            ?? "neondiff.desktop.root"
#else
        "neondiff.desktop.root"
#endif
    }

    private var evaluationRegionBindingsEnabled: Bool {
#if DEBUG
        evaluationContext != nil
#else
        false
#endif
    }

    private var evaluationSurfaceReadyAction: ((DesktopSection) -> Void)? {
#if DEBUG
        evaluationRenderLatch.map { latch in
            { section in
                latch.markReady()
                evaluationSurfaceStatus?.markRendered(section: section)
            }
        }
#else
        nil
#endif
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldRestoreSecureApplicationState(_ app: NSApplication) -> Bool {
#if DEBUG
        if CommandLine.arguments.contains("--ui-testing") { return false }
#endif
        return true
    }

    func applicationShouldSaveSecureApplicationState(_ app: NSApplication) -> Bool {
#if DEBUG
        if CommandLine.arguments.contains("--ui-testing") { return false }
#endif
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
#if DEBUG
        if CommandLine.arguments.contains("--ui-testing") {
            openEvaluationWindowIfNeeded(remainingAttempts: 20)
        }
#endif
    }

#if DEBUG
    private func openEvaluationWindowIfNeeded(remainingAttempts: Int) {
        guard NSApp.windows.isEmpty else { return }
        if let menu = NSApp.mainMenu,
           let item = allMenuItems(in: menu).first(where: {
            $0.keyEquivalent == "n" && $0.keyEquivalentModifierMask.contains(.command)
           }), let action = item.action {
            NSApp.sendAction(action, to: item.target, from: item)
        }
        guard NSApp.windows.isEmpty else { return }
        guard remainingAttempts > 1 else {
            NSLog(
                "NeonDiff Desktop evaluation: failed to open a window through the Cmd+N menu action after exhausting retries"
            )
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.openEvaluationWindowIfNeeded(remainingAttempts: remainingAttempts - 1)
        }
    }

    private func allMenuItems(in menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item in
            [item] + (item.submenu.map(allMenuItems(in:)) ?? [])
        }
    }
#endif
}
