import CZlib
import Foundation

/// Why a gzip stream would not decompress. Internal, like the rest of this
/// file: `BundleArchive` folds every case into its own "failed to decompress"
/// refusal, the way the TS reader wraps whatever `gunzipSync` threw.
enum GzipError: Error, Equatable {
    /// Inflating would produce more than the caller's budget. The cap exists
    /// so a bomb fails before anything is allocated for it.
    case outputBudgetExceeded(limit: Int)
    /// zlib refused the stream — bad magic, bad CRC, bad deflate data.
    case corruptStream(status: Int32)
    /// The stream ended before zlib saw its end marker.
    case truncatedStream
}

/// Streaming gzip over the zlib Apple ships (`CZlib`), and nothing more.
///
/// `decompress` is the one the bundle reader uses; `compress` exists only so
/// tests can build archives without shelling out — Swift ships no bundle
/// writer, deliberately (`heddle bundle` is the writer).
enum Gzip {
    /// zlib status codes, spelled out rather than imported: the negative
    /// parenthesized `#define`s do not reliably cross the Clang importer.
    private static let zOK: Int32 = 0
    private static let zStreamEnd: Int32 = 1
    private static let zBufError: Int32 = -5
    private static let zNoFlush: Int32 = 0
    private static let zFinish: Int32 = 4
    private static let zDeflated: Int32 = 8
    private static let zDefaultCompression: Int32 = -1
    private static let zDefaultStrategy: Int32 = 0
    /// 15 window bits plus zlib's "add 16 for gzip framing" flag.
    private static let gzipWindowBits: Int32 = 15 + 16

    private static let chunkSize = 64 * 1024

    /// Whether the data starts with the gzip magic (0x1f 0x8b).
    static func isGzip(_ data: Data) -> Bool {
        data.count >= 2 && data[data.startIndex] == 0x1f
            && data[data.index(after: data.startIndex)] == 0x8b
    }

    /// Inflate a gzip stream, refusing once the output would pass `maxBytes`.
    ///
    /// Streamed in 64 KiB chunks so the budget is enforced as the output
    /// grows, not after a bomb has already been held in memory.
    static func decompress(_ data: Data, maxBytes: Int) throws -> Data {
        var stream = z_stream()
        var status = inflateInit2_(
            &stream, gzipWindowBits, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)
        )
        guard status == zOK else { throw GzipError.corruptStream(status: status) }
        defer { inflateEnd(&stream) }

        var output = Data()
        var chunk = [UInt8](repeating: 0, count: chunkSize)

        try data.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
            guard let base = input.baseAddress, !input.isEmpty else {
                throw GzipError.truncatedStream
            }
            // zlib never writes through next_in; the mutable pointer is its
            // API's shape, not a mutation.
            stream.next_in = UnsafeMutablePointer(
                mutating: base.assumingMemoryBound(to: UInt8.self)
            )
            stream.avail_in = UInt32(input.count)

            repeat {
                try chunk.withUnsafeMutableBufferPointer { out in
                    stream.next_out = out.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    status = inflate(&stream, zNoFlush)

                    switch status {
                    case zOK, zStreamEnd, zBufError:
                        break
                    default:
                        throw GzipError.corruptStream(status: status)
                    }

                    let produced = chunkSize - Int(stream.avail_out)
                    if produced > 0 {
                        if output.count + produced > maxBytes {
                            throw GzipError.outputBudgetExceeded(limit: maxBytes)
                        }
                        output.append(out.baseAddress!, count: produced)
                    }
                }
                // No end marker, no input left, nothing produced: the stream
                // was cut, not finished.
                if status == zBufError, stream.avail_in == 0 {
                    throw GzipError.truncatedStream
                }
            } while status != zStreamEnd
        }

        return output
    }

    /// Gzip some bytes. Test-only: the shipped code never writes an archive.
    static func compress(_ data: Data) -> Data {
        var stream = z_stream()
        let status = deflateInit2_(
            &stream, zDefaultCompression, zDeflated, gzipWindowBits, 8,
            zDefaultStrategy, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)
        )
        precondition(status == zOK, "deflateInit2 failed: \(status)")
        defer { deflateEnd(&stream) }

        var output = Data()
        var chunk = [UInt8](repeating: 0, count: chunkSize)

        data.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
            if let base = input.baseAddress, !input.isEmpty {
                stream.next_in = UnsafeMutablePointer(
                    mutating: base.assumingMemoryBound(to: UInt8.self)
                )
                stream.avail_in = UInt32(input.count)
            }

            var state = zOK
            repeat {
                chunk.withUnsafeMutableBufferPointer { out in
                    stream.next_out = out.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    state = deflate(&stream, zFinish)
                    precondition(state >= zOK || state == zBufError, "deflate failed: \(state)")
                    output.append(out.baseAddress!, count: chunkSize - Int(stream.avail_out))
                }
            } while state != zStreamEnd
        }

        return output
    }
}
