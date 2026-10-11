import Foundation

/// One small client for the free Gemini API.
///
/// Everything Buddy asks a model to do goes through here: the short-lived token
/// the phone uses for live voice, one-line text answers, research with Google
/// Search grounding, and transcribing recorded chunks. It needs one key — the
/// free one from aistudio.google.com/apikey — and nothing else in the app talks
/// to a model provider directly.
enum Gemini {
    static let apiBase = "https://generativelanguage.googleapis.com/v1beta"
    static let liveWebSocket = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

    /// All on the free tier. The live one is the speech-to-speech model the
    /// phone talks to; the rest answer text. Google renames these from time to
    /// time, so each has a fallback: if a model is gone, the next one is tried
    /// before anything is reported as broken.
    static let liveModel = "gemini-3.8-live"
    static let liveFallbacks = ["gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-preview-12-2025"]
    static let chatModel = "gemini-3.8-flash"
    static let textFallbacks = ["gemini-3.5-flash", "gemini-2.5-flash"]

    enum Failure: LocalizedError {
        case noKey
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .noKey:
                return "I need a free Gemini key. Add one under Voice Key (free Gemini) in the menu bar."
            case .failed(let why):
                return "Gemini wouldn't answer: \(why.prefix(160))"
            }
        }
    }

    static var key: String? { Keychain.get(.gemini) }

    // MARK: Live voice

    struct LiveToken {
        var value: String
        var expiresAt: Date
    }

    /// A one-shot credential for the phone's voice session, so the real key
    /// never leaves this Mac. Gemini calls these ephemeral tokens.
    static func liveToken(minutes: Int = 30) async throws -> LiveToken {
        guard let key else { throw Failure.noKey }
        let expires = Date().addingTimeInterval(TimeInterval(minutes * 60))
        var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1alpha/auth_tokens")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "uses": 1,
            "expireTime": ISO8601DateFormatter.buddy.string(from: expires)
        ])
        let json = try await post(request)
        guard let value = json["name"] as? String, !value.isEmpty else {
            throw Failure.failed("no token came back")
        }
        return LiveToken(value: value, expiresAt: expires)
    }

    // MARK: Text

    /// One answer, as a single string.
    static func answer(_ prompt: String, instructions: String, model: String = chatModel) async throws -> String {
        let body: [String: Any] = [
            "contents": [["role": "user", "parts": [["text": prompt]]]],
            "systemInstruction": ["parts": [["text": instructions]]],
            "generationConfig": ["temperature": 0.9, "maxOutputTokens": 400]
        ]
        let json = try await generate(model: model, body: body)
        return text(in: json) ?? ""
    }

    /// Research with Google's own search grounding: the answer comes back with
    /// the pages it used, which is what puts sources on his report card.
    static func research(_ prompt: String, instructions: String) async throws -> (text: String, sources: [(title: String, url: URL)]) {
        var body: [String: Any] = [
            "contents": [["role": "user", "parts": [["text": prompt]]]],
            "systemInstruction": ["parts": [["text": instructions]]],
            "generationConfig": ["temperature": 0.7, "maxOutputTokens": 1200],
            "tools": [["google_search": [:]]]
        ]
        var json: [String: Any]
        do {
            json = try await generate(model: researchModel, body: body)
        } catch let error as Gemini.Failure {
            // The same tool has been spelled google_search_retrieval, too.
            // Some surfaces call the same tool google_search_retrieval.
            guard case .failed(let why) = error, why.contains("400") else { throw error }
            body["tools"] = [["google_search_retrieval": [:]]]
            json = try await generate(model: researchModel, body: body)
        }
        var sources: [(String, URL)] = []
        for chunk in groundingChunks(in: json) {
            guard let link = chunk["uri"] as? String, let url = URL(string: link),
                  !sources.contains(where: { $0.1 == url }) else { continue }
            sources.append((chunk["title"] as? String ?? url.host() ?? link, url))
        }
        guard let answer = text(in: json), !answer.isEmpty else { throw Failure.failed("empty answer") }
        return (answer, Array(sources.prefix(5)))
    }

    /// Transcribes a recorded chunk with speaker labels and times.
    static func transcribe(_ audio: Data, mimeType: String = "audio/mp4") async throws -> [[String: Any]] {
        let prompt = """
        Transcribe this recording from a meeting or conversation on a Mac.
        Split it into turns: one entry each time the speaker changes, and when there is a long pause.
        Label the speakers A, B, C… in the order they first speak and keep each label with the same voice for the whole recording.
        Give the start and end of each turn in seconds from the beginning of the recording.
        Write exactly what was said, tidied only enough to drop filler like "um" — never summarise, paraphrase or translate.
        Ignore silence, music and background noise.
        """
        let body: [String: Any] = [
            "contents": [[
                "role": "user",
                "parts": [
                    ["text": prompt],
                    ["inlineData": ["mimeType": mimeType, "data": audio.base64EncodedString()]]
                ]
            ]],
            "generationConfig": [
                "temperature": 0.2,
                "responseMimeType": "application/json",
                // An object with one array inside: the friendliest shape for a
                // structured answer, and the parsing below accepts either.
                "responseSchema": [
                    "type": "object",
                    "properties": [
                        "turns": [
                            "type": "array",
                            "items": [
                                "type": "object",
                                "properties": [
                                    "speaker": ["type": "string", "description": "A, B, C…"],
                                    "start": ["type": "number", "description": "seconds from the start"],
                                    "end": ["type": "number", "description": "seconds from the start"],
                                    "text": ["type": "string"]
                                ],
                                "required": ["speaker", "start", "text"]
                            ]
                        ]
                    ],
                    "required": ["turns"]
                ]
            ]
        ]
        let json = try await generate(model: transcribeModel, body: body)
        guard let answer = text(in: json) else { return [] }
        let cleaned = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "```json", with: "")
            .replacingOccurrences(of: "```", with: "")
        guard let data = cleaned.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else { return [] }
        if let rows = parsed as? [[String: Any]] { return rows }
        if let object = parsed as? [String: Any], let rows = object["turns"] as? [[String: Any]] { return rows }
        return []
    }

    // MARK: The wire

    static func generate(model: String, body: [String: Any]) async throws -> [String: Any] {
        do {
            return try await generateOnce(model: model, body: body)
        } catch let error as Failure {
            guard case .failed(let why) = error, missingModel(why) else { throw error }
            for fallback in textFallbacks where fallback != model {
                NSLog("Buddy: \(model) is not available, trying \(fallback)")
                if let json = try? await generateOnce(model: fallback, body: body) { return json }
            }
            throw error
        }
    }

    /// True when the failure means "that model does not exist any more".
    private static func missingModel(_ why: String) -> Bool {
        let lowered = why.lowercased()
        return lowered.contains("404") || lowered.contains("not found") || lowered.contains("not_found")
            || lowered.contains("no longer available")
    }

    private static func generateOnce(model: String, body: [String: Any]) async throws -> [String: Any] {
        guard let key else { throw Failure.noKey }
        var request = URLRequest(url: URL(string: "\(apiBase)/models/\(model):generateContent")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let json = try await post(request)
        if let error = json["error"] as? [String: Any] {
            throw Failure.failed("\(error["code"] ?? 0) \(error["message"] as? String ?? "unknown error")")
        }
        return json
    }

    private static func post(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.failed("\(code) " + (String(data: data, encoding: .utf8) ?? "no answer"))
        }
        guard code == 200 else {
            let message = (json["error"] as? [String: Any])?["message"] as? String
            throw Failure.failed("\(code) " + (message ?? String(data: data, encoding: .utf8)?.prefix(160) ?? ""))
        }
        return json
    }

    // MARK: Reading the answer

    static func text(in json: [String: Any]) -> String? {
        let candidate = (json["candidates"] as? [[String: Any]])?.first
        let parts = (candidate?["content"] as? [String: Any])?["parts"] as? [[String: Any]]
        let joined = (parts ?? []).compactMap { $0["text"] as? String }.joined()
        let trimmed = joined.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func groundingChunks(in json: [String: Any]) -> [[String: Any]] {
        let candidate = (json["candidates"] as? [[String: Any]])?.first
        let metadata = candidate?["groundingMetadata"] as? [String: Any]
        return (metadata?["groundingChunks"] as? [[String: Any]] ?? []).compactMap { $0["web"] as? [String: Any] }
    }
}

private extension ISO8601DateFormatter {
    static let buddy: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
