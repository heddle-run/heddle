import Foundation

/// One thing a `.heddle` archive carries: a file, or a directory (nil data).
public struct TarEntry: Equatable {
    /// Path inside the archive, '/'-separated.
    public var name: String
    public var executable: Bool
    /// The file's bytes; a directory has none.
    public var data: Data?

    public init(name: String, executable: Bool = false, data: Data? = nil) {
        self.name = name
        self.executable = executable
        self.data = data
    }
}

/// Everything the tar layer refuses, each with the words the TS reader
/// (`packages/core/src/bundle/tar.ts`) would use for the same archive.
public enum BundleArchiveError: Error, LocalizedError, Equatable {
    /// The file does not start with the gzip magic — not a bundle at all.
    case notGzip
    /// zlib refused the stream, or inflating passed the output budget.
    case decompressFailed
    /// A header field that should hold an octal number holds something else.
    case badOctalField
    /// A header whose bytes do not add up to their recorded checksum.
    case checksumMismatch(atByte: Int)
    /// A header promises more content than the archive holds.
    case truncated(entry: String)
    /// A typeflag a bundle does not carry — a symlink, a device, a fifo.
    case unsupportedEntryType(entry: String, type: Character)
    case tooManyEntries(limit: Int)
    case tooManyBytes(limit: Int)

    public var errorDescription: String? {
        switch self {
        case .notGzip:
            return "not a heddle bundle: the file does not start with gzip. "
                + "A .heddle is a gzipped tar archive with a heddle.json inside — "
                + "was this file made with \"heddle bundle\"?"
        case .decompressFailed:
            return "failed to decompress the bundle"
        case .badOctalField:
            return "corrupt bundle: bad number in a tar header"
        case .checksumMismatch(let offset):
            return "corrupt bundle: header checksum mismatch at byte \(offset)"
        case .truncated(let entry):
            return "bundle is truncated at \"\(entry)\""
        case .unsupportedEntryType(let entry, let type):
            return "bundle entry \"\(entry)\" has type '\(type)', which "
                + "a .heddle does not carry. A bundle is plain files and directories — "
                + "a link would resolve outside the extraction, so it is refused."
        case .tooManyEntries(let limit):
            return "bundle holds more than \(limit) entries"
        case .tooManyBytes(let limit):
            return "bundle unpacks to more than \(limit) bytes"
        }
    }
}

/// The ustar reader, ported rule for rule from
/// `packages/core/src/bundle/tar.ts` — that file is the format authority, and
/// a divergence here would be a bundle that opens on one platform and not the
/// other. Reader only: Swift never writes a bundle, `heddle bundle` does.
///
/// Only the subset a bundle speaks is read: plain files and directories, one
/// mode bit that matters (executable). PAX attribute blocks are skipped
/// unparsed so an archive a stock tar produced still opens; a symlink is
/// refused — extracted first, it would turn a later entry's write into a
/// write outside the extraction directory.
public enum BundleArchive {
    /// How big a bundle may unpack to (`MAX_BUNDLE_BYTES` in `format.ts`).
    public static let maxBundleBytes = 256 * 1024 * 1024
    public static let maxBundleEntries = 32768

    static let block = 512
    private static let nameField = 100
    private static let prefixField = 155

    private static let typeFile: UInt8 = 0x30 // '0'
    private static let typeFileOld: UInt8 = 0x00 // pre-POSIX writers leave NUL
    private static let typeDirectory: UInt8 = 0x35 // '5'
    private static let typePax: UInt8 = 0x78 // 'x'
    private static let typePaxGlobal: UInt8 = 0x67 // 'g'

