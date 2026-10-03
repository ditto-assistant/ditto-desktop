import AppKit
import ApplicationServices
import Foundation

func output(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
}

func attribute(_ element: AXUIElement, _ name: String) -> Any? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func windows(_ application: AXUIElement) -> [AXUIElement] {
  return attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
}

func label(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  return String(describing: value).prefix(200).description
}

func resolve(_ root: AXUIElement, _ reference: String) -> AXUIElement? {
  let parts = reference.split(separator: ".")
  guard let first = parts.first, first.first == "w", let index = Int(first.dropFirst()),
        index >= 0, index < windows(root).count else { return nil }
  var current = windows(root)[index]
  for part in parts.dropFirst() {
    guard let index = Int(part), index >= 0, index < children(current).count else { return nil }
    current = children(current)[index]
  }
  return current
}

func snapshot(_ root: AXUIElement) -> [[String: String]] {
  var result: [[String: String]] = []
  func visit(_ element: AXUIElement, _ reference: String, _ depth: Int) {
    if result.count >= 180 || depth > 6 { return }
    let role = label(element, kAXRoleAttribute)
    let value = role == "AXSecureTextField" ? "[secure]" : label(element, kAXValueAttribute)
    result.append(["ref": reference, "role": role, "title": label(element, kAXTitleAttribute),
                   "description": label(element, kAXDescriptionAttribute), "value": value])
    for (index, child) in children(element).enumerated() {
      visit(child, "\(reference).\(index)", depth + 1)
    }
  }
  for (index, window) in windows(root).prefix(5).enumerated() {
    visit(window, "w\(index)", 0)
  }
  return result
}

let arguments = CommandLine.arguments
let action = arguments.count > 1 ? arguments[1] : "status"
let frontmost = NSWorkspace.shared.frontmostApplication
let trusted = AXIsProcessTrusted()
let locked = frontmost?.bundleIdentifier == "com.apple.loginwindow"

if action == "status" {
  output(["trusted": trusted, "locked": locked, "app": frontmost?.localizedName ?? "", "bundleId": frontmost?.bundleIdentifier ?? ""])
} else if locked {
  output(["error": "Unlock this Mac before using computer control."])
  exit(1)
} else if action == "activate" {
  guard arguments.count > 2, let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == arguments[2] }) else {
    output(["error": "That app is not running."])
    exit(1)
  }
  output(["activated": app.activate(options: [])])
} else if !trusted {
  output(["error": "Give Ditto Desktop Accessibility permission in macOS Settings before using computer control."])
  exit(1)
} else if let frontmost {
  let root = AXUIElementCreateApplication(frontmost.processIdentifier)
  switch action {
  case "snapshot":
    output(["app": frontmost.localizedName ?? "", "bundleId": frontmost.bundleIdentifier ?? "", "elements": snapshot(root)])
  case "click":
    guard arguments.count > 2, let element = resolve(root, arguments[2]) else {
      output(["error": "Inspect the current app and use a listed element reference."])
      exit(1)
    }
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    output(["clicked": result == .success, "errorCode": result.rawValue])
    if result != .success { exit(1) }
  case "set":
    guard arguments.count > 3, let element = resolve(root, arguments[2]), arguments[3].count <= 10000 else {
      output(["error": "Inspect the current app and enter shorter text in a listed field."])
      exit(1)
    }
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, arguments[3] as CFTypeRef)
    output(["set": result == .success, "errorCode": result.rawValue])
    if result != .success { exit(1) }
  default:
    output(["error": "Unsupported computer action."])
    exit(1)
  }
} else {
  output(["error": "No app is active on this Mac."])
  exit(1)
}
