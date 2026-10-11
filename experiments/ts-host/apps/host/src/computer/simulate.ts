import type { Capability, DisplayInfo } from '@buddy/protocol';
import { createImage, encodePng, fillRect, strokeCircle } from './png.js';
import type { CaptureResult, ComputerController, Point } from './types.js';

/**
 * Simulate mode.
 *
 * The whole of Buddy works without a screen: this controller pretends to be a
 * computer so the phone app, the overlay, the tool pipeline and the speech
 * session can all be exercised on a headless box (or in CI). It draws a fake
 * desktop so the phone's screen peek has something to show, and it answers
 * "where is X" with a plausible spot instead of a guess at nothing.
 */

const SCREEN = { width: 1512, height: 982 };

interface FakeWindow {
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
  accent: [number, number, number];
  items: { label: string; x: number; y: number; width: number; height: number }[];
}

const windows: FakeWindow[] = [
  {
    title: 'Inbox — Mail',
    app: 'Mail',
    x: 90,
    y: 70,
    width: 620,
    height: 460,
    accent: [72, 118, 255],
    items: [
      { label: 'run Buddy on MacBook', x: 120, y: 180, width: 420, height: 44 },
      { label: 'Standup at 9:30', x: 120, y: 232, width: 420, height: 44 },
      { label: 'Receipt from the coffee place', x: 120, y: 284, width: 420, height: 44 }
    ]
  },
  {
    title: 'Chrome — three tabs',
    app: 'Chrome',
    x: 740,
    y: 140,
    width: 660,
    height: 520,
    accent: [40, 176, 120],
    items: [
      { label: 'Search box', x: 790, y: 200, width: 560, height: 40 },
      { label: 'New post', x: 790, y: 280, width: 200, height: 40 },
      { label: 'Send', x: 1210, y: 700, width: 120, height: 44 }
    ]
  }
];

const mouse: Point = { x: 620, y: 430 };
const typed: string[] = [];
let clipboard = 'nothing copied yet';

export class SimulatedComputer implements ComputerController {
  readonly kind = 'simulate' as const;
  readonly supported: Capability[] = [
    'screen',
    'pointer',
    'mouse',
    'keyboard',
    'apps',
    'clipboard',
    'shortcuts'
  ];
  /** Labels the sim knows, so locateTarget has something to find. */
  private readonly log: string[] = [];

  describe(): string {
    return 'simulate mode (no real screen control — everything is pretend)';
  }

  history(): string[] {
    return [...this.log];
  }

  async displays(): Promise<DisplayInfo[]> {
    return [
      {
        id: 1,
        label: 'Simulated display',
        bounds: { x: 0, y: 0, ...SCREEN },
        workArea: { x: 0, y: 24, width: SCREEN.width, height: SCREEN.height - 24 },
        scaleFactor: 2,
        primary: true
      }
    ];
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    return { ...SCREEN };
  }

  async mousePosition(): Promise<Point> {
    return { ...mouse };
  }

  async activeWindow(): Promise<{ app: string; title: string } | null> {
    return { app: 'Mail', title: windows[0]!.title };
  }

  async runningApps(): Promise<string[]> {
    return ['Mail', 'Chrome', 'Finder', 'Terminal', 'Music'];
  }

  async capture(options: {
    region: 'full' | 'window' | 'cursor';
    cursorPoint?: Point | null;
    maxWidth?: number;
  }): Promise<CaptureResult> {
    const image = this.draw();
    let origin: Point = { x: 0, y: 0 };
    let region = image;

    if (options.region === 'cursor') {
      const centre = options.cursorPoint ?? mouse;
      const width = 900;
      const height = 620;
      origin = {
        x: Math.max(0, Math.min(SCREEN.width - width, centre.x - width / 2)),
        y: Math.max(0, Math.min(SCREEN.height - height, centre.y - height / 2))
      };
      region = this.crop(image, origin.x, origin.y, width, height);
    }

    const png = encodePng(region);
    this.log.push(`capture ${options.region} → ${region.width}x${region.height}`);
    return {
      png,
      width: region.width,
      height: region.height,
      origin,
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
      displayId: 1,
      label: 'Simulated display'
    };
  }

