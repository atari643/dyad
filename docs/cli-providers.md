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

- **Build mode only.** Ask, Plan and Agent modes rely on AI SDK tool calling,
  which the CLI cannot serve in print mode. Selecting a Claude CLI model in
  those modes fails with an explicit message; use an API-based provider there.
  Build mode — Dyad's core app-building loop — is fully supported.
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

| Symptom                         | Fix                                                                       |
| ------------------------------- | ------------------------------------------------------------------------- |
| "Claude CLI not found"          | `npm install -g @anthropic-ai/claude-code`, or set `claudeCli.binaryPath` |
| "not authenticated"             | `claude auth login`                                                       |
| "rate limited"                  | Wait for the reported reset, or switch provider for now                   |
| "does not support tool calling" | Switch to Build mode, or use an API provider                              |
| Runs hang                       | Raise `claudeCli.timeoutMs`                                               |

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

## Antigravity CLI (`agy`)

Google's Antigravity CLI replaced Gemini CLI and offers a comparable headless
mode (`agy -p --output-format stream-json`). It is **not integrated yet**: three
properties that the Claude CLI provider depends on are undocumented for `agy`
and need to be measured before a provider can be built responsibly.

1. Can the prompt be piped through **stdin**? If not, it must travel in argv,
   which caps prompts at roughly 32k characters on Windows — too small for
   codebase context.
2. Can its **tools be disabled**? Otherwise `agy` edits files itself and
   conflicts with Dyad's proposal and approval pipeline.
3. How fine-grained is its streaming? Its documented events (`init`,
   `step_update`, `result`) suggest step-level rather than token-level updates.

Dyad's existing Gemini API provider is unaffected and continues to work.