    public static func read(
        _ archive: Data,
        maxBytes: Int = maxBundleBytes,
        maxEntries: Int = maxBundleEntries
    ) throws -> [TarEntry] {
        let tar = try inflated(archive, maxBytes: maxBytes, maxEntries: maxEntries)
        var entries: [TarEntry] = []
        var offset = 0
        var bytes = 0

        while offset + block <= tar.count {
            let header = tar[offset..<(offset + block)]
            if header.allSatisfy({ $0 == 0 }) { break }
            try verifyChecksum(header, at: offset)

            let size = try octal(header, at: 124, width: 12)
            let type = header[header.startIndex + 156]
            let name = entryName(header)
            offset += block

            let padded = (size + block - 1) / block * block
            if offset + padded > tar.count {
                throw BundleArchiveError.truncated(entry: name)
            }

            switch type {
            case typePax, typePaxGlobal:
                // Attributes we never write and do not read; tolerated so an
                // archive a stock tar produced still opens.
                offset += padded
                continue
            case typeFile, typeFileOld:
                bytes += size
                entries.append(
                    TarEntry(
                        name: name,
                        executable: try octal(header, at: 100, width: 8) & 0o111 != 0,
                        data: Data(tar[offset..<(offset + size)])
                    ))
            case typeDirectory:
                entries.append(TarEntry(name: strippedOfTrailingSlashes(name)))
            default:
                throw BundleArchiveError.unsupportedEntryType(
                    entry: name, type: Character(UnicodeScalar(type))
                )
            }

            offset += padded
            if entries.count > maxEntries {
                throw BundleArchiveError.tooManyEntries(limit: maxEntries)
            }
            if bytes > maxBytes {
                throw BundleArchiveError.tooManyBytes(limit: maxBytes)
            }
        }

        return entries
    }

    private static func inflated(
        _ archive: Data, maxBytes: Int, maxEntries: Int
    ) throws -> [UInt8] {
        guard Gzip.isGzip(archive) else { throw BundleArchiveError.notGzip }

        do {
            // The cap covers content plus headers and padding, so a bomb
            // fails in zlib before anything is allocated for it.
            let cap = maxBytes + block * 2 * (maxEntries + 2)
            return [UInt8](try Gzip.decompress(archive, maxBytes: cap))
        } catch {
            throw BundleArchiveError.decompressFailed
        }
    }

    /// An octal header field: cut at the first NUL, trimmed, base 8.
    ///
    /// Parsed as `Number.parseInt` does — leading octal digits, trailing
    /// garbage ignored — so both readers agree byte for byte on what a header
    /// means. Empty is 0; no digit at all, or a negative, is corruption.
    private static func octal(
        _ header: ArraySlice<UInt8>, at: Int, width: Int
    ) throws -> Int {
        let start = header.startIndex + at
        let field = header[start..<(start + width)]
        let cut = field[..<(field.firstIndex(of: 0) ?? field.endIndex)]
        let text = String(decoding: cut, as: UTF8.self)
            .trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return 0 }

        var characters = Substring(text)
        let negative = characters.first == "-"
        if negative { characters = characters.dropFirst() }

        var value = 0
        var digits = 0
        for character in characters {
            guard let digit = character.wholeNumberValue, (0...7).contains(digit) else { break }
            value = value * 8 + digit
            digits += 1
        }
        if digits == 0 || negative { throw BundleArchiveError.badOctalField }
        return value
    }

    /// The unsigned sum of all 512 bytes, with the checksum's own eight
    /// counted as spaces — how every tar writer computes it.
    private static func verifyChecksum(
        _ header: ArraySlice<UInt8>, at offset: Int
    ) throws {
        let recorded = try octal(header, at: 148, width: 8)
        var sum = 0
        for (index, byte) in header.enumerated() {
            sum += (148..<156).contains(index) ? 0x20 : Int(byte)
        }
        if sum != recorded {
            throw BundleArchiveError.checksumMismatch(atByte: offset)
        }
    }

    /// prefix + '/' + name when the prefix field is non-empty — how ustar
    /// carries a path longer than the 100-byte name field.
    private static func entryName(_ header: ArraySlice<UInt8>) -> String {
        let name = cString(header, at: 0, width: nameField)
        let prefix = cString(header, at: 345, width: prefixField)
        return prefix.isEmpty ? name : "\(prefix)/\(name)"
    }

    private static func cString(
        _ header: ArraySlice<UInt8>, at: Int, width: Int
    ) -> String {
        let start = header.startIndex + at
        let field = header[start..<(start + width)]
        let cut = field[..<(field.firstIndex(of: 0) ?? field.endIndex)]
        return String(decoding: cut, as: UTF8.self)
    }

    private static func strippedOfTrailingSlashes(_ name: String) -> String {
        var trimmed = Substring(name)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        return String(trimmed)
    }
}
