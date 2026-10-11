#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderRegistry } from './providers/index.js';
import { createComputer } from './computer/index.js';
import { BuddyHost } from './host.js';
import { BuddyServer, mobileDirFromModule, webDirFromModule } from './server.js';
import { Discovery, SERVICE_TYPE, bestAddress, lanAddresses } from './discovery.js';
import { Logger } from './util/logger.js';
import { BUDDY_VERSION, ensureStateDir, loadConfig, logFile, readJson, stateDir, writeJson } from './config.js';

/**
 * `buddy` — starting the computer half of Buddy.
 *
 * One process that: loads your keys, finds a body to drive, pairs a phone,
 * serves the phone app, and answers its sockets. Everything it can't do, it
 * says out loud instead of pretending.
 */

loadEnv({ path: join(process.cwd(), '.env'), quiet: true });
loadEnv({
  path: join(fileURLToPath(new URL('../../../.env', import.meta.url))),
  quiet: true
});

interface KeysFile {
  gemini?: string;
  groq?: string;
  openai?: string;
  openrouter?: string;
  ollamaUrl?: string;
}

const banner = (lines: string[]): void => {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  console.log(`\n\u001b[35m╭${'─'.repeat(width)}╮\u001b[0m`);
  for (const line of lines) {
    console.log(`\u001b[35m│\u001b[0m  ${line.padEnd(width - 2)}  \u001b[35m│\u001b[0m`);
  }
  console.log(`\u001b[35m╰${'─'.repeat(width)}╯\u001b[0m\n`);
};

const parseArgs = (argv: string[]): { command: string; flags: Set<string>; values: Map<string, string> } => {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let command = 'serve';
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value !== undefined) values.set(key!, value);
      else flags.add(key!);
    } else if (!arg.startsWith('-')) {
      command = arg;
    } else {
      flags.add(arg.replace(/^-+/, ''));
    }
  }
  return { command, flags, values };
};

/** Keys can come from the environment or from a private file next to the state. */
const loadKeys = (): {
  keys: ConstructorParameters<typeof ProviderRegistry>[0]['keys'];
  sources: Record<string, string>;
} => {
  const keysFile = join(stateDir, 'keys.json');
  const stored = readJson<KeysFile>(keysFile, {});
  const sources: Record<string, string> = {};

  const pick = (name: keyof KeysFile, env: string[]): string | undefined => {
    for (const variable of env) {
      const value = process.env[variable]?.trim();
      if (value) {
        sources[name as string] = variable;
        return value;
      }
    }
    const fromFile = stored[name];
    if (fromFile) {
      sources[name as string] = 'keys.json';
      return fromFile;
    }
    return undefined;
  };

  const gemini = pick('gemini', ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']);
  const groq = pick('groq', ['GROQ_API_KEY']);
  const openai = pick('openai', ['OPENAI_API_KEY']);
  const openrouter = pick('openrouter', ['OPENROUTER_API_KEY']);
  const ollamaUrl = process.env.OLLAMA_URL ?? stored.ollamaUrl ?? undefined;

  return {
    keys: {
      gemini,
      groq,
      openai,
      openrouter,
      ollamaUrl,
      // Only talk to a local Ollama if something is actually listening there.
      disableOllama: process.env.BUDDY_NO_OLLAMA === '1'
    },
    sources
  };
};

const main = async (): Promise<void> => {
  const { command, flags, values } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  ensureStateDir();

  const logger = new Logger({
    file: logFile,
    level: (flags.has('verbose') ? 'debug' : undefined) as never,
    silent: flags.has('quiet')
  });

  const { keys, sources } = loadKeys();
  const configured = Object.keys(sources);
  const registry = new ProviderRegistry({ keys });

  if (command === 'doctor' || command === 'keys' || command === 'pair' || command === 'version') {
    return runUtility(command, { registry, logger, flags, values: values as Map<string, string> });
  }

  const simulateFlag = flags.has('simulate') ? true : config.simulate;
  const computer = await createComputer({
    simulate: simulateFlag,
    rebuild: flags.has('rebuild'),
    verbose: flags.has('verbose')
  });

  const host = new BuddyHost({ registry, computer, logger, config });
  await host.init();

  const server = new BuddyServer({
    host,
    logger,
    port: Number(values.get('port') ?? config.port),
    webDir: webDirFromModule(),
    mobileDir: mobileDirFromModule()
  });
  const port = await server.listen();

  const discovery = new Discovery({ identity: host.identity, port, logger });
  discovery.publish();

  const addresses = lanAddresses();
  const address = bestAddress();
  const url = `http://${host.identity.hostname}.local:${port}/`;

  banner([
    `Buddy ${BUDDY_VERSION} — awake on ${host.identity.name}`,
    '',
    `Phone:    ${url}`,
    `          http://${address}:${port}/`,
    addresses.length > 1 ? `          (other addresses: ${addresses.slice(1).join(', ')})` : '',
    `Pairing:  http://${address}:${port}/pair`,
    '',
    `Brain:    ${configured.length ? configured.join(', ') : 'none yet — see below'}`,
    `Voice:    ${registry.liveProvider()?.label ?? 'local voice mode (on-device)'}`,
    `Body:     ${computer.note}`,
    `Keys:     ${configured.length ? configured.map((key) => `${key} from ${sources[key]}`).join(', ') : 'no keys found'}`
  ]);

  if (!configured.length) {
    console.log(
      [
        "Buddy has no AI key yet, so he can't think or speak. He is still here, and the phone app still works.",
        '',
        '  Free, no credit card, about two minutes:',
        '    1. Go to https://aistudio.google.com/apikey and make a key (this one does voice AND eyes)',
        '    2. Or https://console.groq.com/keys for a very fast free Whisper (voice in)',
        '    3. Then either:',
        '         export GEMINI_API_KEY=...           and restart, or',
        `         put {"gemini":"..."} in ${join(stateDir, 'keys.json')}`,
        '',
        'Nothing else is required. Buddy never sends your key to the phone.'
      ].join('\n')
    );
  }

  if (config.openBrowser && !flags.has('no-open')) {
    const { spawn } = await import('node:child_process');
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    } catch {
      /* the user can click the link */
    }
  }

  const shutdown = async (signal: string) => {
    logger.info(`${signal} — putting Buddy to sleep`);
    host.emit('toast', { text: 'Buddy is going to sleep.', kind: 'warn' });
    discovery.stop();
    await server.close();
    host.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));
  process.on('uncaughtException', (error) => logger.error('uncaught exception', error));

  if (flags.has('pair')) {
    const challenge = host.startPairing(`${hostname()}'s phone`);
    logger.info(`pairing code ${challenge.code} — open ${address}:${port}/pair`);
  }
};

