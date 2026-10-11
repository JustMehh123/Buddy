import type { RealtimeTool } from '@buddy/protocol';
import {
  ProviderError,
  classifyStatus,
  withTimeout,
  type BuddyProvider,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type SpeakRequest,
  type SpeakResult,
  type TranscribeRequest,
  type TranscribeResult
} from './types.js';

/**
 * Google Gemini.
 *
 * This is Buddy's default brain, because it is the only big provider whose
 * free tier covers *speech-to-speech* as well as vision and text. You get a
 * key from aistudio.google.com with no credit card, and the same key powers
 * his ears, his eyes and his mouth.
 *
 * Two independent surfaces are used here:
 *   • the plain REST API for text, vision, transcription and TTS
 *   • the Live API (BidiGenerateContent) for realtime voice, which the phone
 *     connects to directly with a short-lived token we mint on this machine
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Free-tier models, best first. The provider walks the list on a 404. */
export const GEMINI_MODELS = {
  chat: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  vision: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  stt: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  tts: [
    'gemini-3.8-flash-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-flash-preview-tts'
  ],
  live: [
    'gemini-3.8-live',
    'gemini-3.1-flash-live-preview',
    'gemini-2.5-flash-native-audio-preview-12-2025'
  ]
} as const;

/** Gemini's prebuilt voices that suit a small cheerful companion. */
export const GEMINI_VOICES = [
  'Puck',
  'Kore',
  'Leda',
  'Aoede',
  'Zephyr',
  'Charon',
  'Fenrir',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba'
] as const;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiOptions {
  apiKey: string;
  /** Override for a proxy or a regional endpoint. */
  baseUrl?: string;
  /** Preferred models; falls back to the built-ins above. */
  models?: Partial<Record<keyof typeof GEMINI_MODELS, string[]>>;
}

