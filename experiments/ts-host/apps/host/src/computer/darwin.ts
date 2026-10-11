import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Capability, DisplayInfo } from '@buddy/protocol';
import { stateDir } from '../config.js';
import { ComputerError, type CaptureResult, type ComputerController, type Point } from './types.js';

const run = promisify(execFile);

/**
 * macOS.
 *
 * Two tools do all the work, and both ship with the machine:
 *   • `buddy-helper` — our own ~600-line Swift binary, compiled on first use
 *     with the Command Line Tools. It moves the mouse, types, presses keys and
 *     reads windows. This is why Buddy needs no Homebrew anything.
 *   • `screencapture` / `sips` — grabs the screen and shrinks it for the
 *     vision pass.
 */

const HELPER_NAME = 'buddy-helper';

export interface DarwinOptions {
  /** Force a recompile (used by `buddy doctor`). */
  rebuild?: boolean;
  verbose?: boolean;
}

export class DarwinComputer implements ComputerController {
  readonly kind = 'darwin' as const;
  readonly supported: Capability[] = [
    'screen',
    'pointer',
    'mouse',
    'keyboard',
    'apps',
    'clipboard',
    'shortcuts'
  ];

  private helperPath: string | null = null;
  private compileError: string | null = null;
  private permissionChecked = false;
  private trusted: boolean | null = null;
  private readonly verbose: boolean;
  private readonly rebuild: boolean;
  private cachedDisplays: DisplayInfo[] | null = null;

  constructor(options: DarwinOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.rebuild = options.rebuild ?? false;
  }

  describe(): string {
    if (this.compileError) return `macOS (helper failed to build: ${this.compileError})`;
    return 'macOS (native helper + screencapture)';
  }

  /** Compile the helper if it isn't built yet. Safe to call repeatedly. */
  private async ensureHelper(): Promise<string> {
    if (this.helperPath && existsSync(this.helperPath)) return this.helperPath;
    if (this.compileError) throw new ComputerError(this.compileError, 'failed');

    const binDir = join(stateDir, 'bin');
    const binary = join(binDir, HELPER_NAME);
    const source = join(fileURLToPath(new URL('../native/', import.meta.url)), 'buddy-helper.swift');

    // When running from `dist/`, the source sits one level up in `src/native`.
    const sourceCandidates = [
      source,
      join(fileURLToPath(new URL('../../src/native/', import.meta.url)), 'buddy-helper.swift')
    ];
    const sourcePath = sourceCandidates.find((path) => existsSync(path));

    if (!this.rebuild && existsSync(binary) && sourcePath) {
      // Recompile if the source is newer than the binary (you edited it).
      try {
        if (statSync(binary).mtimeMs > statSync(sourcePath).mtimeMs) {
          this.helperPath = binary;
          return binary;
        }
      } catch {
        this.helperPath = binary;
        return binary;
      }
    }

    if (!sourcePath) {
      throw new ComputerError(
        `Buddy's macOS helper source is missing (looked in ${sourceCandidates.join(', ')}).`,
        'failed'
      );
    }

    mkdirSync(binDir, { recursive: true });
    try {
      await run('/usr/bin/swiftc', ['-O', '-o', binary, sourcePath], { timeout: 120_000 });
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr ?? String(error);
      this.compileError = `Building Buddy's helper failed. Run "xcode-select --install" once, then restart. (${detail.slice(0, 200)})`;
      throw new ComputerError(this.compileError, 'failed');
    }

    this.helperPath = binary;
    return binary;
  }

