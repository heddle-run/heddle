import SwiftUI

@main
struct HeddleApp: App {
    @State private var model = AppModel.shared
    /// A `.heddle` handed to the app — AirDrop, Files, Mail. The system
    /// copies the file in (`LSSupportsOpeningDocumentsInPlace` is false);
    /// the sheet imports from that copy.
    @State private var opened: ImportRequest?

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model.settings)
                .environment(model.agents)
                .environment(model.runs)
                .environment(model.envKeys)
                .onOpenURL { url in
                    guard url.pathExtension.lowercased() == "heddle" else { return }
                    opened = ImportRequest(url: url)
                }
                .sheet(item: $opened) { request in
                    ImportBundleView(url: request.url)
                        .environment(model.settings)
                        .environment(model.agents)
                        .environment(model.runs)
                        .environment(model.envKeys)
                }
        }
    }
}

/// The app's stores, built once and handed to every screen.
///
/// Shared rather than owned by the scene because the app is no longer the
/// only thing that starts runs: an App Intent performs in this same process
/// with no window in sight, and a second set of stores over the same
/// `agents.json` would mean two writers racing for the file. One set means
/// an intent's run also lands in the Runs tab, where it can be read back.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let settings: ServerSettings
    let agents: AgentStore
    let runs: RunStore
    let envKeys: EnvKeyStore

    init() {
        let settings = ServerSettings()
        self.settings = settings
        let agents = AgentStore()
        self.agents = agents
        let runs = RunStore(settings: settings)
        self.runs = runs
        self.envKeys = EnvKeyStore()
        // A non-portable bundle's first server run learns its server-side
        // id; remembering it on the agent is the agent list's job.
        runs.onServerBundleID = { agent, id in
            var updated = agent
            updated.serverBundleID = id
            agents.update(updated)
        }
    }
}
