import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// Declared in project.yml as an imported type over `public.data` — a
    /// `.heddle` is a gzipped tar, but an archive UTI would invite the
    /// system to unpack it rather than open it.
    static var heddleBundle: UTType {
        UTType("run.heddle.bundle") ?? UTType(filenameExtension: "heddle") ?? .data
    }
}

/// The saved agents, and the two doors to adding one: name a server flow,
/// or import a `.heddle` bundle.
struct AgentsView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(ServerSettings.self) private var settings
    @State private var adding = false
    @State private var picking = false
    @State private var importing: ImportRequest?

    var body: some View {
        NavigationStack {
            Group {
                if agents.agents.isEmpty {
                    ContentUnavailableView {
                        Label("No agents yet", systemImage: "circle.hexagongrid")
                    } description: {
                        Text(
                            "An agent is a .heddle bundle you import, or a "
                                + "flow your heddle server can run."
                        )
                    } actions: {
                        Button("Import Bundle") { picking = true }
                            .buttonStyle(.borderedProminent)
                        Button("Add Server Flow") { adding = true }
                    }
                } else {
                    List {
                        Section {
                            ForEach(agents.agents) { agent in
                                NavigationLink(value: agent) {
                                    AgentRow(agent: agent)
                                }
                            }
                            .onDelete { remove(atOffsets: $0) }
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
                    Menu {
                        Button("Import Bundle…", systemImage: "shippingbox") {
                            picking = true
                        }
                        Button("Add Server Flow…", systemImage: "server.rack") {
                            adding = true
                        }
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                }
            }
            .sheet(isPresented: $adding) {
                AddAgentView()
            }
            .sheet(item: $importing) { request in
                ImportBundleView(url: request.url)
            }
            .fileImporter(
                isPresented: $picking,
                allowedContentTypes: [.heddleBundle]
            ) { result in
                if case .success(let url) = result {
                    importing = ImportRequest(url: url)
                }
            }
        }
    }

    /// A bundle agent owns a directory beside this list; deleting the row
    /// deletes both.
    private func remove(atOffsets offsets: IndexSet) {
        let removed = agents.remove(atOffsets: offsets)
        let bundles = BundleStore()
        for agent in removed {
            try? bundles.remove(agent: agent)
        }
    }
}

private struct AgentRow: View {
    let agent: Agent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(agent.name)
                .font(.headline)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var subtitle: String {
        if agent.bundleID != nil {
            return agent.runsOnDevice
                ? "imported bundle — runs on this iPhone"
                : "imported bundle — needs a heddle-server"
        }
        return agent.sourceLabel
    }
}

/// One quiet line about where server runs will go, checked when the list
/// appears.
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
