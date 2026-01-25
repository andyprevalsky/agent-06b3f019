import { app } from 'electron';
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { FingerprintData } from '../../shared/types/ipc';

// Chrome executable paths on macOS
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  path.join(app.getPath('home'), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
];

/**
 * FingerprintReader collects browser fingerprint data from the user's system.
 * The fingerprint is based on system characteristics (hardware, GPU, screen, fonts, etc.)
 * not on the user's Chrome profile data.
 */
export class FingerprintReader {
  /**
   * Find Chrome executable on the system
   */
  private static findChrome(): string | null {
    for (const chromePath of CHROME_PATHS) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }
    return null;
  }

  /**
   * Collect fingerprint data from the user's system via Chrome.
   * Uses a temporary profile since fingerprint is based on system characteristics,
   * not profile data (hardware, GPU, screen, fonts are system-level).
   */
  static async collectFingerprint(): Promise<FingerprintData | null> {
    const chromePath = this.findChrome();
    if (!chromePath) {
      console.log('[FingerprintReader] Chrome not found');
      return null;
    }

    // Use a temp directory for Chrome profile (required for remote debugging)
    // Fingerprint is system-level (GPU, screen, fonts), not profile-specific
    const tempUserDataDir = path.join(os.tmpdir(), `rose-fingerprint-${Date.now()}`);
    fs.mkdirSync(tempUserDataDir, { recursive: true });

    let browser;
    try {
      console.log('[FingerprintReader] Launching Chrome to collect fingerprint...');

      // Launch Chrome in headful mode to get accurate screen dimensions and userAgent
      // Headless mode reports fake screen dimensions and "HeadlessChrome" in userAgent
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false, // Must be headful to get real screen dimensions
        args: [
          `--user-data-dir=${tempUserDataDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--window-position=-10000,-10000', // Position far off-screen
          '--window-size=1,1', // Minimal window
          '--start-minimized', // Start minimized
        ],
      });

      const page = await browser.newPage();

      // Navigate to a real page to ensure all browser APIs are available
      // (userAgentData.getHighEntropyValues may not work on about:blank)
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 });

      // Collect fingerprint data
      const fingerprint = await page.evaluate(async () => {
        // Navigator properties
        const nav = window.navigator;

        // Screen properties
        const scr = window.screen;

        // WebGL fingerprint
        let webglVendor = '';
        let webglRenderer = '';
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
          if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
              webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '';
              webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
            }
          }
        } catch (e) {
          console.error('WebGL fingerprint error:', e);
        }

        // Canvas fingerprint hash
        let canvasHash = '';
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = 50;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.textBaseline = 'top';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.fillText('Fingerprint', 2, 15);
            ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
            ctx.fillText('Fingerprint', 4, 17);
            canvasHash = canvas.toDataURL();
          }
        } catch (e) {
          console.error('Canvas fingerprint error:', e);
        }

        // Audio fingerprint
        let audioHash = '';
        try {
          const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          const oscillator = audioContext.createOscillator();
          const analyser = audioContext.createAnalyser();
          const gainNode = audioContext.createGain();
          const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

          gainNode.gain.value = 0; // Mute
          oscillator.type = 'triangle';
          oscillator.connect(analyser);
          analyser.connect(scriptProcessor);
          scriptProcessor.connect(gainNode);
          gainNode.connect(audioContext.destination);
          oscillator.start(0);

          // Get frequency data
          const freqData = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(freqData);
          audioHash = Array.from(freqData.slice(0, 30)).join(',');

          oscillator.stop();
          audioContext.close();
        } catch (e) {
          // Audio context may not be available
        }

        // Timezone
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // Installed fonts detection (basic check)
        const testFonts = [
          'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
          'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Helvetica',
          'Monaco', 'Menlo', 'SF Pro', 'San Francisco'
        ];

        const installedFonts: string[] = [];
        const testString = 'mmmmmmmmmmlli';
        const testSize = '72px';
        const baseFonts = ['monospace', 'sans-serif', 'serif'];

        const span = document.createElement('span');
        span.style.position = 'absolute';
        span.style.left = '-9999px';
        span.style.fontSize = testSize;
        span.innerHTML = testString;
        document.body.appendChild(span);

        const baseWidths: Record<string, number> = {};
        for (const baseFont of baseFonts) {
          span.style.fontFamily = baseFont;
          baseWidths[baseFont] = span.offsetWidth;
        }

        for (const font of testFonts) {
          let detected = false;
          for (const baseFont of baseFonts) {
            span.style.fontFamily = `'${font}', ${baseFont}`;
            if (span.offsetWidth !== baseWidths[baseFont]) {
              detected = true;
              break;
            }
          }
          if (detected) {
            installedFonts.push(font);
          }
        }

        document.body.removeChild(span);

        // Plugins (usually empty in modern Chrome)
        const plugins: string[] = [];
        for (let i = 0; i < nav.plugins.length; i++) {
          plugins.push(nav.plugins[i].name);
        }

        // Client Hints (navigator.userAgentData)
        let userAgentData = null;
        try {
          const navUserAgentData = (nav as any).userAgentData;
          console.log('[Fingerprint] userAgentData available:', !!navUserAgentData);
          if (navUserAgentData) {
            const uaData = await navUserAgentData.getHighEntropyValues([
              'architecture',
              'bitness',
              'brands',
              'mobile',
              'model',
              'platform',
              'platformVersion',
              'fullVersionList',
            ]);
            console.log('[Fingerprint] getHighEntropyValues result:', JSON.stringify(uaData).substring(0, 200));
            userAgentData = {
              brands: uaData.brands || [],
              mobile: uaData.mobile || false,
              platform: uaData.platform || '',
              platformVersion: uaData.platformVersion || '',
              architecture: uaData.architecture || '',
              bitness: uaData.bitness || '',
              model: uaData.model || '',
              fullVersionList: uaData.fullVersionList || [],
            };
          }
        } catch (e) {
          console.error('[Fingerprint] Client hints error:', e);
        }

        // Network Information API (navigator.connection)
        let connection = null;
        try {
          const conn = (nav as any).connection;
          if (conn) {
            connection = {
              effectiveType: conn.effectiveType || '4g',
              downlink: conn.downlink || 10,
              rtt: conn.rtt || 50,
              saveData: conn.saveData || false,
            };
          }
        } catch (e) {
          // Network Information API may not be available
        }

        // Viewport dimensions
        const viewport = {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
        };

        // Timezone offset (for Date.getTimezoneOffset())
        const timezoneOffset = new Date().getTimezoneOffset();

        return {
          navigator: {
            userAgent: nav.userAgent,
            platform: nav.platform,
            language: nav.language,
            languages: Array.from(nav.languages),
            hardwareConcurrency: nav.hardwareConcurrency,
            deviceMemory: (nav as any).deviceMemory || null,
            maxTouchPoints: nav.maxTouchPoints,
            vendor: nav.vendor,
            doNotTrack: nav.doNotTrack,
          },
          userAgentData,
          screen: {
            width: scr.width,
            height: scr.height,
            availWidth: scr.availWidth,
            availHeight: scr.availHeight,
            colorDepth: scr.colorDepth,
            pixelDepth: scr.pixelDepth,
            devicePixelRatio: window.devicePixelRatio,
          },
          viewport,
          connection,
          webgl: {
            vendor: webglVendor,
            renderer: webglRenderer,
          },
          canvas: {
            hash: canvasHash,
          },
          audio: {
            hash: audioHash,
          },
          timezone,
          timezoneOffset,
          fonts: installedFonts,
          plugins,
          collectedAt: new Date().toISOString(),
        };
      });

      console.log('[FingerprintReader] ✅ Fingerprint collected successfully');
      return fingerprint;
    } catch (error) {
      console.error('[FingerprintReader] Error collecting fingerprint:', error);
      return null;
    } finally {
      if (browser) {
        await browser.close();
      }
      // Clean up temp directory
      try {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
    }
  }
}
