import SwiftUI

struct ContentView: View {
    @Environment(RunStore.self) private var runs

    var body: some View {
        TabView {
            AgentsView()
                .tabItem { Label("Agents", systemImage: "circle.hexagongrid") }

            RunsView()
                .tabItem { Label("Runs", systemImage: "play.circle") }
                .badge(runs.needingAnswer.count)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
