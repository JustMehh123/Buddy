import Foundation

/// Buddy's brain, running on your own machine.
///
/// He thinks with [Ollama](https://ollama.com) — an open-source (MIT) server
/// that runs open-weight models (Llama, Qwen, Gemma, Mistral and friends)
/// locally. There is no account, no key and no quota: the only limit is your
/// own hardware, so he is free, open source and effectively unlimited. Nothing
/// you say leaves the computer.
///
/// Ollama speaks the same `/v1/chat/completions` shape as everyone else, so
/// this one small client also works with any other OpenAI-compatible server
/// (LM Studio, llama.cpp's server, vLLM) — point `brainHost` at it and nothing
/// else changes.
enum Brain {
    // MARK: Configuration

    /// Where the model server lives. Defaults to a local Ollama.
    static var host: String {
        let defaults = UserDefaults.standard.string(forKey: "brainHost") ?? ""
        if !defaults.isEmpty { return normalize(defaults) }
        let environment = ProcessInfo.processInfo.environment
        if let custom = environment["BUDDY_OLLAMA_HOST"], !custom.isEmpty { return normalize(custom) }
        if let ollama = environment["OLLAMA_HOST"], !ollama.isEmpty { return normalize(ollama) }
        return "http://127.0.0.1:11434"
    }

    /// The model he chats and researches with. Any model you have pulled works.
    static var chatModel: String {
        let defaults = UserDefaults.standard.string(forKey: "brainModel") ?? ""
        if !defaults.isEmpty { return defaults }
        if let custom = ProcessInfo.processInfo.environment["BUDDY_MODEL"], !custom.isEmpty { return custom }
        return "llama3.2"
    }

    /// The OpenAI-compatible base URL (Ollama serves it under `/v1`).
    static var apiBase: String {
        let base = host.hasSuffix("/") ? String(host.dropLast()) : host
        return base.hasSuffix("/v1") ? base : base + "/v1"
    }

    /// A host typed as `127.0.0.1:11434` still gets a scheme.
    private static func normalize(_ value: String) -> String {
        var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") { return trimmed }
        trimmed = trimmed.replacingOccurrences(of: "0.0.0.0", with: "127.0.0.1")
        return "http://" + trimmed
    }

