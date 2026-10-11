# The phone ↔ Mac checklist

Everything here needs two real things: **your Mac**, and **your own Gemini
key**. Nothing in this file can be checked by a test suite, and none of it has
been checked for you — this is the list to walk through once, sitting in front
of both devices. Tick a box only if you saw it happen.

Time: about twenty minutes, the first time.

```sh
git clone https://github.com/JustMehh123/Buddy.git
cd Buddy
./start.sh
```

The terminal prints something like:

```
Buddy's phone app is ready:
   1. On the phone (same Wi-Fi), open:   http://your-mac.local:8444/install?pair=…
      That page installs the little certificate he needs, then pairs the phone.
   2. Then add him to the home screen:    https://your-mac.local:8443/
```

## 1. He starts, and says where he is

- [ ] `./start.sh` finishes without a red error, and `Buddy` is in the menu bar
      (a blueberry, not faded).
- [ ] The terminal prints a QR code **and** the two addresses above. The
      `?pair=…` code is long and different every time you start him.
- [ ] If Bonjour is blocked on your network, `BUDDY_HOST=your-mac.local
      BUDDY_PORT=8737 ./start.sh` gets him found anyway (documented in
      QUICKSTART).
- [ ] The menu shows **Voice Key (free Gemini)…** — paste your key there. The
      menu should stop saying "no key".

## 2. The phone gets in

- [ ] Scanning the QR code with the phone's camera opens the install page.
- [ ] **Install the Buddy certificate**, then the two Settings steps (profile →
      Install, then Certificate Trust Settings → on).
- [ ] **Open Buddy** → the page shows his face and the status line says
      **Connected**.
- [ ] **Share → Add to Home Screen**, then open him from the icon: full screen,
      no Safari chrome.
- [ ] Gear icon → **This phone — paired with your Mac**.
- [ ] Now the part that matters: open the same address in a *different* browser
      (or a friend's phone) **without** the `?pair=` link. It must say
      **This phone is not paired** and refuse to do anything. That is the whole
      security story in one tap.

## 3. His real voice

- [ ] Hold the screen and say something. His mouth moves while you talk.
- [ ] Let go. Within a second or two he answers **out loud**, with a caption in
      the bubble at the same time.
- [ ] A second question works without reloading the page.
- [ ] Ask something with a fact in it ("what's the capital of Iceland") — the
      answer comes from the model, not a script.
- [ ] Leave the page idle for two minutes, then hold and talk. Still answers.
      (This is the bug that started all this: the credential used to be minted
      when the page loaded, and was dead by the time anyone spoke.)
- [ ] Double tap → he goes to sleep. Double tap → he wakes.

## 4. The microphone, and its fallbacks

- [ ] The first hold asks for microphone permission; **Allow**. If you said no,
      Safari → *aA* → Website Settings → Microphone → Allow, then reload.
- [ ] Put a headset on mid-conversation; he keeps hearing you.
- [ ] Toggle **hands-free** in the gear menu if it is there, and check that
      turns start and end without holding.
- [ ] Wi-Fi off, then hold and talk: he should fall back to the phone's own
      voice for the reply rather than going silent. Turn Wi-Fi back on.

## 5. His eyes, his pointing, and his hands

- [ ] "What's on my screen?" → he describes what is actually there. (The
      screenshot comes back as a still frame; the Mac owns the pixels.)
- [ ] "Point at the search bar" → he **points**; he does not click.
- [ ] "Click it" → *now* he clicks.
- [ ] "Open Safari and search for otters" → the window comes forward and the
      typing appears, step by step, not all at once.
- [ ] Open a page with a **password field** and ask him to fill it in: he must
      refuse. Type in it yourself and ask again: still refuses.
- [ ] Turn **computer use** off in the gear menu (or the Mac's menu) and ask him
      to click something. He must refuse *on the server side*, not just say no.
- [ ] Screenshot ordering: ask him to look, then to click — the answer about
      what he saw must come before the click, every time.

## 6. Endings and beginnings

- [ ] Lock the phone mid-sentence, unlock, and hold: he answers again.
- [ ] Put the Mac to sleep, then wake it: the phone shows *Looking for your
      computer…* and reconnects on its own within a few seconds.
- [ ] Walk out of Wi-Fi range and back: same.
- [ ] Ask a long question, let the session run for a few minutes past the
      token's half-hour, and keep talking: reconnections should be invisible
      (a fresh credential each time).
- [ ] Open the app from the home-screen icon twice in a row, quickly: you get
      one conversation, not two overlapping voices.
- [ ] Gear menu → **unpair**, then reload: refused, and the Mac is unharmed.
      `node companion/server.mjs --devices` no longer lists the phone.

## 7. Research and meeting notes

- [ ] "Look up …" or the research command → he comes back with a report card
      whose sources are real pages you can open.
- [ ] Record a minute of two people talking, stop, and let the notes land: the
      transcript has speaker labels (A, B) and the words are not summarised.
- [ ] Ask for a transcription while offline: it should say it failed, not hang
      forever or invent words.

## If something goes wrong

| What you see | What to send me |
| --- | --- |
| "No voice provider is available" | The exact wording from the menu-bar app's **Voice Key** sheet, and whether the key works at aistudio.google.com |
| "The voice service turned that credential away" | The full sentence, which names the reason |
| "This phone is not paired" | Whether the address in the phone's bar still has `?pair=…` (it should be gone after pairing) |
| His voice but no caption | Whether the caption appears if you ask again |
| Nothing at all | The terminal output from `./start.sh`, with your key removed |

The tests that *can* run without you are in QUICKSTART, under **Checking it
yourself**.
