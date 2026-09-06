import AppIntents
import HeddleCore
import XCTest
@testable import Heddle

/// What the Shortcuts action makes of a settled run.
///
/// `perform` itself needs the app's live stores and is left to the app; the
/// judgment it delegates — answer, or which reason there isn't one — is
/// here, because every one of these outcomes is read by someone in the
/// Shortcuts editor with no transcript in front of them.
@MainActor
final class RunAgentIntentTests: XCTestCase {
    private func record(named name: String = "Digest") -> Heddle.RunRecord {
        Heddle.RunRecord(
            agent: Agent(name: name, source: .inline("nodes: []")),
            sessionID: nil
        )
    }

    func testASucceededRunAnswersWithTheTurnsResult() throws {
        let run = record()
        run.status = .succeeded
        // `result` as a string is the repo's own rendering rule — the same
        // string chat shows as the assistant's reply.
        run.finalState = .object(["result": .string("Three things happened today.")])

        XCTAssertEqual(
            try RunAgentIntent.answer(from: run), "Three things happened today."
        )
    }

    /// A flow with no `result` still has to hand Shortcuts something a
    /// following action can use.
    func testARunWithoutAResultFallsBackToItsState() throws {
        let run = record()
        run.status = .succeeded
        run.finalState = .object(["count": .number(2)])

        let answer = try RunAgentIntent.answer(from: run)
        XCTAssertTrue(answer.contains("count"), answer)
        XCTAssertTrue(answer.contains("2"), answer)
    }

    func testASuspendedRunReportsTheQuestionItStoppedOn() {
        let run = record()
        run.status = .suspended(
            Suspension(
                session: "local-1",
                by: "ask",
                ask: .object(["question": .string("Which inbox?")])
            )
        )

        XCTAssertThrowsError(try RunAgentIntent.answer(from: run)) { error in
            guard case RunAgentError.needsAnAnswer(let question) = error else {
                return XCTFail("expected needsAnAnswer, got \(error)")
            }
            XCTAssertEqual(question, "Which inbox?")
            // The editor shows this string and nothing else, so it carries
            // both the question and what to do about it.
            let shown = String(localized: RunAgentError.needsAnAnswer(question)
                .localizedStringResource)
            XCTAssertTrue(shown.contains("Which inbox?"), shown)
            XCTAssertTrue(shown.contains("in the app"), shown)
        }
    }

    func testAFailedRunCarriesItsMessageThrough() {
        let run = record()
        run.status = .failed("ANTHROPIC_API_KEY is not set")

        XCTAssertThrowsError(try RunAgentIntent.answer(from: run)) { error in
            guard case RunAgentError.failed(let message) = error else {
                return XCTFail("expected failed, got \(error)")
            }
            XCTAssertEqual(message, "ANTHROPIC_API_KEY is not set")
        }
    }

    /// `onCompletion` fires only after the status leaves `.running`, so this
    /// is unreachable today — and must stay a failure rather than an empty
    /// answer if that ever changes.
    func testAStillRunningRecordIsAFailureNotAnEmptyAnswer() {
        XCTAssertThrowsError(try RunAgentIntent.answer(from: record()))
    }

    func testTheEntityCarriesTheNameAndSourceShortcutsShows() {
        let agent = Agent(name: "Daily Digest", source: .bundle(id: "abc123"))
        let entity = AgentEntity(agent)

        XCTAssertEqual(entity.id, agent.id)
        XCTAssertEqual(entity.name, "Daily Digest")
        XCTAssertEqual(entity.sourceLabel, "imported bundle")
    }
}
