import XCTest
@testable import HeddleCore

final class BundlePortabilityTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-portability-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func manifest(
        tools: String? = nil,
        plugins: [String] = [],
        mounts: [BundleManifest.Mount] = [],
        requires: [JSONValue]? = nil
    ) -> BundleManifest {
        BundleManifest(
            format: 1, name: "x", flow: "flow/f.json", tools: tools,
            plugins: plugins, pluginConfig: [:], mounts: mounts,
            input: nil, interactive: nil, session: nil,
            maxToolRounds: nil, requires: requires
        )
    }

    private func write(_ text: String, at path: String) throws {
        let url = dir.appendingPathComponent(path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data(text.utf8).write(to: url)
    }

    /// A plugin nothing could fault: one component, a JS entry with no
    /// imports, capabilities the embedded host serves.
    private func writePureJSPlugin(named name: String = "greeter") throws -> String {
        let path = "plugins/\(name)/plugin.json"
        try write(
            """
            {"name": "\(name)", "version": "1.0.0",
             "capabilities": ["log", "callModel"],
             "components": [{"componentType": "Greeter"}],
             "tools": [{"name": "wave", "componentType": "Greeter"}]}
            """,
            at: path
        )
        try write(
            """
            serve(({ registerNode }) => {
              registerNode('Greeter', async () => ({ greeting: 'hi' }));
            });
            """,
            at: "plugins/\(name)/plugin.mjs"
        )
        return path
    }

    private func check(_ manifest: BundleManifest) throws -> PortabilityReport {
        try BundlePortability.check(manifest: manifest, extractedAt: dir)
    }

    func testAPureJSPluginBundleIsPortable() throws {
        let plugin = try writePureJSPlugin()
        let report = try check(manifest(plugins: [plugin]))
        XCTAssertTrue(report.portable, "\(report.reasons)")
        XCTAssertEqual(report.reasons, [])
    }

    func testShippedToolsAreAReason() throws {
        try write("#!/bin/sh\n", at: "tools/greet.sh")
        XCTAssertEqual(try check(manifest(tools: "tools")).reasons, [.hasTools])
    }

    func testAnEmptyToolsDirectoryShipsNothing() throws {
        try FileManager.default.createDirectory(
            at: dir.appendingPathComponent("tools"), withIntermediateDirectories: true
        )
        XCTAssertTrue(try check(manifest(tools: "tools")).portable)
    }

    func testMountsAreAReason() throws {
        let mounted = manifest(mounts: [.init(path: "mounts/0", dest: "knowledge")])
        XCTAssertEqual(try check(mounted).reasons, [.hasMounts])
    }

    func testAPluginCommandIsAReason() throws {
        try write(
            """
            {"name": "shelly", "version": "1.0.0",
             "command": ["python3", "serve.py"],
             "components": [{"componentType": "Shell"}]}
            """,
            at: "plugins/shelly/plugin.json"
        )

        XCTAssertEqual(
            try check(manifest(plugins: ["plugins/shelly/plugin.json"])).reasons,
            [.pluginCommand(plugin: "shelly")]
        )
    }

    func testAPluginWithNoJSEntryIsAReason() throws {
        // Components but no sibling .mjs/.js: nothing the engine can evaluate.
        try write(
            """
            {"name": "ghost", "version": "1.0.0",
             "components": [{"componentType": "Ghost"}]}
            """,
            at: "plugins/ghost/plugin.json"
        )

        XCTAssertEqual(
            try check(manifest(plugins: ["plugins/ghost/plugin.json"])).reasons,
            [.pluginEntryNotJS(plugin: "ghost")]
        )
    }

    func testAPathToolsOnlyPluginNeedsNoEntry() throws {
        // Nothing ever asks this plugin to run — its tools are programs. The
        // programs themselves are caught by the manifest's `tools` or by the
        // executable bit at run level, not by entry analysis.
        try write(
            """
            {"name": "programs", "version": "1.0.0",
             "tools": [{"name": "wave", "path": "wave.sh"}]}
            """,
            at: "plugins/programs/plugin.json"
        )

        XCTAssertTrue(
            try check(manifest(plugins: ["plugins/programs/plugin.json"])).portable
        )
    }

    func testAnESMEntryIsAReason() throws {
        try write(
            """
            {"name": "modular", "version": "1.0.0",
             "components": [{"componentType": "M"}]}
            """,
            at: "plugins/modular/plugin.json"
        )
        try write(
            """
            import { readFile } from 'node:fs/promises';
            serve(() => {});
            """,
            at: "plugins/modular/plugin.mjs"
        )

        XCTAssertEqual(
            try check(manifest(plugins: ["plugins/modular/plugin.json"])).reasons,
            [.pluginMultiFile(plugin: "modular")]
        )
    }

    private func writeModularPlugin() throws -> String {
        try write(
            """
            {"name": "modular", "version": "1.0.0",
             "components": [{"componentType": "M"}]}
            """,
            at: "plugins/modular/plugin.json"
        )
        try write(
            """
            import { handlers } from './handlers.mjs';
            serve(handlers);
            """,
            at: "plugins/modular/plugin.mjs"
        )
        try write(
            "export const handlers = {};\n",
            at: "plugins/modular/handlers.mjs"
        )
        return "plugins/modular/plugin.json"
    }

    func testALinkJudgeThatApprovesMakesAModularEntryPortable() throws {
        let plugin = try writeModularPlugin()

        var sawEntry: String?
        var sawFiles: [String: String] = [:]
        let report = try BundlePortability.check(
            manifest: manifest(plugins: [plugin]), extractedAt: dir,
            linkCheck: { entrySource, files in
                sawEntry = entrySource
                sawFiles = files
                return []
            }
        )

        XCTAssertTrue(report.portable, "\(report.reasons)")
        XCTAssertEqual(sawEntry?.contains("import { handlers }"), true)
        // The judge received every shipped module by plugin-relative path.
        XCTAssertEqual(sawFiles["handlers.mjs"], "export const handlers = {};\n")
        XCTAssertNotNil(sawFiles["plugin.mjs"])
        XCTAssertNil(sawFiles["plugin.json"], "manifests are not modules")
    }

    func testALinkJudgeProblemBecomesAnUnlinkableReason() throws {
        let plugin = try writeModularPlugin()

        let report = try BundlePortability.check(
            manifest: manifest(plugins: [plugin]), extractedAt: dir,
            linkCheck: { _, _ in
                ["the entry imports \"node:fs\", which is not a file the plugin ships"]
            }
        )

        XCTAssertEqual(
            report.reasons,
            [
                .pluginUnlinkable(
                    plugin: "modular",
                    problem: "the entry imports \"node:fs\", which is not a file "
                        + "the plugin ships"
                )
            ]
        )
    }

    func testAThrowingLinkJudgeFallsBackToTheConservativeRefusal() throws {
        let plugin = try writeModularPlugin()

        let report = try BundlePortability.check(
            manifest: manifest(plugins: [plugin]), extractedAt: dir,
            linkCheck: { _, _ in throw BundleError("no engine here") }
        )

        XCTAssertEqual(report.reasons, [.pluginMultiFile(plugin: "modular")])
    }

    func testAnImportFreeEntryNeverMeetsTheLinkJudge() throws {
        let plugin = try writePureJSPlugin()

        let report = try BundlePortability.check(
            manifest: manifest(plugins: [plugin]), extractedAt: dir,
            linkCheck: { _, _ in
                XCTFail("an import-free entry needs no linker")
                return []
            }
        )

        XCTAssertTrue(report.portable)
    }

    func testBinaryFileAndNodeRequirementsAreReasonsButEnvIsFine() throws {
        let report = try check(
            manifest(requires: [
                .object(["env": .string("OPENAI_API_KEY")]),
                .object(["binary": .array([.string("ffmpeg"), .string("avconv")])]),
                .object(["file": .string("~/models/base.bin")]),
                .object(["node": .string(">=22")]),
            ])
        )

        XCTAssertEqual(
            report.reasons,
            [
                .unsupportedRequirement(kind: "binary", name: "ffmpeg or avconv"),
                .unsupportedRequirement(kind: "file", name: "~/models/base.bin"),
                .unsupportedRequirement(kind: "node", name: ">=22"),
            ]
        )
    }

    func testAnUnservedCapabilityIsAReason() throws {
        try write(
            """
            {"name": "grabby", "version": "1.0.0",
             "capabilities": ["log", "openThePodBayDoors"],
             "components": [{"componentType": "G"}]}
            """,
            at: "plugins/grabby/plugin.json"
        )
        try write("serve(() => {});\n", at: "plugins/grabby/plugin.mjs")

        XCTAssertEqual(
            try check(manifest(plugins: ["plugins/grabby/plugin.json"])).reasons,
            [.unsupportedCapability(plugin: "grabby", capability: "openThePodBayDoors")]
        )
    }

    func testReasonsAccumulateAcrossTheManifest() throws {
        try write("#!/bin/sh\n", at: "tools/t.sh")
        let plugin = try writePureJSPlugin()

        let report = try check(
            manifest(
                tools: "tools",
                plugins: [plugin],
                mounts: [.init(path: "mounts/0", dest: "d")],
                requires: [.object(["binary": .string("ffmpeg")])]
            )
        )

        XCTAssertFalse(report.portable)
        XCTAssertEqual(
            report.reasons,
            [
                .hasTools,
                .hasMounts,
                .unsupportedRequirement(kind: "binary", name: "ffmpeg"),
            ]
        )
    }

    func testEveryReasonReadsAsASentenceFragment() {
        let reasons: [PortabilityReport.Reason] = [
            .hasTools, .hasMounts,
            .pluginCommand(plugin: "p"), .pluginEntryNotJS(plugin: "p"),
            .pluginMultiFile(plugin: "p"),
            .pluginUnlinkable(plugin: "p", problem: "imports the moon"),
            .unsupportedRequirement(kind: "binary", name: "ffmpeg"),
            .unsupportedCapability(plugin: "p", capability: "c"),
        ]
        for reason in reasons {
            XCTAssertFalse(reason.label.isEmpty)
        }
    }

    func testModuleSyntaxDetectionByShape() {
        XCTAssertTrue(
            BundlePortability.hasTopLevelModuleSyntax("import x from 'y';\n")
        )
        XCTAssertTrue(
            BundlePortability.hasTopLevelModuleSyntax("  import{a}from'b'\n")
        )
        XCTAssertTrue(
            BundlePortability.hasTopLevelModuleSyntax("export { a } from 'b';\n")
        )
        XCTAssertTrue(
            BundlePortability.hasTopLevelModuleSyntax("code();\nexport * from 'b';\n")
        )
        XCTAssertFalse(
            BundlePortability.hasTopLevelModuleSyntax("export const x = 1;\n"),
            "a plain export is not a module graph"
        )
        XCTAssertFalse(
            BundlePortability.hasTopLevelModuleSyntax("const importer = 1;\n")
        )
        XCTAssertFalse(
            BundlePortability.hasTopLevelModuleSyntax("// import x from 'y'\n")
        )
        XCTAssertFalse(
            BundlePortability.hasTopLevelModuleSyntax("serve(() => {});\n")
        )
    }
}
