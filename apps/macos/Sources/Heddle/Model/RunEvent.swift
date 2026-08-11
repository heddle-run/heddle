import Foundation

/// One line of `--protocol heddle` output: `{"event": <type>, "data": {…}}`.
///
/// The frame is `frameLine` in `packages/cli/src/cli/encoders.ts`; the data
/// is `serializeEvent` in `packages/core/src/plugin/encoder.ts` — the event's
/// own fields, with `state` flattened to plain data.
struct RunFrame: Decodable {
    var event: String?
    var data: JSONValue
}

/// What a run's transcript is made of, reduced to what the window renders.
struct TranscriptItem: Identifiable, Equatable {
    enum Kind: Equatable {
        case nodeStart(name: String)
        case toolCall(name: String)
        case output
        case note
        case failure
    }

    let id: UUID
    let kind: Kind
    var text: String

    init(id: UUID = UUID(), kind: Kind, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

/// What a `suspended` frame carries: the run stopped for a person.
///
/// The CLI writes it to the stream and exits 0 — the turn stays open in the
/// session, and `--resume --answer '<json>'` continues it
/// (`reportSuspension`, `packages/cli/src/cli/run.ts`).
struct Suspension: Equatable {
    let session: String
    let by: String
    let ask: JSONValue

    var question: String {
        ask.objectValue?["question"]?.stringValue ?? by + " is asking"
    }
}

/// Folds the frame stream into a transcript and a final state.
///
/// Kept apart from the process plumbing so it is testable with strings: feed
/// lines, read items. `token_delta` frames coalesce into one growing output
/// item per node rather than one row per token.
struct FrameReducer {
    private(set) var items: [TranscriptItem] = []
    private(set) var finalState: JSONValue?
    private(set) var failure: String?
    private(set) var suspension: Suspension?

    private var streamingNode: String?
    private static let decoder = JSONDecoder()

    mutating func consume(line: Substring) {
        guard !line.isEmpty,
              let frame = try? Self.decoder.decode(RunFrame.self, from: Data(line.utf8))
        else { return }
        consume(frame: frame)
    }

    mutating func consume(frame: RunFrame) {
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

        default:
            break
        }
    }

    /// The state keys worth showing: what the CLI prints, minus bookkeeping.
    ///
    /// Mirrors core's `withoutReserved` (`packages/core/src/session/
    /// reserved.ts`): exactly `_chat_history` and `_resume`, the two keys the
    /// runtime claims for itself.
    private func withoutReserved(_ state: JSONValue) -> JSONValue {
        guard let object = state.objectValue else { return state }
        let reserved: Set<String> = ["_chat_history", "_resume"]
        return .object(object.filter { !reserved.contains($0.key) })
    }
}
