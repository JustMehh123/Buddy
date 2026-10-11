import { ProviderError, type BuddyProvider, type ProviderId } from './types.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatibleProvider, PRESETS } from './openai-compatible.js';

export * from './types.js';
export { GeminiProvider, GEMINI_VOICES, GEMINI_MODELS, GEMINI_LIVE_WS } from './gemini.js';
export { OpenAICompatibleProvider, PRESETS } from './openai-compatible.js';

/**
 * Buddy's brain drawer.
 *
 * He works with whichever keys you happen to have. The registry decides who
 * does what, and — more importantly — retries the next provider when one is
 * rate limited or missing a model. Losing a free quota mid-sentence should
 * never be the thing that makes Buddy feel broken.
 *
 * Priority, unless you override it:
 *   voice sessions  Gemini (free) → OpenAI          → local pipeline
 *   seeing          Gemini (free) → OpenAI          → Groq
 *   hearing         on-device     → Groq (free)     → Gemini → OpenAI
 *   talking         on-device     → Gemini (free)   → OpenAI
 */

export interface ProviderKeys {
  gemini?: string;
  groq?: string;
  openai?: string;
  openrouter?: string;
  /** Any other OpenAI-shaped endpoint. */
  custom?: { baseUrl: string; apiKey?: string; chatModel?: string; visionModel?: string };
  ollamaUrl?: string;
  /** Skip the local Ollama server even if one is running. */
  disableOllama?: boolean;
}

export interface RegistryOptions {
  keys: ProviderKeys;
  /** Overrides from settings, so the user can force a model. */
  prefer?: Partial<Record<'chat' | 'vision' | 'stt' | 'tts' | 'live', string>>;
}

export type JobResult<T> = T & {
  /** Which provider actually answered. */
  provider: ProviderId;
};

export class ProviderRegistry {
  private readonly providers: BuddyProvider[];
  private readonly prefer: RegistryOptions['prefer'];
  private readonly notes: string[] = [];

  constructor(options: RegistryOptions) {
    const { keys } = options;
    this.prefer = options.prefer ?? {};
    this.providers = [];

    if (keys.gemini) {
      this.providers.push(
        new GeminiProvider({
          apiKey: keys.gemini,
          models: {
            chat: pick(this.prefer.chat, ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']),
            vision: pick(this.prefer.vision, ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']),
            live: pick(this.prefer.live, [
              'gemini-3.8-live',
              'gemini-3.1-flash-live-preview',
              'gemini-2.5-flash-native-audio-preview-12-2025'
            ]),
            tts: pick(this.prefer.tts, ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'])
          }
        })
      );
    }
    if (keys.groq) this.providers.push(new OpenAICompatibleProvider(PRESETS.groq(keys.groq)));
    if (keys.openai) this.providers.push(new OpenAICompatibleProvider(PRESETS.openai(keys.openai)));
    if (keys.openrouter) this.providers.push(new OpenAICompatibleProvider(PRESETS.openrouter(keys.openrouter)));
    if (keys.custom?.baseUrl) {
      this.providers.push(
        new OpenAICompatibleProvider({
          id: 'openai-compatible',
          label: 'Custom endpoint',
          apiKey: keys.custom.apiKey,
          baseUrl: keys.custom.baseUrl,
          models: {
            chat: [keys.custom.chatModel ?? 'gpt-4o-mini'],
            vision: [keys.custom.visionModel ?? keys.custom.chatModel ?? 'gpt-4o-mini']
          }
        })
      );
    }
    if (!keys.disableOllama && keys.ollamaUrl) {
      this.providers.push(new OpenAICompatibleProvider(PRESETS.ollama(keys.ollamaUrl)));
    }

    if (!this.providers.length) {
      this.notes.push(
        'No AI provider is configured. Add a free Gemini key (aistudio.google.com/apikey) or a free Groq key (console.groq.com/keys) to bring Buddy to life.'
      );
    }
  }

  get all(): BuddyProvider[] {
    return [...this.providers];
  }

  get isEmpty(): boolean {
    return this.providers.length === 0;
  }

  diagnostics(): string[] {
    return [...this.notes];
  }

  byId(id: ProviderId): BuddyProvider | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  /** Who can run a realtime voice session? */
  liveProvider(): BuddyProvider | undefined {
    return this.order(['gemini', 'openai']).find((provider) => provider.capabilities.live);
  }

  /** Who should answer questions about the screen? */
  visionProvider(): BuddyProvider | undefined {
    return this.order(['gemini', 'openai', 'groq', 'openai-compatible', 'ollama']).find(
      (provider) => provider.capabilities.vision
    );
  }

  transcribers(): BuddyProvider[] {
    return this.order(['groq', 'gemini', 'openai', 'openai-compatible']).filter(
      (provider) => provider.capabilities.stt
    );
  }

  speakers(): BuddyProvider[] {
    return this.order(['gemini', 'openai', 'groq']).filter((provider) => provider.capabilities.tts);
  }

  chatters(): BuddyProvider[] {
    return this.order(['gemini', 'groq', 'openai', 'openai-compatible', 'ollama']).filter(
      (provider) => provider.capabilities.chat
    );
  }

  /**
   * Run a job against the best provider available, falling through on the
   * errors that mean "not this one, try the next".
   */
  async run<T>(
    candidates: BuddyProvider[],
    job: (provider: BuddyProvider) => Promise<T>,
    options: { label?: string } = {}
  ): Promise<JobResult<T>> {
    const errors: string[] = [];
    for (const provider of candidates) {
      try {
        const value = await job(provider);
        return { provider: provider.id, ...(value as object) } as JobResult<T>;
      } catch (error) {
        if (error instanceof ProviderError) {
          errors.push(`${provider.id}: ${error.code} — ${error.message}`);
          if (error.retryable) continue;
        } else {
          errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const detail = errors.length ? errors.join('; ') : 'no providers configured';
    throw new ProviderError(
      'gemini',
      candidates.length ? 'unknown' : 'unsupported',
      `${options.label ?? 'That'} failed — ${detail}`
    );
  }

  /** Check every configured key, for the settings screen and `buddy doctor`. */
  async health(): Promise<{ id: ProviderId; label: string; ok: boolean; detail: string }[]> {
    return Promise.all(
      this.providers.map(async (provider) => {
        try {
          const result = await provider.healthCheck();
          return { id: provider.id, label: provider.label, ok: result.ok, detail: result.detail };
        } catch (error) {
          return {
            id: provider.id,
            label: provider.label,
            ok: false,
            detail: error instanceof Error ? error.message : 'unreachable'
          };
        }
      })
    );
  }

  /** Stable, predictable ordering. Local first when explicitly preferred. */
  private order(preference: ProviderId[]): BuddyProvider[] {
    const ranked = [...this.providers].sort((a, b) => {
      const indexA = preference.indexOf(a.id);
      const indexB = preference.indexOf(b.id);
      return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
    });
    return ranked;
  }
}

const pick = (preferred: string | undefined, fallback: string[]): string[] =>
  preferred ? [preferred, ...fallback.filter((model) => model !== preferred)] : fallback;
