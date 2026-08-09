import Foundation
import UserNotifications

/// Completion notifications, when the process can send any.
///
/// UserNotifications wants a real app bundle behind the process; under a bare
/// `swift run` there is none, so everything here degrades to doing nothing
/// rather than crashing the development loop.
@MainActor
final class Notifier {
    private let available = Bundle.main.bundleIdentifier != nil
    private var authorized = false

    func requestAuthorization() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { granted, _ in
            Task { @MainActor in self.authorized = granted }
        }
    }

    func runFinished(_ run: RunRecord) {
        guard available, authorized else { return }

        let content = UNMutableNotificationContent()
        switch run.status {
        case .succeeded:
            content.title = "\(run.agentName) finished"
            content.body = String(run.summary.prefix(200))
        case .failed(let message):
            content.title = "\(run.agentName) failed"
            content.body = String(message.prefix(200))
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
}
