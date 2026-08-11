import SwiftUI

/// One run's transcript and result, in a regular window.
struct RunDetailView: View {
    @Environment(RunStore.self) private var runs
    let runID: UUID?

    var body: some View {
        if let run = runs.runs.first(where: { $0.id == runID }) {
            RunTranscript(run: run)
                .navigationTitle(run.agentName)
        } else {
            ContentUnavailableView(
                "No run selected",
                systemImage: "circle.dashed",
                description: Text("Pick a run from the Heddle menu.")
            )
        }
    }
}

private struct RunTranscript: View {
    let run: RunRecord
    @Environment(RunStore.self) private var runs

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(run.items) { item in
                            TranscriptRow(item: item)
                        }
                        if let suspension = run.suspension {
                            AskCard(ask: suspension) { runs.answer(run, with: $0) }
                        }
                        if let state = run.finalState {
                            ResultBox(state: state)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .onChange(of: run.items.count) {
                    proxy.scrollTo("end", anchor: .bottom)
                }
            }
        }
        .frame(minWidth: 440, minHeight: 320)
    }

    private var header: some View {
        HStack {
            switch run.status {
            case .running:
                ProgressView().controlSize(.small)
                Text("Running \(run.agentName)…")
            case .succeeded:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Finished")
            case .suspended:
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("Waiting on your answer")
            case .failed(let message):
                Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                Text(message).lineLimit(2)
            }
            Spacer()
            if run.isRunning {
                Button("Cancel") { runs.cancel(run) }
            }
        }
        .padding(10)
    }
}

private struct TranscriptRow: View {
    let item: TranscriptItem

    var body: some View {
        switch item.kind {
        case .nodeStart(let name):
            Label(name, systemImage: "arrowtriangle.right.fill")
                .font(.caption.smallCaps())
                .foregroundStyle(.secondary)
        case .toolCall(let name):
            Label(name, systemImage: "wrench.adjustable")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .output:
            Text(item.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .note:
            Text(item.text)
                .font(.caption)
                .foregroundStyle(.orange)
        case .failure:
            Text(item.text)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        }
    }
}

private struct ResultBox: View {
    let state: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Result")
                .font(.caption.smallCaps())
                .foregroundStyle(.secondary)
            Text(resultText)
                .textSelection(.enabled)
                .font(.body.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    /// A single-key state shows its one value bare; anything wider, as JSON.
    private var resultText: String {
        if let object = state.objectValue, object.count == 1,
           let only = object.values.first
        {
            return only.displayText
        }
        return state.prettyJSON()
    }
}
