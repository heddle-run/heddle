import HeddleCore
import SwiftUI

/// Every run this launch of the app has made, newest first.
struct RunsView: View {
    @Environment(RunStore.self) private var runs

    var body: some View {
        NavigationStack {
            Group {
                if runs.runs.isEmpty {
                    ContentUnavailableView(
                        "No runs yet",
                        systemImage: "play.circle",
                        description: Text("Pick an agent and run it.")
                    )
                } else {
                    List(runs.runs) { run in
                        NavigationLink(value: run.id) {
                            RunRow(run: run)
                        }
                    }
                }
            }
            .navigationTitle("Runs")
            .navigationDestination(for: UUID.self) { id in
                RunDetailView(runID: id)
            }
        }
    }
}

private struct RunRow: View {
    let run: RunRecord

    var body: some View {
        HStack(spacing: 12) {
            statusIcon
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(run.agentName)
                    .font(.headline)
                Text(run.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Text(run.startedAt, style: .time)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch run.status {
        case .running:
            ProgressView()
        case .succeeded:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .suspended:
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        case .failed:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        }
    }
}
