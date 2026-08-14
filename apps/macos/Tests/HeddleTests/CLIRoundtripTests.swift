import HeddleCore
import XCTest
@testable import Heddle

/// The whole M0 seam, against the real CLI: RunStore spawns `heddle run`,
/// frames stream back, the record finishes with the flow's state.
///
/// Needs a runtime, so it skips unless the environment provides one:
///
///   HEDDLE_APP_CLI=<checkout>/packages/cli/dist/heddle.js \
///   HEDDLE_APP_NODE=$(which node) swift test
///
/// The fixture is a Start→End flow — the smallest run there is, and one that
/// needs no model and no key.
@MainActor
final class CLIRoundtripTests: XCTestCase {
    func testStartToEndFlowStreamsAndCompletes() async throws {
        guard ProcessInfo.processInfo.environment["HEDDLE_APP_CLI"] != nil else {
            throw XCTSkip("set HEDDLE_APP_CLI (and HEDDLE_APP_NODE) to run the CLI round trip")
        }

        let spec = try fixtureFlow()
        defer { try? FileManager.default.removeItem(at: spec) }

        let agent = Agent(
            url: spec,
            kind: .flow,
            name: "fixture-flow",
            defaultInput: nil,
            interactive: false
        )

        let store = RunStore()
        let record = store.start(agent: agent, input: ["query": .string("hello from the app")])

        let deadline = Date().addingTimeInterval(60)
        while record.isRunning && Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }

        XCTAssertEqual(record.status, .succeeded)
        XCTAssertEqual(
            record.finalState?.objectValue?["query"],
            .string("hello from the app")
        )
        XCTAssertTrue(
            record.items.contains {
                $0.kind == .nodeStart(name: "start")
            },
            "transcript should carry the node starts"
        )
    }

    func testMissingFlowFailsWithTheCLIsWords() async throws {
        guard ProcessInfo.processInfo.environment["HEDDLE_APP_CLI"] != nil else {
            throw XCTSkip("set HEDDLE_APP_CLI (and HEDDLE_APP_NODE) to run the CLI round trip")
        }

        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("no-such-flow-\(UUID().uuidString).yaml")
        let agent = Agent(
            url: missing, kind: .flow, name: "missing", defaultInput: nil, interactive: false
        )

        let store = RunStore()
        let record = store.start(agent: agent)

        let deadline = Date().addingTimeInterval(60)
        while record.isRunning && Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }

        guard case .failed(let message) = record.status else {
            return XCTFail("a missing flow should fail the run")
        }
        XCTAssertFalse(message.isEmpty)
    }

    private func fixtureFlow() throws -> URL {
        let yaml = """
            component_type: Flow
            name: fixture-flow
            start_node: { $component_ref: start }
            nodes:
              - { $component_ref: start }
              - { $component_ref: end }
            control_flow_connections:
              - component_type: ControlFlowEdge
                name: start_to_end
                from_node: { $component_ref: start }
                to_node: { $component_ref: end }
            $referenced_components:
              start:
                component_type: StartNode
                id: start
                name: start
                outputs: [{ title: query, type: string }]
              end: { component_type: EndNode, id: end, name: end }
            """
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-fixture-\(UUID().uuidString).yaml")
        try yaml.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
