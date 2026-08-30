import Foundation
import HeddleCore

// `Requirement` itself — the reading half, shared with iOS — lives in
// HeddleCore. What follows is the macOS half of the contract: observing this
// machine, which means this Mac's PATH, filesystem, and Keychain.

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
    /// The same contract as `preflight.ts`: pure observation, nothing
    /// written, downloaded, or spawned — the CLI's preflight remains the
    /// authority at run time; this exists so the app can ask for what is
    /// missing *before* the run, which for a GUI mostly means API keys.
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
