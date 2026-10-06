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
    let secure = role == "AXSecureTextField" || label(element, kAXSubroleAttribute) == "AXSecureTextField"
    let value = secure ? "[secure]" : label(element, kAXValueAttribute)
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
  output(["trusted": trusted, "locked": locked, "app": frontmost?.localizedName ?? "", "bundleId": frontmost?.bundleIdentifier ?? "", "pid": frontmost?.processIdentifier ?? 0])
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
  func checkedTarget() -> AXUIElement? {
    guard arguments.count > 2, let index = arguments.firstIndex(of: "--expect"), index + 1 < arguments.count,
          let data = arguments[index + 1].data(using: .utf8),
          let expected = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          expected["bundleId"] as? String == frontmost.bundleIdentifier,
          expected["pid"] as? Int == Int(frontmost.processIdentifier),
          let target = resolve(root, arguments[2]),
          expected["role"] as? String == label(target, kAXRoleAttribute),
          expected["title"] as? String == label(target, kAXTitleAttribute),
          expected["description"] as? String == label(target, kAXDescriptionAttribute) else { return nil }
    return target
  }
  switch action {
  case "snapshot":
    output(["app": frontmost.localizedName ?? "", "bundleId": frontmost.bundleIdentifier ?? "", "pid": frontmost.processIdentifier, "elements": snapshot(root)])
  case "click":
    guard let element = checkedTarget() else {
      output(["error": "The app or control changed. Inspect the current app again before clicking."])
      exit(1)
    }
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    output(["clicked": result == .success, "errorCode": result.rawValue])
    if result != .success { exit(1) }
  case "set":
    guard arguments.count > 3, let element = checkedTarget(), arguments[3].count <= 10000 else {
      output(["error": "The app or control changed. Inspect the current app again before entering text."])
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
