import Foundation
import HeddleCore

/// Something the menu can run: a `.heddle` bundle, or a bare flow file.
///
/// `RunAgent` is heddle-core's view of it — the name a run record shows.
struct Agent: Identifiable, Equatable, RunAgent {
    enum Kind: Equatable {
        case bundle
        case flow
    }

    /// The file's path doubles as identity: one row per file on disk.
    var id: String { url.path }

    let url: URL
    let kind: Kind
    let name: String
    let defaultInput: [String: JSONValue]?
    let interactive: Bool
    var requires: [Requirement] = []

    static func == (lhs: Agent, rhs: Agent) -> Bool {
        lhs.url == rhs.url && lhs.name == rhs.name
    }
}

enum AgentLoading {
    /// Read one agent off disk, or nothing if the file is not runnable.
    ///
    /// A `.heddle` bundle is named by its manifest; a flow file by its stem.
    /// A bundle whose manifest cannot be read still appears, named by its
    /// filename — the run will surface the real error with the CLI's words,
    /// which beat anything this scan could invent.
    static func agent(at url: URL) -> Agent? {
        let ext = url.pathExtension.lowercased()
        if ext == "heddle" {
            // HeddleCore's own reader — the same gzip+ustar rules the CLI
            // applies, so what opens here opens there. No tar subprocess.
            let manifest = try? BundleReader.manifest(at: url)
            return Agent(
                url: url,
                kind: .bundle,
                name: manifest?.name ?? url.deletingPathExtension().lastPathComponent,
                defaultInput: manifest?.input,
                interactive: manifest?.interactive ?? false,
                requires: manifest?.requires?.compactMap(Requirement.init(json:)) ?? []
            )
        }
        if ["json", "yaml", "yml"].contains(ext) {
            return Agent(
                url: url,
                kind: .flow,
                name: url.deletingPathExtension().lastPathComponent,
                defaultInput: nil,
                interactive: false
            )
        }
        return nil
    }
}
