import Foundation

/// A short researched answer: a title, up to four paragraphs, and where it came from.
struct ResearchReport {
    var question: String
    var title: String
    var paragraphs: [String]
    var sources: [(title: String, url: URL)]

    /// Plain text, for him (and the phone's saved transcript).
    var plainText: String {
        ([title] + paragraphs).joined(separator: "\n\n")
    }
}

/// Looks things up on the web with a free, key-less search, then lets the local
/// model write it up. Both halves are open and unlimited, and the pages actually
/// used come back with the answer.
enum WebResearch {
    static let model = Brain.researchModel

    enum ResearchError: LocalizedError {
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .failed(let why): return "The research didn't come back: \(why.prefix(160))"
            }
        }
    }

    private static let instructions = """
    Research the question on the web and write a short, friendly report for a busy person. \
    First line: a plain title of under eight words. Then one to four short paragraphs (four at most), \
    leading with the direct answer, then the most useful details. Plain text only: no markdown, \
    no headings, no bullet lists, and no links or citations in the text.
    """

    static func research(_ question: String, context: String?) async throws -> ResearchReport {
        var input = question
        if let context, !context.isEmpty { input += "\n\nWhat's on the user's screen, for context: \(context)" }
        let (answer, cited) = try await Brain.research(input, instructions: instructions)

        var text = answer
        var sources: [(String, URL)] = cited
        // Drop inline citations like "([site.com](https://…))" and any stray markdown.
        text = text.replacingOccurrences(of: #"\s*\(\[[^\]]*\]\([^)]*\)\)"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s*\[https?://[^\]]*\]"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "#", with: "")
        let blocks = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let title = blocks.first else { throw ResearchError.failed("empty answer") }
        return ResearchReport(question: question, title: title, paragraphs: Array(blocks.dropFirst().prefix(4)),
                              sources: Array(sources.prefix(5)))
    }

    /// Removes tracking parameters the search tool adds.
    private static func clean(_ link: String) -> String {
        guard var parts = URLComponents(string: link) else { return link }
        parts.queryItems = parts.queryItems?.filter { $0.name != "utm_source" }
        if parts.queryItems?.isEmpty == true { parts.queryItems = nil }
        return parts.string ?? link
    }
}
