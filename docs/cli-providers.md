# CLI providers (run models locally, without an API key)

Dyad normally talks to models over paid HTTP APIs. A **CLI provider** instead
drives an AI coding CLI that is already installed and signed in on your machine,
so generations are covered by your existing subscription and cost nothing per
token.

Currently shipped: **Claude CLI**.

## How it works

Dyad does not use tool calling for app building. In Build mode the model is a
plain text generator: it emits `<dyad-write>`, `<dyad-rename>`, `<dyad-delete>`,
`<dyad-execute-sql>` and `<dyad-add-dependency>` tags, and Dyad parses them
(`dyad_tag_parser.ts`) and applies them itself (`response_processor.ts`).

The Claude CLI provider leans on exactly that. It runs the CLI with **every
built-in tool disabled** (`--tools ""`), so Claude only writes text and Dyad
keeps full ownership of file edits, diffs, previews and approvals. Nothing about
Dyad's build pipeline changes.

Implementation lives in `src/ipc/utils/claude_cli/`, and is registered as a
normal Vercel AI SDK provider (`LanguageModelV3`) in
`src/ipc/utils/get_model_client.ts`.

## Tool calling

Build mode needs no tools, but Ask, Plan and Agent modes drive an AI SDK tool
loop. The CLI has no native tool-call channel — its own tools are disabled and
it only emits text — so tool calling is emulated over that text.

When a request carries tools, the provider appends a protocol section to the
system prompt describing each tool and its JSON schema, and asks the model to
emit calls as:

```
<dyad_cli_tool_call name="read_file">{"path":"src/main.ts"}</dyad_cli_tool_call>
```

`tool_call_parser.ts` pulls those markers out of the streaming text and emits
real `tool-call` parts, so the rest of Dyad is unaware the channel is emulated.
Previous calls and their results are replayed into the transcript using the same
markers, which keeps multi-step loops coherent.

Three properties matter and are covered by tests:

- **Markers never leak into the chat.** Text is held back whenever its tail
  could still grow into an opening marker, including when the marker is split
  one character per chunk.
- **Malformed calls fail loudly.** A call with invalid JSON or no name is
  emitted as visible text rather than handed to the tool executor.
- **The finish reason reflects reality.** The CLI always reports `end_turn`;
  the provider reports `tool-calls` when calls were extracted, which is what
  makes the agent loop run another step.

## Setup

### 1. Install the Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Sign in

```bash
claude auth login
```

Verify it worked:

```bash
claude auth status
```

You want `"loggedIn": true`. With `"authMethod": "claude.ai"` your requests are
covered by your Claude subscription and **no `ANTHROPIC_API_KEY` is used**.

### 3. Pick the provider in Dyad

Open the model picker and choose one of the **Claude CLI (local)** models —
Sonnet, Opus or Haiku. There is no API key field: credentials live in the CLI.

## Configuration

Everything is optional. With the CLI installed and on your `PATH`, the provider
works with no configuration at all.

| Setting (`claudeCli.*`) | Environment variable         | Default           | Purpose                                 |
| ----------------------- | ---------------------------- | ----------------- | --------------------------------------- |
| `binaryPath`            | `DYAD_CLAUDE_CLI_PATH`       | auto-detected     | Explicit path to the CLI executable     |
| `timeoutMs`             | `DYAD_CLAUDE_CLI_TIMEOUT_MS` | `600000` (10 min) | Kills a run that stops responding       |
| `extraArgs`             | —                            | none              | Extra CLI flags; debugging escape hatch |

Settings take precedence over environment variables, which take precedence over
the defaults.

### Binary resolution

1. `claudeCli.binaryPath`
2. `DYAD_CLAUDE_CLI_PATH`
3. `claude.exe` / `claude.cmd` / `claude` found on `PATH`
4. bare `claude`, so a missing CLI produces a clear error

On Windows, npm installs `claude` as a `.cmd` batch shim, and Node cannot spawn
`.cmd` files without a shell. The resolver automatically prefers the native
`claude.exe` the package ships alongside the shim, which keeps spawning free of
shell quoting rules.

## Limits

Read this section before switching your whole workflow over.

- **Tool calling is emulated, not native.** Ask, Plan and Agent modes need tool
  calling, which the CLI has no channel for. The provider teaches the model a
  text protocol in the system prompt and parses the calls back out (see
  "Tool calling" below). It works — there is an integration test against the
  real CLI — but it depends on the model following a format rather than on a
  guaranteed API contract, so it is inherently less rigid than an API provider.
  A malformed call is surfaced as visible text rather than silently dropped.
