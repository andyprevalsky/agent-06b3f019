// rose-passkey-import — native helper for Apple Credential Exchange import.
//
// Invoked by the Electron main process when macOS hands Rose a Credential
// Exchange import token (the user transferring passkeys from Apple Passwords).
// Calls ASCredentialImportManager.importCredentials(token:), extracts passkeys
// and basic-auth passwords, and prints JSON on stdout for the Electron side to
// encrypt + upload through the existing integrations ingestion paths.
//
// Usage: rose-passkey-import <import-token-uuid>
// Requires: macOS 26+. The production app uses the in-process native bridge for
// token redemption; this CLI remains a diagnostic wrapper around the same core.

import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("[rose-passkey-import] " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count >= 2, let token = UUID(uuidString: CommandLine.arguments[1]) else {
    fail("usage: rose-passkey-import <import-token-uuid>")
}

let sema = DispatchSemaphore(value: 0)
var exitCode: Int32 = 1

Task {
    do {
        let payload = try await importCredentialsPayload(token: token)
        let json = try JSONEncoder().encode(payload)
        FileHandle.standardOutput.write(json)
        exitCode = 0
    } catch {
        FileHandle.standardError.write(("[rose-passkey-import] import failed: \(error)\n").data(using: .utf8)!)
        exitCode = 2
    }
    sema.signal()
}
sema.wait()
exit(exitCode)
