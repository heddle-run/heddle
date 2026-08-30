import XCTest
@testable import HeddleCore

final class BundleReaderTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-bundle-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func writeArchive(_ entries: [TarEntry], as name: String) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try TarWriter.writeTarGz(entries).write(to: url)
        return url
    }

    private func manifestEntry(_ json: String) -> TarEntry {
        TarEntry(name: "heddle.json", data: Data(json.utf8))
    }

    private func permissions(at url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    // MARK: - manifest(at:)

    func testReadsTheManifestWhereverItSitsInTheArchive() throws {
        // The packer writes heddle.json first; its position is layout, not
        // contract, so here it sits last.
        let url = try writeArchive(
            [
                TarEntry(name: "flow"),
                TarEntry(name: "flow/f.json", data: Data("{}".utf8)),
                manifestEntry(#"{"format": 1, "name": "buried", "flow": "flow/f.json"}"#),
            ],
            as: "buried.heddle"
        )

        XCTAssertEqual(try BundleReader.manifest(at: url).name, "buried")
    }

    func testRefusesAnArchiveWithNoManifestAsNotABundle() throws {
        let url = try writeArchive(
            [TarEntry(name: "flow.json", data: Data("{}".utf8))],
            as: "bare.heddle"
        )

        XCTAssertThrowsError(try BundleReader.manifest(at: url)) { error in
            XCTAssertTrue(
                (error as? BundleError)?.message
                    .contains("no heddle.json at its root") == true
            )
        }
    }

    func testRefusesAMissingFile() {
        let missing = dir.appendingPathComponent("not-there.heddle")
        XCTAssertThrowsError(try BundleReader.manifest(at: missing)) { error in
            XCTAssertTrue(
                (error as? BundleError)?.message.contains("cannot read bundle") == true
            )
        }
    }

    // MARK: - extract(archive:into:)

    func testExtractsFilesDirectoriesAndModes() throws {
        let url = try writeArchive(
            [
                manifestEntry(
                    #"{"format": 1, "name": "x", "flow": "flow/f.json", "tools": "tools"}"#
                ),
                TarEntry(name: "flow"),
                TarEntry(name: "flow/f.json", data: Data("{}".utf8)),
                TarEntry(name: "tools"),
                TarEntry(
                    name: "tools/greet.py", executable: true,
                    data: Data("#!/usr/bin/env python3\n".utf8)
                ),
                TarEntry(name: "tools/notes.txt", data: Data("not executable".utf8)),
            ],
            as: "demo.heddle"
        )

        let out = dir.appendingPathComponent("extracted")
        let manifest = try BundleReader.extract(archive: url, into: out)

        XCTAssertEqual(manifest.name, "x")
        XCTAssertEqual(
            try String(
                contentsOf: out.appendingPathComponent("flow/f.json"), encoding: .utf8
            ),
            "{}"
        )
        // The executable bit — the whole of what makes a file a tool — survived.
        XCTAssertEqual(
            try permissions(at: out.appendingPathComponent("tools/greet.py")), 0o755
        )
        XCTAssertEqual(
            try permissions(at: out.appendingPathComponent("tools/notes.txt")), 0o644
        )
    }

    func testRefusesAnEntryThatWouldLandOutsideTheExtraction() throws {
        let url = try writeArchive(
            [
                manifestEntry(#"{"format": 1, "name": "x", "flow": "flow/f.json"}"#),
                TarEntry(name: "flow/f.json", data: Data("{}".utf8)),
                TarEntry(name: "a/../../escape.txt", data: Data("out".utf8)),
            ],
            as: "escape.heddle"
        )

        XCTAssertThrowsError(
            try BundleReader.extract(archive: url, into: dir.appendingPathComponent("x"))
        ) { error in
            XCTAssertTrue(
                (error as? BundleError)?.message
                    .contains("steps outside the extraction directory") == true
            )
        }
    }

    func testRefusesAManifestThatNamesWhatTheArchiveDoesNotCarry() throws {
        let url = try writeArchive(
            [
                manifestEntry(
                    #"{"format": 1, "name": "x", "flow": "flow/f.json", "tools": "tools"}"#
                ),
                TarEntry(name: "flow/f.json", data: Data("{}".utf8)),
            ],
            as: "hollow.heddle"
        )

        XCTAssertThrowsError(
            try BundleReader.extract(archive: url, into: dir.appendingPathComponent("x"))
        ) { error in
            XCTAssertTrue(
                (error as? BundleError)?.message.contains("does not carry it") == true
            )
        }
    }

    func testWritesNothingWhenTheManifestIsRefused() throws {
        let url = try writeArchive(
            [
                manifestEntry(#"{"format": 1, "name": "x", "flow": "../up"}"#),
                TarEntry(name: "innocent.txt", data: Data("x".utf8)),
            ],
            as: "bad.heddle"
        )

        let target = dir.appendingPathComponent("untouched")
        XCTAssertThrowsError(
            try BundleReader.extract(archive: url, into: target)
        )
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: target.appendingPathComponent("innocent.txt").path
            )
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    // MARK: - The real thing

    /// `mini.heddle` was written by `heddle bundle` itself — the
    /// cross-implementation proof that both readers speak one format.
    private var fixture: URL {
        get throws {
            try XCTUnwrap(
                Bundle.module.url(
                    forResource: "mini", withExtension: "heddle",
                    subdirectory: "Fixtures"
                )
            )
        }
    }

    func testReadsTheManifestOfABundleTheCLIWrote() throws {
        let manifest = try BundleReader.manifest(at: try fixture)

        XCTAssertEqual(manifest.format, 1)
        XCTAssertEqual(manifest.name, "mini")
        XCTAssertEqual(manifest.flow, "flow/flow.yaml")
        XCTAssertEqual(manifest.input, ["task": .string("hi")])
        XCTAssertEqual(
            manifest.requires?.compactMap(Requirement.init(json:)),
            [.env(name: "OPENAI_API_KEY", hint: nil)]
        )
    }

    func testExtractsABundleTheCLIWrote() throws {
        let out = dir.appendingPathComponent("mini-extracted")
        let manifest = try BundleReader.extract(archive: try fixture, into: out)

        let flow = out.appendingPathComponent(manifest.flow)
        let source = try String(contentsOf: flow, encoding: .utf8)
        XCTAssertTrue(source.contains("component_type: Flow"))
        XCTAssertEqual(try permissions(at: flow), 0o644)

        let report = try BundlePortability.check(manifest: manifest, extractedAt: out)
        XCTAssertTrue(report.portable, "\(report.reasons)")
    }
}
