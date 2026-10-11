import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, arch as osArch, hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type BuddySettings, type HostIdentity } from '@buddy/protocol';

/**
 * Everything the host needs to know about itself and the world around it:
 * where its state lives, what the user has configured, and what this machine
 * is actually capable of.
 */

export const BUDDY_VERSION = '0.1.0';

export const stateDir = ((): string => {
  if (process.env.BUDDY_STATE_DIR) return process.env.BUDDY_STATE_DIR;
  const home = homedir();
  switch (osPlatform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Buddy');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Buddy');
    default:
      return join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'buddy');
  }
})();

export const ensureStateDir = (): string => {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  return stateDir;
};

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

export const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
};

export interface RuntimeConfig {
  port: number;
  apiKey: string | null;
  apiBase: string;
  realtimeModel: string;
  textModel: string;
  visionModel: string;
  voice: string;
  simulate: boolean;
  allowComputerUseEnv: boolean;
  openBrowser: boolean;
}

export const loadConfig = (): RuntimeConfig => ({
  port: Number(process.env.BUDDY_PORT ?? 7777),
  apiKey: process.env.OPENAI_API_KEY?.trim() || null,
  apiBase: (process.env.BUDDY_API_BASE ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
  realtimeModel: process.env.BUDDY_REALTIME_MODEL ?? DEFAULT_SETTINGS.realtimeModel,
  textModel: process.env.BUDDY_TEXT_MODEL ?? DEFAULT_SETTINGS.textModel,
  visionModel: process.env.BUDDY_VISION_MODEL ?? DEFAULT_SETTINGS.visionModel,
  voice: process.env.BUDDY_VOICE ?? DEFAULT_SETTINGS.voice,
  simulate: process.env.BUDDY_SIMULATE === '1',
  allowComputerUseEnv: process.env.BUDDY_ALLOW_COMPUTER_USE !== '0',
  openBrowser: process.env.BUDDY_OPEN_BROWSER !== '0'
});

const titleCase = (value: string): string =>
  value.replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

/** A friendly name for this computer, e.g. "Riley's MacBook Pro". */
export const computerName = (): string => {
  const raw = osHostname().replace(/\.local$/i, '');
  const pretty = titleCase(raw);
  if (osPlatform() === 'darwin') return pretty;
  return pretty;
};

export const makeHostname = (): string => {
  const base = osHostname()
    .replace(/\.local$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  return `${base || 'buddy-host'}`;
};

export interface StoredState {
  identity: HostIdentity;
  settings: BuddySettings;
  memories: import('@buddy/protocol').Memory[];
  devices: import('@buddy/protocol').PairedDevice[];
  pairingEnabled: boolean;
  stats: { sessions: number; actions: number; lastSeenAt: number | null };
}

export const identityFile = join(stateDir, 'identity.json');
export const settingsFile = join(stateDir, 'settings.json');
export const memoryFile = join(stateDir, 'memories.json');
export const devicesFile = join(stateDir, 'devices.json');
export const logFile = join(stateDir, 'buddy.log');
export const statsFile = join(stateDir, 'stats.json');

export const loadIdentity = (): HostIdentity => {
  const existing = readJson<HostIdentity | null>(identityFile, null);
  if (existing?.id) return existing;
  const identity: HostIdentity = {
    id: `host_${randomBytes(8).toString('hex')}`,
    name: computerName(),
    hostname: makeHostname(),
    platform:
      osPlatform() === 'darwin'
        ? 'darwin'
        : osPlatform() === 'win32'
          ? 'win32'
          : 'linux',
    arch: osArch(),
    capabilities: ['screen', 'pointer', 'mouse', 'keyboard', 'apps', 'clipboard'],
    appVersion: BUDDY_VERSION,
    protocolVersion: PROTOCOL_VERSION
  };
  writeJson(identityFile, identity);
  return identity;
};

export const loadSettings = (config: RuntimeConfig): BuddySettings => {
  const stored = readJson<Partial<BuddySettings>>(settingsFile, {});
  return {
    ...DEFAULT_SETTINGS,
    voice: config.voice,
    realtimeModel: config.realtimeModel,
    textModel: config.textModel,
    visionModel: config.visionModel,
    computerUse: config.allowComputerUseEnv ? (stored.computerUse ?? true) : false,
    ...stored,
    overlay: { ...DEFAULT_SETTINGS.overlay, ...(stored.overlay ?? {}) }
  };
};

export const saveSettings = (settings: BuddySettings): void => writeJson(settingsFile, settings);
