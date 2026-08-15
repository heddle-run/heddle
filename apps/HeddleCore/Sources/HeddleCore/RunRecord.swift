import Foundation
import Observation

/// What core needs to know about the thing a run runs: a display name.
///
/// Each front end brings its own agent type — a `.heddle` bundle or flow
/// file on disk for the menu bar app, a saved server flow for the phone —
/// and conforms it. Everything transport-shaped about an agent stays in the
/// app that owns the transport.
public protocol RunAgent {
    var name: String { get }
}

/// One run of one agent, as the UI sees it.
///
/// The record is transport-blind: a store folds frames into it whether they
/// arrived from a spawned CLI process or a streaming HTTP request, and the
/// windows read the same fields either way.
@MainActor
@Observable
public final class RunRecord<Agent: RunAgent>: Identifiable {
    public enum Status: Equatable {
        case running
        case succeeded
        case failed(String)
        /// Stopped for a person; the session holds the open turn.
        case suspended(Suspension)
    }

    public let id = UUID()
    public let agent: Agent
    /// Set when this run belongs to a conversation — always set for chat
    /// turns. Minting one the moment a run suspends is not possible, so any
    /// agent that *could* suspend should be given one.
    public let sessionID: String?
    /// Flags every relaunch of this record repeats — a resume needs the same
    /// plugins loaded as the run that suspended, or nothing is there to
    /// consume the answer. Meaningful to a transport that spawns per run
    /// (the CLI); a request-per-run transport leaves it empty, because its
    /// resume re-sends the flow source instead.
    public let extraArguments: [String]
    public let startedAt = Date()
    public var endedAt: Date?
    public var status: Status = .running
    public var items: [TranscriptItem] = []
    public var finalState: JSONValue?

    public init(agent: Agent, sessionID: String?, extraArguments: [String] = []) {
        self.agent = agent
        self.sessionID = sessionID
        self.extraArguments = extraArguments
    }

    public var agentName: String { agent.name }
    public var isRunning: Bool { status == .running }

    public var suspension: Suspension? {
        if case .suspended(let suspension) = status { return suspension }
        return nil
    }

    /// The one line a menu item, list row, or notification leads with.
    public var summary: String {
        switch status {
        case .running: return "Running…"
        case .failed(let message): return message
        case .suspended(let suspension): return suspension.question
        case .succeeded:
            if let object = finalState?.objectValue, let first = object.values.first,
               object.count == 1
            {
                return first.displayText
            }
            return finalState.map { $0.prettyJSON(compact: true) } ?? "Done"
        }
    }

    /// The repo's own rendering rule for a turn's answer — `answerOf` in
    /// `packages/core/src/session/turn.ts`: `result` when it is a string,
    /// the whole output otherwise. The streamed text is the fallback for a
    /// run that produced no state.
    public var answerText: String {
        if let result = finalState?.objectValue?["result"]?.stringValue {
            return result
        }
        if let state = finalState {
            return state.prettyJSON(compact: true)
        }
        let streamed = items
            .filter { $0.kind == .output }
            .map(\.text)
            .joined()
        return streamed.isEmpty ? "(no output)" : streamed
    }
}

/// Identity equality: a record is one live run, so two records are equal
/// only when they are the same object — what `navigationDestination(item:)`
/// and friends ask of a class.
extension RunRecord: Hashable {
    public nonisolated static func == (lhs: RunRecord, rhs: RunRecord) -> Bool {
        lhs === rhs
    }

    public nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
}
