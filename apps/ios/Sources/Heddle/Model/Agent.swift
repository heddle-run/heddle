import Foundation

/// A flow the app can ask the server to run.
///
/// The server takes a flow two ways (`packages/server/src/flow-source.ts`):
/// a path under its `--flows-root`, or the document itself in the request
/// body. `.heddle` bundles are not one of them — only the CLI opens bundles
/// — so an agent here is a flow, not an archive.
struct Agent: Identifiable, Codable, Equatable, Hashable {
    enum Source: Codable, Equatable, Hashable {
        /// A `flowPath`, resolved server-side against `--flows-root`.
        case serverPath(String)
        /// The flow document itself, sent as a string in every request. The
        /// server reads an untagged string as YAML, which reads JSON too.
        case inline(String)
    }

    var id = UUID()
    var name: String
    var source: Source
    /// The key chat messages are sent under. The CLI derives it from the
    /// flow's StartNode (`detectInputKey`, `packages/cli/src/cli/run.ts`);
    /// the app cannot compile the flow, so the person names it, and the
    /// CLI's default `query` is the default here too.
    var inputKey = "query"

    var sourceLabel: String {
        switch source {
        case .serverPath(let path): return path
        case .inline: return "pasted flow"
        }
    }
}

/// The saved agents, one JSON file in Application Support.
@MainActor
@Observable
final class AgentStore {
    private(set) var agents: [Agent] = []

    private static var file: URL {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0]
        return directory.appendingPathComponent("agents.json")
    }

    init() {
        if let data = try? Data(contentsOf: Self.file),
           let saved = try? JSONDecoder().decode([Agent].self, from: data)
        {
            agents = saved
        }
    }

    func add(_ agent: Agent) {
        agents.append(agent)
        save()
    }

    func update(_ agent: Agent) {
        guard let index = agents.firstIndex(where: { $0.id == agent.id }) else { return }
        agents[index] = agent
        save()
    }

    func remove(atOffsets offsets: IndexSet) {
        for index in offsets.sorted(by: >) where agents.indices.contains(index) {
            agents.remove(at: index)
        }
        save()
    }

    private func save() {
        let directory = Self.file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        if let data = try? JSONEncoder().encode(agents) {
            try? data.write(to: Self.file, options: .atomic)
        }
    }
}
