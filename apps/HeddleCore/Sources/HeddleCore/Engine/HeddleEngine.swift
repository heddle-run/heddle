#if canImport(JavaScriptCore)
import Foundation
import JavaScriptCore

/// The embedded engine: one JavaScriptCore context running the
/// `heddle-engine.js` artifact, spoken to through `Engine/CONTRACT.md`.
///
/// The context is confined to a private serial queue — every entry into JS
/// hops onto it, which is what lets the bridge keep its state lock-free and
/// lets JavaScriptCore see one thread. The artifact is evaluated once at
/// init; runs are started on it and stream their frames back as the same
/// JSON lines the CLI writes, so `FrameReducer.consume(line:)` folds them
/// untouched.
public final class HeddleEngine: @unchecked Sendable {
    // @unchecked because the compiler cannot see the discipline: every piece
    // of mutable state is confined to `queue`, and JS itself runs only there.

    /// The two spellings a flow arrives in.
    public enum FlowFormat: String, Encodable {
        case yaml
        case json
    }

    /// One input the flow declares, as `inspect` reports it.
    public struct InputField: Equatable, Decodable {
        public var key: String
        public var type: String
        public var title: String?
        public var required: Bool?

        public init(key: String, type: String, title: String? = nil, required: Bool? = nil) {
            self.key = key
            self.type = type
            self.title = title
            self.required = required
        }
    }

    /// What `inspect` learned by parsing — and only parsing — a flow.
    /// Bundle-level facts (`interactive`, `session`, defaults) are the
    /// manifest's and are read by `BundleManifest`, not asked of the engine.
    public struct FlowInfo: Equatable {
        public var name: String
        public var inputs: [InputField]

        public init(name: String, inputs: [InputField]) {
            self.name = name
            self.inputs = inputs
        }
    }

    /// The contract's `RunConfig`, encoded for `HeddleEngine.run(configJSON)`.
    public struct RunConfig: Encodable {
        public struct Flow: Encodable {
            public var text: String
            public var format: FlowFormat

            public init(text: String, format: FlowFormat) {
                self.text = text
                self.format = format
            }
        }

        /// One plugin, already extracted and read: its parsed manifest, its
        /// entry source, and its directory under `bundleDir`. An entry that
        /// imports sibling files is linked by the artifact, which reads them
        /// through the file bridge at paths under `dir`.
        public struct PluginCode: Encodable {
            public var manifest: JSONValue
            public var entrySource: String
            public var dir: String

            public init(manifest: JSONValue, entrySource: String, dir: String) {
                self.manifest = manifest
                self.entrySource = entrySource
                self.dir = dir
            }
        }

        public var runId: String
        public var flow: Flow
        public var bundleDir: String
        /// Absolute; the run's writable root. The artifact builds every
        /// file-bridge path under `bundleDir` or here, and the host's file
        /// functions refuse anything else.
        public var scratchDir: String
        public var plugins: [PluginCode]
        public var pluginConfig: [String: [String: JSONValue]]
        public var inputs: [String: JSONValue]
        public var session: String?
        public var resume: Bool
        public var answer: JSONValue?
        public var maxToolRounds: JSONValue?

        public init(
            runId: String,
            flow: Flow,
            bundleDir: String,
            scratchDir: String,
            plugins: [PluginCode] = [],
            pluginConfig: [String: [String: JSONValue]] = [:],
            inputs: [String: JSONValue] = [:],
            session: String? = nil,
            resume: Bool = false,
            answer: JSONValue? = nil,
            maxToolRounds: JSONValue? = nil
        ) {
            self.runId = runId
            self.flow = flow
            self.bundleDir = bundleDir
            self.scratchDir = scratchDir
            self.plugins = plugins
            self.pluginConfig = pluginConfig
            self.inputs = inputs
            self.session = session
            self.resume = resume
            self.answer = answer
            self.maxToolRounds = maxToolRounds
        }

