import XCTest
import HeddleCore

final class FrameReducerTests: XCTestCase {
    private func reduce(_ lines: [String]) -> FrameReducer {
        var reducer = FrameReducer()
        for line in lines {
            reducer.consume(line: Substring(line))
        }
        return reducer
    }

    func testCoalescesTokenDeltasIntoOneOutputItem() {
        let reducer = reduce([
            #"{"event":"node_start","data":{"type":"node_start","nodeName":"agent"}}"#,
            #"{"event":"token_delta","data":{"type":"token_delta","nodeName":"agent","delta":"Hel"}}"#,
            #"{"event":"token_delta","data":{"type":"token_delta","nodeName":"agent","delta":"lo"}}"#,
        ])

        XCTAssertEqual(reducer.items.count, 2)
        XCTAssertEqual(reducer.items.last?.kind, .output)
        XCTAssertEqual(reducer.items.last?.text, "Hello")
    }

    func testFlowCompleteStripsReservedKeysAndMarksCompletion() {
        let reducer = reduce([
            #"{"event":"flow_complete","data":{"type":"flow_complete","state":{"answer":"42","_chat_history":[],"_resume":{}}}}"#
        ])

        XCTAssertTrue(reducer.completed)
        XCTAssertEqual(
            reducer.finalState,
            .object(["answer": .string("42")])
        )
    }

    func testNodeErrorBecomesFailure() {
        let reducer = reduce([
            #"{"event":"node_error","data":{"type":"node_error","nodeName":"agent","error":{"name":"ToolError","message":"tool exploded"}}}"#
        ])

        XCTAssertEqual(reducer.failure, "tool exploded")
        XCTAssertEqual(reducer.items.last?.kind, .failure)
        XCTAssertFalse(reducer.completed)
    }

    func testServerErrorFrameIsTerminal() {
        let reducer = reduce([
            #"{"event":"token_delta","data":{"type":"token_delta","delta":"partial"}}"#,
            #"{"event":"error","data":{"type":"RunError","message":"the model went away"}}"#,
        ])

        XCTAssertEqual(reducer.streamError, "the model went away")
        XCTAssertEqual(reducer.items.last?.kind, .failure)
    }

    func testSuspendedFrameCarriesSessionAndAsk() {
        let reducer = reduce([
            #"{"event":"suspended","data":{"session":"s-1","by":"ApprovalGate","seam":"toolCall","node":"agent","ask":{"question":"run rm -rf?","reply":{"approved":"true or false"}},"resume":{}}}"#
        ])

        XCTAssertEqual(reducer.suspension?.session, "s-1")
        XCTAssertEqual(reducer.suspension?.by, "ApprovalGate")
        XCTAssertEqual(reducer.suspension?.question, "run rm -rf?")
        XCTAssertEqual(reducer.items.last?.kind, .note)
    }

    func testGarbageLinesAreIgnored() {
        let reducer = reduce([
            "",
            "not json at all",
            #"{"event":"token_delta","data":{"type":"token_delta","delta":"ok"}}"#,
        ])

        XCTAssertEqual(reducer.items.count, 1)
        XCTAssertEqual(reducer.items.first?.text, "ok")
    }

    func testToolCallInterruptsStreaming() {
        let reducer = reduce([
            #"{"event":"token_delta","data":{"type":"token_delta","nodeName":"a","delta":"one"}}"#,
            #"{"event":"tool_call","data":{"type":"tool_call","toolName":"search"}}"#,
            #"{"event":"token_delta","data":{"type":"token_delta","nodeName":"a","delta":"two"}}"#,
        ])

        XCTAssertEqual(reducer.items.count, 3)
        XCTAssertEqual(reducer.items[1].kind, .toolCall(name: "search"))
        XCTAssertEqual(reducer.items[2].text, "two")
    }
}
