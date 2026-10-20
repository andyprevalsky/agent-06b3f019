# Tools for the user's agent

A bundle can carry tools for the user's root agent under tools/<tool_name>/,
listed in rose-ui.json as
`"tools": { "<tool_name>": { "manifest": "tools/<tool_name>/tool.json" } }`.
Tool names match [a-z0-9_]+.

tools/<tool_name>/tool.json:

    {
      "name": "<tool_name>",
      "description": "one sentence the agent reads to decide when to call it",
      "input_schema": { "type": "object", "properties": { ... } },
      "output_schema": { ... },              optional; results are validated
      "render": { "view": "<view-name>" },   optional; result becomes that inline view's props
      "side_effects": false,                 true if a call changes anything outside the tool
      "idempotency_key_field": "request_id", optional, side_effects only (see below)
      "timeout_s": 60,                       default 60, max 300
      "runtime": "node",                     or "python"
      "entry": "tools/<tool_name>/handler.js",
      "files": ["lib.js"]                    optional extra files, relative to tools/<tool_name>/
    }

The handler reads one JSON object (the input) on stdin and writes one JSON
object on stdout. A non-zero exit is reported to the agent as a tool error.
It runs in this user's own code session (a fresh working directory each
call), with no secrets in its environment, the timeout_s limit and a 256 KB
output cap. After publishing, the user's next root-agent run can call it as
user__<tool_name>.

A side_effects tool runs at most once per agent tool call: a retried call
gets the recorded result back without running the handler again. Its
handler receives the call's idempotency key as ROSE_IDEMPOTENCY_KEY (and in
its input under idempotency_key_field, which must not be an input_schema
property); pass it to downstream APIs that accept one.
