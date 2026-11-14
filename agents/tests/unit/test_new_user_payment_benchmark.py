"""Fail-closed checks for the daily new-user subscription-to-payment journey."""

import copy
import uuid

import pytest


def test_new_user_payment_identity_is_fresh_for_each_isolated_run(monkeypatch):
    from benchmarks.run_benchmark import _new_user_payment_journey_user_id

    monkeypatch.setenv("BENCHMARK_RUN_ID", "daily-run-a")
    first = _new_user_payment_journey_user_id()
    assert str(uuid.UUID(first)) == first
    assert _new_user_payment_journey_user_id() == first

    monkeypatch.setenv("BENCHMARK_RUN_ID", "daily-run-b")
    assert _new_user_payment_journey_user_id() != first


def test_new_user_payment_gate_must_arrive_before_approval():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _attention_request_matches_task

    task = get_task_by_name("agent-payment-new-user-journey")
    gate = {"metadata": {"gate": {"type": "subscription", "gateKey": "subscription", "severity": "blocking"}}}
    approval = {"metadata": {"attentionKind": "payment_approval"}}
    assert _attention_request_matches_task(task, gate, 0)
    assert not _attention_request_matches_task(task, approval, 0)
    assert _attention_request_matches_task(task, approval, 1)
    assert not _attention_request_matches_task(task, gate, 1)
    assert not _attention_request_matches_task(task, approval, 2)


def test_new_user_payment_static_contract_rejects_missing_checkout_and_transfer():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _run_declared_static_check

    task = get_task_by_name("agent-payment-new-user-journey")
    evaluator = {"checks": [
        {"type": "attention_kind_sequence", "value": task.expected_attention_kinds},
        {"type": "subscription_checkout_completed"},
        {"type": "expected_payment_lifecycle"},
    ]}
    state = {
        "expected_attention_kinds_seen": list(task.expected_attention_kinds),
        "subscription_checkout": {"status": "complete", "payment_status": "paid", "webhook_delivered": True},
        "payment_lifecycle": copy.deepcopy(task.expected_payment_lifecycle),
    }
    assert _run_declared_static_check(task, evaluator, {"_benchmark": state})[0]

    wrong_order = copy.deepcopy(state)
    wrong_order["expected_attention_kinds_seen"].reverse()
    assert "sequence mismatch" in _run_declared_static_check(task, evaluator, {"_benchmark": wrong_order})[1]

    unpaid = copy.deepcopy(state)
    unpaid["subscription_checkout"]["payment_status"] = "unpaid"
    assert "Paid Stripe Checkout" in _run_declared_static_check(task, evaluator, {"_benchmark": unpaid})[1]

    missing_transfer = copy.deepcopy(state)
    missing_transfer["payment_lifecycle"]["orgTransfer"]["transferredCents"] = 0
    assert "orgTransfer.transferredCents" in _run_declared_static_check(
        task, evaluator, {"_benchmark": missing_transfer}
    )[1]


def test_new_user_payment_checkout_rejects_non_test_destination():
    from benchmarks.subscription_checkout import _sandbox_session_id

    with pytest.raises(RuntimeError, match="Stripe Checkout URL"):
        _sandbox_session_id("https://example.com/c/pay/cs_test_abcd", "sk_test_example")
    with pytest.raises(RuntimeError, match="test-mode"):
        _sandbox_session_id("https://checkout.stripe.com/c/pay/cs_test_abcd", "sk_live_example")


