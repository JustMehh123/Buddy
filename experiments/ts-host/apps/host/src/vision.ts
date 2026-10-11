import type { ActionTarget, DisplayInfo } from '@buddy/protocol';
import { buildVisionPrompt } from '@buddy/core';
import type { ProviderRegistry } from './providers/index.js';
import type { ChatMessage } from './providers/types.js';
import type { CaptureResult, ComputerController, Point } from './computer/types.js';
import { SimulatedComputer } from './computer/simulate.js';

/**
 * Buddy's eyes.
 *
 * Looking at a screen is a two-step thing, and the cheap step always goes
 * first:
 *
 *   1. Ask the operating system. macOS will hand back every control and line of
 *      text with its exact rectangle, for free, in milliseconds. No vision model
 *      is ever that precise.
 *   2. Only when the OS can't help — a canvas, an image, a video, a game, a
 *      window that hides its accessibility tree — send a downscaled screenshot
 *      to a vision model.
 *
 * That order matters twice: it's far more accurate, and most interactions burn
 * no API quota at all, which matters a lot when yours is free.
 *
 * Coordinate convention, used everywhere in the host: target rects are in
 * screen points with the origin at the top-left of the primary display, and
 * `nx`/`ny` are that point normalised to 0..1 across the primary display, so
 * the phone can draw his pointing at any screen size.
 */

export interface ScreenTarget {
  /** Stable id the model can quote back: "L3", "V1". */
  id: string;
  text: string;
  /** Screen points, absolute. */
  rect: { x: number; y: number; width: number; height: number };
  /** Centre, normalised 0..1 across the primary display. */
  nx: number;
  ny: number;
  role: string;
  source: 'ax' | 'vision' | 'window' | 'sim';
}

export interface ScreenRead {
  targets: ScreenTarget[];
  /** What Buddy should say about it, phrased for speech. */
  summary: string;
  app: string | null;
  windowTitle: string | null;
  mouse: Point | null;
  capture: CaptureResult | null;
  screenshots: { dataUrl: string; width: number; height: number }[];
  displays: DisplayInfo[];
  at: number;
}

/** Anything that can search its own accessibility tree. */
interface AxCapable {
  searchText(query: string): Promise<{ text: string; role?: string; x: number; y: number; w: number; h: number }[]>;
  listControls(): Promise<{ text: string; role?: string; x: number; y: number; w: number; h: number }[]>;
}

const isAxCapable = (computer: ComputerController): computer is ComputerController & AxCapable =>
  typeof (computer as unknown as AxCapable).searchText === 'function';

export interface VisionOptions {
  registry: ProviderRegistry;
  computer: ComputerController;
  maxWidth?: number;
  /** How long a screen read stays usable for follow-up pointing. */
  cacheMs?: number;
}

export interface LocateOptions {
  allowCache?: boolean;
  cursorPoint?: Point | null;
}

export interface LocatedTarget extends ActionTarget {
  source: ScreenTarget['source'];
  /** Screen points — what the mouse wants. */
  point: Point;
}

export const TARGET_ID_PATTERN = /^[LVW]\d+$/i;

export class Vision {
  private readonly registry: ProviderRegistry;
  private readonly computer: ComputerController;
  private readonly maxWidth: number;
  private readonly cacheMs: number;
  private last: ScreenRead | null = null;
  private counter = 0;

  constructor(options: VisionOptions) {
    this.registry = options.registry;
    this.computer = options.computer;
    this.maxWidth = options.maxWidth ?? 1440;
    this.cacheMs = options.cacheMs ?? 20_000;
  }

  get lastRead(): ScreenRead | null {
    return this.last;
  }

