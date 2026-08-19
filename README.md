# VibeAround Agent

VibeAround's first-party ACP coding agent.

This project stays deliberately small: it translates ACP over stdio to Pi
`AgentSession`. VibeAround owns profiles, credentials, process supervision, and
the client UI; this agent owns Pi sessions, model requests, and coding tools.

## Requirements

- Node.js 22.19 or newer

## Development

```sh
npm ci
VIBEAROUND_AGENT_DIR=/path/to/vibearound-data/agents/va-agent \
VIBEAROUND_DATA_DIR=/path/to/vibearound-data \
VIBEAROUND_MODEL_CONFIG='{"api":"openai-responses","baseUrl":"https://api.openai.com/v1","model":"model-id","provider":"openai"}' \
VIBEAROUND_MODEL_API_KEY=provider-api-key \
npm start
npm run check
npm run build
```

`npm run check` includes a no-network integration test that starts a local mock
OpenAI Responses SSE endpoint, drives the agent through the official ACP client,
allows a real `bash` call, restarts the process, loads the transcript, and
verifies the next model request still contains the prior turn.

`VIBEAROUND_MODEL_CONFIG` is a strict JSON object containing `api`, `baseUrl`,
`model`, and `provider`; it points straight at the model provider selected in
the VibeAround profile. Optional fields are `contextWindow`, `maxTokens`,
`input` (`text` / `image`), `reasoning`, provider `headers`, and `authHeader`,
matching what Pi's `registerProvider` accepts. The API key is passed separately
through `VIBEAROUND_MODEL_API_KEY` and is kept in Pi's in-memory model runtime.

## Implemented scope

- ACP `initialize`, `session/new`, `session/resume`, `session/load`,
  `session/prompt`, and `session/cancel`
- Pi session creation, persistence, resume, transcript replay, streaming, and
  cancellation
- A fixed tool set: `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`,
  plus a built-in `get_session_id` that returns the current session ID
- MCP over ACP: the agent advertises `mcpCapabilities.acp`, connects to every
  `type: "acp"` server declared on `session/new` / `session/resume` /
  `session/load` through `mcp/connect` and `mcp/message` on the same stdio
  connection, registers the server's tools with Pi under their own names, and
  forwards calls as `tools/call`. VibeAround declares its `vibearound` server
  this way; its tools carry a `va_mcp_` prefix.
- ACP tool-call lifecycle updates for pending, running, completed, and failed
  calls

`read`, `grep`, `find`, and `ls` run without a prompt only when their resolved
target remains inside the session workspace. Targets outside the workspace
require permission; VibeAround product data outside its managed `workspaces`
directory is always denied. `bash`, `edit`, `write`, and every MCP tool are
blocked before execution until the ACP client selects `allow-once`; the
built-in `get_session_id` needs no prompt. A rejected, cancelled, or failed
permission request stays blocked. Project and user Pi extensions are disabled,
so they cannot add executable tools outside this fixed set.

`VIBEAROUND_DATA_DIR` is VibeAround's data directory; reads under it are
refused except inside its managed `workspaces`. The system prompt is Pi's own
with the opening identity sentence replaced ("You are VibeAround Agent, ...").

Pi transcripts are stored under `$VIBEAROUND_AGENT_DIR/sessions`. A new
session header is persisted before `session/new` returns, so it remains
attachable even if the first turn is cancelled or the process exits.
`session/load`
reopens the session selected by both its Pi session ID and exact working
directory, then replays the active branch's user text, agent text/thought, and
tool-call/result history as ACP updates. `session/resume` reopens the same state
without replay.

HTTP and stdio MCP servers and additional workspace directories are rejected
explicitly; MCP reaches the agent only over ACP. The agent intentionally has no
HTTP server, database, UI, or provider registry.
The initial ACP surface accepts text and resource links only; image prompts and
model reasoning controls are not advertised yet.
