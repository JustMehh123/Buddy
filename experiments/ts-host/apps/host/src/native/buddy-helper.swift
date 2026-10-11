// buddy-helper.swift
//
// Buddy's hands on macOS.
//
// A tiny command-line helper, compiled on first run by the host (Xcode's
// command line tools ship swiftc). It exists so Buddy doesn't need cliclick,
// yabai, Python+PyObjC or any other thing you'd have to install yourself.
//
// Build:  swiftc -O -o buddy-helper buddy-helper.swift
// Usage:  buddy-helper <command> [args...]
//
// Commands:
//   permissions                      is this process trusted to post events?
//   mouse-pos                        "x,y" of the real pointer
//   move <x> <y>                     warp the pointer
//   click <x> <y> [--double] [--right]
//   type <text>                      type text with the real keyboard
//   key <combo> [--repeat n]         e.g. cmd+shift+4, esc, enter, tab
//   active-window                    {"app":"...","title":"..."}
//   apps                             ["Mail", ...]
//   windows                          [{"app":..,"title":..,"x":..,"y":..,"w":..,"h":..}]
//   displays                         [{"id":..,"bounds":{..},"scale":..,"primary":..}]
//   clipboard-get
//   clipboard-set <text>

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ value: String) {
    FileHandle.standardOutput.write((value + "\n").data(using: .utf8)!)
}

func emitJSON(_ object: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
       let text = String(data: data, encoding: .utf8) {
        emit(text)
    } else {
        emit("null")
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
    fail("usage: buddy-helper <command> [args...]")
}
let rest = Array(arguments.dropFirst())

// ── Geometry ────────────────────────────────────────────────────────────────
// Everything uses CoreGraphics' top-left origin, which is what the screenshots
// and the pointer use, so no conversion is needed anywhere else.

func pointerLocation() -> CGPoint {
    if let event = CGEvent(source: nil) {
        return event.location
    }
    return .zero
}

// ── The main screen in points, for bounds clamping ──────────────────────────

func primaryScreen() -> NSScreen? {
    return NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main
}

func screenList() -> [[String: Any]] {
    var result: [[String: Any]] = []
    let primary = primaryScreen()
    let full = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }

    for (index, screen) in NSScreen.screens.enumerated() {
        let frame = screen.frame
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        // NSScreen is bottom-left; convert to the top-left space the pointer uses.
        let top = full.maxY - frame.maxY
        result.append([
            "id": number?.intValue ?? index + 1,
            "label": screen.localizedName,
            "bounds": [
                "x": Int(frame.origin.x.rounded()),
                "y": Int(top.rounded()),
                "width": Int(frame.width.rounded()),
                "height": Int(frame.height.rounded())
            ],
            "workArea": [
                "x": Int(frame.origin.x.rounded()),
                "y": Int(top.rounded()),
                "width": Int(frame.width.rounded()),
                "height": Int((frame.height - screen.visibleFrame.origin.y - 1).rounded())
            ],
            "scale": Double(screen.backingScaleFactor),
            "primary": screen == primary
        ])
    }
    return result
}

// ── Permissions ─────────────────────────────────────────────────────────────

func postEventAccess() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightPostEventAccess()
    }
    return AXIsProcessTrusted()
}

func accessibilityAccess() -> Bool {
    return AXIsProcessTrusted()
}

// ── Window / app info ───────────────────────────────────────────────────────

func frontmostApp() -> NSRunningApplication? {
    return NSWorkspace.shared.frontmostApplication
}

func windowTitle(for pid: pid_t) -> String? {
    let app = AXUIElementCreateApplication(pid)
    var window: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
          let focused = window else {
        // Fall back to the CG window list, which works without accessibility.
        return cgWindowTitle(pid: pid)
    }
    var title: CFTypeRef?
    guard AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
          let value = title as? String else {
        return cgWindowTitle(pid: pid)
    }
    return value
}

func cgWindowTitle(pid: pid_t) -> String? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for entry in list {
        if let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
           let name = entry[kCGWindowName as String] as? String, !name.isEmpty {
            return name
        }
    }
    return nil
}

func onScreenWindows() -> [[String: Any]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    let full = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
    var result: [[String: Any]] = []
    for entry in list {
        guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
        let owner = entry[kCGWindowOwnerName as String] as? String ?? "Unknown"
        let title = entry[kCGWindowName as String] as? String ?? ""
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        if layer != 0 { continue }
        if bounds.width < 80 || bounds.height < 80 { continue }
        let top = full.maxY - bounds.maxY
        result.append([
            "app": owner,
            "title": title,
            "x": Int(bounds.origin.x.rounded()),
            "y": Int(top.rounded()),
            "w": Int(bounds.width.rounded()),
            "h": Int(bounds.height.rounded())
        ])
    }
    return result
}

