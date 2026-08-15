import Foundation

/// One frame of a streamed run: an event name and its data.
///
/// The data is `serializeEvent` (`packages/core/src/plugin/encoder.ts`) — the
/// event's own fields, with `state` flattened to plain data. Every front end
/// receives exactly this shape; only the wire differs. The CLI's `--protocol
/// heddle` writes it one JSON frame per line on stdout (`frameLine`,
/// `packages/cli/src/cli/encoders.ts`); `heddle-server` writes it as SSE with
/// the name in the `event:` field. Which is why one reducer serves both apps:
/// the transports differ, the frames do not.
public struct RunFrame: Decodable {
    public var event: String?
    public var data: JSONValue

    public init(event: String?, data: JSONValue) {
        self.event = event
        self.data = data
    }

    public init?(sse: SSEEvent) {
        guard let data = try? JSONDecoder().decode(
            JSONValue.self, from: Data(sse.data.utf8)
        ) else { return nil }
        self.init(event: sse.event, data: data)
    }
}

/// What a run's transcript is made of, reduced to what the UI renders.
public struct TranscriptItem: Identifiable, Equatable {
    public enum Kind: Equatable {
        case nodeStart(name: String)
        case toolCall(name: String)
        case output
        case note
        case failure
    }

    public let id: UUID
    public let kind: Kind
    public var text: String

    public init(id: UUID = UUID(), kind: Kind, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

/// What a `suspended` frame carries: the run stopped for a person.
///
/// The CLI writes it to the stream and exits 0 — the turn stays open in the
/// session, and `--resume --answer '<json>'` continues it
/// (`reportSuspension`, `packages/cli/src/cli/run.ts`). The server writes it
/// and closes the stream — a new `/v1/runs` request with `resume` and an
/// `answer` continues it (`runStreaming`, `packages/server/src/runs.ts`).
public struct Suspension: Equatable {
    public let session: String
    public let by: String
    public let ask: JSONValue

    public init(session: String, by: String, ask: JSONValue) {
        self.session = session
        self.by = by
        self.ask = ask
    }

    public var question: String {
        ask.objectValue?["question"]?.stringValue ?? by + " is asking"
    }
}

/// Folds the frame stream into a transcript and a final state.
///
/// Kept apart from the transport so it is testable with strings: feed lines
/// or frames, read items. `token_delta` frames coalesce into one growing
/// output item per node rather than one row per token.
public struct FrameReducer {
    public private(set) var items: [TranscriptItem] = []
    public private(set) var finalState: JSONValue?
    public private(set) var failure: String?
    public private(set) var suspension: Suspension?
    /// A `flow_complete` frame arrived: the run ran to its end. Without it,
    /// a cleanly closed stream still means an unfinished run.
    public private(set) var completed = false
    /// The server's terminal `error` frame, sent when the run itself failed
    /// after the SSE headers were already out (`runStreaming`,
    /// `packages/server/src/runs.ts`). The CLI never writes one — its
    /// failures arrive on stderr and in the exit status.
    public private(set) var streamError: String?

    private var streamingNode: String?
    private static let decoder = JSONDecoder()

    public init() {}

    public mutating func consume(line: Substring) {
        guard !line.isEmpty,
              let frame = try? Self.decoder.decode(RunFrame.self, from: Data(line.utf8))
        else { return }
        consume(frame: frame)
    }

    public mutating func consume(frame: RunFrame) {
        let data = frame.data.objectValue ?? [:]
        switch frame.event {
        case "node_start":
            streamingNode = nil
            if let name = data["nodeName"]?.stringValue {
                items.append(TranscriptItem(kind: .nodeStart(name: name), text: name))
            }

        case "token_delta":
            guard let delta = data["delta"]?.stringValue else { return }
            let node = data["nodeName"]?.stringValue
            if streamingNode == node, let last = items.indices.last,
               items[last].kind == .output
            {
                items[last].text += delta
            } else {
                streamingNode = node
                items.append(TranscriptItem(kind: .output, text: delta))
            }

        case "tool_call":
            streamingNode = nil
            let name = data["toolName"]?.stringValue ?? "tool"
            items.append(TranscriptItem(kind: .toolCall(name: name), text: name))

        case "node_error":
            streamingNode = nil
            let message =
                data["error"]?.objectValue?["message"]?.stringValue
                ?? data["message"]?.stringValue
                ?? "node failed"
            failure = message
            items.append(TranscriptItem(kind: .failure, text: message))

        case "warning":
            if let message = data["message"]?.stringValue {
                items.append(TranscriptItem(kind: .note, text: message))
            }

        case "flow_complete":
            streamingNode = nil
            completed = true
            finalState = data["state"].map(withoutReserved)

        case "suspended":
            streamingNode = nil
            let suspended = Suspension(
                session: data["session"]?.stringValue ?? "",
                by: data["by"]?.stringValue ?? "middleware",
                ask: data["ask"] ?? .null
            )
            suspension = suspended
            items.append(TranscriptItem(kind: .note, text: "Stopped: \(suspended.question)"))

        case "error":
            streamingNode = nil
            let message = data["message"]?.stringValue ?? "run failed"
            streamError = message
            items.append(TranscriptItem(kind: .failure, text: message))

        default:
            break
        }
    }

    /// The state keys worth showing: what the CLI prints, minus bookkeeping.
    ///
    /// Mirrors core's `withoutReserved` (`packages/core/src/session/
    /// reserved.ts`): exactly `_chat_history` and `_resume`, the two keys the
    /// runtime claims for itself. The server strips them itself on the
    /// session path; stripping here too keeps sessionless runs consistent.
    private func withoutReserved(_ state: JSONValue) -> JSONValue {
        guard let object = state.objectValue else { return state }
        let reserved: Set<String> = ["_chat_history", "_resume"]
        return .object(object.filter { !reserved.contains($0.key) })
    }
}
