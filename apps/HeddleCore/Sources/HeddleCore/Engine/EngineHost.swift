import Foundation
import os

/// What the console levels of the artifact map to.
public enum EngineLogLevel: String {
    case debug
    case log
    case info
    case warn
    case error
}

/// Everything the embedded engine may ask of the app hosting it.
///
/// One protocol per app: the iOS app answers with its Keychain, its session
/// files and a URLSession; a test answers with dictionaries and canned
/// chunks. The contract the artifact sees is `Engine/CONTRACT.md`; this is
/// the same set of verbs from the Swift side.
public protocol EngineHost: AnyObject {
    /// `__host_resolveEnv` — the host's secret store. Never logged.
    func resolveEnv(_ name: String) -> String?
    /// `__host_sessionRead` — one JSON blob per session id, or nil.
    func sessionRead(id: String) -> String?
    /// `__host_sessionWrite` — dumb I/O; turn semantics live in the artifact.
    func sessionWrite(id: String, json: String)
    /// The only directories `__host_readFile/writeFile/listDir` may touch:
    /// the extracted bundle directory and a per-run scratch directory.
    func fileRoots() -> [URL]
    /// Who performs `__host_fetchStart`. Called once per fetch.
    func fetcher() -> EngineFetcher
    func log(level: EngineLogLevel, message: String)
}

private let engineLogger = Logger(subsystem: "run.heddle.core", category: "engine")

extension EngineHost {
    /// Default: the unified log. An app that wants its own sink overrides.
    public func log(level: EngineLogLevel, message: String) {
        switch level {
        case .debug: engineLogger.debug("\(message, privacy: .public)")
        case .log, .info: engineLogger.info("\(message, privacy: .public)")
        case .warn: engineLogger.warning("\(message, privacy: .public)")
        case .error: engineLogger.error("\(message, privacy: .public)")
        }
    }
}

/// `__host_fetchStart`'s request, as the contract spells it: text body only
/// in v1 — model APIs speak JSON and SSE.
public struct EngineFetchRequest: Equatable {
    public var url: String
    public var method: String
    public var headers: [String: String]
    public var body: String?

    public init(
        url: String, method: String = "GET",
        headers: [String: String] = [:], body: String? = nil
    ) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
    }
}

/// What `__engine_fetchResponse` carries back.
public struct EngineFetchResponseHead: Equatable {
    public var status: Int
    public var headers: [String: String]

    public init(status: Int, headers: [String: String] = [:]) {
        self.status = status
        self.headers = headers
    }
}

/// A live fetch, held so `__host_fetchAbort` can reach it.
public protocol EngineFetchHandle {
    func cancel()
}

/// The one verb a fetch is: start it, and hear back through callbacks.
///
/// Callbacks may arrive on any thread — the bridge hops them onto the JS
/// queue. `onChunk` strings must be whole: a chunk never ends mid-code-point,
/// which is the fetcher's burden because only it sees bytes.
public protocol EngineFetcher {
    func start(
        _ request: EngineFetchRequest,
        onResponse: @escaping (EngineFetchResponseHead) -> Void,
        onChunk: @escaping (String) -> Void,
        onEnd: @escaping () -> Void,
        onError: @escaping (String) -> Void
    ) -> EngineFetchHandle
}

/// UTF-8 out of arbitrary byte splits.
///
/// A network chunk ends wherever the socket did, and a code point split
/// across two chunks must not cross the JS bridge as two replacement
/// characters. Bytes go in as they arrive; what comes out is the longest
/// decodable prefix, the up-to-three trailing bytes of an unfinished
/// sequence held for the next chunk.
struct UTF8ChunkDecoder {
    private var pending: [UInt8] = []

    /// Decode what is complete; hold back an unfinished trailing sequence.
    mutating func decode(_ data: Data) -> String? {
        pending.append(contentsOf: data)
        let cut = Self.completePrefixLength(pending)
        guard cut > 0 else { return nil }

        let out = String(decoding: pending[..<cut], as: UTF8.self)
        pending.removeFirst(cut)
        return out
    }