- **Subscription quotas, not billing.** Requests are free, but your plan's
  5-hour and weekly limits apply. Dyad sends large codebase contexts, so you
  will consume quota noticeably faster than in ordinary CLI use. Throttling is
  reported as an explicit rate limit error with the reset time.
- **Text only.** Image and file attachments are rejected with a clear error.
- **No sampling controls.** The CLI's print mode accepts no `temperature`,
  `topP`, `maxOutputTokens` or `seed`. Dyad reports these back as AI SDK
  warnings rather than silently ignoring them.
- **~1–2s startup per request** while the CLI process boots. Negligible on long
  generations, noticeable on short exchanges.
- **The output format is an external contract.** `stream-json` is documented and
  stable, but a future CLI release could change it. Parsing is isolated in
  `stream_parser.ts` and tolerates unknown fields and malformed lines.
- **Cost reporting is notional.** The CLI reports a `total_cost_usd` equal to
  what the same request would cost through the API. On a subscription you are
  not charged that amount.

## Troubleshooting

Start with the CLI on its own — if this fails, the problem is not Dyad:

```bash
echo "Reply with just: OK" | claude -p --tools "" --output-format stream-json --include-partial-messages --verbose
```

| Symptom                            | Fix                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| "Claude CLI not found"             | `npm install -g @anthropic-ai/claude-code`, or set `claudeCli.binaryPath`       |
| "not authenticated"                | `claude auth login`                                                             |
| "rate limited"                     | Wait for the reported reset, or switch provider for now                         |
| Raw `<dyad_cli_tool_call>` in chat | The model emitted a malformed call; retry, or use an API provider for that mode |
| Runs hang                          | Raise `claudeCli.timeoutMs`                                                     |

Set `DYAD_CLAUDE_CLI_DEBUG=1` (or enable Dyad's debug logging) to see the
resolved binary, the arguments and payload sizes under the `claude-cli` log
scope. Prompts are never logged in full.

## Running Dyad with this provider

```bash
npm install
npm start
```

Node.js 24 is required (see `engines` in `package.json`).

To run the provider's tests — they use a stub CLI, so they consume no quota and
need no credentials:

```bash
npx vitest run src/ipc/utils/claude_cli
```

## Antigravity CLI (`agy`) — evaluated, not integrated

Google's Antigravity CLI (`agy`, the successor to Gemini CLI) has a headless
mode that looks superficially like the Claude CLI's. It was evaluated against
`agy` 1.1.10 on Windows and **cannot serve Dyad's build mode**. The three
properties the provider design depends on were measured, and all three fail.

**1. The prompt cannot be piped — it must fit in the command line.**

`agy` reads the prompt from the `--print` flag value, not stdin; piped input is
ignored. That puts the entire prompt into argv, where Windows caps a process
command line at 32,767 characters. Measured with `spawnSync`:

| Prompt size  | Result                                    |
| ------------ | ----------------------------------------- |
| 32,000 chars | spawns                                    |
| 33,000 chars | `ENAMETOOLONG` — the process never starts |

Dyad's build-mode system prompt is already on the order of 20,000 characters
before any codebase context or conversation history is appended, and codebase
context alone routinely runs to hundreds of kilobytes. The prompt physically
cannot be delivered. There is no `--system-prompt`, `--prompt-file` or stdin
option to work around it.

**2. Tools cannot be disabled.**

There is no equivalent of `--tools ""`. The `init` event advertises the full
agent toolset (file access, browser control, and more). `agy` would edit files
itself instead of emitting `<dyad-write>` tags, bypassing Dyad's proposal,
diff and approval pipeline — the opposite of what this integration is for.

**3. Streaming is step-level, not token-level.**

`stream-json` emits `init`, `step_update` and `result`. The assistant's text
arrives as a single `text_delta` inside one already-`DONE` step, so responses
would appear all at once rather than streaming into the chat.

Any of these alone would be a hard blocker; together they mean a provider could
only be built on workarounds (spilling the prompt to a file and asking the
agent to read it, then fighting its tools for control of the working tree).
That is more fragile than the API path it would replace, so it was not built.

**Dyad's existing Gemini API provider is untouched and continues to work.**
Revisit this if `agy` gains stdin or file-based prompt input plus a way to run
without tools.
