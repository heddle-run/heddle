import Foundation
import HeddleCore
import Observation

/// This app's runs: heddle-core's record over this app's agent — a flow the
/// server can be asked to run. The record's session is one the server keeps.
typealias RunRecord = HeddleCore.RunRecord<Agent>

/// Sends `POST /v1/runs?stream=true` per tap and folds the SSE frames into
/// records.
///
/// Request-per-run is the concurrency model: each run is its own streaming
/// request with its own lifetime, exactly as the server sees the world, and
/// cancelling one is cancelling one request. The macOS app does the same
/// with one CLI process per run; the reducer between transport and record
/// is heddle-core's, shared.
@MainActor
@Observable
final class RunStore {
    private(set) var runs: [RunRecord] = []

    @ObservationIgnored
    private var tasks: [UUID: Task<Void, Never>] = [:]

    /// One-shot continuations, keyed by record — how a chat turn learns its
    /// run settled. Distinct from `onFinish`, which sees every run.
    @ObservationIgnored
    private var completions: [UUID: (RunRecord) -> Void] = [:]

    var onFinish: ((RunRecord) -> Void)?

    private let settings: ServerSettings

    init(settings: ServerSettings) {
        self.settings = settings
    }

    var running: [RunRecord] { runs.filter(\.isRunning) }
    var finished: [RunRecord] { runs.filter { !$0.isRunning } }
    var needingAnswer: [RunRecord] { runs.filter { $0.suspension != nil } }

    /// Called once when the record leaves `.running`, after status is set.
    func onCompletion(of record: RunRecord, perform: @escaping (RunRecord) -> Void) {
        if record.isRunning {
            completions[record.id] = perform
        } else {
            perform(record)
        }
    }

    /// Asks the server for a conversation id. Sessions are server-minted
    /// (`packages/server/src/sessions.ts` refuses caller-chosen ids), and
    /// they only exist at all when it runs with `--session-store`.
    func mintSession(for agent: Agent) async throws -> String {
        guard let client = settings.client else { throw ServerClientError.noServer }
        return try await client.createSession(flowHint: agent.name)
    }

    @discardableResult
    func start(
        agent: Agent,
        input: [String: JSONValue]? = nil,
        session: String? = nil
    ) -> RunRecord {
        let record = RunRecord(agent: agent, sessionID: session)
        runs.insert(record, at: 0)
        run(record: record, input: input, resume: false, answer: nil)
        return record
    }

    /// Continue a suspended run with what the person said, on the same
    /// record: the transcript grows, the status returns to running. The
    /// request repeats the flow source — the server compiles per request and
    /// holds nothing between them, the session checkpoint aside.
    func answer(_ record: RunRecord, with answer: JSONValue) {
        guard record.suspension != nil, record.sessionID != nil else { return }
        record.status = .running
        record.endedAt = nil
        run(record: record, input: nil, resume: true, answer: answer)
    }

    private func run(
        record: RunRecord,
        input: [String: JSONValue]?,
        resume: Bool,
        answer: JSONValue?
    ) {
        guard let client = settings.client else {
            record.status = .failed(ServerClientError.noServer.localizedDescription)
            record.endedAt = Date()
            return
        }

        var body = RunRequest()
        switch record.agent.source {
        case .serverPath(let path): body.flowPath = path
        case .inline(let text): body.flow = .string(text)
        }
        if let input, !input.isEmpty { body.inputs = input }
        body.session = record.sessionID
        if resume { body.resume = true }
        body.answer = answer

        let recordID = record.id
        // A resume keeps its record: what streamed before the suspension
        // stays, and this request's frames append after it.
        let baseItems = record.items

        tasks[recordID] = Task { [weak self] in
            var reducer = FrameReducer()
            var transportFailure: String?
            do {
                let frames = try await client.stream(body)
                for try await frame in frames {
                    reducer.consume(frame: frame)
                    self?.apply(reducer, to: recordID, over: baseItems)
                }
            } catch is CancellationError {
                transportFailure = "cancelled"
            } catch {
                transportFailure = error.localizedDescription
            }
            self?.finish(
                recordID, reducer: reducer, over: baseItems,
                transportFailure: transportFailure
            )
        }
    }

    func cancel(_ record: RunRecord) {
        tasks[record.id]?.cancel()
    }

    func cancelAll() {
        for task in tasks.values { task.cancel() }
    }

    private func record(_ id: UUID) -> RunRecord? {
        runs.first { $0.id == id }
    }

    private func apply(_ reducer: FrameReducer, to id: UUID, over base: [TranscriptItem]) {
        guard let record = record(id) else { return }
        record.items = base + reducer.items
    }

    private func finish(
        _ id: UUID,
        reducer: FrameReducer,
        over base: [TranscriptItem],
        transportFailure: String?
    ) {
        tasks[id] = nil
        guard let record = record(id) else { return }

        record.items = base + reducer.items
        record.finalState = reducer.finalState
        record.endedAt = Date()

        // The frames say how it ended. A suspension beats everything — the
        // turn is open and waiting. An `error` frame is the server's own
        // verdict. `flow_complete` means done even when a node failed along
        // the way and was retried. A stream that ended with none of the
        // three did not finish, whatever the transport thought of it.
        if let suspension = reducer.suspension {
            record.status = .suspended(suspension)
        } else if let message = reducer.streamError {
            record.status = .failed(message)
        } else if reducer.completed {
            record.status = .succeeded
        } else {
            record.status = .failed(
                transportFailure
                    ?? reducer.failure
                    ?? "the stream ended before the flow finished"
            )
        }

        onFinish?(record)
        completions.removeValue(forKey: id)?(record)
    }
}
