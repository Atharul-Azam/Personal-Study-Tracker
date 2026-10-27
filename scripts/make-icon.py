"""Generates the app icon (build/icon.png, build/icon.ico, src/assets/icon.png).

Run:  python scripts/make-icon.py      (needs Pillow: pip install pillow)
The generated files are committed, so building the app does not require Python.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024  # draw large, then downscale for smooth edges


def draw_icon() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    teal, ink, paper = (43, 107, 100, 255), (37, 35, 31, 255), (255, 254, 251, 255)
    d.rounded_rectangle((32, 32, SIZE - 32, SIZE - 32), radius=220, fill=teal)

    # calendar sheet
    left, top, right, bottom = 200, 250, SIZE - 200, SIZE - 190
    d.rounded_rectangle((left, top, right, bottom), radius=70, fill=paper)
    d.rounded_rectangle((left, top, right, top + 170), radius=70, fill=ink)
    d.rectangle((left, top + 100, right, top + 170), fill=ink)
    for x in (left + 150, right - 150):                      # binder rings
        d.rounded_rectangle((x - 28, 190, x + 28, 330), radius=28, fill=paper, outline=teal, width=10)

    # check mark
    pts = [(350, 600), (470, 720), (690, 480)]
    d.line(pts, fill=teal, width=64, joint="curve")
    for p in (pts[0], pts[-1]):
        d.ellipse((p[0] - 32, p[1] - 32, p[0] + 32, p[1] + 32), fill=teal)
    return img


def main() -> None:
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "src" / "assets").mkdir(parents=True, exist_ok=True)
    big = draw_icon()
    png = big.resize((512, 512), Image.LANCZOS)
    png.save(ROOT / "build" / "icon.png")
    png.save(ROOT / "src" / "assets" / "icon.png")
    big.resize((256, 256), Image.LANCZOS).save(
        ROOT / "build" / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote build/icon.png, build/icon.ico, src/assets/icon.png")


if __name__ == "__main__":
    main()
