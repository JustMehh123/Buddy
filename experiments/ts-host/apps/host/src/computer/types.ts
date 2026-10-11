import type { Capability, DisplayInfo } from '@buddy/protocol';

export interface Point {
  x: number;
  y: number;
}

export interface CaptureResult {
  /** PNG bytes, already downscaled to keep the vision pass cheap. */
  png: Buffer;
  /** Size of the image in the buffer (post-scale). */
  width: number;
  height: number;
  /** Where this crop sits in screen space, in real pixels. */
  origin: Point;
  /** Real screen size, so coordinates can be mapped back. */
  screenWidth: number;
  screenHeight: number;
  displayId: number | null;
  /** Which display the capture came from. */
  label: string;
}

export interface KeyPress {
  /** e.g. "cmd+shift+4", "ctrl+alt+t", "enter". */
  keys: string;
  repeat?: number;
}

export interface ComputerController {
  readonly kind: 'darwin' | 'win32' | 'linux' | 'simulate';
  readonly supported: Capability[];
  /** Extra context for the system prompt, e.g. "Swift helper compiled". */
  describe(): string;
  displays(): Promise<DisplayInfo[]>;
  screenSize(): Promise<{ width: number; height: number }>;
  /** Where the user's real mouse is, if we can know. */
  mousePosition(): Promise<Point | null>;
  activeWindow(): Promise<{ app: string; title: string } | null>;
  runningApps(): Promise<string[]>;
  capture(options: {
    region: 'full' | 'window' | 'cursor';
    cursorPoint?: Point | null;
    maxWidth?: number;
    displayId?: number;
  }): Promise<CaptureResult>;
  moveMouse(point: Point, options?: { durationMs?: number; displayId?: number }): Promise<void>;
  click(point: Point, options?: { double?: boolean; button?: 'left' | 'right' }): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(press: KeyPress): Promise<void>;
  openApp(name: string): Promise<{ ok: boolean; message: string }>;
  openUrl(url: string): Promise<{ ok: boolean; message: string }>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  runShortcut(
    name: string,
    args?: string
  ): Promise<{ ok: boolean; message: string; output?: string }>;
  /** Blocking sleep used between synthetic input events. */
  wait(ms: number): Promise<void>;
}

export class ComputerError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'permission' | 'failed'
  ) {
    super(message);
    this.name = 'ComputerError';
  }
}
