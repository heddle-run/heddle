import Foundation

/// Whether a bundle can run inside an embedded JavaScript engine, and if not,
/// every reason why.
///
/// A mirror of core's `checkPortability` — the TS side is the definition of
/// record, and this stays behind it on purpose: a false "not portable" here
/// only costs an unnecessary server fallback, never a wrong run. That
/// asymmetry shapes every rule below toward refusing on doubt.
public struct PortabilityReport: Equatable {
    /// Why the bundle needs a real host. Empty means it runs anywhere.
    public enum Reason: Equatable, Codable {
        /// The bundle ships executable tools, and an embedded engine spawns
        /// nothing.
        case hasTools
        /// The bundle ships mounted files. Conservative for v1: mounts mean a
        /// workspace on a disk.
        case hasMounts
        /// A plugin declares a `command` — it launches its own process.
        case pluginCommand(plugin: String)
        /// A plugin's entry point is not a `.js`/`.mjs` file the engine could
        /// evaluate.
        case pluginEntryNotJS(plugin: String)
        /// A plugin's entry imports other modules and no link judge was
        /// available to ask whether the engine's linker can serve them — the
        /// conservative verdict for a host checking without an engine.
        case pluginMultiFile(plugin: String)
        /// A plugin's entry imports modules the engine's linker refuses —
        /// something outside the plugin, a cycle, a shape it cannot read.
        /// `problem` is the linker's own sentence.
        case pluginUnlinkable(plugin: String, problem: String)
        /// A `requires` entry of a kind only a real machine satisfies
        /// (binary / node / file; `env` is fine — every host can hold a key).
        case unsupportedRequirement(kind: String, name: String)
        /// A plugin asks for a capability the embedded host does not serve.
        case unsupportedCapability(plugin: String, capability: String)

        /// The reason as a person reads it, for the import sheet.
        public var label: String {
            switch self {
            case .hasTools:
                return "ships executable tools"
            case .hasMounts:
                return "ships mounted files"
            case .pluginCommand(let plugin):
                return "plugin \"\(plugin)\" launches its own process"
            case .pluginEntryNotJS(let plugin):
                return "plugin \"\(plugin)\" is not JavaScript"
            case .pluginMultiFile(let plugin):
                return "plugin \"\(plugin)\" is more than one JavaScript file"
            case .pluginUnlinkable(let plugin, let problem):
                return "plugin \"\(plugin)\": \(problem)"
            case .unsupportedRequirement(let kind, let name):
                return "needs \(kind == "env" ? "" : "a \(kind) on the machine: ")\(name)"
            case .unsupportedCapability(let plugin, let capability):
                return "plugin \"\(plugin)\" asks for \"\(capability)\""
            }
        }
    }

    public var reasons: [Reason]

    public var portable: Bool { reasons.isEmpty }

    public init(reasons: [Reason]) {
        self.reasons = reasons
    }
}

public enum BundlePortability {
    /// What the embedded host serves a plugin. The manifest vocabulary
    /// (`packages/core/src/plugin/protocol.ts` `PLUGIN_METHODS`) is exactly
    /// this set today; the check exists so a capability added there tomorrow
    /// falls back to the server rather than running unserved.
    private static let servedCapabilities: Set<String> = [
        "runTool", "emitEvent", "log", "callModel",
    ]

    private static let scriptExtensions = ["mjs", "js"]

    /// Asks the engine's linker whether an entry that imports sibling
    /// modules would evaluate: the entry's source and every shipped module
    /// (keyed by plugin-dir-relative path) go in, the linker's problems come
    /// back — empty meaning it links. `HeddleEngine.linkCheck` is this
    /// closure's intended body; keeping it a closure keeps this check usable
    /// where no JavaScript engine exists.
    public typealias LinkCheck = (
        _ entrySource: String, _ files: [String: String]
    ) throws -> [String]

