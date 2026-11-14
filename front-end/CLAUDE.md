# front-end

Frontend rules (React/TypeScript/Vite on Vercel). The root `CLAUDE.md` still applies; numbers in parentheses are stable rule IDs.

- Every component keeps a state-machine diagram as a comment at the top of its file; read it before changing state flow and update it in the same change (rule 9).
- Realtime and tool message types live in `src/lib/realtime-types.ts`; extend them there rather than redefining payload shapes in components.
- In dev the frontend infers its backend as `frontendPort - 1` (`src/lib/backendUrl.ts`) unless `VITE_BACKEND_API_URL` is set to a non-default value.
- Tests: `npm run test` (blackbox + structural) and `npm run test:coverage`; thresholds live in `vitest.config.ts` and only ratchet up.
