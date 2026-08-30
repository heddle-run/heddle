#if canImport(JavaScriptCore)
import Foundation
import XCTest
@testable import HeddleCore

/// The installed globals and `__host_*` bridges, one by one, through a
/// minimal artifact and the engine's test evaluator.
final class JSBridgeTests: XCTestCase {
    /// Just enough to pass the contract check at init.
    private static let artifact = """
        globalThis.HeddleEngine = {
          version: "bridge-test",
          protocolVersion: 1,
          inspect: () => JSON.stringify({ ok: true, name: "n", inputs: [] }),
          run: () => {},
          cancel: () => {},
        };
        """

    private var host: MockEngineHost!
    private var engine: HeddleEngine!
    private var scratch: URL!

    override func setUpWithError() throws {
        host = MockEngineHost()
        scratch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-bridge-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        host.roots = [scratch]
        engine = try EngineTestSupport.makeEngine(artifact: Self.artifact, host: host)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    // MARK: - Plain globals

    func testTimersFireInDelayOrderAndClearTimeoutStops() async throws {
        _ = try engine.evaluateForTesting(
            """
            globalThis.__order = [];
            setTimeout(() => __order.push("late"), 60);
            setTimeout(() => __order.push("early"), 5);
            const cancelled = setTimeout(() => __order.push("never"), 20);
            clearTimeout(cancelled);
            """
        )

        try await EngineTestSupport.eventually("both timers fired, the cleared one did not") {
            (try? self.engine.evaluateForTesting("JSON.stringify(__order)"))
                == #"["early","late"]"#
        }
    }

    func testConsoleReachesTheHostLog() throws {
        _ = try engine.evaluateForTesting(
            "console.warn('two', 'words'); console.error('bad');"
        )

        XCTAssertEqual(host.logs.map(\.level), [.warn, .error])
        XCTAssertEqual(host.logs.map(\.message), ["two words", "bad"])
    }

    func testRandomUUIDMintsUniqueLowercaseUUIDs() throws {
        let first = try XCTUnwrap(engine.evaluateForTesting("crypto.randomUUID()"))
        let second = try XCTUnwrap(engine.evaluateForTesting("crypto.randomUUID()"))

        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first, first.lowercased())
        XCTAssertNotNil(UUID(uuidString: first))
    }

    // MARK: - Env and sessions

    func testEnvResolvesThroughTheHostAndMissingIsNull() throws {
        host.env = ["OPENAI_API_KEY": "sk-999"]

        XCTAssertEqual(
            try engine.evaluateForTesting("__host_resolveEnv('OPENAI_API_KEY')"), "sk-999"
        )
        XCTAssertNil(try engine.evaluateForTesting("__host_resolveEnv('NOT_SET')"))
        XCTAssertEqual(
            try engine.evaluateForTesting("String(__host_resolveEnv('NOT_SET'))"), "null",
            "the contract says null, not undefined"
        )
    }

