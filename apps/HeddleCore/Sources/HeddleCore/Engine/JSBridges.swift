#if canImport(JavaScriptCore)
import Foundation
import JavaScriptCore

/// Everything the host installs into the context before the artifact is
/// evaluated — the top half of `Engine/CONTRACT.md`, in the order it lists
/// them: plain globals (`setTimeout`, `console`, `crypto.randomUUID`), then
/// the `__host_*` bridge functions.
///
/// One rule governs the whole file: JavaScript runs only on the engine's
/// serial queue. Blocks called *by* JS are already on it; anything arriving
/// from elsewhere — a timer firing, a network chunk — hops on before it
/// touches the context. The mutable state below (timers, live fetches) is
/// therefore queue-confined and needs no locks.
final class EngineBridge {
    private let host: EngineHost
    private let queue: DispatchQueue
    private weak var context: JSContext?

    /// Set by the engine before the artifact is evaluated.
    var onEmit: ((_ runID: String, _ frameLine: String) -> Void)?
    var onRunEnded: ((_ runID: String) -> Void)?

    private var timers: [Int32: DispatchWorkItem] = [:]
    private var nextTimerID: Int32 = 1
    /// Live fetches by the id's string form; the artifact's own id value is
    /// kept beside the handle so callbacks return exactly what was given.
    private var fetches: [String: (handle: EngineFetchHandle, id: JSValue)] = [:]

    init(host: EngineHost, queue: DispatchQueue) {
        self.host = host
        self.queue = queue
    }

    func install(in context: JSContext) {
        self.context = context
        installTimers(context)
        installConsole(context)
        installCrypto(context)
        installRunBridge(context)
        installFetch(context)
        installEnvAndSessions(context)
        installFiles(context)
    }

    // MARK: - Plain globals

    private func installTimers(_ context: JSContext) {
        let setTimeout: @convention(block) (JSValue, Double) -> Int32 = {
            [weak self] callback, milliseconds in
            guard let self else { return 0 }
            let id = self.nextTimerID
            self.nextTimerID += 1

            let work = DispatchWorkItem { [weak self] in
                guard let self, self.timers.removeValue(forKey: id) != nil else { return }
                callback.call(withArguments: [])
            }
            self.timers[id] = work
            self.queue.asyncAfter(
                deadline: .now() + max(0, milliseconds) / 1000, execute: work
            )
            return id
        }
        context.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)

