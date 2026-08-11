import SwiftUI

/// The saved agents, and the door to adding one.
struct AgentsView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(ServerSettings.self) private var settings
    @State private var adding = false

    var body: some View {
        NavigationStack {
            Group {
                if agents.agents.isEmpty {
                    ContentUnavailableView {
                        Label("No agents yet", systemImage: "circle.hexagongrid")
                    } description: {
                        Text(
                            "An agent is a flow your heddle server can run — "
                                + "a path under its flows root, or a flow you paste in."
                        )
                    } actions: {
                        Button("Add Agent") { adding = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        Section {
                            ForEach(agents.agents) { agent in
                                NavigationLink(value: agent) {
                                    AgentRow(agent: agent)
                                }
                            }
                            .onDelete { agents.remove(atOffsets: $0) }
                        } footer: {
                            ServerStatusFooter()
                        }
                    }
                }
            }
            .navigationTitle("Agents")
            .navigationDestination(for: Agent.self) { agent in
                AgentDetailView(agentID: agent.id)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add", systemImage: "plus") { adding = true }
                }
            }
            .sheet(isPresented: $adding) {
                AddAgentView()
            }
        }
    }
}

private struct AgentRow: View {
    let agent: Agent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(agent.name)
                .font(.headline)
            Text(agent.sourceLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

/// One quiet line about where runs will go, checked when the list appears.
struct ServerStatusFooter: View {
    @Environment(ServerSettings.self) private var settings
    @State private var status: String?

    var body: some View {
        Text(status ?? "Checking \(settings.urlString)…")
            .task(id: settings.urlString) {
                guard let client = settings.client else {
                    status = "The server URL in Settings is not valid."
                    return
                }
                do {
                    let caps = try await client.capabilities()
                    let sessions = caps.sessionsEnabled
                        ? "sessions on" : "sessions off — chat needs --session-store"
                    status = "Connected to heddle-server \(caps.version), \(sessions)."
                } catch {
                    status = "Cannot reach \(settings.urlString) — check Settings."
                }
            }
    }
}
