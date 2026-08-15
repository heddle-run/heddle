import AppKit
import SwiftUI

@main
struct HeddleApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    private let model = AppModel.shared

    init() {
        // The .app bundle declares LSUIElement; under a bare `swift run`
        // nothing does, so claim accessory status here too — a menu bar app
        // has no dock tile either way. Through `shared`, not `NSApp`: during
        // App.init the application object may not exist yet, and `NSApp` is
        // an implicitly unwrapped nil then — `shared` creates it instead.
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent()
                .environment(model.agents)
                .environment(model.runs)
        } label: {
            Image(systemName: model.runs.running.isEmpty
                ? "point.3.connected.trianglepath.dotted"
                : "point.3.filled.connected.trianglepath.dotted")
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView()
                .environment(model.agents)
        }
    }
}
