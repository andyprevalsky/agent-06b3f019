import Darwin
import Foundation

@_cdecl("rose_passkey_import_json")
public func rose_passkey_import_json(_ tokenCString: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let tokenCString,
          let tokenString = String(validatingUTF8: tokenCString),
          let token = UUID(uuidString: tokenString) else {
        return strdup(encodeImportResponse(OutImportResponse(
            success: false,
            payload: nil,
            message: "invalid import token",
            domain: nil,
            code: nil
        )))
    }

    let sema = DispatchSemaphore(value: 0)
    var response: OutImportResponse?

    Task {
        do {
            let payload = try await importCredentialsPayload(token: token)
            response = OutImportResponse(
                success: true,
                payload: payload,
                message: nil,
                domain: nil,
                code: nil
            )
        } catch {
            response = errorResponse(error)
        }
        sema.signal()
    }

    sema.wait()
    return strdup(encodeImportResponse(response ?? OutImportResponse(
        success: false,
        payload: nil,
        message: "credential import did not produce a response",
        domain: nil,
        code: nil
    )))
}

@_cdecl("rose_passkey_import_free")
public func rose_passkey_import_free(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}
