/**
 * In-page software WebAuthn authenticator (injected via executeJavaScript).
 *
 * WHY NOT a CDP virtual authenticator: Electron hard-crashes (SIGABRT) when
 * navigator.credentials.create() is driven by a CDP virtual authenticator.
 * Instead we override navigator.credentials.create in the page with a pure
 * WebCrypto implementation that mints an EXPORTABLE P-256 keypair, fulfills the
 * registration ceremony itself, and stashes the captured key on
 * window.__PASSKEY_CAPTURE for the main process to read. No native WebAuthn, no
 * CDP — so no crash. This is the exact technique validated by hand on Amazon.
 *
 * Re-injected on every navigation; the override install is idempotent.
 */
export const SOFTWARE_AUTHENTICATOR_OVERRIDE = String.raw`(() => {
  if (window.__PASSKEY_OVERRIDE_INSTALLED) return;
  window.__PASSKEY_OVERRIDE_INSTALLED = true;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const uint = (n) => n < 24 ? [n] : n < 256 ? [0x18, n] : n < 65536 ? [0x19, n >> 8, n & 255]
    : [0x1a, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const negint = (n) => { const u = uint(-1 - n); u[0] |= 0x20; return u; };
  const bstr = (bytes) => { const a = [...bytes], len = a.length;
    const head = len < 24 ? [0x40 | len] : len < 256 ? [0x58, len] : [0x59, len >> 8, len & 255];
    return head.concat(a); };
  const tstr = (s) => { const a = [...new TextEncoder().encode(s)], len = a.length;
    const head = len < 24 ? [0x60 | len] : len < 256 ? [0x78, len] : [0x79, len >> 8, len & 255];
    return head.concat(a); };
  const map = (pairs) => { let out = [0xa0 | pairs.length]; for (const [k, v] of pairs) out = out.concat(k, v); return out; };
  const orig = navigator.credentials.create.bind(navigator.credentials);
  navigator.credentials.create = async (options) => {
    try {
      const pk = options.publicKey;
      const rpId = pk.rp.id || location.hostname;
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const X = rawPub.slice(1, 33), Y = rawPub.slice(33, 65);
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
      const credId = crypto.getRandomValues(new Uint8Array(32));
      const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
      const cose = map([[uint(1), uint(2)], [uint(3), negint(-7)], [negint(-1), uint(1)], [negint(-2), bstr(X)], [negint(-3), bstr(Y)]]);
      const authData = new Uint8Array([...rpIdHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16),
        (credId.length >> 8) & 255, credId.length & 255, ...credId, ...cose]);
      const attObj = new Uint8Array(map([[tstr('fmt'), tstr('none')], [tstr('attStmt'), [0xa0]], [tstr('authData'), bstr(authData)]]));
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: b64url(pk.challenge), origin: location.origin, crossOrigin: false }));
      const userHandle = pk.user && pk.user.id ? b64(pk.user.id) : null;
      window.__PASSKEY_CAPTURE = { credentialId: b64(credId), privateKey: b64(pkcs8), rpId, userHandle, signCount: 0, capturedAt: new Date().toISOString() };
      return {
        id: b64url(credId), rawId: credId.buffer, type: 'public-key', authenticatorAttachment: 'platform',
        response: { clientDataJSON: clientDataJSON.buffer, attestationObject: attObj.buffer, getTransports: () => ['internal'],
          getAuthenticatorData: () => authData.buffer, getPublicKey: () => rawPub.buffer, getPublicKeyAlgorithm: () => -7 },
        getClientExtensionResults: () => ({}),
      };
    } catch (e) { console.error('[passkey] override failed, falling back:', e); return orig(options); }
  };
})();`;
