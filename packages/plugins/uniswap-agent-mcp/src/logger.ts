/**
 * Minimal structured logger that always writes to stderr (stdout carries the MCP protocol in
 * stdio mode). Never pass secrets, request bodies or headers to it.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent';

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, silent: -1 };

export function createLogger(level: LogLevel = 'info', name = 'uniswap-agent-mcp'): Logger {
  const max = ORDER[level];
  const write = (
    lvl: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>
  ) => {
    if (max < 0 || ORDER[lvl] > max) return;
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      name,
      msg,
      ...fields,
    });
    process.stderr.write(`${line}\n`);
  };
  return {
    error: (m, f) => write('error', m, f),
    warn: (m, f) => write('warn', m, f),
    info: (m, f) => write('info', m, f),
    debug: (m, f) => write('debug', m, f),
  };
}

export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
