# Buddy for Windows

The same violet companion, living on your PC instead of a Mac. The phone page
(`Web/`) and the bridge (`companion/`) are unchanged — this folder replaces
only the Swift Mac app with a Python host speaking the **same protocol**
(newline JSON Packets, same tool names), so everything else just works.

Everything is free: Ollama (brain), `mss`/`pyautogui` (eyes/hands),
DuckDuckGo (research), Tesseract (text ids, optional). No key, no account.

## Setup (no admin)

1. **Python 3.10+** from python.org ("Install for me only"), plus
   [Ollama for Windows](https://ollama.com/download). Then:
   ```bat
   ollama serve
   ollama pull llama3.2
   ```
2. **Double-click `start-win.bat`** (or `py buddy.py`). It installs the
   Python pieces into your user folder and starts Buddy on port `8737`.
3. **Point the bridge at the PC.** On the machine running
   `companion/server.mjs`:
   ```sh
   BUDDY_HOST=<this-pc-ip> BUDDY_PORT=8737 node companion/server.mjs
   ```
   (Or `pip install zeroconf` here and the bridge finds the PC by Bonjour,
   exactly like the Mac.) The phone setup from there is identical:
   certificate page → Add to Home Screen → hold to talk.

## What works / what differs from the Mac

| | Mac app | Windows host |
|---|---|---|
| Chat + tools via Ollama | ✅ | ✅ same loop, same 13 tool names |
| `look_at_screen` screenshot | ✅ | ✅ (`mss`) |
| Text ids (L#/W#) | ✅ Vision, built in | ⚠️ needs Tesseract + `pytesseract`; without it the screenshot + window title still work, ids are just absent |
| Click / type / keys / scroll / drag / open app+url | ✅ | ✅ (`pyautogui` + SendInput; `cmd` in combos means the Win key) |
| `web_research` | ✅ | ✅ (same key-less DuckDuckGo) |
| Animated cursor overlay, menu bar, hotkeys, report cards | ✅ | ❌ not ported — the phone face is the UI; pointing is tracked internally |
| Meeting-notes transcription | ✅ local Whisper | ❌ not ported yet (needs a Windows Whisper build) |

## Free cloud brain: smarter and faster (optional)

`llama3.2` on your own PC is private and unlimited, but a 3B model is dim
and slow. [Groq](https://console.groq.com) runs 70B-class models
(`llama-3.3-70b-versatile`) at hundreds of tokens/sec on a genuinely free
tier — one free key, no card:

1. Sign in at [console.groq.com](https://console.groq.com) and create an API key.
2. Save it for every terminal (close and reopen terminals afterwards):
   ```bat
   setx BUDDY_PROVIDER groq
   setx BUDDY_API_KEY gsk_paste_your_key_here
   ```
3. Restart `start-win.bat` (and the bridge, with the same variables set).

Same tools, same loop, same phone — just a much bigger, faster mind.
(`BUDDY_PROVIDER` also accepts `gemini` with a free AI Studio key, or
`compatible` with `BUDDY_API_BASE` for LM Studio/vLLM. Setting
`GROQ_API_KEY` alone picks Groq.)

## Checks

```sh
py buddy.py --selftest   # protocol, tool schemas, instructions — runs anywhere
```

`--selftest` is the port's contract test: if it passes, the bridge and phone
can talk to this host. The full `npm run smoke` suite in `companion/` still
covers the phone page and bridge side unchanged.
