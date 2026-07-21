#!/usr/bin/env python3
"""Generate demo book covers for Play Store screenshots.

Reads playstore/data.json and writes one PNG per book to playstore/artwork/,
using each book's `cover` palette (bg1 -> bg2 vertical gradient, fg text).
The PNGs are committed, so running this is only needed after editing data.json.

Requires Pillow (pip install pillow / apt install python3-pil).
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SIZE = 640
SERIF_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
SERIF = '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'
FALLBACKS = [
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
]


def load_font(paths, size):
    for path in paths:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def hex_rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def gradient(bg1, bg2):
    image = Image.new('RGB', (SIZE, SIZE))
    top, bottom = hex_rgb(bg1), hex_rgb(bg2)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(SIZE):
            image.putpixel((x, y), row)
    return image


def wrap(draw, text, font, max_width):
    words = text.split()
    lines, line = [], ''
    for word in words:
        candidate = f'{line} {word}'.strip()
        if draw.textlength(candidate, font=font) <= max_width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def make_cover(book, out_path):
    cover = book['cover']
    fg = hex_rgb(cover['fg'])
    image = gradient(cover['bg1'], cover['bg2'])
    draw = ImageDraw.Draw(image)

    # Double border frame
    draw.rectangle([24, 24, SIZE - 25, SIZE - 25], outline=fg, width=2)
    draw.rectangle([34, 34, SIZE - 35, SIZE - 35], outline=fg, width=1)

    title_font = load_font([SERIF_BOLD] + FALLBACKS[:1], 64)
    author_font = load_font([SERIF] + FALLBACKS[1:], 30)

    lines = wrap(draw, book['title'], title_font, SIZE - 140)
    line_height = 76
    block_height = len(lines) * line_height
    y = (SIZE - block_height) // 2 - 40

    for line in lines:
        width = draw.textlength(line, font=title_font)
        draw.text(((SIZE - width) / 2, y), line, font=title_font, fill=fg)
        y += line_height

    # Ornament rule between title and author
    y += 24
    draw.line([SIZE / 2 - 60, y, SIZE / 2 + 60, y], fill=fg, width=2)
    y += 36

    author = book['artist'].upper()
    width = draw.textlength(author, font=author_font)
    draw.text(((SIZE - width) / 2, y), author, font=author_font, fill=fg)

    image.save(out_path, optimize=True)


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'data.json')) as handle:
        data = json.load(handle)

    out_dir = os.path.join(root, 'artwork')
    os.makedirs(out_dir, exist_ok=True)

    for book in data['books']:
        if not book.get('artwork'):
            continue
        out_path = os.path.join(out_dir, book['artwork'])
        make_cover(book, out_path)
        print(f'wrote {os.path.relpath(out_path, root)}')


if __name__ == '__main__':
    sys.exit(main())
