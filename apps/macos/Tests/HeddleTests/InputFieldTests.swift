import HeddleCore
import XCTest
@testable import Heddle

final class InputFieldTests: XCTestCase {
    private func agent(input: [String: JSONValue]?) -> Agent {
        Agent(
            url: URL(fileURLWithPath: "/tmp/x.heddle"),
            kind: .bundle,
            name: "x",
            defaultInput: input,
            interactive: false
        )
    }

    func testRecordedStringsPrefillBare() {
        let fields = InputField.fields(for: agent(input: ["transcript": .string("hi")]))

        XCTAssertEqual(fields.count, 1)
        XCTAssertEqual(fields[0].key, "transcript")
        XCTAssertEqual(fields[0].text, "hi")
        XCTAssertTrue(fields[0].wasString)
    }

    func testNoRecordedInputFallsBackToQuery() {
        let fields = InputField.fields(for: agent(input: nil))

        XCTAssertEqual(fields.map(\.key), ["query"])
        XCTAssertEqual(fields[0].text, "")
    }

    func testRoundTripKeepsNonStringJSON() {
        let fields = InputField.fields(for: agent(input: ["limit": .number(5)]))
        let input = InputField.input(from: fields)

        XCTAssertEqual(input["limit"], .number(5))
    }

    func testBlankFieldsAreOmitted() {
        var fields = InputField.fields(for: agent(input: nil))
        fields[0].text = "   "

        XCTAssertTrue(InputField.input(from: fields).isEmpty)
    }

    func testUnparsableJSONFallsBackToString() {
        let fields = [InputField(key: "limit", wasString: false, text: "not json {")]
        let input = InputField.input(from: fields)

        XCTAssertEqual(input["limit"], .string("not json {"))
    }
}
