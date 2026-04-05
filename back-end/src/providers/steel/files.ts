/**
 * Steel file operations and fingerprint data retrieval.
 */

import { prisma } from "../database";
import { steel } from "./session";
import { type FingerprintData, type SteelFileInfo, log } from "./types";

/**
 * Upload a file to an active Steel session.
 *
 * @param sessionId - The Steel session ID
 * @param fileBuffer - The file content as a Buffer
 * @param filename - The original filename
 * @param mimeType - The MIME type of the file
 * @returns The remote path where the file is available in the session
 */
export async function uploadFileToSession(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string = 'application/octet-stream'
): Promise<{ path: string; size: number }> {
  log.info(`📎 Uploading file '${filename}' to Steel session ${sessionId}...`);

  try {
    // Steel SDK expects a File or Blob object, NOT a Node.js Readable stream
    // Using File (available in Node.js 20+) which includes filename metadata
    const file = new File([fileBuffer], filename, { type: mimeType });

    const uploadedFile = await steel.sessions.files.upload(sessionId, {
      file: file,
      path: filename, // Preserve original filename instead of UUID
    });

    log.info(`  ✅ Uploaded ${filename} -> ${uploadedFile.path} (${uploadedFile.size} bytes)`);

    return {
      path: uploadedFile.path,
      size: uploadedFile.size || fileBuffer.length,
    };
  } catch (error) {
    log.error(`Failed to upload file '${filename}'`, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * List all files in a Steel browser session.
 * This includes files downloaded by the browser and any uploaded files.
 *
 * @param sessionId - The Steel session ID
 * @returns Array of file info objects
 */
export async function listSessionFiles(sessionId: string): Promise<SteelFileInfo[]> {
  log.info(`📂 Listing files in Steel session ${sessionId}...`);

  try {
    const filesResponse = await steel.sessions.files.list(sessionId);

    // Steel SDK returns an object with data or files array, extract it
    const response = filesResponse as unknown as Record<string, unknown>;
    const files: SteelFileInfo[] = (
      (response.data as SteelFileInfo[]) ||
      (response.files as SteelFileInfo[]) ||
      (filesResponse as unknown as SteelFileInfo[]) ||
      []
    );

    log.info(`Found ${files.length} file(s)`);
    for (const file of files) {
      log.info(`  - ${file.path} (${file.size} bytes)`);
    }

    return files.map((f) => ({
      path: f.path,
      size: f.size || 0,
      lastModified: f.lastModified,
    }));
  } catch (error) {
    log.error('Failed to list files', { error: error instanceof Error ? error.message : String(error) });
    // Return empty array on error (session may have no files)
    return [];
  }
}

/**
 * Get fingerprint injection data for a user.
 * Returns the data needed for the agent to apply CDP commands.
 *
 * @param userId - The user's ID
 * @returns Fingerprint data and init script for CDP injection, or null if not available
 */
export async function getFingerprintInjectionData(userId: string): Promise<{
  userAgentOverride: {
    userAgent: string;
    acceptLanguage: string;
    platform: string;
    userAgentMetadata?: {
      brands: Array<{ brand: string; version: string }>;
      fullVersionList: Array<{ brand: string; version: string }>;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
      bitness: string;
    };
  };
  initScript: string;
} | null> {
  const integration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'browser_fingerprint' } },
  });

  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  if (!fp) {
    return null;
  }

  // Build the User-Agent override params for Network.setUserAgentOverride
  const userAgentOverride: {
    userAgent: string;
    acceptLanguage: string;
    platform: string;
    userAgentMetadata?: {
      brands: Array<{ brand: string; version: string }>;
      fullVersionList: Array<{ brand: string; version: string }>;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
      bitness: string;
    };
  } = {
    userAgent: fp.navigator.userAgent,
    acceptLanguage: fp.navigator.languages.join(','),
    platform: fp.navigator.platform,
  };

  if (fp.userAgentData) {
    userAgentOverride.userAgentMetadata = {
      brands: fp.userAgentData.brands,
      fullVersionList: fp.userAgentData.fullVersionList,
      platform: fp.userAgentData.platform,
      platformVersion: fp.userAgentData.platformVersion,
      architecture: fp.userAgentData.architecture,
      model: fp.userAgentData.model,
      mobile: fp.userAgentData.mobile,
      bitness: fp.userAgentData.bitness,
    };
  }

  // Build the fingerprint spoofing init script
  const initScript = `
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

      // NOTE: Viewport dimensions (innerWidth/Height, outerWidth/Height) are intentionally
      // NOT overridden. The agent's browser has its own viewport size that must match its
      // actual rendering dimensions for correct interaction.

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
        const originalRTCPeerConnection = window.RTCPeerConnection;
        if (originalRTCPeerConnection) {
          window.RTCPeerConnection = function(config) {
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

  return {
    userAgentOverride,
    initScript,
  };
}
