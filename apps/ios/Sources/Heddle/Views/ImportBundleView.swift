import HeddleCore
import SwiftUI

/// One `.heddle` to look at before it becomes an agent: sheet identity for
/// `sheet(item:)`, whichever door the file came through.
struct ImportRequest: Identifiable {
    let id = UUID()
    let url: URL
}

/// The import sheet: what the bundle is, what it requires, and whether this
/// iPhone can run it — shown before anything is added, so a bundle full of
/// server-only machinery is a fact the person reads, not a failed run they
/// debug.
///
/// The work happens up front: the sheet extracts into `BundleStore`'s
/// directory as it appears, then either keeps the result (Add) or deletes
/// it (anything else).
struct ImportBundleView: View {
    @Environment(AgentStore.self) private var agents
    @Environment(EnvKeyStore.self) private var envKeys
    @Environment(\.dismiss) private var dismiss

    let url: URL

    private enum Phase {
        case importing
        case failed(String)
        case ready(Agent)
    }

    @State private var phase = Phase.importing
    @State private var added = false

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .importing:
                    ProgressView("Reading \(url.lastPathComponent)…")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Not importable", systemImage: "shippingbox.slash")
                    } description: {
                        Text(message)
                    }
                case .ready(let agent):
                    preview(agent)
                }
            }
            .navigationTitle("Import Bundle")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { add() }
                        .disabled(readyAgent == nil)
                }
            }
        }
        .task {
            do {
                phase = .ready(try BundleStore().importBundle(from: url))
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
        .onDisappear {
            // Dismissed without adding: the extraction is deleted, as if
            // the file was never opened.
            if !added, let agent = readyAgent {
                try? BundleStore().remove(agent: agent)
            }
        }
    }

    private var readyAgent: Agent? {
        if case .ready(let agent) = phase { return agent }
        return nil
    }

    private func add() {
        guard let agent = readyAgent else { return }
        agents.add(agent)
        added = true
        dismiss()
    }

    @ViewBuilder
    private func preview(_ agent: Agent) -> some View {
        Form {
            Section {
                LabeledContent("Name", value: agent.name)
                LabeledContent("File", value: url.lastPathComponent)
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
                    if requirements.contains(where: { unmetEnvName($0) != nil }) {
                        Text("Add missing API keys under Settings › API keys.")
                    }
                }
            }

            Section {
                if agent.portability?.portable == true {
                    Label {
                        Text("Runs on this iPhone")
                    } icon: {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    }
                } else {
                    ForEach(
                        agent.portability?.reasons ?? [], id: \.self
                    ) { reason in
                        Label {
                            Text(reason.label)
                        } icon: {
                            Image(systemName: "desktopcomputer")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Where it runs")
            } footer: {
                if agent.portability?.portable != true {
                    Text("This bundle will run on your heddle-server.")
                }
            }
        }
    }

    private func unmetEnvName(_ requirement: Requirement) -> String? {
        if case .env(let name, _) = requirement, !envKeys.has(name) {
            return name
        }
        return nil
    }
}

/// One `requires` row, observed as far as a phone can: an env key is met
/// when the key store holds it; a binary, file, or node range is a fact
/// about some other machine.
struct RequirementRow: View {
    let requirement: Requirement
    let envKeys: EnvKeyStore

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(requirement.label)
                    .font(.body.monospaced())
                if let hint = requirement.hint {
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            status
        }
    }

    @ViewBuilder
    private var status: some View {
        switch requirement {
        case .env(let name, _):
            if envKeys.has(name) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Text("not set")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        case .binary, .file, .node:
            Text("on a computer")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