@pytest.mark.parametrize("mode", ["missing", "hidden", "fill-error"])
@pytest.mark.asyncio
async def test_checkout_field_failure_reports_only_actual_probe_counts_and_exception_type(monkeypatch, mode):
    import json
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    clock = [0.0]
    sleeps, fills = [], []
    private_value = "fake-value-email@example.test"
    private_selector = 'input[data-private="fake-selector-secret"]'

    class Locator:
        @property
        def first(self):
            return self

        async def count(self):
            return int(mode != "missing")

        async def is_visible(self):
            return mode != "hidden"

        async def fill(self, value, *, timeout):
            fills.append((value, timeout))
            raise TimeoutError("fake-session/path?key=fake-secret " + value)

    async def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds

    page = SimpleNamespace(frames=[SimpleNamespace(
        locator=lambda selector: Locator(),
        url="https://fake-user:fake-password@checkout.stripe.com/private-session?key=fake-query",
    )])
    monkeypatch.setattr(checkout.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(checkout.asyncio, "sleep", sleep)
    prefix = "Stripe Checkout ZIP field was not available"
    with pytest.raises(RuntimeError, match="^" + prefix) as caught:
        await checkout._fill_checkout_field(page, (private_selector,), private_value, "ZIP")
    message = str(caught.value)
    assert message.startswith(prefix + "; selector_diagnostics="), "missing actual fill-attempt diagnostics"
    probes = json.loads(message.split("; selector_diagnostics=", 1)[1])
    assert probes == [{
        "probes": 60,
        "matched_probes": 0 if mode == "missing" else 60,
        "visible_probes": 60 if mode == "fill-error" else 0,
        "fill_attempts": 60 if mode == "fill-error" else 0,
        "last_exception_type": "TimeoutError" if mode == "fill-error" else None,
    }]
    assert clock[0] == 30 and sleeps == [0.5] * 60
    assert fills == ([(private_value, 5000)] * 60 if mode == "fill-error" else [])
    for private in (private_value, private_selector, "fake-secret", "fake-session", "fake-user",
                    "fake-password", "checkout.stripe.com", "private-session", "fake-query"):
        assert private not in message


@pytest.mark.asyncio
async def test_checkout_field_success_keeps_original_fill_and_does_not_emit_diagnostics(monkeypatch):
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    calls = []

    class Locator:
        @property
        def first(self):
            return self

        async def count(self):
            calls.append("count")
            return 1

        async def is_visible(self):
            calls.append("visible")
            return True

        async def fill(self, value, *, timeout):
            calls.append((value, timeout))

    def unexpected(*args, **kwargs):
        raise AssertionError("successful fill must not produce failure diagnostics or retry")

    monkeypatch.setattr(checkout.json, "dumps", unexpected)
    monkeypatch.setattr(checkout.asyncio, "sleep", unexpected)
    page = SimpleNamespace(frames=[SimpleNamespace(locator=lambda selector: Locator())])
    await checkout._fill_checkout_field(page, ('input[name="billingPostalCode"]',), "fake-ZIP", "ZIP")
    assert calls == ["count", "visible", ("fake-ZIP", 5000)]


@pytest.mark.parametrize("geolocated_country", ["NL", "US", None])
@pytest.mark.asyncio
async def test_hosted_checkout_pays_when_stripe_geolocates_the_guest_outside_the_us(monkeypatch, geolocated_country):
    """Hosted Checkout preselects Stripe's IP-geolocated country; a eurozone default renders no ZIP input.

    Fleet sessions presented in EUR failed with zero ZIP matches (fleet run 20261108-042041-2844813).
    """
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    form = {"billingCountry": geolocated_country or "US"}
    filled, selected = {}, []
    names = {"email": "email", "cardNumber": "cc-number", "cardExpiry": "cc-exp", "cardCvc": "cc-csc",
             "billingName": "cc-name", "billingPostalCode": "postal-code"}

    def rendered(selector):
        if selector == 'select[name="billingCountry"]':
            return "billingCountry" if geolocated_country else None
        if selector in ("card", 'button[data-testid="hosted-payment-submit-button"]'):
            return selector
        for name, autocomplete in names.items():
            if selector in (f'input[name="{name}"]', f'input[autocomplete="{autocomplete}"]'):
                if name == "billingPostalCode" and form["billingCountry"] != "US":
                    return None
                return name
        return None

    class Locator:
        def __init__(self, selector):
            self.name = rendered(selector)

        @property
        def first(self):
            return self

        @property
        def last(self):
            return self

        async def count(self):
            return int(self.name is not None)

        async def is_visible(self):
            return self.name is not None

        async def fill(self, value, *, timeout):
            filled[self.name] = value

        async def input_value(self):
            return form[self.name]

        async def select_option(self, value, *, timeout):
            selected.append(value)
            form[self.name] = value

        async def click(self, **kwargs):
            pass

    page = SimpleNamespace(locator=Locator, get_by_text=lambda text, exact: Locator("card"))
    page.frames = [page]

    async def goto(url, **kwargs):
        pass

    page.goto = goto

    class Browser:
        async def new_page(self):
            return page

        async def close(self):
            pass

    class Playwright:
        chromium = SimpleNamespace(launch=None)

        async def __aenter__(self):
            async def launch(**kwargs):
                return Browser()
            self.chromium = SimpleNamespace(launch=launch)
            return self

        async def __aexit__(self, *args):
            pass

    user_id = "00000000-0000-4000-8000-000000000777"
    sessions = iter([
        {"status": "open", "client_reference_id": user_id},
        {"status": "complete", "payment_status": "paid", "subscription": "sub_test", "customer": "cus_test",
         "livemode": False, "client_reference_id": user_id},
    ])

    async def stripe_session(session_id, stripe_key):
        return next(sessions)

    deliveries = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            deliveries.append(url)
            return SimpleNamespace(raise_for_status=lambda: None)

    async def no_sleep(seconds):
        pass

    monkeypatch.setattr(checkout, "async_playwright", Playwright)
    monkeypatch.setattr(checkout, "_stripe_session", stripe_session)
    monkeypatch.setattr(checkout.httpx, "AsyncClient", Client)
    monkeypatch.setattr(checkout.asyncio, "sleep", no_sleep)
    clock = iter(range(0, 10_000, 5))
    monkeypatch.setattr(checkout.time, "monotonic", lambda: next(clock))

    result = await checkout.complete_test_subscription_checkout(
        "http://127.0.0.1:1", "https://checkout.stripe.com/c/pay/cs_test_geo", user_id,
        stripe_key="sk_test_example", webhook_secret="whsec_example",
    )

    assert result["payment_status"] == "paid" and result["webhook_delivered"] is True
    assert filled["billingPostalCode"] == "94105" and filled["cardNumber"] == "4242424242424242"
    assert selected == (["US"] if geolocated_country == "NL" else [])
    assert deliveries == ["http://127.0.0.1:1/webhooks/stripe"]


class _CheckoutElement:
    def __init__(self, name, selectors, *, text=None, visible=True, checked=None, value=None, element_id=None):
        self.name, self.selectors, self.text = name, set(selectors), text
        self.visible, self.checked, self.value, self.element_id = visible, checked, value, element_id


class _CheckoutLocator:
    def __init__(self, frame, matches):
        self.frame, self.matches = frame, matches

    @property
    def first(self):
        return _CheckoutLocator(self.frame, self.matches[:1])

    @property
    def last(self):
        return _CheckoutLocator(self.frame, self.matches[-1:])

    def _one(self):
        if not self.matches:
            raise TimeoutError("locator matched no element")
        return self.matches[0]

    async def count(self):
        return len(self.matches)

    async def is_visible(self):
        return bool(self.matches) and self.matches[0].visible

    async def is_checked(self):
        return bool(self._one().checked)

    async def get_attribute(self, name):
        return self._one().element_id if name == "id" else None

    async def input_value(self):
        return self._one().value

    async def fill(self, value, *, timeout):
        element = self._one()
        if not element.visible:
            raise TimeoutError("element is not visible")
        element.value = value
        self.frame.layout.events.append(("fill", self.frame.name, element.name, value))

    async def select_option(self, value, *, timeout):
        self._one().value = value
        self.frame.layout.events.append(("select", self.frame.name, self._one().name, value))

    async def click(self, **kwargs):
        element = self._one()
        if not element.visible and not kwargs.get("force"):
            raise TimeoutError("element is not visible")
        self.frame.layout.events.append(("click", self.frame.name, element.name))
        self.frame.layout.clicked(element)


class _CheckoutFrame:
    def __init__(self, layout, name, elements):
        self.layout, self.name, self.elements = layout, name, elements

    def locator(self, selector):
        return _CheckoutLocator(self, [e for e in self.elements if selector in e.selectors])

    def get_by_text(self, text, *, exact):
        assert exact is True
        return _CheckoutLocator(self, [e for e in self.elements if e.text == text])


class _HostedCheckoutLayout:
    """DOM contracts captured from real sandbox Checkout sessions on 2026-11-12.

    ``c-pay``: /c/pay/ renders the payment-method accordion, card form and Subscribe in the page.
    ``g-pay``: /g/pay/ (cs_test_b0IjS1OU…, the PR #1981 smoke failure) renders the whole Payment
    Element — Card radio, card form, country/postalCode, Link opt-in and Subscribe — inside one
    js.stripe.com iframe; the page itself only holds the promotion-code input, and hCaptcha adds an
    unrelated ``button[type=submit]`` frame.
    ``*-card-only``: a ``payment_method_types=[card]`` session (both paths) shows a "Card" heading
    and the card form already open, with no other method to choose.
    """

    def __init__(self, variant, geolocated_country):
        self.events = []
        card_only = variant.endswith("-card-only")
        card_hidden = not card_only
        if variant.startswith("g-pay"):
            fields = [
                _CheckoutElement("email", ['input[name="email"]', 'input[autocomplete="email"]']),
                _CheckoutElement("card", [], text="Card"),
                _CheckoutElement("number", ['input[name="number"]', 'input[autocomplete="cc-number"]'],
                                 visible=card_only),
                _CheckoutElement("expiry", ['input[name="expiry"]', 'input[autocomplete="cc-exp"]'],
                                 visible=card_only),
                _CheckoutElement("cvc", ['input[name="cvc"]', 'input[autocomplete="cc-csc"]'], visible=card_only),
                _CheckoutElement("name", ['input[name="name"]', 'input[autocomplete="cc-name"]'], visible=card_only),
                _CheckoutElement("country", ['select[name="country"]', 'select[autocomplete="billing country"]'],
                                 visible=card_only, value=geolocated_country),
                _CheckoutElement("postalCode", ['input[name="postalCode"]',
                                                'input[autocomplete="billing postal-code"]'], visible=card_only),
                _CheckoutElement("linkOptIn", ['input[name="linkOptIn"]'], visible=card_only, checked=True,
                                 element_id="payment-linkOptInInput"),
                _CheckoutElement("linkOptInLabel", ['label[for="payment-linkOptInInput"]'], visible=card_only),
                _CheckoutElement("submit", ['button[type="submit"]',
                                            'button[data-testid="payment-form-submit-button"]'], text="Subscribe"),
            ]
            self.frames = [
                _CheckoutFrame(self, "page", [_CheckoutElement("promotionCode", ['input[name="promotionCode"]'])]),
                _CheckoutFrame(self, "payment-element", fields),
                _CheckoutFrame(self, "hcaptcha", [_CheckoutElement("hcaptcha-menu", ['button[type="submit"]'])]),
            ]
        else:
            fields = [
                _CheckoutElement("email", ['input[name="email"]', 'input[autocomplete="email"]']),
                _CheckoutElement("number", ['input[name="cardNumber"]', 'input[autocomplete="cc-number"]'],
                                 visible=not card_hidden),
                _CheckoutElement("expiry", ['input[name="cardExpiry"]', 'input[autocomplete="cc-exp"]'],
                                 visible=not card_hidden),
                _CheckoutElement("cvc", ['input[name="cardCvc"]', 'input[autocomplete="cc-csc"]'],
                                 visible=not card_hidden),
                _CheckoutElement("name", ['input[name="billingName"]', 'input[autocomplete="cc-name"]'],
                                 visible=not card_hidden),
                _CheckoutElement("country", ['select[name="billingCountry"]'], visible=not card_hidden,
                                 value=geolocated_country),
                _CheckoutElement("postalCode", ['input[name="billingPostalCode"]',
                                                'input[autocomplete="postal-code"]'], visible=not card_hidden),
                _CheckoutElement("linkOptIn", ['input[name="enableStripePass"]'], visible=not card_hidden,
                                 checked=True, element_id="enableStripePass"),
                _CheckoutElement("linkOptInLabel", ['label[for="enableStripePass"]'], visible=not card_hidden),
                _CheckoutElement("submit", ['button[type="submit"]',
                                            'button[data-testid="hosted-payment-submit-button"]'], text="Subscribe"),
            ]
            fields.insert(1, _CheckoutElement("card", ['button[data-testid="card-accordion-item-button"]']
                                              if card_hidden else [], text="Card"))
            self.frames = [_CheckoutFrame(self, "page", fields)]

    def element(self, name):
        return next(e for frame in self.frames for e in frame.elements if e.name == name)

    def clicked(self, element):
        if element.name == "card":
            for frame in self.frames:
                for other in frame.elements:
                    if other.name not in ("email", "card", "submit", "promotionCode", "hcaptcha-menu"):
                        other.visible = True
        elif element.name in ("linkOptIn", "linkOptInLabel"):
            self.element("linkOptIn").checked = not self.element("linkOptIn").checked


@pytest.mark.parametrize("variant", ["c-pay", "g-pay", "c-pay-card-only", "g-pay-card-only"])
@pytest.mark.parametrize("geolocated_country", ["US", "NL"])
@pytest.mark.asyncio
async def test_hosted_checkout_pays_in_every_real_checkout_layout(monkeypatch, variant, geolocated_country):
    """Stripe serves the same session as /c/pay/ or /g/pay/; the driver must pay through either.

    Smoke runs on PR #1975 and #1981 (2026-11-12) got /g/pay/ sessions and timed out on the
    page-level ``get_by_text("Card")`` because that layout renders the Card radio in an iframe.
    """
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    layout = _HostedCheckoutLayout(variant, geolocated_country)
    page = SimpleNamespace(frames=layout.frames, locator=layout.frames[0].locator,
                           get_by_text=layout.frames[0].get_by_text)

    async def goto(url, **kwargs):
        layout.events.append(("goto", url))

    page.goto = goto

    class Browser:
        async def new_page(self):
            return page

        async def close(self):
            pass

    class Playwright:
        async def __aenter__(self):
            async def launch(**kwargs):
                return Browser()
            self.chromium = SimpleNamespace(launch=launch)
            return self

        async def __aexit__(self, *args):
            pass

    user_id = "00000000-0000-4000-8000-000000000778"
    session_reads = []

    async def stripe_session(session_id, stripe_key):
        session_reads.append(session_id)
        if not any(event[:3] == ("click", event[1], "submit") for event in layout.events if event[0] == "click"):
            return {"status": "open", "client_reference_id": user_id}
        return {"status": "complete", "payment_status": "paid", "subscription": "sub_test", "customer": "cus_test",
                "livemode": False, "client_reference_id": user_id}

    deliveries = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            deliveries.append(url)
            return SimpleNamespace(raise_for_status=lambda: None)

    async def no_sleep(seconds):
        pass

    class Expect:
        def __init__(self, locator):
            self.locator = locator

        async def not_to_be_checked(self, **kwargs):
            assert not await self.locator.is_checked()

    monkeypatch.setattr(checkout, "async_playwright", Playwright)
    monkeypatch.setattr(checkout, "_stripe_session", stripe_session)
    monkeypatch.setattr(checkout.httpx, "AsyncClient", Client)
    monkeypatch.setattr(checkout.asyncio, "sleep", no_sleep)
    # Lets the pre-fix driver's playwright `expect` run, so its /c/pay/ cases are real controls.
    monkeypatch.setattr(checkout, "expect", Expect, raising=False)
    clock = iter(range(0, 100_000))
    monkeypatch.setattr(checkout.time, "monotonic", lambda: next(clock))

    path = variant[0]
    result = await checkout.complete_test_subscription_checkout(
        "http://127.0.0.1:1", f"https://checkout.stripe.com/{path}/pay/cs_test_layout", user_id,
        stripe_key="sk_test_example", webhook_secret="whsec_example",
    )

    payment_frame = "payment-element" if variant.startswith("g-pay") else "page"
    filled = {event[2]: event[3] for event in layout.events if event[0] == "fill"}
    assert {event[1] for event in layout.events if event[0] == "fill"} == {payment_frame}
    assert filled == {"email": "bench-00000000@example.test", "number": "4242424242424242", "expiry": "1234",
                      "cvc": "123", "name": "Benchmark User", "postalCode": "94105"}
    assert layout.element("country").value == "US"
    assert layout.element("linkOptIn").checked is False, "Link save must be opted out before paying"
    clicks = [event for event in layout.events if event[0] == "click"]
    assert clicks[-1] == ("click", payment_frame, "submit"), "Subscribe must be the Payment Element's own button"
    assert ("click", "hcaptcha", "hcaptcha-menu") not in clicks
    assert [event for event in layout.events if event[0] in ("click", "fill")].index(clicks[-1]) == \
        len([event for event in layout.events if event[0] in ("click", "fill")]) - 1, "nothing after submit"
    assert result["payment_status"] == "paid" and result["webhook_delivered"] is True
    assert result["checkout_layout"] == path and result["link_opted_out"] is True
    assert session_reads[0] == "cs_test_layout" and len(session_reads) >= 2
    assert deliveries == ["http://127.0.0.1:1/webhooks/stripe"]
