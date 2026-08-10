import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The whole product, as a menu.
struct MenuContent: View {
    @Environment(AgentStore.self) private var agents
    @Environment(RunStore.self) private var runs

    var body: some View {
        agentSection
        Divider()
        activitySection
        Divider()
        Button("Add Agent…", action: addAgent)
        Button("Open Agents Folder") {
            NSWorkspace.shared.open(agents.directory)
        }
        Button("Sessions…") {
            WindowPresenter.shared.showSessions()
        }
        SettingsLink {
            Text("Settings…")
        }
        Divider()
        Button("Quit Heddle") {
            runs.cancelAll()
            NSApp.terminate(nil)
        }
    }

    @ViewBuilder
    private var agentSection: some View {
        if agents.agents.isEmpty {
            Text("No agents yet — drop a .heddle file in the agents folder")
        } else {
            ForEach(agents.agents) { agent in
                Button(agent.name) { AppModel.shared.launch(agent) }
            }
        }
    }

    @ViewBuilder
    private var activitySection: some View {
        ForEach(runs.needingAnswer) { run in
            Button("⚠️ \(run.agentName) — needs your answer") { open(run) }
        }
        ForEach(runs.running) { run in
            Button("⏳ \(run.agentName)") { open(run) }
        }
        if !runs.finished.isEmpty {
            Menu("Recent Runs") {
                ForEach(runs.finished.prefix(10)) { run in
                    Button("\(marker(for: run)) \(run.agentName)") { open(run) }
                }
            }
        }
    }

    private func open(_ run: RunRecord) {
        WindowPresenter.shared.showRun(run.id, agents: agents, runs: runs)
    }

    private func marker(for run: RunRecord) -> String {
        switch run.status {
        case .running: return "⏳"
        case .succeeded: return "✓"
        case .failed: return "✕"
        case .suspended: return "⚠️"
        }
    }

    private func addAgent() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [
            UTType(filenameExtension: "heddle") ?? .data,
            .json,
            .yaml,
        ]
        panel.allowsMultipleSelection = true
        panel.message = "Choose a .heddle bundle or flow file to add"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            try? agents.install(from: url)
        }
    }
}
