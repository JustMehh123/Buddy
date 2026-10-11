#!/usr/bin/env python3
"""
Catches undefined members in the Mac sources.

    python3 tools/check-symbols.py        (from the repository root)

There is no Swift compiler in most places this runs, so this is a stand-in: it
collects every type, member and function the project declares, then checks the
`Type.member` references the code makes to its own types. That is enough to
catch the mistake it was written for — a constant that is used but never
declared, which a syntax-only check sails straight past and which only shows up
as a compile error on someone else's machine.

It is a heuristic, not a compiler: it knows about nesting and brace scopes, and
it ignores string literals and comments. Anything it cannot be sure about is
skipped rather than reported, so a clean run means "nothing obviously missing"
— the real proof is still `swift build`.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted((ROOT / "Mac" / "Sources").rglob("*.swift"))

# Types we do not own: platform and stdlib names whose members we cannot see.
EXTERNAL = {
    "Foundation", "Swift", "AppKit", "Network", "Carbon", "BuddyShared", "NSAlert", "NSMenu", "NSPanel",
    "URLSession", "URLRequest", "URL", "FileManager", "Date", "DateFormatter", "ISO8601DateFormatter",
    "JSONSerialization", "UserDefaults", "DispatchQueue", "DispatchWorkItem", "Timer", "RunLoop",
    "NSScreen", "NSWorkspace", "NSApp", "NSImage", "NSColor", "NSEvent", "NSBezierPath", "NSGradient",
    "NSStatusBar", "NSSound", "NSHostingView", "NSTextView", "NSScrollView", "CGRect",
    "CGPoint", "CGSize", "CACurrentMediaTime", "NWListener", "NWConnection", "NWParameters",
    "NSNotificationCenter", "NSApplication", "ProcessInfo", "String", "Array",
    "Dictionary", "Set", "Double", "Int", "Bool", "Data", "Character", "Result", "Optional", "Task",
    "URLComponents", "NSAttributedString", "NSFont", "AXUIElement", "CGEvent", "CGFloat",
    "CGPreflightScreenCaptureAccess", "CGRequestScreenCaptureAccess", "NSPasteboard", "NSRunningApplication",
    "AVAudioEngine", "MainActor", "NSObject", "NSView", "NSWindow", "CATransaction", "CALayer",
    "NSApplicationDelegate", "NSMenuDelegate", "Comparable", "Codable", "Equatable", "Hashable",
}

# Members the compiler synthesises, which have no declaration to find.
SYNTHESISED = {"allCases", "rawValue", "init", "hashValue", "description", "debugDescription",
               "self", "Type", "Error", "default", "some", "none", "max", "min", "zero", "identity"}

TYPE_RE = re.compile(r"^\s*(?:public\s+|final\s+|private\s+|internal\s+|fileprivate\s+|open\s+)*"
                     r"(?:enum|struct|class|actor|extension|protocol)\s+(\w+)")
MEMBER_RE = re.compile(r"^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|static\s+|final\s+|override\s+|"
                       r"lazy\s+|weak\s+|nonisolated\s+|@\w+(?:\([^)]*\))?\s+)*"
                       r"(?:static\s+)?(?:let|var|func)\s+(\w+)")
CASE_LINE_RE = re.compile(r"^\s*(?:indirect\s+)?case\s+(.+)$")
REFERENCE_RE = re.compile(r"\b([A-Z]\w+)\.([a-zA-Z_]\w*)\b")


def strip_literals_and_comments(line: str) -> str:
    """Blank out string literals and trailing comments so they are not scanned."""
    out = []
    index = 0
    in_string = False
    while index < len(line):
        character = line[index]
        if in_string:
            if character == "\\":
                index += 2
                continue
            if character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            out.append(" ")
            index += 1
            continue
        if character == "/" and index + 1 < len(line) and line[index + 1] == "/" and not (index and line[index - 1] == ":"):
            break
        out.append(character)
        index += 1
    return "".join(out)


def declarations(text: str):
    """Every type and its members, following brace scopes so nesting works."""
    types: dict[str, set[str]] = {}
    # (name, depth at which its body opened)
    scope: list[tuple[str | None, int]] = [(None, 0)]
    depth = 0

    for raw in text.splitlines():
        line = strip_literals_and_comments(raw)
        name = scope[-1][0]

        match = TYPE_RE.match(line)
        if match:
            opened = match.group(1)
            types.setdefault(opened, set())
            depth += line.count("{") - line.count("}")
            scope.append((opened, depth))
            name = opened
            continue

        if name:
            member = MEMBER_RE.match(line)
            if member:
                types[name].add(member.group(1))
            case = CASE_LINE_RE.match(line)
            if case:
                for piece in case.group(1).split(","):
                    label = piece.strip().split("(")[0].split("=")[0].strip()
                    if label and re.fullmatch(r"\w+", label):
                        types[name].add(label)

        depth += line.count("{") - line.count("}")
        while len(scope) > 1 and depth < scope[-1][1]:
            scope.pop()

    return types


def main() -> int:
    contents: dict[str, str] = {}
    decls: dict[str, set[str]] = {}

    for path in SOURCES:
        text = path.read_text(encoding="utf-8")
        contents[path.name] = text
        for owner, members in declarations(text).items():
            decls.setdefault(owner, set()).update(members)

    owned = set(decls)
    problems: list[str] = []

    for name, text in sorted(contents.items()):
        for number, raw in enumerate(text.splitlines(), 1):
            if raw.lstrip().startswith(("//", "///", "*")):
                continue
            line = strip_literals_and_comments(raw)
            for owner, member in REFERENCE_RE.findall(line):
                if owner in EXTERNAL or owner not in owned:
                    continue
                if MEMBER_RE.match(line) and re.search(rf"\b(?:let|var|func)\s+{re.escape(member)}\b", line):
                    continue  # the declaration itself
                if member[0].isupper():
                    continue  # nested type: Foo.Bar
                if member in SYNTHESISED:
                    continue  # provided by the compiler
                if member not in decls[owner]:
                    # `Type.case` for a case declared in an enum extension etc.
                    problems.append(f"{name}:{number}  {owner}.{member} — not declared in {owner}")

    print(f"checked {len(contents)} files, {len(owned)} types, "
          f"{sum(len(v) for v in decls.values())} members")
    if problems:
        print(f"\n{len(problems)} undefined member reference(s):")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("no undefined members")
    return 0


if __name__ == "__main__":
    sys.exit(main())
