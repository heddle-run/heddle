import XCTest
@testable import HeddleCore

/// The reading rules of `packages/core/src/bundle/tar.ts`, checked against
/// the same vectors its `bundle.test.ts` builds — headers written by hand so
/// the two implementations are compared on bytes, not on each other.
final class BundleArchiveTests: XCTestCase {
    private let maxBytes = 1024 * 1024
    private let maxEntries = 256

    private func read(
        _ archive: Data, maxBytes: Int? = nil, maxEntries: Int? = nil
    ) throws -> [TarEntry] {
        try BundleArchive.read(
            archive,
            maxBytes: maxBytes ?? self.maxBytes,
            maxEntries: maxEntries ?? self.maxEntries
        )
    }

    func testRoundTripsFilesDirectoriesAndTheExecutableBit() throws {
        let entries = [
            TarEntry(name: "a-dir"),
            TarEntry(name: "a-dir/plain.txt", data: Data("hello".utf8)),
            TarEntry(
                name: "tool.py", executable: true,
                data: Data("#!/usr/bin/env python3\n".utf8)
            ),
            TarEntry(name: "empty", data: Data()),
        ]

        let back = try read(TarWriter.writeTarGz(entries))

        XCTAssertEqual(
            back.map(\.name), ["a-dir", "a-dir/plain.txt", "tool.py", "empty"]
        )
        XCTAssertNil(back[0].data)
        XCTAssertEqual(back[1].data, Data("hello".utf8))
        XCTAssertFalse(back[1].executable)
        XCTAssertTrue(back[2].executable)
        XCTAssertEqual(back[3].data?.count, 0)
    }

    func testCarriesAPathLongerThanOneUstarNameField() throws {
        let deep = String(repeating: "long-directory-name/", count: 8) + "file.txt"
        XCTAssertGreaterThan(deep.count, 100)

        let back = try read(
            TarWriter.writeTarGz([TarEntry(name: deep, data: Data("x".utf8))])
        )
        XCTAssertEqual(back[0].name, deep)
    }

    func testRejectsWhatIsNotGzip() {
        XCTAssertThrowsError(
            try read(Data("{\"not\":\"a bundle\"}".utf8))
        ) { error in
            XCTAssertEqual(error as? BundleArchiveError, .notGzip)
            XCTAssertTrue(
                (error as? BundleArchiveError)?.errorDescription?
                    .contains("does not start with gzip") == true
            )
        }
    }

    func testRejectsAStreamGzipRefuses() {
        // Gzip magic, garbage after: past the door check, dead in zlib.
        XCTAssertThrowsError(
            try read(Data([0x1f, 0x8b, 0xff, 0xff, 0xff, 0xff]))
        ) { error in
            XCTAssertEqual(error as? BundleArchiveError, .decompressFailed)
        }
    }

    func testRejectsAnArchiveOverTheEntryBudget() {
        let entries = (0..<5).map { TarEntry(name: "f\($0)", data: Data()) }

        XCTAssertThrowsError(
            try read(TarWriter.writeTarGz(entries), maxBytes: 1024, maxEntries: 3)
        ) { error in
            XCTAssertEqual(error as? BundleArchiveError, .tooManyEntries(limit: 3))
        }
    }

    func testRejectsAnArchiveOverTheByteBudget() {
        let entries = [
            TarEntry(name: "a", data: Data(count: 600)),
            TarEntry(name: "b", data: Data(count: 600)),
        ]

        XCTAssertThrowsError(
            try read(TarWriter.writeTarGz(entries), maxBytes: 1000)
        ) { error in
            XCTAssertEqual(error as? BundleArchiveError, .tooManyBytes(limit: 1000))
        }
    }

    func testRejectsACorruptedChecksumNamingTheOffset() throws {
        var tar = TarWriter.blocks([
            TarEntry(name: "fine.txt", data: Data("ok".utf8)),
            TarEntry(name: "victim.txt", data: Data("ok".utf8)),
        ])
        // Flip a name byte in the second header without re-checksumming.
        let secondHeader = TarWriter.block * 2
        tar[secondHeader] = UInt8(ascii: "X")

        XCTAssertThrowsError(try read(Gzip.compress(tar))) { error in
            XCTAssertEqual(
                error as? BundleArchiveError,
                .checksumMismatch(atByte: secondHeader)
            )
        }
    }

    func testSkipsPaxHeadersUnparsed() throws {
        // A PAX attribute block ('x') and a global one ('g'), each with a
        // payload, the way a stock tar writes them. Both must vanish.
        var tar = Data()
        tar.append(TarWriter.rawHeader(name: "./PaxHeaders/f", typeflag: 0x78, size: 30))
        tar.append(Data(count: TarWriter.block)) // padded payload
        tar.append(TarWriter.rawHeader(name: "pax_global_header", typeflag: 0x67, size: 20))
        tar.append(Data(count: TarWriter.block))
        tar.append(TarWriter.blocks([TarEntry(name: "real.txt", data: Data("kept".utf8))]))

        let back = try read(Gzip.compress(tar))
        XCTAssertEqual(back.map(\.name), ["real.txt"])
        XCTAssertEqual(back[0].data, Data("kept".utf8))
    }

    func testRejectsALinkEntryNamingItsType() {
        // Hand-built: the writer refuses to produce one, which is the point.
        var tar = TarWriter.rawHeader(name: "evil-link", typeflag: 0x32) // '2'
        tar.append(Data(count: TarWriter.block * 2))

        XCTAssertThrowsError(try read(Gzip.compress(tar))) { error in
            XCTAssertEqual(
                error as? BundleArchiveError,
                .unsupportedEntryType(entry: "evil-link", type: "2")
            )
            XCTAssertTrue(
                (error as? BundleArchiveError)?.errorDescription?
                    .contains("type '2'") == true
            )
        }
    }

    func testStopsAtTheAllZeroTerminator() throws {
        var tar = TarWriter.blocks([TarEntry(name: "before.txt", data: Data("x".utf8))])
        // Anything after the terminator is not part of the archive.
        tar.append(TarWriter.header(TarEntry(name: "after.txt", data: Data())))

        let back = try read(Gzip.compress(tar))
        XCTAssertEqual(back.map(\.name), ["before.txt"])
    }

    func testRejectsTruncationMidEntryNamingIt() {
        // A header promising 100 bytes of content the archive does not hold.
        let tar = TarWriter.rawHeader(name: "cut-short.txt", typeflag: 0x30, size: 100)

        XCTAssertThrowsError(try read(Gzip.compress(tar))) { error in
            XCTAssertEqual(
                error as? BundleArchiveError, .truncated(entry: "cut-short.txt")
            )
            XCTAssertTrue(
                (error as? BundleArchiveError)?.errorDescription?
                    .contains("truncated at \"cut-short.txt\"") == true
            )
        }
    }

    func testRejectsABadOctalField() {
        var header = [UInt8](TarWriter.rawHeader(name: "bad", typeflag: 0x30))
        // A size field with no octal digit at all.
        for (index, byte) in "xxxxxxx".utf8.enumerated() { header[124 + index] = byte }
        TarWriter.writeChecksum(&header)
        var tar = Data(header)
        tar.append(Data(count: TarWriter.block * 2))

        XCTAssertThrowsError(try read(Gzip.compress(tar))) { error in
            XCTAssertEqual(error as? BundleArchiveError, .badOctalField)
        }
    }
}
