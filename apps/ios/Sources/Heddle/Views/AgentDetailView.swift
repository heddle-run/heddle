import SwiftUI

/// One agent: chat with it, or fire a single run.
struct AgentDetailView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(RunStore.self) private var runs

    let agentID: Agent.ID

    @State private var input = ""
    @State private var startedRun: RunRecord?
    @State private var chat: ChatController?

    var body: some View {
        if let agent = agents.agents.first(where: { $0.id == agentID }) {
            Form {
                Section {
                    LabeledContent("Flow", value: agent.sourceLabel)
                    LabeledContent("Input key", value: agent.inputKey)
                }

                Section {
                    Button {
                        chat = ChatController(agent: agent, runs: runs)
                    } label: {
                        Label("Start a conversation", systemImage: "bubble.left.and.bubble.right")
                    }
                } footer: {
                    Text(
                        "Each message is one run in a server-side session — "
                            + "the server needs --session-store for this."
                    )
                }

                Section {
                    TextField(
                        "What to send as \"\(agent.inputKey)\" — empty runs bare",
                        text: $input,
                        axis: .vertical
                    )
                    .lineLimit(1...4)
                    Button {
                        startedRun = start(agent)
                    } label: {
                        Label("Run once", systemImage: "play.fill")
                    }
                } header: {
                    Text("One run")
                }
            }
            .navigationTitle(agent.name)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $startedRun) { run in
                RunDetailView(runID: run.id)
            }
            .fullScreenCover(item: $chat) { controller in
                NavigationStack {
                    ChatView(controller: controller)
                }
            }
        } else {
            ContentUnavailableView("Agent removed", systemImage: "circle.dashed")
        }
    }

    private func start(_ agent: Agent) -> RunRecord {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let inputs: [String: JSONValue]? =
            text.isEmpty ? nil : [agent.inputKey: .string(text)]
        input = ""
        return runs.start(agent: agent, input: inputs)
    }
}

extension RunRecord: Hashable {
    nonisolated static func == (lhs: RunRecord, rhs: RunRecord) -> Bool {
        lhs === rhs
    }

    nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
}

extension ChatController: Identifiable {}
