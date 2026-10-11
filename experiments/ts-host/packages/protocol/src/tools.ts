import type { RealtimeTool, ToolName } from './types.js';

/**
 * The complete list of things Buddy can ask the host to do.
 *
 * These definitions are handed to the realtime model as function tools, so the
 * model can only ever request something the host knows how to do. The `meta`
 * block is stripped before the tools are sent and is used by the host for
 * safety checks and by the apps for the settings UI.
 */
export const TOOLS: RealtimeTool[] = [
  {
    type: 'function',
    name: 'look_at_screen',
    description:
      "Look at the user's screen and answer a question about it. Use this whenever the user asks about anything visible, says 'this', 'that', 'what am I looking at', or asks you to find something. Returns a short description and any text targets it could identify.",
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: "What the user wants to know. e.g. 'what app is open?'"
        },
        region: {
          type: 'string',
          enum: ['full', 'window', 'cursor'],
          description:
            "'cursor' reads only what is under the user's mouse — best when they say 'what's this'. 'window' reads the app they're focused on. Defaults to 'full'."
        },
        detail: {
          type: 'string',
          enum: ['quick', 'thorough'],
          description: "'quick' is one sentence, 'thorough' lists the on-screen items."
        }
      },
      required: ['question'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'eye', group: 'look' }
  },
  {
    type: 'function',
    name: 'point_at',
    description:
      "Fly Buddy's cursor to something on the screen and land on it. This never touches the user's real mouse and never clicks. ALWAYS prefer this over clicking. Describe the target in plain words.",
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            "Plain-language description of what to point at, e.g. 'the chat that says run Googly Eyes on MacBook' or 'the search box'."
        },
        say: {
          type: 'string',
          description: 'Optional short line Buddy says while he points, in his own voice.'
        }
      },
      required: ['target'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'cursor', group: 'point' }
  },
  {
    type: 'function',
    name: 'move_cursor',
    description:
      "Move Buddy's cursor to a spot on screen. Prefer point_at with a description unless the user gave you an exact spot.",
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixels from the left of the main display.' },
        y: { type: 'number', description: 'Pixels from the top of the main display.' },
        target: { type: 'string', description: 'Or describe what to move to instead of x/y.' }
      },
      additionalProperties: false
    },
    meta: { risky: false, icon: 'cursor', group: 'point' }
  },
  {
    type: 'function',
    name: 'click',
    description:
      "Click on something. This moves the user's REAL mouse and clicks for real. Only do this when the user clearly asked you to. Risky clicks (buy, delete, send, post, pay, publish, log out, uninstall) must be confirmed first — the host will ask.",
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "What to click, in plain words, e.g. 'the Send button'."
        },
        double: { type: 'boolean', description: 'Double-click instead of single.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Defaults to left.' },
        reason: {
          type: 'string',
          description: "One short sentence for the user's confirmation prompt."
        }
      },
      required: ['target'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'hand', group: 'control' }
  },
  {
    type: 'function',
    name: 'type_text',
    description:
      "Type text into whatever is focused. This types with the user's real keyboard. Never type passwords, card numbers or seed phrases — the host blocks sensitive fields and you should refuse instead.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Exactly what to type.' },
        submit: {
          type: 'boolean',
          description: 'Press Enter afterwards. Only when the user asked you to send/submit.'
        },
        reason: {
          type: 'string',
          description: 'One short sentence for the confirmation prompt if submitting.'
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'keyboard', group: 'control' }
  },
  {
    type: 'function',
    name: 'press_keys',
    description:
      "Press a key combination, like 'cmd+shift+4' or 'ctrl+alt+t'. Use for shortcuts (copy, paste, screenshot, close window) and for navigation.",
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description: "Keys joined with +, e.g. 'cmd+c', 'ctrl+shift+t', 'esc'."
        },
        repeat: { type: 'number', description: 'How many times to press it. Defaults to 1.' },
        reason: { type: 'string', description: 'One short sentence for the confirmation prompt.' }
      },
      required: ['keys'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'keyboard', group: 'control' }
  },
  {
    type: 'function',
    name: 'open_app',
    description: 'Open an application by name on the computer, e.g. "Chrome", "Terminal", "Notes".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The app name as a human would say it.' }
      },
      required: ['name'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'app', group: 'control' }
  },
  {
    type: 'function',
    name: 'open_url',
    description: 'Open a URL in the default browser. Say the destination out loud first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Fully-qualified URL including https://' },
        reason: { type: 'string', description: 'One short sentence for the confirmation prompt.' }
      },
      required: ['url'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'globe', group: 'control' }
  },
  {
    type: 'function',
    name: 'list_apps',
    description: 'List the apps currently running on the computer, or the apps installed if asked.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['running', 'installed'], description: 'Defaults to running.' }
      },
      additionalProperties: false
    },
    meta: { risky: false, icon: 'list', group: 'look' }
  },
  {
    type: 'function',
    name: 'get_active_window',
    description:
      'Find out which app and window the user is focused on right now, plus its title. Cheap — use this before big screen reads.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    meta: { risky: false, icon: 'window', group: 'look' }
  },
  {
    type: 'function',
    name: 'read_clipboard',
    description: 'Read what the user last copied.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    meta: { risky: false, icon: 'clipboard', group: 'look' }
  },
  {
    type: 'function',
    name: 'write_clipboard',
    description: 'Put text on the clipboard so the user can paste it.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to copy.' } },
      required: ['text'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'clipboard', group: 'control' }
  },
  {
    type: 'function',
    name: 'run_shortcut',
    description:
      "Run one of the user's saved automations: a macOS Shortcut, a Windows shortcut file, or a shell command they've explicitly allowed. Say what it does before you run it.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the shortcut.' },
        args: { type: 'string', description: 'Optional input passed to the shortcut.' },
        reason: { type: 'string', description: 'One short sentence for the confirmation prompt.' }
      },
      required: ['name'],
      additionalProperties: false
    },
    meta: { risky: true, requiresComputerUse: true, icon: 'bolt', group: 'control' }
  },
  {
    type: 'function',
    name: 'remember',
    description:
      "Save something worth keeping — who the user is, what they like, what they're working on, a plan. Call it whenever you learn something durable, without asking.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory, written in the third person and self-contained.' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'note', 'person', 'place'],
          description: "Defaults to 'fact'."
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'A few short tags.' },
        importance: { type: 'number', description: '0 to 1. Use 1 for things they care about a lot.' }
      },
      required: ['text'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'brain', group: 'memory' }
  },
  {
    type: 'function',
    name: 'recall',
    description: 'Look up what you remember about a topic before answering questions about the user.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search your memories for.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'brain', group: 'memory' }
  },
  {
    type: 'function',
    name: 'forget',
    description:
      'Delete a memory. The friendly form is "forget that", but only when they actually want it gone.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string', description: 'Or describe it.' } },
      additionalProperties: false
    },
    meta: { risky: false, icon: 'brain', group: 'memory' }
  },
  {
    type: 'function',
    name: 'set_mood',
    description:
      "Change your own face. Use it to react — 'happy' when something good happens, 'confused' when you don't understand, 'proud' when you nail it, 'curious' while you think.",
    parameters: {
      type: 'object',
      properties: {
        mood: {
          type: 'string',
          enum: [
            'idle',
            'listening',
            'thinking',
            'talking',
            'happy',
            'curious',
            'pointing',
            'working',
            'confused',
            'surprised',
            'concerned',
            'smug',
            'proud',
            'drowsy',
            'sleeping'
          ]
        },
        say: { type: 'string', description: 'Optional short line to say with the expression.' }
      },
      required: ['mood'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'face', group: 'mood' }
  },
  {
    type: 'function',
    name: 'go_to_sleep',
    description:
      "When the user says goodnight or tells you to go to sleep, close your eyes and nap. You'll still be there — a double tap or a tap-and-hold wakes you.",
    parameters: {
      type: 'object',
      properties: { say: { type: 'string', description: 'A short goodnight, if you like.' } },
      additionalProperties: false
    },
    meta: { risky: false, icon: 'moon', group: 'system' }
  },
  {
    type: 'function',
    name: 'computer_use',
    description:
      'Turn your ability to control the mouse and keyboard on or off. Use it when the user says "stop touching my computer" or "you can drive now".',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        reason: { type: 'string' }
      },
      required: ['enabled'],
      additionalProperties: false
    },
    meta: { risky: false, icon: 'toggle', group: 'system' }
  },
  {
    type: 'function',
    name: 'cancel',
    description: 'Stop what you are doing right now — abort a click, a typing run, a cursor flight.'
    ,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    meta: { risky: false, icon: 'stop', group: 'system' }
  }
];

