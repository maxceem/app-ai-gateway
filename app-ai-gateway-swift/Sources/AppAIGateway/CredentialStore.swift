import Foundation
import Security

/// Where the install's App Attest key ids are kept. The client names each
/// place: the app's id, or on an app with signed-in users the app's id with a
/// user's mark after `#`. `nil` removes a key, and must throw if it cannot.
public protocol GatewayCredentialStoring: Sendable {
    func appAttestKeyID(for appID: String) throws -> String?
    func setAppAttestKeyID(_ keyID: String?, for appID: String) throws
}

public struct KeychainGatewayCredentialStore: GatewayCredentialStoring {
    private let service: String

    public init(service: String = "dev.aigateway.credentials") {
        self.service = service
    }

    public func appAttestKeyID(for appID: String) throws -> String? {
        var query = baseQuery(appID: appID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        return String(data: data, encoding: .utf8)
    }

    /// `nil` removes the key. A removal the Keychain refuses throws, so a key
    /// meant to be gone is never read back as if it were still there.
    public func setAppAttestKeyID(_ keyID: String?, for appID: String) throws {
        let query = baseQuery(appID: appID)
        let removed = SecItemDelete(query as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else {
            throw KeychainError(status: removed)
        }
        guard let keyID else { return }
        var attributes = query
        attributes[kSecValueData as String] = Data(keyID.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private func baseQuery(appID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "\(appID).app-attest-key",
        ]
    }
}

public struct KeychainError: Error, Sendable {
    public let status: OSStatus
}
