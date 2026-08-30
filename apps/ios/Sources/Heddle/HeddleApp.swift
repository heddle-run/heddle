import SwiftUI

@main
struct HeddleApp: App {
    @State private var model = AppModel()
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
@MainActor
@Observable
final class AppModel {
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
