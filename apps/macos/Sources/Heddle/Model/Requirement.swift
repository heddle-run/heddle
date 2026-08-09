import Foundation

/// A bundle's `requires` entry, mirroring `Requirement` in
/// `packages/core/src/preflight.ts`: binary / env / file / node, plus a hint.
///
/// The same contract too: checking is pure observation. Nothing here writes,
/// downloads, or spawns — the CLI's preflight remains the authority at run
/// time; this exists so the app can ask for what is missing *before* the run,
/// which for a GUI mostly means API keys.
enum Requirement: Equatable {
    case binary(names: [String], hint: String?)
    case env(name: String, hint: String?)
    case file(path: String, hint: String?)
    case node(range: String, hint: String?)

    /// Decoded from the loose JSON the manifest carries. An entry this app
    /// does not recognize decodes to nil rather than failing the bundle —
    /// the CLI will still judge it; the panel just cannot ask about it.
    init?(json: JSONValue) {
        guard let object = json.objectValue else { return nil }
        let hint = object["hint"]?.stringValue

        if let env = object["env"]?.stringValue {
            self = .env(name: env, hint: hint)
        } else if let file = object["file"]?.stringValue {
            self = .file(path: file, hint: hint)
        } else if let node = object["node"]?.stringValue {
            self = .node(range: node, hint: hint)
        } else if case .array(let entries)? = object["binary"] {
            let names = entries.compactMap(\.stringValue)
            guard !names.isEmpty else { return nil }
            self = .binary(names: names, hint: hint)
        } else if let name = object["binary"]?.stringValue {
            self = .binary(names: [name], hint: hint)
        } else {
            return nil
        }
    }

    var hint: String? {
        switch self {
        case .binary(_, let hint), .env(_, let hint),
             .file(_, let hint), .node(_, let hint):
            return hint
        }
    }

    var label: String {
        switch self {
        case .binary(let names, _): return names.joined(separator: " or ")
        case .env(let name, _): return name
        case .file(let path, _): return path
        case .node(let range, _): return "node \(range)"
        }
    }
}

/// One requirement, observed on this machine.
struct CheckedRequirement: Identifiable {
    let requirement: Requirement
    let holds: Bool
    /// Why it does not hold, or where it was found. Never a secret's value.
    let detail: String?

    var id: String { requirement.label }
}

enum Preflight {
    /// Observe every declared requirement.
    ///
    /// `env` holds when the Keychain has the key (the app injects it at
    /// spawn) or the app's own environment carries it. `node` always holds:
    /// the app ships its runtime, and the CLI re-checks with the one that
    /// actually runs.
    @MainActor
    static func check(
        _ requirements: [Requirement],
        keychain: KeychainStore = .shared
    ) -> [CheckedRequirement] {
        requirements.map { requirement in
            switch requirement {
            case .env(let name, _):
                if keychain.has(name) {
                    return CheckedRequirement(
                        requirement: requirement, holds: true, detail: "in your Keychain"
                    )
                }
                if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty {
                    return CheckedRequirement(
                        requirement: requirement, holds: true, detail: "in the environment"
                    )
                }
                return CheckedRequirement(requirement: requirement, holds: false, detail: nil)

            case .binary(let names, _):
                if let found = names.compactMap(locate(_:)).first {
                    return CheckedRequirement(
                        requirement: requirement, holds: true, detail: found
                    )
                }
                return CheckedRequirement(
                    requirement: requirement, holds: false, detail: "not on PATH"
                )

            case .file(let path, _):
                let expanded = NSString(string: path).expandingTildeInPath
                let holds = FileManager.default.fileExists(atPath: expanded)
                return CheckedRequirement(
                    requirement: requirement, holds: holds,
                    detail: holds ? nil : "no such path"
                )

            case .node:
                return CheckedRequirement(
                    requirement: requirement, holds: true, detail: "bundled with the app"
                )
            }
        }
    }

    private static func locate(_ name: String) -> String? {
        if name.hasPrefix("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? name : nil
        }
        let path = ProcessInfo.processInfo.environment["PATH"]
            ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
        for directory in path.split(separator: ":") {
            let candidate = "\(directory)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}
