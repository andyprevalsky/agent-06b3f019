/* ============================================================================
 * Passkey enroll — pure console software authenticator (exportable key).
 *
 * Paste this WHOLE block into the DevTools Console on an Amazon tab where you
 * are logged in, BEFORE clicking "Add a passkey". It overrides
 * navigator.credentials.create with a JS software authenticator that mints an
 * EXPORTABLE P-256 keypair (WebCrypto) and fulfills the registration ceremony,
 * so Amazon registers OUR key and we keep the private key.
 *
 * After you click "Add a passkey" and Amazon says it's added, the console
 * prints a JSON block: { credentialId, privateKey, rpId, userHandle, signCount }.
 * Copy that JSON and paste it back to me.
 * ==========================================================================*/
(() => {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // --- minimal CBOR encoder (arrays of byte values) ---
  const uint = (n) =>
    n < 24 ? [n]
    : n < 256 ? [0x18, n]
    : n < 65536 ? [0x19, n >> 8, n & 255]
    : [0x1a, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const negint = (n) => { const u = uint(-1 - n); u[0] |= 0x20; return u; };
  const bstr = (bytes) => {
    const a = [...bytes], len = a.length;
    const head = len < 24 ? [0x40 | len] : len < 256 ? [0x58, len] : [0x59, len >> 8, len & 255];
    return head.concat(a);
  };
  const tstr = (s) => {
    const a = [...new TextEncoder().encode(s)], len = a.length;
    const head = len < 24 ? [0x60 | len] : len < 256 ? [0x78, len] : [0x79, len >> 8, len & 255];
    return head.concat(a);
  };
  const map = (pairs) => {
    let out = [0xa0 | pairs.length];
    for (const [k, v] of pairs) out = out.concat(k, v);
    return out;
  };

  const orig = navigator.credentials.create.bind(navigator.credentials);

  navigator.credentials.create = async (options) => {
    try {
      const pk = options.publicKey;
      const rpId = pk.rp.id || location.hostname;

      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); // 0x04|X(32)|Y(32)
      const X = rawPub.slice(1, 33), Y = rawPub.slice(33, 65);
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);

      const credId = crypto.getRandomValues(new Uint8Array(32));
      const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));

      const cose = map([
        [uint(1), uint(2)],          // kty EC2
        [uint(3), negint(-7)],       // alg ES256
        [negint(-1), uint(1)],       // crv P-256
        [negint(-2), bstr(X)],       // x
        [negint(-3), bstr(Y)],       // y
      ]);

      const flags = 0x45; // UP | UV | AT
      const authData = new Uint8Array([
        ...rpIdHash, flags, 0, 0, 0, 0,
        ...new Uint8Array(16),                       // aaguid (zeros)
        (credId.length >> 8) & 255, credId.length & 255,
        ...credId, ...cose,
      ]);

      const attObj = new Uint8Array(map([
        [tstr('fmt'), tstr('none')],
        [tstr('attStmt'), [0xa0]],
        [tstr('authData'), bstr(authData)],
      ]));

      const clientDataJSON = new TextEncoder().encode(JSON.stringify({
        type: 'webauthn.create',
        challenge: b64url(pk.challenge),
        origin: location.origin,
        crossOrigin: false,
      }));

      const userHandle = pk.user && pk.user.id ? b64(pk.user.id) : null;

      // Stash for printing after the site finishes registration.
      window.__PASSKEY_CAPTURE = {
        credentialId: b64(credId),
        privateKey: b64(pkcs8),
        rpId,
        userHandle,
        signCount: 0,
        capturedAt: new Date().toISOString(),
      };

      const cred = {
        id: b64url(credId),
        rawId: credId.buffer,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: clientDataJSON.buffer,
          attestationObject: attObj.buffer,
          getTransports: () => ['internal'],
          getAuthenticatorData: () => authData.buffer,
          getPublicKey: () => rawPub.buffer,
          getPublicKeyAlgorithm: () => -7,
        },
        getClientExtensionResults: () => ({}),
      };

      console.log('%c[passkey] software authenticator fulfilled create() — finish the Amazon dialog, then copy the JSON below:', 'color:#0a0;font-weight:bold');
      console.log(JSON.stringify(window.__PASSKEY_CAPTURE, null, 2));
      return cred;
    } catch (e) {
      console.error('[passkey] override failed, falling back to real authenticator:', e);
      return orig(options);
    }
  };

  console.log('%c[passkey] override installed. Now click "Add a passkey" on Amazon.', 'color:#06c;font-weight:bold');
  console.log('If you miss the JSON, run:  copy(JSON.stringify(window.__PASSKEY_CAPTURE))');
})();
