import AppKit
import SwiftUI
import NeonDiffDesktopCore

@main
struct NeonDiffDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = NeonDiffDesktopModel()

    var body: some Scene {
        WindowGroup("NeonDiff Desktop") {
            ContentView(model: model)
                .frame(minWidth: 1040, minHeight: 680)
        }
        .commands {
            CommandMenu("NeonDiff") {
                Button("Refresh Status") {
                    model.refreshStatus()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Copy Status Command") {
                    model.copyCommand(model.statusCommand)
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
            }
        }

        Settings {
            SettingsPane(model: model)
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
