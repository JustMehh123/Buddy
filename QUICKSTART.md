# Setting Buddy up

Three minutes, once. After that he is an app on your phone's home screen and a
blueberry in your menu bar.

---

## 1. A free key (2 minutes, no card)

1. Open **https://aistudio.google.com/apikey** on any device.
2. Sign in with any Google account.
3. Tap **Create API key**, copy the string that starts with `AIza…`.

That is the whole "free API" step. It is Google's Gemini free tier — no billing
account, no credit card, no ChatGPT subscription. (Honest note: no free tier is
literally unlimited; Gemini's is roughly 1,500 requests a day, which is far more
than a personal Buddy uses. There is also a switch to Ollama in the README if you
ever want a brain that runs entirely on your own Mac.)

---

## 2. Start him on the Mac

In Terminal, in the folder you downloaded:

```sh
./start.sh
```

The first run builds `Buddy.app` (needs Apple's Command Line Tools — if they are
missing, run `xcode-select --install` once), puts him in your menu bar, and starts
the little phone server.

**Paste the key when he asks.** He keeps it in
`~/Library/Application Support/Buddy/keys.json`, readable only by you. You can
change it later from his menu: **Voice Key (free Gemini)…**.

The server prints something like:

```
  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▄ ▀█▄ ▄ ▄▀█  █ ▄▄▄ █     <- scan this with your phone
  ...
   1. On the phone (same Wi-Fi), open:   http://your-mac.local:8444/install?pair=…
      That page installs the little certificate he needs, then pairs the phone.
   2. Then add him to the home screen:   https://your-mac.local:8443/
```

The long `pair=…` part of that link is a **one-time code**. It is what makes the
phone that opens it *your* phone: the bridge only answers devices it has been
introduced to, and the code stops working the moment it has been used. Nothing
else on the Wi-Fi can reach him, and nobody can drive your Mac from the couch
without that code.

---

## 3. Put him on your phone (1 minute, one time only)

The phone and the Mac must be on the same Wi-Fi.

1. **Point your phone's camera at the QR code** in the terminal and tap the link
   that pops up — or type the `http://…:8444/install?pair=…` address into Safari.
   Keep the `?pair=…` part: that is the one-time pairing code, and the link stops
   working after the phone has used it.
2. On that page, tap **Install the Buddy certificate**. This is what lets a web
   page use the microphone.
3. Tap **Allow** when Safari says it downloaded a profile.
4. **Settings → General → VPN & Device Management → Buddy → Install.**
5. **Settings → General → About → Certificate Trust Settings** → turn on the
   switch for **Buddy Local CA**.
6. Back on the page, tap **Open Buddy**. The page pairs itself on the way in —
   you do not have to type or paste anything. Then **Share → Add to Home Screen**.

That's it — he now opens full-screen from his own icon, already paired.

> If a second phone, or a phone that was set up before, asks to be paired, the
> bridge has a fresh code printed at the bottom of its window: scan that. The
> gear menu inside the app shows whether this phone is paired, and can unpair it.

> **Why pairing?** The bridge listens on your whole Wi-Fi, and one of the things
> it can do is move the mouse and type on your Mac. A phone has to be paired with
> a one-time code before it can do any of that, and the request that asks for
> control has to come from a paired phone. That is what makes him safe to leave
> running on a shared network — a café, an office, a hotel.
>
> The Mac is careful on its own side too: it only obeys commands that carry a
> secret it wrote itself (`~/Library/Application Support/Buddy/bridge-token`,
> readable only by you). So a program on the same Wi-Fi cannot skip the bridge
> and drive the cursor directly. If you ever run the bridge on a *different*
> machine, copy that file's contents across and start it with
> `BUDDY_MAC_TOKEN=… ./start.sh`.
>
> **What is that certificate?** The phone server makes a tiny private certificate
> (with `openssl`, on your Mac, once) so the connection is `https`. iOS only hands
> the microphone to a web page on a trusted connection, so this is the one-time
> price for the microphone working. Nothing leaves your Wi-Fi, and you can remove
> the profile any time in the same Settings screens.

---