// ── Accessibility text search ───────────────────────────────────────────────
// Walks the focused window's element tree looking for nodes whose text matches
// the query, and reports each one's screen rect. Hard-capped so a huge document
// can't hang the helper.

func elementFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else {
        return nil
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
    AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    guard size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: position, size: size)
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    if let text = value as? String, !text.isEmpty { return text }
    // Some elements expose a rich text value with a string description.
    if let attributed = value as? NSAttributedString { return attributed.string }
    return nil
}

func collectText(from element: AXUIElement, query: String, into results: inout [[String: Any]], depth: Int) {
    if depth > 34 || results.count >= 400 { return }

    var candidates: [String] = []
    for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
        if let text = stringAttribute(element, attribute) { candidates.append(text) }
    }

    if let value = stringAttribute(element, kAXValueAttribute), !value.isEmpty, let frame = elementFrame(element) {
        let haystack = value.lowercased()
        if haystack.contains(query) {
            // Report the line's own rect, and a rough rect for the query inside it.
            let lineCount = max(1, value.components(separatedBy: "\n").count)
            var matched: CGRect = frame
            if lineCount > 1 {
                for (index, line) in value.components(separatedBy: "\n").enumerated() where line.lowercased().contains(query) {
                    let height = frame.height / CGFloat(lineCount)
                    matched = CGRect(x: frame.minX, y: frame.minY + CGFloat(index) * height, width: frame.width, height: height)
                    break
                }
            }
            results.append([
                "text": value.count > 300 ? String(value.prefix(300)) : value,
                "x": Int(matched.midX.rounded()),
                "y": Int(matched.midY.rounded()),
                "w": Int(matched.width.rounded()),
                "h": Int(matched.height.rounded()),
                "role": stringAttribute(element, kAXRoleAttribute) ?? "text"
            ])
        }
    }

    // Clickable controls are worth reporting by their label too.
    if let role = stringAttribute(element, kAXRoleAttribute),
       ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXLink"].contains(role),
       let frame = elementFrame(element) {
        let label = candidates.joined(separator: " ").lowercased()
        if !label.isEmpty, label.contains(query) {
            results.append([
                "text": candidates.first ?? role,
                "x": Int(frame.midX.rounded()),
                "y": Int(frame.midY.rounded()),
                "w": Int(frame.width.rounded()),
                "h": Int(frame.height.rounded()),
                "role": role
            ])
        }
    }

    var children: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
          let childElements = children as? [AXUIElement] else { return }
    for child in childElements {
        collectText(from: child, query: query, into: &results, depth: depth + 1)
    }
}

func collectControls(from element: AXUIElement, into controls: inout [[String: Any]], depth: Int) {
    if depth > 28 || controls.count >= 500 { return }
    if let role = stringAttribute(element, kAXRoleAttribute),
       ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXTextField", "AXTextArea", "AXLink", "AXMenuItem", "AXTab"].contains(role),
       let frame = elementFrame(element), frame.width > 8, frame.height > 8 {
        let label = [stringAttribute(element, kAXTitleAttribute),
                     stringAttribute(element, kAXDescriptionAttribute),
                     stringAttribute(element, kAXValueAttribute)]
            .compactMap { $0 }.first ?? ""
        controls.append([
            "role": role,
            "label": label.count > 120 ? String(label.prefix(120)) : label,
            "x": Int(frame.midX.rounded()),
            "y": Int(frame.midY.rounded()),
            "w": Int(frame.width.rounded()),
            "h": Int(frame.height.rounded())
        ])
    }
    var children: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
          let childElements = children as? [AXUIElement] else { return }
    for child in childElements {
        collectControls(from: child, into: &controls, depth: depth + 1)
    }
}

// ── Keyboard ────────────────────────────────────────────────────────────────

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27,
    "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33,
    "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "quote": 39,
    "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44, "n": 45,
    "m": 46, "period": 47, "tab": 48, "space": 49, "grave": 50, "delete": 51,
    "backspace": 51, "escape": 53, "esc": 53, "command": 55, "shift": 56, "capslock": 57,
    "option": 58, "alt": 58, "control": 59, "ctrl": 59, "rightshift": 60,
    "rightoption": 61, "rightcontrol": 62, "function": 63, "f17": 64, "volumeup": 72,
    "volumedown": 73, "mute": 74, "f18": 79, "f19": 80, "f20": 90, "f5": 96,
    "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103, "f13": 105,
    "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113, "help": 114,
    "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
    "left": 123, "leftarrow": 123, "rightarrow": 124, "right": 124, "down": 125,
    "downarrow": 125, "up": 126, "uparrow": 126
]

func flags(for names: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in names {
        switch name {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: break
        }
    }
    return flags
}

