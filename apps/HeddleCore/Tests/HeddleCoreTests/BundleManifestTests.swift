import XCTest
import HeddleCore

/// The validation matrix of `validateBundleManifest` in
/// `packages/core/src/bundle/format.ts`, which this type mirrors.
final class BundleManifestTests: XCTestCase {
    private func decode(_ json: String) throws -> BundleManifest {
        try BundleManifest.decode(Data(json.utf8))
    }

    private func assertRefused(
        _ json: String, containing fragment: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertThrowsError(try decode(json), file: file, line: line) { error in
            guard let refused = error as? BundleError else {
                return XCTFail("expected BundleError, got \(error)", file: file, line: line)
            }
            XCTAssertTrue(
                refused.message.contains(fragment),
                "\"\(refused.message)\" does not mention \"\(fragment)\"",
                file: file, line: line
            )
        }
    }

    func testReadsAMinimalManifestWithItsDefaults() throws {
        let manifest = try decode(
            #"{"format": 1, "name": "x", "flow": "flow/f.json"}"#
        )

        XCTAssertEqual(manifest.format, 1)
        XCTAssertEqual(manifest.name, "x")
        XCTAssertEqual(manifest.flow, "flow/f.json")
        XCTAssertNil(manifest.tools)
        XCTAssertEqual(manifest.plugins, [])
        XCTAssertEqual(manifest.pluginConfig, [:])
        XCTAssertEqual(manifest.mounts, [])
        XCTAssertNil(manifest.input)
        XCTAssertNil(manifest.interactive)
        XCTAssertNil(manifest.session)
        XCTAssertNil(manifest.maxToolRounds)
        XCTAssertNil(manifest.requires)
    }

    func testReadsEveryRecordedField() throws {
        let manifest = try decode(
            """
            {
              "format": 1, "name": "demo", "flow": "flow/flow.yaml",
              "tools": "tools",
              "plugins": ["plugins/greeter/plugin.json"],
              "pluginConfig": {"RetryPolicy": {"maxAttempts": 3}},
              "mounts": [
                {"path": "mounts/0", "dest": "knowledge", "mode": "ro"},
                {"path": "mounts/1", "dest": "notes/one.txt", "mode": "rw"},
                {"path": "mounts/2", "dest": "default-mode"}
              ],
              "input": {"query": "hi"},
              "interactive": true, "session": true,
              "maxToolRounds": "unlimited",
              "requires": [{"env": "OPENAI_API_KEY"}]
            }
            """
        )

        XCTAssertEqual(manifest.tools, "tools")
        XCTAssertEqual(manifest.plugins, ["plugins/greeter/plugin.json"])
        XCTAssertEqual(
            manifest.pluginConfig, ["RetryPolicy": ["maxAttempts": .number(3)]]
        )
        XCTAssertEqual(
            manifest.mounts,
            [
                .init(path: "mounts/0", dest: "knowledge", mode: .ro),
                .init(path: "mounts/1", dest: "notes/one.txt", mode: .rw),
                .init(path: "mounts/2", dest: "default-mode", mode: .ro),
            ]
        )
        XCTAssertEqual(manifest.input, ["query": .string("hi")])
        XCTAssertEqual(manifest.interactive, true)
        XCTAssertEqual(manifest.session, true)
        XCTAssertEqual(manifest.maxToolRounds, .string("unlimited"))
        XCTAssertEqual(
            manifest.requires?.compactMap(Requirement.init(json:)),
            [.env(name: "OPENAI_API_KEY", hint: nil)]
        )
    }

    func testRefusesAFormatFromANewerHeddle() {
        assertRefused(
            #"{"format": 99, "name": "x", "flow": "flow/f.json"}"#,
            containing: "newer"
        )
    }

