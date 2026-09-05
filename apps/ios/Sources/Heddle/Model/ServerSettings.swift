import Foundation
import Observation

/// Where the runs go: one server, remembered across launches.
///
/// The URL is a preference; the bearer token is a secret and lives in the
/// Keychain. The token is only useful against a server started with
/// `--auth-token` — a stock `heddle-server` has no auth at all and should
/// only ever be reached over loopback or a network the user trusts.
@MainActor
@Observable
final class ServerSettings {
    static let defaultURL = "http://127.0.0.1:4319"
    private static let urlKey = "server.url"
    private static let tokenAccount = "server-token"

    var urlString: String {
        didSet { UserDefaults.standard.set(urlString, forKey: Self.urlKey) }
    }

    var token: String {
        didSet { Keychain.write(token, account: Self.tokenAccount) }
    }

    init() {
        urlString =
            UserDefaults.standard.string(forKey: Self.urlKey) ?? Self.defaultURL
        Keychain.migrateAccessibility()
        token = Keychain.read(account: Self.tokenAccount) ?? ""
    }

    /// The client for the configured server, or nil while the URL is not one.
    var client: ServerClient? {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host() != nil
        else { return nil }
        return ServerClient(baseURL: url, token: token)
    }
}
