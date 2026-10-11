# Buddy

A small blueberry-coloured companion who lives in your computer and on your phone.
He hears you, answers out loud, looks at your screen, and — when you let him —
moves his own pointer to show you things or do them for you.

He runs on **free Google Gemini** (no card, no ChatGPT account). One key, pasted
once, is enough for everything.

```
   ┌──────────────┐        HTTP + event stream        ┌───────────────┐
   │  your phone  │ ◄───────────────────────────────► │    bridge     │
   │  the website │        (SSE down, POST up)        │ companion/    │
   └──────┬───────┘                                   └───────┬───────┘
          │  voice (Gemini Live, one-session token)           │ Bonjour + lines of JSON
          ▼                                                   ▼
   ┌──────────────┐                                   ┌───────────────┐
   │    Gemini    │                                   │   Buddy.app   │
   │  free tier   │                                   │  hands + eyes │
   └──────────────┘                                   └───────────────┘
```

## The three pieces

| Piece | What it is | Where |
| --- | --- | --- |
| **Buddy.app** | A Mac menu-bar app. He holds the Gemini key, reads the screen, points, clicks, types, takes notes, and draws his own cursor. | `Mac/`, `Shared/`, `Package.swift` |
| **The phone app** | A website. Same face, same push-to-talk, installs to your home screen with Share → Add to Home Screen. | `Web/` |
| **The bridge** | A tiny Node server that serves the website and finds your Mac on the Wi-Fi, because browsers can't speak Bonjour or raw sockets. | `companion/` |

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

1. **Get a free key** at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   (any Google account, no card) and paste it when Buddy asks.
2. **Scan the QR code** with your phone's camera — the Mac and the phone must be
   on the same Wi-Fi.
3. On the page that opens, tap **Install the Buddy certificate**, then do the two
   quick steps it shows in **Settings** (profile → install, then full trust).
   This is what lets a web page use the microphone; it never leaves your Wi-Fi.
4. Tap **Open Buddy**, then **Share → Add to Home Screen**.

Hold the screen and talk; let go and he answers. Double tap to send him to sleep.

Step by step with screenshots-in-words: **[QUICKSTART.md](QUICKSTART.md)**.
Just want to see him? `./start.sh --demo` — no Mac, no key, just his face.

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
- **Research** — `web_research` pops a little card with the answer and its
  sources.
- **Meeting notes** — long recordings are transcribed with speakers and saved to
  `~/Documents/Buddy Notes/`.
- **Talk with him** — hold the screen and he answers out loud, or in a bubble if
  you would rather keep the room quiet.

## The free API, honestly

There is no such thing as a literally unlimited free API. What there is:

| Option | Free allowance | Verdict |
| --- | --- | --- |
| **Google Gemini** (default) | Real free tier on Flash/Live models — roughly 1,500 requests a day per project | **Start here.** One key runs his voice, his eyes and his answers. |
| **Groq** (optional) | ~1,000 requests/day, ~7,200 audio-seconds/hour on Whisper | Add a key if you want separate fast "ears" for transcription. |
| **Ollama** (optional) | Runs on your own Mac, no internet, no quota | The only truly unlimited option, because it is your own hardware. |

So: free is generous enough for real daily use. Everything in Buddy — his voice,
his answers, his research, his meeting notes — runs on that one free key. If you
ever outgrow it, swapping in a paid key is a one-line change in
`Mac/Sources/BuddyMac/Gemini.swift`, with nothing else to rewire.

## Troubleshooting

- **"Looking for your computer…"** — the phone server has not found `Buddy.app`.
  Check the blueberry is in the menu bar and both devices are on the same Wi-Fi.
  If your network blocks Bonjour: `BUDDY_HOST=your-mac.local BUDDY_PORT=8737 ./start.sh`.
- **"The microphone needs a trusted connection"** — the certificate steps in
  QUICKSTART step 3 were not finished.
- **"No voice provider is available"** — no key yet. **Voice Key (free Gemini)…**
  in his menu, or `GEMINI_API_KEY=… ./start.sh`.
- **A new Wi-Fi or IP** — `node companion/server.mjs --regen-certs`, then
  reinstall the profile on the phone.
- **Port already in use** — he moves to the next free port and prints it.
- **He talks with a phone voice** — that is the fallback when the realtime voice
  cannot be reached, almost always a missing or rejected key.
- **"Gemini wouldn't answer"** — the key was rejected. Check it at
  aistudio.google.com/apikey, then paste it again under **Voice Key (free Gemini)…**.

## Repository layout

```
Mac/Sources/BuddyMac/   the menu-bar app: host, tools, screen reading, cursor
Shared/                 the packet format both halves agree on (+ the fonts)
Web/                    the phone website (face, live voice, gestures)
companion/              the bridge that serves Web/ and finds the Mac
scripts/build-mac.sh    builds and signs build/Buddy.app
docs/                   screenshots from the original project
experiments/            parked, unfinished side work — safe to ignore
```

## Credits

The Mac side began as [bluey-by-riley](https://github.com/rbrown101010/bluey-by-riley)
by Riley Brown, released into the public domain (Unlicense). Buddy is that app,
renamed, with its iPhone app replaced by a website and its brain moved onto a
free API. Same licence: do whatever you like with it.
