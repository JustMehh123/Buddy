import Foundation

/// Turns recorded audio into a proper transcript (with speaker labels) and keeps each session's
/// meeting notes as plain files any agent can read: ~/Documents/Buddy Notes/<date> <id>/.
enum MeetingNotes {

    static var root: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Buddy Notes", isDirectory: true)
    }

    struct Segment {
        var speaker: String
        var start: Double
        var end: Double
        var text: String
    }

    // MARK: Folders

    /// The session's folder, made the first time it's needed.
    static func folder(session: String, started: Date) -> URL {
        let fm = FileManager.default
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        writeReadmeIfNeeded()
        let tag = String(session.prefix(8)).lowercased()
        if let existing = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil))?
            .first(where: { $0.lastPathComponent.hasSuffix(tag) }) {
            return existing
        }
        let name = DateFormatter.folderName.string(from: started) + " " + tag
        let url = root.appendingPathComponent(name, isDirectory: true)
        try? fm.createDirectory(at: url.appendingPathComponent("audio"), withIntermediateDirectories: true)
        return url
    }

    private static func writeReadmeIfNeeded() {
        let url = root.appendingPathComponent("README.md")
        guard !FileManager.default.fileExists(atPath: url.path) else { return }
        let text = """
        # Buddy Notes

        Meeting notes recorded by Buddy (the blueberry on your phone). One folder per listening session, \
        named by start time.

        In each session folder:
        - `notes.md`: the full transcript with timestamps and speaker labels, plus the user's questions to Buddy, \
        Buddy's replies and any research reports, in time order. Start here.
        - `session.json`: the same data, structured.
        - `audio/`: the raw recording, as five-minute AAC chunks.

        Speaker letters (A, B, …) are assigned per five-minute chunk, so the same letter can mean different people \
        in different chunks. Lines marked "(live)" are a rough live transcript for audio that hasn't been fully \
        transcribed yet.
        """
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: Transcription

    /// Saves the chunk's audio into the session folder and transcribes it.
    static func transcribe(audio: Data, session: String, index: Int, sessionStarted: Date) async throws -> (segments: [Segment], folder: URL) {
        let folder = folder(session: session, started: sessionStarted)
        let audioURL = folder.appendingPathComponent("audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: audioURL, withIntermediateDirectories: true)
        try audio.write(to: audioURL.appendingPathComponent(String(format: "chunk-%03d.m4a", index)))
        return (try await turns(audio), folder)
    }

    /// Gemini listens to the recording and hands back speaker-labelled turns.
    /// If it can't manage that (a very noisy recording, say), the same audio is
    /// asked for as plain text, so a session always ends up with something.
    private static func turns(_ audio: Data) async throws -> [Segment] {
        do {
            let rows = try await Gemini.transcribe(audio)
            let raw = rows.map {
                Segment(speaker: $0["speaker"] as? String ?? "?",
                        start: ($0["start"] as? Double) ?? Double($0["start"] as? Int ?? 0),
                        end: ($0["end"] as? Double) ?? Double($0["end"] as? Int ?? 0),
                        text: ($0["text"] as? String ?? "").trimmingCharacters(in: .whitespaces))
            }
            let joined = join(raw)
            if !joined.isEmpty { return joined }
        } catch {
            NSLog("Buddy: transcription failed (\(error)), trying without speakers")
        }
        let json = try await Gemini.generate(
            model: Gemini.transcribeModel,
            body: [
                "contents": [[
                    "role": "user",
                    "parts": [
                        ["text": "Write out everything said in this recording, as one block of plain text. No labels, no timestamps."],
                        ["inlineData": ["mimeType": "audio/mp4", "data": audio.base64EncodedString()]],
                    ]
                ]],
                "generationConfig": ["temperature": 0.2]
            ]
        )
        let text = (Gemini.text(in: json) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? [] : [Segment(speaker: "?", start: 0, end: 0, text: text)]
    }

    /// Joins one speaker's consecutive pieces into a single turn.
    private static func join(_ raw: [Segment]) -> [Segment] {
        var turns: [Segment] = []
        for segment in raw where !segment.text.isEmpty {
            if var last = turns.last, last.speaker == segment.speaker, segment.start - last.end < 2.5 {
                last.text += " " + segment.text
                last.end = segment.end
                turns[turns.count - 1] = last
            } else {
                turns.append(segment)
            }
        }
        return turns
    }

    // MARK: Notes files

    /// Writes session.json and notes.md from the phone's copy of the session. Returns the folder.
    @discardableResult
    static func write(session json: [String: Any]) -> URL? {
        guard let id = json["id"] as? String, let startedAt = json["started"] as? Double else { return nil }
        let started = Date(timeIntervalSince1970: startedAt)
        let folder = folder(session: id, started: started)
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: folder.appendingPathComponent("session.json"), options: .atomic)
        }
        try? markdown(json, started: started).write(to: folder.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
        return folder
    }

    private static func markdown(_ json: [String: Any], started: Date) -> String {
        let ended = (json["ended"] as? Double).map { Date(timeIntervalSince1970: $0) }
        let entries = json["entries"] as? [[String: Any]] ?? []
        let pending = json["transcribing"] as? Int ?? 0
        let day = DateFormatter()
        day.dateStyle = .full
        day.timeStyle = .short
        let clock = DateFormatter()
        clock.dateFormat = "h:mm:ss a"

        var out = ["# Buddy session: \(day.string(from: started))", ""]
        if let ended {
            let minutes = Int(ended.timeIntervalSince(started) / 60)
            out.append("Ended \(clock.string(from: ended)) (\(minutes / 60)h \(minutes % 60)m).")
        } else {
            out.append("Still recording.")
        }
        if pending > 0 { out.append("\(pending) recording chunk(s) still being transcribed; this file updates when they're done.") }
        let asked = entries.filter { $0["kind"] as? String == "asked" }.count
        if asked > 0 { out.append("Buddy was asked \(asked) question(s); they're marked inline below.") }
        out += ["", "## Transcript", ""]

        for entry in entries {
            let text = (entry["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let time = (entry["time"] as? Double).map { clock.string(from: Date(timeIntervalSince1970: $0)) } ?? ""
            switch entry["kind"] as? String {
            case "transcript":
                out.append("**[\(time)] Speaker \(entry["speaker"] as? String ?? "?"):** \(text)")
            case "heard":
                out.append("[\(time)] (live) \(text)")
            case "asked":
                out.append("> **[\(time)] Asked Buddy:** \(text)")
            case "reply":
                out.append("> **Buddy:** \(text)")
            case "report":
                let quoted = text.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
                out.append("> **Research report:**\n" + quoted)
            default:
                out.append("[\(time)] \(text)")
            }
            out.append("")
        }
        return out.joined(separator: "\n")
    }
}

private extension DateFormatter {
    static let folderName: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH.mm"
        return f
    }()
}
