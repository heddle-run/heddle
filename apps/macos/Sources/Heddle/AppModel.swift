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
        notifier.onAction = { [weak self] runID, verdict in
            self?.notificationActed(runID, verdict)
        }
    }

    private func notificationActed(_ runID: UUID, _ verdict: NotificationVerdict) {
        guard let record = runs.runs.first(where: { $0.id == runID }) else { return }

        switch verdict {
        case .approve where record.suspension != nil:
            runs.answer(record, with: .object(["approved": .bool(true)]))
        case .deny where record.suspension != nil:
            runs.answer(record, with: .object(["approved": .bool(false)]))
        default:
            WindowPresenter.shared.showRun(record.id, agents: agents, runs: runs)
        }
    }

    /// The click policy, shared by the menu and Finder opens.
    ///
    /// An `interactive` bundle opens its conversation — that is what the
    /// author recorded the flag to mean. Otherwise: a bundle recording input
    /// (or a bare flow, whose needs nobody recorded) gets the form, as does
    /// anything whose declared requirements do not hold — the form is where
    /// the asking happens. Everything else runs on the click itself.
    func launch(_ agent: Agent) {
        let unmet = Preflight.check(agent.requires).contains { !$0.holds }

        if agent.interactive && !unmet {
            WindowPresenter.shared.showChat(for: agent, agents: agents, runs: runs)
            return
        }

        if agent.defaultInput?.isEmpty == false || agent.kind == .flow || unmet {
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

    /// A `heddle://` URL — Shortcuts, Raycast, a script.
    ///
    /// The named agent must already be in the menu: a URL is a remote
    /// control, not an installer, and letting one name an arbitrary path
    /// would make every web page a launcher for whatever it likes.
    func openURL(_ url: URL) {
        guard case .run(let name, let input)? = AppURL.parse(url) else {
            complain("Nothing handles \(url.absoluteString)")
            return
        }

        guard let agent = agents.agents.first(where: {
            $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame
        }) else {
            complain("No agent named \"\(name)\" in the agents folder")
            return
        }

        if let input {
            let record = runs.start(agent: agent, input: input)
            WindowPresenter.shared.showRun(record.id, agents: agents, runs: runs)
        } else {
            launch(agent)
        }
    }

    private func complain(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Heddle"
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.notifier.requestAuthorization()
    }

    /// Both arrivals land here: file opens and `heddle://` URLs.
    func application(_ application: NSApplication, open urls: [URL]) {
        let (schemed, files) = urls.reduce(into: ([URL](), [URL]())) { split, url in
            if url.scheme?.lowercased() == AppURL.scheme {
                split.0.append(url)
            } else {
                split.1.append(url)
            }
        }
        AppModel.shared.openFiles(files)
        for url in schemed {
            AppModel.shared.openURL(url)
        }
    }
}
