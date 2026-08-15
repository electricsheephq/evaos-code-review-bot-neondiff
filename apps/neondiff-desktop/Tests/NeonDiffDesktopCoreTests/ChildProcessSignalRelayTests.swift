import Darwin
import Testing
@testable import NeonDiffDesktopCore

@Suite struct ChildProcessSignalRelayTests {
    @Test func signalBeforeLaunchIsForwardedWhenChildBinds() {
        var forwarded: [(Int32, Int32)] = []
        let relay = NeonDiffChildProcessSignalRelay { pid, signal in
            forwarded.append((pid, signal))
        }

        relay.receive(SIGTERM)
        #expect(forwarded.isEmpty)

        relay.bind(processIdentifier: 42)
        #expect(forwarded.count == 1)
        #expect(forwarded.first?.0 == 42)
        #expect(forwarded.first?.1 == SIGTERM)
    }

    @Test func signalAfterLaunchTargetsOnlyTheBoundChild() {
        var forwarded: [(Int32, Int32)] = []
        let relay = NeonDiffChildProcessSignalRelay { pid, signal in
            forwarded.append((pid, signal))
        }

        relay.bind(processIdentifier: 43)
        relay.receive(SIGTERM)
        relay.unbind(processIdentifier: 43)
        relay.receive(SIGTERM)

        #expect(forwarded.count == 1)
        #expect(forwarded.first?.0 == 43)
        #expect(forwarded.first?.1 == SIGTERM)
    }
}
