import HeddleCore
import XCTest
@testable import Heddle

/// The local half of `RunStore`: a bundle agent's run goes to the injected
/// engine seam, its frame lines fold through the same reducer path the SSE
/// frames take, and the assembled `RunConfig` is exactly what the extracted
/// bundle says. The engine itself is faked — its own behavior is
/// HeddleCore's suite's business.
@MainActor
final class LocalRunTests: XCTestCase {
    private var base: URL!

    override func setUp() async throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-run-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: base)
    }

    // MARK: - Plumbing

    private func bundles() -> BundleStore {
        BundleStore(baseDirectory: base) { _, _ in
            throw HeddleEngine.EngineError.inspectFailed("no engine in this test")
        }
    }

    private func importFixture(into store: BundleStore) throws -> Agent {
        let url = try XCTUnwrap(
            Bundle(for: LocalRunTests.self)
                .url(forResource: "mini", withExtension: "heddle")
        )
        return try store.importBundle(from: url)
    }

    /// What the fake engine saw, readable after the run settles.
    private final class Seam {
        var config: HeddleEngine.RunConfig?
        var roots: [URL] = []
        var started = false
    }

    /// A `RunStore` whose local transport yields `lines` and records what
    /// it was asked.
    private func makeStore(
        bundles: BundleStore, lines: [String], seam: Seam
    ) -> RunStore {
        // No server on purpose: these tests are about the local engine, and
        // a non-portable bundle with nowhere to fall back must say so
        // rather than dial the default URL.
        let settings = ServerSettings()
        settings.urlString = ""
        return RunStore(
            settings: settings,
            bundles: bundles,
            localRun: { config, roots in
                seam.started = true
                seam.config = config
                seam.roots = roots
                return AsyncThrowingStream { continuation in
                    for line in lines { continuation.yield(line) }
                    continuation.finish()
                }
            }
        )
    }

    // Spelled out: the test imports both HeddleCore (the generic) and the
    // app (its Agent-typed alias), so the bare name is ambiguous here.
    private func settled(_ runs: RunStore, _ record: Heddle.RunRecord) async {
        await withCheckedContinuation { continuation in
            runs.onCompletion(of: record) { _ in continuation.resume() }
        }
    }

    // MARK: - Runs

    func testSuccessFramesBecomeASucceededRecordWithATranscript() async throws {
        let store = bundles()
        let agent = try importFixture(into: store)
        let seam = Seam()
        let runs = makeStore(
            bundles: store,
            lines: [
                #"{"event":"node_start","data":{"nodeName":"agent"}}"#,
                #"{"event":"token_delta","data":{"nodeName":"agent","delta":"Hello "}}"#,
                #"{"event":"token_delta","data":{"nodeName":"agent","delta":"world"}}"#,
                #"{"event":"flow_complete","data":{"state":{"task":"done","_chat_history":[]}}}"#,
            ],
            seam: seam
        )

        let record = runs.start(agent: agent, input: ["task": .string("hi")])
        await settled(runs, record)

        XCTAssertEqual(record.status, .succeeded)
        XCTAssertEqual(
            record.items.map(\.kind), [.nodeStart(name: "agent"), .output]
        )
        XCTAssertEqual(record.items.last?.text, "Hello world")
        XCTAssertEqual(record.finalState, .object(["task": .string("done")]))

        // The config came from the extracted fixture, not from the record.
        let config = try XCTUnwrap(seam.config)
        let extracted = store.extractedDir(
            forBundleID: try XCTUnwrap(agent.bundleID))
        XCTAssertEqual(config.bundleDir, extracted.path)
        XCTAssertEqual(config.flow.format, .yaml)
        XCTAssertTrue(config.flow.text.contains("component_type: Flow"))
        XCTAssertEqual(config.inputs, ["task": .string("hi")])
        XCTAssertNil(config.session)
        XCTAssertFalse(config.resume)
        XCTAssertTrue(config.plugins.isEmpty)

        // The scratch exists, and the roots are exactly bundle + scratch.
        XCTAssertTrue(FileManager.default.fileExists(atPath: config.scratchDir))
        XCTAssertEqual(
            seam.roots.map(\.path), [extracted.path, config.scratchDir]
        )
    }

    func testASuspendedFrameLeavesTheRecordWaitingWithItsAsk() async throws {
        let store = bundles()
        let agent = try importFixture(into: store)
        let seam = Seam()
        let runs = makeStore(
            bundles: store,
            lines: [
                #"{"event":"node_start","data":{"nodeName":"approval"}}"#,
                #"{"event":"suspended","data":{"session":"local-abc","by":"approval","ask":{"question":"Proceed?"}}}"#,
            ],
            seam: seam
        )

        let session = try await runs.mintSession(for: agent)
        XCTAssertTrue(session.hasPrefix("local-"))

        let record = runs.start(agent: agent, input: nil, session: session)
        await settled(runs, record)

        guard case .suspended(let suspension) = record.status else {
            return XCTFail("expected suspended, got \(record.status)")
        }
        XCTAssertEqual(suspension.question, "Proceed?")
        XCTAssertEqual(suspension.by, "approval")

        // The minted session travelled into the engine's config, so a
        // later resume finds the open turn.
        XCTAssertEqual(seam.config?.session, session)
    }

    func testANonPortableBundleFailsWithoutTouchingTheEngine() async throws {
        let store = bundles()
        var agent = try importFixture(into: store)
        agent.portability = PortabilityReport(reasons: [.hasTools])

        let seam = Seam()
        let runs = makeStore(bundles: store, lines: [], seam: seam)

        let record = runs.start(agent: agent)
        await settled(runs, record)

        guard case .failed(let message) = record.status else {
            return XCTFail("expected failed, got \(record.status)")
        }
        XCTAssertTrue(message.contains("cannot run on this device"))
        XCTAssertTrue(message.contains("ships executable tools"))
        XCTAssertFalse(seam.started)
    }

    // MARK: - Config assembly

    func testConfigAssemblyResolvesPluginsFormatAndDefaults() throws {
        let extracted = base.appendingPathComponent("assembled/extracted")
        let plugin = extracted.appendingPathComponent("plugins/greeter")
        try FileManager.default.createDirectory(
            at: extracted.appendingPathComponent("flow"),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: plugin, withIntermediateDirectories: true
        )
        try Data(
            #"""
            {"format":1,"name":"assembled","flow":"flow/flow.json",
             "plugins":["plugins/greeter/greeter.json"],
             "pluginConfig":{"Greeter":{"tone":"warm"}},
             "maxToolRounds":5}
            """#.utf8
        ).write(to: extracted.appendingPathComponent("heddle.json"))
        try Data(#"{"component_type":"Flow"}"#.utf8)
            .write(to: extracted.appendingPathComponent("flow/flow.json"))
        try Data(#"{"name":"greeter","components":[{"type":"Greeter"}]}"#.utf8)
            .write(to: plugin.appendingPathComponent("greeter.json"))
        // Both siblings on disk: .mjs must win, as core's entryFor has it.
        try Data("serve({});".utf8)
            .write(to: plugin.appendingPathComponent("greeter.mjs"))
        try Data("wrong file".utf8)
            .write(to: plugin.appendingPathComponent("greeter.js"))

        let scratch = base.appendingPathComponent("scratch")
        let config = try LocalRunAssembly.config(
            runID: "r-1",
            extractedDir: extracted,
            scratchDir: scratch,
            inputs: ["q": .string("x")],
            session: "local-abc",
            resume: true,
            answer: .object(["approved": .bool(true)])
        )

        XCTAssertEqual(config.runId, "r-1")
        XCTAssertEqual(config.flow.format, .json)
        XCTAssertEqual(config.flow.text, #"{"component_type":"Flow"}"#)
        XCTAssertEqual(config.bundleDir, extracted.path)
        XCTAssertEqual(config.scratchDir, scratch.path)

        XCTAssertEqual(config.plugins.count, 1)
        XCTAssertEqual(config.plugins.first?.entrySource, "serve({});")
        XCTAssertEqual(config.plugins.first?.dir, plugin.path)
        XCTAssertEqual(
            config.plugins.first?.manifest.objectValue?["name"],
            .string("greeter")
        )

        XCTAssertEqual(
            config.pluginConfig, ["Greeter": ["tone": .string("warm")]]
        )
        XCTAssertEqual(config.maxToolRounds, .number(5))
        XCTAssertEqual(config.session, "local-abc")
        XCTAssertTrue(config.resume)
        XCTAssertEqual(config.answer, .object(["approved": .bool(true)]))
    }

    func testConfigAssemblyRefusesAPluginWithoutAnEntry() throws {
        let extracted = base.appendingPathComponent("entryless/extracted")
        let plugin = extracted.appendingPathComponent("plugins/mute")
        try FileManager.default.createDirectory(
            at: plugin, withIntermediateDirectories: true
        )
        try Data(
            #"{"format":1,"name":"x","flow":"flow.yaml","plugins":["plugins/mute/mute.json"]}"#
                .utf8
        ).write(to: extracted.appendingPathComponent("heddle.json"))
        try Data("component_type: Flow".utf8)
            .write(to: extracted.appendingPathComponent("flow.yaml"))
        try Data(#"{"name":"mute"}"#.utf8)
            .write(to: plugin.appendingPathComponent("mute.json"))

        XCTAssertThrowsError(
            try LocalRunAssembly.config(
                runID: "r-2",
                extractedDir: extracted,
                scratchDir: base.appendingPathComponent("s2"),
                inputs: [:],
                session: nil,
                resume: false,
                answer: nil
            )
        ) { error in
            XCTAssertTrue(
                "\(error)".contains("no JavaScript entry"),
                "unexpected error: \(error)"
            )
        }
    }
}
