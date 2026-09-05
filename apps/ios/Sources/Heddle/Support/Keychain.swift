/// The one secret the app holds outside the env store: the server's bearer
/// token, in the Keychain rather than UserDefaults, read at request time so
/// a token pasted in Settings is live on the very next call.
///
/// The calls themselves are `KeychainSecretStore`'s — this is that store
/// under the app's own service, named as a static face because the token is
/// a single well-known item rather than a family. Sharing the store is what
/// keeps the token's accessibility class from drifting away from the env
/// values'; both have to survive a locked screen for a background run.
enum Keychain {
    private static let store = KeychainSecretStore(service: "run.heddle.ios")

    static func read(account: String) -> String? {
        store.read(account: account)
    }

    static func write(_ value: String, account: String) {
        store.write(value, account: account)
    }

    static func delete(account: String) {
        store.delete(account: account)
    }

    static func migrateAccessibility() {
        store.migrateAccessibility()
    }
}
