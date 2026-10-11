/**
 * Buddy's face, drawn on a canvas.
 *
 * This is the browser version of what the SwiftUI app drew: the same blueberry
 * blob, the same googly eyes, the same damped springs so nothing ever snaps.
 * Everything is expressed in a 0..1 design space and scaled to the canvas, so
 * he looks identical on a phone, a tablet or a laptop browser.
 *
 * The Mood names match the wire format the Mac sends (`listening`, `resting`,
 * `thinking`, `talking`, `pointing`, `happy`, `sleepy`) plus a few we invent
 * locally (`waking`, `asleep`, `error`).
 */

const PALETTE = {
  berry1: '#A9BCFF',
  berry2: '#6C86F5',
  berry3: '#4254D6',
  berry4: '#2B2F8F',
  nose: '#1C1F66',
  ink: '#17151F',
  inkSoft: '#B9B2CC',
  panel: '#1E1B29',
  white: '#FFFFFF'
};

/** A tiny damped spring: the reason he feels alive rather than animated. */
class Spring {
  constructor(value, stiffness = 200, damping = 0.7) {
    this.value = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  step(target, dt) {
    const c = 2 * Math.sqrt(this.stiffness) * this.damping;
    this.velocity += (this.stiffness * (target - this.value) - c * this.velocity) * dt;
    this.value += this.velocity * dt;
    // Clamp for numerical safety on slow frames.
    if (!Number.isFinite(this.value)) this.value = target;
    return this.value;
  }
}

/** Per-mood expression targets. Numbers are in the 0..1 design space. */
const MOODS = {
  listening: { browLift: 0.035, browTilt: 0.05, mouth: 0.05, squint: 0, pupil: 1.0, lids: 0.0, blush: 0.05 },
  resting: { browLift: 0.005, browTilt: 0.0, mouth: 0.12, squint: 0.15, pupil: 0.92, lids: 0.18, blush: 0.0 },
  thinking: { browLift: 0.02, browTilt: -0.18, mouth: -0.02, squint: 0.05, pupil: 0.88, lids: 0.05, blush: 0.0, gazeBias: { x: 0.55, y: -0.8 } },
  talking: { browLift: 0.045, browTilt: 0.03, mouth: 0.25, squint: 0.0, pupil: 1.05, lids: 0.0, blush: 0.1 },
  pointing: { browLift: 0.06, browTilt: 0.22, mouth: 0.22, squint: 0.0, pupil: 1.02, lids: 0.0, blush: 0.05, gazeBias: { x: 0.75, y: -0.25 } },
  happy: { browLift: 0.07, browTilt: 0.1, mouth: 0.9, squint: 0.75, pupil: 1.1, lids: 0.0, blush: 0.55 },
  sleepy: { browLift: -0.01, browTilt: 0.0, mouth: 0.06, squint: 0.2, pupil: 0.8, lids: 0.55, blush: 0.0 },
  asleep: { browLift: -0.02, browTilt: 0.0, mouth: 0.02, squint: 0.1, pupil: 0.6, lids: 1.0, blush: 0.0 },
  waking: { browLift: 0.08, browTilt: 0.06, mouth: 0.35, squint: 0.1, pupil: 1.15, lids: 0.1, blush: 0.15 },
  error: { browLift: 0.0, browTilt: 0.35, mouth: -0.35, squint: 0.0, pupil: 1.0, lids: 0.0, blush: 0.0 }
};

export class BuddyFace {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.t = 0;
    this.mood = 'listening';
    this.targetMood = 'listening';
    this.moodSince = 0;
    this.talk = 0;
    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.blinkStarted = -10;
    this.nextBlink = 1.5;
    this.pointer = { x: 0, y: 0 };
    this.pointerSeen = 0;

    this.gx = new Spring(0, 220, 0.75);
    this.gy = new Spring(0, 220, 0.75);
    this.brow = new Spring(0, 180, 0.6);
    this.tilt = new Spring(0, 120, 0.55);
    this.mouth = new Spring(0.1, 260, 0.8);
    this.squint = new Spring(0, 200, 0.7);
    this.blush = new Spring(0, 120, 0.9);
    this.lean = new Spring(0, 90, 0.6);
    this.hop = new Spring(0, 260, 0.45);
    this.pupil = new Spring(1, 200, 0.8);
    this.lids = new Spring(0, 260, 0.85);

    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);

