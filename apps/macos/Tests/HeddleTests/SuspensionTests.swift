import XCTest
@testable import Heddle

final class SuspensionTests: XCTestCase {
    func testSuspendedFrameBecomesSuspension() {
        var reducer = FrameReducer()
        reducer.consume(
            line: Substring(
                #"{"event":"suspended","data":{"session":"s-1","by":"Pause","seam":"node","ask":{"question":"Run pay?","reply":{"approved":"true or false"}},"node":"pay","resume":{}}}"#
            )
        )

        XCTAssertEqual(reducer.suspension?.session, "s-1")
        XCTAssertEqual(reducer.suspension?.by, "Pause")
        XCTAssertEqual(reducer.suspension?.question, "Run pay?")
        XCTAssertEqual(reducer.items.last?.kind, .note)
    }

    func testSessionRowParsing() {
        let row = SessionRow.parse(line: "app-42  2026-08-10T09:00:00.000Z  3 turns  /tmp/x.yaml")
        XCTAssertEqual(row?.id, "app-42")
        XCTAssertEqual(row?.state, "3 turns")
        XCTAssertEqual(row?.flow, "/tmp/x.yaml")

        let unfinished = SessionRow.parse(line: "s2  2026-08-10T09:00:00.000Z  unfinished")
        XCTAssertEqual(unfinished?.state, "unfinished")
        XCTAssertNil(unfinished?.flow)

        XCTAssertNil(SessionRow.parse(line: "not a row"))
    }

    @MainActor
    func testAnswerTextFollowsAnswerOfRule() {
        let agent = Agent(
            url: URL(fileURLWithPath: "/tmp/x.heddle"), kind: .bundle,
            name: "x", defaultInput: nil, interactive: true
        )

        let withResult = RunRecord(agent: agent, sessionID: "s")
        withResult.finalState = .object(["result": .string("the answer"), "extra": .number(1)])
        XCTAssertEqual(ChatController.answerText(of: withResult), "the answer")

        let withoutResult = RunRecord(agent: agent, sessionID: "s")
        withoutResult.finalState = .object(["receipt": .string("refunded")])
        XCTAssertEqual(
            ChatController.answerText(of: withoutResult),
            #"{"receipt":"refunded"}"#
        )

        let streamedOnly = RunRecord(agent: agent, sessionID: "s")
        streamedOnly.items = [
            TranscriptItem(kind: .output, text: "streamed "),
            TranscriptItem(kind: .output, text: "text"),
        ]
        XCTAssertEqual(ChatController.answerText(of: streamedOnly), "streamed text")
    }
}
