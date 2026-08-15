import XCTest
@testable import Heddle

final class SessionRowTests: XCTestCase {
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
}