const runUtility = async (
  command: string,
  context: {
    registry: ProviderRegistry;
    logger: Logger;
    flags: Set<string>;
    values: Map<string, string>;
  }
): Promise<void> => {
  const { registry, logger } = context;

  if (command === 'version') {
    console.log(`Buddy ${BUDDY_VERSION}`);
    return;
  }

  if (command === 'keys' || command === 'doctor') {
    const health = await registry.health();
    console.log('\nBuddy — what he can do with the keys you gave him\n');
    if (!health.length) {
      console.log('  (no providers configured)\n');
    }
    for (const entry of health) {
      const mark = entry.ok ? '\u001b[32mok  \u001b[0m' : '\u001b[31mfail\u001b[0m';
      console.log(`  ${mark} ${entry.label.padEnd(28)} ${entry.detail}`);
    }
    const jobs: [string, string][] = [
      ['voice sessions', registry.liveProvider()?.label ?? 'none — local voice mode only'],
      ['seeing (vision)', registry.visionProvider()?.label ?? 'none'],
      ['hearing (speech→text)', registry.transcribers().map((provider) => provider.label).join(', ') || 'none'],
      ['talking (text→speech)', registry.speakers().map((provider) => provider.label).join(', ') || 'on-device only']
    ];
    console.log('\n  Who does what:');
    for (const [job, who] of jobs) console.log(`    ${job.padEnd(24)} ${who}`);
    console.log('');
    return;
  }

  if (command === 'pair') {
    const identity = readJson<{ name?: string }>(join(stateDir, 'identity.json'), {});
    console.log(`\nBuddy on ${identity.name ?? hostname()} — start the host (npm start) and open /pair on the phone.\n`);
  }
};

main().catch((error) => {
  console.error('\nBuddy could not start:', error instanceof Error ? error.message : error);
  if (process.env.BUDDY_DEBUG) console.error(error);
  process.exitCode = 1;
});

export { SERVICE_TYPE, existsSync, readFileSync, writeJson };
