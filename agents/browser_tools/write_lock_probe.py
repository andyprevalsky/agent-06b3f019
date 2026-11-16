"""Resolve what a browser action would actually commit, for the write-lock gate.

The write-lock classifiers in ``write_lock.py`` judge a label. This module
decides WHICH label: the control a click lands on (not every element under
the pointer, not hidden descendants, not neighbouring cards), or the control
an Enter key would activate (the form's default button, not every button in
the form; a form without one leaves Enter to page script, so its buttons all
count). It also recognizes clicks into a text field, which cannot commit,
and hyperlinks, which cannot post or send.

Two sources produce the same "control facts" dict:

* ``element_control_facts`` reads the cached browser-use DOM node of an index
  click. Its ``ax_node.name`` is Chrome's computed accessible name.
* ``probe_click_target`` / ``probe_enter_target`` run ``PROBE_JS`` in the live
  page over CDP for coordinate clicks and Enter, where only the page knows the
  hit element (through shadow roots and same-origin frames), the focused
  element, and the form's default button.

``target_from_facts`` turns those facts into the signals the classifiers read.
Every function returns ``None`` when it cannot resolve the target (including a
point or focus inside a cross-origin frame) so callers keep their previous
signal. The one exception: a click the page cannot see into is hit-tested
through the frame over CDP, and a hit on a text field resolves to "cannot
commit" so page prose around the frame is never read as its label.

    action ──► facts (cached AX node │ live PROBE_JS) ──► WriteLockTarget
                                                          ├─ commits=False → no lock
                                                          └─ label / return_signal → classifiers
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

_PAGE_CONTAINER_TAGS = frozenset({"html", "body", "main"})
_CONTROL_TAGS = frozenset({"button", "input", "select", "textarea", "summary"})
_CONTROL_ROLES = frozenset(
    {
        "button",
        "link",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "tab",
        "checkbox",
        "radio",
        "switch",
        "option",
        "textbox",
        "searchbox",
        "combobox",
    }
)
_EDITABLE_ROLES = frozenset({"textbox", "searchbox", "combobox"})
_CONTENTEDITABLE_VALUES = frozenset({"", "true", "plaintext-only"})
_NON_TEXT_INPUT_TYPES = frozenset(
    {
        "submit",
        "reset",
        "button",
        "image",
        "checkbox",
        "radio",
        "file",
        "range",
        "color",
        "hidden",
    }
)
_CONTEXT_ID_DEPTH = 6
_WRAPPER_DEPTH = 3
_WRAPPER_MAX_CHARS = 200
_GENERIC_NAME_MAX_CHARS = 200
_FRAME_HOPS = 4
_FRAME_PROBE_TIMEOUT_S = 5.0


@dataclass(frozen=True)
class WriteLockTarget:
    """What an action would commit, as seen by the write-lock classifiers."""

    commits: bool
    label: str = ""
    return_signal: str = ""
    reason: str = ""
    navigates: bool = False


def _collapse(value: Any) -> str:
    return " ".join(str(value or "").split())


def target_from_facts(facts: dict, *, typing: bool = False) -> WriteLockTarget:
    """Build classifier signals from control facts.

    ``label`` is the accessible name. A nameless control falls back to its
    ids/names, the label of a wrapper that holds no other control, and a
    ``submit`` marker. ``return_signal`` adds the submit marker and the
    composed ancestor ids that the return-commit rules key on. ``typing`` is
    True when the subject is the field receiving an Enter key, which may submit
    through page script even though clicking into the field never commits.

    A hyperlink still commits: page script can turn a link click into a charge,
    so ``navigates`` only tells the gate that posting/sending verbs on it name
    a destination (a composer), not a submit.
    """
    if facts.get("editable") and not typing:
        return WriteLockTarget(commits=False, reason="focuses an editable field")
    name = _collapse(facts.get("name"))
    ids = [_collapse(value) for value in facts.get("ids") or [] if _collapse(value)]
    submit = ["submit"] if facts.get("submitter") else []
    if name:
        label = name
    else:
        label = "\n".join(part for part in (*ids, _collapse(facts.get("wrapper")), *submit) if part)
    return_signal = "\n".join(part for part in (label, *submit, *ids) if part)
    navigates = bool(facts.get("navigates"))
    return WriteLockTarget(
        commits=True,
        label=label,
        return_signal=return_signal,
        reason="hyperlink navigation" if navigates else "",
        navigates=navigates,
    )


# ── Cached DOM node (index clicks) ───────────────────────────────────────────


def _tag(node: Any) -> str:
    return str(getattr(node, "tag_name", "") or getattr(node, "node_name", "") or "").lower()


def _attrs(node: Any) -> dict:
    attrs = getattr(node, "attributes", None) or {}
    return attrs if isinstance(attrs, dict) else {}


def _role(node: Any) -> str:
    return (str(_attrs(node).get("role") or "").strip().lower().split() or [""])[0]


def _node_text(node: Any) -> str:
    try:
        return _collapse(node.get_all_children_text())
    except Exception:
        return ""


def _is_control_node(node: Any) -> bool:
    tag = _tag(node)
    attrs = _attrs(node)
    if tag in {"a", "area"}:
        return "href" in attrs
    if tag in _CONTROL_TAGS or _role(node) in _CONTROL_ROLES:
        return True
    contenteditable = attrs.get("contenteditable")
    return contenteditable is not None and str(contenteditable).lower() in _CONTENTEDITABLE_VALUES


def _navigates(tag: str, attrs: dict, role: str) -> bool:
    if tag not in {"a", "area"} or (role and role != "link"):
        return False
    href = str(attrs.get("href") or "").strip().lower()
    if not href or href.startswith(("#", "javascript:")):
        return False
    method = str(attrs.get("data-method") or "").strip().lower()
    if method and method != "get":
        return False
    return "onclick" not in attrs


def _editable(tag: str, attrs: dict, role: str) -> bool:
    if tag == "textarea":
        return True
    if tag == "input":
        return str(attrs.get("type") or "text").strip().lower() not in _NON_TEXT_INPUT_TYPES
    contenteditable = attrs.get("contenteditable")
    if contenteditable is not None and str(contenteditable).lower() in _CONTENTEDITABLE_VALUES:
        return True
    return role in _EDITABLE_ROLES


def _ancestors(node: Any, depth: int):
    current = getattr(node, "parent_node", None)
    for _ in range(depth):
        if current is None:
            return
        yield current
        current = getattr(current, "parent_node", None)


def _has_form_ancestor(node: Any) -> bool:
    return any(_tag(ancestor) == "form" for ancestor in _ancestors(node, 32))


def _submitter(node: Any, tag: str, attrs: dict) -> bool:
    input_type = str(attrs.get("type") or "").strip().lower()
    if tag == "input":
        return input_type in {"submit", "image"}
    if tag == "button":
        return input_type == "submit" or (not input_type and _has_form_ancestor(node))
    return False


def _context_ids(node: Any) -> list[str]:
    ids: list[str] = []
    for current in (node, *_ancestors(node, _CONTEXT_ID_DEPTH - 1)):
        if _tag(current) in _PAGE_CONTAINER_TAGS:
            break
        for attr_name in ("id", "name"):
            value = _collapse(_attrs(current).get(attr_name))
            if value and value not in ids:
                ids.append(value)
    return ids


def _subtree_has_other_control(root: Any, element: Any) -> bool:
    stack = list(getattr(root, "children_and_shadow_roots", None) or [])
    while stack:
        node = stack.pop()
        if node is element:
            continue
        if _is_control_node(node):
            return True
        stack.extend(getattr(node, "children_and_shadow_roots", None) or [])
    return False


def _wrapper_label(element: Any) -> str:
    """Text of the nearest small wrapper that labels only this control."""
    for ancestor in _ancestors(element, _WRAPPER_DEPTH):
        if _tag(ancestor) in _PAGE_CONTAINER_TAGS or _is_control_node(ancestor):
            return ""
        if _subtree_has_other_control(ancestor, element):
            return ""
        text = _node_text(ancestor)
        if text:
            return text if len(text) <= _WRAPPER_MAX_CHARS else ""
    return ""


def element_control_facts(element: Any) -> Optional[dict]:
    """Control facts for a cached browser-use DOM node, or None without an AX name."""
    ax_node = getattr(element, "ax_node", None)
    name = getattr(ax_node, "name", None) if ax_node is not None else None
    if not isinstance(name, str):
        return None
    ax_role = getattr(ax_node, "role", None)
    ax_role = ax_role.lower() if isinstance(ax_role, str) else ""
    tag = _tag(element)
    attrs = _attrs(element)
    role = _role(element)
    name = _collapse(name)
    is_control = _is_control_node(element)
    if not name and not is_control:
        # Chrome computes no name from content for generic roles, so a <div>
        # with a click handler is labelled by its own text.
        text = _node_text(element)
        name = text if len(text) <= _GENERIC_NAME_MAX_CHARS else ""
    return {
        "tag": tag,
        "role": role or ax_role,
        "name": name,
        "navigates": _navigates(tag, attrs, role),
        "editable": _editable(tag, attrs, role or ax_role),
        "submitter": _submitter(element, tag, attrs),
        "ids": _context_ids(element),
        "wrapper": "" if name else _wrapper_label(element),
    }


def element_click_target(element: Any) -> Optional[WriteLockTarget]:
    facts = element_control_facts(element)
    return target_from_facts(facts) if facts is not None else None


# ── Live page probe (coordinate clicks, Enter) ───────────────────────────────

PROBE_JS = r"""
function (mode, intent, x, y) {
    const MAX_DEPTH = 8;
    const CONTROL_SELECTOR = [
        'button', 'input', 'select', 'textarea', 'summary', 'a[href]', 'area[href]',
        '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
        '[role="switch"]', '[role="option"]', '[role="textbox"]', '[role="searchbox"]',
        '[role="combobox"]', '[contenteditable=""]', '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
    ].join(',');
    const NON_TEXT_INPUT_TYPES = new Set(['submit', 'reset', 'button', 'image', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden']);
    const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
    const PAGE_CONTAINERS = new Set(['html', 'body', 'main']);
    const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'select', 'datalist', 'head', 'input', 'textarea']);

    const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isElement = (node) => !!node && node.nodeType === 1;
    const composedParent = (el) => {
        if (el.assignedSlot) return el.assignedSlot;
        if (el.parentElement) return el.parentElement;
        const root = el.getRootNode && el.getRootNode();
        return root && root.host ? root.host : null;
    };
    const roleOf = (el) => (collapse(el.getAttribute('role')).toLowerCase().split(' ')[0] || '');
    const isControl = (el) => isElement(el) && el.matches(CONTROL_SELECTOR);
    const isEditable = (el) => {
        const tag = el.localName;
        if (tag === 'textarea') return true;
        if (tag === 'input') return !NON_TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
        if (el.isContentEditable) return true;
        return EDITABLE_ROLES.has(roleOf(el));
    };
    const isSubmitter = (el) => {
        const tag = el.localName;
        const type = collapse(el.getAttribute('type')).toLowerCase();
        if (tag === 'input') return type === 'submit' || type === 'image';
        if (tag === 'button') return type === 'submit' || (!type && !!el.form);
        return false;
    };
    const navigates = (el) => {
        const tag = el.localName;
        if (tag !== 'a' && tag !== 'area') return false;
        const role = roleOf(el);
        if (role && role !== 'link') return false;
        const href = collapse(el.getAttribute('href')).toLowerCase();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
        const method = collapse(el.getAttribute('data-method')).toLowerCase();
        if (method && method !== 'get') return false;
        return !el.hasAttribute('onclick');
    };
    const hidden = (el) => {
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
        const style = getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    };
    const pseudoText = (el, which) => {
        const content = getComputedStyle(el, which).content;
        if (!content || content === 'none' || content === 'normal') return '';
        const quoted = content.match(/^"([\s\S]*)"$/);
        return quoted ? quoted[1] : '';
    };
    // Name-from-content: visible text through shadow roots and slots, image alt
    // text, svg titles, and CSS generated content; hidden subtrees are skipped.
    const textOf = (node, depth, budget) => {
        if (!node || depth > 32 || budget.left <= 0) return '';
        if (node.nodeType === 3) {
            budget.left -= node.data.length;
            return node.data;
        }
        if (node.nodeType === 11) return Array.from(node.childNodes).map((child) => textOf(child, depth + 1, budget)).join('');
        if (!isElement(node)) return '';
        const tag = node.localName;
        if (tag === 'img' || tag === 'area' || (tag === 'input' && node.type === 'image')) {
            return hidden(node) ? '' : ` ${collapse(node.getAttribute('alt'))} `;
        }
        if (SKIP_TAGS.has(tag) || hidden(node)) return '';
        if (depth > 0) {
            const label = collapse(node.getAttribute('aria-label'));
            if (label) return ` ${label} `;
        }
        if (tag === 'svg') {
            const title = node.querySelector('title');
            return title ? ` ${collapse(title.textContent)} ` : '';
        }
        if (tag === 'br') return ' ';
        let children;
        if (tag === 'slot') {
            children = node.assignedNodes({flatten: true});
            if (!children.length) children = Array.from(node.childNodes);
        } else if (node.shadowRoot) {
            children = Array.from(node.shadowRoot.childNodes);
        } else {
            children = Array.from(node.childNodes);
        }
        const display = getComputedStyle(node).display || '';
        const gap = display.startsWith('inline') || display === 'contents' ? '' : ' ';
        const inner = children.map((child) => textOf(child, depth + 1, budget)).join('');
        return gap + pseudoText(node, '::before') + inner + pseudoText(node, '::after') + gap;
    };
    const byIds = (el, ids) => {
        const root = el.getRootNode();
        return collapse(ids.split(/\s+/).filter(Boolean).map((id) => {
            const target = (root.getElementById && root.getElementById(id)) || document.getElementById(id);
            if (!target) return '';
            return hidden(target) ? target.textContent : textOf(target, 1, {left: 2000});
        }).join(' '));
    };
    const accName = (el) => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const name = byIds(el, labelledBy);
            if (name) return name;
        }
        const ariaLabel = collapse(el.getAttribute('aria-label'));
        if (ariaLabel) return ariaLabel;
        const tag = el.localName;
        if (tag === 'input' && ['submit', 'reset', 'button'].includes(el.type)) {
            const value = collapse(el.value);
            if (value) return value;
            if (el.type === 'submit') return 'Submit';
            if (el.type === 'reset') return 'Reset';
        }
        if ((tag === 'input' && el.type === 'image') || tag === 'img') {
            const alt = collapse(el.getAttribute('alt'));
            if (alt) return alt;
        }
        if (el.labels && el.labels.length) {
            const name = collapse(Array.from(el.labels).map((label) => textOf(label, 1, {left: 2000})).join(' '));
            if (name) return name;
        }
        const editable = isEditable(el);
        if (!editable) {
            const name = collapse(textOf(el, 0, {left: 2000}));
            if (name && (isControl(el) || name.length <= 200)) return name.slice(0, 500);
        }
        const title = collapse(el.getAttribute('title'));
        if (title) return title;
        if (editable) return collapse(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
        return '';
    };
    const contextIds = (el) => {
        const ids = [];
        let node = el;
        for (let depth = 0; node && depth < 6; depth += 1) {
            if (PAGE_CONTAINERS.has(node.localName)) break;
            for (const attr of ['id', 'name']) {
                const value = collapse(node.getAttribute(attr));
                if (value && !ids.includes(value)) ids.push(value);
            }
            node = composedParent(node);
        }
        return ids;
    };
    const containsOtherControl = (container, el) => {
        const scan = (root) => {
            for (const candidate of root.querySelectorAll(CONTROL_SELECTOR)) {
                if (candidate !== el && !el.contains(candidate)) return true;
            }
            for (const host of root.querySelectorAll('*')) {
                if (host.shadowRoot && host.shadowRoot !== el.getRootNode() && scan(host.shadowRoot)) return true;
            }
            return false;
        };
        return scan(container) || (!!container.shadowRoot && scan(container.shadowRoot));
    };
    const wrapperLabel = (el) => {
        let node = composedParent(el);
        for (let depth = 0; node && depth < 3; depth += 1) {
            if (PAGE_CONTAINERS.has(node.localName) || isControl(node) || containsOtherControl(node, el)) return '';
            const text = collapse(textOf(node, 0, {left: 400}));
            if (text) return text.length <= 200 ? text : '';
            node = composedParent(node);
        }
        return '';
    };
    const describe = (el) => {
        const name = accName(el);
        return {
            tag: el.localName,
            role: roleOf(el),
            name,
            navigates: navigates(el),
            editable: isEditable(el),
            submitter: isSubmitter(el),
            ids: contextIds(el),
            wrapper: name ? '' : wrapperLabel(el),
        };
    };
    // The control a pointer event lands on: the nearest semantic control, else
    // the top of the pointer-cursor box (script-driven <div> buttons), else the
    // hit element itself. Page containers are never a click target label.
    const clickSubject = (start) => {
        let node = start;
        for (let depth = 0; node && depth < MAX_DEPTH; depth += 1) {
            if (PAGE_CONTAINERS.has(node.localName)) break;
            if (isControl(node)) return node;
            node = composedParent(node);
        }
        let pointer = null;
        node = start;
        for (let depth = 0; node && depth < MAX_DEPTH; depth += 1) {
            if (PAGE_CONTAINERS.has(node.localName) || getComputedStyle(node).cursor !== 'pointer') break;
            pointer = node;
            node = composedParent(node);
        }
        if (pointer) return pointer;
        return start && !PAGE_CONTAINERS.has(start.localName) ? start : null;
    };
    const deepFromPoint = (px, py) => {
        let el = document.elementFromPoint(px, py);
        for (let hops = 0; el && hops < 16; hops += 1) {
            if (el.shadowRoot) {
                const inner = el.shadowRoot.elementFromPoint(px, py);
                if (inner && inner !== el) {
                    el = inner;
                    continue;
                }
            }
            if (el.localName === 'iframe' || el.localName === 'frame') {
                let inner = null;
                try {
                    const frameDoc = el.contentDocument;
                    if (frameDoc) {
                        const box = el.getBoundingClientRect();
                        px -= box.left + el.clientLeft;
                        py -= box.top + el.clientTop;
                        inner = frameDoc.elementFromPoint(px, py);
                    }
                } catch (error) {
                    inner = null;
                }
                if (inner) {
                    el = inner;
                    continue;
                }
            }
            break;
        }
        return el;
    };
    const deepActive = () => {
        let el = document.activeElement;
        for (let hops = 0; el && hops < 16; hops += 1) {
            if (el.shadowRoot && el.shadowRoot.activeElement) {
                el = el.shadowRoot.activeElement;
                continue;
            }
            if (el.localName === 'iframe' || el.localName === 'frame') {
                let inner = null;
                try {
                    inner = el.contentDocument && el.contentDocument.activeElement;
                } catch (error) {
                    inner = null;
                }
                if (inner) {
                    el = inner;
                    continue;
                }
            }
            break;
        }
        return el;
    };
    // A form with no submit button gives Enter no default action, so page script
    // decides what it triggers (chat composers send through a type="button").
    // Every visible button the form owns is a candidate.
    const formButtonNames = (form) => {
        const names = [];
        const candidates = new Set([...Array.from(form.elements), ...Array.from(form.querySelectorAll('[role="button"]'))]);
        for (const el of candidates) {
            const button = el.localName === 'button' || (el.localName === 'input' && el.type === 'button') || roleOf(el) === 'button';
            if (!button || hidden(el)) continue;
            const name = accName(el);
            if (name && !names.includes(name)) names.push(name);
            if (names.length >= 10) break;
        }
        return names;
    };
    // Enter semantics (HTML implicit submission): a single-line field in a form
    // activates the form's default button (first submit button in tree order);
    // any other field receives the key itself; a focused control is activated.
    const enterSubject = (focus) => {
        if (!focus || PAGE_CONTAINERS.has(focus.localName)) return {via: 'none', subject: null, multiline: false};
        if (isEditable(focus)) {
            const defaultButton = focus.form ? Array.from(focus.form.elements).find(isSubmitter) : null;
            if (defaultButton && focus.localName === 'input') {
                return {via: 'default_button', subject: defaultButton, multiline: false};
            }
            const multiline = focus.localName === 'textarea'
                || (focus.localName !== 'input' && (focus.isContentEditable || focus.getAttribute('aria-multiline') === 'true'));
            const formButtons = focus.form && !defaultButton ? formButtonNames(focus.form) : [];
            return {via: 'field', subject: focus, multiline, formButtons};
        }
        return {via: 'control', subject: clickSubject(focus), multiline: false};
    };

    let start = mode === 'element' ? this : (mode === 'point' ? deepFromPoint(Number(x), Number(y)) : deepActive());
    if (start && !isElement(start)) start = start.parentElement;
    // The frame probe asks for the hit frame element itself, to look inside it.
    if (intent === 'frame_owner') return start && (start.localName === 'iframe' || start.localName === 'frame') ? start : null;
    // A cross-origin frame hides the element actually hit or focused; its title
    // says nothing about that control, so leave the target unresolved.
    if (start && mode !== 'element' && (start.localName === 'iframe' || start.localName === 'frame')) {
        return JSON.stringify({ok: false, reason: 'opaque_frame'});
    }
    let resolved;
    if (intent === 'enter') {
        resolved = enterSubject(mode === 'point' && start ? clickSubject(start) : start);
    } else {
        const subject = start ? clickSubject(start) : null;
        resolved = {via: subject ? 'control' : 'none', subject, multiline: false};
    }
    return JSON.stringify({
        ok: true,
        via: resolved.via,
        multiline: !!resolved.multiline,
        target: resolved.subject ? describe(resolved.subject) : null,
        form_buttons: resolved.formButtons || [],
    });
}
"""


async def _run_probe(session: Any, *, element: Any, coords: Optional[dict], intent: str) -> Optional[dict]:
    mode = "element" if element is not None else ("point" if coords else "focus")
    x = int(coords["x"]) if coords else 0
    y = int(coords["y"]) if coords else 0
    try:
        if element is not None:
            cdp_session = await session.cdp_client_for_node(element)
            resolved = await cdp_session.cdp_client.send.DOM.resolveNode(
                params={"backendNodeId": element.backend_node_id},
                session_id=cdp_session.session_id,
            )
            response = await cdp_session.cdp_client.send.Runtime.callFunctionOn(
                params={
                    "objectId": resolved["object"]["objectId"],
                    "functionDeclaration": PROBE_JS,
                    "arguments": [{"value": mode}, {"value": intent}, {"value": x}, {"value": y}],
                    "returnByValue": True,
                },
                session_id=cdp_session.session_id,
            )
        else:
            cdp_session = await session.get_or_create_cdp_session(session.agent_focus_target_id, focus=False)
            response = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={
                    "expression": f"({PROBE_JS}).call(null, {json.dumps(mode)}, {json.dumps(intent)}, {x}, {y})",
                    "returnByValue": True,
                },
                session_id=cdp_session.session_id,
            )
        if not isinstance(response, dict) or response.get("exceptionDetails"):
            logger.warning("Write-lock probe raised in page: %s", str(response)[:200])
            return None
        value = (response.get("result") or {}).get("value")
        data = json.loads(value) if isinstance(value, str) else None
    except Exception as error:
        logger.warning("Write-lock probe unavailable (%s): %s", mode, str(error)[:200])
        return None
    if not isinstance(data, dict):
        return None
    if data.get("ok") is not True:
        logger.info("Write-lock probe left the %s target unresolved (%s): %s", intent, mode, data.get("reason"))
        return data if data.get("reason") == "opaque_frame" and intent == "click" else None
    return data


def _parse_probe_response(response: Any) -> Optional[dict]:
    if not isinstance(response, dict) or response.get("exceptionDetails"):
        logger.warning("Write-lock frame probe raised: %s", str(response)[:200])
        return None
    value = (response.get("result") or {}).get("value")
    data = json.loads(value) if isinstance(value, str) else None
    return data if isinstance(data, dict) else None


async def _evaluate_in(cdp_session: Any, context_id: Optional[int], expression: str, *, by_value: bool = True) -> dict:
    params: dict = {"expression": expression, "returnByValue": by_value}
    if context_id is not None:
        params["contextId"] = context_id
    return await cdp_session.cdp_client.send.Runtime.evaluate(params=params, session_id=cdp_session.session_id)


def _probe_expression(intent: str, x: float, y: float) -> str:
    return f"({PROBE_JS}).call(null, 'point', {json.dumps(intent)}, {x}, {y})"


async def _frame_context(session: Any, cdp_session: Any, frame_id: str) -> tuple[Any, Optional[int]]:
    """An out-of-process frame is its own target; an in-process one gets an isolated world in its parent's."""
    infos = (await cdp_session.cdp_client.send.Target.getTargets()).get("targetInfos") or []
    if any(info.get("targetId") == frame_id for info in infos):
        return await session.get_or_create_cdp_session(frame_id, focus=False), None
    world = await cdp_session.cdp_client.send.Page.createIsolatedWorld(
        params={"frameId": frame_id, "worldName": "rose-write-lock-probe"}, session_id=cdp_session.session_id
    )
    return cdp_session, world["executionContextId"]