  /** Look at the screen and answer a question about it. */
  async read(
    question: string,
    options: { region?: 'full' | 'window' | 'cursor'; detail?: 'quick' | 'thorough'; withScreenshot?: boolean } = {}
  ): Promise<ScreenRead> {
    const region = options.region ?? 'full';
    const detail = options.detail ?? 'quick';

    const mouse = await this.computer.mousePosition().catch(() => null);
    const displays = await this.computer.displays().catch(() => [] as DisplayInfo[]);
    const active = await this.computer.activeWindow().catch(() => null);
    const capture = await this.computer.capture({
      region,
      cursorPoint: mouse,
      maxWidth: this.maxWidth
    });

    const screenWidth = capture.screenWidth || 1;
    const screenHeight = capture.screenHeight || 1;
    const normalise = (x: number, y: number) => ({
      nx: Math.min(1, Math.max(0, x / screenWidth)),
      ny: Math.min(1, Math.max(0, y / screenHeight))
    });

    const targets: ScreenTarget[] = [];

    for (const display of displays) {
      const centreX = display.bounds.x + display.bounds.width / 2;
      const centreY = display.bounds.y + display.bounds.height / 2;
      targets.push({
        id: `W${++this.counter}`,
        text: `${display.label}, ${display.bounds.width} by ${display.bounds.height}${display.primary ? ', main screen' : ''}`,
        rect: { x: centreX, y: centreY, width: display.bounds.width, height: display.bounds.height },
        ...normalise(centreX, centreY),
        role: 'display',
        source: 'window'
      });
    }

    if (active) {
      targets.push({
        id: `W${++this.counter}`,
        text: `${active.app} — ${active.title || 'untitled window'}`,
        rect: { x: capture.origin.x + 40, y: capture.origin.y + 16, width: 0, height: 0 },
        ...normalise(capture.origin.x + 40, capture.origin.y + 16),
        role: 'window',
        source: 'window'
      });
    }

    // ── Step 1: the OS ─────────────────────────────────────────────────────
    if (isAxCapable(this.computer)) {
      const nodes = await this.computer.listControls().catch(() => []);
      for (const node of nodes.slice(0, 140)) {
        const text = (node.text || node.role || '').trim();
        if (!text) continue;
        targets.push({
          id: `L${++this.counter}`,
          text: text.slice(0, 200),
          rect: { x: node.x, y: node.y, width: node.w, height: node.h },
          ...normalise(node.x, node.y),
          role: node.role ?? 'control',
          source: 'ax'
        });
      }
    }

    // ── Step 2: a model ────────────────────────────────────────────────────
    let summary = '';
    let items: string[] = [];
    if (this.registry.visionProvider()) {
      try {
        const looked = await this.askVision(capture, question, detail, normalise);
        summary = looked.summary;
        items = looked.items;
        targets.push(...looked.targets);
      } catch (error) {
        summary = this.blindSummary(active, mouse, error);
      }
    } else {
      summary = this.blindSummary(active, mouse, null);
    }

    if (items.length) summary = `${summary} Things I can see: ${items.join('; ')}.`;
    if (!summary.trim()) {
      summary = targets.length
        ? `I can read this screen. On it: ${targets.slice(0, 8).map((target) => target.text).join(' / ')}`
        : 'The screen is there but I could not find anything worth describing.';
    }

    const read: ScreenRead = {
      targets,
      summary: summary.trim(),
      app: active?.app ?? null,
      windowTitle: active?.title ?? null,
      mouse,
      capture,
      screenshots: options.withScreenshot
        ? [
            {
              dataUrl: `data:image/png;base64,${capture.png.toString('base64')}`,
              width: capture.width,
              height: capture.height
            }
          ]
        : [],
      displays,
      at: Date.now()
    };
    this.last = read;
    return read;
  }

