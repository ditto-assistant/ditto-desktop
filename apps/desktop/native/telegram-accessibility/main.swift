import AppKit
import ApplicationServices
import Darwin
import Foundation

// Telegram Desktop exposes the semantic Accessibility tree used by this helper,
// but it must never be launched behind the user's back when the native macOS
// client is their installed Telegram application.
private let telegramDesktopBundleIDs = [
    // Direct build from desktop.telegram.org.
    "com.tdesktop.Telegram",
    "com.tdesktop.Telegram.beta",
    // Mac App Store / legacy Telegram Desktop builds.
    "org.telegram.desktop",
    "org.telegram.desktop.beta",
]
private let telegramMacBundleIDs = [
    "ru.keepcoder.Telegram",
    "ru.keepcoder.Telegram.beta",
]
private let telegramAccountId = "telegram:desktop:local"

private struct HelperCommand: Decodable {
    let command: String
    let prompt: Bool?
    let conversationId: String?
    let conversationTitle: String?
    let text: String?
    let idempotencyKey: String?
}

private struct Status: Encodable {
    let available: Bool
    let installed: Bool
    let permission: String
    let client: String
    let detail: String
}

private struct Participant: Encodable {
    let id: String
    let displayName: String
    let handle: String?
    let isSelf: Bool?
}

private struct Conversation: Encodable {
    let accountId = telegramAccountId
    let conversationId: String
    let service = "telegram"
    let title: String
    let kind: String
    let participants: [Participant]
    let position: Int
    let latestMessageAt: String?
    let unreadCount: Int?
    let completeness = "device_cache_partial"
}

private struct Message: Encodable {
    let accountId = telegramAccountId
    let conversationId: String
    let messageId: String
    let service = "telegram"
    let sender: Participant
    let text: String
    let sentAt: String
    let attachments: [String] = []
}

private struct Snapshot: Encodable {
    let available: Bool
    let installed: Bool
    let permission: String
    let client: String
    let detail: String
    let conversations: [Conversation]
    let messages: [String: [Message]]
}

private struct SendResult: Encodable {
    let sent: Bool
    let detail: String
    let message: Message?
}

private let isoFormatter = ISO8601DateFormatter()

private func emit<T: Encodable>(_ value: T) -> Never {
    do {
        FileHandle.standardOutput.write(try JSONEncoder().encode(value))
        exit(EXIT_SUCCESS)
    } catch {
        FileHandle.standardError.write(Data("Unable to encode Telegram helper response.\n".utf8))
        exit(EXIT_FAILURE)
    }
}

