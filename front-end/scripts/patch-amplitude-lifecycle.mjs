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
const EXPOSURE_MARKER = '/* rose-exposure-lifecycle */';
const REMOVAL_MARKER = '/* rose-exposure-removal-lifecycle */';
function verifiedTransform(source, marker, patches) {
  if (source.includes(marker)) {
    if (source.split(marker).length !== 2) throw new Error('Duplicate exposure lifecycle marker');
    let original = source;
    for (const patch of [...patches].reverse())
      original = replaceOnce(original, patch.after, patch.before);
    if (verifiedTransform(original, marker, patches) !== source)
      throw new Error('Partial exposure lifecycle patch');
    return source;
  }
  for (const patch of patches) source = replaceOnce(source, patch.before, patch.after);
  return source;
}
export function transformAmplitudeExposure(source, version) {
  if (!SUPPORTED_AMPLITUDE_AUTOCAPTURE_VERSIONS.includes(version))
    throw new Error('Unsupported exposure version ' + version);
  const legacy = version === '1.28.9';
  const indent = legacy ? '                    ' : '            ';
  const patches = [
    {
      before: 'var exposureMap = new Map();',
      after: EXPOSURE_MARKER + '\n    var exposureMap = new WeakMap();',
    },
    {
      before:
        'exposureTimerMap.clear();\n' +
        (legacy ? '            ' : '        ') +
        'exposureMap.clear();',
      after:
        'exposureTimerMap.clear();\n' +
        (legacy ? '            ' : '        ') +
        'exposureMap = new WeakMap();',
    },
    {
      before: indent + 'exposureMap.set(element, true);',
      after:
        indent + 'exposureTimerMap.delete(element);\n' + indent + 'exposureMap.set(element, true);',
    },
    {
      before:
        'onExposure(elementPath);\n' +
        (legacy ? '                    // Clear the timer reference\n' : '') +
        indent +
        'exposureTimerMap.set(element, null);',
      after: 'onExposure(elementPath);',
    },
    {
      before:
        'clearTimeout(timer);\n' +
        (legacy ? '                ' : '            ') +
        'exposureTimerMap.set(element, null);',
      after:
        'clearTimeout(timer);\n' +
        (legacy ? '                ' : '            ') +
        'exposureTimerMap.delete(element);',
    },
  ];
  if (legacy) {
    patches.push({
      before: 'if (!exposureMap.get(element)) {',
      after: 'if (!exposureMap.get(element) && !exposureTimerMap.has(element)) {',
    });
    patches.push({
      before: 'exposureSubscription.unsubscribe();',
      after:
        'exposureSubscription.unsubscribe();\n            exposureTimerMap.forEach(function (timer) { clearTimeout(timer); });\n            exposureTimerMap.clear();\n            exposureMap = new WeakMap();',
    });
  }
  return verifiedTransform(source, EXPOSURE_MARKER, patches);
}
export function transformAmplitudeExposureObservable(source, version) {
  if (!SUPPORTED_AMPLITUDE_AUTOCAPTURE_VERSIONS.includes(version))
    throw new Error('Unsupported exposure version ' + version);
  if (source.split(REMOVAL_MARKER).length > 2) throw new Error('Duplicate exposure removal marker');
  const start = source.indexOf('var createExposureObservable = function');
  const end = source.indexOf('var createUnhandledErrorObservable = function', start);
  if (start < 0 || end < 0) throw new Error('Unsupported exposure observable boundary');
  if (source.includes(REMOVAL_MARKER) && !source.slice(start, end).includes(REMOVAL_MARKER))
    throw new Error('Misplaced exposure removal marker');
  const previousRemoval = `                /* rose-exposure-removal-lifecycle */
                var retireRemovedNode = function (node) {
                    if (node.isConnected) return;
                    if (node instanceof Element) {
                        intersectionObserver.unobserve(node);
                        observer.next({ target: node, isIntersecting: false, intersectionRatio: 0 });
                        if (node.shadowRoot) retireRemovedNode(node.shadowRoot);
                    }
                    if (node.childNodes) node.childNodes.forEach(retireRemovedNode);
                };
                _a.removedNodes.forEach(retireRemovedNode);
`;
  const removal = `                /* rose-exposure-removal-lifecycle */
                var retireRemovedNode = function (root) {
                    var pending = [root];
                    while (pending.length) {
                        var node = pending.pop();
                        if (node.isConnected) continue;
                        if (node instanceof Element) {
                            intersectionObserver.unobserve(node);
                            observer.next({ target: node, isIntersecting: false, intersectionRatio: 0 });
                        }
                        if (node.childNodes) {
                            for (var i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
                        }
                        if (node instanceof Element && node.shadowRoot) pending.push(node.shadowRoot);
                    }
                };
                _a.removedNodes.forEach(retireRemovedNode);
`;
  const patches = [
    {
      before: '                var addedNodes = _a.addedNodes;',
      after: removal + '                var addedNodes = _a.addedNodes;',
    },
    {
      before:
        '            entries.forEach(function (entry) {\n                observer.next(entry);',
      after:
        '            entries.forEach(function (entry) {\n                if (entry.isIntersecting && !entry.target.isConnected) return;\n                observer.next(entry);',
    },
  ];
  let body = source.slice(start, end);
  if (body.includes(previousRemoval)) {
    const previousPatches = [
      { ...patches[0], after: previousRemoval + patches[0].before },
      patches[1],
    ];
    verifiedTransform(body, REMOVAL_MARKER, previousPatches);
    for (const patch of [...previousPatches].reverse())
      body = replaceOnce(body, patch.after, patch.before);
  }
  return (
    source.slice(0, start) + verifiedTransform(body, REMOVAL_MARKER, patches) + source.slice(end)
  );
}
export function planAmplitudeLifecyclePatch(packageRoot) {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!SUPPORTED_AMPLITUDE_AUTOCAPTURE_VERSIONS.includes(pkg.version))
    throw new Error('Unsupported Amplitude autocapture version ' + pkg.version);
  return ['esm', 'cjs'].flatMap((format) =>
    [
      ['autocapture/track-rage-click.js', transformAmplitudeRageClick],
      ['autocapture/track-exposure.js', transformAmplitudeExposure],
      ['observables.js', transformAmplitudeExposureObservable],
    ].map(([entry, transform]) => {
      const file = path.join(packageRoot, 'lib', format, entry);
      const before = readFileSync(file, 'utf8');
      return { path: file, before, after: transform(before, pkg.version) };
    }),
  );
}
