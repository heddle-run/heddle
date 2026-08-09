import Foundation
import Observation

/// One run of one agent, as the windows see it.
@MainActor
@Observable
final class RunRecord: Identifiable {
    enum Status: Equatable {
        case running
        case succeeded
        case failed(String)
    }

    let id = UUID()
    let agentName: String
    let startedAt = Date()
    var endedAt: Date?
    var status: Status = .running
    var items: [TranscriptItem] = []
    var finalState: JSONValue?

    init(agentName: String) {
        self.agentName = agentName
    }

    var isRunning: Bool { status == .running }

    /// The one line the menu and the notification lead with.
    var summary: String {
        switch status {
        case .running: return "Running…"
        case .failed(let message): return message
        case .succeeded:
            if let object = finalState?.objectValue, let first = object.values.first,
               object.count == 1
            {
                return first.displayText
            }
            return finalState.map { $0.prettyJSON(compact: true) } ?? "Done"
        }
    }
}

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

    var onFinish: ((RunRecord) -> Void)?

    var running: [RunRecord] { runs.filter(\.isRunning) }
    var finished: [RunRecord] { runs.filter { !$0.isRunning } }

    @discardableResult
    func start(agent: Agent, input: [String: JSONValue]? = nil) -> RunRecord {
        let record = RunRecord(agentName: agent.name)
        runs.insert(record, at: 0)

        guard let cli = HeddleCLI.locate() else {
            record.status = .failed(HeddleCLI.LocateError.notFound.localizedDescription)
            record.endedAt = Date()
            return record
        }

        var arguments = Array(cli.invocation.dropFirst())
        arguments += ["run", agent.url.path, "--protocol", "heddle", "--no-ask-env"]
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
                self?.apply(reducer, to: recordID)
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
        return record
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

    private func apply(_ reducer: FrameReducer, to id: UUID) {
        guard let record = record(id) else { return }
        record.items = reducer.items
    }

    private func finish(
        _ id: UUID,
        reducer: FrameReducer,
        exitStatus: Int32,
        stderr: String
    ) {
        processes[id] = nil
        guard let record = record(id) else { return }

        record.items = reducer.items
        record.finalState = reducer.finalState
        record.endedAt = Date()

        if exitStatus == 0 {
            record.status = .succeeded
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
    }
}