    /// Judge an extracted bundle. `extractedAt` is what `BundleReader.extract`
    /// produced — the plugin manifests and entry sources are read from disk,
    /// because the judgment is about what actually shipped, not what the
    /// bundle manifest promises. Without a `linkCheck`, an entry that
    /// imports sibling modules is refused outright; with one, the engine's
    /// own linker settles it — the same judgment core's `checkPortability`
    /// reaches, because it is the same linker.
    public static func check(
        manifest: BundleManifest, extractedAt dir: URL,
        linkCheck: LinkCheck? = nil
    ) throws -> PortabilityReport {
        var reasons: [PortabilityReport.Reason] = []

        if let tools = manifest.tools,
            containsRegularFile(dir.appendingPathComponent(tools)) {
            reasons.append(.hasTools)
        }

        if !manifest.mounts.isEmpty {
            reasons.append(.hasMounts)
        }

        for path in manifest.plugins {
            reasons.append(
                contentsOf: try pluginReasons(
                    manifestPath: dir.appendingPathComponent(path),
                    linkCheck: linkCheck
                ))
        }

        for entry in manifest.requires ?? [] {
            guard let requirement = Requirement(json: entry) else { continue }
            switch requirement {
            case .env:
                break
            case .binary(let names, _):
                reasons.append(
                    .unsupportedRequirement(
                        kind: "binary", name: names.joined(separator: " or ")))
            case .file(let path, _):
                reasons.append(.unsupportedRequirement(kind: "file", name: path))
            case .node(let range, _):
                reasons.append(.unsupportedRequirement(kind: "node", name: range))
            }
        }

        return PortabilityReport(reasons: reasons)
    }

