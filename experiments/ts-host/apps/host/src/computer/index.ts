import { platform } from 'node:os';
import type { Capability } from '@buddy/protocol';
import type { ComputerController } from './types.js';
import { SimulatedComputer } from './simulate.js';

export * from './types.js';
export { SimulatedComputer } from './simulate.js';

/**
 * Picking Buddy a body.
 *
 * Real control when the machine can actually do it, simulate mode otherwise —
 * so a headless server, a locked-down work laptop or a CI runner still gives
 * you a Buddy you can talk to, and he tells the truth about what he can't do.
 */

export interface CreateComputerOptions {
  /** Force simulate mode. */
  simulate?: boolean;
  /** Recompile any native helper. */
  rebuild?: boolean;
  verbose?: boolean;
}

export interface ComputerHandle {
  computer: ComputerController;
  simulated: boolean;
  /** Why we're simulating, for the startup banner and the phone. */
  note: string;
  /** Platform permission status, where the platform has any. */
  permissions?: () => Record<string, boolean | null>;
}

export const createComputer = async (options: CreateComputerOptions = {}): Promise<ComputerHandle> => {
  if (options.simulate) {
    return {
      computer: new SimulatedComputer(),
      simulated: true,
      note: 'Simulate mode is on: Buddy can look at a pretend desktop and point at pretend windows.'
    };
  }

  switch (platform()) {
    case 'darwin': {
      const { DarwinComputer } = await import('./darwin.js');
      const darwin = new DarwinComputer({ rebuild: options.rebuild, verbose: options.verbose });
      return {
        computer: darwin,
        simulated: false,
        note: 'macOS: Buddy can see your screen and, once you allow Accessibility, use your mouse and keyboard.',
        permissions: () => {
          const status = darwin.permissionSnapshot;
          return { accessibility: status?.accessibility ?? false, postEvents: status?.postEvents ?? false };
        }
      };
    }
    case 'win32': {
      const { WindowsComputer } = await import('./win32.js');
      return {
        computer: new WindowsComputer(),
        simulated: false,
        note: 'Windows: Buddy can see your screen and drive the mouse and keyboard.'
      };
    }
    case 'linux': {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        return {
          computer: new SimulatedComputer(),
          simulated: true,
          note: 'No display detected, so Buddy is running in simulate mode. He can still talk and point at a pretend screen.'
        };
      }
      const { LinuxComputer } = await import('./linux.js');
      return {
        computer: new LinuxComputer(),
        simulated: false,
        note: 'Linux: Buddy needs xdotool, xclip and ImageMagick for full control.'
      };
    }
    default:
      return {
        computer: new SimulatedComputer(),
        simulated: true,
        note: `Buddy doesn't know how to drive ${platform()} yet, so he is in simulate mode.`
      };
  }
};

/**
 * What the host is willing to advertise. Anything the platform didn't list, and
 * anything the user switched off, disappears from the phone's settings too.
 */
export const effectiveCapabilities = (
  computer: ComputerController,
  settings: { computerUse: boolean; allowTyping: boolean; allowClicking: boolean; allowShortcuts: boolean }
): Capability[] => {
  const base = new Set<Capability>(computer.supported);
  if (!settings.computerUse) {
    base.delete('mouse');
    base.delete('keyboard');
    base.delete('apps');
    base.delete('shortcuts');
  }
  if (!settings.allowTyping) base.delete('keyboard');
  if (!settings.allowClicking) base.delete('mouse');
  if (!settings.allowShortcuts) base.delete('shortcuts');
  return [...base];
};
