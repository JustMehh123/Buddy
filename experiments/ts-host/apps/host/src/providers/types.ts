import type { RealtimeTool } from '@buddy/protocol';

/**
 * Buddy can think with more than one brain.
 *
 * Everything in the host talks to this little interface, so swapping between a
 * free Gemini key, a free Groq key, a local Ollama server or a paid OpenAI key
 * is a config change and nothing more. The registry picks the best available
 * option per job: the voice session wants realtime audio, the eyes want vision,
 * the ears want fast transcription.
 */

export type ProviderId = 'gemini' | 'groq' | 'ollama' | 'openai' | 'openai-compatible';

export interface ChatImages {
  /** Base64 (no data: prefix) PNG/JPEG data. */
  data: string;
  mimeType: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Screenshots attached to this message. */
  images?: ChatImages[];
  /** For role: 'tool' — which call this is the answer to. */
  toolCallId?: string;
  toolName?: string;
  /** For role: 'assistant' — calls the model asked for. */
  toolCalls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: RealtimeTool[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for JSON back (used by the vision pass). */
  json?: boolean;
  signal?: AbortSignal;
  /** Rough budget guard for the caller. */
  purpose?: 'chat' | 'vision' | 'screen' | 'title';
}

export interface ChatResult {
  text: string;
  toolCalls: ChatToolCall[];
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TranscribeRequest {
  audio: Buffer;
  mimeType: string;
  language?: string;
  /** A nudge for the model, e.g. "expect app names and file paths". */
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  model: string;
}

export interface SpeakRequest {
  text: string;
  voice?: string;
  /** 'mp3' is safest for browsers; some providers only do WAV/PCM. */
  format?: 'mp3' | 'wav' | 'pcm';
  speed?: number;
  signal?: AbortSignal;
}

export interface SpeakResult {
  audio: Buffer;
  mimeType: string;
  model: string;
}

export interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  stt: boolean;
  tts: boolean;
  /** Speech-to-speech over a persistent socket. */
  live: boolean;
  /** Accepts a tool/function schema. */
  tools: boolean;
}

export interface BuddyProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** Models to try, best first. The host walks this list on 404/400. */
  readonly models: {
    chat: string[];
    vision: string[];
    stt: string[];
    tts: string[];
    live: string[];
  };
  chat(request: ChatRequest): Promise<ChatResult>;
  chatStream?(request: ChatRequest): AsyncIterable<string>;
  transcribe?(request: TranscribeRequest): Promise<TranscribeResult>;
  speak?(request: SpeakRequest): Promise<SpeakResult>;
  /** Cheap way to check the key works at all. */
  healthCheck(): Promise<{ ok: boolean; detail: string; models?: string[] }>;
}

export type ProviderErrorCode =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'bad-request'
  | 'not-found'
  | 'network'
  | 'unsupported'
  | 'timeout'
  | 'unknown';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly provider: ProviderId;

  constructor(provider: ProviderId, code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.status = status;
  }

  /** Is it worth trying the next provider? */
  get retryable(): boolean {
    return ['rate-limit', 'quota', 'network', 'timeout', 'not-found', 'unsupported'].includes(this.code);
  }

  /** Should the user be told to fix something? */
  get actionable(): string | null {
    switch (this.code) {
      case 'auth':
        return `${this.provider}: that key was rejected. Check it in settings.`;
      case 'rate-limit':
        return `${this.provider}: rate limited. Buddy will slow down, or add another free key.`;
      case 'quota':
        return `${this.provider}: out of free quota for today.`;
      default:
        return null;
    }
  }
}

export const classifyStatus = (status: number): ProviderErrorCode => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 422) return 'bad-request';
  if (status === 404) return 'not-found';
  if (status === 402 || status === 403) return 'quota';
  if (status >= 500) return 'network';
  return 'unknown';
};

/** A backoff that respects what the provider told us, if anything. */
export const retryDelayMs = (attempt: number, retryAfterSeconds?: number): number => {
  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    return Math.min(60_000, retryAfterSeconds * 1000);
  }
  return Math.min(20_000, 600 * 2 ** attempt) + Math.random() * 250;
};

export const withTimeout = (signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
};