async def _probe_through_frames(session: Any, x: float, y: float) -> Optional[dict]:
    """Run PROBE_JS inside the cross-origin frame a click lands in, at frame viewport coordinates.

    Every coordinate here is a viewport coordinate: the click point, the
    frame's content box (``DOM.getBoxModel``) and ``elementFromPoint`` inside
    the frame, so page and frame scroll never shift the hit. A CSS-scaled frame
    is mapped through its ``innerWidth`` / ``innerHeight``.
    """
    cdp_session = await session.get_or_create_cdp_session(session.agent_focus_target_id, focus=False)
    context_id: Optional[int] = None
    for _ in range(_FRAME_HOPS):
        send = cdp_session.cdp_client.send
        sid = cdp_session.session_id
        owner = await _evaluate_in(cdp_session, context_id, _probe_expression("frame_owner", x, y), by_value=False)
        object_id = (owner.get("result") or {}).get("objectId")
        if not object_id:
            return None
        try:
            frame_id = (await send.DOM.describeNode(params={"objectId": object_id}, session_id=sid))["node"].get(
                "frameId"
            )
            quad = (await send.DOM.getBoxModel(params={"objectId": object_id}, session_id=sid))["model"]["content"]
        finally:
            await send.Runtime.releaseObject(params={"objectId": object_id}, session_id=sid)
        box_width, box_height = quad[2] - quad[0], quad[5] - quad[1]
        if not frame_id or box_width <= 0 or box_height <= 0:
            return None
        cdp_session, context_id = await _frame_context(session, cdp_session, frame_id)
        size = await _evaluate_in(cdp_session, context_id, "[innerWidth, innerHeight]")
        inner_width, inner_height = (size.get("result") or {}).get("value") or (0, 0)
        if not inner_width or not inner_height:
            return None
        x = (x - quad[0]) * inner_width / box_width
        y = (y - quad[1]) * inner_height / box_height
        data = _parse_probe_response(await _evaluate_in(cdp_session, context_id, _probe_expression("click", x, y)))
        if data is None or data.get("ok") is True:
            return data
        if data.get("reason") != "opaque_frame":
            return None
    return None


