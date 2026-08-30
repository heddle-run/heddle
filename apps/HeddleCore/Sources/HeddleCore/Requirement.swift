import Foundation

/// A bundle's `requires` entry, mirroring `Requirement` in
/// `packages/core/src/preflight.ts`: binary / env / file / node, plus a hint.
///
/// The same contract too: a requirement is a declaration, checked by pure
/// observation and never acted on. This type is the reading half — shared by
/// both apps, since what a manifest says is the same on every platform. What
/// "checked" means is each host's own: the macOS app walks PATH and asks its
/// Keychain; iOS asks its key store. Neither belongs here.
public enum Requirement: Equatable {
    case binary(names: [String], hint: String?)
    case env(name: String, hint: String?)
    case file(path: String, hint: String?)
    case node(range: String, hint: String?)

    /// Decoded from the loose JSON the manifest carries. An entry this app
    /// does not recognize decodes to nil rather than failing the bundle —
    /// the CLI will still judge it; the app just cannot ask about it.
    public init?(json: JSONValue) {
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

    public var hint: String? {
        switch self {
        case .binary(_, let hint), .env(_, let hint),
             .file(_, let hint), .node(_, let hint):
            return hint
        }
    }

    public var label: String {
        switch self {
        case .binary(let names, _): return names.joined(separator: " or ")
        case .env(let name, _): return name
        case .file(let path, _): return path
        case .node(let range, _): return "node \(range)"
        }
    }
}
