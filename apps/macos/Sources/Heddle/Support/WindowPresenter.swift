import AppKit
import SwiftUI

/// Windows, presented the AppKit way.
///
/// A menu bar app has no reliable SwiftUI path from "a file was
/// double-clicked" to "a `WindowGroup` scene opened": the delegate callback
/// owns the event and `openWindow` lives only inside views. Hosting the
/// SwiftUI views in plain `NSWindow`s keeps one door for every caller — menu
/// items, the app delegate, tests — at the cost of managing the windows
/// ourselves, which for two window kinds is this file.
@MainActor
final class WindowPresenter {
    static let shared = WindowPresenter()

    /// One window per identity: presenting the same run twice fronts the
    /// existing window rather than stacking a duplicate.
    private var windows: [String: NSWindow] = [:]

    func showRun(_ runID: UUID, agents: AgentStore, runs: RunStore) {
        show(
            id: "run-\(runID.uuidString)",
            title: runs.runs.first { $0.id == runID }?.agentName ?? "Run",
            size: NSSize(width: 520, height: 420)
        ) {
            RunDetailView(runID: runID)
                .environment(agents)
                .environment(runs)
        }
    }

    func showLaunch(for agent: Agent, agents: AgentStore, runs: RunStore) {
        show(
            id: "launch-\(agent.id)",
            title: agent.name,
            size: NSSize(width: 460, height: 240)
        ) {
            LaunchView(agentID: agent.id) { [weak self] record in
                self?.close(id: "launch-\(agent.id)")
                self?.showRun(record.id, agents: agents, runs: runs)
            }
            .environment(agents)
            .environment(runs)
        }
    }

    private func show(
        id: String,
        title: String,
        size: NSSize,
        @ViewBuilder content: () -> some View
    ) {
        if let existing = windows[id] {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(contentViewController: NSHostingController(rootView: content()))
        window.title = title
        window.setContentSize(size)
        window.styleMask = [.titled, .closable, .resizable]
        window.isReleasedWhenClosed = false
        window.center()

        windows[id] = window
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.windows[id] = nil }
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func close(id: String) {
        windows[id]?.close()
        windows[id] = nil
    }
}
