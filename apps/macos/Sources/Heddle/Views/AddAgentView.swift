import SwiftUI

/// Install an agent from an https address — the other half of "Add Agent…",
/// for the bundle someone sent as a link rather than a file.
struct AddAgentView: View {
    @Environment(AgentStore.self) private var agents

    let onInstalled: (Agent) -> Void

    @State private var address = ""
    @State private var installing = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paste the address of a .heddle bundle")
                .font(.caption.smallCaps())
                .foregroundStyle(.secondary)
            TextField("https://example.com/agent.heddle", text: $address)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .onSubmit(install)
                .disabled(installing)

            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                if installing {
                    ProgressView().controlSize(.small)
                    Text("Downloading…").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Install", action: install)
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        installing
                            || address.trimmingCharacters(in: .whitespaces).isEmpty
                    )
            }
        }
        .padding()
        .frame(minWidth: 440)
    }

    private func install() {
        guard !installing else { return }
        installing = true
        failure = nil
        let target = address

        Task { @MainActor in
            defer { installing = false }
            do {
                onInstalled(try await agents.install(fromRemote: target))
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
