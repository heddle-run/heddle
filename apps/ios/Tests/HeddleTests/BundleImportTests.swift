import HeddleCore
import XCTest
@testable import Heddle

/// Importing a `.heddle` into the app: the store's directory layout, the
/// input-form fallback when the engine refuses to parse, and the saved
/// agent's shape — including that an agents.json written before bundles
/// existed still decodes.
@MainActor
final class BundleImportTests: XCTestCase {
    private var base: URL!

    override func setUp() async throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("bundle-import-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func fixtureURL() throws -> URL {
        try XCTUnwrap(
            Bundle(for: BundleImportTests.self)
                .url(forResource: "mini", withExtension: "heddle")
        )
    }

    /// A store whose engine never answers — the stub artifact's behavior,
    /// and any flow the shipped engine cannot parse.
    private func storeWithoutEngine() -> BundleStore {
        BundleStore(baseDirectory: base) { _, _ in
            throw HeddleEngine.EngineError.inspectFailed("no engine in this test")
        }
    }

    func testImportFallsBackToTheManifestInputsWhenInspectRefuses() throws {
        let store = storeWithoutEngine()
        let agent = try store.importBundle(from: fixtureURL())

        XCTAssertEqual(agent.name, "mini")
        let id = try XCTUnwrap(agent.bundleID)

        // The archive verbatim, beside its extraction.
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: store.archiveURL(forBundleID: id).path)
        )
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: store.extractedDir(forBundleID: id)
                    .appendingPathComponent("flow/flow.yaml").path)
        )

        // No tools, mounts, or plugins; the one requirement is an env key,
        // which any host can hold — so it runs on the phone.
        XCTAssertEqual(agent.portability, PortabilityReport(reasons: []))
        XCTAssertTrue(agent.runsOnDevice)

        // The manifest's default input is the fallback form.
        XCTAssertEqual(
            agent.inputFields,
            [
                BundleInputField(
                    key: "task", type: "string", defaultValue: .string("hi"))
            ]
        )
        XCTAssertEqual(agent.inputKey, "task")

        XCTAssertEqual(
            agent.manifestSummary?.requirements.map(\.label), ["OPENAI_API_KEY"]
        )
    }

    func testImportPrefersTheEnginesInputFields() throws {
        let store = BundleStore(baseDirectory: base) { _, _ in
            HeddleEngine.FlowInfo(
                name: "mini",
                inputs: [
                    .init(key: "task", type: "string", title: "Task", required: true)
                ]
            )
        }
        let agent = try store.importBundle(from: fixtureURL())

        // The engine's fields, with the manifest's default merged in.
        XCTAssertEqual(
            agent.inputFields,
            [
                BundleInputField(
                    key: "task", type: "string", title: "Task",
                    required: true, defaultValue: .string("hi"))
            ]
        )
    }

    /// The shipped artifact, end to end: the fixture's flow parses and
    /// declares the input the manifest defaults.
    func testTheRealEngineInspectsTheFixtureFlow() throws {
        let store = BundleStore(baseDirectory: base)
        let agent = try store.importBundle(from: fixtureURL())
        XCTAssertEqual(agent.inputFields?.map(\.key), ["task"])
        XCTAssertEqual(agent.inputFields?.first?.defaultValue, .string("hi"))
    }

    func testRemoveDeletesTheWholeBundleDirectory() throws {
        let store = storeWithoutEngine()
        let agent = try store.importBundle(from: fixtureURL())
        let id = try XCTUnwrap(agent.bundleID)

        try store.remove(agent: agent)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: store.directory(forBundleID: id).path)
        )
    }

    func testAFailedImportLeavesNothingBehind() throws {
        let notABundle = base.appendingPathComponent("garbage.heddle")
        try Data("not a gzip".utf8).write(to: notABundle)

        let store = storeWithoutEngine()
        XCTAssertThrowsError(try store.importBundle(from: notABundle))

        // The store's base holds no half-made directory.
        let leftovers = (try? FileManager.default.contentsOfDirectory(
            atPath: base.path)) ?? []
        XCTAssertEqual(leftovers, ["garbage.heddle"])
    }

    func testAnAgentsFileFromBeforeBundlesStillDecodes() throws {
        // Exactly what the previous Agent encoded: no portability, no
        // inputFields, no manifestSummary, no serverBundleID.
        let old = """
            [
              {"id":"11111111-2222-3333-4444-555555555555",
               "name":"notes",
               "source":{"serverPath":{"_0":"flows/notes.yaml"}},
               "inputKey":"query"},
              {"id":"66666666-7777-8888-9999-000000000000",
               "name":"pasted",
               "source":{"inline":{"_0":"component_type: Flow"}},
               "inputKey":"task"}
            ]
            """
        let agents = try JSONDecoder().decode([Agent].self, from: Data(old.utf8))

        XCTAssertEqual(agents.count, 2)
        XCTAssertEqual(agents[0].source, .serverPath("flows/notes.yaml"))
        XCTAssertEqual(agents[1].source, .inline("component_type: Flow"))
        XCTAssertNil(agents[0].portability)
        XCTAssertNil(agents[0].inputFields)
        XCTAssertNil(agents[0].manifestSummary)
        XCTAssertNil(agents[0].serverBundleID)
    }

    func testABundleAgentRoundtripsThroughItsFile() throws {
        var agent = Agent(name: "mini", source: .bundle(id: "abc"))
        agent.inputKey = "task"
        agent.portability = PortabilityReport(reasons: [
            .hasTools,
            .pluginCommand(plugin: "scraper"),
            .unsupportedRequirement(kind: "binary", name: "python3"),
        ])
        agent.serverBundleID = "sha-1234"
        agent.inputFields = [
            BundleInputField(
                key: "task", type: "string", title: "Task",
                required: true, defaultValue: .string("hi"))
        ]
        agent.manifestSummary = BundleSummary(
            name: "mini",
            requires: [.object(["env": .string("OPENAI_API_KEY")])],
            interactive: true,
            session: true
        )

        let decoded = try JSONDecoder().decode(
            [Agent].self, from: JSONEncoder().encode([agent])
        )
        XCTAssertEqual(decoded, [agent])
    }
}
