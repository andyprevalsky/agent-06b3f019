import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionSession,
  ratchetPassword,
} from "../../front-end/scripts/generate-prod-test-session.mjs";

test("reuses the dedicated ratchet user and returns its session", async () => {
  const calls = [];
  const expectedSession = {
    access_token: "token",
    user: { id: "ratchet-user" },
  };
  const client = {
    auth: {
      admin: {
        async listUsers() {
          calls.push(["list"]);
          return {
            data: {
              users: [
                {
                  id: "ratchet-user",
                  email: "chat-lifecycle-ratchet@roselabs.ai",
                },
              ],
            },
            error: null,
          };
        },
        async createUser() {
          throw new Error("existing users must not be recreated");
        },
        async updateUserById(id, payload) {
          calls.push(["update", id, payload]);
          return { error: null };
        },
      },
      async signInWithPassword(credentials) {
        calls.push(["sign-in", credentials]);
        return { data: { session: expectedSession }, error: null };
      },
    },
  };

  const session = await createProductionSession({
    url: "https://supabase.test",
    serviceRoleKey: "service-role-key",
    createClientImpl: () => client,
  });

  assert.equal(session, expectedSession);
  assert.deepEqual(calls, [
    ["list"],
    [
      "update",
      "ratchet-user",
      {
        password: ratchetPassword("service-role-key"),
        email_confirm: true,
      },
    ],
    [
      "sign-in",
      {
        email: "chat-lifecycle-ratchet@roselabs.ai",
        password: ratchetPassword("service-role-key"),
      },
    ],
  ]);
});

test("finds the ratchet user beyond the first 1,000 auth users", async () => {
  const listedPages = [];
  const client = {
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          listedPages.push(page);
          if (page <= 10) {
            return {
              data: {
                users: Array.from({ length: perPage }, (_, index) => ({
                  id: `user-${page}-${index}`,
                  email: `user-${page}-${index}@example.com`,
                })),
              },
              error: null,
            };
          }
          return {
            data: {
              users: [
                {
                  id: "ratchet-user",
                  email: "chat-lifecycle-ratchet@roselabs.ai",
                },
              ],
            },
            error: null,
          };
        },
        async createUser() {
          throw new Error("an existing paginated user must not be recreated");
        },
        async updateUserById() {
          return { error: null };
        },
      },
      async signInWithPassword() {
        return { data: { session: { access_token: "token" } }, error: null };
      },
    },
  };

  await createProductionSession({
    url: "https://supabase.test",
    serviceRoleKey: "service-role-key",
    createClientImpl: () => client,
  });

  assert.deepEqual(
    listedPages,
    Array.from({ length: 11 }, (_, index) => index + 1),
  );
});

test("fails closed when production Supabase credentials are absent", async () => {
  await assert.rejects(
    createProductionSession({ url: "", serviceRoleKey: "" }),
    /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required/,
  );
});