  /** Every screen on the machine, in the coordinates the helper speaks. */
  async displays(): Promise<DisplayInfo[]> {
    if (this.cachedDisplays) return this.cachedDisplays;
    try {
      const raw = await this.helperJson<RawDisplay[]>(['displays']);
      this.cachedDisplays = raw.map((display) => ({
        id: display.id,
        label: display.label ?? `Display ${display.id}`,
        bounds: display.bounds,
        workArea: display.workArea ?? display.bounds,
        scaleFactor: display.scale ?? 2,
        primary: Boolean(display.primary)
      }));
      return this.cachedDisplays;
    } catch {
      // The helper is the only way to know; fall back to the main screen size.
      const { width, height } = await this.screenSize();
      this.cachedDisplays = [
        {
          id: 1,
          label: 'Main display',
          bounds: { x: 0, y: 0, width, height },
          workArea: { x: 0, y: 0, width, height },
          scaleFactor: 2,
          primary: true
        }
      ];
      return this.cachedDisplays;
    }
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    // system_profiler is slow; the helper's display list is not.
    try {
      const displays = await this.displays();
      const primary = displays.find((display) => display.primary) ?? displays[0];
      if (primary) return { width: primary.bounds.width, height: primary.bounds.height };
    } catch {
      /* fall through */
    }
    try {
      const { stdout } = await run('/usr/bin/osascript', [
        '-e',
        'tell application "Finder" to get bounds of window of desktop'
      ]);
      const [left, top, right, bottom] = stdout
        .trim()
        .split(', ')
        .map((value) => Number(value));
      if (right && bottom) {
        return { width: Math.round((right ?? 0) - (left ?? 0)), height: Math.round((bottom ?? 0) - (top ?? 0)) };
      }
    } catch {
      /* ignore */
    }
    return { width: 1440, height: 900 };
  }

  async mousePosition(): Promise<Point | null> {
    try {
      const output = await this.helper(['mouse-pos']);
      const [x, y] = output.trim().split(',').map(Number);
      return x !== undefined && y !== undefined ? { x, y } : null;
    } catch {
      return null;
    }
  }

  async activeWindow(): Promise<{ app: string; title: string } | null> {
    try {
      const json = await this.helperJson<{ app?: string; title?: string }>(['active-window']);
      if (!json.app) return null;
      return { app: json.app, title: json.title ?? '' };
    } catch {
      return null;
    }
  }

  async runningApps(): Promise<string[]> {
    try {
      return await this.helperJson<string[]>(['apps']);
    } catch {
      return [];
    }
  }

  // ── Seeing ───────────────────────────────────────────────────────────────

