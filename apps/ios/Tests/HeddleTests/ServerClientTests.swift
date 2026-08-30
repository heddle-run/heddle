import HeddleCore
import XCTest
@testable import Heddle

/// The app's own slice of the server protocol: the `POST /v1/runs` body and
/// the `GET /v1/capabilities` read. The frames and their reducer are
/// heddle-core's and tested there; what is tested here is what only this
/// app encodes and decodes.
final class ServerClientTests: XCTestCase {
    private func encoded(_ body: RunRequest) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
    }

    func testRunRequestCarriesOnlyWhatWasSet() throws {
        var body = RunRequest()
        body.flowPath = "flows/demo.yaml"
        body.session = "s-1"

        let json = try encoded(body)
        XCTAssertEqual(json.objectValue?.keys.sorted(), ["flowPath", "session"])
        XCTAssertEqual(json.objectValue?["flowPath"]?.stringValue, "flows/demo.yaml")
    }

    func testRunRequestCarriesAServerBundleID() throws {
        var body = RunRequest()
        body.bundle = "a".padding(toLength: 8, withPad: "a", startingAt: 0)
        body.session = "s-1"
        body.resume = true

        let json = try encoded(body)
        XCTAssertEqual(json.objectValue?.keys.sorted(), ["bundle", "resume", "session"])
        XCTAssertEqual(json.objectValue?["bundle"]?.stringValue, "aaaaaaaa")
    }

    func testCapabilitiesReadTheBundlesBlock() throws {
        let data = Data(
            #"{"version":"1","bundles":{"enabled":true,"maxBytes":67108864,"store":true}}"#
                .utf8)
        let caps = try JSONDecoder().decode(ServerCapabilities.self, from: data)
        XCTAssertTrue(caps.bundlesEnabled)
        XCTAssertEqual(caps.bundles?.maxBytes, 67_108_864)

        // An older server that predates /v1/bundles: absent means off.
        let old = try JSONDecoder().decode(
            ServerCapabilities.self, from: Data(#"{"version":"1"}"#.utf8))
        XCTAssertFalse(old.bundlesEnabled)
    }

    func testBundleUploadDecodesTheStoreAnswer() throws {
        let data = Data(
            #"{"id":"deadbeef","name":"coding-agent","portable":false,"reasons":["x"]}"#
                .utf8)
        let upload = try JSONDecoder().decode(BundleUpload.self, from: data)
        XCTAssertEqual(upload.id, "deadbeef")
        XCTAssertEqual(upload.name, "coding-agent")
        XCTAssertEqual(upload.portable, false)
    }

    func testRunRequestSendsInlineFlowAndAnswerVerbatim() throws {
        var body = RunRequest()
        body.flow = .string("component_type: Flow")
        body.inputs = ["query": .string("hi")]
        body.resume = true
        body.answer = .object(["approved": .bool(true)])

        let json = try encoded(body).objectValue
        XCTAssertEqual(json?["flow"], .string("component_type: Flow"))
        XCTAssertEqual(json?["inputs"], .object(["query": .string("hi")]))
        XCTAssertEqual(json?["resume"], .bool(true))
        XCTAssertEqual(json?["answer"]?.objectValue?["approved"], .bool(true))
    }

    func testCapabilitiesReadTheSessionsBlock() throws {
        let full = try JSONDecoder().decode(
            ServerCapabilities.self,
            from: Data(
                #"{"version":"0.2.0","sessions":{"enabled":true,"store":"file"},"protocols":["heddle"]}"#
                    .utf8
            )
        )
        XCTAssertTrue(full.sessionsEnabled)
        XCTAssertEqual(full.sessions?.store, "file")

        let bare = try JSONDecoder().decode(
            ServerCapabilities.self,
            from: Data(#"{"version":"0.1.0"}"#.utf8)
        )
        XCTAssertFalse(bare.sessionsEnabled)
    }
}
