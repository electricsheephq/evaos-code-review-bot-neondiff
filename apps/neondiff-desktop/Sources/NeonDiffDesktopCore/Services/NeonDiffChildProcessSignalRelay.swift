import Darwin
import Foundation

package final class NeonDiffChildProcessSignalRelay:
    @unchecked Sendable
{
    private let lock = NSLock()
    private let sendSignal: (Int32, Int32) -> Void
    private var processIdentifier: Int32?
    private var pendingSignal: Int32?

    package init(
        sendSignal: @escaping (Int32, Int32) -> Void = { pid, signal in
            _ = Darwin.kill(pid, signal)
        }
    ) {
        self.sendSignal = sendSignal
    }

    package func bind(processIdentifier: Int32) {
        lock.lock()
        self.processIdentifier = processIdentifier
        let signal = pendingSignal
        pendingSignal = nil
        lock.unlock()

        if let signal {
            sendSignal(processIdentifier, signal)
        }
    }

    package func receive(_ signal: Int32) {
        lock.lock()
        guard let processIdentifier else {
            pendingSignal = signal
            lock.unlock()
            return
        }
        lock.unlock()

        sendSignal(processIdentifier, signal)
    }

    package func unbind(processIdentifier: Int32) {
        lock.lock()
        if self.processIdentifier == processIdentifier {
            self.processIdentifier = nil
            pendingSignal = nil
        }
        lock.unlock()
    }
}