  /** Hand the picture to a vision model and ask for something structured. */
  private async askVision(
    capture: CaptureResult,
    question: string,
    detail: 'quick' | 'thorough',
    normalise: (x: number, y: number) => { nx: number; ny: number }
  ): Promise<{ summary: string; items: string[]; targets: ScreenTarget[] }> {
    const provider = this.registry.visionProvider();
    if (!provider) return { summary: '', items: [], targets: [] };

    const prompt = buildVisionPrompt(question, { width: capture.width, height: capture.height });
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.system },
      {
        role: 'user',
        content:
          detail === 'thorough'
            ? `${prompt.user}\n\nAlso include "items": an array of up to 12 short strings naming the notable things on screen.`
            : prompt.user,
        images: [{ data: capture.png.toString('base64'), mimeType: 'image/png' }]
      }
    ];

    const result = await this.registry.run(
      [provider],
      (candidate) =>
        candidate.chat({
          messages,
          json: true,
          temperature: 0.1,
          maxTokens: detail === 'thorough' ? 1200 : 600,
          purpose: 'vision'
        }),
      { label: 'Looking at your screen' }
    );

    const parsed = parseVisionJson(result.text);
    const targets: ScreenTarget[] = [];
    if (parsed.found) {
      // The model answered in image pixels; convert to screen points.
      const scaleX = capture.screenWidth / Math.max(1, capture.width);
      const scaleY = capture.screenHeight / Math.max(1, capture.height);
      const screenX = capture.origin.x + parsed.x * scaleX;
      const screenY = capture.origin.y + parsed.y * scaleY;
      targets.push({
        id: `V${++this.counter}`,
        text: parsed.label || question,
        rect: { x: screenX, y: screenY, width: 0, height: 0 },
        ...normalise(screenX, screenY),
        role: 'vision',
        source: 'vision'
      });
    }

    return {
      summary: parsed.description || result.text.trim(),
      items: parsed.items,
      targets
    };
  }

  private blindSummary(
    active: { app: string; title: string } | null,
    mouse: Point | null,
    error: unknown
  ): string {
    const parts: string[] = [];
    if (active) parts.push(`${active.app} is in front${active.title ? `, showing "${active.title}"` : ''}.`);
    if (mouse) parts.push(`Your pointer is at ${mouse.x}, ${mouse.y}.`);
    parts.push(
      error
        ? `I could not read the screen: ${error instanceof Error ? error.message : 'the vision call failed'}. Say so honestly.`
        : 'I have no vision model configured, so I cannot read the screen — say so honestly.'
    );
    return parts.join(' ');
  }

  /**
   * Where is "the Send button"?
   *
   * In order: a quoted id from the last look → text in the last look → the
   * operating system's own search → simulate mode's fake desktop → a fresh
   * screenshot sent to a vision model. The confidence reported is real, and
   * below the user's threshold Buddy says he isn't sure rather than pointing at
   * a guess.
   */
  async locate(target: string, options: LocateOptions = {}): Promise<LocatedTarget | null> {
    const query = target.trim();
    if (!query) return null;
    const useCache = options.allowCache !== false;

    // 1. An id the model quoted from the last look.
    if (useCache && TARGET_ID_PATTERN.test(query) && this.last) {
      const match = this.last.targets.find((entry) => entry.id.toLowerCase() === query.toLowerCase());
      if (match) return toLocated(match, 0.95);
    }

    // 2. Text somewhere in the last look.
    if (useCache && this.last && Date.now() - this.last.at < this.cacheMs) {
      const hit = bestTextMatch(this.last.targets, query);
      if (hit && hit.score >= 0.7) return toLocated(hit.target, hit.score);
    }

    // 3. The operating system, directly.
    if (isAxCapable(this.computer)) {
      const nodes = await this.computer.searchText(query).catch(() => []);
      const best = pickAxisNode(nodes, query);
      if (best) {
        const { nx, ny } = await this.normalisePoint(best.x, best.y);
        return {
          x: best.x,
          y: best.y,
          nx,
          ny,
          label: best.text.slice(0, 120),
          confidence: 0.92,
          description: `"${best.text.slice(0, 140)}"`,
          source: 'ax',
          point: { x: best.x, y: best.y }
        };
      }
    }

    // 4. Simulate mode knows its own pretend desktop.
    if (this.computer instanceof SimulatedComputer) {
      const guess = this.computer.locate(query, options.cursorPoint ?? undefined);
      if (!guess) return null;
      const { nx, ny } = await this.normalisePoint(guess.point.x, guess.point.y);
      return {
        x: guess.point.x,
        y: guess.point.y,
        nx,
        ny,
        label: guess.label,
        confidence: guess.confidence,
        description: guess.description,
        source: 'sim',
        point: { x: guess.point.x, y: guess.point.y }
      };
    }

    // 5. Last resort: a fresh screenshot and a vision model.
    if (this.registry.visionProvider()) {
      try {
        const read = await this.read(`Where exactly on screen is this: ${query}?`, { region: 'full' });
        const visionTarget = read.targets.find((entry) => entry.source === 'vision');
        if (visionTarget) {
          return {
            ...toLocated(visionTarget, 0.55),
            description: read.summary,
            source: 'vision'
          };
        }
        const hit = bestTextMatch(read.targets, query);
        if (hit && hit.score >= 0.6) return toLocated(hit.target, hit.score);
      } catch {
        /* fall through and admit defeat */
      }
    }

    return null;
  }

  private async normalisePoint(x: number, y: number): Promise<{ nx: number; ny: number }> {
    const displays = this.last?.displays ?? (await this.computer.displays().catch(() => [] as DisplayInfo[]));
    const primary = displays.find((display) => display.primary) ?? displays[0];
    const width = primary?.bounds.width ?? this.last?.capture?.screenWidth ?? 1920;
    const height = primary?.bounds.height ?? this.last?.capture?.screenHeight ?? 1080;
    return {
      nx: Math.min(1, Math.max(0, x / Math.max(1, width))),
      ny: Math.min(1, Math.max(0, y / Math.max(1, height)))
    };
  }
}

