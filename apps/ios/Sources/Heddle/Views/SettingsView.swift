import SwiftUI

/// Where the runs go, and whether it answers.
struct SettingsView: View {
    @Environment(ServerSettings.self) private var settings

    private enum Check: Equatable {
        case idle
        case checking
        case reached(String)
        case unreached(String)
    }

    @State private var check = Check.idle

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
