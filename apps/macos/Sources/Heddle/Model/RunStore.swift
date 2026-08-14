import Foundation
import HeddleCore
import Observation

/// This app's runs: heddle-core's record over this app's agent — a bundle
/// or flow file on disk. `extraArguments` carries the flags every spawn of
/// a record repeats; bundles carry theirs inside the archive, so these are
/// for bare flows (and tests) that take them from the command line.
typealias RunRecord = HeddleCore.RunRecord<Agent>

/// Spawns `heddle run` per click and folds its stdout into records.
///
/// Process-per-run is the concurrency model: each run is its own CLI
/// invocation with its own lifetime, exactly as if typed in a terminal, and
/// cancelling one is terminating one process.
@MainActor
@Observable
final class RunStore {
    private(set) var runs: [RunRecord] = []

    @ObservationIgnored
    private var processes: [UUID: Process] = [:]

    /// One-shot continuations, keyed by record — how a chat turn learns its
    /// run settled. Distinct from `onFinish`, which is the app-wide observer
    /// (notifications) and sees every run.
    @ObservationIgnored
    private var completions: [UUID: (RunRecord) -> Void] = [:]

    var onFinish: ((RunRecord) -> Void)?

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

    @discardableResult
    func start(
        agent: Agent,
        input: [String: JSONValue]? = nil,
        session: String? = nil,
        resume: Bool = false,
        answer: JSONValue? = nil,
        extraArguments: [String] = []
    ) -> RunRecord {
        let record = RunRecord(
            agent: agent, sessionID: session, extraArguments: extraArguments
        )
        runs.insert(record, at: 0)
        run(record: record, input: input, resume: resume, answer: answer)
        return record
    }

    /// Continue a suspended run with what the person said, on the same
    /// record: the transcript grows, the status returns to running — the GUI
    /// twin of `heddle run --session <id> --resume --answer '<json>'`.
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
        let agent = record.agent

        guard let cli = HeddleCLI.locate() else {
            record.status = .failed(HeddleCLI.LocateError.notFound.localizedDescription)
            record.endedAt = Date()
            return
        }

        var arguments = Array(cli.invocation.dropFirst())
        arguments += ["run", agent.url.path, "--protocol", "heddle", "--no-ask-env"]
        arguments += record.extraArguments
        if let session = record.sessionID {
            arguments += ["--session", session]
        }
        if resume {
            arguments += ["--resume"]
        }
        if let answer,
           let data = try? JSONEncoder().encode(answer),
           let json = String(data: data, encoding: .utf8)
        {
            arguments += ["--answer", json]
        }
        if let input, !input.isEmpty,
           let data = try? JSONEncoder().encode(JSONValue.object(input)),
           let json = String(data: data, encoding: .utf8)
        {
            arguments += ["--input", json]
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli.invocation[0])
        process.arguments = arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        // The app's environment plus the Keychain-held keys, read at spawn
        // time — so a key saved in the preflight panel is live on this very
        // run, and no value ever rests anywhere but the Keychain.
        process.environment = ProcessInfo.processInfo.environment
            .merging(KeychainStore.shared.environment()) { _, keychain in keychain }

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice

        let recordID = record.id
        // A resume keeps its record: what streamed before the suspension
        // stays, and this spawn's frames append after it.
        let baseItems = record.items
        var reducer = FrameReducer()
        var buffer = Data()
        var stderrTail = Data()

        // Readability handlers run on a private queue; every mutation of the
        // record hops to the main actor with the bytes it read.
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            Task { @MainActor [weak self] in
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    if let text = String(data: Data(line), encoding: .utf8) {
                        reducer.consume(line: Substring(text))
                    }
                }
                self?.apply(reducer, to: recordID, over: baseItems)
            }
        }

        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            Task { @MainActor in
                stderrTail.append(chunk)
                if stderrTail.count > 16 * 1024 {
                    stderrTail.removeFirst(stderrTail.count - 16 * 1024)
                }
            }
        }

        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            Task { @MainActor [weak self] in
                stdout.fileHandleForReading.readabilityHandler = nil
                stderr.fileHandleForReading.readabilityHandler = nil

                // The pipe may still hold bytes the handler never saw.
                if let rest = try? stdout.fileHandleForReading.readToEnd(), !rest.isEmpty {
                    buffer.append(rest)
                }
                for line in String(data: buffer, encoding: .utf8)?
                    .split(separator: "\n", omittingEmptySubsequences: true) ?? []
                {
                    reducer.consume(line: line)
                }

                self?.finish(
                    recordID,
                    reducer: reducer,
                    over: baseItems,
                    exitStatus: status,
                    stderr: String(data: stderrTail, encoding: .utf8) ?? ""
                )
            }
        }

        do {
            try process.run()
            processes[recordID] = process
        } catch {
            record.status = .failed("could not start heddle: \(error.localizedDescription)")
            record.endedAt = Date()
        }
    }

    func cancel(_ record: RunRecord) {
        processes[record.id]?.terminate()
    }

    func cancelAll() {
        for process in processes.values { process.terminate() }
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
        exitStatus: Int32,
        stderr: String
    ) {
        processes[id] = nil
        guard let record = record(id) else { return }

        record.items = base + reducer.items
        record.finalState = reducer.finalState
        record.endedAt = Date()

        if exitStatus == 0 {
            // Exit 0 covers both endings; the frames say which one this was
            // (`run.ts` writes the `suspended` frame and returns).
            if let suspension = reducer.suspension {
                record.status = .suspended(suspension)
            } else {
                record.status = .succeeded
            }
        } else {
            // The CLI's last words beat an exit code: its errors go to stderr
            // (`heddle.ts` prints `err.message`), events' to the reducer.
            let lastWords =
                reducer.failure
                ?? stderr.split(separator: "\n").last.map(String.init)
                ?? "heddle exited with status \(exitStatus)"
            record.status = .failed(lastWords)
        }

        onFinish?(record)
        completions.removeValue(forKey: id)?(record)
    }
}
