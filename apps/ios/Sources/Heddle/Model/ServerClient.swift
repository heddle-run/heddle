import Foundation
import HeddleCore

/// The slice of `GET /v1/capabilities` the app reads
/// (`packages/server/src/capabilities.ts`).
struct ServerCapabilities: Decodable {
    struct Sessions: Decodable {
        var enabled: Bool
        var store: String?
    }

    struct Bundles: Decodable {
        var enabled: Bool
        var maxBytes: Int?
        var store: Bool?
    }

    var version: String
    var sessions: Sessions?
    var acceptsFlowPath: Bool?
    var protocols: [String]?
    var formats: [String]?
    var bundles: Bundles?

    var sessionsEnabled: Bool { sessions?.enabled == true }
    /// Absent means an older server that predates `/v1/bundles`.
    var bundlesEnabled: Bool { bundles?.enabled == true }
}

/// The body of `POST /v1/runs` (`RunRequest`, `packages/server/src/runs.ts`).
///
/// Exactly one of `flow` / `flowPath`; `resume` and `answer` only mean
/// something beside a `session`, and the session id must be one this server
/// minted — `POST /v1/sessions` first, the store refuses caller-chosen ids
/// (unlike the CLI's, which is why the macOS app can mint its own).
struct RunRequest: Encodable {
    var flow: JSONValue?
    var flowPath: String?
    var format: String?
    /// A stored bundle's id from `POST /v1/bundles` — the server runs what
    /// it extracted at upload. Exclusive with `flow`/`flowPath`; a resumed
    /// bundle conversation must carry it again (`packages/server/src/runs.ts`).
    var bundle: String?
    var inputs: [String: JSONValue]?
    var session: String?
    var resume: Bool?
    var answer: JSONValue?
}

/// What `POST /v1/bundles` answers: the content-addressed id to run by,
/// and the server's own read of the archive.
struct BundleUpload: Decodable {
    var id: String
    var name: String?
    var portable: Bool?
}

enum ServerClientError: LocalizedError {
    case noServer
    case http(status: Int, message: String)
    case notHTTP

    var errorDescription: String? {
        switch self {
        case .noServer:
            return "no server configured — set one in Settings"
        case .http(let status, let message):
            return message.isEmpty ? "server returned \(status)" : message
        case .notHTTP:
            return "the server gave a non-HTTP response"
        }
    }
}

/// The app's whole view of a heddle server: plain HTTP plus one SSE stream
/// per run. No SDK, no WebSocket — the server speaks nothing the URL loading
/// system does not already know.
struct ServerClient {
    var baseURL: URL
    var token: String?

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    func capabilities() async throws -> ServerCapabilities {
        let (data, response) = try await URLSession.shared.data(
            for: request(path: "/v1/capabilities")
        )
        try Self.check(response, data: data)
        return try Self.decoder.decode(ServerCapabilities.self, from: data)
    }

    /// Mints a conversation id. The server issues ids and never accepts one
    /// (`packages/server/src/sessions.ts`); the hint is what
    /// `GET /v1/sessions/<id>` later reports the conversation was with.
    func createSession(flowHint: String?) async throws -> String {
        struct Minted: Decodable { var id: String }

        var req = request(path: "/v1/sessions")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = flowHint.flatMap {
            try? Self.encoder.encode(["flow": $0])
        } ?? Data("{}".utf8)

        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.check(response, data: data)
        return try Self.decoder.decode(Minted.self, from: data).id
    }

    /// Sends a `.heddle` archive to the server's store; the id that comes
    /// back is content-addressed, so re-uploading the same bytes is free and
    /// answers the same id (`packages/server/src/bundles.ts`).
    func uploadBundle(_ archive: Data) async throws -> BundleUpload {
        var req = request(path: "/v1/bundles")
        req.httpMethod = "POST"
        req.setValue("application/x-heddle", forHTTPHeaderField: "content-type")
        req.httpBody = archive
        req.timeoutInterval = 300

        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.check(response, data: data)
        return try Self.decoder.decode(BundleUpload.self, from: data)
    }

    /// Starts a run and yields its frames as the server writes them.
    ///
    /// A flow that does not compile is a real 400 before any SSE bytes
    /// (`runStreaming`, `packages/server/src/runs.ts`), so an HTTP error here
    /// throws with the server's message; after 200 the stream itself carries
    /// any failure as `error` / `node_error` frames. `EventSource` cannot
    /// POST, hence the hand-rolled parse over `URLSession.bytes`.
    func stream(_ body: RunRequest) async throws -> AsyncThrowingStream<RunFrame, Error> {
        var req = request(path: "/v1/runs", query: [URLQueryItem(name: "stream", value: "true")])
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.httpBody = try Self.encoder.encode(body)
        req.timeoutInterval = 60 * 60

        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        guard let http = response as? HTTPURLResponse else { throw ServerClientError.notHTTP }
        guard http.statusCode == 200 else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            throw Self.error(status: http.statusCode, data: data)
        }

        return AsyncThrowingStream { continuation in
            let task = Task {
                var parser = SSEParser()
                var line = [UInt8]()
                do {
                    for try await byte in bytes {
                        if byte == UInt8(ascii: "\n") {
                            let text = String(decoding: line, as: UTF8.self)
                            line.removeAll(keepingCapacity: true)
                            if let event = parser.consume(line: text),
                               let frame = RunFrame(sse: event)
                            {
                                continuation.yield(frame)
                            }
                        } else if byte != UInt8(ascii: "\r") {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func request(path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(
            url: baseURL, resolvingAgainstBaseURL: false
        ) ?? URLComponents()
        components.path = path
        if !query.isEmpty { components.queryItems = query }

        var req = URLRequest(url: components.url ?? baseURL)
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw ServerClientError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            throw error(status: http.statusCode, data: data)
        }
    }

    /// Error bodies are `{"error": {"type", "message"}}` (`toErrorResponse`,
    /// `packages/server/src/errors.ts`); anything else is quoted as-is.
    private static func error(status: Int, data: Data) -> ServerClientError {
        struct Body: Decodable {
            struct Inner: Decodable { var message: String? }
            var error: Inner?
        }
        let message =
            (try? decoder.decode(Body.self, from: data))?.error?.message
            ?? String(data: data, encoding: .utf8)
            ?? ""
        return .http(status: status, message: message)
    }
}
