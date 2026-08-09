import Foundation

/// Where the heddle runtime is, and how to invoke it.
///
/// The app runs agents by spawning the CLI — `heddle run <agent> --protocol
/// heddle` — and reading its one-JSON-frame-per-line stdout. The CLI is the
/// one front end that already opens `.heddle` bundles (tools, plugins,
/// mounts, recorded input, sessions); the HTTP server takes only inline flows
/// today, so wrapping the CLI is what "no agent logic in Swift" costs.
struct HeddleCLI {
    /// argv prefix: either `[heddle]` or `[node, …/heddle.js]`.
    let invocation: [String]

    enum LocateError: LocalizedError {
        case notFound

        var errorDescription: String? {
            "heddle was not found. Install it (brew install heddle) or set "
                + "HEDDLE_APP_CLI to a heddle.js and HEDDLE_APP_NODE to a node binary."
        }
    }

    /// The runtime, in order of intent:
    ///
    /// 1. `HEDDLE_APP_CLI` (+ `HEDDLE_APP_NODE`) — development against a
    ///    checkout's `packages/cli/dist/heddle.js`.
    /// 2. The copy inside the app bundle — what make-app.sh packs, and the
    ///    only path a user who downloaded Heddle.app exercises.
    /// 3. A `heddle` on PATH — the Homebrew install, when running unbundled.
    static func locate(environment: [String: String] = ProcessInfo.processInfo.environment)
        -> HeddleCLI?
    {
        if let cli = environment["HEDDLE_APP_CLI"] {
            guard let node = node(environment: environment) else { return nil }
            return HeddleCLI(invocation: [node, cli])
        }

        // The layout make-app.sh packs: a `pnpm deploy`d CLI beside a node.
        if let runtime = Bundle.main.resourceURL?
            .appendingPathComponent("heddle-runtime", isDirectory: true)
        {
            let cli = runtime.appendingPathComponent("cli/dist/heddle.js")
            if FileManager.default.fileExists(atPath: cli.path),
               let node = node(environment: environment)
            {
                return HeddleCLI(invocation: [node, cli.path])
            }
        }

        if let found = pathLookup("heddle", environment: environment) {
            return HeddleCLI(invocation: [found])
        }

        return nil
    }

    private static func node(environment: [String: String]) -> String? {
        if let explicit = environment["HEDDLE_APP_NODE"] { return explicit }
        if let packed = Bundle.main.resourceURL?
            .appendingPathComponent("heddle-runtime/node"),
            FileManager.default.isExecutableFile(atPath: packed.path)
        {
            return packed.path
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return pathLookup("node", environment: environment)
    }

    /// A plain PATH walk, because the app may not have a login shell's PATH.
    private static func pathLookup(_ name: String, environment: [String: String]) -> String? {
        let path = environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
        for directory in path.split(separator: ":") {
            let candidate = String(directory) + "/" + name
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}