    // He looks at your finger or your cursor — the cheapest trick for "alive".
    const track = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = (event.clientX - rect.left) / Math.max(1, rect.width);
      const py = (event.clientY - rect.top) / Math.max(1, rect.height);
      this.pointer = { x: (px - 0.5) * 2, y: (py - 0.5) * 2 };
      this.pointerSeen = this.t;
    };
    window.addEventListener('pointermove', track, { passive: true });
    window.addEventListener('pointerdown', track, { passive: true });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(240, Math.round(rect.width));
    const height = Math.max(240, Math.round(rect.height));
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
  }

  setMood(mood) {
    if (!MOODS[mood] || mood === this.targetMood) return;
    this.targetMood = mood;
    this.mood = mood;
    this.moodSince = this.t;
    this.blinkStarted = this.t; // blink through every change of expression
  }

  setTalk(level) {
    this.talk = Math.max(0, Math.min(1, level));
  }

  /** -1..1, where the eyes should look. */
  setGaze(x, y) {
    this.gazeTarget = {
      x: Math.max(-1, Math.min(1, x || 0)),
      y: Math.max(-1, Math.min(1, y || 0))
    };
  }

  /** The Mac said which way to look, ignoring the local pointer for a moment. */
  setPointerInfluence(active) {
    this.usePointer = active !== false;
  }

  frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.t += dt;

    const shape = MOODS[this.mood] || MOODS.listening;
    const asleep = this.mood === 'asleep';
    const sleepy = this.mood === 'sleepy';

    // ── Gaze ────────────────────────────────────────────────────────────────
    let wantX = this.gazeTarget.x;
    let wantY = this.gazeTarget.y;
    if (shape.gazeBias) {
      wantX += shape.gazeBias.x * 0.35;
      wantY += shape.gazeBias.y * 0.35;
    }
    if (this.usePointer !== false && this.t - this.pointerSeen < 2.5 && !asleep) {
      // Curiosity: the pointer pulls at his eyes a little.
      wantX = wantX * 0.55 + this.pointer.x * 0.45;
      wantY = wantY * 0.55 + this.pointer.y * 0.45;
    }
    // Idle wander when nothing is happening.
    if (this.usePointer !== false && this.t - this.pointerSeen > 2.5 && !asleep) {
      wantX += Math.sin(this.t * 0.53) * 0.12;
      wantY += Math.sin(this.t * 0.71 + 1.2) * 0.08;
    }
    if (this.mood === 'thinking') {
      wantX = 0.6 + Math.sin(this.t * 1.3) * 0.08;
      wantY = -0.85;
    }
    this.gaze.x = this.gx.step(wantX, dt);
    this.gaze.y = this.gy.step(wantY, dt);

    // ── Blink ───────────────────────────────────────────────────────────────
    let closed = 0;
    if (asleep) {
      closed = 1;
    } else {
      const sinceBlink = this.t - this.blinkStarted;
      const duration = 0.16;
      if (sinceBlink < duration) {
        const p = sinceBlink / duration;
        closed = p < 0.35 ? p / 0.35 : 1 - (p - 0.35) / 0.65;
      } else if (this.t > this.nextBlink) {
        this.blinkStarted = this.t;
        const energy = this.mood === 'talking' || this.mood === 'happy' ? 1.4 : 1;
        this.nextBlink = this.t + (2.4 + Math.random() * 3.4) / energy;
      }
    }

    // ── Idle life ───────────────────────────────────────────────────────────
    const breathe = Math.sin(this.t * (this.mood === 'resting' ? 1.1 : 1.8)) * 0.008;
    if (this.talk < 0.05 && !asleep && !sleepy && Math.random() < dt * 0.35) {
      this.hop.velocity += 120 + Math.random() * 160;
    }

    const browTarget = shape.browLift + breathe * 0.4;
    this.brow.step(browTarget, dt);
    this.tilt.step(shape.browTilt + (this.mood === 'pointing' ? Math.sin(this.t * 2) * 0.03 : 0), dt);
    this.mouth.step(this.mood === 'talking' ? 0.18 + this.talk * 0.85 : shape.mouth, dt);
    this.squint.step(shape.squint, dt);
    this.blush.step(shape.blush, dt);
    this.lean.step(this.gaze.x * 0.06, dt);
    this.hop.step(0, dt);
    this.pupil.step(shape.pupil + this.talk * 0.08, dt);
    this.lids.step(closed > 0 ? closed : shape.lids, dt);

    this.draw(shape);
    requestAnimationFrame(this.frame);
  }

  draw(shape) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const size = Math.min(width, height);
    const cx = width / 2;
    const cy = height / 2;
    // The blob occupies 86% of the canvas, leaving room for brows and hops.
    const scale = size * 0.86;
    const hopOffset = -this.hop.value * scale * 0.18;

    ctx.save();
    ctx.translate(cx, cy + hopOffset);
    ctx.rotate(this.lean.value);
    ctx.scale(scale, scale);
    // Everything below is drawn in a -0.5..0.5 box.
    this.drawBlob(ctx);
    this.drawEyes(ctx);
    this.drawBrows(ctx);
    this.drawMouth(ctx);
    this.drawBlush(ctx);
    this.drawSleepyZ(ctx);
    ctx.restore();
  }

  /** The blueberry: four different corner radii, exactly like the design. */
  drawBlob(ctx) {
    const r = { x: -0.5, y: -0.5, w: 1, h: 1 };
    const tl = { w: 0.52, h: 0.58 };
    const tr = { w: 0.48, h: 0.56 };
    const br = { w: 0.46, h: 0.44 };
    const bl = { w: 0.54, h: 0.42 };
    const k = 0.5523;

    const gradient = ctx.createLinearGradient(-0.42, -0.5, 0.42, 0.5);
    gradient.addColorStop(0, PALETTE.berry1);
    gradient.addColorStop(0.34, PALETTE.berry2);
    gradient.addColorStop(0.68, PALETTE.berry3);
    gradient.addColorStop(1, PALETTE.berry4);

    ctx.beginPath();
    ctx.moveTo(r.x + tl.w, r.y);
    ctx.lineTo(r.x + r.w - tr.w, r.y);
    ctx.bezierCurveTo(
      r.x + r.w - tr.w * (1 - k), r.y,
      r.x + r.w, r.y + tr.h * (1 - k),
      r.x + r.w, r.y + tr.h
    );
    ctx.lineTo(r.x + r.w, r.y + r.h - br.h);
    ctx.bezierCurveTo(
      r.x + r.w, r.y + r.h - br.h * (1 - k),
      r.x + r.w - br.w * (1 - k), r.y + r.h,
      r.x + r.w - br.w, r.y + r.h
    );
    ctx.lineTo(r.x + bl.w, r.y + r.h);
    ctx.bezierCurveTo(
      r.x + bl.w * (1 - k), r.y + r.h,
      r.x, r.y + r.h - bl.h * (1 - k),
      r.x, r.y + r.h - bl.h
    );
    ctx.lineTo(r.x, r.y + tl.h);
    ctx.bezierCurveTo(r.x, r.y + tl.h * (1 - k), r.x + tl.w * (1 - k), r.y, r.x + tl.w, r.y);
    ctx.closePath();

    ctx.save();
    ctx.shadowColor = 'rgba(66, 84, 214, 0.45)';
    ctx.shadowBlur = 0.09;
    ctx.shadowOffsetY = 0.035;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();

    // A soft top-left sheen, like the design's light source.
    const sheen = ctx.createRadialGradient(-0.2, -0.26, 0.02, -0.2, -0.26, 0.42);
    sheen.addColorStop(0, 'rgba(255,255,255,0.5)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fill();

    // The little stalk dimple at the top, so he reads as a berry.
    ctx.beginPath();
    ctx.ellipse(0.02, -0.44, 0.055, 0.028, -0.15, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(28,31,102,0.55)';
    ctx.fill();
  }

  drawEyes(ctx) {
    const eye = { y: -0.06, dx: 0.175 };
    const radius = { x: 0.135, y: 0.155 };
    const lids = this.lids.value;
    const squint = this.squint.value;
    const gazeX = this.gaze.x;
    const gazeY = this.gaze.y;
    const pupilScale = this.pupil.value;

    for (const side of [-1, 1]) {
      const ex = side * eye.dx;
      const ey = eye.y + (this.mood === 'sleepy' ? 0.03 : 0);

      // Sclera
      ctx.beginPath();
      ctx.ellipse(ex, ey, radius.x, radius.y, 0, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.white;
      ctx.fill();
      ctx.lineWidth = 0.008;
      ctx.strokeStyle = 'rgba(28,31,102,0.18)';
      ctx.stroke();

      // Pupil, clamped inside the sclera so he never looks broken.
      const maxX = radius.x * 0.42;
      const maxY = radius.y * 0.38;
      const px = ex + gazeX * maxX;
      const py = ey + gazeY * maxY;
      const pr = 0.062 * pupilScale;

      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, ey, radius.x, radius.y, 0, 0, Math.PI * 2);
      ctx.clip();

      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.ink;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px - pr * 0.32, py - pr * 0.36, pr * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();

      // Eyelid: a rect that slides down from the top of the sclera.
      const lidAmount = Math.max(lids, squint * 0.72);
      if (lidAmount > 0.001) {
        const lidHeight = radius.y * 2 * Math.min(1, lidAmount);
        ctx.beginPath();
        ctx.rect(ex - radius.x - 0.01, ey - radius.y - 0.01, radius.x * 2 + 0.02, lidHeight);
        ctx.fillStyle = PALETTE.berry2;
        ctx.fill();
        // A soft edge instead of a hard line.
        ctx.beginPath();
        ctx.rect(ex - radius.x - 0.01, ey - radius.y + lidHeight - 0.012, radius.x * 2 + 0.02, 0.014);
        ctx.fillStyle = 'rgba(169,188,255,0.75)';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawBrows(ctx) {
    const lift = this.brow.value;
    const tilt = this.tilt.value;
    for (const side of [-1, 1]) {
      const ex = side * 0.175;
      const ey = -0.245 - lift - (this.mood === 'listening' ? Math.max(0, this.talk) * 0.03 : 0);
      const width = 0.13;
      const wobble = this.mood === 'thinking' && side === 1 ? -0.25 : 0;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate((tilt + wobble) * side * -1);
      ctx.beginPath();
      ctx.moveTo(-width / 2, 0);
      ctx.quadraticCurveTo(0, -0.03, width / 2, 0);
      ctx.lineWidth = 0.028;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(23,21,31,0.82)';
      ctx.stroke();
      ctx.restore();
    }
  }

  drawMouth(ctx) {
    const openness = Math.max(0, this.mouth.value);
    const smile = Math.max(0, this.mouth.value);

    if (this.mood === 'asleep' || this.mood === 'sleepy') {
      ctx.beginPath();
      ctx.moveTo(-0.032, 0.235);
      ctx.quadraticCurveTo(0, 0.255, 0.032, 0.235);
      ctx.lineWidth = 0.017;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(23,21,31,0.75)';
      ctx.stroke();
      return;
    }

    if (this.talk > 0.06 || this.mood === 'talking') {
      // An open, rounded mouth while he speaks; the height follows his voice.
      const height = 0.035 + openness * 0.075;
      const width = 0.062 + smile * 0.03;
      ctx.beginPath();
      ctx.ellipse(0, 0.235 + height * 0.25, width, height, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(28,31,102,0.92)';
      ctx.fill();
      // Tongue-ish highlight
      ctx.beginPath();
      ctx.ellipse(0, 0.235 + height * 0.55, width * 0.5, height * 0.28, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,140,170,0.75)';
      ctx.fill();
      return;
    }

    if (smile > 0.55) {
      // Big happy grin
      ctx.beginPath();
      ctx.moveTo(-0.075, 0.215);
      ctx.quadraticCurveTo(0, 0.335, 0.075, 0.215);
      ctx.closePath();
      ctx.fillStyle = 'rgba(28,31,102,0.9)';
      ctx.fill();
      return;
    }

    if (this.mood === 'error' || this.mouth.value < 0.08) {
      // A small unhappy curve
      ctx.beginPath();
      ctx.moveTo(-0.05, 0.275);
      ctx.quadraticCurveTo(0, 0.235, 0.05, 0.275);
      ctx.lineWidth = 0.019;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(23,21,31,0.78)';
      ctx.stroke();
      return;
    }

    // Neutral friendly curve
    ctx.beginPath();
    ctx.moveTo(-0.048, 0.238);
    ctx.quadraticCurveTo(0, 0.272 + smile * 0.02, 0.048, 0.238);
    ctx.lineWidth = 0.019;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(23,21,31,0.78)';
    ctx.stroke();
  }

  drawBlush(ctx) {
    const amount = Math.min(0.7, this.blush.value);
    if (amount <= 0.02) return;
    for (const side of [-1, 1]) {
      const x = side * 0.275;
      const y = 0.145;
      const gradient = ctx.createRadialGradient(x, y, 0.005, x, y, 0.075);
      gradient.addColorStop(0, `rgba(255,150,180,${0.55 * amount})`);
      gradient.addColorStop(1, 'rgba(255,150,180,0)');
      ctx.beginPath();
      ctx.ellipse(x, y, 0.075, 0.05, 0, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }

  drawSleepyZ(ctx) {
    if (this.mood !== 'sleepy' && this.mood !== 'asleep') return;
    const base = this.mood === 'asleep' ? 0.6 : 0.25;
    ctx.save();
    ctx.font = `${0.11}px Fredoka, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(185,178,204,0.9)';
    for (let i = 0; i < 3; i += 1) {
      const phase = (this.t * 0.45 + i * 0.33) % 1;
      const alpha = Math.sin(phase * Math.PI) * base;
      const x = 0.34 + phase * 0.14;
      const y = -0.12 - phase * 0.28;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillText('z', x * 1, y * 1);
    }
    ctx.restore();
  }
}

export { PALETTE, MOODS };
