import {
  DEFAULT_FACE_STATE,
  type FaceState,
  type Gesture,
  type Mood
} from '@buddy/protocol';

/**
 * Buddy's face, as maths.
 *
 * The renderer is dumb: hand it a FaceState and it draws. All the personality
 * — the breathing, the blinking, the way his eyes drift when he's thinking,
 * the way he looks at your cursor — lives here so it behaves identically on
 * the phone, in the browser and on the desktop.
 *
 * Everything is driven by `update(deltaMs)`, so it stays in time no matter how
 * often the renderer happens to tick.
 */

interface MoodShape {
  /** -1 frown … 1 grin. */
  smile: number;
  /** 0..1 how wide the eyes sit. */
  open: number;
  /** 0..1 fidget/breathing speed. */
  energy: number;
  /** Resting tilt in radians. */
  tilt: number;
  /** How long a gesture-set mood lingers before settling. 0 = until changed. */
  holdMs: number;
  /** Optional one-off gesture when entering the mood. */
  enter?: Gesture;
  /** Pupils drift upward when sleepy, down when thinking about something hard. */
  gazeBias?: { x: number; y: number };
}

export const MOODS: Record<Mood, MoodShape> = {
  sleeping: { smile: 0.05, open: 0.0, energy: 0.22, tilt: -0.16, holdMs: 0, gazeBias: { x: 0, y: 0.35 } },
  drowsy: { smile: 0.1, open: 0.32, energy: 0.3, tilt: -0.1, holdMs: 0, gazeBias: { x: 0, y: 0.22 } },
  idle: { smile: 0.15, open: 1, energy: 0.42, tilt: -0.04, holdMs: 0 },
  listening: { smile: 0.2, open: 1.12, energy: 0.5, tilt: 0.06, holdMs: 0, enter: 'blink' },
  thinking: { smile: -0.05, open: 0.78, energy: 0.34, tilt: -0.2, holdMs: 0, gazeBias: { x: -0.35, y: -0.3 } },
  talking: { smile: 0.25, open: 1.02, energy: 0.62, tilt: 0.02, holdMs: 0 },
  happy: { smile: 0.92, open: 1.06, energy: 0.72, tilt: 0.1, holdMs: 2400, enter: 'bounce' },
  curious: { smile: 0.3, open: 1.16, energy: 0.56, tilt: 0.24, holdMs: 2200 },
  pointing: { smile: 0.34, open: 1.08, energy: 0.68, tilt: 0.5, holdMs: 1200, gazeBias: { x: 0.3, y: -0.05 } },
  working: { smile: 0.06, open: 0.9, energy: 0.55, tilt: -0.06, holdMs: 0, gazeBias: { x: 0.18, y: -0.18 } },
  confused: { smile: -0.35, open: 0.92, energy: 0.46, tilt: 0.62, holdMs: 2000, enter: 'shake' },
  surprised: { smile: 0.5, open: 1.34, energy: 0.8, tilt: 0.12, holdMs: 1400, enter: 'bounce' },
  concerned: { smile: -0.4, open: 1.04, energy: 0.4, tilt: -0.28, holdMs: 2000 },
  smug: { smile: 0.66, open: 0.76, energy: 0.5, tilt: -0.18, holdMs: 1800 },
  proud: { smile: 0.84, open: 1.0, energy: 0.66, tilt: 0.14, holdMs: 2400, enter: 'bounce' }
};

const GESTURE_DURATION: Record<Gesture, number> = {
  wake: 700,
  nod: 620,
  shake: 520,
  blink: 160,
  wink: 260,
  look: 500,
  point: 900,
  sleep: 1400,
  bounce: 620
};

export interface FaceEngineOptions {
  /** Random source, injectable so tests are stable. */
  random?: () => number;
  now?: () => number;
  /** Start asleep, eyes closed. */
  asleep?: boolean;
}

