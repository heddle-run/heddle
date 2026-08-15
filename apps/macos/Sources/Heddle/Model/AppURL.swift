import Foundation
import HeddleCore

/// What a `heddle://` URL asks for.
///
/// The scheme exists for Shortcuts, Raycast and scripts:
///
///     open "heddle://run?agent=Meeting%20Notes"
///     open "heddle://run?agent=csv-analyst&input=%7B%22query%22%3A%22top%20rows%22%7D"
///
/// One verb today. `agent` names an agent as the menu shows it (or its file
/// stem); `input`, when present, is a JSON object handed to the run as
/// `--input` — given input runs immediately, no form.
enum AppURL: Equatable {
    case run(agent: String, input: [String: JSONValue]?)

    static let scheme = "heddle"

    static func parse(_ url: URL) -> AppURL? {
        guard url.scheme?.lowercased() == scheme,
              url.host()?.lowercased() == "run",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }

        let items = components.queryItems ?? []
        guard let agent = items.first(where: { $0.name == "agent" })?.value,
              !agent.isEmpty
        else { return nil }

        var input: [String: JSONValue]?
        if let raw = items.first(where: { $0.name == "input" })?.value,
           let data = raw.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data),
           let object = value.objectValue
        {
            input = object
        }

        return .run(agent: agent, input: input)
    }
}
