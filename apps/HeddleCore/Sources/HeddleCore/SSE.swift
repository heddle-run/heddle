import Foundation

/// One server-sent event, as `SseStream` writes them
/// (`packages/server/src/sse.ts`): an optional `event:` name and the joined
/// `data:` lines.
public struct SSEEvent: Equatable {
    public var event: String?
    public var data: String

    public init(event: String?, data: String) {
        self.event = event
        self.data = data
    }
}

/// Incremental parser for the `/v1/runs?stream=true` byte stream.
///
/// Fed one line at a time, without its terminator; a blank line closes the
/// pending event. Only the fields the server writes are honoured — `event:`
/// and `data:` — plus `:` comments, which keep-alive proxies inject. Kept
/// apart from the URLSession plumbing so it is testable with strings.
public struct SSEParser {
    private var event: String?
    private var data: [String] = []

    public init() {}

    public mutating func consume(line: String) -> SSEEvent? {
        if line.isEmpty {
            guard !data.isEmpty else {
                event = nil
                return nil
            }
            let complete = SSEEvent(event: event, data: data.joined(separator: "\n"))
            event = nil
            data = []
            return complete
        }
        if line.hasPrefix(":") { return nil }

        let name: Substring
        let value: Substring
        if let colon = line.firstIndex(of: ":") {
            name = line[line.startIndex..<colon]
            let afterColon = line.index(after: colon)
            // The spec strips exactly one leading space from the value.
            let start = line[afterColon...].hasPrefix(" ")
                ? line.index(after: afterColon) : afterColon
            value = line[start...]
        } else {
            name = line[...]
            value = ""
        }

        switch name {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}
