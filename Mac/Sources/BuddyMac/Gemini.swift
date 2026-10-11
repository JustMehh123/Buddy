import Foundation

/// One small client for the free Gemini API.
///
/// Everything Buddy asks a model to do goes through here: the short-lived token
/// the phone uses for live voice, one-line text answers, research with Google
/// Search grounding, and transcribing recorded chunks. It needs one key — the
/// free one from aistudio.google.com/apikey — and nothing else in the app talks
/// to a model provider directly.
///
/// Model IDs are chosen from the free tier and each has a fallback chain,
/// because Google renames and retires them regularly. Any of them can be
/// overridden without touching code:
///
///     BUDDY_LIVE_MODEL, BUDDY_CHAT_MODEL, BUDDY_RESEARCH_MODEL, BUDDY_TRANSCRIBE_MODEL
enum Gemini {
    /// Where Gemini lives. Overridable so a stand-in can answer in tests (and
    /// so an account behind a proxy is not stuck).
    static let host = ProcessInfo.processInfo.environment["BUDDY_GEMINI_BASE"]?
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        ?? "https://generativelanguage.googleapis.com"
    static let apiBase = "\(host)/v1beta"

    /// The constrained Live endpoint. Ephemeral tokens are validated against the
    /// configuration baked into them, which is why the phone can safely hold one.
    static let liveWebSocket =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"

    // MARK: Models

    /// Speech-to-speech, for the phone's voice session.
    static let liveModel = override("BUDDY_LIVE_MODEL") ?? "gemini-3.8-live"
    static let liveFallbacks = [
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-preview-12-2025",
    ]

    /// One-line spoken answers and general text. Every name here is on the
    /// published model list, and every one accepts text in and text out.
    static let chatModel = override("BUDDY_CHAT_MODEL") ?? "gemini-3.8-flash"
    static let chatFallbacks = ["gemini-3.6-flash", "gemini-2.5-flash"]

    /// Research, answered with Google Search grounding. These Flash models
    /// support the `google_search` tool, which is what makes a report card’s
    /// sources real rather than invented.
    static let researchModel = override("BUDDY_RESEARCH_MODEL") ?? "gemini-3.8-flash"
    static let researchFallbacks = ["gemini-3.6-flash", "gemini-2.5-flash"]

    /// Recorded audio into speaker-labelled turns.
    ///
    /// `gemini-3.5-transcribe` is the purpose-built one: audio in (up to an
    /// hour), text out, with speaker diarization and word timestamps — the two
    /// things meeting notes are made of. It is asked in its own dialect
    /// (`audioTranscriptionConfig`), not with a JSON schema: it does not do
    /// function calling or structured output.
    ///
    /// The Flash models are the safety net, and they are asked differently —
    /// their audio understanding plus a JSON schema. That is why `transcribe`
    /// below has two shapes rather than one.
    static let transcribeModel = override("BUDDY_TRANSCRIBE_MODEL") ?? "gemini-3.5-transcribe"
    static let transcribeFallbacks = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"]

    /// A model that wants the prompt-and-schema shape rather than the
    /// transcription config. Anything not named here is asked the documented
    /// transcription way.
    static func usesAudioTranscriptionConfig(_ model: String) -> Bool {
        model.contains("transcribe")
    }