  async capture(options: {
    region: 'full' | 'window' | 'cursor';
    cursorPoint?: Point | null;
    maxWidth?: number;
    displayId?: number;
  }): Promise<CaptureResult> {
    await this.ensureHelper();
    const maxWidth = options.maxWidth ?? 1440;
    const displays = await this.displays();
    const display =
      displays.find((entry) => entry.id === options.displayId) ??
      displays.find((entry) => entry.primary) ??
      displays[0]!;

    // Choose the rectangle to grab, in screen points.
    let rect = { ...display.bounds };
    if (options.region === 'cursor') {
      const cursor = options.cursorPoint ?? (await this.mousePosition()) ?? {
        x: display.bounds.x + display.bounds.width / 2,
        y: display.bounds.y + display.bounds.height / 2
      };
      const width = Math.min(display.bounds.width, 1100);
      const height = Math.min(display.bounds.height, 720);
      rect = {
        x: Math.max(display.bounds.x, Math.min(display.bounds.x + display.bounds.width - width, cursor.x - width / 2)),
        y: Math.max(display.bounds.y, Math.min(display.bounds.y + display.bounds.height - height, cursor.y - height / 2)),
        width,
        height
      };
    } else if (options.region === 'window') {
      const window = await this.frontWindowRect();
      if (window) rect = window;
    }

    const tempFile = join(tmpdir(), `buddy-shot-${Date.now()}.png`);
    const args = ['-x', '-o', '-t', 'png'];
    if (options.region !== 'full' || rect.width < display.bounds.width || rect.height < display.bounds.height) {
      args.push('-R', `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
    } else {
      args.push('-D', String(display.id));
    }
    args.push(tempFile);

    try {
      await run('/usr/bin/screencapture', args, { timeout: 15_000 });
    } catch (error) {
      throw new ComputerError(
        `Screen capture failed: ${(error as { stderr?: string }).stderr ?? 'unknown error'}`,
        'failed'
      );
    }

    if (!existsSync(tempFile)) {
      throw new ComputerError(
        'Screen capture produced nothing. Give Buddy permission in System Settings → Privacy & Security → Screen Recording.',
        'permission'
      );
    }

    // Shrink it: a 5K screenshot is megabytes of tokens and no more accurate.
    const scaledWidth = Math.min(maxWidth, Math.round(rect.width * display.scaleFactor));
    if (scaledWidth < Math.round(rect.width * display.scaleFactor)) {
      try {
        await run('/usr/bin/sips', ['-Z', String(scaledWidth), tempFile], { timeout: 15_000 });
      } catch {
        /* a big image still works, just costs more */
      }
    }

    const png = readFileSync(tempFile);
    const dimensions = readPngSize(png);
    return {
      png,
      width: dimensions.width || Math.round(rect.width * display.scaleFactor),
      height: dimensions.height || Math.round(rect.height * display.scaleFactor),
      origin: { x: rect.x, y: rect.y },
      screenWidth: display.bounds.width,
      screenHeight: display.bounds.height,
      displayId: display.id,
      label: display.label
    };
  }

  /** The focused window's rect, so "look at this window" is actually cheap. */
  private async frontWindowRect(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const window = await this.helperJson<{ x: number; y: number; w: number; h: number }[]>([
        'windows'
      ]);
      const best = window.find((entry) => entry.w >= 200 && entry.h >= 120);
      if (!best) return null;
      return { x: best.x, y: best.y, width: best.w, height: best.h };
    } catch {
      return null;
    }
  }

  // ── Doing ────────────────────────────────────────────────────────────────

  async moveMouse(point: Point): Promise<void> {
    await this.helper(['move', String(Math.round(point.x)), String(Math.round(point.y))]);
  }

  async click(point: Point, options: { double?: boolean; button?: 'left' | 'right' } = {}): Promise<void> {
    const args = ['click', String(Math.round(point.x)), String(Math.round(point.y))];
    if (options.double) args.push('--double');
    if (options.button === 'right') args.push('--right');
    await this.helper(args);
  }

  async typeText(text: string): Promise<void> {
    // Chunked so a very long paste doesn't blow past ARG_MAX or the event tap.
    const chunks = splitForArgv(text, 1200);
    for (const chunk of chunks) {
      await this.helper(['type', chunk], 30_000);
    }
  }

  async pressKeys(press: { keys: string; repeat?: number }): Promise<void> {
    const args = ['key', press.keys];
    if (press.repeat && press.repeat > 1) args.push('--repeat', String(Math.min(50, press.repeat)));
    await this.helper(args);
  }

  async openApp(name: string): Promise<{ ok: boolean; message: string }> {
    // `open -a` matches on the display name and is far more forgiving than
    // guessing at bundle paths.
    try {
      await run('/usr/bin/open', ['-a', name], { timeout: 15_000 });
      return { ok: true, message: `${name} is up.` };
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr ?? '';
      if (detail.includes('Unable to find application')) {
        return { ok: false, message: `I couldn't find an app called "${name}".` };
      }
      return { ok: false, message: `Opening ${name} didn't work.` };
    }
  }

  async openUrl(url: string): Promise<{ ok: boolean; message: string }> {
    try {
      await run('/usr/bin/open', [url], { timeout: 15_000 });
      return { ok: true, message: 'It is open in your browser.' };
    } catch {
      return { ok: false, message: "That link wouldn't open." };
    }
  }

  async readClipboard(): Promise<string> {
    const { stdout } = await run('/usr/bin/pbpaste', [], { timeout: 5000 });
    return stdout;
  }

  async writeClipboard(text: string): Promise<void> {
    const child = execFile('/usr/bin/pbcopy', [], { timeout: 5000 });
    child.stdin?.end(text);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
  }

