import { Bonjour, type Service } from 'bonjour-service';
import type { HostIdentity } from '@buddy/protocol';
import type { Logger } from './util/logger.js';

/**
 * "Find my computer on this Wi-Fi."
 *
 * The reference implementation uses `_googly._tcp`; Buddy advertises
 * `_buddy._tcp` so the two coexist happily on one network. iOS Safari can't do
 * mDNS *browsing* from a web page, which is why the phone also gets a QR code,
 * a `.local` address and a manual entry field — but advertising means the
 * address stays correct even when your router hands out a new IP.
 */

export const SERVICE_TYPE = 'buddy';

export interface DiscoveryOptions {
  identity: HostIdentity;
  port: number;
  logger: Logger;
}

export class Discovery {
  private readonly bonjour: Bonjour;
  private service: Service | null = null;
  private readonly options: DiscoveryOptions;

  constructor(options: DiscoveryOptions) {
    this.options = options;
    this.bonjour = new Bonjour();
  }

  publish(): void {
    if (this.service) return;
    try {
      this.service = this.bonjour.publish({
        name: `${this.options.identity.name} (Buddy)`,
        type: SERVICE_TYPE,
        port: this.options.port,
        host: `${this.options.identity.hostname}.local`,
        txt: {
          version: String(this.options.identity.protocolVersion),
          id: this.options.identity.id,
          platform: this.options.identity.platform,
          url: `/`,
          app: 'Buddy'
        }
      });
      this.service.on?.('error', (error: Error) => {
        this.options.logger.warn(`discovery error: ${error.message}`);
      });
      this.options.logger.info(
        `advertising _${SERVICE_TYPE}._tcp on "${this.options.identity.hostname}.local" — phones on this Wi-Fi can find us`
      );
    } catch (error) {
      // mDNS is a nicety; the QR code and the address still work without it.
      this.options.logger.warn(
        `could not advertise over Bonjour (${error instanceof Error ? error.message : 'unknown'}) — use the QR code instead`
      );
    }
  }

  get advertised(): boolean {
    return this.service !== null;
  }

  stop(): void {
    try {
      this.service?.stop?.(() => undefined);
      this.bonjour.destroy();
    } catch {
      /* going away anyway */
    }
    this.service = null;
  }
}

/**
 * The best guess at the address a phone should use: the LAN address, not
 * loopback, and not a VPN or virtual adapter if we can tell.
 */
export const lanAddresses = (): string[] => {
  // Import lazily so bundlers used by the desktop shell don't trip on it.
  const { networkInterfaces } = require('node:os') as typeof import('node:os');
  const result: { address: string; name: string; score: number }[] = [];
  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      let score = 0;
      if (/^en\d|^eth\d|^wl/i.test(name)) score += 2;
      if (/^(utun|awdl|llw|bridge|docker|vbox|vmnet|tun|tap|wg)/i.test(name)) score -= 3;
      if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score += 1;
      result.push({ address: entry.address, name, score });
    }
  }
  return result
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((entry) => `${entry.address}`);
};

export const bestAddress = (): string => lanAddresses()[0] ?? '127.0.0.1';
