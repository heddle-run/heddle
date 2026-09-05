import Foundation
import HeddleCore

/// The embedded engine, hosted by this app: one JavaScriptCore context for
/// the whole process, answering `resolveEnv` from the Keychain, sessions
/// from blobs on disk, files from the roots each live run registers, and
/// fetches from URLSession.
///
/// The `HeddleEngine` itself is built on first use — evaluating a 600 KiB
/// artifact is not free, and a launch that never touches a bundle should
/// never pay for it.
final class LocalEngine: EngineHost, @unchecked Sendable {
    // @unchecked: `engine` and `roots` sit behind `lock`; everything else is
    // immutable. EngineHost calls arrive on the engine's own queue.

    static let shared = LocalEngine()

    private let lock = NSLock()
    private var engine: HeddleEngine?
    /// Reference-counted so two concurrent runs of one agent, sharing its
    /// extracted directory, do not pull the root out from under each other.
    private var roots: [String: Int] = [:]

    private let secrets: SecretStore
    private let sessionsDirectory: URL
    private let urlFetcher = URLSessionFetcher()

    init(
        secrets: SecretStore = KeychainSecretStore(
            service: KeychainSecretStore.envService),
        sessionsDirectory: URL? = nil
    ) {
        self.secrets = secrets
        self.sessionsDirectory =
            sessionsDirectory
            ?? FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            )[0].appendingPathComponent("EngineSessions")
    }

    /// Parse a flow for its name and declared inputs — runs nothing.
    func inspect(
        flowText: String, format: HeddleEngine.FlowFormat
    ) throws -> HeddleEngine.FlowInfo {
        try liveEngine().inspect(flowText: flowText, format: format)
    }

    /// Ask the engine's linker whether a plugin entry would evaluate here —
    /// runs nothing. Empty means it links; each entry is one problem.
    func linkCheck(
        entrySource: String, files: [String: String]
    ) throws -> [String] {
        try liveEngine().linkCheck(entrySource: entrySource, files: files)
    }

    /// Start a run whose file bridge may touch `roots` (the extracted bundle
    /// and the run's scratch), registered for exactly the stream's lifetime.
    func run(
        _ config: HeddleEngine.RunConfig, roots runRoots: [URL]
    ) throws -> AsyncThrowingStream<String, Error> {
        let engine = try liveEngine()
        retain(runRoots)
        let inner = engine.run(config)

        return AsyncThrowingStream { continuation in
            let forwarder = Task {
                defer { self.release(runRoots) }
                do {
                    for try await line in inner {
                        continuation.yield(line)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Cancelling the consumer cancels the forwarder, whose inner
            // loop cancels the engine's stream, which cancels the JS run.
            continuation.onTermination = { _ in forwarder.cancel() }
        }
    }

    private func liveEngine() throws -> HeddleEngine {
        try lock.withLock {
            if let engine { return engine }
            let built = try HeddleEngine(host: self)
            engine = built
            return built
        }
    }

    private func retain(_ urls: [URL]) {
        lock.withLock {
            for url in urls { roots[url.path, default: 0] += 1 }
        }
    }

    private func release(_ urls: [URL]) {
        lock.withLock {
            for url in urls {
                let count = (roots[url.path] ?? 1) - 1
                roots[url.path] = count > 0 ? count : nil
            }
        }
    }

    // MARK: - EngineHost

    func resolveEnv(_ name: String) -> String? {
        secrets.read(account: name)
    }

    func sessionRead(id: String) -> String? {
        guard let file = sessionFile(id) else { return nil }
        return try? String(contentsOf: file, encoding: .utf8)
    }

    /// Dumb I/O per the contract, with one host-side reading: an empty
    /// string deletes the blob, so the artifact can drop a session.
    func sessionWrite(id: String, json: String) {
        guard let file = sessionFile(id) else { return }
        if json.isEmpty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        try? FileManager.default.createDirectory(
            at: sessionsDirectory, withIntermediateDirectories: true
        )
        try? Data(json.utf8).write(to: file, options: .atomic)
    }

    func fileRoots() -> [URL] {
        lock.withLock {
            roots.keys.map { URL(fileURLWithPath: $0) }
        }
    }

    func fetcher() -> EngineFetcher {
        urlFetcher
    }

    /// A session id the disk can hold as a filename: the same alphabet
    /// core's `assertSessionId` allows (`packages/core/src/session/
    /// store.ts`), refused rather than escaped — the id came from JS.
    private func sessionFile(_ id: String) -> URL? {
        guard !id.isEmpty, id.count <= 128,
              id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
              id.first?.isLetter == true || id.first?.isNumber == true
        else { return nil }
        return sessionsDirectory.appendingPathComponent(id + ".json")
    }
}

/// From an extracted bundle on disk to the engine's `RunConfig` — the same
/// resolution the CLI performs when it opens a bundle, done with the
/// manifest as the map.
enum LocalRunAssembly {
    /// The flow's format, by the extension the manifest recorded.
    static func format(of path: String) -> HeddleEngine.FlowFormat {
        (path as NSString).pathExtension.lowercased() == "json" ? .json : .yaml
    }

    /// The run's writable root, under the temp directory the system already
    /// prunes. Created here so the engine can write from its first frame.
    static func makeScratchDirectory(runID: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("EngineScratch")
            .appendingPathComponent(runID)
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true
        )
        return dir
    }

    /// Assemble a config from `extractedDir` — the manifest is re-read from
    /// `extracted/heddle.json` rather than trusted to any saved copy,
    /// because the directory is what actually runs.
    static func config(
        runID: String,
        extractedDir: URL,
        scratchDir: URL,
        inputs: [String: JSONValue],
        session: String?,
        resume: Bool,
        answer: JSONValue?
    ) throws -> HeddleEngine.RunConfig {
        let manifest = try BundleManifest.decode(
            try readData(
                extractedDir.appendingPathComponent(BundleManifest.manifestName),
                what: BundleManifest.manifestName
            )
        )

        let flowURL = extractedDir.appendingPathComponent(manifest.flow)
        guard let flowText = try? String(contentsOf: flowURL, encoding: .utf8) else {
            throw BundleError("the extracted bundle lost its flow \"\(manifest.flow)\"")
        }

        let plugins = try manifest.plugins.map { path in
            try pluginCode(manifestURL: extractedDir.appendingPathComponent(path))
        }

        return HeddleEngine.RunConfig(
            runId: runID,
            flow: .init(text: flowText, format: format(of: manifest.flow)),
            bundleDir: extractedDir.path,
            scratchDir: scratchDir.path,
            plugins: plugins,
            pluginConfig: manifest.pluginConfig,
            inputs: inputs,
            session: session,
            resume: resume,
            answer: answer,
            maxToolRounds: manifest.maxToolRounds
        )
    }

    /// One plugin, read whole: parsed manifest, entry source, directory.
    ///
    /// Entry resolution is `BundlePortability`'s (itself core's
    /// `entryFor`): `command[0]` when the manifest declares one — though a
    /// command already made the bundle non-portable, so the portable path
    /// never lands there — else the manifest's sibling `<stem>.mjs` or
    /// `<stem>.js`.
    private static func pluginCode(
        manifestURL: URL
    ) throws -> HeddleEngine.RunConfig.PluginCode {
        let name = manifestURL.lastPathComponent
        let raw: JSONValue
        do {
            raw = try JSONDecoder().decode(
                JSONValue.self, from: try readData(manifestURL, what: name))
        } catch let error as BundleError {
            throw error
        } catch {
            throw BundleError("plugin manifest \"\(name)\" is not readable JSON")
        }

        let dir = manifestURL.deletingLastPathComponent()
        let entry: URL
        if case .array(let command)? = raw.objectValue?["command"],
           let first = command.first?.stringValue {
            entry = dir.appendingPathComponent(first)
        } else {
            let stem = manifestURL.deletingPathExtension()
            guard
                let sibling = ["mjs", "js"]
                    .map({ stem.appendingPathExtension($0) })
                    .first(where: { FileManager.default.fileExists(atPath: $0.path) })
            else {
                throw BundleError(
                    "plugin manifest \"\(name)\" has no JavaScript entry beside it"
                )
            }
            entry = sibling
        }

        guard let source = try? String(contentsOf: entry, encoding: .utf8) else {
            throw BundleError(
                "plugin entry \"\(entry.lastPathComponent)\" is not readable"
            )
        }

        return .init(manifest: raw, entrySource: source, dir: dir.path)
    }

    private static func readData(_ url: URL, what: String) throws -> Data {
        do {
            return try Data(contentsOf: url)
        } catch {
            throw BundleError("the extracted bundle lost its \(what)")
        }
    }
}
