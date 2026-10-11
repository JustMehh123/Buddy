import Foundation
import Security

/// API keys live in a private file in ~/Library/Application Support/Buddy (readable only by you),
/// never in the project folder or git. Unlike the Keychain, this never asks for your password.
enum Keychain {
    enum Key: String {
        /// The free path, and the only key Buddy needs: Google AI Studio powers
        /// his voice, his answers, his research and his transcription.
        case gemini
    }

    private static var cache: [String: String]?

    private static var fileURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Buddy", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return dir.appendingPathComponent("keys.json")
    }

    private static func load() -> [String: String] {
        if let cache { return cache }
        let stored = (try? Data(contentsOf: fileURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
        cache = stored
        return stored
    }

    /// The secret the bridge signs its commands with. Made once, on first use,
    /// and readable only by this user — the bridge (which runs as the same
    /// user, on this machine) picks it up from the same folder.
    static var bridgeToken: String {
        let file = fileURL.deletingLastPathComponent().appendingPathComponent("bridge-token")
        if let existing = try? String(contentsOf: file, encoding: .utf8),
           existing.count >= 32 {
            return existing.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let made = bytes.map { String(format: "%02x", $0) }.joined()
        FileManager.default.createFile(atPath: file.path, contents: Data(made.utf8),
                                       attributes: [.posixPermissions: 0o600])
        NSLog("Buddy: made a bridge secret at \(file.path) so only the phone bridge can command this Mac")
        return made
    }

    static func get(_ key: Key) -> String? {
        guard let value = load()[key.rawValue], !value.isEmpty else { return nil }
        return value
    }

    static func set(_ key: Key, _ value: String?) {
        var all = load()
        all[key.rawValue] = value?.isEmpty == false ? value : nil
        cache = all
        guard let data = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys]) else { return }
        FileManager.default.createFile(atPath: fileURL.path, contents: data, attributes: [.posixPermissions: 0o600])
    }
}