func pressKey(combo: String, repeatCount: Int) {
    let parts = combo.lowercased()
        .replacingOccurrences(of: " ", with: "")
        .split(separator: "+")
        .map(String.init)
    guard let keyName = parts.last, let code = keyCodes[keyName] else {
        fail("unknown key: \(combo)")
    }
    let modifierFlags = flags(for: Array(parts.dropLast()))

    for _ in 0..<max(1, repeatCount) {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        down?.flags = modifierFlags
        up?.flags = modifierFlags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        usleep(12000)
    }
}

func typeText(_ text: String) {
    // Post the string in small chunks; long single events get truncated.
    let chunkSize = 16
    let characters = Array(text)
    var index = 0
    while index < characters.count {
        let slice = Array(characters[index..<min(index + chunkSize, characters.count)])
        let string = String(slice)
        let utf16 = Array(string.utf16)
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
           let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
            utf16.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buffer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buffer.baseAddress!)
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        index += chunkSize
        usleep(15000)
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

switch command {
case "permissions":
    emitJSON(["postEvents": postEventAccess(), "accessibility": accessibilityAccess()])

case "mouse-pos":
    let point = pointerLocation()
    emit("\(Int(point.x.rounded())),\(Int(point.y.rounded()))")

case "move":
    guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
        fail("usage: move <x> <y>")
    }
    let target = CGPoint(x: x, y: y)
    // Warp instantly, then post a mouse-moved event so hover states update.
    CGWarpMouseCursorPosition(target)
    CGAssociateMouseAndMouseCursorPosition(1)
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
    emit("ok")

case "click":
    guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
        fail("usage: click <x> <y> [--double] [--right]")
    }
    let target = CGPoint(x: x, y: y)
    let double = rest.contains("--double")
    let right = rest.contains("--right")
    CGWarpMouseCursorPosition(target)
    usleep(30000)
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let button: CGMouseButton = right ? .right : .left
    let clicks = double ? 2 : 1
    for clickIndex in 0..<clicks {
        let clickState = Int64(clickIndex + 1)
        if let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: target, mouseButton: button),
           let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: target, mouseButton: button) {
            down.setIntegerValueField(.mouseEventClickState, value: clickState)
            up.setIntegerValueField(.mouseEventClickState, value: clickState)
            down.post(tap: .cghidEventTap)
            usleep(20000)
            up.post(tap: .cghidEventTap)
        }
        usleep(60000)
    }
    emit("ok")

case "type":
    guard let text = rest.first, !text.isEmpty else { fail("usage: type <text>") }
    typeText(text)
    emit("ok")

case "key":
    guard let combo = rest.first else { fail("usage: key <combo> [--repeat n]") }
    var repeatCount = 1
    if let index = rest.firstIndex(of: "--repeat"), index + 1 < rest.count, let value = Int(rest[index + 1]) {
        repeatCount = max(1, min(50, value))
    }
    pressKey(combo: combo, repeatCount: repeatCount)
    emit("ok")

case "active-window":
    guard let app = frontmostApp() else { emitJSON(["app": "Unknown", "title": ""]); break }
    let title = windowTitle(for: app.processIdentifier) ?? ""
    emitJSON(["app": app.localizedName ?? "Unknown", "title": title])

case "apps":
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { $0.localizedName }
    emitJSON(Array(Set(apps)).sorted())

case "windows":
    emitJSON(onScreenWindows())

case "ax-text":
    // Every line of text the Accessibility tree knows about, with its rect.
    // Free, instant, and far more precise than any vision model — this is what
    // makes "point at the chat that says X" land exactly on the right chat.
    guard let query = rest.first, !query.isEmpty else { fail("usage: ax-text <query>") }
    guard AXIsProcessTrusted() else {
        emitJSON([])
        break
    }
    var results: [[String: Any]] = []
    if let app = frontmostApp() {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        collectText(from: appElement, query: query.lowercased(), into: &results, depth: 0)
    }
    emitJSON(Array(results.prefix(40)))

case "ax-controls":
    guard AXIsProcessTrusted() else {
        emitJSON([])
        break
    }
    var controls: [[String: Any]] = []
    if let app = frontmostApp() {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        collectControls(from: appElement, into: &controls, depth: 0)
    }
    emitJSON(Array(controls.prefix(120)))

case "displays":
    emitJSON(screenList())

case "clipboard-get":
    emit(NSPasteboard.general.string(forType: .string) ?? "")

case "clipboard-set":
    guard let text = rest.first else { fail("usage: clipboard-set <text>") }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    emit("ok")

case "trust":
    // Ask macOS to show the Accessibility prompt for this binary.
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)
    emitJSON(["trusted": trusted])

default:
    fail("unknown command: \(command)")
}
