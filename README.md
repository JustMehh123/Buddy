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
| **Buddy.app** | A Mac menu-bar app. He holds the API key, reads the screen, points, clicks, types, takes notes, and draws his own cursor. | `Mac/`, `Shared/`, `Package.swift` |
| **The phone app** | A website. Same face, same push-to-talk, installs to your home screen with Share → Add to Home Screen. | `Web/` |
| **The bridge** | A tiny Node server that serves the website and finds your Mac on the Wi-Fi, because browsers can't speak Bonjour or raw sockets. | `companion/` |

iOS will not hand a web page the microphone over plain `http://`, so the bridge
generates a small local certificate (with `openssl`, once) and serves HTTPS. You
install that certificate on the phone the same way you install any profile, and
then everything works.

## Quick start

### 1. Get a free key

Visit **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**, sign in
with any Google account, and create an API key. No card, no billing, no ChatGPT.

### 2. Run the Mac app

```sh
./scripts/build-mac.sh      # needs the Xcode Command Line Tools
open build/Buddy.app
```

Buddy appears in the menu bar and asks for his voice key on first run — paste the
one you just made (or use **Voice Key (free Gemini)…** in his menu any time). He
keeps it in `~/Library/Application Support/Buddy/keys.json`, readable only by you.

### 3. Run the bridge

```sh
cd companion && npm install && cd ..
node companion/server.mjs
```

It prints something like:

```
   https://your-mac.local:8443/
```

### 4. Put him on your phone

1. Open that address on your phone (same Wi-Fi).
2. The first time, open `https://your-mac.local:8443/install` and follow the two
   steps to trust the certificate — this is the only fiddly bit, and it is what
   lets the microphone work.
3. Then Share → **Add to Home Screen**. He opens full-screen, like an app.

### 5. Use him

- **Hold the screen and talk.** Let go and he answers.
- **Double tap** to wake him up or put him to sleep.
- **Gear** for details: which computer, which voice, whether he may use the
  computer, and a switch for him speaking out loud.
- On the Mac: **⌥Space** wakes him, **⌃⌥P** points here, **⌃⌥F** makes his eyes
  follow your mouse, **⌃⌥D** stops pointing, **⌃⌥S** stops him using the computer.

Just want to see him before setting anything up?

```sh
BUDDY_DEMO=1 node companion/server.mjs
```

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

## The free API, honestly

There is no such thing as a literally unlimited free API. What there is:

| Option | Free allowance | Verdict |
| --- | --- | --- |
| **Google Gemini** (default) | Real free tier on Flash/Live models — roughly 1,500 requests a day per project | **Start here.** One key runs his voice, his eyes and his answers. |
| **Groq** (optional) | ~1,000 requests/day, ~7,200 audio-seconds/hour on Whisper | Add a key if you want separate fast "ears" for transcription. |
| **Ollama** (optional) | Runs on your own Mac, no internet, no quota | The only truly unlimited option, because it is your own hardware. |

So: free is generous enough for real daily use, and the moment you need more, an
OpenAI or paid Gemini key can be added without changing anything else — the Mac
app already knows how to hold those too.

## Troubleshooting

- **"Looking for your computer…"** — the bridge hasn't found `Buddy.app`. Check
  the Mac app is running (its menu-bar icon stops looking faded), and that the
  phone and Mac are on the same Wi-Fi. If your network blocks Bonjour, start the
  bridge with `BUDDY_HOST=your-mac.local BUDDY_PORT=<port>`.
- **"The microphone needs a trusted connection"** — open `/install` on the phone
  and do the two steps (install the profile, then turn on full trust in
  Settings → General → About → Certificate Trust Settings).
- **A different Wi-Fi or a new IP** — the certificate covers the addresses it saw
  when it was made. Re-run `node companion/server.mjs --regen-certs` and reinstall
  the profile.
- **"No voice provider is available"** — no key yet. Use the Mac app's
  **Voice Key (free Gemini)…** menu item, or start the bridge with
  `GEMINI_API_KEY=…`.
- **Port already in use** — `BUDDY_PHONE_PORT=9443 node companion/server.mjs`.

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