    private static func override(_ name: String) -> String? {
        let value = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespaces)
        return (value?.isEmpty == false) ? value : nil
    }

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
        /// When messages on a session started with this token stop being accepted.
        var expiresAt: Date
        /// When it stops being possible to *start* a session with it. Short by
        /// design (a couple of minutes): tokens are minted right before use.
        var newSessionExpiresAt: Date
        var model: String
        /// True when the token carries its configuration, so a stolen one cannot
        /// be used to run a different model, voice or tool set.
        var constrained: Bool
    }

    /// A one-shot credential for the phone's voice session, so the real key never
    /// leaves this Mac. Gemini calls these ephemeral tokens.
    ///
    /// `setup` is the exact session the phone is allowed to run — the same JSON
    /// the page sends in its setup frame. Baking it into the token
    /// (`liveConnectConstraints`) means the token is only good for Buddy's own
    /// session shape.
    static func liveToken(setup: [String: Any]?,
                          model preferredModel: String? = nil,
                          minutes: Int = 30,
                          sessionWindowSeconds: Int = 150,
                          constrained: Bool = true) async throws -> LiveToken {
        guard let key else { throw Failure.noKey }
        let model = (preferredModel?.isEmpty == false) ? preferredModel! : liveModel
        let now = Date()
        let expires = now.addingTimeInterval(TimeInterval(minutes * 60))
        let window = now.addingTimeInterval(TimeInterval(sessionWindowSeconds))

        var payload: [String: Any] = [
            "uses": 1,
            "expireTime": iso(expires),
            "newSessionExpireTime": iso(window),
        ]
        if constrained, let setup {
            payload["liveConnectConstraints"] = [
                "model": "models/\(model)",
                "config": setup,
            ]
        }

        let json = try await createAuthToken(payload)
        guard let value = json["name"] as? String, !value.isEmpty else {
            throw Failure.failed("no token came back")
        }
        let newSession = (json["newSessionExpireTime"] as? String).flatMap(parseDate) ?? window
        let expiry = (json["expireTime"] as? String).flatMap(parseDate) ?? expires
        guard expiry > Date() else { throw Failure.failed("the token arrived already expired") }
        return LiveToken(value: value, expiresAt: expiry, newSessionExpiresAt: newSession,
                         model: model, constrained: constrained)
    }

    /// Creates an ephemeral token, on the version of the API that accepts them.
    ///
    /// Google's documented REST example uses `v1beta/auth_tokens`; some accounts
    /// and older surfaces only answer on `v1alpha`. Rather than guess, the newer
    /// one is tried first and a 404 steps down.
    private static func createAuthToken(_ payload: [String: Any]) async throws -> [String: Any] {
        guard let key else { throw Failure.noKey }
        var lastError: Error = Failure.failed("no token endpoint answered")
        for version in ["v1beta", "v1alpha"] {
            var request = URLRequest(url: URL(string: "\(host)/\(version)/auth_tokens")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 30
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
            do {
                return try await post(request)
            } catch let Failure.failed(why) {
                lastError = Failure.failed(why)
                guard why.contains("404") || missingModel(why) else { throw lastError }
                NSLog("Buddy: the ephemeral-token endpoint \(version) did not answer; trying the other version")
            }
        }
        throw lastError
    }

    // MARK: Text

    /// One answer, as a single string.
    static func answer(_ prompt: String, instructions: String, model: String? = nil) async throws -> String {
        let body: [String: Any] = [
            "contents": [["role": "user", "parts": [["text": prompt]]]],
            "systemInstruction": ["parts": [["text": instructions]]],
            "generationConfig": ["temperature": 0.9, "maxOutputTokens": 400],
        ]
        let json = try await generate(model: model ?? chatModel, fallbacks: chatFallbacks, body: body)
        return text(in: json) ?? ""
    }

    /// Research with Google's own search grounding: the answer comes back with
    /// the pages it used, which is what puts sources on his report card.
    static func research(_ prompt: String, instructions: String) async throws -> (text: String, sources: [(title: String, url: URL)]) {
        var body: [String: Any] = [
            "contents": [["role": "user", "parts": [["text": prompt]]]],
            "systemInstruction": ["parts": [["text": instructions]]],
            "generationConfig": ["temperature": 0.7, "maxOutputTokens": 1200],
            "tools": [["google_search": [:]]],
        ]
        let json = try await generate(model: researchModel, fallbacks: researchFallbacks, body: body) { why, _ in
            // The search tool has been spelled google_search_retrieval too, and a
            // model that will not take one may take the other.
            guard body["tools"] as? [[String: Any]] == [["google_search": [:]]] else { return nil }
            let lowered = why.lowercased()
            guard why.contains("400") || why.contains("404") || lowered.contains("not found")
                || lowered.contains("unsupported") || lowered.contains("unknown") else { return nil }
            var swapped = body
            swapped["tools"] = [["google_search_retrieval": [:]]]
            NSLog("Buddy: retrying research with the google_search_retrieval tool name")
            return swapped
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

    /// Recorded audio into speaker-labelled turns: `[[speaker, start, end, text]]`.
    ///
    /// Two shapes, because two kinds of model answer this:
    ///
    ///   gemini-3.5-transcribe — asked in its own dialect, with
    ///   `audioTranscriptionConfig.diarization`, and answered with speaker
    ///   labels and word offsets attached to each part.
    ///
    ///   the Flash models — asked the ordinary way, with a prompt and a JSON
    ///   schema, because they have no transcription config but do have audio
    ///   understanding and structured output.
    ///
    /// The first model that answers wins; a failure moves to the next shape
    /// rather than losing the recording.
    static func transcribe(_ audio: Data, mimeType: String = "audio/mp4") async throws -> [[String: Any]] {
        let chain = [transcribeModel] + transcribeFallbacks.filter { $0 != transcribeModel }
        var lastError: Error = Failure.failed("nothing was tried")

        for model in chain {
            do {
                let json = try await generateOnce(model: model, body: usesAudioTranscriptionConfig(model)
                    ? transcriptionBody(audio, mimeType: mimeType)
                    : promptBody(audio, mimeType: mimeType))
                let rows = usesAudioTranscriptionConfig(model)
                    ? rowsFromTranscription(json)
                    : rowsFromJson(json)
                if !rows.isEmpty {
                    if model != transcribeModel {
                        NSLog("Buddy: transcribed with \(model) rather than \(transcribeModel)")
                    }
                    return rows
                }
                lastError = Failure.failed("\(model) returned nothing usable")
            } catch let Failure.failed(why) {
                lastError = Failure.failed("\(model): \(why)")
                NSLog("Buddy: transcription with \(model) failed (\(why)); trying the next model")
            }
        }

        // Last try: the general path with the schema dropped, for a model that
        // answers in prose. A plain block of speech beats a lost recording.
        for model in transcribeFallbacks {
            do {
                var body = promptBody(audio, mimeType: mimeType)
                var config = (body["generationConfig"] as? [String: Any]) ?? [:]
                config.removeValue(forKey: "responseSchema")
                config.removeValue(forKey: "responseMimeType")
                body["generationConfig"] = config
                let json = try await generateOnce(model: model, body: body)
                let text = (self.text(in: json) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    NSLog("Buddy: transcribed with \(model) as plain text")
                    return [["speaker": "?", "start": 0, "end": 0, "text": text]]
                }
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// The documented shape: audio in, transcription options in, no prompt.
    private static func transcriptionBody(_ audio: Data, mimeType: String) -> [String: Any] {
        [
            "contents": [[
                "role": "user",
                "parts": [
                    ["inlineData": ["mimeType": mimeType, "data": audio.base64EncodedString()]],
                ],
            ]],
            "generationConfig": [
                // VERBATIM is the default and is *required* alongside
                // diarization and word timestamps — asking for the cleaned-up
                // SMART mode as well would be refused.
                "audioTranscriptionConfig": [
                    "diarization": true,
                    "wordTimestamp": true,
                ],
            ],
        ]
    }

    /// The general shape: a prompt and a JSON schema, for the Flash models.
    private static func promptBody(_ audio: Data, mimeType: String) -> [String: Any] {
        let prompt = """
        Transcribe this recording from a meeting or conversation on a Mac.
        Split it into turns: one entry each time the speaker changes, and when there is a long pause.
        Label the speakers A, B, C… in the order they first speak and keep each label with the same voice for the whole recording.
        Give the start and end of each turn in seconds from the beginning of the recording.
        Write exactly what was said, tidied only enough to drop filler like "um" — never summarise, paraphrase or translate.
        Ignore silence, music and background noise.
        """
        return [
            "contents": [[
                "role": "user",
                "parts": [
                    ["text": prompt],
                    ["inlineData": ["mimeType": mimeType, "data": audio.base64EncodedString()]],
                ],
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
                                    "text": ["type": "string"],
                                ],
                                "required": ["speaker", "start", "text"],
                            ],
                        ],
                    ],
                    "required": ["turns"],
                ],
            ],
        ]
    }

    /// `candidates[].content.parts[].audioTranscription` — speaker labels and
    /// word offsets — turned into turns.
    ///
    /// A new turn starts when the speaker changes, or after a gap of more than
    /// a second and a half, which is what a listener would hear as a breath.
    static func rowsFromTranscription(_ json: [String: Any]) -> [[String: Any]] {
        var rows: [[String: Any]] = []
        var speaker: String?
        var words: [String] = []
        var start = 0.0
        var end = 0.0

        func flush() {
            let said = words.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !said.isEmpty {
                rows.append(["speaker": speaker ?? "?", "start": start, "end": end, "text": said])
            }
            words = []
        }

        let candidates = json["candidates"] as? [[String: Any]] ?? []
        for candidate in candidates {
            let parts = (candidate["content"] as? [String: Any])?["parts"] as? [[String: Any]] ?? []
            for part in parts {
                guard let transcription = part["audioTranscription"] as? [String: Any] else { continue }
                let label = (transcription["speakerLabel"] as? String)?.trimmingCharacters(in: .whitespaces)
                    ?? speaker ?? "?"
                let spoken = transcription["words"] as? [[String: Any]] ?? []
                if spoken.isEmpty {
                    // Some answers carry the text without word annotations.
                    if let said = part["text"] as? String, !said.trimmingCharacters(in: .whitespaces).isEmpty {
                        flush()
                        speaker = label
                        words = [said]
                        start = end
                    }
                    continue
                }
                for word in spoken {
                    let text = (word["word"] as? String) ?? ""
                    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                    let began = seconds(word["startOffset"]) ?? end
                    let finished = seconds(word["endOffset"]) ?? began
                    if speaker != nil && (speaker != label || began - end > 1.5) { flush() }
                    if words.isEmpty { start = began }
                    speaker = label
                    end = finished
                    words.append(text.trimmingCharacters(in: .whitespaces))
                }
            }
        }
        flush()
        return rows
    }

    /// "0.100s" (the documented format) or a plain number, in seconds.
    static func seconds(_ value: Any?) -> Double? {
        if let number = value as? Double { return number }
        if let number = value as? Int { return Double(number) }
        guard let text = value as? String else { return nil }
        return Double(text.trimmingCharacters(in: CharacterSet(charactersIn: "sS ")))
    }

    /// A JSON answer from a Flash model, as turns.
    static func rowsFromJson(_ json: [String: Any]) -> [[String: Any]] {
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

    /// generateContent with a model fallback chain.
    ///
    /// `retryBody` is how a caller changes the request between attempts (a
    /// different tool name, a simpler schema). It is handed the failure and
    /// returns a new body — or nil to just move on to the next model.
    static func generate(model: String,
                         fallbacks: [String] = [],
                         body: [String: Any],
                         retryBody: ((String, Bool) -> [String: Any]?)? = nil) async throws -> [String: Any] {
        var chain = [model] + fallbacks.filter { $0 != model }
        var current = body
        var lastError: Error = Failure.failed("nothing was tried")
        var retriedShape = false

        while !chain.isEmpty {
            let name = chain.removeFirst()
            let isLast = chain.isEmpty
            do {
                return try await generateOnce(model: name, body: current)
            } catch let error as Failure {
                lastError = error
                guard case .failed(let why) = error else { throw error }
                // A request the model refuses on its own terms gets one chance to
                // be rephrased (once only, so a genuine mistake cannot loop).
                if !retriedShape, let changed = retryBody?(why, isLast) {
                    retriedShape = true
                    current = changed
                    chain.insert(name, at: 0)
                    continue
                }
                guard !isLast else { throw lastError }
                NSLog("Buddy: \(name) did not answer (\(why.prefix(90))); trying \(chain[0])")
            }
        }
        throw lastError
    }

    /// True when the failure means "that model does not exist any more".
    private static func missingModel(_ why: String) -> Bool {
        let lowered = why.lowercased()
        return lowered.contains("not found") || lowered.contains("not_found")
            || lowered.contains("no longer available") || lowered.contains("does not exist")
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

    // MARK: Dates

    private static func iso(_ date: Date) -> String { ISO8601DateFormatter.buddy.string(from: date) }

    private static func parseDate(_ text: String) -> Date? {
        ISO8601DateFormatter.buddy.date(from: text)
            ?? ISO8601DateFormatter.buddyFractional.date(from: text)
    }
}

private extension ISO8601DateFormatter {
    static let buddy: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Google sometimes echoes timestamps with milliseconds.
    static let buddyFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
