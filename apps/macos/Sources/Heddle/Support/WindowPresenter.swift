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

    /// Conversations outlive their windows: closing a chat and clicking the
    /// agent again continues where it left off, for the app's lifetime. The
    /// session on disk is what makes that cheap to honour.
    private var chats: [String: ChatController] = [:]

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
            LaunchView(agentID: agent.id) { [weak self] outcome in
                self?.close(id: "launch-\(agent.id)")
                switch outcome {
                case .run(let record):
                    self?.showRun(record.id, agents: agents, runs: runs)
                case .chat(let agent):
                    self?.showChat(for: agent, agents: agents, runs: runs)
                }
            }
            .environment(agents)
            .environment(runs)
        }
    }

    func showChat(for agent: Agent, agents: AgentStore, runs: RunStore) {
        let controller = chats[agent.id] ?? ChatController(agent: agent, runs: runs)
        chats[agent.id] = controller

        show(
            id: "chat-\(agent.id)",
            title: agent.name,
            size: NSSize(width: 480, height: 440)
        ) {
            ChatView(controller: controller)
                .environment(agents)
                .environment(runs)
        }
    }

    func showAddByURL(agents: AgentStore, runs: RunStore) {
        show(
            id: "add-by-url",
            title: "Add Agent from URL",
            size: NSSize(width: 460, height: 140)
        ) {
            AddAgentView { [weak self] _ in
                self?.close(id: "add-by-url")
            }
            .environment(agents)
            .environment(runs)
        }
    }

    func showSessions() {
        show(
            id: "sessions",
            title: "Sessions",
            size: NSSize(width: 560, height: 400)
        ) {
            SessionsView()
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
