import SwiftUI

/// One row of `heddle sessions ls`: `id  updatedAt  state  flow`.
struct SessionRow: Identifiable, Equatable {
    let id: String
    let updatedAt: String
    let state: String
    let flow: String?

    /// Columns are joined with exactly two spaces (`sessions.ts`), and a
    /// column's own text ("3 turns") holds only single ones — so the
    /// two-space split is the format, not a heuristic.
    static func parse(line: some StringProtocol) -> SessionRow? {
        let columns = String(line)
            .components(separatedBy: "  ")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard columns.count >= 3 else { return nil }
        return SessionRow(
            id: columns[0],
            updatedAt: columns[1],
            state: columns[2],
            flow: columns.count > 3 ? columns[3] : nil
        )
    }
}

/// The conversations heddle has kept, over `heddle sessions` — the same
/// store the CLI reads, so what is listed here is what `--session` resumes.
struct SessionsView: View {
    @State private var rows: [SessionRow] = []
    @State private var transcript: String?
    @State private var selected: SessionRow.ID?
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                ContentUnavailableView(
                    "No sessions",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(note ?? "Conversations agents keep will appear here.")
                )
            } else {
                Table(rows, selection: $selected) {
                    TableColumn("Session") { row in Text(row.id).monospaced() }
                    TableColumn("Updated") { row in Text(row.updatedAt) }
                        .width(160)
                    TableColumn("State") { row in Text(row.state) }
                        .width(90)
                }
                .onChange(of: selected) { loadTranscript() }
                if let transcript {
                    Divider()
                    ScrollView {
                        Text(transcript)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 180)
                }
            }
            Divider()
            HStack {
                Button("Refresh") { refresh() }
                Spacer()
                Button("Delete", role: .destructive) { deleteSelected() }
                    .disabled(selected == nil)
            }
            .padding(8)
        }
        .frame(minWidth: 520, minHeight: 360)
        .onAppear { refresh() }
    }

    private func refresh() {
        Task { @MainActor in
            guard let cli = HeddleCLI.locate() else {
                note = HeddleCLI.LocateError.notFound.localizedDescription
                return
            }
            let result = await cli.output(["sessions", "ls"])
            rows = result.stdout
                .split(separator: "\n")
                .compactMap(SessionRow.parse(line:))
            // "no sessions in <dir>" arrives on stderr; keep the words.
            note = rows.isEmpty ? result.stderr.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            if let selected, !rows.contains(where: { $0.id == selected }) {
                self.selected = nil
                transcript = nil
            }
        }
    }

    private func loadTranscript() {
        guard let selected else {
            transcript = nil
            return
        }
        Task { @MainActor in
            guard let cli = HeddleCLI.locate() else { return }
            let result = await cli.output(["sessions", "show", selected])
            transcript = result.stdout.isEmpty
                ? result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                : result.stdout
        }
    }

    private func deleteSelected() {
        guard let selected else { return }
        Task { @MainActor in
            guard let cli = HeddleCLI.locate() else { return }
            _ = await cli.output(["sessions", "rm", selected])
            refresh()
        }
    }
}
