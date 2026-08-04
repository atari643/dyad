/**
 * A stand-in for the Claude CLI used by provider tests.
 *
 * It speaks just enough of the real contract -- `--version`, `auth status`,
 * and `--print --output-format stream-json` -- for the provider to be
 * exercised end to end through a real child process, without network access,
 * credentials, or quota. The scenario is selected with FAKE_CLAUDE_SCENARIO.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "success";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function textDelta(text, index = 0) {
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  });
}

if (args.includes("--version")) {
  process.stdout.write("9.9.9 (fake claude)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify({
      loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== "0",
      authMethod: "claude.ai",
      subscriptionType: "pro",
    }) + "\n",
  );
  process.exit(0);
}

// Generation mode: read the prompt from stdin, exactly as the provider sends it.
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const systemPromptIndex = args.indexOf("--system-prompt-file");
  const systemPrompt =
    systemPromptIndex === -1
      ? ""
      : readFileSync(args[systemPromptIndex + 1], "utf8");

  if (scenario === "exit-error") {
    process.stderr.write("fake CLI failure detail\n");
    process.exit(2);
  }

  if (scenario === "rate-limit") {
    emit({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1785894000,
      },
    });
    process.exit(1);
  }

  if (scenario === "hang") {
    // Never exits: lets a test assert the timeout path.
    setInterval(() => {}, 1000);
    return;
  }

  emit({ type: "system", subtype: "init", session_id: "fake-session" });
  // Echo the inputs back so tests can assert how the prompt was transported.
  textDelta(`stdin:${stdin}`);
  textDelta(`|system:${systemPrompt}`);
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: "fake result",
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
    },
  });
  process.exit(0);
});