    func testRefusesAnUnusableFormat() {
        assertRefused(#"{"name": "x", "flow": "f"}"#, containing: "format")
        assertRefused(#"{"format": 0, "name": "x", "flow": "f"}"#, containing: "format")
        assertRefused(#"{"format": 1.5, "name": "x", "flow": "f"}"#, containing: "format")
        assertRefused(#"{"format": "1", "name": "x", "flow": "f"}"#, containing: "format")
    }

    func testRefusesWhatIsNotAManifest() {
        assertRefused(#"[1, 2]"#, containing: "JSON object")
        XCTAssertThrowsError(try decode("not json at all")) { error in
            XCTAssertEqual((error as? BundleError)?.message, "heddle.json is not JSON")
        }
    }

    func testRefusesAMissingName() {
        assertRefused(#"{"format": 1, "flow": "f"}"#, containing: "name")
        assertRefused(#"{"format": 1, "name": "", "flow": "f"}"#, containing: "name")
    }

    func testRefusesAManifestPathThatClimbs() {
        assertRefused(
            #"{"format": 1, "name": "x", "flow": "../outside"}"#,
            containing: "steps outside the bundle"
        )
        assertRefused(
            #"{"format": 1, "name": "x", "flow": "a/./b"}"#,
            containing: "steps outside"
        )
        assertRefused(
            #"{"format": 1, "name": "x", "flow": "a//b"}"#,
            containing: "steps outside"
        )
    }

    func testRefusesAnAbsoluteOrBackslashedManifestPath() {
        assertRefused(
            #"{"format": 1, "name": "x", "flow": "/etc/passwd"}"#,
            containing: "relative"
        )
        assertRefused(
            #"{"format": 1, "name": "x", "flow": "a\\b"}"#,
            containing: "relative"
        )
        assertRefused(
            #"{"format": 1, "name": "x", "flow": ""}"#,
            containing: "non-empty path"
        )
    }

    func testValidatesEveryPathTheManifestNames() {
        let base = #""format": 1, "name": "x", "flow": "f.json""#
        assertRefused(
            #"{\#(base), "tools": "../up"}"#, containing: "tools"
        )
        assertRefused(
            #"{\#(base), "plugins": ["ok/plugin.json", "../up"]}"#,
            containing: "plugins[1]"
        )
        assertRefused(
            #"{\#(base), "plugins": "not-an-array"}"#, containing: "array"
        )
        assertRefused(
            #"{\#(base), "mounts": [{"path": "../up", "dest": "d"}]}"#,
            containing: "mounts[0].path"
        )
    }

    func testRefusesABadMount() {
        let base = #""format": 1, "name": "x", "flow": "f.json""#
        assertRefused(
            #"{\#(base), "mounts": [{"path": "m/0", "dest": "d", "mode": "rx"}]}"#,
            containing: "expected ro or rw"
        )
        assertRefused(
            #"{\#(base), "mounts": [{"path": "m/0"}]}"#,
            containing: "missing a \"dest\""
        )
        assertRefused(#"{\#(base), "mounts": {}}"#, containing: "array")
    }

    func testRefusesABadPluginConfig() {
        let base = #""format": 1, "name": "x", "flow": "f.json""#
        assertRefused(
            #"{\#(base), "pluginConfig": {"Retry": "not-an-object"}}"#,
            containing: "pluginConfig[\"Retry\"]"
        )
        assertRefused(
            #"{\#(base), "pluginConfig": []}"#, containing: "object"
        )
    }

    func testReadsMaxToolRoundsAsWritten() throws {
        let base = #""format": 1, "name": "x", "flow": "f.json""#
        XCTAssertEqual(
            try decode(#"{\#(base), "maxToolRounds": 40}"#).maxToolRounds, .number(40)
        )
        XCTAssertEqual(
            try decode(#"{\#(base), "maxToolRounds": "unlimited"}"#).maxToolRounds,
            .string("unlimited")
        )
        assertRefused(
            #"{\#(base), "maxToolRounds": -3}"#, containing: "maxToolRounds"
        )
        assertRefused(
            #"{\#(base), "maxToolRounds": 2.5}"#, containing: "maxToolRounds"
        )
        assertRefused(
            #"{\#(base), "maxToolRounds": " "}"#, containing: "maxToolRounds"
        )
        assertRefused(
            #"{\#(base), "maxToolRounds": true}"#, containing: "maxToolRounds"
        )
    }

    func testProposalsOnlyCountWhenTrue() throws {
        let base = #""format": 1, "name": "x", "flow": "f.json""#
        let refused = try decode(
            #"{\#(base), "interactive": false, "session": false}"#
        )
        XCTAssertNil(refused.interactive)
        XCTAssertNil(refused.session)
    }

    func testNormalizesTheLegacyRequiresObject() throws {
        let manifest = try decode(
            """
            {"format": 1, "name": "x", "flow": "f.json",
             "requires": {"env": ["OPENAI_API_KEY"], "binaries": ["ffmpeg"]}}
            """
        )

        XCTAssertEqual(
            manifest.requires?.compactMap(Requirement.init(json:)),
            [
                .binary(names: ["ffmpeg"], hint: nil),
                .env(name: "OPENAI_API_KEY", hint: nil),
            ]
        )
    }
}
