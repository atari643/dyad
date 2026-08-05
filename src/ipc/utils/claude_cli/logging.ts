import log from "electron-log";

const logger = log.scope("claude-cli");

/**
 * Diagnostics for the CLI provider.
 *
 * These lines are logged at debug level, which Dyad hides by default. Setting
 * `DYAD_CLAUDE_CLI_DEBUG=1` promotes them to info so the resolved binary,
 * arguments and payload sizes can be inspected without turning on debug
 * logging for the whole application.
 *
 * The env var is read per call rather than cached so it can be flipped in a
 * running dev session.
 */
export function debugLog(message: string): void {
  if (process.env.DYAD_CLAUDE_CLI_DEBUG === "1") {
    logger.info(message);
    return;
  }
  logger.debug(message);
}

export { logger };
