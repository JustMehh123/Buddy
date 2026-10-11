import { randomUUID } from 'node:crypto';
import type {
  ActionRequest,
  ActionResult,
  ActionTarget,
  BuddySettings,
  Confirmation,
  Memory,
  ToolName
} from '@buddy/protocol';
import { buildConfirmationCopy, decide, looksSensitive } from '@buddy/core';
import type { ComputerController } from './computer/types.js';
import { ComputerError } from './computer/types.js';
import type { Vision } from './vision.js';

/**
 * Buddy's hands.
 *
 * Every tool call from the model lands here, and nothing gets done without
 * passing the same gate: policy first (@buddy/core, so the rules are the same
 * ones the prompt talks about), then the user's tap-to-confirm if it's risky,
 * then the actual work.
 *
 * Two habits make him feel well-behaved rather than robotic:
 *
 *   • He clicks with *his* cursor. The real pointer is saved, warped to the
 *     target, used, and put back exactly where you left it, so your mouse never
 *     teleports across the screen.
 *   • Pointing is always available and never touches anything, so the model can
 *     lean on it as the safe default for showing you something.
 */

export interface ActionContext {
  computer: ComputerController;
  vision: Vision;
  /** Current settings; read fresh on every action so toggles take effect. */
  settings(): BuddySettings;
  updateSettings(patch: Partial<BuddySettings>): BuddySettings;
  /** Move his own cursor on screen, and let it land. */
  pointCursor(target: { x: number; y: number; nx: number; ny: number; label?: string; confidence?: number }): void;
  clearCursor(): void;
  /** Highlight a spot without moving the cursor. */
  highlight(target: { x: number; y: number; width: number; height: number; label?: string }): void;
  /** Ask the phone to confirm; resolves false on timeout or denial. */
  confirm(confirmation: Confirmation): Promise<boolean>;
  remember(input: { text: string; kind?: Memory['kind']; tags?: string[]; importance?: number }): Memory;
  recall(query: string, limit?: number): Memory[];
  forget(query: { id?: string; text?: string }): Memory[];
  setMood(mood: string, say?: string): void;
  goToSleep(say?: string): void;
  setStatus(status: string | null): void;
  /** Called when the model should stop whatever it was doing. */
  onCancel(): void;
  log(entry: { level: 'info' | 'warn' | 'error'; message: string; data?: unknown }): void;
}

const now = () => Date.now();

export class ActionRunner {
  private readonly context: ActionContext;
  private cancelled = false;
  private busyUntil = 0;

  constructor(context: ActionContext) {
    this.context = context;
  }

  get isBusy(): boolean {
    return now() < this.busyUntil;
  }

  cancel(): void {
    this.cancelled = true;
    this.context.clearCursor();
  }

