import AppIntents
import Foundation
import HeddleCore

/// A saved agent, as Shortcuts sees it: a row in the action's picker, a
/// phrase Siri can match by name.
///
/// The identity is the `Agent`'s own UUID, so a shortcut built today keeps
/// pointing at the same agent after a rename — and breaks loudly, rather
/// than silently running the wrong flow, if that agent is deleted.
struct AgentEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Agent")
    }

    static var defaultQuery = AgentEntityQuery()

    var id: UUID
    var name: String
    var sourceLabel: String

    init(_ agent: Agent) {
        id = agent.id
        name = agent.name
        sourceLabel = agent.sourceLabel
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)", subtitle: "\(sourceLabel)"
        )
    }
}

/// The agent list, read through the app's own store.
struct AgentEntityQuery: EntityQuery, EntityStringQuery {
    @MainActor
    private var saved: [Agent] { AppModel.shared.agents.agents }

    @MainActor
    func entities(for identifiers: [UUID]) async throws -> [AgentEntity] {
        // Identifier order is the caller's, not the list's — a shortcut
        // naming two agents expects them back the way it asked.
        identifiers.compactMap { id in
            saved.first { $0.id == id }.map(AgentEntity.init)
        }
    }

    @MainActor
    func suggestedEntities() async throws -> [AgentEntity] {
        saved.map(AgentEntity.init)
    }

    /// What Siri asks when someone says a name rather than picking a row.
    @MainActor
    func entities(matching string: String) async throws -> [AgentEntity] {
        saved
            .filter { $0.name.localizedCaseInsensitiveContains(string) }
            .map(AgentEntity.init)
    }
}

/// Run a saved agent from Shortcuts, Siri, or a Home-screen automation, and
/// hand the answer back for the next action to use.
///
/// The run is `RunStore`'s, not a second implementation of one: the same
/// store the UI drives, so a portable bundle runs on-device through the
/// embedded engine, a non-portable one falls back to the server, and the
/// frames land in the same reducer. What the intent adds is a headless way
/// in and a string on the way out.
struct RunAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Run Agent"

    static var description = IntentDescription(
        """
        Runs one of your saved Heddle agents and returns its answer. \
        Bundles that can run on this device do; the rest run on your server.
        """,
        categoryName: "Agents",
        searchKeywords: ["heddle", "agent", "flow", "run"]
    )

    /// The run happens in the background; the app is only brought forward
    /// when someone asks for it in the Shortcuts editor.
    static var openAppWhenRun = false

    @Parameter(title: "Agent", description: "The saved agent to run.")
    var agent: AgentEntity

    /// Optional because plenty of agents take nothing — a digest that reads
    /// a calendar wants no prompt. Optional also means Shortcuts never asks
    /// for it, so there is no `requestValueDialog` here to be ignored.
    ///
    /// One string, under the agent's own `inputKey`, rather than a field per
    /// declared input: a static intent cannot grow parameters per agent, and
    /// the single-input flow is the one worth reaching by voice.
    @Parameter(
        title: "Input",
        description: "Sent under the agent's input key — the flow's first declared input."
    )
    var input: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Run \(\.$agent) with \(\.$input)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let model = AppModel.shared

        // The entity carries a snapshot; the store holds the live agent, and
        // an id with nothing behind it means the agent was deleted after
        // this shortcut was built.
        guard let saved = model.agents.agents.first(where: { $0.id == agent.id }) else {
            throw RunAgentError.noSuchAgent(agent.name)
        }

        var inputs: [String: JSONValue] = [:]
        if let input, !input.isEmpty {
            inputs[saved.inputKey] = .string(input)
        }

        // No session: a shortcut is a one-shot, not a conversation. Chat is
        // where sessions belong, and minting one here would leave a
        // checkpoint nobody returns to.
        let record = model.runs.start(agent: saved, input: inputs)
        let settled = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                model.runs.onCompletion(of: record) { continuation.resume(returning: $0) }
            }
        } onCancel: {
            // Shortcuts stopped waiting — stop the work too, rather than
            // leaving a run burning tokens for an answer nobody reads.
            Task { @MainActor in model.runs.cancel(record) }
        }

        let answer = try Self.answer(from: settled)
        return .result(value: answer, dialog: IntentDialog(stringLiteral: answer))
    }

    /// What a settled run gives Shortcuts: the answer, or the reason there
    /// isn't one. Separate from `perform` because this is the whole of the
    /// intent's judgment, and the rest is plumbing that needs a live store.
    @MainActor
    static func answer(from record: RunRecord) throws -> String {
        switch record.status {
        case .succeeded:
            // The repo's own rendering rule, the same one chat shows.
            return record.answerText

        case .suspended(let suspension):
            // A flow that asks a question mid-run has nobody to ask here.
            // Saying which question beats a bare failure: it tells whoever
            // built the shortcut that this agent wants the app, not an
            // automation.
            throw RunAgentError.needsAnAnswer(suspension.question)

        case .failed(let message):
            throw RunAgentError.failed(message)

        case .running:
            // `onCompletion` fires after the status leaves `.running`, so
            // this is unreachable — and a wrong answer would be worse than
            // an honest failure if it ever stopped being.
            throw RunAgentError.failed("the run ended without a result")
        }
    }
}

/// The ways a run from Shortcuts can end badly, in words that say what to do
/// about it — an intent's error is read in the Shortcuts editor, far from
/// any transcript.
enum RunAgentError: Swift.Error, CustomLocalizedStringResourceConvertible {
    case noSuchAgent(String)
    case needsAnAnswer(String)
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .noSuchAgent(let name):
            return "“\(name)” is no longer saved in Heddle. Pick the agent again."
        case .needsAnAnswer(let question):
            return """
                This agent stopped to ask: “\(question)”. \
                Agents that ask questions have to be run in the app.
                """
        case .failed(let message):
            return "The run failed: \(message)"
        }
    }
}

/// The phrase Siri listens for, and the action Shortcuts offers before
/// anyone has built anything.
struct HeddleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RunAgentIntent(),
            phrases: [
                "Run an agent with \(.applicationName)",
                "Run a \(.applicationName) agent",
                "Ask \(.applicationName)",
            ],
            shortTitle: "Run Agent",
            systemImageName: "circle.hexagongrid"
        )
    }
}
