import HeddleCore
import XCTest
@testable import Heddle

/// The whole M3 seam, against the real CLI: a middleware suspends the run,
/// the record says so, `answer` resumes it on the same record, and the flow
/// finishes. Skips without a runtime, like `CLIRoundtripTests`.
@MainActor
final class SuspensionRoundtripTests: XCTestCase {
    func testSuspendAnswerComplete() async throws {
        guard ProcessInfo.processInfo.environment["HEDDLE_APP_CLI"] != nil else {
            throw XCTSkip("set HEDDLE_APP_CLI (and HEDDLE_APP_NODE) to run the CLI round trip")
        }

        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        let agent = Agent(
            url: fixture.flow, kind: .flow, name: "gate-flow",
            defaultInput: nil, interactive: false
        )

        let store = RunStore()
        let record = store.start(
            agent: agent,
            input: ["order": .string("991")],
            session: "app-test-\(UUID().uuidString.lowercased())",
            extraArguments: [
                "--tools-dir", fixture.tools.path,
                "--plugin", fixture.pluginManifest.path,
                "--plugin-config", #"Pause={"node":"pay"}"#,
                "--session-dir", fixture.sessions.path,
            ]
        )

        try await settle(record)
        guard case .suspended(let suspension) = record.status else {
            return XCTFail("expected a suspension, got \(record.status)")
        }
        XCTAssertEqual(suspension.question, "Run pay?")
        XCTAssertEqual(store.needingAnswer.map(\.id), [record.id])

        let itemsBeforeResume = record.items.count
        store.answer(record, with: .object(["approved": .bool(true)]))
        try await settle(record)

        XCTAssertEqual(record.status, .succeeded)
        XCTAssertEqual(
            record.finalState?.objectValue?["receipt"],
            .string("refunded")
        )
        XCTAssertGreaterThan(
            record.items.count, itemsBeforeResume,
            "the resume's frames should append to the same transcript"
        )
    }

    private func settle(_ record: RunRecord) async throws {
        let deadline = Date().addingTimeInterval(90)
        while record.isRunning && Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertFalse(record.isRunning, "run did not settle in time")
    }

    private struct Fixture {
        let root: URL
        let flow: URL
        let tools: URL
        let pluginManifest: URL
        let sessions: URL
    }

    /// A Start→Tool→End flow, a stub tool, and a middleware that suspends
    /// the tool node until a person answers — the smallest run that stops
    /// for a human, and it needs no model.
    private func makeFixture() throws -> Fixture {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-suspend-\(UUID().uuidString)")
        let tools = root.appendingPathComponent("tools")
        let plugin = root.appendingPathComponent("pause-plugin")
        let sessions = root.appendingPathComponent("sessions")
        for directory in [tools, plugin, sessions] {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true
            )
        }

        let refund = tools.appendingPathComponent("refund")
        try #"""
        #!/bin/bash
        echo '{"receipt":"refunded"}'
        """#.write(to: refund, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: refund.path
        )

        let flow = root.appendingPathComponent("gate-flow.yaml")
        try """
            weave: 1
            name: gate-flow
            inputs:
              order: string
            tools:
              refund:
                description: refunds an order
                inputs:
                  order: string
                outputs:
                  receipt: string
            steps:
              - name: pay
                tool: refund
                with:
                  order: '{{inputs.order}}'
            outcomes:
              done:
                receipt: '{{pay.receipt}}'
            """.write(to: flow, atomically: true, encoding: .utf8)

        let manifest = plugin.appendingPathComponent("pause.json")
        try """
            {
              "name": "pause",
              "version": "1.0.0",
              "capabilities": [],
              "components": [
                {
                  "componentType": "Pause",
                  "kind": "middleware",
                  "seams": { "node": ["before"] },
                  "schema": {
                    "type": "object",
                    "properties": { "node": { "type": "string" } }
                  }
                }
              ]
            }
            """.write(to: manifest, atomically: true, encoding: .utf8)

        try """
            serve({
              Pause: {
                node: {
                  before({ subject }, ctx) {
                    if (subject.nodeName !== ctx.component.node) return { action: 'proceed' };
                    if (ctx.answered) {
                      return ctx.answered.approved === true
                        ? { action: 'proceed' }
                        : { action: 'reject', reason: 'a person said no' };
                    }
                    return {
                      action: 'suspend',
                      ask: {
                        question: `Run ${subject.nodeName}?`,
                        reply: { approved: 'true or false' },
                      },
                    };
                  },
                },
              },
            });
            """.write(
                to: plugin.appendingPathComponent("pause.mjs"),
                atomically: true, encoding: .utf8
            )

        return Fixture(
            root: root, flow: flow, tools: tools,
            pluginManifest: manifest, sessions: sessions
        )
    }
}