    func testSessionsRoundTripThroughTheHost() throws {
        XCTAssertNil(try engine.evaluateForTesting("__host_sessionRead('s1')"))

        _ = try engine.evaluateForTesting(
            #"__host_sessionWrite('s1', JSON.stringify({turns: 1}))"#
        )
        XCTAssertEqual(
            try engine.evaluateForTesting("__host_sessionRead('s1')"), #"{"turns":1}"#
        )
        XCTAssertEqual(host.sessions["s1"], #"{"turns":1}"#)
    }

    // MARK: - Files

    func testFileOpsWorkInsideTheDeclaredRoots() throws {
        XCTAssertEqual(
            try engine.evaluateForTesting(
                "__host_writeFile('\(scratch.path)/nested/out.txt', 'written from JS')"
            ),
            "true", "intermediate directories are created"
        )
        XCTAssertEqual(
            try engine.evaluateForTesting("__host_readFile('\(scratch.path)/nested/out.txt')"),
            "written from JS"
        )
        XCTAssertEqual(
            try engine.evaluateForTesting(
                "JSON.stringify(__host_listDir('\(scratch.path)'))"
            ),
            #"["nested"]"#
        )
    }

    func testFileOpsRefuseEverythingOutsideTheRoots() throws {
        // A climb that normalizes outside the root.
        XCTAssertEqual(
            try engine.evaluateForTesting(
                "__host_writeFile('\(scratch.path)/../escaped.txt', 'no')"
            ),
            "false"
        )
        // An absolute path that was never a root.
        XCTAssertNil(try engine.evaluateForTesting("__host_readFile('/etc/passwd')"))
        XCTAssertNil(try engine.evaluateForTesting("__host_listDir('/etc')"))
        // A relative path: the contract deals in absolute paths under roots.
        XCTAssertEqual(
            try engine.evaluateForTesting("__host_writeFile('relative.txt', 'no')"),
            "false"
        )
        // A climb that normalizes back inside is a spelling, not an escape.
        XCTAssertEqual(
            try engine.evaluateForTesting(
                "__host_writeFile('\(scratch.path)/a/../inside.txt', 'yes')"
            ),
            "true"
        )
    }

    // MARK: - Fetch

    func testFetchAbortReachesTheHandle() async throws {
        host.mockFetcher.script = .hang
        _ = try engine.evaluateForTesting(
            """
            __host_fetchStart('f1', { url: 'https://x.example/', method: 'GET', headers: {} });
            __host_fetchAbort('f1');
            """
        )

        try await EngineTestSupport.eventually("abort cancelled the live handle") {
            self.host.mockFetcher.handles.first?.cancelled == true
        }
    }

    func testFetchCallbacksDeliverHeadChunksAndEnd() async throws {
        host.mockFetcher.script = .stream(
            head: EngineFetchResponseHead(status: 201, headers: ["content-type": "text/plain"]),
            chunks: ["one", " two"]
        )
        _ = try engine.evaluateForTesting(
            """
            globalThis.__seen = { text: "", status: 0, ended: false };
            globalThis.__engine_fetchResponse = (id, head) => { __seen.status = head.status; };
            globalThis.__engine_fetchChunk = (id, text) => { __seen.text += text; };
            globalThis.__engine_fetchEnd = (id) => { __seen.ended = true; };
            globalThis.__engine_fetchError = (id, message) => { __seen.error = message; };
            __host_fetchStart(7, { url: 'https://x.example/', method: 'GET', headers: {} });
            """
        )

        try await EngineTestSupport.eventually("the streamed response arrived in JS") {
            (try? self.engine.evaluateForTesting("JSON.stringify(__seen)"))
                == #"{"text":"one two","status":201,"ended":true}"#
        }
    }

    // MARK: - The fetcher's byte discipline

    func testChunkDecoderHoldsASplitCodePointBack() {
        var decoder = UTF8ChunkDecoder()
        let emoji = Array("🌍".utf8) // f0 9f 8c 8d

        // "Hi " plus half the emoji: the half stays behind.
        XCTAssertEqual(
            decoder.decode(Data(Array("Hi ".utf8) + emoji[0..<2])), "Hi "
        )
        // The rest arrives: the emoji comes out whole, never as replacements.
        XCTAssertEqual(decoder.decode(Data(emoji[2...])), "🌍")
        XCTAssertNil(decoder.flush())
    }

    func testChunkDecoderAcrossEverySplitOfAMixedString() {
        let text = "héllo 🌍 → done"
        let bytes = Array(text.utf8)

        for cut in 0...bytes.count {
            var decoder = UTF8ChunkDecoder()
            var out = ""
            if let first = decoder.decode(Data(bytes[..<cut])) { out += first }
            if let second = decoder.decode(Data(bytes[cut...])) { out += second }
            if let tail = decoder.flush() { out += tail }
            XCTAssertEqual(out, text, "split at byte \(cut)")
        }
    }

    func testChunkDecoderFlushDecodesADanglingTailLossily() {
        var decoder = UTF8ChunkDecoder()
        let emoji = Array("🌍".utf8)

        XCTAssertNil(decoder.decode(Data(emoji[0..<2])))
        // The stream ended mid-code-point: flushed as replacement, not lost.
        let tail = decoder.flush()
        XCTAssertNotNil(tail)
        XCTAssertTrue(tail?.contains("\u{FFFD}") == true)
    }
}
#endif
