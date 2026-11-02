import { readFileSync } from 'node:fs';
import path from 'node:path';
export const SUPPORTED_AMPLITUDE_AUTOCAPTURE_VERSIONS = ['1.30.1', '1.28.9'];
const MARKER = '/* rose-rage-click-lifecycle */';
const PATCHES = [
  {
    before: 'var pendingRageClick = null;',
    after:
      'var pendingRageClick = null;\n    /* rose-rage-click-lifecycle */\n    var clickWindowExpiryTimer = null;\n    var rageClickDisposed = false;',
  },
  {
    before: 'function resetClickWindow(click) {',
    after:
      'function resetClickWindow(click) {\n        if (clickWindowExpiryTimer !== null) {\n            clearTimeout(clickWindowExpiryTimer);\n            clickWindowExpiryTimer = null;\n        }',
  },
  {
    before: "return shouldTrackRageClick('click', click.closestTrackedAncestor);",
    after:
      "return !rageClickDisposed && shouldTrackRageClick('click', click.closestTrackedAncestor);",
  },
  {
    before: 'if (clickWindow.length >= RAGE_CLICK_THRESHOLD) {',
    after:
      'if (clickWindowExpiryTimer !== null) clearTimeout(clickWindowExpiryTimer);\n            clickWindowExpiryTimer = setTimeout(function () {\n                clickWindowExpiryTimer = null;\n                if (!pendingRageClick) resetClickWindow();\n            }, RAGE_CLICK_WINDOW_MS);\n            if (clickWindow.length >= RAGE_CLICK_THRESHOLD) {',
  },
  {
    before: 'resolve(getRageClickAnalyticsEvent(clickWindow));',
    after:
      'var result = getRageClickAnalyticsEvent(clickWindow);\n                                pendingRageClick = null;\n                                resetClickWindow();\n                                resolve(result);',
  },
  {
    before: 'unsubscribe: function () {\n            rageClickSubscription.unsubscribe();',
    after:
      'unsubscribe: function () {\n            rageClickDisposed = true;\n            resetClickWindow();\n            if (pendingRageClick) {\n                clearTimeout(pendingRageClick.timerId);\n                pendingRageClick.resolve(null);\n                pendingRageClick = null;\n            }\n            rageClickSubscription.unsubscribe();',
  },
];
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error('Unsupported or partial Amplitude source block: ' + before.slice(0, 90));
  return source.replace(before, after);
}
export function transformAmplitudeRageClick(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2) throw new Error('Duplicate Amplitude lifecycle marker');
    let original = source;
    for (const patch of [...PATCHES].reverse())
      original = replaceOnce(original, patch.after, patch.before);
    if (transformAmplitudeRageClick(original) !== source)
      throw new Error('Partial Amplitude lifecycle patch');
    return source;
  }
  for (const patch of PATCHES) source = replaceOnce(source, patch.before, patch.after);
  return source;
}
export function planAmplitudeLifecyclePatch(packageRoot) {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!SUPPORTED_AMPLITUDE_AUTOCAPTURE_VERSIONS.includes(pkg.version))
    throw new Error('Unsupported Amplitude autocapture version ' + pkg.version);
  return ['esm', 'cjs'].map((format) => {
    const file = path.join(packageRoot, 'lib', format, 'autocapture', 'track-rage-click.js');
    const before = readFileSync(file, 'utf8');
    return { path: file, before, after: transformAmplitudeRageClick(before) };
  });
}
