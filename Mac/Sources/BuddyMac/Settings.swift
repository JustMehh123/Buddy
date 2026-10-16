import Foundation
import BuddyShared

/// User choices from the menu bar, kept between launches.
final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    var onChange: (() -> Void)?

    /// Cursor size in points (the design's default is 72).
    var cursorSize: Double {
        get { defaults.object(forKey: "cursorSize") as? Double ?? 72 }
        set { defaults.set(newValue, forKey: "cursorSize"); onChange?() }
    }

    var glow: Bool {
        get { defaults.object(forKey: "glow") as? Bool ?? false }
        set { defaults.set(newValue, forKey: "glow"); onChange?() }
    }

    var showCursor: Bool {
        get { defaults.object(forKey: "showCursor") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "showCursor"); onChange?() }
    }

    /// Where the phone sits under the screen, 0 = left edge, 1 = right edge.
    var phonePosition: Double {
        get { defaults.object(forKey: "phonePosition") as? Double ?? 0.5 }
        set { defaults.set(newValue, forKey: "phonePosition"); onChange?() }
    }

    /// When idle, hide the big cursor and let the phone's eyes follow your own mouse.
    var followMouse: Bool {
        get { defaults.object(forKey: "followMouse") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "followMouse"); onChange?() }
    }

    var captions: Bool {
        get { defaults.object(forKey: "captions") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "captions"); onChange?() }
    }

    /// Lets him click, type, press keys and open things when you ask.
    var computerControl: Bool {
        get { defaults.object(forKey: "computerControl") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "computerControl"); onChange?() }
    }

    /// How the cursor's path shows while it flies.
    var trail: PointerTrail {
        get { PointerTrail(rawValue: defaults.string(forKey: "trail") ?? "") ?? .comet }
        set { defaults.set(newValue.rawValue, forKey: "trail"); onChange?() }
    }

    /// Which voice he speaks with. The phone picks from the voices the browser
    /// already has, so this is just a hint; "System" lets it choose.
    var voice: String {
        get { defaults.string(forKey: "voice") ?? "System" }
        set { defaults.set(newValue, forKey: "voice"); onChange?() }
    }

    /// Where his open-source model server lives. Empty means the default local
    /// Ollama (http://127.0.0.1:11434).
    var brainHost: String {
        get { defaults.string(forKey: "brainHost") ?? "" }
        set { defaults.set(newValue, forKey: "brainHost"); onChange?() }
    }

    /// Which model he thinks with. Empty means the default (llama3.2).
    var brainModel: String {
        get { defaults.string(forKey: "brainModel") ?? "" }
        set { defaults.set(newValue, forKey: "brainModel"); onChange?() }
    }

    /// The mood picked by hand in the menu.
    var mood: Mood {
        get { Mood(rawValue: defaults.string(forKey: "mood") ?? "") ?? .listening }
        set { defaults.set(newValue.rawValue, forKey: "mood"); onChange?() }
    }
}
