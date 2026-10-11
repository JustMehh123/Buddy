import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Capability, DisplayInfo } from '@buddy/protocol';
import { ComputerError, type CaptureResult, type ComputerController, type Point } from './types.js';
import { readPngSize } from './darwin.js';

const run = promisify(execFile);

/**
 * Windows.
 *
 * Everything goes through PowerShell, which is present on every supported
 * Windows, with a small inline C# block for the user32 calls. Screenshots come
 * from System.Drawing, input from SendInput/keybd_event, and text is typed by
 * putting it on the clipboard and pressing Ctrl+V — the same trick every
 * serious Windows automation tool uses, because it survives emoji, quotes and
 * non-ASCII characters that SendKeys mangles.
 *
 * Written carefully but verified less than the macOS path: if something here
 * needs a nudge on your machine, `buddy doctor` will say which bit.
 */

const POWERSHELL = 'powershell.exe';

const prelude = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BuddyNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static void Key(byte vk, bool up) { keybd_event(vk, 0, up ? KEYEVENTF_KEYUP : 0, IntPtr.Zero); }
}
"@
`;

export class WindowsComputer implements ComputerController {
  readonly kind = 'win32' as const;
  readonly supported: Capability[] = [
    'screen',
    'pointer',
    'mouse',
    'keyboard',
    'apps',
    'clipboard'
  ];

  private cachedDisplays: DisplayInfo[] | null = null;

  describe(): string {
    return 'Windows (PowerShell + user32)';
  }

  async displays(): Promise<DisplayInfo[]> {
    if (this.cachedDisplays) return this.cachedDisplays;
    const script = `${prelude}
$i = 0
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $i++
  [pscustomobject]@{
    id = $i
    label = $_.DeviceName
    bounds = @{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
    workArea = @{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height }
    scaleFactor = 1
    primary = $_.Primary
  }
} | ConvertTo-Json -Compress -AsArray`;
    try {
      const raw = await this.powershell<DisplayInfo[]>(script);
      this.cachedDisplays = raw.map((display, index) => ({
        id: display.id ?? index + 1,
        label: display.label ?? `Display ${index + 1}`,
        bounds: display.bounds,
        workArea: display.workArea ?? display.bounds,
        scaleFactor: display.scaleFactor ?? 1,
        primary: Boolean(display.primary)
      }));
      return this.cachedDisplays;
    } catch {
      return [
        {
          id: 1,
          label: 'Main display',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          scaleFactor: 1,
          primary: true
        }
      ];
    }
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const displays = await this.displays();
    const primary = displays.find((display) => display.primary) ?? displays[0]!;
    return { width: primary.bounds.width, height: primary.bounds.height };
  }

  async mousePosition(): Promise<Point | null> {
    try {
      const script = `${prelude}
$p = [System.Windows.Forms.Cursor]::Position
Write-Output "$($p.X),$($p.Y)"`;
      const output = await this.powershell<string>(script, true);
      const [x, y] = output.trim().split(',').map(Number);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null;
    } catch {
      return null;
    }
  }

  async activeWindow(): Promise<{ app: string; title: string } | null> {
    const script = `${prelude}