        let clearTimeout: @convention(block) (Int32) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: id)?.cancel()
        }
        context.setObject(clearTimeout, forKeyedSubscript: "clearTimeout" as NSString)
    }

    private func installConsole(_ context: JSContext) {
        let console = JSValue(newObjectIn: context)!

        for level in [EngineLogLevel.log, .info, .warn, .error, .debug] {
            // Zero declared parameters: console takes whatever it is given,
            // and `currentArguments` is how a block reads a variadic call.
            let sink: @convention(block) () -> Void = { [weak self] in
                let arguments = JSContext.currentArguments() as? [JSValue] ?? []
                let message = arguments
                    .map { $0.toString() ?? "" }
                    .joined(separator: " ")
                self?.host.log(level: level, message: message)
            }
            console.setObject(sink, forKeyedSubscript: level.rawValue as NSString)
        }

        context.setObject(console, forKeyedSubscript: "console" as NSString)
    }

    private func installCrypto(_ context: JSContext) {
        let crypto = JSValue(newObjectIn: context)!
        let randomUUID: @convention(block) () -> String = {
            // Lowercase, as the web API mints them.
            UUID().uuidString.lowercased()
        }
        crypto.setObject(randomUUID, forKeyedSubscript: "randomUUID" as NSString)
        context.setObject(crypto, forKeyedSubscript: "crypto" as NSString)
    }

    // MARK: - Run reporting

    private func installRunBridge(_ context: JSContext) {
        let emit: @convention(block) (String, String) -> Void = { [weak self] runID, line in
            self?.onEmit?(runID, line)
        }
        context.setObject(emit, forKeyedSubscript: "__host_emit" as NSString)

        let runEnded: @convention(block) (String) -> Void = { [weak self] runID in
            self?.onRunEnded?(runID)
        }
        context.setObject(runEnded, forKeyedSubscript: "__host_runEnded" as NSString)
    }

    // MARK: - Fetch

    private func installFetch(_ context: JSContext) {
        let start: @convention(block) (JSValue, JSValue) -> Void = { [weak self] id, request in
            self?.startFetch(id: id, request: request)
        }
        context.setObject(start, forKeyedSubscript: "__host_fetchStart" as NSString)

        let abort: @convention(block) (JSValue) -> Void = { [weak self] id in
            guard let self, let key = id.toString() else { return }
            self.fetches.removeValue(forKey: key)?.handle.cancel()
        }
        context.setObject(abort, forKeyedSubscript: "__host_fetchAbort" as NSString)
    }

    private func startFetch(id: JSValue, request: JSValue) {
        guard let key = id.toString() else { return }

        var headers: [String: String] = [:]
        if let declared = request.forProperty("headers")?.toDictionary() {
            for (name, value) in declared {
                if let name = name as? String {
                    headers[name] = "\(value)"
                }
            }
        }
        let body = request.forProperty("body")
        let parsed = EngineFetchRequest(
            url: request.forProperty("url")?.toString() ?? "",
            method: request.forProperty("method")?.isString == true
                ? request.forProperty("method")!.toString() : "GET",
            headers: headers,
            body: body?.isString == true ? body?.toString() : nil
        )

        let handle = host.fetcher().start(
            parsed,
            onResponse: { [weak self] head in
                self?.callback("__engine_fetchResponse", for: key) { id in
                    [id, ["status": head.status, "headers": head.headers] as [String: Any]]
                }
            },
            onChunk: { [weak self] text in
                self?.callback("__engine_fetchChunk", for: key) { id in [id, text] }
            },
            onEnd: { [weak self] in
                self?.callback("__engine_fetchEnd", for: key, done: true) { id in [id] }
            },
            onError: { [weak self] message in
                self?.callback("__engine_fetchError", for: key, done: true) { id in
                    [id, message]
                }
            }
        )
        fetches[key] = (handle, id)
    }

    /// Hop a fetcher callback onto the JS queue and into the artifact.
    ///
    /// The fetch may already be gone — aborted, or finished by an earlier
    /// callback — in which case the late event is dropped, matching what an
    /// aborted fetch means. `done` retires the fetch after delivery.
    private func callback(
        _ function: String, for key: String, done: Bool = false,
        arguments: @escaping (JSValue) -> [Any]
    ) {
        queue.async { [weak self] in
            guard let self, let context = self.context,
                let live = self.fetches[key]
            else { return }
            if done { self.fetches.removeValue(forKey: key) }

            let target = context.objectForKeyedSubscript(function)
            guard target?.isUndefined == false else { return }
            target?.call(withArguments: arguments(live.id))
        }
    }

    // MARK: - Env and sessions

    private func installEnvAndSessions(_ context: JSContext) {
        let resolveEnv: @convention(block) (String) -> JSValue = { [weak self] name in
            let context = JSContext.current()!
            guard let value = self?.host.resolveEnv(name) else {
                return JSValue(nullIn: context)
            }
            return JSValue(object: value, in: context)
        }
        context.setObject(resolveEnv, forKeyedSubscript: "__host_resolveEnv" as NSString)

        let sessionRead: @convention(block) (String) -> JSValue = { [weak self] id in
            let context = JSContext.current()!
            guard let json = self?.host.sessionRead(id: id) else {
                return JSValue(nullIn: context)
            }
            return JSValue(object: json, in: context)
        }
        context.setObject(sessionRead, forKeyedSubscript: "__host_sessionRead" as NSString)

        let sessionWrite: @convention(block) (String, String) -> Void = { [weak self] id, json in
            self?.host.sessionWrite(id: id, json: json)
        }
        context.setObject(sessionWrite, forKeyedSubscript: "__host_sessionWrite" as NSString)
    }

    // MARK: - Files

    private func installFiles(_ context: JSContext) {
        let readFile: @convention(block) (String) -> JSValue = { [weak self] path in
            let context = JSContext.current()!
            guard let url = self?.confined(path),
                let contents = try? String(contentsOf: url, encoding: .utf8)
            else { return JSValue(nullIn: context) }
            return JSValue(object: contents, in: context)
        }
        context.setObject(readFile, forKeyedSubscript: "__host_readFile" as NSString)

        let writeFile: @convention(block) (String, String) -> Bool = { [weak self] path, contents in
            guard let self, let url = self.confined(path) else { return false }
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true
                )
                try Data(contents.utf8).write(to: url)
                return true
            } catch {
                return false
            }
        }
        context.setObject(writeFile, forKeyedSubscript: "__host_writeFile" as NSString)

        let listDir: @convention(block) (String) -> JSValue = { [weak self] path in
            let context = JSContext.current()!
            guard let url = self?.confined(path),
                let names = try? FileManager.default.contentsOfDirectory(atPath: url.path)
            else { return JSValue(nullIn: context) }
            return JSValue(object: names.sorted(), in: context)
        }
        context.setObject(listDir, forKeyedSubscript: "__host_listDir" as NSString)
    }

    /// A path the artifact may touch, or nil.
    ///
    /// Absolute, normalized, and under one of the host's declared roots —
    /// the extracted bundle and the per-run scratch. Symlinks are resolved on
    /// both sides of the comparison so `/var` and `/private/var` spellings
    /// agree; a `..` survives normalization only by climbing, which is
    /// exactly what is refused.
    private func confined(_ path: String) -> URL? {
        guard path.hasPrefix("/") else { return nil }

        let target = URL(fileURLWithPath: path).standardizedFileURL
            .resolvingSymlinksInPath()
        for root in host.fileRoots() {
            let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
            if target.path == rootPath || target.path.hasPrefix(rootPath + "/") {
                return target
            }
        }
        return nil
    }
}
#endif
