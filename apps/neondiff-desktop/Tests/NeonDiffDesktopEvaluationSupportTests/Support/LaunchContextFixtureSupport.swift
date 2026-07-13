import Foundation

func temporaryFixture(contentSize: String = "null") throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("neondiff-evaluation-launch-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let fixtureURL = directory.appendingPathComponent("fixture.json")
    let json = """
    {
      "schemaVersion": 1,
      "id": "tab-overview",
      "surface": {"section": "overview", "onboardingStep": null},
      "environment": {
        "clock": "2026-07-10T12:00:00Z",
        "locale": "en_US_POSIX",
        "appearance": "dark",
        "disableAnimations": true,
        "contentSize": \(contentSize)
      },
      "state": {
        "health": "healthy",
        "runtimeReady": true,
        "repositories": [],
        "provider": null,
        "license": {"entitlement": "active", "credentialPresent": true, "updateChannel": "dev"},
        "github": {"connection": "disconnected", "login": null, "repositoryCount": 0},
        "logText": "Fixture log: deterministic launch."
      },
      "scriptedOutcomes": [],
      "expectedActions": ["refresh-status"],
      "safeCopy": ["deterministic launch"]
    }
    """
    try Data(json.utf8).write(to: fixtureURL)
    return fixtureURL
}

func createFixtureSymlink(at url: URL, destination: URL) throws {
    try FileManager.default.createSymbolicLink(at: url, withDestinationURL: destination)
}

func removeTemporaryFixture(_ url: URL) {
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
}
