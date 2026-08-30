import Foundation
import HeddleCore
import Observation

/// The agents folder, watched: what the menu lists.
///
/// `~/.heddle/agents` is created on first launch and rescanned whenever it
/// changes, so dropping a bundle in Finder is all "installing an agent" is.
@MainActor
@Observable
final class AgentStore {
    private(set) var agents: [Agent] = []

    /// Agents opened from outside the folder — a Finder double-click, a drop.
    /// Runnable but not listed in the menu's main section; removed if the
    /// file disappears.
    private(set) var external: [Agent] = []

    private(set) var directory: URL

    private static let directoryDefaultsKey = "agentsDirectory"

    @ObservationIgnored
    private var watcher: DispatchSourceFileSystemObject?

    init(directory: URL? = nil) {
        self.directory =
            directory
            ?? UserDefaults.standard.string(forKey: Self.directoryDefaultsKey)
                .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".heddle/agents", isDirectory: true)
        ensureDirectory()
        rescan()
        watch()
    }

    /// Point the store somewhere else; the choice persists across launches.
    func setDirectory(_ url: URL) {
        watcher?.cancel()
        watcher = nil
        directory = url
        UserDefaults.standard.set(url.path, forKey: Self.directoryDefaultsKey)
        ensureDirectory()
        rescan()
        watch()
    }

    /// The agent behind an id, wherever it came from.
    func find(_ id: Agent.ID?) -> Agent? {
        guard let id else { return nil }
        return agents.first { $0.id == id } ?? external.first { $0.id == id }
    }

    /// Adopt a file opened from outside the folder, re-reading its manifest.
    /// Nothing is copied: the double-clicked bundle runs where it lies.
    @discardableResult
    func adoptExternal(_ url: URL) -> Agent? {
        guard let agent = AgentLoading.agent(at: url.standardizedFileURL) else { return nil }
        external.removeAll { $0.id == agent.id }
        external.append(agent)
        return agent
    }

    func rescan() {
        let contents =
            (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )) ?? []

        agents =
            contents
            .compactMap(AgentLoading.agent(at:))
            .sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    /// Copy a picked file into the folder; the watcher makes it appear.
    func install(from source: URL) throws {
        let destination = directory.appendingPathComponent(source.lastPathComponent)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: source, to: destination)
        rescan()
    }

    /// Download a `.heddle` address into the folder — the same rule the CLI
    /// applies to a remote path (`bundles.ts`): http(s), and only bundles,
    /// because a flow file depends on tools and mounts beside it and a
    /// download has no beside. The archive is opened for its manifest before
    /// it lands, so a URL serving something else never joins the menu.
    func install(fromRemote address: String) async throws -> Agent {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme)
        else {
            throw installError("that is not an http(s) address")
        }
        guard url.path.lowercased().hasSuffix(".heddle") else {
            throw installError(
                "only .heddle bundles install from a URL — bundle a flow first "
                    + "with \"heddle bundle\""
            )
        }

        let (temporary, response) = try await URLSession.shared.download(from: url)
        defer { try? FileManager.default.removeItem(at: temporary) }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw installError("the server answered \(http.statusCode)")
        }
        guard (try? BundleReader.manifest(at: temporary)) != nil else {
            throw installError("what that URL serves is not a readable .heddle bundle")
        }

        let name = url.lastPathComponent.isEmpty ? "agent.heddle" : url.lastPathComponent
        let destination = directory.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: temporary, to: destination)
        rescan()

        guard let agent = AgentLoading.agent(at: destination) else {
            throw installError("the downloaded bundle would not load")
        }
        return agent
    }

    private func installError(_ message: String) -> Error {
        NSError(
            domain: "run.heddle.app", code: 1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func ensureDirectory() {
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
    }

    /// One kqueue source on the directory itself.
    ///
    /// Coarser than FSEvents — any write to the directory triggers a full
    /// rescan — and exactly enough: the folder holds tens of files, and a
    /// rescan is a readdir plus a manifest read per new bundle.
    private func watch() {
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler { [weak self] in self?.rescan() }
        source.setCancelHandler { close(fd) }
        source.resume()
        watcher = source
    }
}