  /** The one entry point. Always resolves — failures become spoken results. */
  async run(request: Omit<ActionRequest, 'id' | 'requestedAt'> & { id?: string }): Promise<ActionResult> {
    const startedAt = now();
    const id = request.id ?? `act_${randomUUID().slice(0, 8)}`;
    const settings = this.context.settings();
    const tool = request.tool;
    const args = request.args ?? {};

    this.cancelled = false;
    this.context.log({ level: 'info', message: `tool ${tool}`, data: { args, deviceId: request.deviceId } });

    const finish = (result: Partial<ActionResult> & { message: string }): ActionResult => ({
      id,
      tool,
      status: result.status ?? 'ok',
      message: result.message,
      target: result.target,
      data: result.data,
      startedAt,
      finishedAt: now()
    });

    // ── Policy ─────────────────────────────────────────────────────────────
    const policy = decide({ tool, args, settings });
    if (!policy.allowed) {
      this.context.log({ level: 'warn', message: `refused ${tool}: ${policy.reason}` });
      return finish({ status: 'denied', message: policy.message ?? "I can't do that one." });
    }

    if (policy.confirm) {
      const copy = buildConfirmationCopy(tool, args);
      const confirmation: Confirmation = {
        id,
        token: randomUUID(),
        tool,
        args,
        summary: copy.summary,
        detail: copy.detail,
        risky: copy.risky,
        createdAt: now()
      };
      this.context.setStatus('waiting on you');
      const approved = await this.context.confirm(confirmation);
      this.context.setStatus(null);
      if (!approved) {
        this.context.log({ level: 'info', message: `not confirmed: ${tool}` });
        return finish({ status: 'cancelled', message: 'No problem, I left it alone.' });
      }
    }

    // ── Do the thing ───────────────────────────────────────────────────────
    try {
      switch (tool) {
        case 'look_at_screen':
          return finish(await this.lookAtScreen(args));
        case 'point_at':
          return finish(await this.pointAt(args));
        case 'move_cursor':
          return finish(await this.moveCursor(args));
        case 'click':
          return finish(await this.click(args));
        case 'type_text':
          return finish(await this.typeText(args));
        case 'press_keys':
          return finish(await this.pressKeys(args));
        case 'open_app':
          return finish(await this.openApp(args));
        case 'open_url':
          return finish(await this.openUrl(args));
        case 'list_apps':
          return finish(await this.listApps(args));
        case 'get_active_window':
          return finish(await this.activeWindow());
        case 'read_clipboard':
          return finish(await this.readClipboard());
        case 'write_clipboard':
          return finish(await this.writeClipboard(args));
        case 'run_shortcut':
          return finish(await this.runShortcut(args));
        case 'remember':
          return finish(this.remember(args));
        case 'recall':
          return finish(this.recall(args));
        case 'forget':
          return finish(this.forget(args));
        case 'set_mood':
          return finish(this.setMood(args));
        case 'go_to_sleep':
          return finish(this.goToSleep(args));
        case 'computer_use':
          return finish(this.computerUse(args));
        case 'cancel':
          return finish(this.cancelAll());
        default:
          return finish({ status: 'unsupported', message: `I don't know how to do "${tool}".` });
      }
    } catch (error) {
      if (error instanceof ComputerError && error.code === 'permission') {
        return finish({ status: 'denied', message: error.message });
      }
      const message = error instanceof Error ? error.message : 'something went wrong';
      this.context.log({ level: 'error', message: `${tool} failed`, data: message });
      return finish({ status: 'error', message: this.translateError(tool, message) });
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  private async lookAtScreen(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const question = stringArg(args.question, 'What is on the screen?');
    const region = (stringArg(args.region, 'full') as 'full' | 'window' | 'cursor') ?? 'full';
    const detail = (stringArg(args.detail, 'quick') as 'quick' | 'thorough') ?? 'quick';

    this.context.setStatus('looking');
    const read = await this.context.vision.read(question, {
      region: region === 'cursor' ? 'cursor' : region === 'window' ? 'window' : 'full',
      detail
    });
    this.context.setStatus(null);

    const top = read.targets
      .filter((target) => target.source === 'ax' || target.source === 'vision')
      .slice(0, 14)
      .map((target) => `${target.id}: ${target.text.slice(0, 70)}`);

    const message = [
      read.summary,
      top.length ? `Targets I can point at: ${top.join(' | ')}` : '',
      read.mouse ? `The user's pointer is at screen ${Math.round(read.mouse.x)}, ${Math.round(read.mouse.y)}.` : ''
    ]
      .filter(Boolean)
      .join('\n');

    return {
      message,
      status: 'ok',
      data: {
        app: read.app,
        windowTitle: read.windowTitle,
        targetCount: read.targets.length,
        screenshot: read.screenshots[0]?.dataUrl
      }
    };
  }

  private async pointAt(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const targetText = stringArg(args.target, '');
    if (!targetText) return { status: 'bad-request' as never, message: 'I need something to point at.' };

    const settings = this.context.settings();
    const located = await this.context.vision.locate(targetText, { cursorPoint: await this.context.computer.mousePosition() });

    if (!located) {
      this.context.setMood('confused');
      return {
        status: 'not_found',
        message: `I looked but I can't find anything called "${targetText}" on screen. Say what's near it, or tell me to look again.`
      };
    }

    if ((located.confidence ?? 0) < settings.pointingConfidence) {
      // Honest instead of confidently wrong.
      this.context.setMood('confused');
      this.context.pointCursor({
        x: located.point.x,
        y: located.point.y,
        nx: located.nx,
        ny: located.ny,
        label: located.label,
        confidence: located.confidence
      });
      return {
        status: 'not_found',
        target: located,
        message: `I'm only about ${Math.round((located.confidence ?? 0) * 100)} percent sure I've got the right thing — I'm pointing at "(${located.label})" but check me.`
      };
    }

    this.context.setMood('pointing');
    this.context.pointCursor({
      x: located.point.x,
      y: located.point.y,
      nx: located.nx,
      ny: located.ny,
      label: located.label,
      confidence: located.confidence
    });

    // Give the cursor time to arrive before the model speaks about it.
    await this.context.computer.wait(Math.min(1400, settings.cursorSpeed + 150));

    return {
      status: 'ok',
      target: located,
      message: `Pointing at "${located.label ?? targetText}".${located.description ? ` It is ${located.description}.` : ''} My cursor is there now — tell the user, don't repeat the coordinates.`,
      data: { source: located.source, confidence: located.confidence }
    };
  }

  private async moveCursor(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const x = numberArg(args.x);
    const y = numberArg(args.y);
    const targetText = stringArg(args.target, '');

    let nx = 0.5;
    let ny = 0.5;
    let point = { x: 0, y: 0 };
    let label = 'a spot you described';

    if (typeof x === 'number' && typeof y === 'number') {
      point = { x, y };
      const size = await this.context.computer.screenSize();
      nx = x / Math.max(1, size.width);
      ny = y / Math.max(1, size.height);
    } else if (targetText) {
      const located = await this.context.vision.locate(targetText);
      if (!located) return { status: 'not_found', message: `I couldn't find "${targetText}" to move to.` };
      point = located.point;
      nx = located.nx;
      ny = located.ny;
      label = located.label ?? targetText;
    } else {
      return { status: 'error', message: 'Give me a place to move to.' };
    }

    this.context.setMood('pointing');
    this.context.pointCursor({ ...point, nx, ny, label });
    await this.context.computer.wait(this.context.settings().cursorSpeed);
    return { status: 'ok', message: `My cursor is on ${label}.`, data: { nx, ny } };
  }

  private async click(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const settings = this.context.settings();
    const targetText = stringArg(args.target, '');
    const double = args.double === true;
    const button = args.button === 'right' ? 'right' : 'left';

    const located = targetText
      ? await this.context.vision.locate(targetText, { cursorPoint: await this.context.computer.mousePosition() })
      : null;

    if (!located && !(typeof numberArg(args.x) === 'number' && typeof numberArg(args.y) === 'number')) {
      this.context.setMood('confused');
      return {
        status: 'not_found',
        message: `I can't find "${targetText}" to click, so I didn't click anything. Point me at it again?`
      };
    }

    const point = located?.point ?? { x: numberArg(args.x)!, y: numberArg(args.y)! };
    const label = located?.label ?? targetText;

    // Fly his cursor there first — it should look like he did it, because he did.
    if (located) {
      this.context.setMood('pointing');
      this.context.pointCursor({ ...point, nx: located.nx, ny: located.ny, label });
      await this.context.computer.wait(Math.min(1200, settings.cursorSpeed));
    }

    if (!settings.moveRealMouse) {
      await this.clickAndRestore(point, { double, button }, settings);
    } else {
      await this.context.computer.click(point, { double, button });
    }

    this.context.setMood('working');
    return {
      status: 'ok',
      target: located ?? { x: point.x, y: point.y, nx: 0, ny: 0, label },
      message: `${double ? 'Double-clicked' : 'Clicked'} "${label}".${
        settings.moveRealMouse ? '' : ' I used my own cursor and put yours back where it was.'
      } If the screen didn't change, say so rather than clicking again.`,
      data: { point }
    };
  }

  /**
   * The trick that makes him tolerable to share a mouse with: remember where
   * the user's pointer was, warp it, click, warp it back.
   */
  private async clickAndRestore(
    point: { x: number; y: number },
    options: { double?: boolean; button?: 'left' | 'right' },
    settings: BuddySettings
  ): Promise<void> {
    const computer = this.context.computer;
    const before = await computer.mousePosition().catch(() => null);
    try {
      await computer.click(point, options);
      await computer.wait(Math.max(60, settings.cursorSpeed / 6));
    } finally {
      if (before) {
        await computer.moveMouse(before).catch(() => undefined);
      }
    }
  }

  private async typeText(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const text = stringArg(args.text, '');
    const submit = args.submit === true;
    if (!text) return { status: 'error', message: 'I had nothing to type.' };

    if (looksSensitive(text)) {
      return {
        status: 'denied',
        message: "That looks like a password or a code, so I'm not typing it. You've got that one."
      };
    }

    this.context.setMood('working');
    await this.context.computer.typeText(text);

    if (submit) {
      await this.context.computer.wait(260);
      await this.context.computer.pressKeys({ keys: 'enter' });
    }

    // A quick read-back so he can tell whether it landed somewhere sensible,
    // and notice the classic "typed into a password field" accident.
    await this.context.computer.wait(400);
    let warning = '';
    try {
      if (isAxCapable(this.context.computer)) {
        const controls = await this.context.computer.listControls();
        const focused = controls.find((control) => /AXSecureTextField|password/i.test(control.role ?? '' + control.text));
        if (focused) {
          warning =
            ' That went into a password-looking field — tell the user, and do not type anything else there.';
        }
      }
    } catch {
      /* read-back is a nicety, not a requirement */
    }

    return {
      status: 'ok',
      message: `Typed it${submit ? ' and pressed Enter' : ''}.${warning}`,
      data: { length: text.length, submit }
    };
  }

  private async pressKeys(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const keys = stringArg(args.keys, '');
    const repeat = numberArg(args.repeat) ?? 1;
    if (!keys) return { status: 'error', message: 'Which keys?' };
    await this.context.computer.pressKeys({ keys, repeat });
    return { status: 'ok', message: `Pressed ${keys}${repeat > 1 ? ` ${repeat} times` : ''}.` };
  }

  private async openApp(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const name = stringArg(args.name, '');
    if (!name) return { status: 'error', message: 'Which app?' };
    this.context.setMood('working');
    const result = await this.context.computer.openApp(name);
    return { status: result.ok ? 'ok' : 'not_found', message: result.message };
  }

  private async openUrl(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    let url = stringArg(args.url, '');
    if (!url) return { status: 'error', message: 'Which link?' };
    if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;
    const result = await this.context.computer.openUrl(url);
    return { status: result.ok ? 'ok' : 'error', message: result.message };
  }

  private async listApps(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const scope = stringArg(args.scope, 'running');
    const apps = await this.context.computer.runningApps();
    if (!apps.length) {
      return { status: 'ok', message: 'I can see the machine but no apps with windows are open right now.' };
    }
    return {
      status: 'ok',
      message: `${scope === 'installed' ? 'Apps I know about' : 'Open right now'}: ${apps.slice(0, 12).join(', ')}.`,
      data: { apps }
    };
  }

  private async activeWindow(): Promise<Partial<ActionResult> & { message: string }> {
    const active = await this.context.computer.activeWindow();
    if (!active) return { status: 'ok', message: "I can't tell which app is focused right now." };
    return {
      status: 'ok',
      message: `${active.app} is in front${active.title ? `, showing "${active.title}"` : ''}.`,
      data: active
    };
  }

  private async readClipboard(): Promise<Partial<ActionResult> & { message: string }> {
    const text = await this.context.computer.readClipboard();
    if (!text.trim()) return { status: 'ok', message: 'The clipboard is empty.' };
    if (looksSensitive(text)) {
      return {
        status: 'ok',
        message: "There's something on the clipboard that looks like a secret, so I'm not reading it out loud.",
        data: { redacted: true, length: text.length }
      };
    }
    return {
      status: 'ok',
      message: `The clipboard says: ${text.slice(0, 600)}`,
      data: { text: text.slice(0, 4000) }
    };
  }

  private async writeClipboard(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const text = stringArg(args.text, '');
    await this.context.computer.writeClipboard(text);
    return { status: 'ok', message: 'Copied. Paste away.', data: { length: text.length } };
  }

  private async runShortcut(args: Record<string, unknown>): Promise<Partial<ActionResult> & { message: string }> {
    const name = stringArg(args.name, '');
    const shortcutArgs = stringArg(args.args, undefined as unknown as string) || undefined;
    const result = await this.context.computer.runShortcut(name, shortcutArgs);
    return {
      status: result.ok ? 'ok' : 'not_found',
      message: result.message,
      data: { output: result.output }
    };
  }

  private remember(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const text = stringArg(args.text, '');
    if (!text) return { status: 'error', message: 'Nothing to remember.' };
    const memory = this.context.remember({
      text,
      kind: (stringArg(args.kind, 'fact') as Memory['kind']) ?? 'fact',
      tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : undefined,
      importance: numberArg(args.importance) ?? 0.5
    });
    return { status: 'ok', message: `Noted — I'll remember that.`, data: { id: memory.id } };
  }

  private recall(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const query = stringArg(args.query, '');
    const memories = this.context.recall(query, 8);
    if (!memories.length) return { status: 'ok', message: `I've got nothing on "${query}".` };
    return {
      status: 'ok',
      message: `I remember: ${memories.map((memory) => memory.text).join(' | ')}`,
      data: { memories }
    };
  }

  private forget(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const id = stringArg(args.id, '');
    const text = stringArg(args.text, '');
    const removed = this.context.forget({ id: id || undefined, text: text || undefined });
    if (!removed.length) return { status: 'not_found', message: "I couldn't find that one to forget." };
    return { status: 'ok', message: 'Forgotten.', data: { ids: removed.map((memory) => memory.id) } };
  }

  private setMood(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const mood = stringArg(args.mood, 'idle');
    const say = stringArg(args.say, '');
    this.context.setMood(mood, say || undefined);
    return { status: 'ok', message: say ? `Face set to ${mood}, and he said: ${say}` : `Face set to ${mood}.` };
  }

  private goToSleep(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const say = stringArg(args.say, '');
    this.context.goToSleep(say || undefined);
    return { status: 'ok', message: 'He is going to sleep. Stay quiet now — no more talking until you are woken.' };
  }

  private computerUse(args: Record<string, unknown>): Partial<ActionResult> & { message: string } {
    const enabled = args.enabled !== false;
    const settings = this.context.updateSettings({ computerUse: enabled });
    return {
      status: 'ok',
      message: enabled
        ? 'Computer use is back on — he can drive the mouse and keyboard again.'
        : 'Computer use is off. He can still look and point, but not click or type.',
      data: { computerUse: settings.computerUse }
    };
  }

  private cancelAll(): Partial<ActionResult> & { message: string } {
    this.cancel();
    this.context.onCancel();
    return { status: 'cancelled', message: 'Stopped.' };
  }

  private translateError(tool: ToolName, message: string): string {
    if (/timed out/i.test(message)) return `"${tool}" took too long, so I stopped; nothing else was touched.`;
    if (/permission|not authorized|denied/i.test(message)) {
      return `I don't have permission to do that yet — the computer needs to allow me first. (${message.slice(0, 140)})`;
    }
    return `That didn't work: ${message.slice(0, 180)}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const stringArg = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const numberArg = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const isAxCapable = (
  computer: ComputerController
): computer is ComputerController & { listControls(): Promise<{ role?: string; text?: string }[]> } =>
  typeof (computer as unknown as { listControls?: unknown }).listControls === 'function';

/** Exposed for tests: the click-and-restore dance, without the OS. */
export const simulateClickAndRestore = async (
  computer: {
    mousePosition(): Promise<{ x: number; y: number } | null>;
    click(point: { x: number; y: number }, options?: { double?: boolean; button?: 'left' | 'right' }): Promise<void>;
    moveMouse(point: { x: number; y: number }): Promise<void>;
  },
  point: { x: number; y: number }
): Promise<void> => {
  const before = await computer.mousePosition();
  await computer.click(point);
  if (before) await computer.moveMouse(before);
};

export type { ActionTarget };
