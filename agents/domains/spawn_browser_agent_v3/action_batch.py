"""Ordered native decisions reuse the ordinary one-action execution loop.

Queued actions are not durable authority: pause, steering, a changed document,
or any unsuccessful/intercepted action discards the remainder with call IDs.
"""
from copy import deepcopy

from browser_tools.schemas import PHONE_NAVIGATION_OPERATIONS, PHONE_READ_OPERATIONS, phone_call_batchable


CONTINUE_AFTER = frozenset({
    'input_text', 'select_dropdown', 'press_key', 'read_browser_state',
    'screenshot', 'read_network_requests', 'read_console_logs',
})


def _phone_read(action):
    params = action.get('params') or {}
    return action.get('action') == 'phone' and (
        params.get('mode') == 'status'
        or (params.get('mode') == 'operation' and params.get('operation') in PHONE_READ_OPERATIONS))


def _phone_lease(snapshot):
    """Exact active claim observed for this decision, else None."""
    view = (snapshot or {}).get('interaction') if (snapshot or {}).get('enabled') is True else None
    lease = (view or {}).get('lease') or {}
    cursor = (view or {}).get('cursor')
    if (lease.get('status') != 'ACTIVE' or not isinstance(lease.get('id'), str)
            or not isinstance(cursor, int) or isinstance(cursor, bool)):
        return None
    return lease['id'], cursor


def _phone_fence_holds(fence, snapshot):
    """A queued phone call runs only on the cursor its predecessor left behind."""
    if fence is None or _phone_lease(snapshot) != fence:
        return False
    view = snapshot['interaction']
    return (not (view.get('lease') or {}).get('attentionRequestId')
            and (view.get('pendingOperation') or {}).get('status') not in {'CONNECTING', 'RUNNING', 'UNKNOWN'})


def _node_identity(node):
    if node is None or getattr(node, 'is_visible', True) is not True:
        return None
    root = node
    seen = set()
    while getattr(root, 'parent_node', None) is not None:
        if id(root) in seen:
            return None
        seen.add(id(root))
        root = root.parent_node
    values = tuple(getattr(node, key, None) for key in ('target_id', 'frame_id', 'backend_node_id'))
    root_id = getattr(root, 'backend_node_id', None)
    if values[-1] is None or root_id is None:
        return None
    ax = getattr(node, 'ax_node', None)
    return values + (root_id, getattr(node, 'node_name', None), getattr(ax, 'role', None), getattr(ax, 'name', None))


def context(dom, url, messages, binding):
    session = getattr(dom, 'session', None)
    try:
        # This is the existing event-maintained target snapshot, not a new CDP read.
        native = dom.get_parked_page_identity()
        target, current_url = native["target_id"], native["url"]
    except Exception:
        # Unknown ownership cannot compare equal across decisions.
        target, current_url = object(), url
    return (id(dom), id(session), target, current_url,
            binding, tuple(sorted({identity[3] for node in (getattr(dom, 'selector_map', {}) or {}).values()
                                         if (identity := _node_identity(node)) is not None})),
            tuple(id(m) for m in messages if m.get('role') in {'user', 'USER'}
                  or type(m.get('content')).__name__ == 'InterAgentText'))


