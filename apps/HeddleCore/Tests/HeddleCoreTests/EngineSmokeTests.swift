#if canImport(JavaScriptCore)
import Foundation
import XCTest
@testable import HeddleCore

/// The whole loop against a test artifact that keeps the contract: run() →
/// fetch round trip → frames out of `__host_emit` → the stream → the same
/// `FrameReducer` both apps render with.
final class EngineSmokeTests: XCTestCase {
    /// A miniature engine honoring `Engine/CONTRACT.md`: inspect parses,
    /// run streams a node through one model fetch, cancel aborts the fetch
    /// and emits the terminal error frame.
    private static let artifact = """
        const __runs = {};
        const __fetches = {};

        globalThis.HeddleEngine = {
          version: "test",
          protocolVersion: 1,

          inspect(flowText, format) {
            if (flowText.includes("broken")) {
              return JSON.stringify({ ok: false, error: "unparseable flow" });
            }
            return JSON.stringify({
              ok: true,
              name: "demo-" + format,
              inputs: [{ key: "task", type: "string", title: "Task", required: true }],
            });
          },

          run(configJSON) {
            const config = JSON.parse(configJSON);
            const id = config.runId;
            const run = { done: false, fetchId: null };
            __runs[id] = run;

            __host_emit(id, JSON.stringify({ event: "flow_start", data: { name: "demo" } }));
            __host_emit(id, JSON.stringify({ event: "node_start", data: { nodeName: "agent" } }));

            const fid = crypto.randomUUID();
            run.fetchId = fid;
            __fetches[fid] = { runId: id, text: "" };
            __host_fetchStart(fid, {
              url: "https://model.example/v1/chat",
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + (__host_resolveEnv("API_KEY") || "none"),
              },
              body: JSON.stringify({ inputs: config.inputs }),
            });
          },

          cancel(runId) {
            const run = __runs[runId];
            if (!run || run.done) return;
            run.done = true;
            if (run.fetchId) __host_fetchAbort(run.fetchId);
            __host_emit(runId, JSON.stringify({ event: "error", data: { message: "cancelled" } }));
            __host_runEnded(runId);
          },
        };

        globalThis.__engine_fetchResponse = (id, head) => {
          const fetch = __fetches[id];
          if (fetch) fetch.status = head.status;
        };
        globalThis.__engine_fetchChunk = (id, text) => {
          const fetch = __fetches[id];
          if (fetch) fetch.text += text;
        };
        globalThis.__engine_fetchEnd = (id) => {
          const fetch = __fetches[id];
          if (!fetch) return;
          delete __fetches[id];
          const run = __runs[fetch.runId];
          if (!run || run.done) return;

          for (const line of fetch.text.split("\\n")) {
            if (line.startsWith("data: ")) {
              __host_emit(fetch.runId, JSON.stringify({
                event: "token_delta",
                data: { nodeName: "agent", delta: line.slice(6) },
              }));
            }
          }
          setTimeout(() => {
            if (run.done) return;
            run.done = true;
            __host_emit(fetch.runId, JSON.stringify({
              event: "node_complete", data: { nodeName: "agent" },
            }));
            __host_emit(fetch.runId, JSON.stringify({
              event: "flow_complete",
              data: { state: { result: "done", _chat_history: [] } },
            }));
            __host_runEnded(fetch.runId);
          }, 5);
        };
        globalThis.__engine_fetchError = (id, message) => {
          const fetch = __fetches[id];
          if (!fetch) return;
          delete __fetches[id];
          const run = __runs[fetch.runId];
          if (!run || run.done) return;
          run.done = true;
          __host_emit(fetch.runId, JSON.stringify({ event: "error", data: { message } }));
          __host_runEnded(fetch.runId);
        };
        """

    private func makeEngine(host: MockEngineHost) throws -> HeddleEngine {
        try EngineTestSupport.makeEngine(artifact: Self.artifact, host: host)
    }

    private func config(runId: String) -> HeddleEngine.RunConfig {
        HeddleEngine.RunConfig(
            runId: runId,
            flow: .init(text: "name: demo", format: .yaml),
            bundleDir: "/tmp/never-touched",
            scratchDir: "/tmp/never-touched-scratch",
            inputs: ["task": .string("hi")]
        )
    }

