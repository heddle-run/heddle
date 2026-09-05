import Foundation
import Security

/// Where named secrets live. The Keychain in the app; a dictionary in tests,
/// where the simulator's Keychain is not worth depending on.
protocol SecretStore {
    func read(account: String) -> String?
    func write(_ value: String, account: String)
    func delete(account: String)
    /// Bring already-stored items up to the current accessibility class.
    /// Only the Keychain has one; the default is the no-op every other
    /// store wants.
    func migrateAccessibility()
}

extension SecretStore {
    func migrateAccessibility() {}
}

/// Generic-password items under one service — the same calls as
/// `Support/Keychain.swift`, parameterized by service because the env values
/// are a different family of secrets than the server token.
struct KeychainSecretStore: SecretStore {
    /// The service the bundles' env values live under. Read directly by
    /// `LocalEngine.resolveEnv` on the engine's queue — the Keychain is
    /// thread-safe where an `@Observable` store is not.
    static let envService = "run.heddle.env"

    /// `AfterFirstUnlock`, not the `WhenUnlocked` default: a run started by
    /// a Shortcuts automation reads these with the screen locked and nobody
    /// watching, and the default would fail that read — an agent dying at
    /// env resolution because the phone was in a pocket. The weaker class
    /// still requires the device to have been unlocked once since boot, and
    /// the item never leaves this device.
    private static let accessibility = kSecAttrAccessibleAfterFirstUnlock

    let service: String

    func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ value: String, account: String) {
        guard !value.isEmpty else {
            delete(account: account)
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // The accessibility rides on the update too, not just the add: an
        // item written before this class was pinned is migrated the next
        // time its value is saved, without a separate pass.
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: Self.accessibility,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
    }

    /// Re-file every item under this service at the current accessibility
    /// class. Items written by an older build are `WhenUnlocked` and would
    /// stay that way until they were next edited — a key pasted once, months
    /// ago, is exactly the key a background run needs. One update covers
    /// them all: the query names the service and no account.
    ///
    /// `errSecItemNotFound` is the ordinary answer on a fresh install.
    func migrateAccessibility() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let attributes: [String: Any] = [
            kSecAttrAccessible as String: Self.accessibility
        ]
        _ = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// A dictionary standing in for the Keychain, for tests.
final class InMemorySecretStore: SecretStore {
    private(set) var values: [String: String] = [:]

    func read(account: String) -> String? { values[account] }

    // Empty means delete, exactly as the Keychain store treats it — a double
    // with different semantics tests a store nobody ships.
    func write(_ value: String, account: String) {
        if value.isEmpty { values[account] = nil } else { values[account] = value }
    }

    func delete(account: String) { values[account] = nil }
}

/// The named env values a bundle may require — `ANTHROPIC_API_KEY` and
/// friends. Values live in the Keychain; the list of names, which is not a
/// secret, lives in UserDefaults so Settings can show empty rows worth
/// filling in.
///
/// The engine reads the Keychain directly (`LocalEngine.resolveEnv`), and
/// this store writes through it — a key pasted in Settings is live on the
/// very next run.
@MainActor
@Observable
final class EnvKeyStore {
    /// Always offered, filled in or not — the two providers a flow's
    /// `$ENV` refs overwhelmingly name.
    static let suggested = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    private static let namesKey = "env.names"

    private(set) var names: [String]
    /// Mirrors the secret store so rows re-render on edit; the store itself
    /// stays the authority.
    private var values: [String: String]

    private let secrets: SecretStore
    private let defaults: UserDefaults

    init(
        secrets: SecretStore = KeychainSecretStore(
            service: KeychainSecretStore.envService),
        defaults: UserDefaults = .standard
    ) {
        self.secrets = secrets
        self.defaults = defaults

        // Foreground launch is the one moment the device is certainly
        // unlocked, so it is where items from an older build get re-filed.
        secrets.migrateAccessibility()

        var names = defaults.stringArray(forKey: Self.namesKey) ?? []
        for seed in Self.suggested where !names.contains(seed) {
            names.append(seed)
        }
        self.names = names
        self.values = Dictionary(
            uniqueKeysWithValues: names.map { ($0, secrets.read(account: $0) ?? "") }
        )
        persistNames()
    }

    func value(of name: String) -> String {
        values[name] ?? ""
    }

    func has(_ name: String) -> Bool {
        !value(of: name).isEmpty
    }

    func set(_ value: String, for name: String) {
        values[name] = value
        secrets.write(value, account: name)
    }

    /// Add a row. A name already listed is not duplicated; its value is
    /// left alone.
    func add(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !names.contains(trimmed) else { return }
        names.append(trimmed)
        values[trimmed] = secrets.read(account: trimmed) ?? ""
        persistNames()
    }

    /// Delete the row and its secret. A suggested name returns, empty, on
    /// the next launch — the suggestion is a seed, not a record.
    func remove(name: String) {
        secrets.delete(account: name)
        values[name] = nil
        names.removeAll { $0 == name }
        persistNames()
    }

    private func persistNames() {
        defaults.set(names, forKey: Self.namesKey)
    }
}
