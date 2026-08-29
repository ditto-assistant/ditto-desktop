import AppKit
import ApplicationServices
import Darwin
import Foundation

private let discordBundleIDs: Set<String> = [
    "com.hnc.Discord",
    "com.hnc.DiscordPTB",
    "com.hnc.DiscordCanary",
]

private struct HelperCommand: Decodable {
    let command: String
    let prompt: Bool?
    let actionId: String?
    let origin: String?
    let mode: String?
    let deepLink: String?
    let expectedTitle: String?
    let text: String?
    let timeoutMs: Int?
}

private struct StatusResponse: Encodable {
    let available: Bool
    let permission: String
    let detail: String
}

private struct ReplyResponse: Encodable {
    let actionId: String
    let origin: String
    let mode: String
    let outcome: String
    let permission: String
    let startedAt: String
    let completedAt: String
    let detail: String
    let sent: Bool
    let draftPrepared: Bool
    let duplicate: Bool
}

private let isoFormatter = ISO8601DateFormatter()

private func emit<T: Encodable>(_ value: T) -> Never {
    do {
        let data = try JSONEncoder().encode(value)
        FileHandle.standardOutput.write(data)
        exit(EXIT_SUCCESS)
    } catch {
        FileHandle.standardError.write(Data("Unable to encode helper result.\n".utf8))
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

private func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    (copyAttribute(element, attribute) as? Bool) ?? false
}

private func childElements(_ element: AXUIElement) -> [AXUIElement] {
    (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

private func normalizeTitle(_ value: String) -> String {
    var normalized = value
        .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .lowercased()
    normalized = normalized.replacingOccurrences(of: "send a message to ", with: "")
    normalized = normalized.replacingOccurrences(of: "message to ", with: "")
    normalized = normalized.replacingOccurrences(of: "message ", with: "")
    normalized = normalized.replacingOccurrences(of: "@", with: "")
    normalized = normalized.replacingOccurrences(of: "#", with: "")
    normalized = normalized.unicodeScalars.map { scalar in
        CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : " "
    }.reduce(into: "") { $0.append($1) }
    return normalized.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct ComposerMatch {
    let element: AXUIElement
    let descriptor: String
}

private func matchingComposers(in root: AXUIElement, expectedTitle: String) -> [ComposerMatch] {
    let expected = normalizeTitle(expectedTitle)
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var queueIndex = 0
    var visited = 0
    var matches: [ComposerMatch] = []

    while queueIndex < queue.count && visited < 20_000 {
        let (element, depth) = queue[queueIndex]
        queueIndex += 1
        visited += 1
        let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        if role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String) {
            let descriptors = [
                stringAttribute(element, kAXPlaceholderValueAttribute as CFString),
                stringAttribute(element, kAXDescriptionAttribute as CFString),
                stringAttribute(element, kAXHelpAttribute as CFString),
                stringAttribute(element, kAXTitleAttribute as CFString),
                stringAttribute(element, kAXValueAttribute as CFString),
            ].compactMap { $0 }
            if let descriptor = descriptors.first(where: { normalizeTitle($0) == expected }) {
                matches.append(ComposerMatch(element: element, descriptor: descriptor))
            }
        }
        if depth < 30 {
            queue.append(contentsOf: childElements(element).map { ($0, depth + 1) })
        }
    }
    return matches
}

private func discordApplication(
    deadline: Date,
    restoringFocusTo previousApplication: NSRunningApplication?
) -> NSRunningApplication? {
    while Date() < deadline {
        restore(previousApplication)
        if let app = NSWorkspace.shared.runningApplications.first(where: {
            guard let bundleIdentifier = $0.bundleIdentifier else { return false }
            return discordBundleIDs.contains(bundleIdentifier)
        }) {
            return app
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return nil
}

private func verifiedComposer(
    app: NSRunningApplication,
    expectedTitle: String,
    deadline: Date,
    restoringFocusTo previousApplication: NSRunningApplication?
) -> ComposerMatch? {
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    // Electron/Chromium can keep its renderer accessibility tree dormant until an
    // assistive client explicitly opts in. Computer Use does this automatically;
    // the standalone helper must do it before asking for Discord's windows.
    _ = AXUIElementSetAttributeValue(
        appElement,
        "AXManualAccessibility" as CFString,
        true as CFTypeRef
    )
    _ = AXUIElementSetAttributeValue(
        appElement,
        "AXEnhancedUserInterface" as CFString,
        true as CFTypeRef
    )
    while Date() < deadline {
        restore(previousApplication)
        let windows = (copyAttribute(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement]) ?? []
        let matches = windows.flatMap { matchingComposers(in: $0, expectedTitle: expectedTitle) }
        if matches.count == 1 {
            return matches[0]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    }
    return nil
}

private func supportsConfirm(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let actions = names as? [String]
    else { return false }
    return actions.contains(kAXConfirmAction as String)
}

private func performSend(_ composer: AXUIElement, application: AXUIElement) -> Bool {
    if supportsConfirm(composer) {
        return AXUIElementPerformAction(composer, kAXConfirmAction as CFString) == .success
    }
    guard AXUIElementSetAttributeValue(
        composer,
        kAXFocusedAttribute as CFString,
        true as CFTypeRef
    ) == .success,
          boolAttribute(composer, kAXFocusedAttribute as CFString)
    else { return false }
    let returnKeyCode: CGKeyCode = 36
    typealias PostKeyboardEvent = @convention(c) (
        AXUIElement,
        UInt16,
        CGKeyCode,
        UInt8
    ) -> AXError
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "AXUIElementPostKeyboardEvent")
    else { return false }
    let postKeyboardEvent = unsafeBitCast(symbol, to: PostKeyboardEvent.self)
    guard postKeyboardEvent(application, 0, returnKeyCode, 1) == .success else {
        return false
    }
    return postKeyboardEvent(application, 0, returnKeyCode, 0) == .success
}

private func composerValue(_ element: AXUIElement) -> String {
    (stringAttribute(element, kAXValueAttribute as CFString) ?? "")
        .replacingOccurrences(of: "\u{FEFF}", with: "")
        .replacingOccurrences(of: "\u{200B}", with: "")
}

private func restore(_ application: NSRunningApplication?) {
    guard let application, !application.isTerminated else { return }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier {
        return
    }
    application.activate(options: [.activateIgnoringOtherApps])
}

private func openInBackground(_ url: URL) -> Bool {
    guard let applicationURL = NSWorkspace.shared.urlForApplication(toOpen: url) else {
        return false
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    var completed = false
    var succeeded = false
    NSWorkspace.shared.open(
        [url],
        withApplicationAt: applicationURL,
        configuration: configuration
    ) { _, error in
        succeeded = error == nil
        completed = true
    }
    let deadline = Date().addingTimeInterval(2)
    while !completed && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    return completed && succeeded
}

private func execute(_ command: HelperCommand) -> ReplyResponse {
    let startedAt = isoFormatter.string(from: Date())
    let actionId = command.actionId ?? "invalid"
    let origin = command.origin ?? "local_desktop"
    let mode = command.mode ?? "prepare"
    func result(
        _ outcome: String,
        _ detail: String,
        sent: Bool = false,
        draftPrepared: Bool = false,
        permission: String = "granted"
    ) -> ReplyResponse {
        ReplyResponse(
            actionId: actionId,
            origin: origin,
            mode: mode,
            outcome: outcome,
            permission: permission,
            startedAt: startedAt,
            completedAt: isoFormatter.string(from: Date()),
            detail: detail,
            sent: sent,
            draftPrepared: draftPrepared,
            duplicate: false
        )
    }

    guard trusted(prompt: false) else {
        return result(
            "permission_required",
            "Allow Ditto's Discord helper in System Settings > Privacy & Security > Accessibility.",
            permission: "not_granted"
        )
    }
    guard let deepLink = command.deepLink,
          let url = URL(string: deepLink),
          url.scheme == "discord",
          url.host == "-",
          url.user == nil,
          url.password == nil,
          url.port == nil,
          url.query == nil,
          url.fragment == nil,
          let expectedTitle = command.expectedTitle,
          !normalizeTitle(expectedTitle).isEmpty,
          let text = command.text,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          text.count <= 4_000
    else {
        return result("target_not_verified", "The Discord target or draft did not pass validation.")
    }
    let path = url.pathComponents.filter { $0 != "/" }
    let snowflake = try? NSRegularExpression(pattern: "^[0-9]{15,24}$")
    func isSnowflake(_ value: String) -> Bool {
        guard let snowflake else { return false }
        return snowflake.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
    guard path.count == 3,
          path[0] == "channels",
          (path[1] == "@me" || isSnowflake(path[1])),
          isSnowflake(path[2])
    else {
        return result("target_not_verified", "The Discord deep link was rejected.")
    }

    let previousApplication = NSWorkspace.shared.frontmostApplication
    defer { restore(previousApplication) }
    guard openInBackground(url) else {
        return result("discord_unavailable", "Discord could not open the requested conversation.")
    }
    restore(previousApplication)
    let timeout = min(max(command.timeoutMs ?? 10_000, 1_000), 15_000)
    let deadline = Date().addingTimeInterval(Double(timeout) / 1_000)
    guard let discord = discordApplication(
        deadline: deadline,
        restoringFocusTo: previousApplication
    ) else {
        return result("discord_unavailable", "Discord did not become available before the action timed out.")
    }
    guard let match = verifiedComposer(
        app: discord,
        expectedTitle: expectedTitle,
        deadline: deadline,
        restoringFocusTo: previousApplication
    ) else {
        return result(
            "target_not_verified",
            "Ditto could not verify the exact Discord conversation composer. Nothing was typed."
        )
    }
    let discordElement = AXUIElementCreateApplication(discord.processIdentifier)

    _ = AXUIElementSetAttributeValue(
        match.element,
        kAXValueAttribute as CFString,
        text as CFTypeRef
    )
    let writeDeadline = min(deadline, Date().addingTimeInterval(1))
    while composerValue(match.element) != text && Date() < writeDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    }
    guard composerValue(match.element) == text else {
        return result("composer_not_found", "The verified Discord composer did not accept the draft.")
    }

    if mode == "prepare" {
        return result(
            "draft_prepared",
            "Draft prepared in the verified Discord conversation. Open Discord and press Enter to send.",
            draftPrepared: true
        )
    }
    guard mode == "send" else {
        return result(
            "draft_prepared",
            "The verified Discord draft was left ready instead of being sent.",
            draftPrepared: true
        )
    }
    guard performSend(match.element, application: discordElement) else {
        return result(
            "draft_prepared",
            "Discord rejected the Accessibility send action. The verified draft was left ready instead.",
            draftPrepared: true
        )
    }
    let confirmationDeadline = min(deadline, Date().addingTimeInterval(1.5))
    while Date() < confirmationDeadline {
        if composerValue(match.element).isEmpty {
            return result(
                "sent",
                "Discord cleared the verified composer after its Accessibility confirm action.",
                sent: true
            )
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return result(
        "send_not_confirmed",
        "Discord did not clear the composer, so Ditto cannot confirm that the message was sent.",
        draftPrepared: true
    )
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let command = try? JSONDecoder().decode(HelperCommand.self, from: inputData) else {
    FileHandle.standardError.write(Data("Invalid helper command.\n".utf8))
    exit(EXIT_FAILURE)
}

switch command.command {
case "status":
    let isTrusted = trusted(prompt: command.prompt ?? false)
    emit(StatusResponse(
        available: true,
        permission: isTrusted ? "granted" : "not_granted",
        detail: isTrusted
            ? "Ditto can prepare and send explicit Discord replies."
            : "Allow Ditto's Discord helper in System Settings > Privacy & Security > Accessibility."
    ))
case "execute":
    emit(execute(command))
default:
    FileHandle.standardError.write(Data("Unsupported helper command.\n".utf8))
    exit(EXIT_FAILURE)
}