        private enum CodingKeys: String, CodingKey {
            case runId, flow, bundleDir, scratchDir, plugins, pluginConfig
            case inputs, session, resume, answer, maxToolRounds
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(runId, forKey: .runId)
            try container.encode(flow, forKey: .flow)
            try container.encode(bundleDir, forKey: .bundleDir)
            try container.encode(scratchDir, forKey: .scratchDir)
            try container.encode(plugins, forKey: .plugins)
            try container.encode(pluginConfig, forKey: .pluginConfig)
            try container.encode(inputs, forKey: .inputs)
            // The contract says `string | null`, so nil is an explicit null
            // rather than an absent key.
            try container.encode(session, forKey: .session)
            try container.encode(resume, forKey: .resume)
            try container.encodeIfPresent(answer, forKey: .answer)
            try container.encodeIfPresent(maxToolRounds, forKey: .maxToolRounds)
        }

        public func encodeJSON() throws -> String {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return String(decoding: try encoder.encode(self), as: UTF8.self)
        }
    }

    public enum EngineError: Error, LocalizedError, Equatable {
        /// No artifact at the given URL, and none shipped as a resource.
        case artifactNotFound
        /// The artifact (or a later call into it) threw.
        case javascriptFailed(String)
        /// The artifact evaluated but defined no usable `HeddleEngine`.
        case engineMissing
        /// `inspect` said `{ok: false}` — the flow did not parse.
        case inspectFailed(String)
        /// `inspect` answered something that is not the contract's shape.
        case badEngineReply(String)

        public var errorDescription: String? {
            switch self {
            case .artifactNotFound:
                return "heddle-engine.js is not in the app bundle"
            case .javascriptFailed(let message):
                return "the engine threw: \(message)"
            case .engineMissing:
                return "the artifact defined no HeddleEngine global — "
                    + "it is not a heddle engine build"
            case .inspectFailed(let message):
                return message
            case .badEngineReply(let reply):
                return "the engine answered inspect with something other than "
                    + "its contract: \(reply)"
            }
        }
    }

    /// The one thread JavaScript ever runs on.
    private let queue = DispatchQueue(label: "run.heddle.core.engine")
    private let context: JSContext
    private let bridge: EngineBridge
    /// Live runs' stream continuations. Queue-confined.
    private var runs: [String: AsyncThrowingStream<String, Error>.Continuation] = [:]
    /// The last exception JS raised, kept until the call that caused it
    /// returns to Swift and turns it into a thrown error. Queue-confined.
    private var pendingException: JSValue?

    /// Evaluate the artifact and check it kept its side of the contract.
    ///
    /// `artifactURL` is a test seam and an override; by default the artifact
    /// ships as the package resource `EngineResources/heddle-engine.js`,
    /// refreshed by the repo's update script and stable in name so a refresh
    /// is a file copy, not a code change. (`EngineResources`, not
    /// `Resources`: a top-level `Resources/` inside the built resource bundle
    /// fails iOS codesigning, which reads it as a malformed deep bundle.)
    public init(host: EngineHost, artifactURL: URL? = nil) throws {
        let url = artifactURL
            ?? Bundle.module.url(
                forResource: "heddle-engine", withExtension: "js",
                subdirectory: "EngineResources"
            )
        guard let url else { throw EngineError.artifactNotFound }
        let source: String
        do {
            source = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw EngineError.artifactNotFound
        }

        context = JSContext()
        bridge = EngineBridge(host: host, queue: queue)

        try queue.sync {
            context.exceptionHandler = { [weak self] _, exception in
                self?.pendingException = exception
            }

            bridge.onEmit = { [weak self] runID, line in
                self?.runs[runID]?.yield(line)
            }
            bridge.onRunEnded = { [weak self] runID in
                self?.runs.removeValue(forKey: runID)?.finish()
            }
            bridge.install(in: context)

            context.evaluateScript(source, withSourceURL: url)
            if let error = takeException() { throw error }

            let engine = context.objectForKeyedSubscript("HeddleEngine")
            guard engine?.isObject == true,
                engine?.forProperty("inspect")?.isUndefined == false,
                engine?.forProperty("run")?.isUndefined == false,
                engine?.forProperty("cancel")?.isUndefined == false
            else { throw EngineError.engineMissing }
        }
    }