  async moveMouse(point: Point): Promise<void> {
    const constrained = this.constrain(point);
    mouse.x = constrained.x;
    mouse.y = constrained.y;
    this.log.push(`move mouse → ${constrained.x},${constrained.y}`);
  }

  async click(point: Point, options: { double?: boolean; button?: 'left' | 'right' } = {}): Promise<void> {
    await this.moveMouse(point);
    this.log.push(`click ${options.button ?? 'left'}${options.double ? ' (double)' : ''}`);
  }

  async typeText(text: string): Promise<void> {
    const target = this.findFocusedField();
    typed.push(text);
    this.log.push(`type ${text.length} chars${target ? ` into "${target}"` : ''}`);
  }

  async pressKeys(press: { keys: string; repeat?: number }): Promise<void> {
    this.log.push(`press ${press.keys}${press.repeat && press.repeat > 1 ? ` x${press.repeat}` : ''}`);
  }

  async openApp(name: string): Promise<{ ok: boolean; message: string }> {
    this.log.push(`open app ${name}`);
    return { ok: true, message: `${name} came to the front.` };
  }

  async openUrl(url: string): Promise<{ ok: boolean; message: string }> {
    this.log.push(`open url ${url}`);
    return { ok: true, message: `Opened ${url}.` };
  }

  async readClipboard(): Promise<string> {
    return clipboard;
  }

  async writeClipboard(text: string): Promise<void> {
    clipboard = text;
    this.log.push(`clipboard ← ${text.slice(0, 40)}`);
  }

  async runShortcut(
    name: string,
    args?: string
  ): Promise<{ ok: boolean; message: string; output?: string }> {
    this.log.push(`shortcut ${name}${args ? ` "${args}"` : ''}`);
    return { ok: true, message: `Ran the shortcut "${name}".`, output: 'simulated' };
  }

  async wait(ms: number): Promise<void> {
    // Real waiting in simulate mode just makes tests slow.
    void ms;
  }