const toLocated = (target: ScreenTarget, confidence: number): LocatedTarget => ({
  x: Math.round(target.rect.x),
  y: Math.round(target.rect.y),
  nx: target.nx,
  ny: target.ny,
  label: target.text.slice(0, 120),
  confidence,
  description: `${target.text.slice(0, 140)} (${target.role})`,
  source: target.source,
  point: { x: Math.round(target.rect.x), y: Math.round(target.rect.y) }
});

/** Prefer a node whose text contains the whole query, then the tightest box. */
const pickAxisNode = (
  nodes: { text: string; role?: string; x: number; y: number; w: number; h: number }[],
  query: string
): { text: string; role?: string; x: number; y: number; w: number; h: number } | null => {
  if (!nodes.length) return null;
  const needle = query.toLowerCase();
  const scored = nodes.map((node) => {
    const text = (node.text ?? '').toLowerCase();
    let score = 0;
    if (text === needle) score = 1;
    else if (text.includes(needle)) score = 0.9;
    else {
      const words = needle.split(/\s+/).filter((word) => word.length > 2);
      const hits = words.filter((word) => text.includes(word)).length;
      score = words.length ? (hits / words.length) * 0.7 : 0;
    }
    // Prefer smaller, more specific elements and buttons over giant containers.
    const area = Math.max(1, node.w * node.h);
    const sizeBonus = score > 0 ? Math.min(0.15, 4000 / area) : 0;
    const roleBonus = /button|link|menuitem|tab/i.test(node.role ?? '') ? 0.08 : 0;
    return { node, score: score + sizeBonus + roleBonus };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  return best.score >= 0.45 ? best.node : null;
};

/** Substring beats word overlap beats prefix. */
export const bestTextMatch = (
  targets: ScreenTarget[],
  query: string
): { target: ScreenTarget; score: number } | null => {
  const needle = query.toLowerCase().trim();
  if (!needle) return null;
  const words = needle.split(/\s+/).filter((word) => word.length > 2);

  let best: { target: ScreenTarget; score: number } | null = null;
  for (const target of targets) {
    const haystack = `${target.text} ${target.role}`.toLowerCase();
    let score = 0;
    if (haystack === needle) score = 1;
    else if (haystack.includes(needle)) score = 0.92;
    else if (words.length > 1) {
      const hits = words.filter((word) => haystack.includes(word)).length;
      if (hits) score = 0.4 + (hits / words.length) * 0.42;
    } else if (words[0] && haystack.includes(words[0]!)) {
      score = 0.62;
    }
    if (score > 0 && (!best || score > best.score)) best = { target, score };
  }
  return best;
};

interface VisionJsonShape {
  found?: boolean;
  x?: number;
  y?: number;
  label?: string;
  description?: string;
  confidence?: number;
  items?: unknown;
}

export interface ParsedVision {
  found: boolean;
  x: number;
  y: number;
  label: string;
  description: string;
  confidence: number;
  items: string[];
}

export const parseVisionJson = (text: string): ParsedVision => {
  const fallback: ParsedVision = {
    found: false,
    x: 0,
    y: 0,
    label: '',
    description: '',
    confidence: 0,
    items: []
  };
  if (!text) return fallback;

  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { ...fallback, description: cleaned.slice(0, 400) };
  }

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as VisionJsonShape;
    return {
      found: Boolean(parsed.found),
      x: Number(parsed.x) || 0,
      y: Number(parsed.y) || 0,
      label: typeof parsed.label === 'string' ? parsed.label : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.6,
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 12).map((item) => String(item)) : []
    };
  } catch {
    return { ...fallback, description: cleaned.slice(0, 400) };
  }
};
