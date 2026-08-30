import Foundation
import HeddleCore
import Observation

/// This app's runs: heddle-core's record over this app's agent — a flow the
/// server can be asked to run. The record's session is one the server keeps.
typealias RunRecord = HeddleCore.RunRecord<Agent>

/// Sends `POST /v1/runs?stream=true` per tap and folds the SSE frames into
/// records — or, for a portable bundle agent, feeds the same reducer from
/// the embedded engine's stream instead.
///
/// Request-per-run is the concurrency model: each run is its own streaming
/// request (or engine run) with its own lifetime, and cancelling one is
/// cancelling one request. The macOS app does the same with one CLI process
/// per run; the reducer between transport and record is heddle-core's,
/// shared — which is why `RunDetailView` cannot tell the transports apart.
@MainActor
@Observable
final class RunStore {
    /// The local transport, injected so tests can substitute a canned
    /// stream of frame lines for the JavaScript engine.
    typealias LocalRun = (HeddleEngine.RunConfig, _ roots: [URL]) throws
        -> AsyncThrowingStream<String, Error>

    private(set) var runs: [RunRecord] = []

    @ObservationIgnored
    private var tasks: [UUID: Task<Void, Never>] = [:]

    /// One-shot continuations, keyed by record — how a chat turn learns its
    /// run settled. Distinct from `onFinish`, which sees every run.
    @ObservationIgnored
    private var completions: [UUID: (RunRecord) -> Void] = [:]

    var onFinish: ((RunRecord) -> Void)?

    private let settings: ServerSettings
    private let bundles: BundleStore
    private let localRun: LocalRun

    init(
        settings: ServerSettings,
        bundles: BundleStore = BundleStore(),
        localRun: @escaping LocalRun = { config, roots in
            try LocalEngine.shared.run(config, roots: roots)
        }
    ) {
        self.settings = settings
        self.bundles = bundles
        self.localRun = localRun
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

    /// A conversation id for this agent. Server flows ask the server —
    /// sessions are server-minted (`packages/server/src/sessions.ts` refuses
    /// caller-chosen ids), and they only exist at all when it runs with
    /// `--session-store`. A bundle's sessions are this phone's own, so the
    /// id is minted here, in the shape core's `assertSessionId`
    /// (`packages/core/src/session/store.ts`) accepts: letters, digits,
    /// "-", starting with a letter.
    func mintSession(for agent: Agent) async throws -> String {
        // Only a *portable* bundle's sessions are this phone's own. A bundle
        // that falls back to the server converses there, so its session is
        // server-minted like any other server flow's.
        if case .bundle = agent.source, agent.portability?.portable == true {
            return "local-" + UUID().uuidString.lowercased()
        }
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
        if case .bundle(let bundleID) = record.agent.source {
            runLocally(
                record: record, bundleID: bundleID,
                input: input, resume: resume, answer: answer
            )
            return
        }

        guard let client = settings.client else {
            record.status = .failed(ServerClientError.noServer.localizedDescription)
            record.endedAt = Date()
            return
        }

        var body = RunRequest()
        switch record.agent.source {
        case .serverPath(let path): body.flowPath = path
        case .inline(let text): body.flow = .string(text)
        case .bundle: return  // took the local branch above
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

    /// A bundle agent's run: the embedded engine instead of the server, its
    /// frame lines fed to the exact reducer-and-finish path the SSE frames
    /// take — so the transcript, the ask card, and the chat behave
    /// identically whichever side ran the flow.
    private func runLocally(
        record: RunRecord,
        bundleID: String,
        input: [String: JSONValue]?,
        resume: Bool,
        answer: JSONValue?
    ) {
        guard record.agent.portability?.portable == true else {
            runViaServer(
                record: record, bundleID: bundleID,
                input: input, resume: resume, answer: answer
            )
            return
        }

        let recordID = record.id
        let sessionID = record.sessionID
        // A resume keeps its record, exactly as the server path does.
        let baseItems = record.items
        let extracted = bundles.extractedDir(forBundleID: bundleID)

        tasks[recordID] = Task { [weak self, localRun] in
            var reducer = FrameReducer()
            var transportFailure: String?
            do {
                let runID = "run-" + recordID.uuidString.lowercased()
                let scratch = try LocalRunAssembly.makeScratchDirectory(runID: runID)
                let config = try LocalRunAssembly.config(
                    runID: runID,
                    extractedDir: extracted,
                    scratchDir: scratch,
                    inputs: input ?? [:],
                    session: sessionID,
                    resume: resume,
                    answer: answer
                )
                let lines = try localRun(config, [extracted, scratch])
                for try await line in lines {
                    reducer.consume(line: Substring(line))
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

    /// A bundle that cannot run on this device runs on the user's server
    /// instead: the archive uploads once (content-addressed, so a repeat is
    /// free), its id is remembered on the agent, and every run names it. A
    /// remembered id the server no longer holds — its store is under tmp,
    /// wiped on reboot — 404s once, re-uploads, and carries on.
    private func runViaServer(
        record: RunRecord,
        bundleID: String,
        input: [String: JSONValue]?,
        resume: Bool,
        answer: JSONValue?
    ) {
        let reasons = record.agent.portability?.reasons
            .map(\.label).joined(separator: "; ")

        guard let client = settings.client else {
            record.status = .failed(
                "this bundle cannot run on this device"
                    + (reasons.map { " — \($0)" } ?? "")
                    + ", and no server is configured. Set one in Settings."
            )
            record.endedAt = Date()
            return
        }

        let recordID = record.id
        let agent = record.agent
        let sessionID = record.sessionID
        let baseItems = record.items

        tasks[recordID] = Task { [weak self] in
            var reducer = FrameReducer()
            var transportFailure: String?
            do {
                var serverID = agent.serverBundleID
                if serverID == nil {
                    serverID = try await self?.upload(
                        agent: agent, bundleID: bundleID, to: client)
                }
                var body = RunRequest()
                body.bundle = serverID
                if let input, !input.isEmpty { body.inputs = input }
                body.session = sessionID
                if resume { body.resume = true }
                body.answer = answer

                var frames: AsyncThrowingStream<RunFrame, Error>
                do {
                    frames = try await client.stream(body)
                } catch ServerClientError.http(let status, _) where status == 404 {
                    // The remembered id went with the server's store; upload
                    // again and repeat once.
                    serverID = try await self?.upload(
                        agent: agent, bundleID: bundleID, to: client, force: true)
                    body.bundle = serverID
                    frames = try await client.stream(body)
                }
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

    /// How an agent learns its server-side id — persisted by whoever owns
    /// the agent list, injected because this store holds runs, not agents.
    var onServerBundleID: ((Agent, String) -> Void)?

    private func upload(
        agent: Agent,
        bundleID: String,
        to client: ServerClient,
        force: Bool = false
    ) async throws -> String {
        if !force, let known = agent.serverBundleID { return known }

        let archive = try Data(contentsOf: bundles.archiveURL(forBundleID: bundleID))
        let uploaded = try await client.uploadBundle(archive)
        onServerBundleID?(agent, uploaded.id)
        return uploaded.id
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
