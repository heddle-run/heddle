import Foundation
import Security

/// API keys, in the Keychain and nowhere else.
///
/// One generic-password item per environment variable name, shared across
/// agents — two bundles requiring `ANTHROPIC_API_KEY` read the same item.
/// Values go into a spawned run's environment and are never written to disk
/// or shown back; the store can say *whether* a name is held without ever
/// handing the UI the value.
@MainActor
final class KeychainStore {
    static let shared = KeychainStore()

    private let service: String

    /// A distinct service under tests, so they never touch real keys.
    init(service: String = "run.heddle.app") {
        self.service = service
    }

    func has(_ name: String) -> Bool {
        var query = baseQuery(name)
        query[kSecReturnData as String] = false
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    func set(_ name: String, value: String) throws {
        let data = Data(value.utf8)
        var update = baseQuery(name)

        if has(name) {
            let status = SecItemUpdate(
                update as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            try check(status, "updating \(name)")
        } else {
            update[kSecValueData as String] = data
            let status = SecItemAdd(update as CFDictionary, nil)
            try check(status, "saving \(name)")
        }
    }

    func delete(_ name: String) {
        SecItemDelete(baseQuery(name) as CFDictionary)
    }

    /// Every held name — for injection, and for a settings list.
    func names() -> [String] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]]
        else { return [] }
        query.removeAll()
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }

    /// The held keys as an environment fragment, read at spawn time only.
    func environment() -> [String: String] {
        var env: [String: String] = [:]
        for name in names() {
            var query = baseQuery(name)
            query[kSecReturnData as String] = true
            var result: AnyObject?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data,
                  let value = String(data: data, encoding: .utf8)
            else { continue }
            env[name] = value
        }
        return env
    }

    private func baseQuery(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
        ]
    }

    private func check(_ status: OSStatus, _ doing: String) throws {
        guard status == errSecSuccess else {
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "\(doing): \(message)"]
            )
        }
    }
}
