// rose-passkey-permission — request/inspect AutoFill credential-provider enablement.
//
// Invoked by Electron when the user clicks Sync Passkeys. On macOS 15+, this
// uses AuthenticationServices' first-party enablement prompt for the containing
// app's Credential Provider Extension instead of forcing System Settings to the
// front. On older supported macOS versions it opens the provider settings pane.

import Foundation
import AuthenticationServices

struct PermissionResult: Codable {
    let success: Bool
    let enabled: Bool
    let openedSettings: Bool
    let message: String?
}

func emit(_ result: PermissionResult) {
    do {
        let json = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(json)
    } catch {
        FileHandle.standardError.write("[rose-passkey-permission] failed to encode result\n".data(using: .utf8)!)
        exit(1)
    }
}

let sema = DispatchSemaphore(value: 0)

ASSettingsHelper.requestToTurnOnCredentialProviderExtension { enabled in
    emit(PermissionResult(
        success: true,
        enabled: enabled,
        openedSettings: false,
        message: nil
    ))
    sema.signal()
}

sema.wait()
