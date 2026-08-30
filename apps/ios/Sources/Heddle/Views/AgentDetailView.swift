import HeddleCore
import SwiftUI

/// One agent: chat with it, or fire a single run.
///
/// Server agents keep their hand-named input key and free-text field. A
/// bundle agent gets the form its flow actually declares — the inputs were
/// read at import — and its Run and Chat are gated on the portability
/// verdict: a bundle full of executable tools is a fact to explain, not a
/// run to fail.
struct AgentDetailView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(RunStore.self) private var runs
    @Environment(EnvKeyStore.self) private var envKeys
    @Environment(ServerSettings.self) private var settings

    let agentID: Agent.ID

    @State private var input = ""
    @State private var bundleInputs: [String: String] = [:]
    @State private var startedRun: RunRecord?
    @State private var chat: ChatController?

    var body: some View {
        if let agent = agents.agents.first(where: { $0.id == agentID }) {
            Form {
                if agent.bundleID != nil {
                    bundleSections(agent)
                } else {
                    serverSections(agent)
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
            .onAppear { prefill(agent) }
        } else {
            ContentUnavailableView("Agent removed", systemImage: "circle.dashed")
        }
    }

    // MARK: - Server flows

    @ViewBuilder
    private func serverSections(_ agent: Agent) -> some View {
        Section {
            LabeledContent("Flow", value: agent.sourceLabel)
            LabeledContent("Input key", value: agent.inputKey)
        }

        Section {
            chatButton(agent)
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
                startedRun = startServer(agent)
            } label: {
                Label("Run once", systemImage: "play.fill")
            }
        } header: {
            Text("One run")
        }
    }

    private func startServer(_ agent: Agent) -> RunRecord {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let inputs: [String: JSONValue]? =
            text.isEmpty ? nil : [agent.inputKey: .string(text)]
        input = ""
        return runs.start(agent: agent, input: inputs)
    }

    // MARK: - Bundles

    @ViewBuilder
    private func bundleSections(_ agent: Agent) -> some View {
        let portable = agent.runsOnDevice

        Section {
            LabeledContent("Source", value: agent.sourceLabel)
            if portable {
                Label {
                    Text("Runs on this iPhone")
                } icon: {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                }
            }
        }

        let requirements = agent.manifestSummary?.requirements ?? []
        if !requirements.isEmpty {
            Section {
                ForEach(requirements, id: \.label) { requirement in
                    RequirementRow(requirement: requirement, envKeys: envKeys)
                }
            } header: {
                Text("Requires")
            } footer: {
                if unmetEnvNames(requirements).isEmpty == false {
                    Text("Add missing API keys under Settings › API keys.")
                }
            }
        }

        if portable {
            Section {
                chatButton(agent)
            } footer: {
                Text("Each message is one run in a conversation kept on this iPhone.")
            }

            Section {
                ForEach(agent.inputFields ?? [], id: \.key) { field in
                    LabeledContent(field.title ?? field.key) {
                        TextField(
                            field.required == true ? "required" : "optional",
                            text: bundleInputBinding(field.key)
                        )
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    }
                }
                Button {
                    startedRun = startBundle(agent)
                } label: {
                    Label("Run once", systemImage: "play.fill")
                }
            } header: {
                Text("One run")
            } footer: {
                if agent.inputFields?.isEmpty ?? true {
                    Text("The flow declares no inputs; a run starts bare.")
                }
            }
        } else {
            // Not portable: the server is where this one runs. With one
            // configured the buttons work — first run uploads the archive,
            // after that it runs by its remembered id. Without one, the
            // buttons explain instead of failing.
            let hasServer = settings.client != nil
            Section {
                Button {
                    startedRun = startBundle(agent)
                } label: {
                    Label("Run once", systemImage: "play.fill")
                }
                .disabled(!hasServer)
                chatButton(agent)
                    .disabled(!hasServer)
            } header: {
                Text("Where it runs")
            } footer: {
                let reasons = (agent.portability?.reasons ?? [])
                    .map(\.label).joined(separator: "; ")
                Text(
                    "This bundle cannot run on this iPhone — "
                        + (reasons.isEmpty ? "it needs a real machine" : reasons)
                        + (hasServer
                            ? ". It runs on your heddle-server instead."
                            : ". Set a server in Settings to run it there.")
                )
            }
        }
    }

    private func chatButton(_ agent: Agent) -> some View {
        Button {
            chat = ChatController(agent: agent, runs: runs)
        } label: {
            Label("Start a conversation", systemImage: "bubble.left.and.bubble.right")
        }
    }

    private func prefill(_ agent: Agent) {
        guard bundleInputs.isEmpty else { return }
        for field in agent.inputFields ?? [] {
            bundleInputs[field.key] = field.defaultText
        }
    }

    private func bundleInputBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { bundleInputs[key] ?? "" },
            set: { bundleInputs[key] = $0 }
        )
    }

    private func startBundle(_ agent: Agent) -> RunRecord {
        var inputs: [String: JSONValue] = [:]
        for field in agent.inputFields ?? [] {
            let text = bundleInputs[field.key]?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty {
                inputs[field.key] = .string(text)
            }
        }
        return runs.start(agent: agent, input: inputs.isEmpty ? nil : inputs)
    }

    private func unmetEnvNames(_ requirements: [Requirement]) -> [String] {
        requirements.compactMap { requirement in
            if case .env(let name, _) = requirement, !envKeys.has(name) {
                return name
            }
            return nil
        }
    }
}

extension ChatController: Identifiable {}
