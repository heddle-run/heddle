import Foundation
import HeddleCore

/// The slice of a bundle's `heddle.json` the app acts on.
///
/// Mirrors `BundleManifest` in `packages/core/src/bundle/format.ts`, minus the
/// archive-layout fields (`flow`, `tools`, `plugins`, …) that only the CLI —
/// which does the unpacking — needs to see.
struct AgentManifest: Decodable {
    var name: String
    var input: [String: JSONValue]?
    var interactive: Bool?
    var session: Bool?
    var requires: [JSONValue]?
}

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
            let manifest = try? bundleManifest(at: url)
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

    /// The manifest at the root of a `.heddle` archive.
    ///
    /// A bundle is a gzipped ustar (`packages/core/src/bundle/format.ts`), and
    /// macOS ships bsdtar at `/usr/bin/tar`, which reads exactly that —
    /// `-xOzf` prints one entry to stdout. Shelling out keeps the app free of
    /// an archive dependency, the same zero-dep stance the writer takes.
    static func bundleManifest(at url: URL) throws -> AgentManifest {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-xOzf", url.path, "heddle.json"]

        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()

        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw CocoaError(.fileReadCorruptFile, userInfo: [
                NSFilePathErrorKey: url.path,
                NSLocalizedDescriptionKey: "not a readable .heddle bundle",
            ])
        }
        return try JSONDecoder().decode(AgentManifest.self, from: data)
    }
}
