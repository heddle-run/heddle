import Foundation

/// A bundle refusal above the tar layer: a manifest that cannot be believed,
/// an archive that breaks its own promises. One message-carrying type, the
/// shape TS core's `BundleError` has — the message is the contract.
public struct BundleError: Error, LocalizedError, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// What a `.heddle` file is: a gzipped tar with a `heddle.json` at its root.
///
/// The full Swift mirror of `packages/core/src/bundle/format.ts` — the
/// manifest names everything else in the archive by path, so opening a bundle
/// is reading one file. Validation is the TS validator's, rule for rule: the
/// manifest is the one part of a bundle that is followed rather than merely
/// copied, so a path that climbs is an escape, not a typo.
public struct BundleManifest: Equatable {
    public static let manifestName = "heddle.json"
    public static let formatVersion = 1

    /// Where a mounted tree lives in the archive, and where it lands.
    public struct Mount: Equatable {
        public enum Mode: String, Equatable {
            case ro
            case rw
        }

        /// Path inside the archive.
        public var path: String
        /// Where it lands in every workspace, relative to the workspace root.
        public var dest: String
        public var mode: Mode

        public init(path: String, dest: String, mode: Mode = .ro) {
            self.path = path
            self.dest = dest
            self.mode = mode
        }
    }

    public var format: Int
    /// The flow's name, for display — the flow file is the authority.
    public var name: String
    /// Archive path of the flow spec (JSON or YAML).
    public var flow: String
    /// Archive path of the tools directory, when the bundle ships tools.
    public var tools: String?
    /// Archive paths of plugin manifests, each inside its plugin's directory.
    public var plugins: [String]
    /// Component settings, resolved at pack time — `@file` never travels.
    public var pluginConfig: [String: [String: JSONValue]]
    public var mounts: [Mount]
    /// Default `--input`, overridable at run time.
    public var input: [String: JSONValue]?
    /// The bundle would rather open a conversation than run once. A proposal,
    /// like `input` — the runner decides.
    public var interactive: Bool?
    /// Keep every run of this bundle in a conversation on disk. A proposal too.
    public var session: Bool?
    /// A default `--max-tool-rounds`: a whole number, or a word like
    /// "unlimited". Stored as written; the run-time parser reads both.
    public var maxToolRounds: JSONValue?
    /// What the machine running this has to already have. Kept as the loose
    /// JSON it arrived in — `Requirement.init(json:)` reads each entry, and an
    /// entry this app does not recognize is the CLI's to judge, not ours to
    /// drop.
    public var requires: [JSONValue]?

    /// Read and validate a `heddle.json`'s bytes.
    public static func decode(_ data: Data) throws -> BundleManifest {
        let raw: JSONValue
        do {
            raw = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw BundleError("\(manifestName) is not JSON")
        }
        return try validate(raw)
    }

    /// The TS `validateBundleManifest`, field for field.
    public static func validate(_ raw: JSONValue) throws -> BundleManifest {
        guard let manifest = raw.objectValue else {
            throw BundleError("\(manifestName) must be a JSON object")
        }

        guard case .number(let formatNumber)? = manifest["format"],
            formatNumber == formatNumber.rounded(), formatNumber >= 1
        else {
            throw BundleError("\(manifestName) has no usable \"format\" number")
        }
        let format = Int(formatNumber)
        if format > formatVersion {
            throw BundleError(
                "this bundle is format \(format) and this app reads up to "
                    + "\(formatVersion). It was made by a heddle newer than this app "
                    + "understands — upgrade to run it."
            )
        }

        guard let name = manifest["name"]?.stringValue, !name.isEmpty else {
            throw BundleError("\(manifestName) is missing a \"name\"")
        }

        return BundleManifest(
            format: format,
            name: name,
            flow: try archivePath(manifest["flow"], field: "flow"),
            tools: manifest["tools"] == nil
                ? nil
                : try archivePath(manifest["tools"], field: "tools"),
            plugins: try pluginPaths(manifest["plugins"]),
            pluginConfig: try pluginConfig(manifest["pluginConfig"]),
            mounts: try mounts(manifest["mounts"]),
            input: try optionalObject(manifest["input"], field: "input"),
            interactive: manifest["interactive"] == .bool(true) ? true : nil,
            session: manifest["session"] == .bool(true) ? true : nil,
            maxToolRounds: try maxToolRounds(manifest["maxToolRounds"]),
            requires: requires(manifest["requires"])
        )
    }

