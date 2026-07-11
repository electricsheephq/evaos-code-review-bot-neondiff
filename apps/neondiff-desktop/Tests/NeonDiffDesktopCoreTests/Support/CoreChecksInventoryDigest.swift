import CryptoKit
import Foundation

func coreChecksSHA256(_ messages: [String]) -> String {
    let data = Data((messages.joined(separator: "\n") + "\n").utf8)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
