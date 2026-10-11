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
| Port already in use | He takes the next free port and prints it — just use the address he shows. |

A note on his two voices: on the **phone** he talks through Gemini's realtime
voice with the free key. On the **Mac** (⌥Space), the wake-and-talk loop still
uses OpenAI's realtime API, so that one asks for an OpenAI key; everything the
phone drives — looking at your screen, pointing, clicking, typing — works from
the free key alone.