private func trusted(prompt: Bool) -> Bool {
    if prompt {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    copyAttribute(element, attribute) as? String
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

private struct AppTarget {
    let app: NSRunningApplication
    let client: String
}

private func runningTelegram(
    bundleIDs: [String],
    client: String
) -> AppTarget? {
    NSWorkspace.shared.runningApplications
        .first(where: { $0.bundleIdentifier.map(bundleIDs.contains) ?? false })
        .map { AppTarget(app: $0, client: client) }
}

private func runningTelegram() -> AppTarget? {
    runningTelegram(bundleIDs: telegramMacBundleIDs, client: "telegram-macos")
        ?? runningTelegram(bundleIDs: telegramDesktopBundleIDs, client: "telegram-desktop")
}

private func installedApplicationURL(bundleIDs: [String]) -> URL? {
    // LaunchServices can retain the path to a mounted Telegram installer after
    // the app has been copied to /Applications. Prefer a validated local app
    // bundle so a stale registration cannot make an installed client disappear.
    let fileManager = FileManager.default
    let candidateURLs = [
        URL(fileURLWithPath: "/Applications/Telegram.app"),
        fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true)
            .appendingPathComponent("Telegram.app", isDirectory: true),
    ]
    for url in candidateURLs where fileManager.fileExists(atPath: url.path) {
        if let bundleID = Bundle(url: url)?.bundleIdentifier, bundleIDs.contains(bundleID) {
            return url
        }
    }

    let workspace = NSWorkspace.shared
    for bundleID in bundleIDs {
        guard let url = workspace.urlForApplication(withBundleIdentifier: bundleID),
              fileManager.fileExists(atPath: url.path),
              Bundle(url: url)?.bundleIdentifier == bundleID
        else { continue }
        return url
    }
    return nil
}

private func installedTelegram() -> Bool {
    runningTelegram() != nil
        || installedApplicationURL(bundleIDs: telegramDesktopBundleIDs) != nil
        || installedApplicationURL(bundleIDs: telegramMacBundleIDs) != nil
}

private func preferredInstalledTelegramClient() -> String {
    if runningTelegram(bundleIDs: telegramMacBundleIDs, client: "telegram-macos") != nil
        || installedApplicationURL(bundleIDs: telegramMacBundleIDs) != nil
    {
        return "telegram-macos"
    }
    if runningTelegram(bundleIDs: telegramDesktopBundleIDs, client: "telegram-desktop") != nil
        || installedApplicationURL(bundleIDs: telegramDesktopBundleIDs) != nil
    {
        return "telegram-desktop"
    }
    return "none"
}

private func launchTelegramInBackground(
    bundleIDs: [String],
    client: String
) -> AppTarget? {
    if let running = runningTelegram(bundleIDs: bundleIDs, client: client) { return running }
    let workspace = NSWorkspace.shared
    guard let appURL = installedApplicationURL(bundleIDs: bundleIDs) else { return nil }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    var completed = false
    workspace.openApplication(at: appURL, configuration: configuration) { _, _ in completed = true }
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
        if let running = runningTelegram(bundleIDs: bundleIDs, client: client) { return running }
        if completed { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return runningTelegram(bundleIDs: bundleIDs, client: client)
}

private func launchTelegramInBackground() -> AppTarget? {
    // Respect the user's installed client. If Telegram for macOS is present,
    // do not silently launch Telegram Desktop merely because its Accessibility
    // tree is richer. A protocol bridge can provide local sync independently
    // of either UI; this helper must not choose a different Telegram app.
    if installedApplicationURL(bundleIDs: telegramMacBundleIDs) != nil
        || runningTelegram(bundleIDs: telegramMacBundleIDs, client: "telegram-macos") != nil
    {
        return launchTelegramInBackground(bundleIDs: telegramMacBundleIDs, client: "telegram-macos")
    }
    return launchTelegramInBackground(
        bundleIDs: telegramDesktopBundleIDs,
        client: "telegram-desktop"
    )
}

private func status(prompt: Bool) -> Status {
    let installed = installedTelegram()
    guard installed else {
        return Status(
            available: false,
            installed: false,
            permission: "unavailable",
            client: "none",
            detail: "Install and sign in to Telegram on this Mac first."
        )
    }
    guard trusted(prompt: prompt) else {
        return Status(
            available: false,
            installed: true,
            permission: "not_granted",
            client: preferredInstalledTelegramClient(),
            detail: "Allow Ditto's Telegram helper in System Settings > Privacy & Security > Accessibility."
        )
    }
    guard let target = launchTelegramInBackground() else {
        return Status(
            available: false,
            installed: true,
            permission: "granted",
            client: preferredInstalledTelegramClient(),
            detail: "Open Telegram once so Ditto can read its screen-reader view."
        )
    }
    if target.client == "telegram-macos" {
        return Status(
            available: false,
            installed: true,
            permission: "granted",
            client: target.client,
            detail: "Telegram for macOS is installed. Local sync needs the upcoming protocol bridge; Ditto will not open another Telegram client."
        )
    }
    return Status(
        available: true,
        installed: true,
        permission: "granted",
        client: target.client,
        detail: "Telegram chats are mirrored from the local screen-reader view."
    )
}

private func normalized(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func fnv(_ value: String) -> String {
    var hash: UInt64 = 1469598103934665603
    for byte in value.utf8 {
        hash ^= UInt64(byte)
        hash &*= 1099511628211
    }
    return String(hash, radix: 16)
}

private func nodeStrings(_ root: AXUIElement, maxDepth: Int = 6) -> [String] {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var index = 0
    var values: [String] = []
    var seen = Set<String>()
    while index < queue.count && index < 2_000 {
        let (element, depth) = queue[index]
        index += 1
        for attribute in [
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXValueAttribute,
            kAXHelpAttribute,
            kAXPlaceholderValueAttribute,
        ] {
            guard let raw = stringAttribute(element, attribute as CFString) else { continue }
            let value = normalized(raw)
            if !value.isEmpty && value.count <= 4_000 && seen.insert(value).inserted {
                values.append(value)
            }
        }
        if depth < maxDepth {
            queue.append(contentsOf: children(element).map { ($0, depth + 1) })
        }
    }
    return values
}

private func firstHandle(in values: [String]) -> String? {
    let pattern = try? NSRegularExpression(pattern: "(?:^|\\s)@([A-Za-z0-9_]{5,32})(?:$|\\s)")
    for value in values {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = pattern?.firstMatch(in: value, range: range),
              let capture = Range(match.range(at: 1), in: value)
        else { continue }
        return String(value[capture]).lowercased()
    }
    return nil
}

private func timestampValue(_ value: String) -> Bool {
    value.range(of: #"\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b"#, options: [.regularExpression, .caseInsensitive]) != nil
}

private let telegramMetadataCellTitles = Set([
    "auto-delete", "delivery", "dimensions", "draft", "edited", "forward",
    "link description", "link title", "media type", "mention", "message", "muted",
    "name", "pinned", "premium", "reactions", "seen", "sender", "time", "type",
    "unread", "verified", "warning", "website",
])

private func cleanTelegramText(_ value: String) -> String {
    normalized(
        value
            .replacingOccurrences(of: "\u{2068}", with: "")
            .replacingOccurrences(of: "\u{2069}", with: "")
            .replacingOccurrences(of: "\u{200e}", with: "")
            .replacingOccurrences(of: "\u{200f}", with: "")
    )
}

private func activeConversationTitle(in windows: [AXUIElement]) -> String? {
    for window in windows {
        guard let rawTitle = stringAttribute(window, kAXTitleAttribute as CFString) else { continue }
        let title = cleanTelegramText(rawTitle).replacingOccurrences(
            of: #"\s+[–—-]\s+\(\d+\)$"#,
            with: "",
            options: .regularExpression
        )
        if !title.isEmpty, title.caseInsensitiveCompare("Telegram") != .orderedSame {
            return title
        }
    }
    return nil
}

private struct ParsedTelegramMessage {
    let sender: String
    let body: String
    let isSelf: Bool?
}

private enum AccessibilityRegion {
    case unknown
    case chats
    case messages
}

private struct ParsedTelegramConversation {
    let title: String
    let kind: String
    let unreadCount: Int?
}

private func parsedTelegramConversation(_ values: [String]) -> ParsedTelegramConversation? {
    guard let source = values.max(by: { $0.count < $1.count }) else { return nil }
    let firstLine = source
        .components(separatedBy: .newlines)
        .map(cleanTelegramText)
        .first(where: { !$0.isEmpty }) ?? ""
    var components = firstLine.split(separator: ",", omittingEmptySubsequences: true)
        .map { normalized(String($0)) }
    guard !components.isEmpty else { return nil }
    let kindLabels = Set(["bot", "channel", "group"])
    let first = components.removeFirst()
    let kind = first.caseInsensitiveCompare("group") == .orderedSame ? "group" : "direct"
    let title = kindLabels.contains(first.lowercased()) ? (components.first ?? "") : first
    guard !title.isEmpty,
          title.count <= 200,
          !telegramMetadataCellTitles.contains(title.lowercased())
    else { return nil }

    let unreadPattern = try? NSRegularExpression(
        pattern: #"\b(\d{1,4})\s+new messages?\b"#,
        options: [.caseInsensitive]
    )
    let range = NSRange(source.startIndex..<source.endIndex, in: source)
    let unreadCount: Int?
    if let match = unreadPattern?.firstMatch(in: source, range: range),
       let capture = Range(match.range(at: 1), in: source)
    {
        unreadCount = Int(source[capture])
    } else {
        unreadCount = nil
    }
    return ParsedTelegramConversation(title: title, kind: kind, unreadCount: unreadCount)
}

private func parsedTelegramMessage(_ values: [String]) -> ParsedTelegramMessage? {
    guard let source = values
        .filter({ timestampValue($0) })
        .max(by: { $0.count < $1.count })
    else { return nil }

    var lines = source
        .components(separatedBy: .newlines)
        .map(cleanTelegramText)
        .filter { !$0.isEmpty }
    guard let timestampIndex = lines.lastIndex(where: timestampValue), timestampIndex > 0 else {
        return nil
    }
    lines = Array(lines[..<timestampIndex])
    guard !lines.isEmpty else { return nil }

    let accessibilityPrefix = "Secondary Actions: Raise, "
    if lines[0].hasPrefix(accessibilityPrefix) {
        lines[0].removeFirst(accessibilityPrefix.count)
    }
    let metadataPrefixes = ["Reactions:", "Pinned", "Received ", "Sent "]
    lines.removeAll { line in
        metadataPrefixes.contains(where: line.hasPrefix)
    }
    guard !lines.isEmpty else { return nil }

    var isSelf: Bool?
    var sender = lines.removeFirst()
    if sender.caseInsensitiveCompare("Seen") == .orderedSame,
       lines.first?.caseInsensitiveCompare("Me") == .orderedSame
    {
        sender = lines.removeFirst()
        isSelf = true
    } else if sender.caseInsensitiveCompare("Me") == .orderedSame {
        isSelf = true
    }
    let body = lines.joined(separator: "\n")
    guard !sender.isEmpty, !body.isEmpty else { return nil }
    return ParsedTelegramMessage(sender: sender, body: body, isSelf: isSelf)
}

private func selectedConversation(
    conversations: [Conversation],
    composerStrings: [String]
) -> Conversation? {
    let composerText = composerStrings.joined(separator: " ").lowercased()
    return conversations
        .filter { composerText.contains($0.title.lowercased()) }
        .max { $0.title.count < $1.title.count }
}

private func snapshot() -> Snapshot {
    let current = status(prompt: false)
    guard current.available, let target = runningTelegram() else {
        return Snapshot(
            available: current.available,
            installed: current.installed,
            permission: current.permission,
            client: current.client,
            detail: current.detail,
            conversations: [],
            messages: [:]
        )
    }

    let appElement = AXUIElementCreateApplication(target.app.processIdentifier)
    let windows = (copyAttribute(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement]) ?? []
    var queue = windows.flatMap { children($0).map { ($0, 0, AccessibilityRegion.unknown) } }
    var index = 0
    var conversations: [Conversation] = []
    var messageCandidates: [[String]] = []
    var composerStrings: [String] = []
    var seenConversations = Set<String>()
    var seenMessageCandidates = Set<String>()

    if let title = activeConversationTitle(in: windows) {
        let id = "title:\(fnv(title.lowercased()))"
        seenConversations.insert(id)
        conversations.append(
            Conversation(
                conversationId: id,
                title: title,
                kind: "group",
                participants: [],
                position: conversations.count,
                latestMessageAt: nil,
                unreadCount: nil
            )
        )
    }

    while index < queue.count && index < 20_000 {
        let (element, depth, inheritedRegion) = queue[index]
        index += 1
        let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        var region = inheritedRegion
        if role == (kAXListRole as String) {
            let listLabel = nodeStrings(element, maxDepth: 0).joined(separator: " ").lowercased()
            if listLabel.contains("messages") {
                region = .messages
            } else if listLabel.contains("chats") {
                region = .chats
            }
        }
        if role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String) {
            let values = nodeStrings(element, maxDepth: 0)
            if values.contains(where: { $0.range(of: "message", options: .caseInsensitive) != nil }) {
                composerStrings.append(contentsOf: values)
            }
        }
        if region == .chats,
           role == (kAXRowRole as String)
            || role == (kAXCellRole as String)
            || role == (kAXStaticTextRole as String)
        {
            let values = nodeStrings(element)
            if let parsed = parsedTelegramConversation(values)
            {
                let handle = firstHandle(in: values)
                let id = handle.map { "username:\($0)" } ?? "title:\(fnv(parsed.title.lowercased()))"
                if seenConversations.insert(id).inserted {
                    conversations.append(
                        Conversation(
                            conversationId: id,
                            title: parsed.title,
                            kind: parsed.kind,
                            participants: [
                                Participant(
                                    id: handle ?? id,
                                    displayName: parsed.title,
                                    handle: handle,
                                    isSelf: false
                                ),
                            ],
                            position: conversations.count,
                            latestMessageAt: nil,
                            unreadCount: parsed.unreadCount
                        )
                    )
                }
            }
        }
        if region == .messages, role == (kAXGroupRole as String) {
            let values = nodeStrings(element, maxDepth: 3)
            let candidateId = fnv(values.joined(separator: "|"))
            if values.count >= 3,
               values.contains(where: timestampValue),
               seenMessageCandidates.insert(candidateId).inserted
            {
                messageCandidates.append(values)
            }
        }
        if region == .messages, role == (kAXStaticTextRole as String) {
            let values = nodeStrings(element, maxDepth: 0)
            let candidateId = fnv(values.joined(separator: "|"))
            if parsedTelegramMessage(values) != nil,
               seenMessageCandidates.insert(candidateId).inserted
            {
                messageCandidates.append(values)
            }
        }
        if depth < 30 {
            queue.append(contentsOf: children(element).map { ($0, depth + 1, region) })
        }
    }

    var messagesByConversation: [String: [Message]] = [:]
    if let activeTitle = activeConversationTitle(in: windows),
       let active = conversations.first(where: { $0.title == activeTitle })
        ?? selectedConversation(conversations: conversations, composerStrings: composerStrings)
    {
        let candidates = messageCandidates.suffix(500)
        let baseDate = Date().addingTimeInterval(-Double(candidates.count))
        for (candidateIndex, values) in candidates.enumerated() {
            guard let parsed = parsedTelegramMessage(values) else { continue }
            let sender = Participant(
                id: fnv(parsed.sender.lowercased()),
                displayName: parsed.sender,
                handle: firstHandle(in: values),
                isSelf: parsed.isSelf
            )
            let message = Message(
                conversationId: active.conversationId,
                messageId: "ax:\(fnv(values.joined(separator: "|")))",
                sender: sender,
                text: parsed.body,
                sentAt: isoFormatter.string(
                    from: baseDate.addingTimeInterval(Double(candidateIndex))
                )
            )
            messagesByConversation[active.conversationId, default: []].append(message)
        }
    }
    return Snapshot(
        available: true,
        installed: true,
        permission: "granted",
        client: target.client,
        detail: "Telegram chats are mirrored from the local screen-reader view.",
        conversations: Array(conversations.prefix(200)),
        messages: messagesByConversation.mapValues { Array($0.suffix(500)) }
    )
}

private func openInBackground(_ url: URL, with app: NSRunningApplication) -> Bool {
    // Do not use the system's default tg: handler here. Users may keep the
    // native Telegram for macOS client installed alongside Telegram Desktop,
    // and the default handler can point at the unsupported native client.
    guard let appURL = app.bundleURL else { return false }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    var completed = false
    var succeeded = false
    NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration) { _, error in
        succeeded = error == nil
        completed = true
    }
    let deadline = Date().addingTimeInterval(3)
    while !completed && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    return completed && succeeded
}

private func matchingComposer(app: NSRunningApplication, expectedTitle: String) -> AXUIElement? {
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    let deadline = Date().addingTimeInterval(6)
    while Date() < deadline {
        let windows = (copyAttribute(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement]) ?? []
        var matches: [AXUIElement] = []
        for window in windows {
            var queue: [(AXUIElement, Int)] = [(window, 0)]
            var index = 0
            while index < queue.count && index < 20_000 {
                let (element, depth) = queue[index]
                index += 1
                let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
                if role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String) {
                    let values = nodeStrings(element, maxDepth: 0).joined(separator: " ").lowercased()
                    if values.contains("message") && values.contains(expectedTitle.lowercased()) {
                        matches.append(element)
                    }
                }
                if depth < 30 {
                    queue.append(contentsOf: children(element).map { ($0, depth + 1) })
                }
            }
        }
        if matches.count == 1 { return matches[0] }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    }
    return nil
}

private func executeSend(_ command: HelperCommand) -> SendResult {
    guard trusted(prompt: false) else {
        return SendResult(sent: false, detail: "Accessibility permission is required.", message: nil)
    }
    guard let target = runningTelegram(), target.client == "telegram-desktop" else {
        return SendResult(
            sent: false,
            detail: "Verified local sends require Telegram Desktop 6.9 or newer.",
            message: nil
        )
    }
    guard let id = command.conversationId,
          id.hasPrefix("username:"),
          let title = command.conversationTitle,
          let text = command.text?.trimmingCharacters(in: .whitespacesAndNewlines),
          !text.isEmpty,
          text.count <= 4_000
    else {
        return SendResult(
            sent: false,
            detail: "This Telegram chat has no verified public username, so Ditto left it untouched.",
            message: nil
        )
    }
    let username = String(id.dropFirst("username:".count))
    guard username.range(of: #"^[A-Za-z0-9_]{5,32}$"#, options: .regularExpression) != nil,
          let deepLink = URL(string: "tg://resolve?domain=\(username)"),
          openInBackground(deepLink, with: target.app),
          let composer = matchingComposer(app: target.app, expectedTitle: title)
    else {
        return SendResult(
            sent: false,
            detail: "Ditto could not verify the exact Telegram composer. Nothing was typed.",
            message: nil
        )
    }
    guard AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFTypeRef) == .success else {
        return SendResult(sent: false, detail: "The verified Telegram composer rejected the draft.", message: nil)
    }
    guard AXUIElementPerformAction(composer, kAXConfirmAction as CFString) == .success else {
        return SendResult(
            sent: false,
            detail: "Telegram left the verified draft ready, but Ditto could not confirm send.",
            message: nil
        )
    }
    let sender = Participant(id: "self", displayName: "You", handle: nil, isSelf: true)
    let message = Message(
        conversationId: id,
        messageId: "local:\(command.idempotencyKey ?? UUID().uuidString)",
        sender: sender,
        text: text,
        sentAt: isoFormatter.string(from: Date())
    )
    return SendResult(sent: true, detail: "Sent through the verified Telegram composer.", message: message)
}

guard CommandLine.arguments.count == 2,
      let payload = Data(base64Encoded: CommandLine.arguments[1]
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
        .padding(toLength: ((CommandLine.arguments[1].count + 3) / 4) * 4, withPad: "=", startingAt: 0)),
      let command = try? JSONDecoder().decode(HelperCommand.self, from: payload)
else {
    FileHandle.standardError.write(Data("Expected one base64url JSON command.\n".utf8))
    exit(EXIT_FAILURE)
}

switch command.command {
case "status": emit(status(prompt: command.prompt ?? false))
case "snapshot": emit(snapshot())
case "send": emit(executeSend(command))
default:
    FileHandle.standardError.write(Data("Unknown Telegram helper command.\n".utf8))
    exit(EXIT_FAILURE)
}
