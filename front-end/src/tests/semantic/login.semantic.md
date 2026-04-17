# Semantic Test: Login via Phone + OTP

## Summary
Verify a user can log in from the marketing homepage by clicking the Login button, entering their phone number, receiving an OTP, entering the OTP, and reaching an authenticated state with a persisted session.

## Config
```
BACKEND_URL=http://localhost:{BACKEND_PORT}
FRONTEND_URL=http://localhost:{FRONTEND_PORT}
TEST_PHONE_DIGITS=9729777432
TEST_PHONE_E164=+19729777432
TEST_OTP=181818
TIMEOUT_SECONDS=60
```

## Pre-conditions
1. Backend API is healthy: `GET {BACKEND_URL}/health` returns 200
2. Frontend is accessible: `GET {FRONTEND_URL}` returns 200
3. Chrome browser with Claude extension connected (for CDP browser steps)

## Setup
1. Open a fresh tab with `tabs_create_mcp`
2. Navigate to `{FRONTEND_URL}/terminal` (marketing/landing page — `/terminal` route is the marketing `Index` page that renders `NaviHeader` with the `Login` button; `/` is the authenticated Terminal surface).
3. Wait for the page DOM to be ready
4. Clear any existing session so we test the unauthenticated flow:
   ```js
   // Evaluate via javascript_tool
   Object.keys(localStorage)
     .filter(k => k.startsWith('sb-') || k === 'rose-session' || k === 'app-user')
     .forEach(k => localStorage.removeItem(k));
   location.reload();
   ```
5. After reload, read console messages and confirm `[Auth] State changed` shows `isAuthenticated: false` OR the user is anonymous. If `isAuthenticated: true` for a real (non-anonymous) user, FAIL with "Test started from an already-authenticated state — cannot exercise login."
6. **Dev-mode caveat:** When running against a Vite dev build, `useAuth` auto-logs in with test credentials (`+19729777432`/`181818`). In that case the Login button may not render. To force the logged-out path:
   - Run the FE against a built preview (`npm run build && npx vite preview`), OR
   - Mock `POST /api/auth/anonymous` to fail so `useAuth` lands in `user: null`, OR
   - Skip Step 4 and instead start the test with an anonymous session, then assert the Login click opens the modal.

## Steps

### Step 1: Click the Login button
1. Use `find` to locate the element "Login button in the page header"
2. Click it by dispatching a click on the returned ref
3. **PASS**: The phone auth modal appears AND is fully on-screen. Verify via `javascript_tool`:
   ```js
   const d = document.querySelector('[role="dialog"]');
   const r = d && d.getBoundingClientRect();
   r && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
   ```
   Must return `true`. Also verify a "Phone Number" input or "Start Building." heading is present in the dialog.
4. **FAIL**: If after 3s no modal appears, FAIL with "Login button did not open the auth modal — button is broken"
5. **FAIL**: If the dialog exists but any edge is off-screen (e.g. top < 0), FAIL with "Modal rendered off-screen — positioning regression"

### Step 2: Submit phone number
1. `find` the "Phone Number input" and enter `{TEST_PHONE_DIGITS}` using `form_input`
2. `find` the "Continue button" inside the modal and click it
3. Watch for:
   - Backend network call `POST /api/auth/send-otp` with body `{"phone":"{TEST_PHONE_E164}"}`
   - Console message `[Auth]` related events or a toast "Code sent!"
4. **PASS**: Modal transitions to OTP step — heading reads "Verify Code" and an OTP input (`#otp`) is visible
5. **FAIL**: If `POST /api/auth/send-otp` returns non-2xx, FAIL with the error message returned
6. **FAIL**: If modal does not transition within 15s, FAIL with "Send-OTP succeeded but modal did not advance to OTP step"

### Step 3: Submit OTP
1. `find` the "Verification Code input" (6-digit OTP field) and enter `{TEST_OTP}` via `form_input`
2. `find` the "I authorize SMS communication checkbox" and check it (set value `true`)
3. `find` the "Verify button" and click it
4. Watch for backend network call `POST /api/auth/verify-otp` with body containing `"phone":"{TEST_PHONE_E164}"` and `"token":"{TEST_OTP}"`
5. **PASS**: Response is 2xx and contains `user.id` + `session.access_token`
6. **FAIL**: If response is non-2xx, FAIL with the error body

### Step 4: Verify authenticated state
After Verify:
1. Modal should close within 3s (no "Verify Code" heading in DOM)
2. Console should contain `[Auth] Phone verification complete` with a `userId`
3. A Supabase session must be persisted in localStorage — verify with:
   ```js
   Object.keys(localStorage).some(k => k.startsWith('sb-') && localStorage.getItem(k)?.includes('access_token'))
   ```
   Must return `true`.
4. Console `[Auth] State changed` must subsequently log `isAuthenticated: true` and `isAnonymous: false`

### Step 5: Verify login survives navigation
1. Click the Login button again (same element as Step 1)
2. **PASS**: Because the user is now authenticated, the handler must navigate to `/terminal` — verify the URL path is `/terminal` within 3s
3. **FAIL**: If the auth modal re-opens instead, FAIL with "Login button does not detect authenticated state"

## Invariants (check continuously)
1. No `Uncaught` errors or `unhandledrejection` in the console at any point
2. No `POST /api/auth/send-otp` or `/verify-otp` returns 5xx
3. The Login button element must remain visible until Step 5 navigation (never disappears mid-flow)

## Termination Conditions

### SUCCESS
All of these must hold:
- Step 1 modal appeared
- Step 2 `send-otp` returned 2xx and modal advanced to OTP step
- Step 3 `verify-otp` returned 2xx with a session
- Step 4 session persisted in localStorage and auth state is `isAuthenticated: true, isAnonymous: false`
- Step 5 clicking Login redirects to `/terminal`
- No invariants violated

### FAILURE (any one triggers immediate failure)
- Any pre-condition not met
- Login button click does not open modal
- `send-otp` or `verify-otp` HTTP error
- Modal fails to transition between phone → otp → closed
- Session not persisted after verify
- Invariant violation

## Cleanup
After test (pass or fail), clear the dev session so re-runs start fresh:
```js
Object.keys(localStorage)
  .filter(k => k.startsWith('sb-') || k === 'rose-auth-session')
  .forEach(k => localStorage.removeItem(k));
```
