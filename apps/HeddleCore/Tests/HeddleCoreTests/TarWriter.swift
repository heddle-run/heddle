import Foundation
@testable import HeddleCore

/// A minimal ustar writer, for tests only.
///
/// The shipped package deliberately reads and never writes — `heddle bundle`
/// is the writer. Tests still need archives to read, so this ports the
/// writing half of `packages/core/src/bundle/tar.ts` (headers, checksums,
/// the name/prefix split, the two-zero-block terminator) just far enough to
/// build the vectors `bundle.test.ts` builds.
enum TarWriter {
    static let block = 512
    private static let nameField = 100
    private static let prefixField = 155

    /// The archive as `readTarGz` expects it: gzipped blocks.
    static func writeTarGz(_ entries: [TarEntry]) -> Data {
        Gzip.compress(blocks(entries))
    }

    /// The uncompressed blocks, for tests that corrupt bytes before gzipping.
    static func blocks(_ entries: [TarEntry]) -> Data {
        var tar = Data()
        for entry in entries {
            tar.append(header(entry))
            if let data = entry.data, !data.isEmpty {
                tar.append(data)
                let spill = data.count % block
                if spill > 0 { tar.append(Data(count: block - spill)) }
            }
        }
        // Two zero blocks are the end-of-archive marker readers stop at.
        tar.append(Data(count: block * 2))
        return tar
    }

    static func header(_ entry: TarEntry) -> Data {
        let directory = entry.data == nil
        let (name, prefix) = splitName(directory ? entry.name + "/" : entry.name)

        var header = [UInt8](repeating: 0, count: block)
        write(name, into: &header, at: 0, width: nameField)
        writeOctal(
            directory || entry.executable ? 0o755 : 0o644,
            into: &header, at: 100, width: 8
        )
        writeOctal(0, into: &header, at: 108, width: 8) // uid
        writeOctal(0, into: &header, at: 116, width: 8) // gid
        writeOctal(entry.data?.count ?? 0, into: &header, at: 124, width: 12)
        writeOctal(0, into: &header, at: 136, width: 12) // mtime
        header[156] = directory ? 0x35 : 0x30
        write("ustar", into: &header, at: 257, width: 6)
        write("00", into: &header, at: 263, width: 2)
        write(prefix, into: &header, at: 345, width: prefixField)

        writeChecksum(&header)
        return Data(header)
    }

    /// A raw header with an arbitrary typeflag and size, checksummed — the
    /// hand-built vector `bundle.test.ts` uses for its symlink refusal.
    static func rawHeader(name: String, typeflag: UInt8, size: Int = 0) -> Data {
        var header = [UInt8](repeating: 0, count: block)
        write(name, into: &header, at: 0, width: nameField)
        writeOctal(0o644, into: &header, at: 100, width: 8)
        writeOctal(size, into: &header, at: 124, width: 12)
        header[156] = typeflag
        write("ustar", into: &header, at: 257, width: 6)
        write("00", into: &header, at: 263, width: 2)
        writeChecksum(&header)
        return Data(header)
    }

    private static func splitName(_ path: String) -> (name: String, prefix: String) {
        if path.utf8.count <= nameField { return (path, "") }

        let characters = Array(path)
        for cut in stride(from: characters.count - 1, to: 0, by: -1) {
            guard characters[cut] == "/" else { continue }
            let prefix = String(characters[0..<cut])
            let name = String(characters[(cut + 1)...])
            if prefix.utf8.count <= prefixField, !name.isEmpty,
                name.utf8.count <= nameField {
                return (name, prefix)
            }
        }

        preconditionFailure("\"\(path)\" is too long for a bundle entry")
    }

    private static func write(
        _ text: String, into header: inout [UInt8], at: Int, width: Int
    ) {
        for (index, byte) in text.utf8.prefix(width).enumerated() {
            header[at + index] = byte
        }
    }

    private static func writeOctal(
        _ value: Int, into header: inout [UInt8], at: Int, width: Int
    ) {
        var text = String(value, radix: 8)
        while text.count < width - 1 { text = "0" + text }
        write(text, into: &header, at: at, width: width - 1)
        // The trailing byte is already NUL.
    }

    static func writeChecksum(_ header: inout [UInt8]) {
        for index in 148..<156 { header[index] = 0x20 }
        var sum = 0
        for byte in header { sum += Int(byte) }
        var text = String(sum, radix: 8)
        while text.count < 6 { text = "0" + text }
        write(text, into: &header, at: 148, width: 6)
        header[154] = 0
        header[155] = 0x20
    }
}
