import XCTest
import HeddleCore

/// The smallest agent there is: a name. What core asks of one is exactly
/// what these tests need to provide.
private struct StubAgent: RunAgent {
    let name: String
}

@MainActor
final class RunRecordTests: XCTestCase {
    func testAnswerTextFollowsAnswerOfRule() {
        let agent = StubAgent(name: "x")

        let withResult = RunRecord(agent: agent, sessionID: "s")
        withResult.finalState = .object(["result": .string("the answer"), "extra": .number(1)])
        XCTAssertEqual(withResult.answerText, "the answer")

        let withoutResult = RunRecord(agent: agent, sessionID: "s")
        withoutResult.finalState = .object(["receipt": .string("refunded")])
        XCTAssertEqual(
            withoutResult.answerText,
            #"{"receipt":"refunded"}"#
        )

        let streamedOnly = RunRecord(agent: agent, sessionID: "s")
        streamedOnly.items = [
            TranscriptItem(kind: .output, text: "streamed "),
            TranscriptItem(kind: .output, text: "text"),
        ]
        XCTAssertEqual(streamedOnly.answerText, "streamed text")
    }

    func testSummaryLeadsWithWhatMatters() {
        let record = RunRecord(agent: StubAgent(name: "x"), sessionID: nil)
        XCTAssertEqual(record.summary, "Running…")
        XCTAssertTrue(record.isRunning)

        record.status = .failed("node exploded")
        XCTAssertEqual(record.summary, "node exploded")

        record.status = .succeeded
        record.finalState = .object(["answer": .string("42")])
        XCTAssertEqual(record.summary, "42", "a single-key state shows its value bare")

        record.finalState = .object(["a": .string("1"), "b": .string("2")])
        XCTAssertEqual(record.summary, #"{"a":"1","b":"2"}"#)
    }

    func testSuspendedStatusExposesTheSuspension() {
        let record = RunRecord(agent: StubAgent(name: "x"), sessionID: "s")
        let suspension = Suspension(
            session: "s", by: "gate", ask: .object(["question": .string("ok?")])
        )
        record.status = .suspended(suspension)

        XCTAssertEqual(record.suspension, suspension)
        XCTAssertEqual(record.summary, "ok?")
        XCTAssertFalse(record.isRunning)
    }
}
