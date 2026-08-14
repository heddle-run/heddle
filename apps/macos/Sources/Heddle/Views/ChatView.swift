import HeddleCore
import SwiftUI

/// The conversation window an `interactive` bundle opens.
struct ChatView: View {
    @State var controller: ChatController
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(controller.messages) { message in
                            MessageBubble(message: message)
                        }
                        if controller.isBusy, let run = controller.activeRun {
                            LiveTurn(run: run)
                        }
                        if let ask = controller.pendingAsk {
                            AskCard(ask: ask) { controller.answer($0) }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .onChange(of: controller.messages.count) {
                    proxy.scrollTo("end", anchor: .bottom)
                }
                .onChange(of: controller.pendingAsk) {
                    proxy.scrollTo("end", anchor: .bottom)
                }
            }
            Divider()
            HStack(alignment: .bottom) {
                TextField("Message \(controller.agent.name)", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .onSubmit(send)
                Button("Send", action: send)
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        controller.isBusy || controller.pendingAsk != nil
                            || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
            .padding(10)
        }
        .frame(minWidth: 460, minHeight: 380)
        .onAppear { focused = true }
    }

    private func send() {
        controller.send(draft)
        draft = ""
    }
}

private struct MessageBubble: View {
    let message: ChatController.Message

    var body: some View {
        switch message.role {
        case .user:
            Text(message.text)
                .textSelection(.enabled)
                .padding(8)
                .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            Text(message.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .system:
            Text(message.text)
                .font(.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The turn in flight: the streamed transcript, small, until it settles.
private struct LiveTurn: View {
    let run: RunRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(run.items.suffix(6)) { item in
                switch item.kind {
                case .output:
                    Text(item.text).frame(maxWidth: .infinity, alignment: .leading)
                case .toolCall(let name):
                    Label(name, systemImage: "wrench.adjustable")
                        .font(.caption).foregroundStyle(.secondary)
                case .nodeStart(let name):
                    Label(name, systemImage: "arrowtriangle.right.fill")
                        .font(.caption2).foregroundStyle(.tertiary)
                case .note, .failure:
                    Text(item.text).font(.caption).foregroundStyle(.orange)
                }
            }
            ProgressView().controlSize(.small)
        }
    }
}

/// A suspension, asked in place: what the middleware wants to know, quick
/// yes/no for the common `{"approved": …}` reply, and a JSON field for
/// every other shape.
struct AskCard: View {
    let ask: Suspension
    let onAnswer: (JSONValue) -> Void

    @State private var freeform = ""
    @State private var parseError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(ask.question, systemImage: "hand.raised")
                .font(.headline)
            Text(ask.ask.prettyJSON())
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack {
                Button("Approve") { onAnswer(.object(["approved": .bool(true)])) }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { onAnswer(.object(["approved": .bool(false)])) }
            }

            HStack {
                TextField("or answer as JSON, e.g. {\"choice\": \"b\"}", text: $freeform)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                Button("Answer") { sendFreeform() }
                    .disabled(freeform.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if parseError {
                Text("that is not a JSON object")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(10)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }

    private func sendFreeform() {
        guard let data = freeform.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              value.objectValue != nil
        else {
            parseError = true
            return
        }
        parseError = false
        onAnswer(value)
    }
}
