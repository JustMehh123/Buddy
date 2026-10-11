/**
 * The Buddy wire format.
 *
 * Buddy is two apps that find each other on the same Wi-Fi:
 *
 *   ┌───────────────────┐   HTTP + WebSocket    ┌───────────────────────┐
 *   │  Buddy (phone)    │ ────────────────────► │  Buddy (computer)     │
 *   │  the talking      │   http://buddy.local  │  the seeing + doing   │
 *   └───────────────────┘                       └───────────────────────┘
 *
 * The phone owns the microphone and the face. The computer owns the API key,
 * the screen, the cursor, the mouse and the keyboard. Everything that crosses
 * between them is described here, and the schema below is the same object we
 * hand to OpenAI as a function tool — so the model can only ever ask for
 * things the host is actually able to do.
 */

export const PROTOCOL_VERSION = 3 as const;

/** Names of the tools the phone's voice session can call. */
export type ToolName =
  | 'look_at_screen'
  | 'point_at'
  | 'move_cursor'
  | 'click'
  | 'type_text'
  | 'press_keys'
  | 'run_shortcut'
  | 'open_app'
  | 'open_url'
  | 'list_apps'
  | 'read_clipboard'
  | 'write_clipboard'
  | 'get_active_window'
  | 'remember'
  | 'recall'
  | 'forget'
  | 'set_mood'
  | 'go_to_sleep'
  | 'computer_use'
  | 'cancel';

// ────────────────────────────────────────────────────────────────────────────
// Pairing
// ────────────────────────────────────────────────────────────────────────────

export interface HostIdentity {
  /** Stable id for this computer. Survives restarts, renames and re-pairing. */
  id: string;
  /** What the phone shows when pairing, e.g. "Riley's MacBook Pro". */
  name: string;
  /** Lowercase-dashed `macbook-pro-2.local` style name used for mDNS. */
  hostname: string;
  platform: 'darwin' | 'win32' | 'linux' | 'web';
  arch: string;
  /** Which of Buddy's abilities actually work on this machine right now. */
  capabilities: Capability[];
  appVersion: string;
  protocolVersion: number;
}

export type Capability =
  | 'screen'
  | 'pointer'
  | 'mouse'
  | 'keyboard'
  | 'apps'
  | 'clipboard'
  | 'shortcuts';

export const CAPABILITY_NOTES: Record<Capability, string> = {
  screen: 'can see your screen',
  pointer: 'can point with his own cursor',
  mouse: 'can move your real mouse and click',
  keyboard: 'can type and press keys',
  apps: 'can open apps and windows',
  clipboard: 'can read and write the clipboard',
  shortcuts: 'can run your Shortcuts / automations'
};

export interface PairingChallenge {
  /** Six digits the phone shows so you know you paired with your own computer. */
  code: string;
  /** Random device id the phone generated, echoed back. */
  deviceId: string;
  deviceName: string;
  /** Always true in the normal flow. */
  createdAt: number;
}

export interface PairingResult {
  token: string;
  host: HostIdentity;
  /** Short-lived credential for the phone's realtime voice session. */
  live: LiveCredentials | null;
  /** The OpenAI-shaped credentials, when OpenAI is the voice provider. */
  realtime?: RealtimeCredentials;
  settings: BuddySettings;
  memories: Memory[];
}

/**
 * A short-lived credential for a speech-to-speech session, from whichever
 * provider is doing the talking. Gemini and OpenAI want different shapes, so
 * the phone gets both the token and a description of how to use it.
 */
