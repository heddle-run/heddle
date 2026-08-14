import Foundation
import HeddleCore
import Observation

/// One conversation with one agent, process-per-turn.
///
/// Each message spawns `heddle run <agent> --session <id> --protocol heddle
/// --input {...}`; the session on disk carries the history between spawns,
/// so the controller holds only what the window shows. The session id is
/// minted here — the store honours caller-chosen ids
/// (`selectSession`, `packages/cli/src/cli/sessions.ts`).
@MainActor
@Observable
final class ChatController {
    struct Message: Identifiable, Equatable {
        enum Role: Equatable {
            case user
            case assistant
            case system
        }

        let id = UUID()
        let role: Role
        var text: String
    }

    let agent: Agent
    let sessionID: String

    private(set) var messages: [Message] = []
    private(set) var activeRun: RunRecord?
    /// Set while the run waits on a person; the window renders the ask.
    private(set) var pendingAsk: Suspension?

    private let runs: RunStore

    /// The key each message is sent under: the CLI's chat derives it from
    /// the flow's StartNode (`detectInputKey`, `run.ts`). The app cannot
    /// parse the flow, so it approximates: a single recorded input key is
    /// that key, anything else is the CLI's default `query`.
    let inputKey: String

    init(agent: Agent, runs: RunStore) {
        self.agent = agent
        self.runs = runs
        self.sessionID = "app-" + UUID().uuidString.lowercased()
        self.inputKey =
            agent.defaultInput?.count == 1
            ? agent.defaultInput!.keys.first!
            : "query"
    }

    var isBusy: Bool { activeRun?.isRunning == true }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isBusy, pendingAsk == nil else { return }

        messages.append(Message(role: .user, text: trimmed))
        let record = runs.start(
            agent: agent,
            input: [inputKey: .string(trimmed)],
            session: sessionID
        )
        watch(record)
    }

    func answer(_ value: JSONValue) {
        guard let record = activeRun ?? runs.needingAnswer.first(where: {
            $0.sessionID == sessionID
        }) else { return }

        pendingAsk = nil
        runs.answer(record, with: value)
        watch(record)
    }

    private func watch(_ record: RunRecord) {
        activeRun = record
        runs.onCompletion(of: record) { [weak self] settled in
            self?.settled(settled)
        }
    }

    private func settled(_ record: RunRecord) {
        switch record.status {
        case .running:
            return
        case .suspended(let suspension):
            pendingAsk = suspension
        case .succeeded:
            messages.append(Message(role: .assistant, text: record.answerText))
            activeRun = nil
        case .failed(let message):
            messages.append(Message(role: .system, text: message))
            activeRun = nil
        }
    }
}
