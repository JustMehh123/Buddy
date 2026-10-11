/**
 * @buddy/core — Buddy's soul.
 *
 * The face maths, the personality, the memory, the safety rules and the two
 * clients (the live link to the computer and the realtime voice session).
 * Everything in here runs unchanged on the phone, in a browser and in the
 * desktop shell, because Buddy should behave identically in all of them.
 */

export * from './face.js';
export * from './memory.js';
export * from './persona.js';
export * from './safety.js';
export * from './socket.js';
export * from './realtime.js';

// Re-export the wire types so apps only need one import.
export * from '@buddy/protocol';
export { TOOLS, TOOL_NAMES, getTool, toolMeta, realtimeToolPayload, RISKY_TOOLS, COMPUTER_USE_TOOLS } from '@buddy/protocol';
