import AppKit
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @Environment(AgentStore.self) private var agents

    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?

    var body: some View {
        Form {
            Section("Agents folder") {
                HStack {
                    Text(agents.directory.path)
                        .truncationMode(.middle)
                        .lineLimit(1)
                        .textSelection(.enabled)
                    Spacer()
                    Button("Open in Finder") {
                        NSWorkspace.shared.open(agents.directory)
                    }
                    Button("Change…", action: changeFolder)
                }
            }

            Section {
                Toggle("Launch Heddle at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, wanted in
                        setLaunchAtLogin(wanted)
                    }
                if let loginItemError {
                    Text(loginItemError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Section("Runtime") {
                Text(runtimeDescription)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var runtimeDescription: String {
        guard let cli = HeddleCLI.locate() else {
            return HeddleCLI.LocateError.notFound.localizedDescription
        }
        return cli.invocation.joined(separator: " ")
    }

    private func changeFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.directoryURL = agents.directory
        panel.message = "Choose the folder Heddle lists agents from"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        agents.setDirectory(url)
    }

    /// `SMAppService` is strict about where the app runs from; outside
    /// /Applications registration can be refused, and the toggle should say
    /// so rather than lie in the on position.
    private func setLaunchAtLogin(_ wanted: Bool) {
        do {
            if wanted {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginItemError = nil
        } catch {
            loginItemError = error.localizedDescription
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}
