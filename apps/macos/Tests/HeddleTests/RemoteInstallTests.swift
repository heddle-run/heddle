import XCTest
@testable import Heddle

@MainActor
final class RemoteInstallTests: XCTestCase {
    private func store() throws -> AgentStore {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("heddle-agents-\(UUID().uuidString)")
        return AgentStore(directory: directory)
    }

    func testRefusesNonHTTPAddresses() async throws {
        let agents = try store()
        defer { try? FileManager.default.removeItem(at: agents.directory) }

        for address in ["file:///tmp/x.heddle", "ftp://host/x.heddle", "not a url"] {
            do {
                _ = try await agents.install(fromRemote: address)
                XCTFail("\(address) should be refused")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("http"))
            }
        }
    }

    func testRefusesNonBundlePaths() async throws {
        let agents = try store()
        defer { try? FileManager.default.removeItem(at: agents.directory) }

        do {
            _ = try await agents.install(fromRemote: "https://example.com/flow.yaml")
            XCTFail("a flow URL should be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains(".heddle"))
        }
    }
}
