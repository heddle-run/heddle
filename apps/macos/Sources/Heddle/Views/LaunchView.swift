import SwiftUI

/// The pre-run form: the agent's input, editable, then Run.
///
/// Opens for an agent whose bundle records an `input` (defaults pre-filled,
/// exactly what `heddle run` would use unprompted) and for bare flows, which
/// get the CLI's default `query` field. Agents recording no input skip this
/// window entirely — the menu runs them directly.
struct LaunchView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(RunStore.self) private var runs

    let agentID: Agent.ID?
    let onRun: (RunRecord) -> Void

    @State private var fields: [InputField] = []
    @State private var checks: [CheckedRequirement] = []
    @State private var loadedFor: Agent.ID?

    private var agent: Agent? {
        agents.find(agentID)
    }

    /// Missing keys block Run — the panel exists to ask first. A missing
    /// binary or file only warns: the app installs nothing, and the CLI's
    /// preflight remains the gate that refuses.
    private var missingKeys: [CheckedRequirement] {
        checks.filter { check in
            if case .env = check.requirement { return !check.holds }
            return false
        }
    }

    var body: some View {
        if let agent {
            form(for: agent)
                .onAppear { load(agent) }
        } else {
            ContentUnavailableView(
                "Agent not found",
                systemImage: "questionmark.folder",
                description: Text("It may have been removed from the agents folder.")
            )
            .frame(minWidth: 380, minHeight: 200)
        }
    }

    private func form(for agent: Agent) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !checks.isEmpty {
                PreflightSection(checks: checks) { recheck(agent) }
                Divider()
            }
            ForEach($fields) { $field in
                VStack(alignment: .leading, spacing: 4) {
                    Text(field.key)
                        .font(.caption.smallCaps())
                        .foregroundStyle(.secondary)
                    TextField(field.key, text: $field.text, axis: .vertical)
                        .lineLimit(1...8)
                        .textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Spacer()
                Button("Run") { run(agent) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!missingKeys.isEmpty)
            }
        }
        .padding()
        .frame(minWidth: 420)
        .navigationTitle(agent.name)
    }

    private func load(_ agent: Agent) {
        guard loadedFor != agent.id else { return }
        loadedFor = agent.id
        fields = InputField.fields(for: agent)
        recheck(agent)
    }

    private func recheck(_ agent: Agent) {
        checks = Preflight.check(agent.requires)
    }

    private func run(_ agent: Agent) {
        onRun(runs.start(agent: agent, input: InputField.input(from: fields)))
    }
}

/// What the agent declared it needs, observed on this machine.
///
/// Missing keys get a secure field that saves to the Keychain — the value
/// goes nowhere else, and the next spawn injects it. Missing binaries and
/// files are reported in the author's own `hint` words; the app installs
/// nothing.
private struct PreflightSection: View {
    let checks: [CheckedRequirement]
    let onChange: () -> Void

    @State private var drafts: [String: String] = [:]
    @State private var saveError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Needs")
                .font(.caption.smallCaps())
                .foregroundStyle(.secondary)

            ForEach(checks) { check in
                row(check)
            }

            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private func row(_ check: CheckedRequirement) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: check.holds ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(check.holds ? .green : .orange)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(check.requirement.label)
                    if let detail = check.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if !check.holds, let hint = check.requirement.hint {
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if case .env(let name, _) = check.requirement, !check.holds {
                    HStack {
                        SecureField("value for \(name)", text: draft(name))
                            .textFieldStyle(.roundedBorder)
                        Button("Save") { save(name) }
                            .disabled(drafts[name, default: ""].isEmpty)
                    }
                }
            }
        }
    }

    private func draft(_ name: String) -> Binding<String> {
        Binding(
            get: { drafts[name, default: ""] },
            set: { drafts[name] = $0 }
        )
    }

    private func save(_ name: String) {
        guard let value = drafts[name], !value.isEmpty else { return }
        do {
            try KeychainStore.shared.set(name, value: value)
            drafts[name] = nil
            saveError = nil
            onChange()
        } catch {
            saveError = error.localizedDescription
        }
    }
}

/// One editable input key. Strings edit bare; anything else edits as JSON
/// and is parsed back on Run, falling back to the text as a string — the
/// forgiving read a form owes a person typing.
struct InputField: Identifiable {
    let key: String
    let wasString: Bool
    var text: String

    var id: String { key }

    static func fields(for agent: Agent) -> [InputField] {
        guard let input = agent.defaultInput, !input.isEmpty else {
            // The CLI's default input key, `packages/cli/src/cli/run.ts`.
            return [InputField(key: "query", wasString: true, text: "")]
        }
        return input
            .sorted { $0.key < $1.key }
            .map { key, value in
                if case .string(let text) = value {
                    return InputField(key: key, wasString: true, text: text)
                }
                return InputField(key: key, wasString: false, text: value.prettyJSON())
            }
    }

    static func input(from fields: [InputField]) -> [String: JSONValue] {
        var input: [String: JSONValue] = [:]
        for field in fields {
            let trimmed = field.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if field.wasString {
                input[field.key] = .string(field.text)
            } else if let data = trimmed.data(using: .utf8),
                      let value = try? JSONDecoder().decode(JSONValue.self, from: data)
            {
                input[field.key] = value
            } else {
                input[field.key] = .string(field.text)
            }
        }
        return input
    }
}
