#!/usr/bin/env python3
"""Draw Buddy's app icons — the violet blob with two eyes.

Run it after changing his colours so the home-screen icon on the phone matches
the face the canvas draws (`Web/face.js`):

    python3 scripts/make-icons.py

Writes Web/icons/{favicon,apple-touch-icon,icon-192,icon-512,icon-maskable}.png.
Needs Pillow (`pip install pillow`). Everything is supersampled 4x, then
downscaled, so the edges come out smooth.
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "Web" / "icons"

# The same four stops as Shared/Palette.swift and Web/face.js.
STOPS = [
    (0.0, (0xC9, 0xB2, 0xFF)),  # violet1, light lavender
    (0.34, (0x9A, 0x6B, 0xFF)),  # violet2, vivid violet
    (0.68, (0x6C, 0x3F, 0xE0)),  # violet3, deep violet
    (1.0, (0x3A, 0x1E, 0x78)),  # violet4, dark purple
]
INK = (0x17, 0x15, 0x1F)
WHITE = (0xFF, 0xFF, 0xFF)

SS = 4  # supersampling factor


def gradient_pixel(t: float) -> tuple[int, int, int]:
    """The gradient colour at position t (0 top-left … 1 bottom-right)."""
    t = min(max(t, 0.0), 1.0)
    for (p0, c0), (p1, c1) in zip(STOPS, STOPS[1:]):
        if t <= p1:
            f = (t - p0) / (p1 - p0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def draw_icon(size: int, fill: float) -> Image.Image:
    """One icon at `size` px; the blob fills `fill` of the canvas."""
    w = size * SS
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    # ── The gradient blob (a rounded square, like the design) ───────────────
    blob = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    px = blob.load()
    for y in range(w):
        for x in range(w):
            px[x, y] = (*gradient_pixel((x + y) / (2 * w)), 255)

    inset = round(w * (1 - fill) / 2)
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, w - inset, w - inset], radius=round(w * fill * 0.24), fill=255
    )
    canvas.paste(blob, (0, 0), mask)

    # ── His eyes: whites with dark pupils, a little above centre ────────────
    draw = ImageDraw.Draw(canvas)
    centre = w / 2
    eye_y = centre - w * fill * 0.02
    eye_dx = w * fill * 0.13
    eye_r = w * fill * 0.115
    pupil_r = eye_r * 0.52
    for side in (-1, 1):
        ex = centre + side * eye_dx
        draw.ellipse([ex - eye_r, eye_y - eye_r, ex + eye_r, eye_y + eye_r], fill=WHITE)
        draw.ellipse(
            [ex - pupil_r, eye_y - pupil_r, ex + pupil_r, eye_y + pupil_r], fill=INK
        )

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = {
        "favicon.png": (64, 0.84),
        "apple-touch-icon.png": (180, 0.9),
        "icon-192.png": (192, 0.92),
        "icon-512.png": (512, 0.92),
        # A maskable icon needs its art inside a safe zone, so it is smaller.
        "icon-maskable.png": (512, 0.7),
    }
    for name, (size, fill) in targets.items():
        draw_icon(size, fill).save(OUT / name)
        print(f"wrote {OUT / name} ({size}px)")


if __name__ == "__main__":
    main()