    /// One plugin, judged from its shipped manifest and entry source.
    private static func pluginReasons(
        manifestPath: URL,
        linkCheck: LinkCheck?
    ) throws -> [PortabilityReport.Reason] {
        let raw: JSONValue
        do {
            raw = try JSONDecoder().decode(
                JSONValue.self, from: try Data(contentsOf: manifestPath))
        } catch {
            throw BundleError(
                "plugin manifest \"\(manifestPath.lastPathComponent)\" in the "
                    + "extracted bundle is not readable JSON"
            )
        }
        guard let manifest = raw.objectValue else {
            throw BundleError(
                "plugin manifest \"\(manifestPath.lastPathComponent)\" in the "
                    + "extracted bundle is not a JSON object"
            )
        }

        let plugin = manifest["name"]?.stringValue ?? manifestPath.lastPathComponent
        var reasons: [PortabilityReport.Reason] = []

        if case .array(let capabilities)? = manifest["capabilities"] {
            for capability in capabilities.compactMap(\.stringValue)
            where !servedCapabilities.contains(capability) {
                reasons.append(
                    .unsupportedCapability(plugin: plugin, capability: capability))
            }
        }

        // A command means the plugin picks its own interpreter — a process,
        // which is the one thing an embedded engine will never start. Entry
        // analysis is moot past this point.
        if manifest["command"] != nil {
            reasons.append(.pluginCommand(plugin: plugin))
            return reasons
        }

        // Entry resolution mirrors `entryFor` in core's plugin/loader.ts:
        // no command, so the entry is the sibling <stem>.mjs or <stem>.js of
        // the manifest, whichever exists.
        let stem = manifestPath.deletingPathExtension()
        let entry = scriptExtensions
            .map { stem.appendingPathExtension($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }

        guard let entry else {
            // Nothing to evaluate. Fine for a plugin nothing ever asks to run
            // (path-tools only); a blocker for one that serves components or
            // discovery.
            if needsProcess(manifest) {
                reasons.append(.pluginEntryNotJS(plugin: plugin))
            }
            return reasons
        }

        let source = try entrySource(entry)
        if hasTopLevelModuleSyntax(source) {
            reasons.append(
                contentsOf: linkReasons(
                    plugin: plugin, entry: entry, source: source,
                    linkCheck: linkCheck
                ))
        }

        return reasons
    }

    /// An entry that imports sibling modules, judged by the engine's linker
    /// when one was offered. Every failure to ask — no judge, unreadable
    /// files, a judge that throws — lands on `.pluginMultiFile`, the refusal
    /// this case always was: on doubt, the bundle goes to a real host.
    private static func linkReasons(
        plugin: String, entry: URL, source: String, linkCheck: LinkCheck?
    ) -> [PortabilityReport.Reason] {
        guard let linkCheck else {
            return [.pluginMultiFile(plugin: plugin)]
        }

        let problems: [String]
        do {
            problems = try linkCheck(source, siblingModules(of: entry))
        } catch {
            return [.pluginMultiFile(plugin: plugin)]
        }
        return problems.map {
            .pluginUnlinkable(plugin: plugin, problem: $0)
        }
    }

    /// Every JavaScript module the plugin ships, keyed by its path relative
    /// to the plugin's directory — what the linker may resolve imports
    /// against. A file that fails to read is left out, and an import of it
    /// then fails the link check, which is the safe direction.
    private static func siblingModules(of entry: URL) -> [String: String] {
        let dir = entry.deletingLastPathComponent()
        var files: [String: String] = [:]

        let enumerated = FileManager.default.enumerator(
            at: dir, includingPropertiesForKeys: [.isRegularFileKey]
        )
        while let item = enumerated?.nextObject() as? URL {
            guard scriptExtensions.contains(item.pathExtension.lowercased()),
                (try? item.resourceValues(forKeys: [.isRegularFileKey]))?
                    .isRegularFile == true
            else { continue }
            let relative = relativePath(of: item, under: dir)
            guard !relative.isEmpty,
                let source = try? String(contentsOf: item, encoding: .utf8)
            else { continue }
            files[relative] = source
        }
        return files
    }

    /// `item`'s path under `dir`, `/`-joined — the linker's path alphabet.
    private static func relativePath(of item: URL, under dir: URL) -> String {
        let base = dir.standardizedFileURL.pathComponents
        let full = item.standardizedFileURL.pathComponents
        guard full.count > base.count,
            Array(full.prefix(base.count)) == base
        else { return "" }
        return full.dropFirst(base.count).joined(separator: "/")
    }

    /// Whether anything could ever ask this plugin to run — `needsProcess`
    /// in core's loader.ts. Components and discovery are dispatched over the
    /// wire; a tool with a `path` is a program run directly, so a tool
    /// without one names a component.
    private static func needsProcess(_ manifest: [String: JSONValue]) -> Bool {
        if case .array(let components)? = manifest["components"], !components.isEmpty {
            return true
        }
        if manifest["discoverTools"] == .bool(true) { return true }
        if case .array(let tools)? = manifest["tools"] {
            return tools.contains { tool in
                tool.objectValue?["path"] == nil
            }
        }
        return false
    }

    private static func entrySource(_ entry: URL) throws -> String {
        guard let source = try? String(contentsOf: entry, encoding: .utf8) else {
            throw BundleError(
                "plugin entry \"\(entry.lastPathComponent)\" in the extracted "
                    + "bundle is not readable"
            )
        }
        return source
    }

    /// Top-level ESM syntax, found by shape rather than by parsing: a line
    /// opening with `import`, or an `export … from`. A false positive (the
    /// pattern inside a template literal, say) costs a server fallback, never
    /// a wrong run — the cheap check is on the safe side of that trade.
    static func hasTopLevelModuleSyntax(_ source: String) -> Bool {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .contains { line in
                let trimmed = line.drop { $0 == " " || $0 == "\t" }
                if let rest = trimmed.dropPrefix("import"),
                    rest.first.map(isIdentifierBreak) ?? true {
                    return true
                }
                if let rest = trimmed.dropPrefix("export"),
                    rest.first == " " || rest.first == "\t" {
                    return containsFromKeyword(rest)
                }
                return false
            }
    }

    /// `\bfrom\b` over the tail of an `export` line.
    private static func containsFromKeyword(_ text: Substring) -> Bool {
        var rest = text
        while let range = rest.range(of: "from") {
            let before = rest[..<range.lowerBound].last
            let after = range.upperBound < rest.endIndex ? rest[range.upperBound] : nil
            if before.map(isIdentifierBreak) ?? true, after.map(isIdentifierBreak) ?? true {
                return true
            }
            rest = rest[range.upperBound...]
        }
        return false
    }

    private static func isIdentifierBreak(_ character: Character) -> Bool {
        !(character.isLetter || character.isNumber || character == "_" || character == "$")
    }

    /// At least one regular file anywhere under `directory` — an empty tools
    /// directory ships nothing an engine would miss.
    private static func containsRegularFile(_ directory: URL) -> Bool {
        let files = FileManager.default
        var isDirectory: ObjCBool = false
        guard files.fileExists(atPath: directory.path, isDirectory: &isDirectory) else {
            return false
        }
        if !isDirectory.boolValue { return true }

        let enumerated = files.enumerator(
            at: directory, includingPropertiesForKeys: [.isRegularFileKey]
        )
        while let item = enumerated?.nextObject() as? URL {
            if (try? item.resourceValues(forKeys: [.isRegularFileKey]))?
                .isRegularFile == true {
                return true
            }
        }
        return false
    }
}

extension Substring {
    fileprivate func dropPrefix(_ prefix: String) -> Substring? {
        hasPrefix(prefix) ? dropFirst(prefix.count) : nil
    }
}
