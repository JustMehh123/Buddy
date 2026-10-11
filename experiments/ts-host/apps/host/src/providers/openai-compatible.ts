import {
  ProviderError,
  classifyStatus,
  withTimeout,
  type BuddyProvider,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ProviderId,
  type SpeakRequest,
  type SpeakResult,
  type TranscribeRequest,
  type TranscribeResult
} from './types.js';

/**
 * Anything that speaks the OpenAI HTTP shape.
 *
 * That happens to be almost everyone: OpenAI itself, Groq's free tier, a local
 * Ollama server, OpenRouter, LiteLLM, vLLM, LM Studio. One implementation,
 * four presets, and a `baseUrl` for everything else.
 */

export interface OpenAICompatibleOptions {
  id: ProviderId;
  label: string;
  apiKey?: string;
  baseUrl: string;
  models: {
    chat: string[];
    vision: string[];
    stt?: string[];
    tts?: string[];
  };
  /** Bearer token is wrong for local servers; use the dummy key Ollama wants. */
  sendApiKey?: boolean;
  extraHeaders?: Record<string, string>;
}

export const PRESETS = {
  openai: (apiKey: string): OpenAICompatibleOptions => ({
    id: 'openai',
    label: 'OpenAI',
    apiKey,
    baseUrl: 'https://api.openai.com/v1',
    models: {
      chat: ['gpt-4o', 'gpt-4o-mini'],
      vision: ['gpt-4o', 'gpt-4o-mini'],
      stt: ['gpt-4o-transcribe', 'whisper-1'],
      tts: ['gpt-4o-mini-tts', 'tts-1']
    }
  }),

  /** Free tier, no credit card: console.groq.com/keys */
  groq: (apiKey: string): OpenAICompatibleOptions => ({
    id: 'groq',
    label: 'Groq (free tier)',
    apiKey,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: {
      chat: [
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-120b',
        'moonshotai/kimi-k2-instruct',
        'llama-3.3-70b-versatile'
      ],
      vision: ['llama-3.2-90b-vision-preview', 'llama-3.2-11b-vision-preview'],
      // 2,000 free transcription requests a day, ~28,800 audio seconds.
      stt: ['whisper-large-v3-turbo', 'whisper-large-v3'],
      tts: ['playai-tts']
    }
  }),

  /** A local model. Truly unlimited, no key, nothing leaves your machine. */
  ollama: (baseUrl = 'http://127.0.0.1:11434/v1'): OpenAICompatibleOptions => ({
    id: 'ollama',
    label: 'Ollama (local, unlimited)',
    baseUrl,
    sendApiKey: false,
    models: {
      chat: ['llama3.2', 'qwen3', 'gemma3', 'mistral'],
      vision: ['llava', 'llama3.2-vision', 'qwen2.5vl', 'gemma3']
    }
  }),

  openrouter: (apiKey: string): OpenAICompatibleOptions => ({
    id: 'openai-compatible',
    label: 'OpenRouter',
    apiKey,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      chat: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free'],
      vision: ['meta-llama/llama-3.2-11b-vision-instruct:free']
    }
  })
} as const;

