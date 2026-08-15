import HeddleCore
import SwiftUI

/// One run's transcript and result.
struct RunDetailView: View {
    @Environment(RunStore.self) private var runs
    let runID: UUID

    var body: some View {
        if let run = runs.runs.first(where: { $0.id == runID }) {
            RunTranscript(run: run)
                .navigationTitle(run.agentName)
                .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("No such run", systemImage: "circle.dashed")
        }
    }
}

private struct RunTranscript: View {
    let run: RunRecord
    @Environment(RunStore.self) private var runs

    var body: some View {
        VStack(spacing: 0) {
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
        .font(.subheadline)
        .padding(12)
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
                .font(.callout.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
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

/// A suspension, asked in place: what the middleware wants to know, quick
/// yes/no for the common `{"approved": …}` reply, and a JSON field for
/// every other shape.
struct AskCard: View {
    let ask: Suspension
    let onAnswer: (JSONValue) -> Void

    @State private var freeform = ""
    @State private var parseError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(ask.question, systemImage: "hand.raised")
                .font(.headline)
            Text(ask.ask.prettyJSON())
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack {
                Button("Approve") { onAnswer(.object(["approved": .bool(true)])) }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { onAnswer(.object(["approved": .bool(false)])) }
                    .buttonStyle(.bordered)
            }

            HStack {
                TextField("or answer as JSON, e.g. {\"choice\": \"b\"}", text: $freeform)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.callout.monospaced())
                Button("Answer") { sendFreeform() }
                    .disabled(freeform.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if parseError {
                Text("that is not a JSON object")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }

    private func sendFreeform() {
        guard let data = freeform.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              value.objectValue != nil
        else {
            parseError = true
            return
        }
        parseError = false
        onAnswer(value)
    }
}