const toolIndex = new Map<string, RealtimeTool>(TOOLS.map((tool) => [tool.name, tool]));

export const TOOL_NAMES: ToolName[] = TOOLS.map((tool) => tool.name as ToolName);

export const getTool = (name: string): RealtimeTool | undefined => toolIndex.get(name);

export const toolMeta = (name: string): Required<Pick<RealtimeTool, 'type' | 'name'>> &
  NonNullable<RealtimeTool['meta']> => {
  const tool = toolIndex.get(name);
  return {
    type: 'function',
    name,
    risky: tool?.meta?.risky ?? true,
    blocked: tool?.meta?.blocked ?? false,
    requiresComputerUse: tool?.meta?.requiresComputerUse ?? false,
    icon: tool?.meta?.icon ?? 'dot',
    group: tool?.meta?.group ?? 'system'
  };
};

/** Tools that hit the real mouse/keyboard. Gated by settings.computerUse. */
export const COMPUTER_USE_TOOLS: ToolName[] = TOOLS.filter(
  (tool) => tool.meta?.requiresComputerUse
).map((tool) => tool.name as ToolName);

/** Tools the user has to confirm first, when confirmRiskyActions is on. */
export const RISKY_TOOLS: ToolName[] = TOOLS.filter((tool) => tool.meta?.risky).map(
  (tool) => tool.name as ToolName
);

/** Tools handed to the model, with host-only metadata stripped. */
export const realtimeToolPayload = (): Omit<RealtimeTool, 'meta'>[] =>
  TOOLS.map(({ meta: _meta, ...rest }) => rest);