    func testInspectDecodesTheContractShape() throws {
        let engine = try makeEngine(host: MockEngineHost())

        let info = try engine.inspect(flowText: "name: demo", format: .yaml)
        XCTAssertEqual(info.name, "demo-yaml")
        XCTAssertEqual(
            info.inputs,
            [.init(key: "task", type: "string", title: "Task", required: true)]
        )

        XCTAssertThrowsError(
            try engine.inspect(flowText: "broken", format: .json)
        ) { error in
            XCTAssertEqual(
                error as? HeddleEngine.EngineError, .inspectFailed("unparseable flow")
            )
        }
    }

    func testRunStreamsFramesTheReducerFoldsToSuccess() async throws {
        let host = MockEngineHost()
        host.env = ["API_KEY": "sk-123"]
        host.mockFetcher.script = .stream(
            head: EngineFetchResponseHead(status: 200),
            chunks: ["data: Hello \n", "data: 🌍\n"]
        )
        let engine = try makeEngine(host: host)

        var lines: [String] = []
        for try await line in engine.run(config(runId: "r1")) {
            lines.append(line)
        }

        // The stream carried the CLI's frame vocabulary, in order.
        let events = lines.compactMap {
            try? JSONDecoder().decode(RunFrame.self, from: Data($0.utf8)).event
        }
        XCTAssertEqual(
            events,
            [
                "flow_start", "node_start", "token_delta", "token_delta",
                "node_complete", "flow_complete",
            ]
        )

        // The run reached the model through the host's env and fetcher.
        let request = try XCTUnwrap(host.mockFetcher.requests.first)
        XCTAssertEqual(request.url, "https://model.example/v1/chat")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["authorization"], "Bearer sk-123")
        XCTAssertTrue(request.body?.contains("\"task\":\"hi\"") == true)