    /// A path the manifest may use to name something in the archive:
    /// relative, '/'-separated, and stepping nowhere.
    static func archivePath(_ value: JSONValue?, field: String) throws -> String {
        guard let path = value?.stringValue, !path.isEmpty else {
            throw BundleError("\(manifestName) \"\(field)\" must be a non-empty path")
        }
        if path.hasPrefix("/") || path.contains("\\") {
            throw BundleError(
                "\(manifestName) \"\(field)\" (\"\(path)\") must be a relative '/' path"
            )
        }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        if segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw BundleError(
                "\(manifestName) \"\(field)\" (\"\(path)\") steps outside the bundle. "
                    + "A manifest path is followed after extraction, so one that climbs "
                    + "is an escape rather than a typo."
            )
        }
        return path
    }

    private static func pluginPaths(_ value: JSONValue?) throws -> [String] {
        guard let value else { return [] }
        guard case .array(let entries) = value else {
            throw BundleError("\(manifestName) \"plugins\" must be an array of paths")
        }
        return try entries.enumerated().map { index, entry in
            try archivePath(entry, field: "plugins[\(index)]")
        }
    }

    private static func pluginConfig(
        _ value: JSONValue?
    ) throws -> [String: [String: JSONValue]] {
        guard let value else { return [:] }
        guard let config = value.objectValue else {
            throw BundleError("\(manifestName) \"pluginConfig\" must be an object")
        }

        var read: [String: [String: JSONValue]] = [:]
        for (componentType, settings) in config {
            guard let settings = settings.objectValue else {
                throw BundleError(
                    "\(manifestName) pluginConfig[\"\(componentType)\"] must be an "
                        + "object of settings"
                )
            }
            read[componentType] = settings
        }
        return read
    }

    private static func mounts(_ value: JSONValue?) throws -> [Mount] {
        guard let value else { return [] }
        guard case .array(let entries) = value else {
            throw BundleError("\(manifestName) \"mounts\" must be an array")
        }

        return try entries.enumerated().map { index, entry in
            guard let mount = entry.objectValue else {
                throw BundleError("\(manifestName) mounts[\(index)] must be an object")
            }
            let mode: Mount.Mode
            switch mount["mode"] {
            case nil:
                mode = .ro
            case .string(let name):
                guard let known = Mount.Mode(rawValue: name) else {
                    throw BundleError(
                        "\(manifestName) mounts[\(index)] has mode \"\(name)\"; "
                            + "expected ro or rw"
                    )
                }
                mode = known
            case .some(let other):
                throw BundleError(
                    "\(manifestName) mounts[\(index)] has mode "
                        + "\"\(other.displayText)\"; expected ro or rw"
                )
            }
            guard let dest = mount["dest"]?.stringValue, !dest.isEmpty else {
                throw BundleError("\(manifestName) mounts[\(index)] is missing a \"dest\"")
            }
            return Mount(
                path: try archivePath(mount["path"], field: "mounts[\(index)].path"),
                // Not checked beyond presence: where a mount may land is the
                // opener's rule, applied before anything is copied.
                dest: dest,
                mode: mode
            )
        }
    }

    private static func optionalObject(
        _ value: JSONValue?, field: String
    ) throws -> [String: JSONValue]? {
        guard let value else { return nil }
        guard let object = value.objectValue else {
            throw BundleError("\(manifestName) \"\(field)\" must be a JSON object")
        }
        return object
    }

    /// A recorded `maxToolRounds`: a whole number of 1 or more, or a word.
    /// Only the shape is checked; the word is the run-time parser's to read.
    private static func maxToolRounds(_ value: JSONValue?) throws -> JSONValue? {
        switch value {
        case nil:
            return nil
        case .number(let number):
            guard number == number.rounded(), number >= 1 else {
                throw BundleError(
                    "\(manifestName) \"maxToolRounds\" must be a whole number of 1 or more"
                )
            }
            return value
        case .string(let word) where !word.trimmingCharacters(in: .whitespaces).isEmpty:
            return value
        default:
            throw BundleError(
                "\(manifestName) \"maxToolRounds\" must be a number or a word "
                    + "like \"unlimited\""
            )
        }
    }

    /// The `requires` list, kept loose. The list form passes through; the
    /// older `{ env: [...], binaries: [...] }` object is normalized into it,
    /// as TS `parseRequirements` does. An unreadable declaration is kept
    /// rather than refused — this app shows what it can and the CLI judges
    /// the rest at run time.
    private static func requires(_ value: JSONValue?) -> [JSONValue]? {
        switch value {
        case nil, .null:
            return nil
        case .array(let entries):
            return entries.isEmpty ? nil : entries
        case .object(let legacy):
            var entries: [JSONValue] = []
            if case .array(let binaries)? = legacy["binaries"] {
                entries.append(
                    contentsOf: binaries.compactMap { name in
                        name.stringValue.map { .object(["binary": .array([.string($0)])]) }
                    })
            }
            if case .array(let names)? = legacy["env"] {
                entries.append(
                    contentsOf: names.compactMap { name in
                        name.stringValue.map { .object(["env": .string($0)]) }
                    })
            }
            return entries.isEmpty ? nil : entries
        default:
            return nil
        }
    }
}