  /**
   * A pretend "vision model": the simulated desktop knows its own window list,
   * so locating a target is a substring match with a believable confidence.
   */
  locate(target: string, hint?: { x: number; y: number }): { point: Point; label: string; confidence: number; description: string } | null {
    const needle = target.toLowerCase();
    const candidates: { point: Point; label: string; score: number; description: string }[] = [];

    for (const window of windows) {
      const title = `${window.app} ${window.title}`.toLowerCase();
      if (title.includes(needle)) {
        candidates.push({
          point: { x: window.x + window.width / 2, y: window.y + 14 },
          label: window.title,
          score: 0.72,
          description: `${window.app} window: ${window.title}.`
        });
      }
      for (const item of window.items) {
        const label = item.label.toLowerCase();
        const overlap = words(needle).filter((word) => label.includes(word)).length;
        if (label.includes(needle) || overlap >= Math.max(1, words(needle).length - 1)) {
          candidates.push({
            point: { x: item.x + item.width / 2, y: item.y + item.height / 2 },
            label: item.label,
            score: label.includes(needle) ? 0.94 : 0.62,
            description: `"${item.label}" inside ${window.app}.`
          });
        }
      }
    }

    if (!candidates.length) {
      // Nothing matched — behave like the real thing and admit it, sometimes
      // returning a low-confidence guess so the "I'm not sure" path gets used.
      if (hint) {
        return {
          point: hint,
          label: target,
          confidence: 0.24,
          description: `Couldn't find "${target}" on the simulated desktop. Best guess near your cursor.`
        };
      }
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    return { point: best.point, label: best.label, confidence: best.score, description: best.description };
  }

  private findFocusedField(): string | null {
    for (const window of windows) {
      for (const item of window.items) {
        const inside =
          mouse.x >= item.x && mouse.x <= item.x + item.width && mouse.y >= item.y && mouse.y <= item.y + item.height;
        if (inside) return item.label;
      }
    }
    return null;
  }

  private draw(): { width: number; height: number; pixels: Uint8Array } {
    const image = createImage(SCREEN.width, SCREEN.height, [22, 24, 32, 255]);

    // Wallpaper: a soft blue-violet wash, so it's obvious this is a pretend screen.
    for (let y = 0; y < SCREEN.height; y += 1) {
      for (let x = 0; x < SCREEN.width; x += 1) {
        if ((x + y) % 3 !== 0) continue;
        const offset = (y * image.width + x) * 4;
        const t = (x / SCREEN.width + y / SCREEN.height) / 2;
        image.pixels[offset] = Math.round(22 + t * 30);
        image.pixels[offset + 1] = Math.round(24 + t * 18);
        image.pixels[offset + 2] = Math.round(32 + t * 60);
      }
    }

    // Menu bar
    fillRect(image, 0, 0, SCREEN.width, 26, [16, 18, 26, 255]);
    fillRect(image, 16, 9, 120, 8, [200, 210, 230, 255], 4);
    fillRect(image, SCREEN.width - 180, 8, 60, 10, [180, 190, 210, 255], 5);
    fillRect(image, SCREEN.width - 100, 8, 70, 10, [150, 160, 190, 255], 5);

    for (const window of windows) {
      fillRect(image, window.x + 6, window.y + 8, window.width, window.height, [0, 0, 0, 70], 10);
      fillRect(image, window.x, window.y, window.width, window.height, [30, 32, 42, 255], 10);
      fillRect(image, window.x, window.y, window.width, 34, [window.accent[0], window.accent[1], window.accent[2], 255], 10);
      fillRect(image, window.x, window.y + 16, window.width, 18, [window.accent[0], window.accent[1], window.accent[2], 255]);
      // window title bar lights
      fillRect(image, window.x + 14, window.y + 12, 10, 10, [255, 95, 86, 255], 5);
      fillRect(image, window.x + 30, window.y + 12, 10, 10, [255, 189, 46, 255], 5);
      fillRect(image, window.x + 46, window.y + 12, 10, 10, [39, 201, 63, 255], 5);

      for (const item of window.items) {
        fillRect(image, item.x, item.y, item.width, item.height, [255, 255, 255, 26], 6);
        fillRect(image, item.x + 10, item.y + item.height / 2 - 5, Math.min(item.width - 24, 6 * item.label.length), 10, [222, 230, 245, 200], 3);
      }
    }

    // The user's real cursor
    strokeCircle(image, mouse.x, mouse.y, 7, [255, 255, 255, 220], 2);
    fillRect(image, mouse.x - 6, mouse.y - 6, 12, 12, [255, 255, 255, 120], 6);

    // A little Buddy watermark so it's clear which mode you're in
    fillRect(image, 24, SCREEN.height - 46, 210, 26, [86, 108, 255, 220], 13);

    return image;
  }

  private crop(
    image: { width: number; height: number; pixels: Uint8Array },
    x: number,
    y: number,
    width: number,
    height: number
  ): { width: number; height: number; pixels: Uint8Array } {
    const pixels = new Uint8Array(width * height * 4);
    for (let py = 0; py < height; py += 1) {
      const sourceStart = ((y + py) * image.width + x) * 4;
      pixels.set(image.pixels.subarray(sourceStart, sourceStart + width * 4), py * width * 4);
    }
    return { width, height, pixels };
  }

  private constrain(point: Point): Point {
    return {
      x: Math.max(0, Math.min(SCREEN.width - 1, Math.round(point.x))),
      y: Math.max(0, Math.min(SCREEN.height - 1, Math.round(point.y)))
    };
  }
}

const words = (text: string): string[] =>
  text.split(/[^a-z0-9]+/).filter((word) => word.length > 3);
