import { readFileSync } from 'node:fs';
import path from 'node:path';
const VERSION = '2.0.0-alpha.40';
const MARKER = '/* rose-replay-document-lifecycle */';
const PATCHES = [
  {
    before: '  removeNodeFromMap(n2) {\n    const id = this.getId(n2);',
    after:
      '  removeNodeFromMap(n2) {\n    /* rose-replay-document-lifecycle */\n    let iframeDocument = null;\n    if (n2.nodeName === "IFRAME") {\n      try { iframeDocument = n2.contentDocument; }\n      catch (error) { if (error?.name !== "SecurityError") throw error; }\n    }\n    if (iframeDocument) this.removeNodeFromMap(iframeDocument);\n    const id = this.getId(n2);',
  },
  {
    before:
      '      while (this.mapRemoves.length) {\n        this.mirror.removeNodeFromMap(this.mapRemoves.shift());\n      }',
    after:
      '      while (this.mapRemoves.length) {\n        const removed = this.mapRemoves.shift();\n        if (!removed.isConnected) this.iframeManager.removeIframe(removed);\n        this.mirror.removeNodeFromMap(removed);\n      }',
  },
  {
    before: '  return observer;\n}\nfunction initMoveObserver',
    after:
      '  const disconnect = observer.disconnect.bind(observer);\n  observer.disconnect = () => {\n    disconnect();\n    const index = mutationBuffers.indexOf(mutationBuffer);\n    if (index !== -1) mutationBuffers.splice(index, 1);\n  };\n  return observer;\n}\nfunction initMoveObserver',
  },
  {
    before:
      '    mutationBuffers.forEach((b) => b.reset());\n    mutationObserver == null ? void 0 : mutationObserver.disconnect();',
    after:
      '    if (o2.doc === document) {\n      o2.shadowDomManager.reset();\n      o2.canvasManager.reset();\n    }\n    mutationObserver == null ? void 0 : mutationObserver.disconnect();',
  },
  {
    before: '  addLoadListener(cb) {\n    this.loadListener = cb;\n  }\n  attachIframe',
    after:
      '  addLoadListener(cb) {\n    this.loadListener = cb;\n  }\n  addUnloadListener(cb) {\n    this.unloadListener = cb;\n  }\n  removeIframe(node) {\n    if (node.nodeName === "IFRAME") this.unloadListener?.(node);\n    node.childNodes?.forEach((child) => this.removeIframe(child));\n  }\n  attachIframe',
  },
  {
    before:
      'class ShadowDomManager {\n  constructor(options) {\n    __publicField(this, "shadowDoms", /* @__PURE__ */ new WeakSet());\n    __publicField(this, "mutationCb");\n    __publicField(this, "scrollCb");\n    __publicField(this, "bypassOptions");\n    __publicField(this, "mirror");\n    __publicField(this, "restoreHandlers", []);\n    this.mutationCb = options.mutationCb;\n    this.scrollCb = options.scrollCb;\n    this.bypassOptions = options.bypassOptions;\n    this.mirror = options.mirror;\n    this.init();\n  }\n  init() {\n    this.reset();\n    this.patchAttachShadow(Element, document);\n  }\n  addShadowRoot(shadowRoot2, doc) {\n    if (!isNativeShadowDom(shadowRoot2)) return;\n    if (this.shadowDoms.has(shadowRoot2)) return;\n    this.shadowDoms.add(shadowRoot2);\n    const observer = initMutationObserver(\n      {\n        ...this.bypassOptions,\n        doc,\n        mutationCb: this.mutationCb,\n        mirror: this.mirror,\n        shadowDomManager: this\n      },\n      shadowRoot2\n    );\n    this.restoreHandlers.push(() => observer.disconnect());\n    this.restoreHandlers.push(\n      initScrollObserver({\n        ...this.bypassOptions,\n        scrollCb: this.scrollCb,\n        // https://gist.github.com/praveenpuglia/0832da687ed5a5d7a0907046c9ef1813\n        // scroll is not allowed to pass the boundary, so we need to listen the shadow document\n        doc: shadowRoot2,\n        mirror: this.mirror\n      })\n    );\n    setTimeout(() => {\n      if (shadowRoot2.adoptedStyleSheets && shadowRoot2.adoptedStyleSheets.length > 0)\n        this.bypassOptions.stylesheetManager.adoptStyleSheets(\n          shadowRoot2.adoptedStyleSheets,\n          this.mirror.getId(index.host(shadowRoot2))\n        );\n      this.restoreHandlers.push(\n        initAdoptedStyleSheetObserver(\n          {\n            mirror: this.mirror,\n            stylesheetManager: this.bypassOptions.stylesheetManager\n          },\n          shadowRoot2\n        )\n      );\n    }, 0);\n  }\n  /**\n   * Monkey patch \'attachShadow\' of an IFrameElement to observe newly added shadow doms.\n   */\n  observeAttachShadow(iframeElement) {\n    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;\n    this.patchAttachShadow(\n      iframeElement.contentWindow.Element,\n      iframeElement.contentDocument\n    );\n  }\n  /**\n   * Patch \'attachShadow\' to observe newly added shadow doms.\n   */\n  patchAttachShadow(element, doc) {\n    const manager = this;\n    this.restoreHandlers.push(\n      patch(\n        element.prototype,\n        "attachShadow",\n        function(original) {\n          return function(option) {\n            const sRoot = original.call(this, option);\n            const shadowRootEl = index.shadowRoot(this);\n            if (shadowRootEl && inDom(this))\n              manager.addShadowRoot(shadowRootEl, doc);\n            return sRoot;\n          };\n        }\n      )\n    );\n  }\n  reset() {\n    this.restoreHandlers.forEach((handler) => {\n      try {\n        handler();\n      } catch (e2) {\n      }\n    });\n    this.restoreHandlers = [];\n    this.shadowDoms = /* @__PURE__ */ new WeakSet();\n  }\n}\n',
    after:
      'class ShadowDomManager {\n  constructor(options) {\n    __publicField(this, "shadowDoms", /* @__PURE__ */ new WeakSet());\n    __publicField(this, "mutationCb");\n    __publicField(this, "scrollCb");\n    __publicField(this, "bypassOptions");\n    __publicField(this, "mirror");\n    __publicField(this, "restoreHandlers", /* @__PURE__ */ new Map());\n    __publicField(this, "shadowRootsByDocument", /* @__PURE__ */ new WeakMap());\n    this.mutationCb = options.mutationCb;\n    this.scrollCb = options.scrollCb;\n    this.bypassOptions = options.bypassOptions;\n    this.mirror = options.mirror;\n    this.init();\n  }\n  init() {\n    this.reset();\n    this.patchAttachShadow(Element, document);\n  }\n  addShadowRoot(shadowRoot2, doc) {\n    if (!isNativeShadowDom(shadowRoot2)) return;\n    if (this.shadowDoms.has(shadowRoot2)) return;\n    this.shadowDoms.add(shadowRoot2);\n    let roots = this.shadowRootsByDocument.get(doc);\n    if (!roots) this.shadowRootsByDocument.set(doc, roots = new Set());\n    roots.add(shadowRoot2);\n    const observer = initMutationObserver(\n      {\n        ...this.bypassOptions,\n        doc,\n        mutationCb: this.mutationCb,\n        mirror: this.mirror,\n        shadowDomManager: this\n      },\n      shadowRoot2\n    );\n    this.addCleanup(doc, () => observer.disconnect());\n    this.addCleanup(doc,\n      initScrollObserver({\n        ...this.bypassOptions,\n        scrollCb: this.scrollCb,\n        // https://gist.github.com/praveenpuglia/0832da687ed5a5d7a0907046c9ef1813\n        // scroll is not allowed to pass the boundary, so we need to listen the shadow document\n        doc: shadowRoot2,\n        mirror: this.mirror\n      })\n    );\n    const timer = setTimeout(() => {\n      if (shadowRoot2.adoptedStyleSheets && shadowRoot2.adoptedStyleSheets.length > 0)\n        this.bypassOptions.stylesheetManager.adoptStyleSheets(\n          shadowRoot2.adoptedStyleSheets,\n          this.mirror.getId(index.host(shadowRoot2))\n        );\n      this.addCleanup(doc,\n        initAdoptedStyleSheetObserver(\n          {\n            mirror: this.mirror,\n            stylesheetManager: this.bypassOptions.stylesheetManager\n          },\n          shadowRoot2\n        )\n      );\n    }, 0);\n    this.addCleanup(doc, () => clearTimeout(timer));\n  }\n  /**\n   * Monkey patch \'attachShadow\' of an IFrameElement to observe newly added shadow doms.\n   */\n  observeAttachShadow(iframeElement) {\n    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;\n    this.patchAttachShadow(\n      iframeElement.contentWindow.Element,\n      iframeElement.contentDocument\n    );\n  }\n  /**\n   * Patch \'attachShadow\' to observe newly added shadow doms.\n   */\n  patchAttachShadow(element, doc) {\n    const manager = this;\n    this.addCleanup(doc,\n      patch(\n        element.prototype,\n        "attachShadow",\n        function(original) {\n          return function(option) {\n            const sRoot = original.call(this, option);\n            const shadowRootEl = index.shadowRoot(this);\n            if (shadowRootEl && inDom(this))\n              manager.addShadowRoot(shadowRootEl, doc);\n            return sRoot;\n          };\n        }\n      )\n    );\n  }\n  addCleanup(doc, handler) {\n    let handlers = this.restoreHandlers.get(doc);\n    if (!handlers) this.restoreHandlers.set(doc, handlers = new Set());\n    handlers.add(handler);\n  }\n  removeDocument(doc) {\n    const handlers = this.restoreHandlers.get(doc);\n    this.restoreHandlers.delete(doc);\n    handlers?.forEach((handler) => {\n      try { handler(); } catch (e2) {}\n    });\n    this.shadowRootsByDocument.get(doc)?.forEach((root) => this.shadowDoms.delete(root));\n    this.shadowRootsByDocument.delete(doc);\n  }\n  reset() {\n    [...this.restoreHandlers.keys()].forEach((doc) => this.removeDocument(doc));\n    this.shadowDoms = /* @__PURE__ */ new WeakSet();\n  }\n}\n',
  },
  {
    before: '  try {\n    const handlers = [];\n    const observe = (doc) => {',
    after:
      '  try {\n    const handlers = /* @__PURE__ */ new Set();\n    const observedIframes = /* @__PURE__ */ new WeakMap();\n    const observe = (doc) => {',
  },
  {
    before:
      '    iframeManager.addLoadListener((iframeEl) => {\n      try {\n        handlers.push(observe(iframeEl.contentDocument));\n      } catch (error) {\n        console.warn(error);\n      }\n    });',
    after:
      '    iframeManager.addUnloadListener((iframeEl) => {\n      observedIframes.get(iframeEl)?.release();\n    });\n    iframeManager.addLoadListener((iframeEl) => {\n      try {\n        const doc = iframeEl.contentDocument;\n        if (!doc || !iframeEl.isConnected) return;\n        const previous = observedIframes.get(iframeEl);\n        if (previous?.doc === doc) return;\n        previous?.release();\n        const stop = observe(doc);\n        let active = true;\n        const release = () => {\n          if (!active) return;\n          active = false;\n          observedIframes.delete(iframeEl);\n          handlers.delete(release);\n          iframeManager.removeIframe(doc);\n          stop();\n          shadowDomManager.removeDocument(doc);\n          mirror.removeNodeFromMap(doc);\n        };\n        observedIframes.set(iframeEl, { doc, release });\n        handlers.add(release);\n      } catch (error) {\n        console.warn(error);\n      }\n    });',
  },
  {
    before: '      handlers.push(observe(document));',
    after: '      handlers.add(observe(document));',
  },
  {
    before: '      handlers.push(\n        on("DOMContentLoaded"',
    after: '      handlers.add(\n        on("DOMContentLoaded"',
  },
  {
    before: '      handlers.push(\n        on(\n          "load"',
    after: '      handlers.add(\n        on(\n          "load"',
  },
  {
    before: '      handlers.forEach((h) => h());\n      processedNodeManager.destroy();',
    after:
      '      handlers.forEach((h) => h());\n      mirror.reset();\n      processedNodeManager.destroy();',
  },
];
function once(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error('Unsupported replay lifecycle source: ' + before.slice(0, 80));
  return source.replace(before, after);
}
function transformDocumentLifecycle(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2) throw new Error('Duplicate replay lifecycle marker');
    let original = source;
    for (const patch of [...PATCHES].reverse())
      original = once(original, patch.after, patch.before);
    if (transformDocumentLifecycle(original) !== source)
      throw new Error('Partial replay lifecycle patch');
    return source;
  }
  for (const patch of PATCHES) source = once(source, patch.before, patch.after);
  return source;
}
const GENERATION_MARKER = '/* rose-replay-generation */';
const GENERATION_PATCHES = [
  {
    before: '  reset() {\n    this.idNodeMap = /* @__PURE__ */ new Map();',
    after:
      '  reset() {\n    /* rose-replay-generation */\n    this.__roseReplayGeneration = (this.__roseReplayGeneration || 0) + 1;\n    this.idNodeMap = /* @__PURE__ */ new Map();',
  },
  {
    before:
      '  if (serializedNode.type === NodeType$3.Element && serializedNode.tagName === "iframe") {\n    onceIframeLoaded(\n      n2,\n      () => {\n        const iframeDoc = n2.contentDocument;',
    after:
      '  if (serializedNode.type === NodeType$3.Element && serializedNode.tagName === "iframe") {\n    const replayGeneration = mirror2.__roseReplayGeneration;\n    onceIframeLoaded(\n      n2,\n      () => {\n        if (mirror2.__roseReplayGeneration !== replayGeneration) return;\n        const iframeDoc = n2.contentDocument;',
  },
];
function applyGeneration(source) {
  for (const patch of GENERATION_PATCHES) source = once(source, patch.before, patch.after);
  return source;
}
export function transformReplayLifecycle(source) {
  // Validate the complete existing document repair before upgrading its lifetime guard.
  const repaired = transformDocumentLifecycle(source);
  if (!repaired.includes(GENERATION_MARKER)) return applyGeneration(repaired);
  if (repaired.split(GENERATION_MARKER).length !== 2)
    throw new Error('Duplicate replay generation marker');
  let previous = repaired;
  for (const patch of [...GENERATION_PATCHES].reverse())
    previous = once(previous, patch.after, patch.before);
  if (applyGeneration(previous) !== repaired) throw new Error('Partial replay generation repair');
  return repaired;
}
export function planReplayLifecyclePatch(packageRoot) {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== '@amplitude/rrweb-record' || pkg.version !== VERSION)
    throw new Error('Unsupported replay package: ' + pkg.version);
  return ['dist/rrweb-record.js', 'dist/rrweb-record.cjs'].map((entry) => {
    const file = path.join(packageRoot, entry),
      before = readFileSync(file, 'utf8');
    return { path: file, before, after: transformReplayLifecycle(before) };
  });
}
