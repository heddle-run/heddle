import HeddleCore
import XCTest
@testable import Heddle

final class RequirementTests: XCTestCase {
    private func decode(_ json: String) -> Requirement? {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return Requirement(json: value)
    }

    func testDecodesEveryKind() {
        XCTAssertEqual(
            decode(#"{"env":"OPENAI_API_KEY","hint":"an OpenAI key"}"#),
            .env(name: "OPENAI_API_KEY", hint: "an OpenAI key")
        )
        XCTAssertEqual(
            decode(#"{"binary":["ffmpeg","avconv"]}"#),
            .binary(names: ["ffmpeg", "avconv"], hint: nil)
        )
        XCTAssertEqual(
            decode(#"{"file":"~/notes"}"#),
            .file(path: "~/notes", hint: nil)
        )
        XCTAssertEqual(
            decode(#"{"node":">=18"}"#),
            .node(range: ">=18", hint: nil)
        )
    }

    func testUnknownShapesDecodeToNil() {
        XCTAssertNil(decode(#"{"gpu":"metal"}"#))
        XCTAssertNil(decode(#""just a string""#))
    }

    @MainActor
    func testPreflightObservesThisMachine() {
        let keychain = KeychainStore(service: "run.heddle.app.tests.\(UUID().uuidString)")

        let checks = Preflight.check(
            [
                .binary(names: ["tar"], hint: nil),
                .binary(names: ["definitely-not-a-real-binary-xyz"], hint: nil),
                .file(path: "/System", hint: nil),
                .env(name: "HEDDLE_TEST_NEVER_SET_XYZ", hint: nil),
                .node(range: ">=18", hint: nil),
            ],
            keychain: keychain
        )

        XCTAssertEqual(checks.map(\.holds), [true, false, true, false, true])
    }

    @MainActor
    func testKeychainRoundTrip() throws {
        let keychain = KeychainStore(service: "run.heddle.app.tests.\(UUID().uuidString)")
        let name = "HEDDLE_TEST_KEY"
        defer { keychain.delete(name) }

        XCTAssertFalse(keychain.has(name))
        try keychain.set(name, value: "first")
        XCTAssertTrue(keychain.has(name))
        try keychain.set(name, value: "second")
        XCTAssertEqual(keychain.environment()[name], "second")
        XCTAssertEqual(keychain.names(), [name])

        keychain.delete(name)
        XCTAssertFalse(keychain.has(name))
    }
}
