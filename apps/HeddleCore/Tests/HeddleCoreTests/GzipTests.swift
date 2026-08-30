import XCTest
@testable import HeddleCore

final class GzipTests: XCTestCase {
    func testRoundTripsThroughTheTestOnlyCompressor() throws {
        let original = Data("the same bytes, there and back".utf8)
        let inflated = try Gzip.decompress(
            Gzip.compress(original), maxBytes: 1024 * 1024
        )
        XCTAssertEqual(inflated, original)
    }

    func testRoundTripsSomethingLargerThanOneChunk() throws {
        // Past the 64 KiB streaming chunk, so append-per-chunk is exercised.
        var original = Data()
        for index in 0..<20_000 {
            original.append(Data("line \(index)\n".utf8))
        }
        XCTAssertGreaterThan(original.count, 128 * 1024)

        let inflated = try Gzip.decompress(
            Gzip.compress(original), maxBytes: original.count
        )
        XCTAssertEqual(inflated, original)
    }

    func testRecognizesTheMagic() {
        XCTAssertTrue(Gzip.isGzip(Gzip.compress(Data("x".utf8))))
        XCTAssertFalse(Gzip.isGzip(Data("{\"not\":\"gzip\"}".utf8)))
        XCTAssertFalse(Gzip.isGzip(Data([0x1f])))
        XCTAssertFalse(Gzip.isGzip(Data()))
    }

    func testRefusesWhatIsNotAGzipStream() {
        XCTAssertThrowsError(
            try Gzip.decompress(Data("plain text, no framing".utf8), maxBytes: 1024)
        ) { error in
            guard case GzipError.corruptStream = error else {
                return XCTFail("expected corruptStream, got \(error)")
            }
        }
    }

    func testRefusesOutputPastTheBudget() {
        // Highly compressible on purpose: the bomb shape the cap exists for.
        let inflatable = Gzip.compress(Data(count: 512 * 1024))

        XCTAssertThrowsError(
            try Gzip.decompress(inflatable, maxBytes: 4096)
        ) { error in
            XCTAssertEqual(
                error as? GzipError, .outputBudgetExceeded(limit: 4096)
            )
        }
    }

    func testRefusesATruncatedStream() {
        let whole = Gzip.compress(Data(repeating: 0x61, count: 4096))
        let cut = whole.prefix(whole.count / 2)

        XCTAssertThrowsError(
            try Gzip.decompress(Data(cut), maxBytes: 1024 * 1024)
        ) { error in
            XCTAssertEqual(error as? GzipError, .truncatedStream)
        }
    }
}
