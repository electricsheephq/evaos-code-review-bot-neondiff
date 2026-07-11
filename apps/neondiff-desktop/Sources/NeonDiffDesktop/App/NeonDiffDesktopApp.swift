import AppKit
import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@main
struct NeonDiffDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model: NeonDiffDesktopModel
    @StateObject private var updateController = NeonUpdateController()

    init() {
        _model = StateObject(wrappedValue: NeonDiffDesktopCompositionRoot.makeModel())
    }

    var body: some Scene {
        WindowGroup("NeonDiff Desktop") {
            ContentView(model: model, updateController: updateController)
                .frame(minWidth: 1040, minHeight: 680)
                .background(NeonWindowConfigurator().allowsHitTesting(false))
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
            .preferredColorScheme(.dark)
            .frame(width: 560)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
