import AppKit
import Foundation

/// The one object graph, reachable from every entry point.
///
/// The SwiftUI scene, the app delegate's file-open callback, and the window
/// presenter all act on the same stores; a singleton is the honest shape of
/// that, and `@State` in the `App` would hide it without changing it.
@MainActor
final class AppModel {
    static let shared = AppModel()

    let agents = AgentStore()
    let runs = RunStore()
    let notifier = Notifier()

    private init() {
        runs.onFinish = { [notifier] run in notifier.runFinished(run) }
    }

    /// The click policy, shared by the menu and Finder opens: a bundle
    /// recording input (or a bare flow, whose needs nobody recorded) gets
    /// the form, as does anything whose declared requirements do not hold —
    /// the form is where the asking happens. Everything else runs on the
    /// click itself.
    func launch(_ agent: Agent) {
        let needsForm =
            agent.defaultInput?.isEmpty == false
            || agent.kind == .flow
            || Preflight.check(agent.requires).contains { !$0.holds }

        if needsForm {
            WindowPresenter.shared.showLaunch(for: agent, agents: agents, runs: runs)
        } else {
            let record = runs.start(agent: agent)
            WindowPresenter.shared.showRun(record.id, agents: agents, runs: runs)
        }
    }

    /// A `.heddle` (or flow file) arriving from outside — double-click,
    /// drag to the Dock icon, `open -a Heddle x.heddle`. Nothing is copied;
    /// the file runs where it lies.
    func openFiles(_ urls: [URL]) {
        for url in urls {
            guard let agent = agents.adoptExternal(url) else { continue }
            launch(agent)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.notifier.requestAuthorization()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        AppModel.shared.openFiles(urls)
    }
}