  async runShortcut(
    name: string,
    args?: string
  ): Promise<{ ok: boolean; message: string; output?: string }> {
    // `shortcuts run` arrived in macOS 12. Older systems get told honestly.
    try {
      const result = await run(
        '/usr/bin/shortcuts',
        ['run', name, ...(args ? ['-i', args] : [])],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
      );
      return { ok: true, message: `"${name}" ran.`, output: result.stdout.slice(0, 4000) };
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr ?? String(error);
      if (detail.includes('No such shortcut') || detail.includes('not found')) {
        return { ok: false, message: `There's no shortcut called "${name}".` };
      }
      return { ok: false, message: `That shortcut didn't run: ${detail.slice(0, 160)}` };
    }
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Accessibility + Screen Recording status, for the menu and the doctor. */
  async permissions(): Promise<{ postEvents: boolean; accessibility: boolean }> {
    try {
      const json = await this.helperJson<{ postEvents?: boolean; accessibility?: boolean }>([
        'permissions'
      ]);
      this.trusted = Boolean(json.postEvents);
      return {
        postEvents: Boolean(json.postEvents),
        accessibility: Boolean(json.accessibility)
      };
    } catch {
      return { postEvents: false, accessibility: false };
    }
  }

  /** Show the system prompt that sends the user to the right settings pane. */
  async requestPermissions(): Promise<void> {
    try {
      await run('/usr/bin/open', [
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      ]);
    } catch {
      /* the user can find it themselves */
    }
    this.permissionChecked = true;
  }

  /** Cached permission state, for the status API (never throws, never blocks). */
  get permissionSnapshot(): { postEvents: boolean; accessibility: boolean } | null {
    if (this.trusted === null) {
      void this.permissions().catch(() => undefined);
      return null;
    }
    return { postEvents: this.trusted, accessibility: this.trusted };
  }

  get isTrusted(): boolean | null {
    return this.trusted;
  }

  /**
   * Every control the focused window exposes to the Accessibility tree, with
   * its screen rect. Free, exact and instant — this is what lets Buddy land
   * dead on the right button instead of approximating with a vision model.
   */
  async listControls(): Promise<AxNode[]> {
    try {
      const nodes = await this.helperJson<AxNode[]>(['ax-controls']);
      return Array.isArray(nodes) ? nodes : [];
    } catch {
      return [];
    }
  }

  /** Search the focused window for text/matching controls. */
  async searchText(query: string): Promise<AxNode[]> {
    try {
      const nodes = await this.helperJson<AxNode[]>(['ax-text', query]);
      return Array.isArray(nodes) ? nodes : [];
    } catch {
      return [];
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private async helper(args: string[], timeout = 20_000): Promise<string> {
    const binary = await this.ensureHelper();
    try {
      const { stdout } = await run(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (!this.permissionChecked) {
        this.permissionChecked = true;
        const permissions = await this.permissions();
        this.trusted = permissions.postEvents;
        if (!permissions.postEvents) {
          throw new ComputerError(
            'Buddy needs Accessibility permission to move the mouse and type. Open System Settings → Privacy & Security → Accessibility and switch Buddy on.',
            'permission'
          );
        }
      }
      throw new ComputerError(stderr.trim() || `buddy-helper ${args[0]} failed`, 'failed');
    }
  }

  private async helperJson<T>(args: string[]): Promise<T> {
    const stdout = await this.helper(args);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new ComputerError(`buddy-helper ${args[0]} returned something unreadable`, 'failed');
    }
  }
}

interface RawDisplay {
  id: number;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea?: { x: number; y: number; width: number; height: number };
  scale?: number;
  primary?: boolean;
}

/** A node from the Accessibility tree, positioned in screen points. */
export interface AxNode {
  text: string;
  role?: string;
  /** Centre of the element, in screen points. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Read width/height out of a PNG header, so the caller knows the scale factor. */
export const readPngSize = (buffer: Buffer): { width: number; height: number } => {
  if (buffer.length > 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
};

/** Split a long string into argv-safe pieces, preferring word boundaries. */
export const splitForArgv = (text: string, limit: number): string[] => {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.6) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

/** Used by the doctor command to prove the helper builds on this machine. */
export const buildHelper = async (): Promise<{ ok: boolean; detail: string }> => {
  try {
    const computer = new DarwinComputer({ rebuild: true });
    await (computer as unknown as { ensureHelper: () => Promise<string> }).ensureHelper();
    return { ok: true, detail: 'helper compiled' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
  }
};

export const writeHelperSourceIfMissing = (target: string, source: string): void => {
  if (!existsSync(target)) writeFileSync(target, source, 'utf8');
};
