import Foundation
import HeddleCore

/// The imported bundles' home: `Application Support/Bundles/<id>/`, one
/// folder per bundle agent, holding the archive verbatim (`bundle.heddle`,
/// kept byte-for-byte for a later server upload) beside its `extracted/`
/// tree — what the embedded engine actually runs from.
struct BundleStore {
    /// Defaults to Application Support; tests point it at a temp directory.
    var baseDirectory: URL
    /// The engine's `inspect`, injectable: tests answer without JavaScript,
    /// and the import path survives an artifact that refuses to parse.
    var inspect: (String, HeddleEngine.FlowFormat) throws -> HeddleEngine.FlowInfo
    /// The engine's `linkCheck`, injectable the same way. Judges plugin
    /// entries that import sibling modules; `BundlePortability.check` treats
    /// a throw here as "cannot ask" and refuses conservatively.
    var linkCheck: BundlePortability.LinkCheck

    init(
        baseDirectory: URL? = nil,
        inspect: @escaping (String, HeddleEngine.FlowFormat) throws
            -> HeddleEngine.FlowInfo = { text, format in
                try LocalEngine.shared.inspect(flowText: text, format: format)
            },
        linkCheck: @escaping BundlePortability.LinkCheck = { entrySource, files in
            try LocalEngine.shared.linkCheck(entrySource: entrySource, files: files)
        }
    ) {
        self.baseDirectory =
            baseDirectory
            ?? FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            )[0].appendingPathComponent("Bundles")
        self.inspect = inspect
        self.linkCheck = linkCheck
    }

    func directory(forBundleID id: String) -> URL {
        baseDirectory.appendingPathComponent(id)
    }

    /// The verbatim archive, kept for the server fallback's upload.
    func archiveURL(forBundleID id: String) -> URL {
        directory(forBundleID: id).appendingPathComponent("bundle.heddle")
    }

    /// What the engine runs from, and what portability was judged on.
    func extractedDir(forBundleID id: String) -> URL {
        directory(forBundleID: id).appendingPathComponent("extracted")
    }

    /// Copy the archive in, extract it, judge it, and read its input form.
    ///
    /// The returned agent is not yet in any `AgentStore` — the import sheet
    /// shows it first and either adds it or hands it back to `remove`. A
    /// failure anywhere cleans up the half-made directory before rethrowing.
    func importBundle(from url: URL) throws -> Agent {
        let id = UUID().uuidString
        let directory = directory(forBundleID: id)

        // The URL usually arrives security-scoped (file importer, "open
        // with"); from our own test bundle the call answers false and the
        // read works anyway.
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }

        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true
            )
            let archive = archiveURL(forBundleID: id)
            do {
                try Data(contentsOf: url).write(to: archive)
            } catch {
                throw BundleError("cannot read \"\(url.lastPathComponent)\"")
            }

            let extracted = extractedDir(forBundleID: id)
            let manifest = try BundleReader.extract(archive: archive, into: extracted)
            let report = try BundlePortability.check(
                manifest: manifest, extractedAt: extracted, linkCheck: linkCheck
            )
            let fields = inputFields(manifest: manifest, extractedDir: extracted)

            var agent = Agent(name: manifest.name, source: .bundle(id: id))
            agent.portability = report
            agent.inputFields = fields
            agent.manifestSummary = BundleSummary(
                name: manifest.name,
                requires: manifest.requires,
                interactive: manifest.interactive,
                session: manifest.session
            )
            // Chat sends its messages under the flow's first input.
            if let first = fields.first {
                agent.inputKey = first.key
            }
            return agent
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /// Delete a bundle agent's directory — archive and extraction both.
    func remove(agent: Agent) throws {
        guard let id = agent.bundleID else { return }
        try FileManager.default.removeItem(at: directory(forBundleID: id))
    }

    /// The flow's declared inputs, asked of the engine; the manifest's
    /// default `input` object is the fallback shape when `inspect` refuses
    /// (an artifact behind the flow's spec version, or the stub build), and
    /// supplies the default values either way.
    private func inputFields(
        manifest: BundleManifest, extractedDir: URL
    ) -> [BundleInputField] {
        let defaults = manifest.input ?? [:]

        let flowURL = extractedDir.appendingPathComponent(manifest.flow)
        if let text = try? String(contentsOf: flowURL, encoding: .utf8),
           let info = try? inspect(text, LocalRunAssembly.format(of: manifest.flow))
        {
            return info.inputs.map { field in
                BundleInputField(
                    key: field.key,
                    type: field.type,
                    title: field.title,
                    required: field.required,
                    defaultValue: defaults[field.key]
                )
            }
        }

        return defaults.keys.sorted().map { key in
            BundleInputField(key: key, type: "string", defaultValue: defaults[key])
        }
    }
}