    /// The stream is over: decode whatever is held, lossily if it was cut.
    mutating func flush() -> String? {
        guard !pending.isEmpty else { return nil }
        let out = String(decoding: pending, as: UTF8.self)
        pending = []
        return out
    }

    private static func completePrefixLength(_ bytes: [UInt8]) -> Int {
        var lead = bytes.count - 1
        // Walk back over up to three continuation bytes to the lead byte.
        while lead >= 0, bytes.count - lead <= 3, bytes[lead] & 0b1100_0000 == 0b1000_0000 {
            lead -= 1
        }
        guard lead >= 0 else { return bytes.count } // malformed; decode lossily

        let expected: Int
        switch bytes[lead] {
        case ..<0x80: expected = 1
        case 0b1100_0000...0b1101_1111: expected = 2
        case 0b1110_0000...0b1110_1111: expected = 3
        case 0b1111_0000...0b1111_0111: expected = 4
        default: expected = 1 // malformed lead; decode lossily
        }

        return bytes.count - lead < expected ? lead : bytes.count
    }
}

/// The production fetcher: URLSession, streamed through a per-task delegate
/// so chunks arrive as the network delivers them — what an SSE model stream
/// needs. Text only, per the contract; bytes are decoded on UTF-8 boundaries
/// before they cross into JS.
public final class URLSessionFetcher: EngineFetcher {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func start(
        _ request: EngineFetchRequest,
        onResponse: @escaping (EngineFetchResponseHead) -> Void,
        onChunk: @escaping (String) -> Void,
        onEnd: @escaping () -> Void,
        onError: @escaping (String) -> Void
    ) -> EngineFetchHandle {
        guard let url = URL(string: request.url), url.scheme != nil else {
            // Asynchronously, so the caller holds its handle before hearing.
            DispatchQueue.global().async { onError("not a fetchable URL: \(request.url)") }
            return NoopHandle()
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        if let body = request.body {
            urlRequest.httpBody = Data(body.utf8)
        }

        let task = session.dataTask(with: urlRequest)
        // The task retains its delegate until completion — exactly the
        // lifetime the stream needs, with no registry to clean up.
        task.delegate = StreamDelegate(
            onResponse: onResponse, onChunk: onChunk, onEnd: onEnd, onError: onError
        )
        task.resume()
        return TaskHandle(task: task)
    }

    private struct TaskHandle: EngineFetchHandle {
        let task: URLSessionTask
        func cancel() { task.cancel() }
    }

    private struct NoopHandle: EngineFetchHandle {
        func cancel() {}
    }

    private final class StreamDelegate: NSObject, URLSessionDataDelegate {
        private let onResponse: (EngineFetchResponseHead) -> Void
        private let onChunk: (String) -> Void
        private let onEnd: () -> Void
        private let onError: (String) -> Void
        private var decoder = UTF8ChunkDecoder()
        private var finished = false

        init(
            onResponse: @escaping (EngineFetchResponseHead) -> Void,
            onChunk: @escaping (String) -> Void,
            onEnd: @escaping () -> Void,
            onError: @escaping (String) -> Void
        ) {
            self.onResponse = onResponse
            self.onChunk = onChunk
            self.onEnd = onEnd
            self.onError = onError
        }

        func urlSession(
            _ session: URLSession, dataTask: URLSessionDataTask,
            didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            let http = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (name, value) in http?.allHeaderFields ?? [:] {
                if let name = name as? String, let value = value as? String {
                    headers[name.lowercased()] = value
                }
            }
            onResponse(EngineFetchResponseHead(status: http?.statusCode ?? 200, headers: headers))
            completionHandler(.allow)
        }

        func urlSession(
            _ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data
        ) {
            if let text = decoder.decode(data) {
                onChunk(text)
            }
        }

        func urlSession(
            _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
        ) {
            guard !finished else { return }
            finished = true

            if let error {
                onError(error.localizedDescription)
                return
            }
            if let tail = decoder.flush() {
                onChunk(tail)
            }
            onEnd()
        }
    }
}
