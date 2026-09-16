"""Regenerate the Feno Bridge desktop icons (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1] / "assets"
SIZE = 1024


def rounded_line(draw: ImageDraw.ImageDraw, points, width: int, fill: str) -> None:
    draw.line(points, fill=fill, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def main() -> None:
    background = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient_pixels = gradient.load()
    for y in range(SIZE):
        blend = y / (SIZE - 1)
        color = tuple(round(a * (1 - blend) + b * blend) for a, b in zip((27, 75, 91), (10, 27, 40)))
        for x in range(SIZE):
            gradient_pixels[x, y] = (*color, 255)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((34, 34, 990, 990), radius=210, fill=255)
    background.paste(gradient, (0, 0), mask)

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((228, 540, 796, 990), fill=(57, 222, 205, 50))
    background = Image.alpha_composite(background, glow.filter(ImageFilter.GaussianBlur(70)))

    draw = ImageDraw.Draw(background)
    draw.rounded_rectangle((34, 34, 990, 990), radius=210, outline=(139, 241, 232, 75), width=10)
    draw.arc((211, 568, 813, 916), 186, 354, fill="#4BDBC9", width=62)
    rounded_line(draw, [(330, 260), (330, 742)], 101, "#F7FCFE")
    rounded_line(draw, [(330, 260), (724, 260)], 101, "#F7FCFE")
    rounded_line(draw, [(330, 486), (646, 486)], 101, "#F7FCFE")

    background.save(ROOT / "icon.png")
    background.save(
        ROOT / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    (ROOT / "icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
        '  <defs><linearGradient id="bg" x2="0" y2="1">'
        '<stop stop-color="#1B4B5B"/><stop offset="1" stop-color="#0A1B28"/>'
        '</linearGradient></defs>\n'
        '  <rect x="34" y="34" width="956" height="956" rx="210" fill="url(#bg)" '
        'stroke="#508C95" stroke-width="10"/>\n'
        '  <path d="M241 738 A301 174 0 0 1 783 738" fill="none" '
        'stroke="#4BDBC9" stroke-width="62" stroke-linecap="round"/>\n'
        '  <path d="M330 742 V260 H724 M330 486 H646" fill="none" '
        'stroke="#F7FCFE" stroke-width="101" stroke-linecap="round" '
        'stroke-linejoin="round"/>\n'
        '</svg>\n',
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
