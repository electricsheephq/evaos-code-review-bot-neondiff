import CryptoKit
import Foundation

func coreChecksSHA256(_ messages: [String]) -> String {
    var data = Data()
    for message in messages {
        let bytes = Data(message.utf8)
        var length = UInt64(bytes.count).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(bytes)
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