export interface LiveCredentials {
  provider: 'gemini' | 'openai';
  /** One-shot token. Dies after the session, so the real key stays home. */
  token: string;
  expiresAt: number;
  model: string;
  /** Where to open the socket (Gemini) or post the SDP (OpenAI). */
  wsUrl: string;
  callsUrl?: string;
  /** The session configuration the host wants, mirrored by both providers. */
  session: RealtimeSessionConfig;
  /** Seconds of audio the provider allows before a session must restart. */
  maxSessionSeconds?: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  token: string;
  pairedAt: number;
  lastSeenAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Realtime voice
// ────────────────────────────────────────────────────────────────────────────

export interface RealtimeCredentials {
  /** `ek_...` ephemeral client secret. Never the real API key. */
  clientSecret: string;
  expiresAt: number;
  model: string;
  /** The session config the host minted the token with (for reconciliation). */
  session: RealtimeSessionConfig;
  /** Where to exchange SDP. Normally https://api.openai.com/v1/realtime/calls */
  callsUrl: string;
  transport: 'webrtc' | 'websocket';
  /** Empty string means "same origin as the host". */
  apiBase: string;
}

export interface RealtimeSessionConfig {
  type: 'realtime';
  model: string;
  instructions: string;
  outputModalities: ('audio' | 'text')[];
  voice: string;
  temperature: number;
  inputAudioTranscriptionModel: string;
  turnDetection: TurnDetection | null;
  tools: RealtimeTool[];
  toolChoice: 'auto' | 'none';
}

export interface TurnDetection {
  type: 'server_vad';
  threshold: number;
  prefixPaddingMs: number;
  silenceDurationMs: number;
}

export interface RealtimeTool {
  type: 'function';
  name: ToolName | string;
  description: string;
  parameters: Record<string, unknown>;
  /** Host-side metadata, stripped before the tool is sent to OpenAI. */
  meta?: ToolMeta;
}

export interface ToolMeta {
  /** Requires the user to confirm on the phone before Buddy does it. */
  risky: boolean;
  /** Never allowed, regardless of settings (see safety.ts in @buddy/core). */
  blocked?: boolean;
  /** Only available when computer use is switched on. */
  requiresComputerUse?: boolean;
  icon?: string;
  /** Groups tools in the settings UI. */
  group?: 'look' | 'point' | 'control' | 'system' | 'memory' | 'mood';
}

// ────────────────────────────────────────────────────────────────────────────
// The face
// ────────────────────────────────────────────────────────────────────────────

/**
 * Buddy's moods. The renderer interpolates between them, so any string in
 * here can be reached smoothly from any other.
 */
export type Mood =
  | 'sleeping'
  | 'drowsy'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'happy'
  | 'curious'
  | 'pointing'
  | 'working'
  | 'confused'
  | 'surprised'
  | 'concerned'
  | 'smug'
  | 'proud';

export type Gesture =
  | 'wake'
  | 'nod'
  | 'shake'
  | 'blink'
  | 'wink'
  | 'look'
  | 'point'
  | 'sleep'
  | 'bounce';

/** The whole state of the face, in one object, sent over the wire. */
export interface FaceState {
  mood: Mood;
  /** 0..1 eyelid closure. 1 = fully shut. */
  blink: number;
  /** -1..1 where the pupils are looking (x), -1 up, 1 down (y). */
  gaze: { x: number; y: number };
  /** 0..1 how wide the eyes are. */
  open: number;
  /** Mouth curve: -1 sad frown, 0 flat, 1 big smile. */
  smile: number;
  /** -1..1 head tilt in radians-ish. */
  tilt: number;
  /** 0..1 breathing speed multiplier. */
  energy: number;
  /** Screen-space point Buddy is pointing at, if any (normalised 0..1). */
  pointing: { x: number; y: number } | null;
  /** Transient gestures to play once. */
  gestures: Gesture[];
  /** Small message the face can show ("on it", "couldn't find it"). */
  status: string | null;
  updatedAt: number;
}

export const DEFAULT_FACE_STATE: FaceState = {
  mood: 'idle',
  blink: 0,
  gaze: { x: 0, y: 0 },
  open: 1,
  smile: 0.15,
  tilt: 0,
  energy: 0.5,
  pointing: null,
  gestures: [],
  status: null,
  updatedAt: 0
};

// ────────────────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────────────────

export interface ActionRequest {
  /** Unique id so the phone, the host and the logs agree on what happened. */
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
  /** Which paired device asked. */
  deviceId: string;
  requestedAt: number;
}

export interface ActionTarget {
  x: number;
  y: number;
  /** Normalised screen coordinates (0..1) so any display size works. */
  nx: number;
  ny: number;
  /** What Buddy believes is at that spot. */
  label?: string;
  /** How sure he is, 0..1. Below settings.pointingConfidence he says so. */
  confidence?: number;
  /** Plain-language description of the thing, read off the screen. */
  description?: string;
  displayIndex?: number;
}

export type ActionStatus =
  | 'ok'
  | 'not_found'
  | 'needs_confirmation'
  | 'denied'
  | 'blocked'
  | 'unsupported'
  | 'error'
  | 'cancelled';

export interface ActionResult {
  id: string;
  tool: ToolName;
  status: ActionStatus;
  /** What the model should tell the user. Short, spoken-friendly. */
  message: string;
  target?: ActionTarget;
  /** Where the action happened, for the desktop overlay + dev logs. */
  data?: Record<string, unknown>;
  /** True when the host wants the phone to confirm before it finishes. */
  confirmToken?: string;
  startedAt: number;
  finishedAt: number;
}

export interface Confirmation {
  id: string;
  token: string;
  tool: ToolName;
  args: Record<string, unknown>;
  /** Buddy's own words: "Post "building something cool" to X?" */
  summary: string;
  /** What happens if you say yes. */
  detail?: string;
  risky: boolean;
  createdAt: number;
}

export interface ConfirmationResponse {
  id: string;
  token: string;
  approved: boolean;
  deviceId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Memory
// ────────────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 'fact' = something durable about you, 'note' = something to do later. */
  kind: 'fact' | 'preference' | 'note' | 'person' | 'place';
  text: string;
  tags: string[];
  /** 0..1, higher = surfaced first. */
  importance: number;
  source: 'voice' | 'typed' | 'manual';
}

// ────────────────────────────────────────────────────────────────────────────
// Settings
// ────────────────────────────────────────────────────────────────────────────

export interface BuddySettings {
  /** What he answers to. */
  name: string;
  /** Free-form personality text you can edit from any of the apps. */
  personality: string;
  voice: string;
  realtimeModel: string;
  textModel: string;
  visionModel: string;
  /** Spoken out loud, straight into the session instructions. */
  customInstructions: string;
  memoryEnabled: boolean;
  computerUse: boolean;
  confirmRiskyActions: boolean;
  allowTyping: boolean;
  allowClicking: boolean;
  allowShortcuts: boolean;
  /** 0..1. Below this, he says he isn't sure instead of pointing. */
  pointingConfidence: number;
  /** ms the cursor flight takes. */
  cursorSpeed: number;
  /** Leave a trail behind his cursor when he flies. */
  cursorTrail: 'comet' | 'string' | 'none';
  /** Keep listening after he answers (hands-free) instead of hold-to-talk. */
  wakeWord: boolean;
  /** Push-to-talk requires holding the screen — the default. */
  pushToTalk: boolean;
  /** Play a soft chime when he wakes up. */
  chime: boolean;
  /** Show transcript bubbles on the face. */
  captions: boolean;
  /** Let the computer's real mouse follow along when he points. */
  moveRealMouse: boolean;
  /** Mood he drifts to when nothing is happening. */
  defaultMood: Mood;
  /** Auto-nap after this many ms of nothing. 0 disables. */
  sleepAfterMs: number;
  /** Where his cursor overlay lives on the computer. */
  overlay: {
    enabled: boolean;
    cursor: boolean;
    trail: boolean;
    faceOnScreen: boolean;
    facePosition: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'custom';
    facePoint: { x: number; y: number } | null;
  };
}

export const DEFAULT_SETTINGS: BuddySettings = {
  name: 'Buddy',
  personality:
    "Warm, a little cheeky, quick. Talks like a friend who happens to be sitting inside your computer. Never corporate, never a wall of text.",
  voice: 'marin',
  realtimeModel: 'gpt-realtime-2.1',
  textModel: 'gpt-4o',
  visionModel: 'gpt-4o',
  customInstructions: '',
  memoryEnabled: true,
  computerUse: true,
  confirmRiskyActions: true,
  allowTyping: true,
  allowClicking: true,
  allowShortcuts: true,
  pointingConfidence: 0.45,
  cursorSpeed: 850,
  cursorTrail: 'comet',
  wakeWord: false,
  pushToTalk: true,
  chime: true,
  captions: true,
  moveRealMouse: false,
  defaultMood: 'idle',
  sleepAfterMs: 10 * 60 * 1000,
  overlay: {
    enabled: true,
    cursor: true,
    trail: true,
    faceOnScreen: false,
    facePosition: 'bottom-right',
    facePoint: null
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Live link
// ────────────────────────────────────────────────────────────────────────────

/** Buffered host → phone events, so a reconnecting phone misses nothing. */
export interface HostEventMap {
  'face.state': FaceState;
  'face.status': { status: string | null; mood?: Mood };
  'host.info': HostIdentity;
  'settings.changed': BuddySettings;
  'memory.changed': Memory[];
  'action.started': { id: string; tool: ToolName; label?: string };
  'action.finished': ActionResult;
  'confirmation.request': Confirmation;
  'confirmation.resolved': { id: string; approved: boolean };
  'screen.frame': { dataUrl: string; width: number; height: number; at: number };
  'caption': { role: 'buddy' | 'you'; text: string; final: boolean; at: number };
  'toast': { text: string; kind: 'info' | 'success' | 'warn' | 'error' };
  'error': { message: string; code?: string };
  'pong': { at: number; echo?: number };
}

export interface PhoneActionMap {
  'action.request': { tool: ToolName; args: Record<string, unknown>; id?: string };
  'action.confirm': ConfirmationResponse;
  'action.cancel': { id?: string };
  'face.update': Partial<FaceState>;
  'face.gesture': { gesture: Gesture };
  'settings.update': Partial<BuddySettings>;
  'memory.add': { text: string; kind?: Memory['kind']; tags?: string[] };
  'memory.delete': { id: string };
  'memory.clear': Record<string, never>;
  'session.token': { session?: Partial<RealtimeSessionConfig> };
  'session.log': Record<string, unknown>;
  'get.state': Record<string, never>;
  'ping': { at: number };
}

// ────────────────────────────────────────────────────────────────────────────
// The desktop shell (cursor overlay + floating face)
// ────────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface DisplayInfo {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
}

/**
 * Events the host pushes to the desktop shell. The shell draws; it never
 * decides anything, so the cursor you see is always the same cursor the host
 * believes it moved.
 */
export interface OverlayEventMap {
  /** The shell has to send this first; it tells the host about the screens. */
  'overlay.hello': { platform: string; displays: DisplayInfo[]; version: string };
  'overlay.displays': { displays: DisplayInfo[] };
  /** Fly his cursor. `from` is where the shell should start, `to` where it lands. */
  'overlay.cursor': {
    from: Point;
    to: Point;
    durationMs: number;
    trail: BuddySettings['cursorTrail'];
    label?: string;
    /** Pulse the cursor like a click, without touching the real mouse. */
    tap?: boolean;
  };
  'overlay.cursor.hide': Record<string, never>;
  /** Ring something on screen without moving the cursor. */
  'overlay.highlight': { x: number; y: number; width: number; height: number; ms: number; label?: string };
  /** Keep the floating face in sync, and let his eyes follow the real pointer. */
  'overlay.face': {
    state: FaceState;
    /** Normalised position of the user's real pointer, if the shell can see it. */
    pointer: Point | null;
  };
  'overlay.settings': { overlay: BuddySettings['overlay']; cursorSpeed: number };
  /** Ask the shell to show/hide windows (used by the menu bar). */
  'overlay.visibility': { cursor: boolean; face: boolean };
}

export type OverlayEventType = keyof OverlayEventMap;
export type OverlayEvent<T extends OverlayEventType = OverlayEventType> = {
  type: T;
  payload: OverlayEventMap[T];
  at: number;
};

export interface OverlayHello {
  platform: string;
  displays: DisplayInfo[];
  version: string;
}

export type HostEventType = keyof HostEventMap;
export type PhoneActionType = keyof PhoneActionMap;
export type HostEvent<T extends HostEventType = HostEventType> = {
  type: T;
  payload: HostEventMap[T];
  seq?: number;
  at: number;
};
export type PhoneAction<T extends PhoneActionType = PhoneActionType> = {
  type: T;
  payload: PhoneActionMap[T];
  id?: string;
  at: number;
};

export const isHostEvent = (value: unknown): value is HostEvent => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; payload?: unknown };
  return typeof candidate.type === 'string' && 'payload' in candidate;
};

export const isPhoneAction = (value: unknown): value is PhoneAction => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown };
  return typeof candidate.type === 'string' && 'payload' in candidate;
};
