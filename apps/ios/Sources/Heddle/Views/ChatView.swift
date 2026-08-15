import HeddleCore
import SwiftUI

/// The conversation screen: request-per-turn against one server session.
struct ChatView: View {
    @Environment(\.dismiss) private var dismiss
    @State var controller: ChatController
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(controller.messages) { message in
                        MessageBubble(message: message)
                    }
                    if controller.isBusy {
                        LiveTurn(run: controller.activeRun)
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
        .navigationTitle(controller.agent.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
        .onAppear { focused = true }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(controller.agent.name)", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18))
            Button {
                send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title)
            }
            .disabled(
                controller.isBusy || controller.pendingAsk != nil
                    || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
        }
        .padding(10)
        .background(.bar)
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
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
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
/// The run is nil for the moment the session id is still being minted.
private struct LiveTurn: View {
    let run: RunRecord?

    private var tail: [TranscriptItem] {
        guard let run else { return [] }
        return Array(run.items.suffix(6))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tail) { item in
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
