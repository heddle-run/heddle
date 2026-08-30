import Foundation

/// Opening a `.heddle` file: its manifest alone, or a full extraction.
///
/// The extraction half is `packages/core/src/bundle/unpack.ts`, ported with
/// its ordering intact: the manifest is read and validated *before* anything
/// touches the disk, so a bundle whose manifest is missing or malformed
/// writes nothing — a refusal leaves no half-extracted directory to clean up
/// or to trust by accident. Every entry's path is checked against the
/// extraction directory; the archive came from somebody else, which is the
/// point of a bundle, so a name that climbs is treated as an attack rather
/// than a defect.
public enum BundleReader {
    /// The manifest at the root of a `.heddle` archive, without extracting.
    ///
    /// The packer writes `heddle.json` first, but its position is layout, not
    /// contract — the whole entry list is scanned for it.
    public static func manifest(at url: URL) throws -> BundleManifest {
        let entries = try BundleArchive.read(try archiveData(at: url))
        return try manifestOf(entries, archivePath: url.path)
    }

    /// Extract the archive into `destDir` and hand back its manifest.
    ///
    /// Only the one bit that means anything travels: a tool is a tool because
    /// it is executable (0755). Everything else lands owner-writable and
    /// private (0644).
    @discardableResult
    public static func extract(archive url: URL, into destDir: URL) throws -> BundleManifest {
        let entries = try BundleArchive.read(try archiveData(at: url))
        let manifest = try manifestOf(entries, archivePath: url.path)

        let files = FileManager.default
        for entry in entries {
            let target = destDir.appendingPathComponent(try safeName(entry.name))

            guard let data = entry.data else {
                try files.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }

            try files.createDirectory(
                at: target.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: target)
            try files.setAttributes(
                [.posixPermissions: entry.executable ? 0o755 : 0o644],
                ofItemAtPath: target.path
            )
        }

        try assertComplete(manifest, destDir: destDir, archivePath: url.path)
        return manifest
    }

    private static func archiveData(at url: URL) throws -> Data {
        do {
            return try Data(contentsOf: url)
        } catch {
            throw BundleError("cannot read bundle \"\(url.path)\"")
        }
    }

    private static func manifestOf(
        _ entries: [TarEntry], archivePath: String
    ) throws -> BundleManifest {
        guard
            let entry = entries.first(where: { $0.name == BundleManifest.manifestName }),
            let data = entry.data
        else {
            throw BundleError(
                "\"\(archivePath)\" has no \(BundleManifest.manifestName) at its root, "
                    + "so it is a tar archive but not a heddle bundle. One is written "
                    + "by \"heddle bundle\"."
            )
        }
        return try BundleManifest.decode(data)
    }

    /// An entry name that may be joined to the extraction directory.
    ///
    /// The same shape `BundleManifest.archivePath` enforces on manifest
    /// fields, applied to what the archive itself says. Both exist because
    /// they guard different inputs: a manifest can name a clean path in an
    /// archive full of dirty ones.
    private static func safeName(_ name: String) throws -> String {
        if name.isEmpty {
            throw BundleError("bundle has an entry with an empty name")
        }
        if name.hasPrefix("/") || name.contains("\\") {
            throw BundleError(
                "bundle entry \"\(name)\" is not a relative '/' path, so it would "
                    + "land outside the extraction directory."
            )
        }
        let segments = name.split(separator: "/", omittingEmptySubsequences: false)
        if segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw BundleError(
                "bundle entry \"\(name)\" steps outside the extraction directory."
            )
        }
        return name
    }

    /// Everything the manifest names must have been in the archive.
    ///
    /// Checked after extraction rather than trusted, because the manifest and
    /// the entries are written by the same author but read by different code:
    /// a promised flow the archive does not carry would otherwise surface
    /// later as a file-not-found blaming a temp path nobody typed.
    private static func assertComplete(
        _ manifest: BundleManifest, destDir: URL, archivePath: String
    ) throws {
        var named = [manifest.flow]
        if let tools = manifest.tools { named.append(tools) }
        named.append(contentsOf: manifest.plugins)
        named.append(contentsOf: manifest.mounts.map(\.path))

        let missing = named.filter { path in
            !FileManager.default.fileExists(
                atPath: destDir.appendingPathComponent(path).path
            )
        }

        if !missing.isEmpty {
            let listed = missing.map { "\"\($0)\"" }.joined(separator: ", ")
            throw BundleError(
                "\"\(archivePath)\" names \(listed) in its "
                    + "\(BundleManifest.manifestName) but does not carry "
                    + "\(missing.count == 1 ? "it" : "them"). The bundle is "
                    + "incomplete — rebuild it with \"heddle bundle\"."
            )
        }
    }
}
