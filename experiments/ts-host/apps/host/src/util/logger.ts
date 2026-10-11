import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A tiny logger that is pleasant in a terminal and readable in a file.
 * No dependency, no ceremony, and it never throws — logging should not be the
 * thing that takes Buddy down.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  data?: unknown;
}

const COLOURS: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m'
};

const RESET = '\u001b[0m';
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export interface LoggerOptions {
  level?: LogLevel;
  file?: string;
  /** Set by --quiet / BUDDY_QUIET. */
  silent?: boolean;
  colour?: boolean;
}

export class Logger implements Record<'debug' | 'info' | 'warn' | 'error', (message: string, data?: unknown) => void> {
  [key: string]: unknown;

  private readonly level: LogLevel;
  private readonly file?: string;
  private readonly silent: boolean;
  private readonly colour: boolean;
  private readonly recent: LogEntry[] = [];

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? ((process.env.BUDDY_LOG_LEVEL as LogLevel) || 'info');
    this.file = options.file;
    this.silent = options.silent ?? process.env.BUDDY_QUIET === '1';
    this.colour = options.colour ?? Boolean(process.stdout.isTTY);
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        if (!existsSync(this.file)) writeFileSync(this.file, '');
      } catch {
        /* logging to a file is best effort */
      }
    }
  }

  debug = (message: string, data?: unknown): void => this.write('debug', message, data);
  info = (message: string, data?: unknown): void => this.write('info', message, data);
  warn = (message: string, data?: unknown): void => this.write('warn', message, data);
  error = (message: string, data?: unknown): void => this.write('error', message, data);

  /** The last N entries, for the settings screen's "recent activity". */
  tail(count = 40): LogEntry[] {
    return this.recent.slice(-count);
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = { at: Date.now(), level, message, data };
    this.recent.push(entry);
    if (this.recent.length > 200) this.recent.shift();

    if (this.shouldPrint(level) && !this.silent) {
      const time = new Date(entry.at).toLocaleTimeString();
      const tag = this.colour ? `${COLOURS[level]}${level.padEnd(5)}${RESET}` : level.padEnd(5);
      const extra = data === undefined ? '' : ` ${format(data)}`;
      const line = `${this.colour ? '\u001b[90m' : ''}${time}${this.colour ? RESET : ''} ${tag} ${message}${extra}`;
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    }

    if (this.file) {
      try {
        // Roll the file so it can't grow forever on a machine that runs for weeks.
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
        if (Math.random() < 0.01 && existsSync(this.file)) {
          const contents = readFileSync(this.file);
          if (contents.byteLength > MAX_LOG_BYTES) {
            writeFileSync(this.file, contents.subarray(contents.byteLength - MAX_LOG_BYTES / 2));
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private shouldPrint(level: LogLevel): boolean {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(level) >= order.indexOf(this.level);
  }
}

const format = (data: unknown): string => {
  if (typeof data === 'string') return data;
  try {
    const json = JSON.stringify(data);
    return json && json.length > 600 ? `${json.slice(0, 600)}…` : (json ?? String(data));
  } catch {
    return String(data);
  }
};
