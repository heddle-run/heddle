import Foundation
import UserNotifications

/// What the person did on a notification.
enum NotificationVerdict {
    case approve
    case deny
    /// Plain tap — bring the run's window up.
    case open
}

/// Completion and needs-your-answer notifications, when the process can
/// send any.
///
/// UserNotifications wants a real app bundle behind the process; under a
/// bare `swift run` there is none, so everything here degrades to doing
/// nothing rather than crashing the development loop.
///
/// A suspended run whose ask follows the `{"approved": …}` convention gets
/// Approve/Deny buttons on the notification itself — answering without
/// reaching for a window. Every other shape opens the window, where the
/// JSON field is.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let available = Bundle.main.bundleIdentifier != nil
    private var authorized = false

    /// Set by the app model: what to do when a notification is acted on.
    var onAction: ((UUID, NotificationVerdict) -> Void)?

    private nonisolated static let suspendedCategory = "run-suspended"
    private nonisolated static let runIDKey = "runID"

    func requestAuthorization() {
        guard available else { return }

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approve = UNNotificationAction(
            identifier: "approve", title: "Approve", options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "deny", title: "Deny", options: [.authenticationRequired, .destructive]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.suspendedCategory,
                actions: [approve, deny],
                intentIdentifiers: []
            )
        ])

        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in self.authorized = granted }
        }
    }

    func runFinished(_ run: RunRecord) {
        guard available, authorized else { return }

        let content = UNMutableNotificationContent()
        content.userInfo = [Self.runIDKey: run.id.uuidString]

        switch run.status {
        case .succeeded:
            content.title = "\(run.agentName) finished"
            content.body = String(run.summary.prefix(200))
        case .failed(let message):
            content.title = "\(run.agentName) failed"
            content.body = String(message.prefix(200))
        case .suspended(let suspension):
            content.title = "\(run.agentName) needs your answer"
            content.body = String(suspension.question.prefix(200))
            if suspension.isApprovable {
                content.categoryIdentifier = Self.suspendedCategory
            }
        case .running:
            return
        }

        let request = UNNotificationRequest(
            identifier: run.id.uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let raw = info[Self.runIDKey] as? String, let runID = UUID(uuidString: raw)
        else { return }

        let verdict: NotificationVerdict =
            switch response.actionIdentifier {
            case "approve": .approve
            case "deny": .deny
            default: .open
            }

        await MainActor.run {
            onAction?(runID, verdict)
        }
    }
}

extension Suspension {
    /// Whether the ask's declared reply is the `{"approved": …}` shape the
    /// quick buttons speak — the convention the approval-gate example set.
    var isApprovable: Bool {
        ask.objectValue?["reply"]?.objectValue?.keys.contains("approved") == true
    }
}