export class GeminiProvider implements BuddyProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini (free tier)';
  readonly capabilities = {
    chat: true,
    vision: true,
    stt: true,
    tts: true,
    live: true,
    tools: true
  };
  readonly models: BuddyProvider['models'];

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? GEMINI_BASE).replace(/\/$/, '');
    this.models = {
      chat: options.models?.chat ?? [...GEMINI_MODELS.chat],
      vision: options.models?.vision ?? [...GEMINI_MODELS.vision],
      stt: options.models?.stt ?? [...GEMINI_MODELS.stt],
      tts: options.models?.tts ?? [...GEMINI_MODELS.tts],
      live: options.models?.live ?? [...GEMINI_MODELS.live]
    };
  }

  // ── Text and vision ──────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ChatResult> {
    const wantsVision = request.messages.some((message) => message.images?.length);
    const candidates = request.model
      ? [request.model]
      : wantsVision
        ? this.models.vision
        : this.models.chat;

    return this.tryModels(candidates, async (model) => {
      const body: Record<string, unknown> = {
        contents: toGeminiContents(request.messages),
        generationConfig: {
          temperature: request.temperature ?? 0.8,
          maxOutputTokens: request.maxTokens ?? 1024,
          ...(request.json ? { responseMimeType: 'application/json' } : {})
        }
      };

      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (request.tools?.length) {
        body.tools = [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }];
      }

      const json = await this.post<GeminiResponse>(`/models/${model}:generateContent`, body, request.signal);
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((part) => part.text ?? '')
        .join('')
        .trim();
      const toolCalls = parts
        .filter((part) => part.functionCall?.name)
        .map((part, index) => ({
          id: `gem_${Date.now().toString(36)}_${index}`,
          name: part.functionCall!.name,
          args: part.functionCall!.args ?? {}
        }));

      return {
        text,
        toolCalls,
        model,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount,
          outputTokens: json.usageMetadata?.candidatesTokenCount
        }
      };
    });
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    const model = request.model ?? this.models.chat[0]!;
    const body = {
      contents: toGeminiContents(request.messages),
      systemInstruction: request.messages.some((message) => message.role === 'system')
        ? {
            parts: [
              {
                text: request.messages
                  .filter((message) => message.role === 'system')
                  .map((message) => message.content)
                  .join('\n\n')
              }
            ]
          }
        : undefined,
      generationConfig: { temperature: request.temperature ?? 0.8, maxOutputTokens: request.maxTokens ?? 1024 }
    };

    const response = await fetch(`${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!response.ok || !response.body) {
      throw await this.errorFrom(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as GeminiResponse;
          const text = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
          if (text) yield text;
        } catch {
          /* partial frame, skip */
        }
      }
    }
  }

  // ── Ears ─────────────────────────────────────────────────────────────────

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    return this.tryModels(this.models.stt, async (model) => {
      const prompt = [
        'Transcribe this audio exactly as spoken, in the language it was spoken in.',
        'Return only the transcript, no quotes, no commentary, no timestamps.',
        'If the audio is silent or unintelligible, return an empty string.',
        request.prompt ? `Context to help you: ${request.prompt}` : '',
        request.language ? `The speaker is using ${request.language}.` : ''
      ]
        .filter(Boolean)
        .join(' ');

      const json = await this.post<GeminiResponse>(
        `/models/${model}:generateContent`,
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: request.mimeType, data: request.audio.toString('base64') } }
              ]
            }
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
        },
        request.signal,
        60_000
      );

      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
        .trim();
      return { text, model };
    });
  }

  // ── Mouth ────────────────────────────────────────────────────────────────

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    const voice = request.voice && GEMINI_VOICES.includes(request.voice as (typeof GEMINI_VOICES)[number])
      ? request.voice
      : 'Puck';

    return this.tryModels(this.models.tts, async (model) => {
      const json = await this.post<GeminiResponse>(
        `/models/${model}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: request.text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
            }
          }
        },
        request.signal,
        45_000
      );

      const inline = (json.candidates?.[0]?.content?.parts ?? []).find((part) => part.inlineData)?.inlineData;
      if (!inline?.data) throw new ProviderError('gemini', 'unknown', 'Gemini returned no audio.');
      const audio = Buffer.from(inline.data, 'base64');
      const mimeType = inline.mimeType ?? 'audio/L16;rate=24000';
      return {
        audio: mimeType.includes('wav') ? audio : wrapPcmAsWav(audio, mimeType),
        mimeType: mimeType.includes('wav') ? mimeType : 'audio/wav',
        model
      };
    });
  }

  // ── Health ───────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; detail: string; models?: string[] }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
      if (!response.ok) {
        const error = await this.errorFrom(response);
        return { ok: false, detail: error.message };
      }
      const json = (await response.json()) as { models?: { name: string }[] };
      const models = (json.models ?? []).map((model) => model.name.replace(/^models\//, ''));
      return { ok: true, detail: `${models.length} models available`, models };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  // ── Realtime: tokens the phone can use ───────────────────────────────────

  /**
   * Mint a one-shot token for the phone. The real key never leaves this
   * machine; the phone gets a credential that dies after a single session.
   * `expireTime` must be 1 minute to 24 hours out.
   */
  async mintLiveToken(options: { minutes?: number; uses?: number } = {}): Promise<{
    token: string;
    expiresAt: number;
    model: string;
    wsUrl: string;
  }> {
    const minutes = Math.min(1440, Math.max(1, options.minutes ?? 30));
    const expireTime = new Date(Date.now() + minutes * 60_000).toISOString();

    // auth_tokens lives on v1alpha. Keep the version pinned here so a change in
    // the shared base URL can't silently break pairing.
    const authBase = 'https://generativelanguage.googleapis.com/v1alpha';
    const response = await fetch(`${authBase}/auth_tokens`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ uses: options.uses ?? 1, expireTime })
    });

    if (!response.ok) {
      throw await this.errorFrom(response);
    }

    const json = (await response.json()) as { name?: string };
    if (!json.name) throw new ProviderError('gemini', 'unknown', 'No token returned by Gemini.');
    return {
      token: json.name,
      expiresAt: Date.parse(expireTime),
      model: this.models.live[0]!,
      wsUrl: GEMINI_LIVE_WS
    };
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey
    };
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const guard = withTimeout(signal, timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: guard.signal
      });
      if (!response.ok) throw await this.errorFrom(response);
      return (await response.json()) as T;
    } finally {
      guard.cancel();
    }
  }

  private async errorFrom(response: Response): Promise<ProviderError> {
    let detail = '';
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
      detail = parsed.error?.message ?? text.slice(0, 300);
    } catch {
      /* body already consumed or not JSON */
    }
    return new ProviderError('gemini', classifyStatus(response.status), detail || response.statusText, response.status);
  }

  /** Walk the model list: newer names 404 on older accounts, and vice versa. */
  private async tryModels<T>(models: string[], run: (model: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const model of models) {
      try {
        return await run(model);
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError && (error.code === 'not-found' || error.code === 'bad-request')) {
          continue; // this account doesn't have that model — try the next
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError('gemini', 'not-found', 'None of the Gemini models were available.');
  }
}

// ── Conversions ─────────────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

const toGeminiContents = (messages: ChatMessage[]): GeminiContent[] => {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      // Gemini wants function responses in a user turn.
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.toolName ?? 'tool',
              response: { result: safeParse(message.content) }
            }
          }
        ]
      });
      continue;
    }

    const parts: GeminiPart[] = [];
    if (message.content.trim()) parts.push({ text: message.content });
    for (const image of message.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
    }
    if (!parts.length) continue;

    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
};

export const toFunctionDeclaration = (tool: RealtimeTool): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description,
  parameters: sanitizeSchema(tool.parameters)
});

/** Gemini rejects a few JSON-Schema keywords that OpenAI accepts. */
export const sanitizeSchema = (schema: unknown): Record<string, unknown> => {
  if (Array.isArray(schema)) return { anyOf: schema.map(sanitizeSchema) };
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const source = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'examples') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = sanitizeSchema(property);
      }
      output.properties = properties;
      continue;
    }
    if (key === 'items') {
      output.items = sanitizeSchema(value);
      continue;
    }
    if (key === 'enum') {
      output.enum = (value as unknown[]).map((entry) => String(entry));
      continue;
    }
    output[key] = value;
  }
  if (!output.type && output.properties) output.type = 'object';
  return output;
};

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Gemini's TTS returns raw little-endian PCM. Browsers want a container, so we
 * wrap it in a 44-byte WAV header. Default rate is 24 kHz mono 16-bit.
 */
export const wrapPcmAsWav = (pcm: Buffer, mimeType: string): Buffer => {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24_000);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (rate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