        // And FrameReducer folds the lines exactly as it folds the CLI's.
        var reducer = FrameReducer()
        for line in lines { reducer.consume(line: Substring(line)) }
        XCTAssertTrue(reducer.completed)
        XCTAssertNil(reducer.failure)
        XCTAssertNil(reducer.streamError)
        XCTAssertEqual(reducer.finalState, .object(["result": .string("done")]))
        XCTAssertEqual(
            reducer.items.map(\.kind),
            [.nodeStart(name: "agent"), .output]
        )
        XCTAssertEqual(reducer.items.last?.text, "Hello 🌍")
    }

    func testCancelMidRunEndsWithATerminalErrorFrame() async throws {
        let host = MockEngineHost()
        host.mockFetcher.script = .hang
        let engine = try makeEngine(host: host)

        let stream = engine.run(config(runId: "r2"))
        var iterator = stream.makeAsyncIterator()

        let first = try await iterator.next()
        XCTAssertTrue(try XCTUnwrap(first).contains("flow_start"))
        let second = try await iterator.next()
        XCTAssertTrue(try XCTUnwrap(second).contains("node_start"))

        engine.cancel(runID: "r2")

        let terminalLine = try await iterator.next()
        let terminal = try XCTUnwrap(terminalLine)
        var reducer = FrameReducer()
        reducer.consume(line: Substring(terminal))
        XCTAssertEqual(reducer.streamError, "cancelled")

        // After the terminal frame, __host_runEnded closed the stream…
        let afterEnd = try await iterator.next()
        XCTAssertNil(afterEnd)

        // …and the artifact aborted its in-flight fetch on the way out.
        try await EngineTestSupport.eventually("the hung fetch was aborted") {
            host.mockFetcher.handles.first?.cancelled == true
        }
    }

    func testCancellingTheConsumerCancelsTheRun() async throws {
        let host = MockEngineHost()
        host.mockFetcher.script = .hang
        let engine = try makeEngine(host: host)

        let consumer = Task {
            var seen = 0
            for try await _ in engine.run(config(runId: "r3")) { seen += 1 }
            return seen
        }

        // Let the run reach its hung fetch, then walk away.
        try await EngineTestSupport.eventually("the run started its fetch") {
            !host.mockFetcher.handles.isEmpty
        }
        consumer.cancel()

        // Stream cancellation reached JS cancel, which aborted the fetch.
        try await EngineTestSupport.eventually("cancellation reached the fetch") {
            host.mockFetcher.handles.first?.cancelled == true
        }
        _ = try? await consumer.value
    }

    func testAFetchErrorBecomesTheRunsErrorFrame() async throws {
        let host = MockEngineHost()
        host.mockFetcher.script = .fail("connection refused")
        let engine = try makeEngine(host: host)

        var lines: [String] = []
        for try await line in engine.run(config(runId: "r4")) {
            lines.append(line)
        }

        var reducer = FrameReducer()
        for line in lines { reducer.consume(line: Substring(line)) }
        XCTAssertEqual(reducer.streamError, "connection refused")
        XCTAssertFalse(reducer.completed)
    }

    func testAnArtifactWithoutAnEngineIsRefused() {
        XCTAssertThrowsError(
            try EngineTestSupport.makeEngine(
                artifact: "globalThis.somethingElse = 1;", host: MockEngineHost()
            )
        ) { error in
            XCTAssertEqual(error as? HeddleEngine.EngineError, .engineMissing)
        }
    }

    func testAThrowingArtifactSurfacesTheException() {
        XCTAssertThrowsError(
            try EngineTestSupport.makeEngine(
                artifact: "throw new Error('bad build');", host: MockEngineHost()
            )
        ) { error in
            guard case .javascriptFailed(let message)? = error as? HeddleEngine.EngineError
            else { return XCTFail("expected javascriptFailed, got \(error)") }
            XCTAssertTrue(message.contains("bad build"))
        }
    }

    /// The shipped resource is the real engine. One flow, end to end: the
    /// same YAML the CLI would run, a canned OpenAI-style stream from the
    /// mock fetcher, the API key out of the mock host's env — folded by the
    /// same `FrameReducer` both apps use. This is the cross-implementation
    /// proof for the artifact the repo checks in.
    func testTheShippedArtifactRunsAFlowEndToEnd() async throws {
        let host = MockEngineHost()
        host.env = ["OPENAI_API_KEY": "test-key-123"]
        host.mockFetcher.script = .stream(
            head: .init(status: 200, headers: [:]),
            chunks: [
                #"data: {"choices":[{"delta":{"content":"Hello"}}]}"# + "\n\n",
                #"data: {"choices":[{"delta":{"content":" phone"}}]}"# + "\n\n",
                #"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"# + "\n\n",
                "data: [DONE]\n\n",
            ]
        )

        let engine = try HeddleEngine(host: host)

        let info = try engine.inspect(flowText: Self.agentFlowYAML, format: .yaml)
        XCTAssertEqual(info.name, "smoke-flow")
        XCTAssertEqual(info.inputs.map(\.key), ["query"])

        let runConfig = HeddleEngine.RunConfig(
            runId: "shipped-1",
            flow: .init(text: Self.agentFlowYAML, format: .yaml),
            bundleDir: "/tmp/never-touched",
            scratchDir: "/tmp/never-touched-scratch",
            inputs: ["query": .string("say hello")]
        )

        var reducer = FrameReducer()
        var sawFlowComplete = false
        for try await line in engine.run(runConfig) {
            if line.contains("\"flow_complete\"") { sawFlowComplete = true }
            reducer.consume(line: Substring(line))
        }

        XCTAssertTrue(sawFlowComplete)
        XCTAssertNil(reducer.streamError)
        XCTAssertTrue(reducer.completed)
        let streamed = reducer.items
            .filter { $0.kind == .output }
            .map(\.text)
            .joined()
        XCTAssertEqual(streamed, "Hello phone")

        let request = host.mockFetcher.requests.first
        XCTAssertEqual(
            request?.headers["authorization"], "Bearer test-key-123")
    }

    /// The shipped linker, asked the way `BundlePortability.check` asks: a
    /// linkable graph comes back clean, a bare specifier comes back as the
    /// problem core's `checkPortability` would report — same linker, so the
    /// Swift check can never disagree with the TypeScript one.
    func testTheShippedArtifactJudgesPluginLinks() throws {
        let engine = try HeddleEngine(host: MockEngineHost())

        XCTAssertEqual(
            try engine.linkCheck(
                entrySource: "import { h } from './lib.js';\nserve(h);",
                files: ["lib.js": "export const h = {};"]
            ),
            []
        )

        let problems = try engine.linkCheck(
            entrySource: "import fs from 'node:fs';\nserve({});",
            files: [:]
        )
        XCTAssertEqual(problems.count, 1)
        XCTAssertTrue(
            problems[0].contains("\"node:fs\""), "unexpected: \(problems)")
    }

    /// A plugin whose entry imports a sibling module, run for real: the
    /// artifact links it by reading the sibling over `__host_readFile` from
    /// the plugin's directory — the on-device shape, end to end.
    func testTheShippedArtifactRunsAMultiFilePluginFlow() async throws {
        let bundleDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-engine-multifile-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: bundleDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundleDir) }
        try Data("export function shout(t) { return t.toUpperCase() + '!'; }\n".utf8)
            .write(to: bundleDir.appendingPathComponent("fmt.mjs"))

        let host = MockEngineHost()
        host.roots = [bundleDir]
        let engine = try HeddleEngine(host: host)

        let manifest = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                """
                {"name": "shouter", "version": "1.0.0",
                 "components": [{"componentType": "Shout"}]}
                """.utf8)
        )
        let entry = """
            import { shout } from './fmt.mjs';
            serve({
              Shout: {
                async execute(input) {
                  return { output: { loud: shout(input.text) } };
                },
              },
            });
            """

        let runConfig = HeddleEngine.RunConfig(
            runId: "multifile-1",
            flow: .init(text: Self.pluginFlowJSON, format: .json),
            bundleDir: bundleDir.path,
            scratchDir: bundleDir.path,
            plugins: [
                .init(manifest: manifest, entrySource: entry, dir: bundleDir.path)
            ],
            inputs: ["text": .string("quiet")]
        )

        var sawFlowComplete = false
        var sawShout = false
        for try await line in engine.run(runConfig) {
            XCTAssertFalse(
                line.contains("\"event\":\"error\""), "run failed: \(line)")
            if line.contains("\"flow_complete\"") { sawFlowComplete = true }
            if line.contains("QUIET!") { sawShout = true }
        }
        XCTAssertTrue(sawFlowComplete)
        XCTAssertTrue(sawShout)
    }

    /// start → Shout → end, in the agentspec JSON the engine parses.
    private static let pluginFlowJSON = """
        {"component_type": "Flow", "name": "plugin-flow",
         "start_node": {"$component_ref": "s"},
         "nodes": [{"$component_ref": "s"}, {"$component_ref": "p"},
                   {"$component_ref": "e"}],
         "control_flow_connections": [
           {"component_type": "ControlFlowEdge", "name": "a",
            "from_node": {"$component_ref": "s"},
            "to_node": {"$component_ref": "p"}},
           {"component_type": "ControlFlowEdge", "name": "b",
            "from_node": {"$component_ref": "p"},
            "to_node": {"$component_ref": "e"}}],
         "$referenced_components": {
           "s": {"component_type": "StartNode", "id": "s", "name": "s",
                 "outputs": [{"title": "text", "type": "string"}]},
           "p": {"component_type": "Shout", "id": "p", "name": "p"},
           "e": {"component_type": "EndNode", "id": "e", "name": "e"}}}
        """

    private static let agentFlowYAML = """
        component_type: Flow
        name: smoke-flow
        start_node: { $component_ref: start }
        nodes:
          - { $component_ref: start }
          - { $component_ref: agent }
          - { $component_ref: end }
        control_flow_connections:
          - component_type: ControlFlowEdge
            name: start_to_agent
            from_node: { $component_ref: start }
            to_node: { $component_ref: agent }
          - component_type: ControlFlowEdge
            name: agent_to_end
            from_node: { $component_ref: agent }
            to_node: { $component_ref: end }
        $referenced_components:
          start:
            component_type: StartNode
            id: start
            name: start
            outputs: [{ title: query, type: string }]
          agent:
            component_type: AgentNode
            id: agent
            name: agent
            agent:
              component_type: Agent
              id: inner-agent
              name: inner-agent
              system_prompt: be helpful
              llm_config:
                component_type: OpenAiConfig
                id: llm
                name: openai
                model_id: gpt-4o
          end: { component_type: EndNode, id: end, name: end }
        """
}
#endif
