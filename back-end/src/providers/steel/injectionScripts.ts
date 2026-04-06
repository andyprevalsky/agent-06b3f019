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

              // Override navigator.webdriver (bot detection flag)
              try {
                Object.defineProperty(Navigator.prototype, 'webdriver', {
                  get: () => false,
                  configurable: true,
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

              // Override viewport dimensions
              if (fp.viewport) {
                try {
                  Object.defineProperty(window, 'innerWidth', {
                    get: () => fp.viewport.innerWidth,
                    configurable: true,
                  });
                  Object.defineProperty(window, 'innerHeight', {
                    get: () => fp.viewport.innerHeight,
                    configurable: true,
                  });
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

              // Override WebGL
              const getParameterProxyHandler = {
                apply: function(target, thisArg, args) {
                  const param = args[0];
                  const UNMASKED_VENDOR_WEBGL = 0x9245;
                  const UNMASKED_RENDERER_WEBGL = 0x9246;

                  if (param === UNMASKED_VENDOR_WEBGL) {
                    return fp.webgl.vendor;
                  }
                  if (param === UNMASKED_RENDERER_WEBGL) {
                    return fp.webgl.renderer;
                  }
                  return target.apply(thisArg, args);
                }
              };

              try {
                WebGLRenderingContext.prototype.getParameter = new Proxy(
                  WebGLRenderingContext.prototype.getParameter,
                  getParameterProxyHandler
                );
                WebGL2RenderingContext.prototype.getParameter = new Proxy(
                  WebGL2RenderingContext.prototype.getParameter,
                  getParameterProxyHandler
                );
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

              log.info('[Fingerprint] ✅ Comprehensive fingerprint spoofing injected');
            })();
  `;
}
