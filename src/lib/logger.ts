/**
 * logger — minimal structured logger.
 *
 * Writes to process.stderr in both formats so it's always safe for stdio
 * MCP mode (which uses stdout as the JSON-RPC transport). Never writes
 * to stdout. Ever.
 *
 * Two output formats:
 *   - 'json' (production): one JSON object per line, newline-delimited.
 *     Easy to pipe into Logtail / Axiom / Datadog log drains.
 *   - 'pretty' (dev): human-readable text with level and fields.
 *
 * Format selection (highest priority wins):
 *   1. LOG_FORMAT env var ('json' | 'pretty')
 *   2. NODE_ENV === 'production' → json
 *   3. Default → pretty
 *
 * The logger intentionally has no transports, no plugins, no middleware.
 * If richer output is ever needed, pipe the JSON stream into a real
 * aggregator instead of adding complexity here.
 *
 * Usage:
 *   import { logger } from './lib/logger.js';
 *   logger.info('deposit credited', { userId, amount, txId });
 *   logger.warn('refund replay blocked', { txId });
 *   logger.error('play failed', { userId, error: e });
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// ── Config (resolved once at module load) ──────────────────────

function resolveFormat(): 'json' | 'pretty' {
  const explicit = process.env.LOG_FORMAT?.toLowerCase();
  if (explicit === 'json' || explicit === 'pretty') return explicit;
  if (process.env.NODE_ENV === 'production') return 'json';
  return 'pretty';
}

function resolveMinLevel(): number {
  const explicit = process.env.LOG_LEVEL?.toLowerCase() as Level | undefined;
  if (explicit && explicit in LEVEL_ORDER) return LEVEL_ORDER[explicit];
  return LEVEL_ORDER.info;
}

const format = resolveFormat();
const minLevel = resolveMinLevel();

// ── Pretty format helpers ──────────────────────────────────────

const LEVEL_COLORS: Record<Level, string> = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
};
const RESET = '\x1b[0m';

function formatPretty(level: Level, msg: string, fields: Record<string, unknown>): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const color = LEVEL_COLORS[level];
  const head = `${color}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}`;
  const keys = Object.keys(fields);
  if (keys.length === 0) return head;
  const pairs = keys
    .map((k) => `${k}=${formatValue(fields[k])}`)
    .join(' ');
  return `${head} ${pairs}`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Error) return `"${v.message}"`;
  if (typeof v === 'string') return v.includes(' ') ? `"${v}"` : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── JSON format ────────────────────────────────────────────────

function formatJson(level: Level, msg: string, fields: Record<string, unknown>): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  for (const [k, v] of Object.entries(fields)) {
    // Serialize Error instances with stack + message, not their useless {}
    if (v instanceof Error) {
      record[k] = { message: v.message, name: v.name, stack: v.stack };
    } else {
      record[k] = v;
    }
  }
  return JSON.stringify(record);
}

// ── Emit ───────────────────────────────────────────────────────

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const line = format === 'json'
    ? formatJson(level, msg, fields)
    : formatPretty(level, msg, fields);
  // Always stderr — never stdout. stdio MCP uses stdout for JSON-RPC.
  process.stderr.write(line + '\n');
}

// ── Public API ─────────────────────────────────────────────────

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** Returns true if the logger is in JSON mode (production). */
export function isJsonFormat(): boolean {
  return format === 'json';
}
