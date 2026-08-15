import Foundation
import HeddleCore
import Observation

/// One conversation with one agent, request-per-turn.
///
/// Each message becomes one streaming run against the same server session;
/// the session on the server carries the history between requests, so the
/// controller holds only what the screen shows. The id is minted by the
/// server on the first message — `POST /v1/sessions` — because its store
/// refuses caller-chosen ids (`packages/server/src/sessions.ts`), where the
/// CLI's store lets the macOS app bring its own.
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

    private(set) var sessionID: String?
    private(set) var messages: [Message] = []
    private(set) var activeRun: RunRecord?
    /// Set while the run waits on a person; the screen renders the ask.
    private(set) var pendingAsk: Suspension?
    /// True between the send and the run's first frame — the mint of the
    /// session id is a request of its own, and the screen should show a
    /// turn in flight for the whole round trip.
    private var starting = false

    private let runs: RunStore

    init(agent: Agent, runs: RunStore) {
        self.agent = agent
        self.runs = runs
    }

    var isBusy: Bool { starting || activeRun?.isRunning == true }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isBusy, pendingAsk == nil else { return }

        messages.append(Message(role: .user, text: trimmed))
        starting = true
        Task {
            do {
                let session: String
                if let sessionID {
                    session = sessionID
                } else {
                    session = try await runs.mintSession(for: agent)
                    sessionID = session
                }
                let record = runs.start(
                    agent: agent,
                    input: [agent.inputKey: .string(trimmed)],
                    session: session
                )
                watch(record)
            } catch {
                messages.append(Message(role: .system, text: error.localizedDescription))
            }
            starting = false
        }
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
