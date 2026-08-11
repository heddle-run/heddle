import XCTest
@testable import Heddle

final class SSEParserTests: XCTestCase {
    private func parse(_ lines: [String]) -> [SSEEvent] {
        var parser = SSEParser()
        var events: [SSEEvent] = []
        for line in lines {
            if let event = parser.consume(line: line) {
                events.append(event)
            }
        }
        return events
    }

    func testParsesTheServersFrames() {
        // Exactly what SseStream.send writes, split on newlines
        // (`packages/server/src/sse.ts`).
        let events = parse([
            #"event: token_delta"#,
            #"data: {"type":"token_delta","delta":"hi"}"#,
            "",
            #"event: flow_complete"#,
            #"data: {"type":"flow_complete","state":{}}"#,
            "",
        ])

        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].event, "token_delta")
        XCTAssertEqual(events[0].data, #"{"type":"token_delta","delta":"hi"}"#)
        XCTAssertEqual(events[1].event, "flow_complete")
    }

    func testEventlessFrameKeepsNilName() {
        let events = parse([#"data: {"raw":true}"#, ""])

        XCTAssertEqual(events, [SSEEvent(event: nil, data: #"{"raw":true}"#)])
    }

    func testCommentsAndBlankRunsAreIgnored() {
        let events = parse([
            ": keep-alive",
            "",
            "",
            "event: warning",
            #"data: {"message":"careful"}"#,
            "",
        ])

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "warning")
    }

    func testMultipleDataLinesJoinWithNewline() {
        let events = parse(["data: one", "data: two", ""])

        XCTAssertEqual(events[0].data, "one\ntwo")
    }

    func testFrameDecodesIntoRunFrame() {
        let events = parse([
            "event: suspended",
            #"data: {"session":"s-9","by":"gate","ask":{"question":"ok?"}}"#,
            "",
        ])

        let frame = RunFrame(sse: events[0])
        XCTAssertEqual(frame?.event, "suspended")
        XCTAssertEqual(
            frame?.data.objectValue?["session"]?.stringValue, "s-9"
        )
    }
}