    /// Parse a flow — runs nothing, per the contract.
    public func inspect(flowText: String, format: FlowFormat) throws -> FlowInfo {
        try queue.sync {
            let reply = context.objectForKeyedSubscript("HeddleEngine")?
                .invokeMethod("inspect", withArguments: [flowText, format.rawValue])
            if let error = takeException() { throw error }
            guard let json = reply?.toString(), reply?.isString == true else {
                throw EngineError.badEngineReply(reply?.toString() ?? "undefined")
            }

            struct InspectReply: Decodable {
                var ok: Bool
                var error: String?
                var name: String?
                var inputs: [InputField]?
            }
            guard let decoded = try? JSONDecoder().decode(
                InspectReply.self, from: Data(json.utf8)
            ) else {
                throw EngineError.badEngineReply(json)
            }
            guard decoded.ok else {
                throw EngineError.inspectFailed(decoded.error ?? "flow did not parse")
            }
            guard let name = decoded.name else {
                throw EngineError.badEngineReply(json)
            }
            return FlowInfo(name: name, inputs: decoded.inputs ?? [])
        }
    }

    /// Ask the artifact's linker whether a plugin entry would evaluate in
    /// this engine — runs nothing, per the contract. `files` maps the
    /// plugin-dir-relative path of every sibling module to its source; the
    /// answer is the list of problems, empty when the entry links.
    public func linkCheck(
        entrySource: String, files: [String: String]
    ) throws -> [String] {
        try queue.sync {
            struct Request: Encodable {
                var entrySource: String
                var files: [String: String]
            }
            let json = String(
                decoding: try JSONEncoder().encode(
                    Request(entrySource: entrySource, files: files)),
                as: UTF8.self
            )

            let reply = context.objectForKeyedSubscript("HeddleEngine")?
                .invokeMethod("linkCheck", withArguments: [json])
            if let error = takeException() { throw error }
            guard let text = reply?.toString(), reply?.isString == true else {
                throw EngineError.badEngineReply(reply?.toString() ?? "undefined")
            }

            struct Reply: Decodable {
                var ok: Bool
                var problems: [String]?
            }
            guard let decoded = try? JSONDecoder().decode(
                Reply.self, from: Data(text.utf8)
            ) else {
                throw EngineError.badEngineReply(text)
            }
            if decoded.ok { return [] }
            return decoded.problems ?? ["the entry could not be linked"]
        }
    }

    /// Start a run; the stream is its frames, one CLI-shaped JSON line each.
    ///
    /// The stream finishes when the artifact calls `__host_runEnded`, and
    /// throws only when the run could not be started at all. Cancelling the
    /// consuming task cancels the run — the artifact still emits its
    /// terminal frame, to a stream no longer listening.
    public func run(_ config: RunConfig) -> AsyncThrowingStream<String, Error> {
        let runID = config.runId

        return AsyncThrowingStream { continuation in
            continuation.onTermination = { [weak self] termination in
                guard let self else { return }
                self.queue.async {
                    self.runs.removeValue(forKey: runID)
                    if case .cancelled = termination {
                        self.cancelOnQueue(runID: runID)
                    }
                }
            }

            queue.async { [weak self] in
                guard let self else {
                    continuation.finish()
                    return
                }
                self.runs[runID] = continuation

                do {
                    let configJSON = try config.encodeJSON()
                    self.context.objectForKeyedSubscript("HeddleEngine")?
                        .invokeMethod("run", withArguments: [configJSON])
                    if let error = self.takeException() {
                        self.runs.removeValue(forKey: runID)
                        continuation.finish(throwing: error)
                    }
                } catch {
                    self.runs.removeValue(forKey: runID)
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Ask the artifact to abort; it answers with a terminal frame and
    /// `__host_runEnded` of its own.
    public func cancel(runID: String) {
        queue.async { [weak self] in
            self?.cancelOnQueue(runID: runID)
        }
    }

    private func cancelOnQueue(runID: String) {
        context.objectForKeyedSubscript("HeddleEngine")?
            .invokeMethod("cancel", withArguments: [runID])
        _ = takeException() // a cancel of a finished run is not an event
    }

    /// The pending JS exception as a Swift error, consumed.
    private func takeException() -> Error? {
        guard let exception = pendingException else { return nil }
        pendingException = nil
        return EngineError.javascriptFailed(exception.toString() ?? "unknown exception")
    }

    /// Run a script in the engine's context — the test suite's window into
    /// bridge behavior. Returns the result's string form; null and undefined
    /// come back as nil.
    func evaluateForTesting(_ script: String) throws -> String? {
        try queue.sync {
            let value = context.evaluateScript(script)
            if let error = takeException() { throw error }
            guard let value, !value.isUndefined, !value.isNull else { return nil }
            return value.toString()
        }
    }
}
#endif
