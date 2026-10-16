# Setting Buddy up

Three minutes, once. After that he is an app on your phone's home screen and a
violet blob in your menu bar.

---

## 1. A free brain (2 minutes, no key)

Buddy thinks with an open-source model running on your own Mac. Install it once:

1. Get **Ollama** from [ollama.com/download](https://ollama.com/download) — or,
   with Homebrew, `brew install ollama`.
2. Start it: `ollama serve`
3. Pull a model:

   ```sh
   ollama pull llama3.2
   ```

That is the whole step. There is **no key, no account, no credit card and no
quota** — the model runs on your computer, so it is free, open source and
unlimited. Any model works: `ollama pull qwen2.5`, `gemma3` or `mistral`, then
pick it in **Brain (local model)…** in the menu bar.

---

## 2. Start him on the Mac

In Terminal, in the folder you downloaded:

```sh
./start.sh
```

The first run builds `Buddy.app` (needs Apple's Command Line Tools — if they are
missing, run `xcode-select --install` once), puts him in your menu bar, and starts
the little phone server. It prints whether his brain is reachable, so you can see
at a glance if Ollama is running.

The server prints something like:

```
  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▄ ▀█▄ ▄ ▄▀█  █ ▄▄▄ █     <- scan this with your phone
  ...
   1. On the phone (same Wi-Fi), open:   http://your-mac.local:8444/install
   2. Then add him to the home screen:   https://your-mac.local:8443/
```

---

## 3. Put him on your phone (1 minute, one time only)

The phone and the Mac must be on the same Wi-Fi.

1. **Point your phone's camera at the QR code** in the terminal and tap the link
   that pops up — or type the `http://…:8444/install` address into Safari.
2. On that page, tap **Install the Buddy certificate**. This is what lets a web
   page use the microphone.
3. Tap **Allow** when Safari says it downloaded a profile.
4. **Settings → General → VPN & Device Management → Buddy → Install.**
5. **Settings → General → About → Certificate Trust Settings** → turn on the
   switch for **Buddy Local CA**.
6. Back on the page, tap **Open Buddy**, then **Share → Add to Home Screen**.

That's it — he now opens full-screen from his own icon.

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
| **Gear icon** | Which computer he is on, which model he thinks with, and a switch for him speaking out loud. |

On the Mac, the menu-bar violet blob has: **Wake Up and Talk** (⌥Space),
**Point Here** (⌃⌥P), **Eyes Follow My Mouse** (⌃⌥F), **Stop Him** (⌃⌥S),
**Let Him Use the Computer**, moods, cursor size, **Brain (local model)…** and
personality.

For him to click and type, macOS asks once for **Accessibility** permission
(**Allow Clicking and Typing (Accessibility)…** in his menu) and once for
**Screen Recording** (he asks the first time he looks at your screen).

---

## Just want to see him first?

```sh
./start.sh --demo
```

No Mac app, no model: his face, his moods and a scripted little conversation, in
your browser. Good for checking the phone side before the rest is set up.

---

## If something goes wrong

| What you see | What it means |
| --- | --- |
| "Looking for your computer…" | The phone server has not found `Buddy.app`. Check the violet blob is in the menu bar (not faded) and both devices are on the same Wi-Fi. Blocked Bonjour? Start it with `BUDDY_HOST=your-mac.local BUDDY_PORT=8737 ./start.sh`. |
| "The microphone needs a trusted connection" | Step 3 was not finished. Redo steps 4–5 in the Certificate Trust Settings screen. |
| "I can't reach the model on your computer" | Ollama is not running. Run `ollama serve`, and check you have pulled a model (`ollama pull llama3.2`). |
| He answers but seems to know nothing current | A small local model has no live knowledge. Ask him to **research** something and he will search the web first. |
| A new Wi-Fi or a new IP | `node companion/server.mjs --regen-certs`, then reinstall the profile on the phone. |
| Port already in use | He takes the next free port and prints it — just use the address he shows. |
| "This browser has no speech recognition" | Voice needs Safari or Chrome on the phone. Other browsers can still type to him. |

### What runs where

| Piece | Who does the thinking |
| --- | --- |
| Talking with him (hold the screen) | The phone's own speech recognition hears you; **Ollama** on your Mac answers; the phone's own speech speaks the reply |
| Looking at your screen, pointing, clicking, typing | The Mac runs the tools; the local model decides which to use |
| Research | A free DuckDuckGo search, then the local model writes the report and lists the pages it used |
| Meeting notes | Local Whisper (via `whisper-cpp`) transcribes each recorded chunk |

No key is stored anywhere and nothing is uploaded: the model, the speech and the
search all run on hardware you control.
