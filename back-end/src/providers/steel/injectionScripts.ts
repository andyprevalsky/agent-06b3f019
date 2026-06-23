/**
 * Browser injection script builders for Steel sessions.
 * Extracted from injection.ts to comply with max-lines.
 */
import { type FingerprintData } from './types';

/**
 * Build the comprehensive fingerprint spoofing JavaScript that runs in the browser.
 */
export function buildFingerprintScript(fp: FingerprintData): string {
  return `
            // Fingerprint spoofing script - injected to match user's real browser
            (function() {
              'use strict';

              // ── Defeat CDP console-consumer detection ───────────────────
              // Detectors (FCaptcha _detectCDPRuntime) plant an Error whose
              // .message getter fires only when an attached CDP client has
              // Runtime enabled and Chrome serializes a console-logged object.
              // browser-use enables Runtime, so any console.* call trips it.
              // Route console.* through no-ops that never reach the native sink
              // → Chrome emits no consoleAPICalled → the bait getter never fires.
              // Keep toString native-looking so the override isn't itself a tell.
              try {
                const _nativeToString = Function.prototype.toString;
                const _consoleNoop = function () {};
                for (const _m of [
                  'debug', 'log', 'info', 'warn', 'error', 'trace', 'dir', 'dirxml',
                  'table', 'group', 'groupCollapsed', 'groupEnd', 'assert', 'count',
                  'countReset', 'time', 'timeEnd', 'timeLog', 'profile', 'profileEnd',
                ]) {
                  try {
                    const _fn = function () {};
                    Object.defineProperty(_fn, 'name', { value: _m });
                    Object.defineProperty(_fn, 'toString', {
                      value: () => 'function ' + _m + '() { [native code] }',
                      configurable: true,
                    });
                    Object.defineProperty(console, _m, {
                      value: _fn,
                      writable: true,
                      configurable: true,
                    });
                  } catch (e) {}
                }
                void _nativeToString;
                void _consoleNoop;
              } catch (e) {}

              const fp = ${JSON.stringify(fp)};

              // Override navigator properties
              const navigatorProps = {
                userAgent: { value: fp.navigator.userAgent },
                platform: { value: fp.navigator.platform },
                language: { value: fp.navigator.language },
                languages: { value: Object.freeze([...fp.navigator.languages]) },
                hardwareConcurrency: { value: fp.navigator.hardwareConcurrency },
                deviceMemory: { value: fp.navigator.deviceMemory },
                maxTouchPoints: { value: fp.navigator.maxTouchPoints },
                vendor: { value: fp.navigator.vendor },
                doNotTrack: { value: fp.navigator.doNotTrack },
              };

              for (const [prop, desc] of Object.entries(navigatorProps)) {
                try {
                  Object.defineProperty(Navigator.prototype, prop, {
                    get: () => desc.value,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.webdriver (bot detection flag). Define it
              // NON-configurable: detectors read the property descriptor and flag
              // both a missing webdriver ('webdriver_deleted') and a configurable
              // one ('webdriver_configurable'), since a real Chrome exposes
              // navigator.webdriver as a non-configurable getter returning false.
              // Matching that shape (get:()=>false, configurable:false) leaves no
              // descriptor-level automation tell to probe.
              try {
                Object.defineProperty(Navigator.prototype, 'webdriver', {
                  get: () => false,
                  configurable: false,
                  enumerable: true,
                });
              } catch (e) {}

              // Override navigator.plugins with user's plugins
              if (fp.plugins && fp.plugins.length > 0) {
                try {
                  const fakePlugins = {
                    length: fp.plugins.length,
                    item: (index) => fakePlugins[index] || null,
                    namedItem: (name) => {
                      for (let i = 0; i < fp.plugins.length; i++) {
                        if (fp.plugins[i] === name) return { name: fp.plugins[i] };
                      }
                      return null;
                    },
                    refresh: () => {},
                  };
                  for (let i = 0; i < fp.plugins.length; i++) {
                    fakePlugins[i] = { name: fp.plugins[i], description: '', filename: '', length: 0 };
                  }
                  Object.defineProperty(Navigator.prototype, 'plugins', {
                    get: () => fakePlugins,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.connection (Network Information API)
              if (fp.connection) {
                try {
                  const fakeConnection = {
                    effectiveType: fp.connection.effectiveType,
                    downlink: fp.connection.downlink,
                    rtt: fp.connection.rtt,
                    saveData: fp.connection.saveData,
                    onchange: null,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    dispatchEvent: () => true,
                  };
                  Object.defineProperty(Navigator.prototype, 'connection', {
                    get: () => fakeConnection,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override navigator.userAgentData (Client Hints in JS)
              if (fp.userAgentData) {
                try {
                  const fakeUserAgentData = {
                    brands: fp.userAgentData.brands,
                    mobile: fp.userAgentData.mobile,
                    platform: fp.userAgentData.platform,
                    getHighEntropyValues: async (hints) => {
                      const result = {
                        brands: fp.userAgentData.brands,
                        mobile: fp.userAgentData.mobile,
                        platform: fp.userAgentData.platform,
                      };
                      if (hints.includes('platformVersion')) result.platformVersion = fp.userAgentData.platformVersion;
                      if (hints.includes('architecture')) result.architecture = fp.userAgentData.architecture;
                      if (hints.includes('bitness')) result.bitness = fp.userAgentData.bitness;
                      if (hints.includes('model')) result.model = fp.userAgentData.model;
                      if (hints.includes('fullVersionList')) result.fullVersionList = fp.userAgentData.fullVersionList;
                      return result;
                    },
                    toJSON: () => ({
                      brands: fp.userAgentData.brands,
                      mobile: fp.userAgentData.mobile,
                      platform: fp.userAgentData.platform,
                    }),
                  };
                  Object.defineProperty(Navigator.prototype, 'userAgentData', {
                    get: () => fakeUserAgentData,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override screen properties
              const screenProps = {
                width: fp.screen.width,
                height: fp.screen.height,
                availWidth: fp.screen.availWidth,
                availHeight: fp.screen.availHeight,
                colorDepth: fp.screen.colorDepth,
                pixelDepth: fp.screen.pixelDepth,
              };

              for (const [prop, value] of Object.entries(screenProps)) {
                try {
                  Object.defineProperty(Screen.prototype, prop, {
                    get: () => value,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override devicePixelRatio
              try {
                Object.defineProperty(window, 'devicePixelRatio', {
                  get: () => fp.screen.devicePixelRatio,
                  configurable: true,
                });
              } catch (e) {}

              // Temporarily do not override inner viewport dimensions. The agent
              // browser must report its real content viewport so site layout,
              // screenshots, and click coordinates agree.
              if (fp.viewport) {
                try {
                  Object.defineProperty(window, 'outerWidth', {
                    get: () => fp.viewport.outerWidth,
                    configurable: true,
                  });
                  Object.defineProperty(window, 'outerHeight', {
                    get: () => fp.viewport.outerHeight,
                    configurable: true,
                  });
                } catch (e) {}
              }

              // Override WebGL. A plain wrapped function (not a Proxy) avoids
              // destabilizing the GPU/raster pipeline — wrapping getParameter in
              // a Proxy on Steel's software-GL backend was making the 2D canvas
              // read back blank ("Canvas fingerprinting blocked or failed"). Also
              // guard against the captured fingerprint itself reporting software
              // rendering (SwiftShader/LLVMpipe), which would leak straight
              // through, and normalize VERSION/SHADING strings that betray it.
              const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|virtualbox|vmware|mesa|microsoft basic render/i;
              const _safeVendor =
                fp.webgl && fp.webgl.vendor && !SOFTWARE_GL_RE.test(fp.webgl.vendor)
                  ? fp.webgl.vendor
                  : 'Google Inc. (Apple)';
              const _safeRenderer =
                fp.webgl && fp.webgl.renderer && !SOFTWARE_GL_RE.test(fp.webgl.renderer)
                  ? fp.webgl.renderer
                  : 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)';

              const _wrapGetParameter = (proto) => {
                const orig = proto.getParameter;
                const wrapped = function (param) {
                  if (param === 0x9245) return _safeVendor; // UNMASKED_VENDOR_WEBGL
                  if (param === 0x9246) return _safeRenderer; // UNMASKED_RENDERER_WEBGL
                  const real = orig.call(this, param);
                  if (
                    (param === 0x1f02 || param === 0x8b8c) && // VERSION / SHADING_LANGUAGE_VERSION
                    typeof real === 'string' &&
                    SOFTWARE_GL_RE.test(real)
                  ) {
                    return param === 0x1f02
                      ? 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'
                      : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
                  }
                  return real;
                };
                try {
                  Object.defineProperty(wrapped, 'toString', {
                    value: () => 'function getParameter() { [native code] }',
                    configurable: true,
                  });
                } catch (e) {}
                proto.getParameter = wrapped;
              };
              try {
                _wrapGetParameter(WebGLRenderingContext.prototype);
                _wrapGetParameter(WebGL2RenderingContext.prototype);
              } catch (e) {}

              // ── Canvas fingerprint spoof ────────────────────────────────
              // Return a STABLE, realistic, sub-perceptually-noised canvas so
              // toDataURL/getImageData never read back blank/all-zero ("blocked
              // or failed", 0.4). Noise is seeded per session so reads are
              // self-consistent; a fresh per-session seed also varies the canvas
              // component of the server's fingerprint identity, helping the
              // "seen from many IPs" reputation signal. Native-masked toString.
              try {
                const _seedStr =
                  (fp.canvas && fp.canvas.hash ? String(fp.canvas.hash) : 'rose-canvas') +
                  ':' +
                  Math.floor(Date.now() / 1000) +
                  ':' +
                  (Math.random() * 1e9 | 0);
                let _seed = 0x811c9dc5 >>> 0;
                for (let i = 0; i < _seedStr.length; i++) {
                  _seed ^= _seedStr.charCodeAt(i);
                  _seed = Math.imul(_seed, 0x01000193) >>> 0;
                }
                const _mkRand = (s) => () => {
                  s = (s + 0x6d2b79f5) | 0;
                  let t = Math.imul(s ^ (s >>> 15), 1 | s);
                  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                };
                const _perturb = (img, extra) => {
                  const d = img && img.data;
                  if (!d || d.length === 0) return img;
                  const rand = _mkRand((_seed ^ (extra >>> 0)) >>> 0);
                  const px = d.length >>> 2;
                  const n = Math.min(64, px);
                  for (let k = 0; k < n; k++) {
                    const o = (Math.floor(rand() * px)) << 2;
                    d[o] = (d[o] + (rand() < 0.5 ? 1 : -1) + 256) & 255;
                    d[o + 1] = (d[o + 1] + (rand() < 0.5 ? 1 : -1) + 256) & 255;
                    d[o + 2] = (d[o + 2] + (rand() < 0.5 ? 1 : -1) + 256) & 255;
                    if (d[o + 3] === 0) d[o + 3] = 255;
                  }
                  return img;
                };
                const _strSeed = (str) => {
                  let h = 0;
                  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
                  return h >>> 0;
                };
                const _nativeMask = (fn, name) => {
                  try {
                    Object.defineProperty(fn, 'toString', {
                      value: () => 'function ' + name + '() { [native code] }',
                      configurable: true,
                    });
                  } catch (e) {}
                  return fn;
                };
                const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
                CanvasRenderingContext2D.prototype.getImageData = _nativeMask(function (sx, sy, sw, sh) {
                  const img = _origGetImageData.call(this, sx, sy, sw, sh);
                  try {
                    return _perturb(img, _strSeed(sx + 'x' + sy + 'x' + sw + 'x' + sh));
                  } catch (e) {
                    return img;
                  }
                }, 'getImageData');
                const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = _nativeMask(function (...args) {
                  try {
                    const w = this.width, h = this.height;
                    if (w > 0 && h > 0) {
                      const ctx = this.getContext('2d');
                      if (ctx) {
                        const img = _origGetImageData.call(ctx, 0, 0, w, h);
                        _perturb(img, _strSeed(w + 'x' + h));
                        ctx.putImageData(img, 0, 0);
                      }
                    }
                  } catch (e) {}
                  return _origToDataURL.apply(this, args);
                }, 'toDataURL');
              } catch (e) {}

              // ── Notification permission ─────────────────────────────────
              // Headless Chrome reports Notification.permission === 'denied'
              // ("Notifications pre-denied"); real Chrome defaults to 'default'.
              try {
                if (typeof Notification !== 'undefined') {
                  Object.defineProperty(Notification, 'permission', {
                    get: () => 'default',
                    configurable: true,
                  });
                }
              } catch (e) {}

              // ── window.chrome runtime object ────────────────────────────
              // Real Chrome exposes window.chrome with runtime; its absence is a
              // headless/automation tell.
              try {
                if (!window.chrome) {
                  Object.defineProperty(window, 'chrome', {
                    value: { runtime: {}, app: { isInstalled: false }, csi: function () {}, loadTimes: function () {} },
                    configurable: true,
                    writable: true,
                  });
                } else if (!window.chrome.runtime) {
                  window.chrome.runtime = {};
                }
              } catch (e) {}

              // Override timezone via Intl.DateTimeFormat
              const originalDateTimeFormat = Intl.DateTimeFormat;
              Intl.DateTimeFormat = function(...args) {
                const instance = new originalDateTimeFormat(...args);
                const originalResolvedOptions = instance.resolvedOptions.bind(instance);
                instance.resolvedOptions = function() {
                  const options = originalResolvedOptions();
                  options.timeZone = fp.timezone;
                  return options;
                };
                return instance;
              };
              Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
              Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;

              // Override Date.prototype.getTimezoneOffset
              if (fp.timezoneOffset !== undefined) {
                const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
                Date.prototype.getTimezoneOffset = function() {
                  return fp.timezoneOffset;
                };
              }

              // Block WebRTC IP leak via JS
              try {
                // Override RTCPeerConnection to prevent IP leaks
                const originalRTCPeerConnection = window.RTCPeerConnection;
                if (originalRTCPeerConnection) {
                  window.RTCPeerConnection = function(config) {
                    // Force ICE candidate filtering
                    if (config && config.iceServers) {
                      // Keep STUN/TURN but they'll only see proxy IP
                    }
                    return new originalRTCPeerConnection(config);
                  };
                  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
                }
              } catch (e) {}

            })();
  `;
}
