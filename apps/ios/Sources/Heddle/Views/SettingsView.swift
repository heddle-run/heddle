import SwiftUI

/// Where the runs go, and whether it answers — plus the API keys bundles
/// running on this iPhone read their `$ENV` refs from.
struct SettingsView: View {
    @Environment(ServerSettings.self) private var settings
    @Environment(EnvKeyStore.self) private var envKeys

    private enum Check: Equatable {
        case idle
        case checking
        case reached(String)
        case unreached(String)
    }

    @State private var check = Check.idle
    @State private var newKeyName = ""

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                Section {
                    TextField(ServerSettings.defaultURL, text: $settings.urlString)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.body.monospaced())
                } header: {
                    Text("Server")
                } footer: {
                    Text(
                        "A running heddle-server. On your Mac:\n"
                            + "heddle-server --host 0.0.0.0 --session-store file "
                            + "--flows-root ~/flows\n"
                            + "Loopback works in the simulator; a device needs "
                            + "your Mac's LAN address."
                    )
                    .font(.caption.monospaced())
                }

                Section {
                    SecureField("none", text: $settings.token)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Bearer token")
                } footer: {
                    Text(
                        "Sent as an Authorization header, for servers behind "
                            + "an authenticating proxy. Kept in the Keychain. "
                            + "A stock heddle-server ignores it — and trusts "
                            + "everyone who can reach it."
                    )
                }

                Section {
                    ForEach(envKeys.names, id: \.self) { name in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            SecureField(
                                "not set",
                                text: Binding(
                                    get: { envKeys.value(of: name) },
                                    set: { envKeys.set($0, for: name) }
                                )
                            )
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        }
                    }
                    .onDelete { offsets in
                        for name in offsets.compactMap({
                            envKeys.names.indices.contains($0) ? envKeys.names[$0] : nil
                        }) {
                            envKeys.remove(name: name)
                        }
                    }

                    HStack {
                        TextField("ANOTHER_API_KEY", text: $newKeyName)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .font(.body.monospaced())
                        Button("Add") {
                            envKeys.add(name: newKeyName)
                            newKeyName = ""
                        }
                        .disabled(
                            newKeyName.trimmingCharacters(in: .whitespaces).isEmpty
                        )
                    }
                } header: {
                    Text("API keys")
                } footer: {
                    Text(
                        "What a bundle's $ENV references resolve to when it "
                            + "runs on this iPhone. Kept in the Keychain, sent "
                            + "only to the provider the flow itself names. "
                            + "Swipe a row to delete it."
                    )
                }

                Section {
                    Button {
                        checkConnection()
                    } label: {
                        if check == .checking {
                            HStack {
                                ProgressView().controlSize(.small)
                                Text("Checking…")
                            }
                        } else {
                            Text("Check connection")
                        }
                    }
                    .disabled(check == .checking)

                    switch check {
                    case .idle, .checking:
                        EmptyView()
                    case .reached(let summary):
                        Label {
                            Text(summary)
                        } icon: {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                        .font(.callout)
                    case .unreached(let why):
                        Label {
                            Text(why)
                        } icon: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.red)
                        }
                        .font(.callout)
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func checkConnection() {
        guard let client = settings.client else {
            check = .unreached("that is not an http(s) URL")
            return
        }
        check = .checking
        Task {
            do {
                let caps = try await client.capabilities()
                var lines = ["heddle-server \(caps.version)"]
                lines.append(
                    caps.sessionsEnabled
                        ? "sessions: on (\(caps.sessions?.store ?? "?"))"
                        : "sessions: off — chat and approvals need --session-store file"
                )
                lines.append(
                    caps.acceptsFlowPath == true
                        ? "flow paths: accepted"
                        : "flow paths: off — paste flows inline, or start with --flows-root"
                )
                check = .reached(lines.joined(separator: "\n"))
            } catch {
                check = .unreached(error.localizedDescription)
            }
        }
    }
}
