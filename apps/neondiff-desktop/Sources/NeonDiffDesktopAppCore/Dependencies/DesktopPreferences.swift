import Foundation

package protocol DesktopPreferences: Sendable {
    func string(forKey key: String) -> String?
    func bool(forKey key: String) -> Bool
    func set(_ value: String, forKey key: String)
    func set(_ value: Bool, forKey key: String)
    func removeValue(forKey key: String)
}
