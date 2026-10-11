import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Capability, DisplayInfo } from '@buddy/protocol';
import { ComputerError, type CaptureResult, type ComputerController, type Point } from './types.js';
import { readPngSize } from './darwin.js';

const run = promisify(execFile);

/**
 * Linux (X11, and Wayland where the compositor allows it).
 *
 * Uses the small command-line tools that are already on most desktops:
 * xdotool for input, one of import/scrot/gnome-screenshot for pictures, xclip
 * for the clipboard. Missing tools are reported honestly rather than faked,
 * and everything still works in simulate mode if you're on a headless box.
 *
 *   sudo apt install xdotool xclip imagemagick
 *   sudo dnf install xdotool xclip ImageMagick
 */

export class LinuxComputer implements ComputerController {
  readonly kind = 'linux' as const;
  readonly supported: Capability[] = [
    'screen',
    'pointer',
    'mouse',
    'keyboard',
    'apps',
    'clipboard'
  ];

  private cachedDisplays: DisplayInfo[] | null = null;
  private readonly missing = new Set<string>();

  describe(): string {
    const gaps = [...this.missing];
    return gaps.length
      ? `Linux (missing ${gaps.join(', ')} — sudo apt install xdotool xclip imagemagick)`
      : 'Linux (xdotool + ImageMagick)';
  }

  async displays(): Promise<DisplayInfo[]> {
    if (this.cachedDisplays) return this.cachedDisplays;
    let width = 1920;
    let height = 1080;
    try {
      const { stdout } = await run('xdotool', ['getdisplaygeometry'], { timeout: 5000 });
      const [w, h] = stdout.trim().split(/\s+/).map(Number);
      if (w && h) {
        width = w;
        height = h;
      }
    } catch {
      this.missing.add('xdotool');
    }
    this.cachedDisplays = [
      {
        id: 1,
        label: process.env.DISPLAY ?? ':0',
        bounds: { x: 0, y: 0, width, height },
        workArea: { x: 0, y: 0, width, height },
        scaleFactor: 1,
        primary: true
      }
    ];
    return this.cachedDisplays;
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const displays = await this.displays();
    const primary = displays[0]!;
    return { width: primary.bounds.width, height: primary.bounds.height };
  }

  async mousePosition(): Promise<Point | null> {
    try {
      const { stdout } = await run('xdotool', ['getmouselocation', '--shell'], { timeout: 5000 });
      const x = /X=(\d+)/.exec(stdout)?.[1];
      const y = /Y=(\d+)/.exec(stdout)?.[1];
      return x && y ? { x: Number(x), y: Number(y) } : null;
    } catch {
      return null;
    }
  }