    enum Failure: LocalizedError {
        case unreachable(String)
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .unreachable(let why):
                return "I can't reach the model on your computer (\(why)). Check that Ollama is running: `ollama serve`."
            case .failed(let why):
                return "The model wouldn't answer: \(why.prefix(160))"
            }
        }
    }

    // MARK: Chat

    /// One answer, as a single string. `instructions` is his personality + tool rules.
    static func answer(_ prompt: String, instructions: String, model: String? = nil) async throws -> String {
        let messages: [[String: Any]] = [
            ["role": "system", "content": instructions],
            ["role": "user", "content": prompt],
        ]
        let (text, _) = try await chat(messages: messages, tools: nil, model: model ?? chatModel, temperature: 0.9)
        return text
    }

    /// The working call: messages in, text and any tool calls out (OpenAI shape).
    ///
    /// Tool calls come back exactly as the model emitted them — a list of
    /// `{id, type, function: {name, arguments}}` — so the caller can append them
    /// to the running conversation untouched.
    static func chat(messages: [[String: Any]], tools: [[String: Any]]?, model: String? = nil,
                     temperature: Double = 0.8) async throws -> (text: String, toolCalls: [[String: Any]]) {
        var body: [String: Any] = [
            "model": model ?? chatModel,
            "messages": messages,
            "temperature": temperature,
            "stream": false,
        ]
        if let tools, !tools.isEmpty {
            body["tools"] = tools
            body["tool_choice"] = "auto"
        }
        let json = try await post(path: "/chat/completions", body: body)
        if let error = json["error"] as? [String: Any] {
            throw Failure.failed("\(error["code"] ?? 0) \(error["message"] as? String ?? "unknown error")")
        }
        let choice = (json["choices"] as? [[String: Any]])?.first
        let message = choice?["message"] as? [String: Any]
        let calls = (message?["tool_calls"] as? [[String: Any]]) ?? []
        return (text(message?["content"]), calls)
    }

    /// The models this server actually has, for a status line and setup help.
    static func health() async -> (ok: Bool, detail: String) {
        do {
            let json = try await get(path: "/models")
            let models = ((json["data"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
            guard !models.isEmpty else {
                return (false, "The model server is running but has no models yet. Pull one: `ollama pull \(chatModel)`.")
            }
            let wanted = chatModel.split(separator: ":").first.map(String.init) ?? chatModel
            if models.contains(where: { $0 == chatModel || $0.hasPrefix(wanted) }) {
                return (true, "Using \(chatModel) on \(host)")
            }
            return (true, "Running \(models.count) models; \(chatModel) is not pulled yet. `ollama pull \(chatModel)`.")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    // MARK: Research

    /// The model used for research reports.
    static var researchModel: String { chatModel }

    /// Looks things up on the web, then asks the local model to write it up.
    ///
    /// There is no hosted "search grounding" to lean on, so the search itself is
    /// a plain, free, key-less DuckDuckGo lookup; the model only reads the
    /// snippets it is handed. Returns the report text and the pages it used.
    static func research(_ prompt: String, instructions: String) async throws -> (text: String, sources: [(title: String, url: URL)]) {
        let results = await WebSearch.search(prompt)
        var context = ""
        if results.isEmpty {
            context = "\n\n(You could not reach the web just now; answer from what you already know.)"
        } else {
            let listed = results.map { "- \($0.title) (\($0.url.absoluteString)): \($0.snippet)" }.joined(separator: "\n")
            context = "\n\nHere are web results to base your answer on. Do not invent anything beyond them:\n\(listed)"
        }
        let question = "\(prompt)\(context)"
        let answer = try await answer(question, instructions: instructions, model: researchModel)
        let sources = results.prefix(5).map { (title: $0.title, url: $0.url) }
        return (answer, Array(sources))
    }

    // MARK: Transcription (meeting notes)

    /// Transcribes a recorded chunk with a local Whisper model.
    ///
    /// Whisper is the free, open-source speech model, and running it here keeps
    /// the promise: nothing is uploaded. It needs the `whisper-cli` helper from
    /// whisper.cpp (`brew install whisper-cpp`) and a model file. If either is
    /// missing, the caller gets a plain-English explanation instead of a crash.
    static func transcribe(_ audio: Data, mimeType: String = "audio/mp4") async throws -> [[String: Any]] {
        guard let cli = whisperCLI() else {
            throw Failure.failed("Meeting-note transcription needs a local Whisper. Install it with `brew install whisper-cpp`, then pull a model.")
        }
        guard let model = whisperModel() else {
            throw Failure.failed("Whisper is installed but has no model. Download one (e.g. ggml-base.en.bin) into ~/Library/Application Support/Buddy/.")
        }

        let work = FileManager.default.temporaryDirectory.appendingPathComponent("buddy-whisper-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }

        let extensionName = mimeType.contains("wav") ? "wav" : mimeType.contains("mp3") ? "mp3" : "m4a"
        let source = work.appendingPathComponent("chunk.\(extensionName)")
        try audio.write(to: source)

        // whisper.cpp wants 16 kHz mono PCM; afconvert ships with macOS.
        let wav = work.appendingPathComponent("chunk.wav")
        _ = try? run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", source.path, wav.path])
        let input = FileManager.default.fileExists(atPath: wav.path) ? wav : source

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = ["-m", model, "-f", input.path, "-oj", "-of", work.appendingPathComponent("out").path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            throw Failure.failed("Whisper could not start: \(error.localizedDescription)")
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw Failure.failed("Whisper exited with status \(process.terminationStatus)")
        }

        let jsonURL = work.appendingPathComponent("out.json")
        guard let data = try? Data(contentsOf: jsonURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = root["transcription"] as? [[String: Any]] else {
            return []
        }
        // One turn per Whisper segment; it does not label speakers, so they all
        // start as "?" and the caller merges them into a single voice.
        return rows.compactMap { row in
            let text = (row["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let from = (row["offsets"] as? [String: Any])?["from"] as? Int ?? 0
            let to = (row["offsets"] as? [String: Any])?["to"] as? Int ?? from
            return ["speaker": "?", "start": Double(from) / 1000, "end": Double(to) / 1000, "text": text]
        }
    }

    private static func whisperCLI() -> String? {
        for candidate in ["whisper-cli", "whisper-cpp", "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"] {
            if candidate.hasPrefix("/") {
                if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
            } else if let path = which(candidate) {
                return path
            }
        }
        return nil
    }

    private static func whisperModel() -> String? {
        if let explicit = ProcessInfo.processInfo.environment["BUDDY_WHISPER_MODEL"],
           FileManager.default.fileExists(atPath: explicit) { return explicit }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Buddy", isDirectory: true)
        let names = ["ggml-base.en.bin", "ggml-base.bin", "ggml-small.en.bin"]
        for name in names {
            let url = support.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { return url.path }
        }
        return nil
    }

    private static func which(_ tool: String) -> String? {
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let path = "\(directory)/\(tool)"
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    private static func run(_ launchPath: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    // MARK: The wire

    static func post(path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let url = URL(string: apiBase + path) else { throw Failure.failed("bad address \(apiBase + path)") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 300
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private static func get(path: String) async throws -> [String: Any] {
        guard let url = URL(string: apiBase + path) else { throw Failure.failed("bad address") }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        return try await send(request)
    }

    private static func send(_ request: URLRequest) async throws -> [String: Any] {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.unreachable(error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let body = String(data: data, encoding: .utf8) ?? "no answer"
            throw Failure.failed("\(code) \(body.prefix(160))")
        }
        guard (200..<300).contains(code) else {
            let message = (json["error"] as? [String: Any])?["message"] as? String
            throw Failure.failed("\(code) " + (message ?? "request rejected"))
        }
        return json
    }

    /// Reads a chat message's `content`, which a server may send as a string or
    /// as a list of parts.
    static func text(_ content: Any?) -> String {
        if let string = content as? String { return string.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let parts = content as? [[String: Any]] {
            let joined = parts.compactMap { $0["text"] as? String }.joined()
            return joined.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ""
    }
}

/// A tiny, key-less web search: DuckDuckGo's HTML endpoint, parsed for the top
/// organic results. Free and unlimited in the same spirit as the rest of Buddy,
/// and only used to hand the local model something real to read.
enum WebSearch {
    struct Result {
        var title: String
        var url: URL
        var snippet: String
    }

    static func search(_ query: String, limit: Int = 6) async -> [Result] {
        var components = URLComponents(string: "https://html.duckduckgo.com/html/")
        components?.queryItems = [URLQueryItem(name: "q", value: query)]
        guard let url = components?.url else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        // DuckDuckGo serves the plain HTML page to a normal-looking client.
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let html = String(data: data, encoding: .utf8) else { return [] }
        return parse(html, limit: limit)
    }

    /// Pulls titles/urls and snippets out of the results page. Kept defensive:
    /// a layout change should mean "no results", never a crash.
    private static func parse(_ html: String, limit: Int) -> [Result] {
        let links = matches(html, #"<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
        let snippets = matches(html, #"<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#)
        var results: [Result] = []
        for (index, link) in links.enumerated() {
            guard index < limit, let url = resolve(link.0) else { continue }
            let title = clean(link.1)
            guard !title.isEmpty else { continue }
            let snippet = index < snippets.count ? clean(snippets[index].0) : ""
            results.append(Result(title: title, url: url, snippet: snippet))
        }
        return results
    }

    /// DuckDuckGo wraps links as `//duckduckgo.com/l/?uddg=<encoded>`; unwrap them.
    private static func resolve(_ href: String) -> URL? {
        var link = href
        if link.hasPrefix("//") { link = "https:" + link }
        guard let url = URL(string: link) else { return nil }
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let target = components.queryItems?.first(where: { $0.name == "uddg" })?.value,
           let unwrapped = URL(string: target) {
            return unwrapped
        }
        return url
    }

    private static func matches(_ html: String, _ pattern: String) -> [(String, String)] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
        let range = NSRange(html.startIndex..<html.endIndex, in: html)
        return regex.matches(in: html, range: range).compactMap { match in
            guard match.numberOfRanges > 2,
                  let first = Range(match.range(at: 1), in: html),
                  let second = Range(match.range(at: 2), in: html) else { return nil }
            return (String(html[first]), String(html[second]))
        }
    }

    /// Strips tags and decodes the handful of entities that show up in titles.
    private static func clean(_ fragment: String) -> String {
        var text = fragment.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        let entities = ["&amp;": "&", "&quot;": "\"", "&#x27;": "'", "&#39;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " "]
        for (entity, value) in entities { text = text.replacingOccurrences(of: entity, with: value) }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
