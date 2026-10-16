import AppKit
import Foundation

// LaunchServices gives the helper its own TCC identity. Credentials arrive on
// stdin rather than argv, and only the helper is restarted after a grant.
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let value = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let appPath = value["app"] as? String,
      let arguments = value["arguments"] as? [String],
      let environment = value["environment"] as? [String: String] else { exit(64) }
let config = NSWorkspace.OpenConfiguration()
config.activates = false
config.createsNewApplicationInstance = true
config.promptsUserIfNeeded = false
config.arguments = arguments
config.environment = environment
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: config) { app, error in
  if let app {
    let data = try! JSONSerialization.data(withJSONObject: ["pid": app.processIdentifier])
    FileHandle.standardOutput.write(data)
    exit(0)
  }
  FileHandle.standardError.write(Data("Ditto Computer Use could not launch.\n".utf8))
  exit(1)
}
RunLoop.main.run()
