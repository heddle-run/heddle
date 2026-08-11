import XCTest
@testable import Heddle

final class AppURLTests: XCTestCase {
    private func parse(_ text: String) -> AppURL? {
        URL(string: text).flatMap(AppURL.parse)
    }

    func testRunWithAgentOnly() {
        XCTAssertEqual(
            parse("heddle://run?agent=Meeting%20Notes"),
            .run(agent: "Meeting Notes", input: nil)
        )
    }

    func testRunWithInput() {
        XCTAssertEqual(
            parse("heddle://run?agent=csv-analyst&input=%7B%22query%22%3A%22top%20rows%22%7D"),
            .run(agent: "csv-analyst", input: ["query": .string("top rows")])
        )
    }

    func testRefusesWhatItDoesNotSpeak() {
        XCTAssertNil(parse("heddle://run"))
        XCTAssertNil(parse("heddle://install?agent=x"))
        XCTAssertNil(parse("https://run?agent=x"))
        XCTAssertNil(parse("heddle://run?agent="))
    }

    func testMalformedInputBecomesNoInput() {
        XCTAssertEqual(
            parse("heddle://run?agent=x&input=not-json"),
            .run(agent: "x", input: nil)
        )
    }
}
