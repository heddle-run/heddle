import Foundation
import HeddleCore

/// A flow the app can run.
///
/// Two homes: the server takes a flow as a path under its `--flows-root` or
/// as the document itself in the request body
/// (`packages/server/src/flow-source.ts`), and an imported `.heddle` bundle
/// lives on this phone, extracted under `BundleStore`'s directory and run by
/// the embedded engine when it is portable enough.
///
/// `RunAgent` is heddle-core's view of it — the name a run record shows.
struct Agent: Identifiable, Codable, Equatable, Hashable, RunAgent {
    enum Source: Codable, Equatable, Hashable {
        /// A `flowPath`, resolved server-side against `--flows-root`.
        case serverPath(String)
        /// The flow document itself, sent as a string in every request. The
        /// server reads an untagged string as YAML, which reads JSON too.
        case inline(String)
        /// An imported `.heddle` bundle; the id names its folder under
        /// `BundleStore`'s directory.
        case bundle(id: String)
    }

    var id = UUID()
    var name: String
    var source: Source
    /// The key chat messages are sent under. For server flows the person
    /// names it (the app cannot compile the flow); for a bundle it is the
    /// flow's first declared input, read at import. The CLI's default
    /// `query` is the default here too.
    var inputKey = "query"

    // Bundle agents only; nil on the server kinds, and optional so an
    // agents.json written before bundles existed still decodes.

    /// The verdict `BundlePortability.check` reached at import: empty
    /// reasons means the embedded engine can run it.
    var portability: PortabilityReport?
    /// The id `POST /v1/bundles` answered with, once this bundle has been
    /// uploaded for a server-side run. Unset until the fallback lands.
    var serverBundleID: String?
    /// The flow's declared inputs, one text field each. From the engine's
    /// `inspect` when it answered, from the manifest's default `input`
    /// otherwise.
    var inputFields: [BundleInputField]?
    /// What the manifest said, kept for display without re-reading the disk.
    var manifestSummary: BundleSummary?

    var sourceLabel: String {
        switch source {
        case .serverPath(let path): return path
        case .inline: return "pasted flow"
        case .bundle: return "imported bundle"
        }
    }

    /// The folder name under `BundleStore`'s directory, for bundle agents.
    var bundleID: String? {
        if case .bundle(let id) = source { return id }
        return nil
    }

    /// Whether the embedded engine may run this agent. Server agents are not
    /// "portable" — they have a server; only bundles are judged.
    var runsOnDevice: Bool {
        bundleID != nil && portability?.portable == true
    }
}

/// One input the flow declares, as the detail screen renders it: a key, a
/// declared type, and the manifest's default value when it recorded one.
struct BundleInputField: Codable, Equatable, Hashable {
    var key: String
    var type: String
    var title: String?
    var required: Bool?
    var defaultValue: JSONValue?

    /// The default as text a `TextField` can prefill: strings bare,
    /// everything else as compact JSON, nothing as nothing.
    var defaultText: String {
        switch defaultValue {
        case nil, .null: return ""
        case .some(let value): return value.displayText
        }
    }
}

/// The manifest facts worth keeping on the agent: its display name and the
/// declarations the import sheet and detail screen show. The manifest itself
/// stays authoritative on disk (`extracted/heddle.json`) — the run path
/// re-reads it there.
struct BundleSummary: Codable, Equatable, Hashable {
    var name: String
    /// The `requires` list as the loose JSON it arrived in;
    /// `Requirement.init(json:)` reads each entry.
    var requires: [JSONValue]?
    var interactive: Bool?
    var session: Bool?

    var requirements: [Requirement] {
        requires?.compactMap(Requirement.init(json:)) ?? []
    }
}

// HeddleCore's report, made storable: agents.json remembers the verdict so
// the list and detail screens need not re-extract anything. `Reason` is
// Codable in HeddleCore; the report itself gains the rest here.
extension PortabilityReport: Codable {
    private enum CodingKeys: String, CodingKey {
        case reasons
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(reasons: try container.decode([Reason].self, forKey: .reasons))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reasons, forKey: .reasons)
    }
}

extension PortabilityReport.Reason: Hashable {
    // The label distinguishes every case a person can meet; a rare collision
    // costs a hash bucket, not correctness — Equatable stays synthesized.
    public func hash(into hasher: inout Hasher) {
        hasher.combine(label)
    }
}

extension PortabilityReport: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(reasons)
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

    /// Remove, and hand back what was removed — the caller owns whatever
    /// lives outside this file, which for a bundle agent is its directory.
    @discardableResult
    func remove(atOffsets offsets: IndexSet) -> [Agent] {
        var removed: [Agent] = []
        for index in offsets.sorted(by: >) where agents.indices.contains(index) {
            removed.append(agents.remove(at: index))
        }
        save()
        return removed
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