## 4. Use him

| Gesture | What happens |
| --- | --- |
| **Hold the screen and talk** | He listens while you hold. Let go and he answers. |
| **Double tap** | He goes to sleep or wakes up. |
| **Gear icon** | Which computer he is on, his voice, whether he may use the computer, and a switch for him speaking out loud. |

On the Mac, the menu-bar blueberry has: **Wake Up and Talk** (⌥Space),
**Point Here** (⌃⌥P), **Eyes Follow My Mouse** (⌃⌥F), **Stop Him** (⌃⌥S),
**Let Him Use the Computer**, moods, cursor size and personality.

For him to click and type, macOS asks once for **Accessibility** permission
(**Allow Clicking and Typing (Accessibility)…** in his menu) and once for
**Screen Recording** (he asks the first time he looks at your screen).

---

## Just want to see him first?

```sh
./start.sh --demo
```

No Mac app, no key: his face, his moods and a scripted little conversation, in
your browser. Good for checking the phone side before the rest is set up.

---

## If something goes wrong

| What you see | What it means |
| --- | --- |
| "Looking for your computer…" | The phone server has not found `Buddy.app`. Check the blueberry is in the menu bar (not faded) and both devices are on the same Wi-Fi. Blocked Bonjour? Start it with `BUDDY_HOST=your-mac.local BUDDY_PORT=8737 ./start.sh`. |
| "The microphone needs a trusted connection" | Step 3 was not finished. Redo steps 4–5 in the Certificate Trust Settings screen. |
| "No voice provider is available" | No key yet: **Voice Key (free Gemini)…** in his menu, or start with `GEMINI_API_KEY=… ./start.sh`. |
| He answers with the phone's voice, not his own | That is the fallback when the realtime voice cannot be reached — usually a missing or rejected key. |
| A new Wi-Fi or a new IP | `node companion/server.mjs --regen-certs`, then reinstall the profile on the phone. |
| A new phone, or one that lost its pairing | The bridge prints a fresh one-time link every time it starts. Open it on the phone. |
| A phone you want to cut off | `node companion/server.mjs --revoke all` (or `--devices` to see the list first, then `--revoke <id>`). |
| Wondering which phones are paired | `node companion/server.mjs --devices` |
| Port already in use | He takes the next free port and prints it — just use the address he shows. |

### What runs where

| Piece | Who does the thinking |
| --- | --- |
| Talking with him (hold the screen) | Gemini Live, on the free key — the phone only ever gets a short-lived, one-session token |
| Looking at your screen, pointing, clicking, typing | The Mac runs the tools; Gemini decides which to use |
| Research | Gemini with Google Search grounding — the report card lists the pages it used |
| Meeting notes | Gemini listens to each recorded chunk and writes the speaker-labelled transcript |

One key covers all of it. It is stored in
`~/Library/Application Support/Buddy/keys.json` (readable only by you) and never
leaves the Mac. The phone is handed a token for **one session**, pinned to the
exact conversation he is about to have, good for starting a session for about
two minutes and expired half an hour after that — and it is asked for at the
moment you press the screen, not when the page loads.

### Checking it yourself

Everything below runs without an API key and without leaving your Mac:

```sh
npm --prefix companion ci          # the bridge's one dependency tree
npm --prefix companion run smoke   # 143 checks: page, voice path, security, tokens
python3 tools/check-symbols.py     # every Foo.bar in the Swift sources resolves
swift build -c release --product BuddyMac   # the menu bar app
./scripts/build-mac.sh             # and the signed .app bundle
```

`npm run smoke` covers the four suites in `companion/tools/`: the phone page in a
fake browser (including pairing and that loading it spends no voice token), the
voice protocol against a fake socket (including what happens when a model is
retired or a credential is refused), the bridge with no trust at all (a device
that was never paired, path traversal, revocation, the log), and the token
request itself against a local stand-in for Gemini.

What that cannot cover, and has to be tried on your own Mac with your own key:
the real voice session, a real ephemeral token, real research and transcription,
and the certificate step on a real iPhone. Those are the last four rows of the
table in the report's checklist, and they need ears.
