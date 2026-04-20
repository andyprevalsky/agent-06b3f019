/**
 * In-page fingerprint-collection script.
 *
 * This module exports the browser-side script as a string literal so it can
 * be passed directly to `page.evaluate(src)`. Keeping the script as a string
 * (rather than an inline arrow) is what lets the orchestrator in `service.ts`
 * stay under the strict per-function line cap: the whole script is a single
 * template literal here, not a function body to be linted.
 *
 * IMPORTANT: the script body runs inside Chrome, not Node. It must not
 * reference anything from the Node module scope — puppeteer evaluates the
 * string as-is inside the target page.
 *
 * Contract: the script resolves to a value matching the `FingerprintData`
 * shape defined in `shared/types/ipc.ts`. Any sub-collector that fails falls
 * back to safe defaults (empty strings, null objects) so the resolved payload
 * is always complete.
 */

/**
 * Async IIFE body evaluated inside the target page. Puppeteer returns the
 * resolved value to Node as the `page.evaluate` result.
 */
export const FINGERPRINT_PAGE_SCRIPT = `(async () => {
  const nav = window.navigator;
  const scr = window.screen;

  // WebGL vendor/renderer via the debug-renderer-info extension.
  let webglVendor = '';
  let webglRenderer = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
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

  // Canvas fingerprint hash (deterministic paint).
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

  // Audio fingerprint (frequency-bin slice from an oscillator graph).
  let audioHash = '';
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const audioContext = new Ctor();
    const oscillator = audioContext.createOscillator();
    const analyser = audioContext.createAnalyser();
    const gainNode = audioContext.createGain();
    const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    gainNode.gain.value = 0;
    oscillator.type = 'triangle';
    oscillator.connect(analyser);
    analyser.connect(scriptProcessor);
    scriptProcessor.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(0);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    audioHash = Array.from(freqData.slice(0, 30)).join(',');
    oscillator.stop();
    await audioContext.close();
  } catch (e) {
    // Audio context may not be available.
  }

  // Installed fonts — detect each test font via width differences vs base families.
  const testFonts = [
    'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
    'Impact', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Helvetica',
    'Monaco', 'Menlo', 'SF Pro', 'San Francisco'
  ];
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const installedFonts = [];
  const span = document.createElement('span');
  span.style.position = 'absolute';
  span.style.left = '-9999px';
  span.style.fontSize = '72px';
  span.innerHTML = 'mmmmmmmmmmlli';
  document.body.appendChild(span);
  const baseWidths = {};
  for (const baseFont of baseFonts) {
    span.style.fontFamily = baseFont;
    baseWidths[baseFont] = span.offsetWidth;
  }
  for (const font of testFonts) {
    let detected = false;
    for (const baseFont of baseFonts) {
      span.style.fontFamily = "'" + font + "', " + baseFont;
      if (span.offsetWidth !== baseWidths[baseFont]) {
        detected = true;
        break;
      }
    }
    if (detected) installedFonts.push(font);
  }
  document.body.removeChild(span);

  // Plugins (usually empty in modern Chrome).
  const plugins = [];
  for (let i = 0; i < nav.plugins.length; i++) {
    plugins.push(nav.plugins[i].name);
  }

  // Client Hints (navigator.userAgentData).
  let userAgentData = null;
  try {
    const navUserAgentData = nav.userAgentData;
    console.log('[Fingerprint] userAgentData available:', !!navUserAgentData);
    if (navUserAgentData) {
      const uaData = await navUserAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'brands', 'mobile', 'model',
        'platform', 'platformVersion', 'fullVersionList'
      ]);
      console.log(
        '[Fingerprint] getHighEntropyValues result:',
        JSON.stringify(uaData).substring(0, 200)
      );
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

  // Network Information API (navigator.connection).
  let connection = null;
  try {
    const conn = nav.connection;
    if (conn) {
      connection = {
        effectiveType: conn.effectiveType || '4g',
        downlink: conn.downlink || 10,
        rtt: conn.rtt || 50,
        saveData: conn.saveData || false,
      };
    }
  } catch (e) {
    // Network Information API may not be available.
  }

  return {
    navigator: {
      userAgent: nav.userAgent,
      platform: nav.platform,
      language: nav.language,
      languages: Array.from(nav.languages),
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory || null,
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
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    },
    connection,
    webgl: { vendor: webglVendor, renderer: webglRenderer },
    canvas: { hash: canvasHash },
    audio: { hash: audioHash },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    fonts: installedFonts,
    plugins,
    collectedAt: new Date().toISOString(),
  };
})()`;
