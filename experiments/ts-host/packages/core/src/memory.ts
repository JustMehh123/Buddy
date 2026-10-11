import type { Memory } from '@buddy/protocol';

/**
 * Buddy's memory. Deliberately boring and local: an array of little text
 * memories, saved as JSON next to the rest of his state on the host. No vector
 * database, no cloud, no embeddings — a keyword score and a recency nudge is
 * plenty for the hundreds of things you'd tell a small blue friend.
 */

export interface MemoryStorage {
  load(): Memory[];
  save(memories: Memory[]): void;
}

export class InMemoryStorage implements MemoryStorage {
  private memories: Memory[] = [];

  load(): Memory[] {
    return this.memories;
  }

  save(memories: Memory[]): void {
    this.memories = memories;
  }
}

export interface AddMemoryInput {
  text: string;
  kind?: Memory['kind'];
  tags?: string[];
  importance?: number;
  source?: Memory['source'];
}

export interface MemoryStoreOptions {
  storage: MemoryStorage;
  /** Keep at most this many; the lowest scoring get dropped. */
  limit?: number;
  /** Called whenever something changes, so the apps can re-render. */
  onChange?: (memories: Memory[]) => void;
  /** Injectable clock + id generator, for tests. */
  now?: () => number;
  idFactory?: () => string;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'they', 'we', 'my', 'your', 'his', 'her', 'their', 'me', 'him', 'them', 'about', 'as',
  'by', 'from', 'so', 'if', 'then', 'than', 'do', 'does', 'did', 'have', 'has', 'had', 'not',
  'no', 'yes', 'can', 'could', 'would', 'should', 'will', 'just', 'really', 'very', 'like'
]);

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

export const randomId = (prefix = 'mem'): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class MemoryStore {
  private memories: Memory[];
  private readonly limit: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onChange?: (memories: Memory[]) => void;

  constructor(options: MemoryStoreOptions) {
    this.memories = options.storage.load() ?? [];
    this.limit = options.limit ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomId());
    this.onChange = options.onChange;
    this.storage = options.storage;
  }

  private storage: MemoryStorage;

  get storageRef(): MemoryStorage {
    return this.storage;
  }

  all(): Memory[] {
    return [...this.memories];
  }

  get(id: string): Memory | undefined {
    return this.memories.find((memory) => memory.id === id);
  }

  /** Save a new memory, or merge into an existing near-duplicate. */
  add(input: AddMemoryInput): Memory {
    const text = input.text.trim().replace(/\s+/g, ' ');
    const existing = this.findDuplicate(text);
    if (existing) {
      const merged: Memory = {
        ...existing,
        text: text.length > existing.text.length ? text : existing.text,
        updatedAt: this.now(),
        importance: Math.max(existing.importance, input.importance ?? existing.importance),
        tags: [...new Set([...existing.tags, ...(input.tags ?? [])])]
      };
      this.replace(merged);
      return merged;
    }

    const memory: Memory = {
      id: this.idFactory(),
      createdAt: this.now(),
      updatedAt: this.now(),
      kind: input.kind ?? 'fact',
      text,
      tags: input.tags ?? tokenize(text).slice(0, 4),
      importance: clamp(input.importance ?? 0.5, 0, 1),
      source: input.source ?? 'voice'
    };
    this.memories.push(memory);
    this.prune();
    this.commit();
    return memory;
  }

  update(id: string, patch: Partial<Omit<Memory, 'id'>>): Memory | undefined {
    const memory = this.get(id);
    if (!memory) return undefined;
    const updated: Memory = { ...memory, ...patch, updatedAt: this.now() };
    this.replace(updated);
    return updated;
  }

  remove(id: string): boolean {
    const before = this.memories.length;
    this.memories = this.memories.filter((memory) => memory.id !== id);
    const changed = this.memories.length !== before;
    if (changed) this.commit();
    return changed;
  }

  /** "Forget the thing about my brother" → matches on text. */
  removeByText(query: string): Memory[] {
    const scored = this.search(query, { limit: 3, minScore: 1 });
    const removed = scored.filter((memory) => this.remove(memory.id));
    return removed;
  }

  clear(): void {
    this.memories = [];
    this.commit();
  }

  /** Keyword + importance + recency score. Good enough, and instant. */
  search(query: string, options: { limit?: number; minScore?: number } = {}): Memory[] {
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.01;
    const terms = tokenize(query);
    if (!terms.length) return this.recent(limit);

    const now = this.now();
    const scored = this.memories.map((memory) => {
      const haystack = `${memory.text} ${memory.tags.join(' ')} ${memory.kind}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += term.length >= 6 ? 1.6 : 1;
      }
      if (!score) return { memory, score: 0 };
      score *= 0.6 + memory.importance * 0.8;
      const ageDays = Math.max(0, (now - memory.createdAt) / 86_400_000);
      score *= 1 / (1 + Math.log1p(ageDays) * 0.15);
      return { memory, score };
    });

    return scored
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  recent(limit = 10): Memory[] {
    return [...this.memories]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** The handful of memories that get pasted into every session. */
  digest(limit = 12): Memory[] {
    const now = this.now();
    const ranked = [...this.memories].sort((a, b) => {
      const scoreA = a.importance * 2 + recency(now, a.updatedAt);
      const scoreB = b.importance * 2 + recency(now, b.updatedAt);
      return scoreB - scoreA;
    });
    return ranked.slice(0, limit);
  }

  stats(): { count: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const memory of this.memories) {
      byKind[memory.kind] = (byKind[memory.kind] ?? 0) + 1;
    }
    return { count: this.memories.length, byKind };
  }

  private findDuplicate(text: string): Memory | undefined {
    const normalized = text.toLowerCase();
    return this.memories.find((memory) => {
      const other = memory.text.toLowerCase();
      if (other === normalized) return true;
      // Cheap containment check for "he lives in Berlin" vs "Buddy lives in Berlin".
      if (other.length > 24 && normalized.length > 24) {
        if (other.includes(normalized) || normalized.includes(other)) return true;
        return jaccard(tokenize(other), tokenize(normalized)) > 0.72;
      }
      return false;
    });
  }

  private replace(memory: Memory): void {
    this.memories = this.memories.map((existing) =>
      existing.id === memory.id ? memory : existing
    );
    this.commit();
  }

  private prune(): void {
    if (this.memories.length <= this.limit) return;
    const now = this.now();
    this.memories = [...this.memories]
      .sort((a, b) => b.importance * 2 + recency(now, b.updatedAt) - (a.importance * 2 + recency(now, a.updatedAt)))
      .slice(0, this.limit);
  }

  private commit(): void {
    this.storage.save(this.memories);
    this.onChange?.(this.all());
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const recency = (now: number, at: number): number => {
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return 1 / (1 + ageDays / 14);
};

export const jaccard = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
};