$h = [BuddyNative]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][BuddyNative]::GetWindowText($h, $sb, 512)
$pid = 0
[void][BuddyNative]::GetWindowThreadProcessId($h, [ref]$pid)
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
[pscustomobject]@{ app = $(if ($proc) { $proc.ProcessName } else { 'Unknown' }); title = $sb.ToString() } | ConvertTo-Json -Compress`;
    try {
      return await this.powershell<{ app: string; title: string }>(script);
    } catch {
      return null;
    }
  }

  async runningApps(): Promise<string[]> {
    const script = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique | ConvertTo-Json -Compress -AsArray`;
    try {
      return await this.powershell<string[]>(script);
    } catch {
      return [];
    }
  }

  async capture(options: {
    region: 'full' | 'window' | 'cursor';
    cursorPoint?: Point | null;
    maxWidth?: number;
    displayId?: number;
  }): Promise<CaptureResult> {
    const maxWidth = options.maxWidth ?? 1440;
    const displays = await this.displays();
    const display =
      displays.find((entry) => entry.id === options.displayId) ??
      displays.find((entry) => entry.primary) ??
      displays[0]!;

    let rect = { ...display.bounds };
    if (options.region === 'cursor') {
      const cursor = options.cursorPoint ?? (await this.mousePosition()) ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const width = Math.min(rect.width, 1100);
      const height = Math.min(rect.height, 720);
      rect = {
        x: Math.max(display.bounds.x, Math.min(display.bounds.x + display.bounds.width - width, cursor.x - width / 2)),
        y: Math.max(display.bounds.y, Math.min(display.bounds.y + display.bounds.height - height, cursor.y - height / 2)),
        width,
        height
      };
    }

    const target = join(tmpdir(), `buddy-shot-${Date.now()}.png`);
    const scale = Math.min(1, maxWidth / (rect.width * display.scaleFactor));
    const script = `${prelude}
$rect = New-Object System.Drawing.Rectangle ${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.width)}, ${Math.round(rect.height)}
$bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
$g.Dispose()
$outW = [int]($rect.Width * ${scale})
$outH = [int]($rect.Height * ${scale})
if ($outW -lt $rect.Width) {
  $scaled = New-Object System.Drawing.Bitmap $outW, $outH
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.InterpolationMode = 'HighQualityBicubic'
  $sg.DrawImage($bmp, 0, 0, $outW, $outH)
  $sg.Dispose()
  $bmp.Dispose()
  $bmp = $scaled
}
$bmp.Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "ok"`;
    try {
      await this.powershell<string>(script, true);
    } catch (error) {
      throw new ComputerError(
        `Screen capture failed on Windows: ${error instanceof Error ? error.message : 'unknown'}`,
        'failed'
      );
    }
    if (!existsSync(target)) throw new ComputerError('Screen capture produced no file.', 'failed');

    const png = readFileSync(target);
    const size = readPngSize(png);
    return {
      png,
      width: size.width,
      height: size.height,
      origin: { x: rect.x, y: rect.y },
      screenWidth: display.bounds.width,
      screenHeight: display.bounds.height,
      displayId: display.id,
      label: display.label
    };
  }

  async moveMouse(point: Point): Promise<void> {
    await this.powershell(
      `${prelude}[BuddyNative]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)}) | Out-Null; Write-Output ok`,
      true
    );
  }

  async click(point: Point, options: { double?: boolean; button?: 'left' | 'right' } = {}): Promise<void> {
    const down = options.button === 'right' ? 'MOUSEEVENTF_RIGHTDOWN' : 'MOUSEEVENTF_LEFTDOWN';
    const up = options.button === 'right' ? 'MOUSEEVENTF_RIGHTUP' : 'MOUSEEVENTF_LEFTUP';
    const clicks = options.double ? 2 : 1;
    const script = `${prelude}
[BuddyNative]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)}) | Out-Null
Start-Sleep -Milliseconds 40
1..${clicks} | ForEach-Object {
  [BuddyNative]::mouse_event([BuddyNative]::${down}, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 25
  [BuddyNative]::mouse_event([BuddyNative]::${up}, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}
Write-Output ok`;
    await this.powershell(script, true);
  }

  async typeText(text: string): Promise<void> {
    // Clipboard paste: robust for any characters, and instant for long text.
    const script = `${prelude}
Set-Clipboard -Value ${psString(text)}
Start-Sleep -Milliseconds 60
[BuddyNative]::Key(0x11, $false)   # Ctrl
[BuddyNative]::Key(0x56, $false)   # V
[BuddyNative]::Key(0x56, $true)
[BuddyNative]::Key(0x11, $true)
Write-Output ok`;
    await this.powershell(script, true);
  }

  async pressKeys(press: { keys: string; repeat?: number }): Promise<void> {
    const combos = parseCombo(press.keys);
    const times = Math.max(1, Math.min(50, press.repeat ?? 1));
    const send = combos
      .map(
        (combo) => `1..${times} | ForEach-Object {
  ${combo.mods.map((mod) => `[BuddyNative]::Key(0x${mod.toString(16)}, $false)`).join('\n  ')}
  [BuddyNative]::Key(0x${combo.key.toString(16)}, $false)
  [BuddyNative]::Key(0x${combo.key.toString(16)}, $true)
  ${[...combo.mods].reverse().map((mod) => `[BuddyNative]::Key(0x${mod.toString(16)}, $true)`).join('\n  ')}
  Start-Sleep -Milliseconds 40
}`
      )
      .join('\n');
    await this.powershell(`${prelude}${send}\nWrite-Output ok`, true);
  }

  async openApp(name: string): Promise<{ ok: boolean; message: string }> {
    const script = `
$name = ${psString(name)}
$paths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
)
$shortcut = Get-ChildItem -Path $paths -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName -like "*$name*" } | Select-Object -First 1
if ($shortcut) { Start-Process -FilePath $shortcut.FullName; Write-Output "ok" }
else {
  $exe = Get-Command $name -ErrorAction SilentlyContinue
  if ($exe) { Start-Process $exe.Source; Write-Output "ok" }
  else { Write-Output "missing" }
}`;
    try {
      const output = await this.powershell<string>(script, true);
      return output.includes('ok')
        ? { ok: true, message: `${name} is up.` }
        : { ok: false, message: `I couldn't find an app called "${name}".` };
    } catch (error) {
      return { ok: false, message: `Opening ${name} failed: ${error instanceof Error ? error.message : 'unknown'}` };
    }
  }

  async openUrl(url: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.powershell(`Start-Process ${psString(url)}; Write-Output ok`, true);
      return { ok: true, message: 'It is open in your browser.' };
    } catch {
      return { ok: false, message: "That link wouldn't open." };
    }
  }

  async readClipboard(): Promise<string> {
    return this.powershell<string>('Get-Clipboard -Raw', true);
  }

  async writeClipboard(text: string): Promise<void> {
    await this.powershell(`Set-Clipboard -Value ${psString(text)}; Write-Output ok`, true);
  }

  async runShortcut(
    name: string,
    args?: string
  ): Promise<{ ok: boolean; message: string; output?: string }> {
    const script = `
$name = ${psString(name)}
$candidates = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\$name.lnk",
  "$env:USERPROFILE\\Desktop\\$name.lnk",
  "$env:USERPROFILE\\Desktop\\$name.cmd",
  "$env:USERPROFILE\\Desktop\\$name.bat",
  "$env:USERPROFILE\\Desktop\\$name.ps1"
)
$target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($target) { & $target; Write-Output "ok" } else { Write-Output "missing" }`;
    try {
      const output = await this.powershell<string>(script, false, 120_000);
      return output.includes('ok')
        ? { ok: true, message: `"${name}" ran.` }
        : { ok: false, message: `I couldn't find a shortcut called "${name}" on your desktop or Start menu.` };
    } catch (error) {
      return { ok: false, message: `That shortcut failed: ${error instanceof Error ? error.message : 'unknown'}` };
    }
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async powershell<T>(script: string, json = false, timeout = 45_000): Promise<T> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      const { stdout } = await run(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
      );
      const text = stdout.trim();
      if (!json) return text as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      throw new ComputerError(stderr.trim().slice(0, 400) || 'PowerShell failed', 'failed');
    }
  }
}

/** Single-quote a string for PowerShell (doubling embedded quotes). */
const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const VK: Record<string, number> = {
  enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  cmd: 0x5b, win: 0x5b, ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10
};

const parseCombo = (keys: string): { mods: number[]; key: number }[] => {
  return keys
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((combo) => {
      const parts = combo.split('+').map((part) => part.trim());
      const keyName = parts[parts.length - 1] ?? 'enter';
      const mods = parts
        .slice(0, -1)
        .map((mod) => VK[mod])
        .filter((code): code is number => typeof code === 'number');
      const named = VK[keyName];
      const key = named ?? (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0x0d);
      return { mods, key };
    });
};