/** Smoothly approaches a target at a fixed rate per millisecond. */
const ease = (current: number, target: number, rate: number): number => {
  if (Math.abs(target - current) < 0.0005) return target;
  return current + (target - current) * Math.min(1, rate);
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

export class FaceEngine {
  private state: FaceState;
  private mood: Mood;
  private moodUntil = 0;
  private activeGestures: { gesture: Gesture; until: number }[] = [];
  /** Timestamp the current blink started, or 0 when the eyes are open. */
  private blinkStartedAt = 0;
  private blinkDuration = 160;
  private nextBlinkAt = 0;
  private wanderTarget = { x: 0, y: 0 };
  private nextWanderAt = 0;
  /** Where the user's cursor / a thing on screen is, normalised -1..1. */
  private attention: { x: number; y: number } | null = null;
  private t = 0;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: FaceEngineOptions = {}) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.mood = options.asleep ? 'sleeping' : 'idle';
    this.state = {
      ...DEFAULT_FACE_STATE,
      mood: this.mood,
      blink: options.asleep ? 1 : 0,
      smile: MOODS[this.mood]!.smile,
      open: MOODS[this.mood]!.open,
      energy: MOODS[this.mood]!.energy,
      tilt: MOODS[this.mood]!.tilt,
      updatedAt: this.now()
    };
    this.nextBlinkAt = this.now() + this.blinkDelay();
  }

  /** Apply a partial state that arrived over the wire (e.g. from the phone). */
  applyRemote(partial: Partial<FaceState>): void {
    if (partial.mood && partial.mood !== this.mood) {
      this.mood = partial.mood;
      this.moodUntil = 0;
    }
    if (partial.gestures?.length) {
      for (const gesture of partial.gestures) this.gesture(gesture);
    }
    if (partial.pointing !== undefined) this.state.pointing = partial.pointing;
    if (partial.status !== undefined) this.state.status = partial.status;
    // Deliberately not applying blink/gaze/smile from the wire: those are this
    // instance's to animate, and copying them makes the face twitch.
  }

  setMood(mood: Mood, options: { holdMs?: number; gesture?: Gesture } = {}): void {
    if (!MOODS[mood]) return;
    const changed = mood !== this.mood;
    this.mood = mood;
    const shape = MOODS[mood];
    const hold = options.holdMs ?? shape.holdMs;
    this.moodUntil = hold > 0 ? this.now() + hold : 0;
    if (changed && shape.enter) this.gesture(shape.enter);
    if (changed && options.gesture) this.gesture(options.gesture);
  }

  getMood(): Mood {
    return this.mood;
  }

  gesture(gesture: Gesture): void {
    const now = this.now();
    const already = this.activeGestures.find((entry) => entry.gesture === gesture);
    if (already) {
      already.until = now + GESTURE_DURATION[gesture];
      return;
    }
    if (gesture === 'blink') {
      this.blinkStartedAt = now;
      this.blinkDuration = GESTURE_DURATION.blink;
      this.nextBlinkAt = now + this.blinkDelay();
      return;
    }
    if (gesture === 'sleep') this.setMood('sleeping');
    if (gesture === 'wake') this.setMood('listening', { holdMs: 1500 });
    if (gesture === 'point') this.setMood('pointing');
    this.activeGestures.push({ gesture, until: now + GESTURE_DURATION[gesture] });
  }

  /** Point the eyes at something: normalised -1..1 (0,0 is straight ahead). */
  lookAt(point: { x: number; y: number } | null): void {
    this.attention = point;
    if (point) {
      this.wanderTarget = {
        x: clamp(point.x, -1, 1) * 0.62,
        y: clamp(point.y, -1, 1) * 0.5
      };
      this.nextWanderAt = this.now() + 1200;
    }
  }

  /** Where Buddy is pointing his cursor, for the "eyes lead the cursor" feel. */
  setPointing(point: { x: number; y: number } | null): void {
    this.state.pointing = point;
  }

  setStatus(status: string | null): void {
    this.state.status = status;
  }

  /** A neutral pulse for whenever sound is coming out of him. */
  talkLevel(level: number): void {
    const energy = clamp01(this.state.energy + level * 0.02);
    this.state.energy = energy;
  }

  /** Advance the animation. Returns the state to draw. */
  update(deltaMs: number): FaceState {
    const dt = Math.min(Math.max(deltaMs, 0), 250);
    this.t += dt;
    const now = this.now();
    const shape = MOODS[this.mood] ?? MOODS.idle;
    const asleep = shape.open <= 0.05;

    // Mood holds expire back to the resting mood.
    if (this.moodUntil && now > this.moodUntil) {
      this.moodUntil = 0;
      this.mood = asleep ? 'sleeping' : 'idle';
    }

    // ── Blinking ────────────────────────────────────────────────────────────
    // A blink is a tiny two-part animation: snap shut (35%), ease open (65%).
    let blinkValue = 0;
    if (asleep) {
      this.blinkStartedAt = 0;
      blinkValue = 1;
    } else {
      if (this.blinkStartedAt === 0 && now >= this.nextBlinkAt) {
        this.blinkStartedAt = now;
        this.blinkDuration = 130 + this.random() * 60;
      }
      if (this.blinkStartedAt !== 0) {
        const progress = (now - this.blinkStartedAt) / this.blinkDuration;
        if (progress >= 1) {
          this.blinkStartedAt = 0;
          this.nextBlinkAt = now + this.blinkDelay();
        } else {
          blinkValue = progress < 0.35 ? progress / 0.35 : 1 - (progress - 0.35) / 0.65;
        }
      }
    }

    // ── Idle wander ─────────────────────────────────────────────────────────
    if (now >= this.nextWanderAt && !asleep) {
      if (!this.attention) {
        const spread = this.mood === 'thinking' ? 0.42 : this.mood === 'curious' ? 0.34 : 0.22;
        this.wanderTarget = {
          x: (this.random() - 0.5) * 2 * spread,
          y: (this.random() - 0.5) * 2 * spread * 0.7
        };
      }
      this.nextWanderAt = now + 1400 + this.random() * 3200;
    }

    // ── Gestures ────────────────────────────────────────────────────────────
    this.activeGestures = this.activeGestures.filter((entry) => entry.until > now);
    let nodOffset = 0;
    let shakeOffset = 0;
    let bounce = 0;
    for (const entry of this.activeGestures) {
      const remaining = (entry.until - now) / GESTURE_DURATION[entry.gesture];
      const phase = Math.sin((1 - remaining) * Math.PI * 2.4);
      if (entry.gesture === 'nod') nodOffset += phase * 0.22;
      if (entry.gesture === 'shake') shakeOffset += phase * 0.3;
      if (entry.gesture === 'bounce' || entry.gesture === 'wake') {
        bounce += Math.max(0, Math.sin((1 - remaining) * Math.PI)) * 0.14;
      }
    }

    // ── Breathing ───────────────────────────────────────────────────────────
    const breath = Math.sin(this.t / (1400 / Math.max(0.15, shape.energy))) * 0.05;
    const idleFidget = Math.sin(this.t / 3100) * 0.02;

    // ── Targets ─────────────────────────────────────────────────────────────
    const bias = shape.gazeBias ?? { x: 0, y: 0 };
    const gazeX = this.wanderTarget.x + bias.x + shakeOffset;
    const gazeY = this.wanderTarget.y + bias.y + nodOffset;

    const targetOpen = shape.open + breath - bounce * 0.5;
    const targetSmile = shape.smile + breath * 0.35;
    const targetTilt = shape.tilt + idleFidget + (this.mood === 'curious' ? Math.sin(this.t / 900) * 0.06 : 0);

    const blink = blinkValue;

    const speed = dt / 160;
    this.state = {
      ...this.state,
      mood: this.mood,
      blink: ease(this.state.blink, blink, blink > this.state.blink ? dt / 40 : dt / 90),
      gaze: {
        x: ease(this.state.gaze.x, gazeX, speed * 1.1),
        y: ease(this.state.gaze.y, gazeY, speed)
      },
      open: ease(this.state.open, Math.max(0.02, targetOpen), speed * 0.9),
      smile: ease(this.state.smile, clamp01((targetSmile + 1) / 2) * 2 - 1, speed * 0.8),
      tilt: ease(this.state.tilt, targetTilt, speed * 0.7),
      energy: ease(this.state.energy, shape.energy, speed * 0.4),
      gestures: this.activeGestures.map((entry) => entry.gesture),
      pointing: this.state.pointing,
      status: this.state.status,
      updatedAt: now
    };

    return this.state;
  }

  /** The current drawing state without advancing anything. */
  snapshot(): FaceState {
    return { ...this.state, mood: this.mood };
  }

  private blinkDelay(): number {
    // Sleepy moods blink slower and heavier; lively moods flutter.
    const energy = MOODS[this.mood]?.energy ?? 0.5;
    const base = 2600 + this.random() * 3400;
    return base * (1.6 - energy);
  }
}

/** Moods that are pure reactions — used to pick something to settle back to. */
export const TRANSIENT_MOODS: Mood[] = [
  'happy',
  'surprised',
  'confused',
  'smug',
  'proud',
  'curious'
];

export const isTransientMood = (mood: Mood): boolean => TRANSIENT_MOODS.includes(mood);

/** One-liners so the host and the phone agree about what each mood means. */
export const MOOD_LABELS: Record<Mood, string> = {
  sleeping: 'Asleep',
  drowsy: 'Drowsy',
  idle: 'Hanging out',
  listening: 'Listening',
  thinking: 'Thinking',
  talking: 'Talking',
  happy: 'Happy',
  curious: 'Curious',
  pointing: 'Pointing',
  working: 'Working',
  confused: 'Confused',
  surprised: 'Surprised',
  concerned: 'Concerned',
  smug: 'Smug',
  proud: 'Proud'
};