class BrowserActionBatch:
    def __init__(self, append_result):
        self.pending = []
        self.stream = None
        self.current_ids = []
        self._context = None
        self._targets = {}
        self._completed = False
        self._append_result = append_result
        self._selected = None
        self._started = False
        self._references = {}
        self._cached = False
        self._phone_fence = None
        self._reads_only = False
        self.is_continuation = False

    def discard_pending(self, reason):
        pending, self.pending = self.pending, []
        if self._selected is not None and not self._started:
            pending.insert(0, self._selected)
        self._selected = None
        self.is_continuation = False
        for item in pending:
            action = item['action']
            # The ordinary transcript writer expands a coalesced action once
            # into its original native calls. Do not expand the IDs twice.
            call_ids = item['tool_call_ids'][:1] if action.get('coalesced_calls') else item['tool_call_ids']
            for call_id in call_ids:
                self._append_result(action, {'success': False, 'skipped': True,
                                             'message': reason}, call_id)

    async def discard(self, reason):
        self.discard_pending(reason)
        if self.stream is not None:
            await self.stream.finish_tools(status='ERROR', all_tools=True)
        self.stream = None
        self.current_ids = []

    def begin(self, result, dom, state, stream):
        actions = result.get('batch_actions') or []
        if not actions:
            return result
        self.pending = deepcopy(actions)
        self._references = {}
        self._context = deepcopy(state)
        selectors = getattr(dom, 'selector_map', {}) or {}
        self._targets = {item['action'].get('index'): _node_identity(selectors.get(item['action'].get('index')))
                         for item in actions if item['action'].get('index') is not None}
        self.stream = stream
        self._cached = bool((result.get('usage') or {}).get('from_fast_cache'))
        self._phone_fence = _phone_lease(result.get('_phone_snapshot'))
        self._reads_only = False
        self._base = {key: value for key, value in result.items() if key not in {'action', 'batch_actions'}}
        return self._take(first=True)

    def _take(self, first=False, phone=None):
        item = self.pending.pop(0)
        self.current_ids = item['tool_call_ids']
        self._selected = item
        self._started = False
        self._completed = False
        self.is_continuation = not first
        self.stream.select_tools(self.current_ids)
        action = item['action'] if first else {**item['action'], 'thinking': None}
        base = self._base if first else {key: value for key, value in self._base.items() if key != '_fast_cache_browser_target'}
        if not first and '_phone_snapshot' in base:
            # Each queued call carries the loop's fresh observation, never the
            # planning snapshot: the server CAS sees the current cursor.
            base = {**base, '_phone_snapshot': phone or {}}
        return {**base, 'action': action, 'tool_call_id': self.current_ids[0],
                **({} if first else {'usage': {}, 'timing': {}, '_batch_continuation': True})}

    async def next(self, dom, state, phone=None):
        if not self.pending:
            return None
        action = self.pending[0]['action']
        if self._reads_only and not _phone_read(action):
            await self.discard('Batch remainder skipped: observe the phone screen before acting again.')
            return None
        if action.get('action') == 'phone' and not _phone_fence_holds(self._phone_fence, phone):
            await self.discard('Batch remainder skipped: phone lease, cursor or attention changed.')
            return None
        reference = (action.get('params') or {}).get('observation_ref')
        if reference:
            bound = self._references.get((reference['observation_id'], reference['target']))
            if bound is None:
                await self.discard('Batch remainder skipped: observed target missing or ambiguous.')
                return None
            index, identity, source_call_id = bound
            if identity != _node_identity((getattr(dom, 'selector_map', {}) or {}).get(index)):
                await self.discard('Batch remainder skipped: observed target changed.')
                return None
            action = {**action, 'index': index,
                      'params': {key: value for key, value in action['params'].items() if key != 'observation_ref'}}
            action['params']['index'] = index
            action['observation_source_call_id'] = source_call_id
            self.pending[0]['action'] = action
            self._targets[index] = identity
        index = action.get('index')
        same_target = index is None or (
            self._targets.get(index) is not None
            and self._targets[index] == _node_identity((getattr(dom, 'selector_map', {}) or {}).get(index))
        )
        if not self._completed or state != self._context or not same_target:
            await self.discard('Batch remainder skipped: outcome, page, target, authority or user input changed.')
            return None
        return self._take(phone=phone)

    def current_matches(self, dom, state):
        if self._selected is None or state != self._context:
            return False
        index = self._selected['action'].get('index')
        return index is None or (
            self._targets.get(index) is not None
            and self._targets[index] == _node_identity((getattr(dom, 'selector_map', {}) or {}).get(index))
        )

    def bind_observation(self, action, result, dom, state):
        params = action.get('params') or {}
        observation_id = params.get('observation_id')
        if action.get('action') != 'read_browser_state' or not observation_id:
            return result
        refs = {}
        # The read may populate selectors, but may not transfer authority or
        # cross a URL/target/user-instruction boundary.
        coherent = (result.get('success', True) is True and self._context[:5] == state[:5]
                    and self._context[-1] == state[-1])
        visible = str(result.get('formatted_state') or '')
        for target in params.get('targets', []):
            matches = []
            if coherent:
                for index, node in (getattr(dom, 'selector_map', {}) or {}).items():
                    ax = getattr(node, 'ax_node', None)
                    # Use native accessibility identity, never fuzzy descriptions
                    # or text inferred from an untrusted result payload.
                    if (getattr(node, 'is_visible', False) is True
                            and getattr(ax, 'role', None) == target['role']
                            and getattr(ax, 'name', None) == target['name']
                            and f'[{index}]' in visible and _node_identity(node) is not None):
                        matches.append((index, _node_identity(node)))
            if len(matches) == 1:
                index, identity = matches[0]
                self._references[(observation_id, target['key'])] = (index, identity, self.current_ids[0])
                refs[target['key']] = {'status': 'bound', 'index': index}
            else:
                refs[target['key']] = {'status': 'ambiguous' if len(matches) > 1 else 'missing'}
        if coherent:
            self._context = deepcopy(state)
        return {**result, 'observation_id': observation_id, 'target_refs': refs}

    def _phone_continues(self, action, result):
        if action.get('action') != 'phone':
            return False
        params = action.get('params') or {}
        if not phone_call_batchable(params):
            return False
        if params.get('mode') == 'status':
            cursor = (result.get('phone') or {}).get('cursor')
        else:
            operation = result.get('operation') or {}
            if operation.get('status') != 'SUCCEEDED':
                return False
            # The receipt cursor is the lease cursor this call left behind.
            cursor = operation.get('cursor')
        if self._phone_fence is None or not isinstance(cursor, int) or isinstance(cursor, bool):
            return False
        self._phone_fence = (self._phone_fence[0], cursor)
        self._reads_only = self._reads_only or params.get('operation') in PHONE_NAVIGATION_OPERATIONS
        return True

    def started(self):
        self._started = True

    async def completed(self, action, result):
        self._selected = None
        self.is_continuation = False
        successful = isinstance(result, dict) and result.get('success', True) is True
        self._completed = successful and not self._cached and not result.get('status') in {
            'needs_write_approval', 'awaiting_payment_card_approval', 'paused', 'cancelled',
        } and (action.get('action') in CONTINUE_AFTER or self._phone_continues(action, result))
        # Enter submits a form; later actions must observe its outcome first.
        if action.get('action') == 'press_key' and str((action.get('params') or {}).get('key', '')).lower() in {'enter', 'return'}:
            self._completed = False
        if not self._completed and self.pending:
            await self.discard('Batch remainder skipped after an action boundary or unsuccessful result.')