  async activeWindow(): Promise<{ app: string; title: string } | null> {
    try {
      const { stdout } = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 5000 });
      const title = stdout.trim();
      const app = /xdotool/.test(stdout) ? '' : title.split(/[—–-]/)[0]?.trim() ?? '';
      return { app: app || 'Unknown', title };
    } catch {
      return null;
    }
  }

  async runningApps(): Promise<string[]> {
    try {
      const { stdout } = await run('wmctrl', ['-lx'], { timeout: 5000 });
      const apps = stdout
        .split('\n')
        .map((line) => line.split(/\s+/)[2])
        .filter((value): value is string => Boolean(value))
        .map((value) => value.replace(/^.*\./, ''));
      return [...new Set(apps)];
    } catch {
      this.missing.add('wmctrl');
      return [];
    }
  }

  async capture(options: {
    region: 'full' | 'window' | 'cursor';
    cursorPoint?: Point | null;
    maxWidth?: number;
    displayId?: number;
  }): Promise<CaptureResult> {
    const maxWidth = options.maxWidth ?? 1440;
    const { width: screenWidth, height: screenHeight } = await this.screenSize();

    let rect = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    if (options.region === 'cursor') {
      const cursor = options.cursorPoint ?? (await this.mousePosition()) ?? { x: screenWidth / 2, y: screenHeight / 2 };
      const width = Math.min(screenWidth, 1100);
      const height = Math.min(screenHeight, 720);
      rect = {
        x: Math.max(0, Math.min(screenWidth - width, Math.round(cursor.x - width / 2))),
        y: Math.max(0, Math.min(screenHeight - height, Math.round(cursor.y - height / 2))),
        width,
        height
      };
    }

    const dir = mkdtempSync(join(tmpdir(), 'buddy-shot-'));
    const file = join(dir, 'shot.png');
    const geometry = `${rect.width}x${rect.height}+${rect.x}+${rect.y}`;
    const attempts: [string, string[]][] = [
      ['import', ['-window', 'root', '-crop', geometry, '+repage', file]],
      ['scrot', ['-a', `${rect.x},${rect.y},${rect.width},${rect.height}`, file]],
      ['gnome-screenshot', ['-f', file, `--area=${rect.x},${rect.y},${rect.width},${rect.height}`]]
    ];

    let captured = false;
    for (const [command, args] of attempts) {
      try {
        await run(command, args, { timeout: 15_000 });
        if (existsSync(file)) {
          captured = true;
          break;
        }
      } catch {
        this.missing.add(command);
      }
    }
    if (!captured) {
      throw new ComputerError(
        'No screenshot tool found. Install ImageMagick (import), scrot or gnome-screenshot.',
        'failed'
      );
    }

    // Shrink if needed; convert is part of ImageMagick, so it may not exist.
    const scale = Math.min(1, maxWidth / rect.width);
    if (scale < 1) {
      const scaled = join(dir, 'scaled.png');
      try {
        await run('convert', [file, '-resize', `${Math.round(rect.width * scale)}x`, scaled], { timeout: 15_000 });
        if (existsSync(scaled)) {
          const png = readFileSync(scaled);
          const size = readPngSize(png);
          return this.result(png, size, rect, screenWidth, screenHeight);
        }
      } catch {
        this.missing.add('convert');
      }
    }

    const png = readFileSync(file);
    const size = readPngSize(png);
    return this.result(png, size, rect, screenWidth, screenHeight);
  }

  private result(
    png: Buffer,
    size: { width: number; height: number },
    rect: { x: number; y: number; width: number; height: number },
    screenWidth: number,
    screenHeight: number
  ): CaptureResult {
    return {
      png,
      width: size.width || rect.width,
      height: size.height || rect.height,
      origin: { x: rect.x, y: rect.y },
      screenWidth,
      screenHeight,
      displayId: 1,
      label: 'Display'
    };
  }

  async moveMouse(point: Point): Promise<void> {
    await this.xdotool(['mousemove', String(Math.round(point.x)), String(Math.round(point.y))]);
  }

  async click(point: Point, options: { double?: boolean; button?: 'left' | 'right' } = {}): Promise<void> {
    await this.moveMouse(point);
    await this.xdotool([
      'click',
      options.double ? '--repeat' : '--clearmodifiers',
      ...(options.double ? ['2', '--delay', '60'] : []),
      options.button === 'right' ? '3' : '1'
    ]);
  }

  async typeText(text: string): Promise<void> {
    // `xdotool type` handles unicode, but long strings are slow: keep chunks.
    const chunks = text.match(/[\s\S]{1,400}/g) ?? [];
    for (const chunk of chunks) {
      await this.xdotool(['type', '--delay', '8', '--', chunk], 60_000);
    }
  }

  async pressKeys(press: { keys: string; repeat?: number }): Promise<void> {
    const keys = press.keys.replace(/\+/g, '+').replace(/\s+/g, ' ');
    const repeat = Math.max(1, Math.min(50, press.repeat ?? 1));
    await this.xdotool(['key', '--clearmodifiers', '--repeat', String(repeat), '--delay', '40', keys]);
  }

  async openApp(name: string): Promise<{ ok: boolean; message: string }> {
    const candidates = [name, name.toLowerCase(), name.replace(/\s+/g, '-').toLowerCase()];
    for (const candidate of candidates) {
      try {
        await run('gtk-launch', [candidate], { timeout: 10_000, detached: true } as never);
        return { ok: true, message: `${name} is starting.` };
      } catch {
        /* try the next */
      }
      try {
        const { stdout } = await run('bash', ['-lc', `command -v ${JSON.stringify(candidate)}`], { timeout: 5000 });
        if (stdout.trim()) {
          await run('bash', ['-lc', `${JSON.stringify(candidate)} >/dev/null 2>&1 &`], { timeout: 5000 });
          return { ok: true, message: `${name} is starting.` };
        }
      } catch {
        /* keep going */
      }
    }
    return { ok: false, message: `I couldn't find an app called "${name}".` };
  }

  async openUrl(url: string): Promise<{ ok: boolean; message: string }> {
    try {
      await run('xdg-open', [url], { timeout: 10_000 });
      return { ok: true, message: 'It is open in your browser.' };
    } catch {
      return { ok: false, message: "That link wouldn't open." };
    }
  }

  async readClipboard(): Promise<string> {
    try {
      const { stdout } = await run('xclip', ['-selection', 'clipboard', '-o'], { timeout: 5000 });
      return stdout;
    } catch {
      this.missing.add('xclip');
      return '';
    }
  }

  async writeClipboard(text: string): Promise<void> {
    const child = execFile('xclip', ['-selection', 'clipboard'], { timeout: 5000 });
    child.stdin?.end(text);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
  }

  async runShortcut(
    name: string,
    args?: string
  ): Promise<{ ok: boolean; message: string; output?: string }> {
    // A shortcut is a .desktop entry. Anything else needs an explicit allow-list.
    try {
      await run('gtk-launch', [name], { timeout: 15_000 });
      return { ok: true, message: `"${name}" is running.` };
    } catch {
      return { ok: false, message: `I couldn't find an app shortcut called "${name}".` };
    }
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async xdotool(args: string[], timeout = 20_000): Promise<void> {
    try {
      await run('xdotool', args, { timeout });
    } catch (error) {
      this.missing.add('xdotool');
      throw new ComputerError(
        'xdotool is not installed, so Buddy cannot move the mouse or type. Install it with: sudo apt install xdotool',
        'unsupported'
      );
    }
  }
}