export class OpenAICompatibleProvider implements BuddyProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly models: BuddyProvider['models'];
  readonly capabilities;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly sendApiKey: boolean;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.sendApiKey = options.sendApiKey ?? true;
    this.extraHeaders = options.extraHeaders ?? {};
    this.models = {
      chat: options.models.chat,
      vision: options.models.vision,
      stt: options.models.stt ?? [],
      tts: options.models.tts ?? [],
      live: []
    };
    this.capabilities = {
      chat: true,
      vision: this.models.vision.length > 0,
      stt: this.models.stt.length > 0,
      tts: this.models.tts.length > 0,
      live: false,
      tools: true
    };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const wantsVision = request.messages.some((message) => message.images?.length);
    const candidates = request.model
      ? [request.model]
      : wantsVision && this.models.vision.length
        ? this.models.vision
        : this.models.chat;

    return this.tryModels(candidates, async (model) => {
      const body: Record<string, unknown> = {
        model,
        messages: toOpenAIMessages(request.messages),
        temperature: request.temperature ?? 0.8,
        max_tokens: request.maxTokens ?? 1024,
        ...(request.json ? { response_format: { type: 'json_object' } } : {})
      };
      if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        }));
        body.tool_choice = 'auto';
      }

      const response = await this.post('/chat/completions', body, request.signal);
      const choice = response.choices?.[0];
      const toolCalls = (choice?.message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `${this.id}_${index}`,
        name: call.function?.name ?? '',
        args: safeParse(call.function?.arguments)
      }));

      return {
        text: (choice?.message?.content ?? '').trim(),
        toolCalls: toolCalls.filter((call) => call.name),
        model,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens
        }
      };
    });
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    const model = request.model ?? this.models.chat[0]!;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(request.messages),
        temperature: request.temperature ?? 0.8,
        max_tokens: request.maxTokens ?? 1024,
        stream: true
      }),
      signal: request.signal
    });
    if (!response.ok || !response.body) throw await this.errorFrom(response);

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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {
          /* keep going */
        }
      }
    }
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.models.stt.length) {
      throw new ProviderError(this.id, 'unsupported', `${this.label} cannot transcribe audio.`);
    }
    return this.tryModels(this.models.stt, async (model) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(request.audio)], { type: request.mimeType }), fileNameFor(request.mimeType));
      form.append('model', model);
      if (request.language) form.append('language', request.language);
      if (request.prompt) form.append('prompt', request.prompt.slice(0, 400));
      form.append('response_format', 'json');

      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        // Note: no content-type — fetch sets the multipart boundary.
        headers: this.apiKey && this.sendApiKey ? { authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders } : { ...this.extraHeaders },
        body: form,
        signal: request.signal
      });
      if (!response.ok) throw await this.errorFrom(response);
      const json = (await response.json()) as { text?: string; language?: string };
      return { text: (json.text ?? '').trim(), language: json.language, model };
    });
  }

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    if (!this.models.tts.length) {
      throw new ProviderError(this.id, 'unsupported', `${this.label} cannot speak.`);
    }
    return this.tryModels(this.models.tts, async (model) => {
      const isGroq = this.id === 'groq';
      const body: Record<string, unknown> = isGroq
        ? {
            model,
            input: request.text,
            voice: request.voice ?? 'Fritz-PlayAI',
            response_format: 'wav'
          }
        : {
            model,
            input: request.text,
            voice: request.voice ?? 'alloy',
            response_format: request.format ?? 'mp3',
            ...(request.speed ? { speed: Math.min(4, Math.max(0.25, request.speed)) } : {})
          };

      const response = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal
      });
      if (!response.ok) throw await this.errorFrom(response);
      const buffer = Buffer.from(await response.arrayBuffer());
      const format = isGroq ? 'wav' : (request.format ?? 'mp3');
      return {
        audio: buffer,
        mimeType: format === 'wav' ? 'audio/wav' : format === 'pcm' ? 'audio/pcm' : 'audio/mpeg',
        model
      };
    });
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string; models?: string[] }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
      if (!response.ok) {
        const error = await this.errorFrom(response);
        return { ok: false, detail: error.message };
      }
      const json = (await response.json()) as { data?: { id: string }[] };
      const models = (json.data ?? []).map((entry) => entry.id);
      return { ok: true, detail: `${models.length} models available`, models };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'unreachable'
      };
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.extraHeaders
    };
    if (this.apiKey && this.sendApiKey) headers.authorization = `Bearer ${this.apiKey}`;
    else if (this.sendApiKey) headers.authorization = 'Bearer not-needed';
    return headers;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<OpenAIChatResponse> {
    const guard = withTimeout(signal, 60_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: guard.signal
      });
      if (!response.ok) throw await this.errorFrom(response);
      return (await response.json()) as OpenAIChatResponse;
    } finally {
      guard.cancel();
    }
  }

  private async errorFrom(response: Response): Promise<ProviderError> {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        detail =
          typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? text.slice(0, 300));
      } catch {
        detail = text.slice(0, 300);
      }
    } catch {
      /* nothing readable */
    }
    return new ProviderError(this.id, classifyStatus(response.status), detail || response.statusText, response.status);
  }

  private async tryModels<T>(models: string[], run: (model: string) => Promise<T>): Promise<T> {
    if (!models.length) throw new ProviderError(this.id, 'unsupported', `${this.label} has no models configured.`);
    let lastError: unknown;
    for (const model of models) {
      try {
        return await run(model);
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError && error.code === 'not-found') continue;
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError(this.id, 'not-found', `${this.label} has no usable models.`);
  }
}

interface OpenAIChatResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const toOpenAIMessages = (messages: ChatMessage[]): Record<string, unknown>[] =>
  messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? 'call',
        content: message.content
      };
    }

    if (message.images?.length) {
      return {
        role: message.role,
        content: [
          ...(message.content.trim() ? [{ type: 'text', text: message.content }] : []),
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` }
          }))
        ]
      };
    }

    if (message.toolCalls?.length) {
      return {
        role: message.role,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        }))
      };
    }

    return { role: message.role, content: message.content };
  });

const safeParse = (text: string | undefined): Record<string, unknown> => {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const fileNameFor = (mimeType: string): string => {
  if (mimeType.includes('wav')) return 'audio.wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.m4a';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('webm')) return 'audio.webm';
  return 'audio.wav';
};
