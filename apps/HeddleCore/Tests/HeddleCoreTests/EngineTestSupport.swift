#if canImport(JavaScriptCore)
import Foundation
import XCTest
@testable import HeddleCore

/// A host made of dictionaries, plus a fetcher that answers from a script.
///
/// Callbacks from the bridge arrive on the engine's JS queue while tests
/// read from theirs, so every mutable field sits behind one lock.
final class MockEngineHost: EngineHost {
    private let lock = NSLock()

    private var _env: [String: String] = [:]
    private var _sessions: [String: String] = [:]
    private var _roots: [URL] = []
    private var _logs: [(level: EngineLogLevel, message: String)] = []
    let mockFetcher = MockFetcher()

    var env: [String: String] {
        get { lock.withLock { _env } }
        set { lock.withLock { _env = newValue } }
    }
    var sessions: [String: String] {
        get { lock.withLock { _sessions } }
        set { lock.withLock { _sessions = newValue } }
    }
    var roots: [URL] {
        get { lock.withLock { _roots } }
        set { lock.withLock { _roots = newValue } }
    }
    var logs: [(level: EngineLogLevel, message: String)] {
        lock.withLock { _logs }
    }

    func resolveEnv(_ name: String) -> String? {
        lock.withLock { _env[name] }
    }

    func sessionRead(id: String) -> String? {
        lock.withLock { _sessions[id] }
    }

    func sessionWrite(id: String, json: String) {
        lock.withLock { _sessions[id] = json }
    }

    func fileRoots() -> [URL] {
        lock.withLock { _roots }
    }

    func fetcher() -> EngineFetcher {
        mockFetcher
    }

    func log(level: EngineLogLevel, message: String) {
        lock.withLock { _logs.append((level, message)) }
    }
}

/// Answers each fetch from its script: a canned streamed response, a hang
/// (for cancel tests), or an error.
final class MockFetcher: EngineFetcher {
    enum Script {
        case stream(head: EngineFetchResponseHead, chunks: [String])
        case hang
        case fail(String)
    }

    final class Handle: EngineFetchHandle {
        private let lock = NSLock()
        private var _cancelled = false

        var cancelled: Bool { lock.withLock { _cancelled } }

        func cancel() {
            lock.withLock { _cancelled = true }
        }
    }

    private let lock = NSLock()
    private var _script: Script = .hang
    private var _requests: [EngineFetchRequest] = []
    private var _handles: [Handle] = []

    var script: Script {
        get { lock.withLock { _script } }
        set { lock.withLock { _script = newValue } }
    }
    var requests: [EngineFetchRequest] { lock.withLock { _requests } }
    var handles: [Handle] { lock.withLock { _handles } }

    func start(
        _ request: EngineFetchRequest,
        onResponse: @escaping (EngineFetchResponseHead) -> Void,
        onChunk: @escaping (String) -> Void,
        onEnd: @escaping () -> Void,
        onError: @escaping (String) -> Void
    ) -> EngineFetchHandle {
        let handle = Handle()
        let script = lock.withLock {
            _requests.append(request)
            _handles.append(handle)
            return _script
        }

        switch script {
        case .stream(let head, let chunks):
            // Off-thread, the way a network answers.
            DispatchQueue.global().async {
                onResponse(head)
                for chunk in chunks { onChunk(chunk) }
                onEnd()
            }
        case .hang:
            break
        case .fail(let message):
            DispatchQueue.global().async { onError(message) }
        }
        return handle
    }
}

enum EngineTestSupport {
    /// Write a test artifact and open an engine on it.
    static func makeEngine(
        artifact: String, host: MockEngineHost
    ) throws -> HeddleEngine {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-test-artifact-\(UUID().uuidString).js")
        try Data(artifact.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        return try HeddleEngine(host: host, artifactURL: url)
    }

    /// Wait for an off-queue effect, then assert it held.
    static func eventually(
        within timeout: TimeInterval = 2,
        _ what: String,
        file: StaticString = #filePath, line: UInt = #line,
        condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }
}
#endif
