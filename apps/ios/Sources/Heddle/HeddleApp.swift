import SwiftUI

@main
struct HeddleApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model.settings)
                .environment(model.agents)
                .environment(model.runs)
        }
    }
}

/// The app's three stores, built once and handed to every screen.
@MainActor
@Observable
final class AppModel {
    let settings: ServerSettings
    let agents: AgentStore
    let runs: RunStore

    init() {
        let settings = ServerSettings()
        self.settings = settings
        self.agents = AgentStore()
        self.runs = RunStore(settings: settings)
    }
}