async def _cross_origin_field_click(session: Any, coords: dict) -> Optional[WriteLockTarget]:
    """A click the page probe could not see into: ``commits=False`` only when it lands in a text field.

    Fields never commit, so page prose around the frame cannot make that click
    a purchase. Any other control inside the frame (a wallet button), an
    unloaded frame, or an unresolvable hit returns None so the caller keeps
    its page signal.
    """
    try:
        data = await asyncio.wait_for(
            _probe_through_frames(session, float(coords["x"]), float(coords["y"])), _FRAME_PROBE_TIMEOUT_S
        )
    except Exception as error:
        logger.warning("Write-lock frame probe unavailable: %s", str(error)[:200])
        return None
    target = data.get("target") if data else None
    if not isinstance(target, dict) or not target.get("editable"):
        return None
    return target_from_facts(target)


async def probe_click_target(session: Any, coords: Optional[dict]) -> Optional[WriteLockTarget]:
    """Resolve the control a coordinate click lands on in the live page."""
    if not coords:
        return None
    data = await _run_probe(session, element=None, coords=coords, intent="click")
    if data is None:
        return None
    if data.get("reason") == "opaque_frame":
        return await _cross_origin_field_click(session, coords)
    target = data.get("target")
    if not isinstance(target, dict):
        return WriteLockTarget(commits=False, reason="no element at click point")
    return target_from_facts(target)


async def probe_enter_target(
    session: Any,
    *,
    element: Any = None,
    coords: Optional[dict] = None,
    typed_newline: bool = False,
) -> Optional[WriteLockTarget]:
    """Resolve what an Enter key on the focused (or given) field would activate.

    ``typed_newline`` marks a newline inside typed text: in a multi-line field
    that is content, not a submit.
    """
    data = await _run_probe(session, element=element, coords=coords, intent="enter")
    if data is None:
        return None
    target = data.get("target")
    if not isinstance(target, dict):
        return WriteLockTarget(commits=False, reason="nothing focused")
    via = data.get("via")
    if via == "field" and typed_newline and data.get("multiline"):
        return WriteLockTarget(commits=False, reason="newline typed into a multi-line field")
    resolved = target_from_facts(target, typing=via == "field")
    buttons = [name for name in (_collapse(value) for value in data.get("form_buttons") or []) if name]
    if not resolved.commits or not buttons:
        return resolved
    return WriteLockTarget(
        commits=True,
        label="\n".join(part for part in (resolved.label, *buttons) if part),
        return_signal="\n".join(part for part in (resolved.return_signal, *buttons) if part),
        reason=resolved.reason,
        navigates=resolved.navigates,
    )
