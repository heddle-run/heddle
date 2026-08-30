import XCTest
@testable import Heddle

/// The named env values behind Settings › API keys, exercised over the
/// in-memory secret store — the Keychain's contract without the simulator's
/// Keychain.
@MainActor
final class EnvKeyStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() async throws {
        suiteName = "env-key-tests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testTheSuggestionsAreSeededEmpty() {
        let store = EnvKeyStore(secrets: InMemorySecretStore(), defaults: defaults)
        XCTAssertEqual(store.names, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
        XCTAssertFalse(store.has("ANTHROPIC_API_KEY"))
        XCTAssertEqual(store.value(of: "OPENAI_API_KEY"), "")
    }

    func testValuesRoundTripThroughTheSecretStore() {
        let secrets = InMemorySecretStore()
        let store = EnvKeyStore(secrets: secrets, defaults: defaults)

        store.set("sk-123", for: "OPENAI_API_KEY")
        XCTAssertTrue(store.has("OPENAI_API_KEY"))
        // Written through — this is what the engine's resolveEnv reads.
        XCTAssertEqual(secrets.read(account: "OPENAI_API_KEY"), "sk-123")

        // Clearing the field deletes the secret; the row stays.
        store.set("", for: "OPENAI_API_KEY")
        XCTAssertNil(secrets.read(account: "OPENAI_API_KEY"))
        XCTAssertTrue(store.names.contains("OPENAI_API_KEY"))
    }

    func testAddedNamesPersistAndReload() {
        let secrets = InMemorySecretStore()
        let store = EnvKeyStore(secrets: secrets, defaults: defaults)

        store.add(name: "  MY_PROVIDER_KEY  ")
        store.add(name: "MY_PROVIDER_KEY")  // no duplicate row
        store.set("v-1", for: "MY_PROVIDER_KEY")
        XCTAssertEqual(
            store.names.filter { $0 == "MY_PROVIDER_KEY" }.count, 1
        )

        // A fresh store over the same defaults and secrets sees both the
        // name and the value.
        let reloaded = EnvKeyStore(secrets: secrets, defaults: defaults)
        XCTAssertTrue(reloaded.names.contains("MY_PROVIDER_KEY"))
        XCTAssertEqual(reloaded.value(of: "MY_PROVIDER_KEY"), "v-1")
    }

    func testRemoveDeletesTheNameAndItsSecret() {
        let secrets = InMemorySecretStore()
        let store = EnvKeyStore(secrets: secrets, defaults: defaults)

        store.add(name: "DOOMED")
        store.set("x", for: "DOOMED")
        store.remove(name: "DOOMED")

        XCTAssertFalse(store.names.contains("DOOMED"))
        XCTAssertNil(secrets.read(account: "DOOMED"))

        let reloaded = EnvKeyStore(secrets: secrets, defaults: defaults)
        XCTAssertFalse(reloaded.names.contains("DOOMED"))
    }
}
