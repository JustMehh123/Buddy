# Buddy

A small violet companion who lives in your computer and on your phone.
He hears you, answers out loud, looks at your screen, and — when you let him —
moves his own pointer to show you things or do them for you.

He thinks with a **free, open-source model running on your own machine**
([Ollama](https://ollama.com)). There is no account, no API key and no quota:
the only limit is your own computer, which makes him completely free, open
source and effectively unlimited. Nothing you say is sent to anyone.

```
   ┌──────────────┐        HTTP + event stream        ┌───────────────┐
   │  your phone  │ ◄───────────────────────────────► │    bridge     │
   │  the website │        (SSE down, POST up)        │ companion/    │
   └──────┬───────┘                                   └───────┬───────┘
          │  voice: the phone's own speech                     │ Bonjour + lines of JSON
          ▼                                                   ▼
   ┌──────────────┐                                   ┌───────────────┐
   │ SpeechRecog. │                                   │   Buddy.app   │
   │ SpeechSynth. │                                   │  hands + eyes │
   └──────────────┘                                   └───────┬───────┘
                                                              │ /v1/chat/completions
                                                              ▼
                                                      ┌───────────────┐
                                                      │     Ollama    │
                                                      │ open model 🧠 │
                                                      └───────────────┘
```

## The three pieces

| Piece | What it is | Where |
| --- | --- | --- |
| **Buddy.app** | A Mac menu-bar app. He runs the open model, reads the screen, points, clicks, types, takes notes, and draws his own cursor. | `Mac/`, `Shared/`, `Package.swift` |
| **Buddy for Windows** | Same companion as a Python host for Windows 10+: same protocol, same tools, no admin needed. | `windows/` (see `windows/README.md`) |
| **The phone app** | A website. Same face, same push-to-talk, installs to your home screen with Share → Add to Home Screen. | `Web/` |
| **The bridge** | A tiny Node server that serves the website and finds your Mac on the Wi-Fi, because browsers can't speak Bonjour or raw sockets. It also talks to Ollama. | `companion/` |

iOS will not hand a web page the microphone over plain `http://`, so the bridge
generates a small local certificate (with `openssl`, once) and serves HTTPS. You
install that certificate on the phone the same way you install any profile, and
then everything works.

## Quick start

```sh
./start.sh
```

That builds and opens `Buddy.app`, starts the little phone server, and prints a
QR code. Then, **once**:

1. **Get a brain.** Install [Ollama](https://ollama.com/download) (or
   `brew install ollama`), start it (`ollama serve`), and pull a model:

   ```sh
   ollama pull llama3.2
   ```

   That's the whole "AI setup" — free, open source, and unlimited because it
   runs on your Mac.
2. **Scan the QR code** with your phone's camera — the Mac and the phone must be
   on the same Wi-Fi.
3. On the page that opens, tap **Install the Buddy certificate**, then do the two
   quick steps it shows in **Settings** (profile → install, then full trust).
   This is what lets a web page use the microphone; it never leaves your Wi-Fi.
4. Tap **Open Buddy**, then **Share → Add to Home Screen**.

Hold the screen and talk; let go and he answers. Double tap to send him to sleep.

Step by step with screenshots-in-words: **[QUICKSTART.md](QUICKSTART.md)**.
Just want to see him? `./start.sh --demo` — no Mac, no model, just his face.

## What he can do

- **Listen and answer** — hold to talk, release to hear. His lips move while he
  speaks and his eyes follow the pointer while he thinks.
- **Look at your screen** — `look_at_screen` returns the frontmost app, the
  clickable controls, the lines and the words on screen, on a 0–1000 grid.
- **Point** — at a control, a line, a word, or an exact spot, with his own
  cursor, then hold still so you can see it.
- **Use your computer**, when you switch "Let Him Use the Computer" on: click,
  type, press keys, scroll, drag, open apps and links. He asks before anything
  destructive, refuses password fields, and ⌃⌥S stops him mid-action.
- **Research** — `web_research` does a free, key-less web search and has the local
  model write it up, then pops a little card with the answer and its sources.
- **Meeting notes** — long recordings are transcribed locally with Whisper and
  saved to `~/Documents/Buddy Notes/`.
- **Talk with him** — hold the screen and he answers out loud, or in a bubble if
  you would rather keep the room quiet.

## The free brain, honestly

There is no such thing as a literally unlimited free *cloud* API. So Buddy
doesn't use one. All the thinking happens on your own machine:

| Piece | What runs it | Cost |
| --- | --- | --- |
| **Thinking** (answers, tools, research, notes) | **Ollama** — open source (MIT), running open-weight models: Llama, Qwen, Gemma, Mistral | **Free and unlimited.** It's your hardware. |
| **Hearing and speaking** (the phone) | The browser's built-in `SpeechRecognition` and `SpeechSynthesis`, the same ones Safari and Chrome ship with | **Free and unlimited.** No key, no data leaving the phone for the cloud TTS/STT. |
| **Search** (research only) | A plain, key-less DuckDuckGo lookup | Free. |

That is the whole point: `llama3.2` (or `qwen2.5`, `gemma3`, `mistral`…) is
open-source software you run; Buddy is the companion wrapped around it. If you
outgrow a local model and want to point him at something bigger, his client
speaks the same OpenAI-shaped API as everyone else — set the server in
**Brain (local model)…**, or edit `Mac/Sources/BuddyMac/Brain.swift`. Nothing
else changes.

## Troubleshooting

- **"Looking for your computer…"** — the phone server has not found `Buddy.app`.
  Check the violet blob is in the menu bar and both devices are on the same
  Wi-Fi. If your network blocks Bonjour:
  `BUDDY_HOST=your-mac.local BUDDY_PORT=8737 ./start.sh`.
- **"I can't reach the model on your computer"** — Ollama is not running. Start it
  with `ollama serve`, and make sure you have pulled a model (`ollama pull llama3.2`).
- **"The microphone needs a trusted connection"** — the certificate steps in
  QUICKSTART step 3 were not finished.
- **He answers but knows nothing recent** — a small local model has no live
  knowledge; ask him to **research** something and he will search the web first.
- **A new Wi-Fi or IP** — `node companion/server.mjs --regen-certs`, then
  reinstall the profile on the phone.
- **Port already in use** — he moves to the next free port and prints it.
- **"No speech recognition in this browser"** — use Safari or Chrome on the phone
  for voice; other browsers can still type to him.
- **Meeting notes are empty** — local transcription needs `whisper-cpp` and a
  model file; the menu tells you exactly what to install.

## Repository layout

```
Mac/Sources/BuddyMac/   the menu-bar app: host, tools, screen reading, cursor, the model client (Brain.swift)
windows/                the Windows host: same protocol and tools in Python (buddy.py), no admin needed
Shared/                 the packet format both halves agree on (+ the fonts)
Web/                    the phone website (face, voice, gestures)
companion/              the bridge that serves Web/ and finds the Mac
scripts/build-mac.sh    builds and signs build/Buddy.app
scripts/make-icons.py   draws the violet app icons
docs/                   screenshots from the original project
experiments/            parked, unfinished side work — safe to ignore
```

## Credits

The Mac side began as [bluey-by-riley](https://github.com/rbrown101010/bluey-by-riley)
by Riley Brown, released into the public domain (Unlicense). Buddy is that app,
renamed and recoloured, with its iPhone app replaced by a website and its brain
moved onto a free, open-source model running locally. Same licence: do whatever
you like with it.
