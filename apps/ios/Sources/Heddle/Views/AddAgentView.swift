import SwiftUI

/// Name a flow the server can reach: a path under its flows root, or the
/// flow document pasted whole.
struct AddAgentView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(\.dismiss) private var dismiss

    private enum Kind: String, CaseIterable, Identifiable {
        case serverPath = "Server path"
        case inline = "Pasted flow"
        var id: String { rawValue }
    }

    @State private var name = ""
    @State private var kind = Kind.serverPath
    @State private var path = ""
    @State private var source = ""
    @State private var inputKey = "query"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.never)
                }

                Section {
                    Picker("Where the flow lives", selection: $kind) {
                        ForEach(Kind.allCases) { kind in
                            Text(kind.rawValue).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)

                    switch kind {
                    case .serverPath:
                        TextField("flows/notetaker.yaml", text: $path)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .font(.body.monospaced())
                    case .inline:
                        TextEditor(text: $source)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .font(.caption.monospaced())
                            .frame(minHeight: 160)
                    }
                } footer: {
                    switch kind {
                    case .serverPath:
                        Text(
                            "Resolved against the server's --flows-root. "
                                + "The server refuses paths when it was started without one."
                        )
                    case .inline:
                        Text(
                            "The Weave document itself, YAML or JSON. "
                                + "It is sent with every run."
                        )
                    }
                }

                Section {
                    TextField("query", text: $inputKey)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.body.monospaced())
                } header: {
                    Text("Input key")
                } footer: {
                    Text(
                        "The key chat messages are sent under — usually the "
                            + "flow's first input. The CLI's default is \"query\"."
                    )
                }
            }
            .navigationTitle("Add Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { add() }
                        .disabled(!complete)
                }
            }
        }
    }

    private var complete: Bool {
        let named = !name.trimmingCharacters(in: .whitespaces).isEmpty
        switch kind {
        case .serverPath:
            return named && !path.trimmingCharacters(in: .whitespaces).isEmpty
        case .inline:
            return named && !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func add() {
        let source: Agent.Source =
            kind == .serverPath
            ? .serverPath(path.trimmingCharacters(in: .whitespaces))
            : .inline(self.source)
        let key = inputKey.trimmingCharacters(in: .whitespaces)
        agents.add(
            Agent(
                name: name.trimmingCharacters(in: .whitespaces),
                source: source,
                inputKey: key.isEmpty ? "query" : key
            )
        )
        dismiss()
    }
}
