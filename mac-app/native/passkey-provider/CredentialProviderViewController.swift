// Minimal Credential Provider extension principal class.
//
// Its ONLY job is registration: declaring ProvidesPasskeys in Info.plist makes
// macOS list Rose as a credential manager (and thus a passkey-transfer
// destination). The actual Credential Exchange import is handled by the main
// app via the rose-passkey-import helper — this extension just needs to exist
// and satisfy the ASCredentialProviderViewController contract.
import AuthenticationServices
import AppKit

final class CredentialProviderViewController: ASCredentialProviderViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        NSLog("[RosePasskeyProvider] viewDidLoad")
    }

    override func prepareInterfaceForExtensionConfiguration() {
        NSLog("[RosePasskeyProvider] prepareInterfaceForExtensionConfiguration")
        // Nothing to configure; Rose manages credentials in its main app + backend.
        self.extensionContext.completeExtensionConfigurationRequest()
    }

    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        NSLog("[RosePasskeyProvider] prepareCredentialList services=\(serviceIdentifiers.count)")
        // Rose does not vault-fill on this device; cancel so the OS falls back.
        self.extensionContext.cancelRequest(
            withError: NSError(domain: ASExtensionErrorDomain,
                               code: ASExtensionError.userCanceled.rawValue))
    }
}
