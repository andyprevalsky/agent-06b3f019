import AuthenticationServices
import Foundation

struct OutPasskey: Codable {
    let rpId: String
    let credentialId: String
    let privateKey: String
    let userHandle: String
    let userName: String
    let signCount: Int
}

struct OutPassword: Codable {
    let title: String
    let url: String
    let userName: String
    let password: String
}

struct OutImport: Codable {
    let passkeys: [OutPasskey]
    let passwords: [OutPassword]
}

struct OutImportResponse: Codable {
    let success: Bool
    let payload: OutImport?
    let message: String?
    let domain: String?
    let code: Int?
}

func b64(_ d: Data) -> String { d.base64EncodedString() }

func importCredentialsPayload(token: UUID) async throws -> OutImport {
    let manager = ASCredentialImportManager()
    let data = try await manager.importCredentials(token: token)

    var passkeys: [OutPasskey] = []
    var passwords: [OutPassword] = []
    for account in data.accounts {
        for item in account.items {
            for credential in item.credentials {
                if case let .passkey(pk) = credential {
                    passkeys.append(OutPasskey(
                        rpId: pk.relyingPartyIdentifier,
                        credentialId: b64(pk.credentialID),
                        privateKey: b64(pk.key),
                        userHandle: b64(pk.userHandle),
                        userName: pk.userName,
                        signCount: 0
                    ))
                } else if case let .basicAuthentication(basic) = credential,
                          let password = basic.password?.value,
                          !password.isEmpty {
                    let url = item.scope?.urls.first?.absoluteString ?? item.title
                    passwords.append(OutPassword(
                        title: item.title,
                        url: url,
                        userName: basic.userName?.value ?? "",
                        password: password
                    ))
                }
            }
        }
    }

    return OutImport(passkeys: passkeys, passwords: passwords)
}

func encodeImportResponse(_ response: OutImportResponse) -> String {
    do {
        let data = try JSONEncoder().encode(response)
        return String(data: data, encoding: .utf8) ?? #"{"success":false,"message":"invalid utf8"}"#
    } catch {
        return #"{"success":false,"message":"failed to encode import response"}"#
    }
}

func errorResponse(_ error: Error) -> OutImportResponse {
    let nsError = error as NSError
    return OutImportResponse(
        success: false,
        payload: nil,
        message: "\(error)",
        domain: nsError.domain,
        code: nsError.code
    )
}
