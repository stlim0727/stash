#!/usr/bin/env python3
"""Render a home-screen mockup placing the new Stash icon among other apps."""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(__file__)
ICON = os.path.normpath(os.path.join(
    HERE, "..", "..", "apps", "mobile", "assets", "images", "icon.png"))
OUT = "/tmp/stash-home-mockup.png"

SS = 2
WW, HH = 900 * SS, 1600 * SS  # phone canvas
R = 0


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(w, h, top, bot):
    g = Image.new("RGB", (1, h), 0)
    for y in range(h):
        g.putpixel((0, y), lerp(top, bot, y / (h - 1)))
    return g.resize((w, h))


def squircle_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size-1, size-1],
                                        radius=radius, fill=255)
    return m


FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
FONT_B = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"


def placeholder(size, color, glyph=None, gcolor=(255, 255, 255)):
    im = Image.new("RGBA", (size, size), color + (255,))
    if glyph:
        d = ImageDraw.Draw(im)
        f = ImageFont.truetype(FONT_B, int(size * 0.5))
        bb = d.textbbox((0, 0), glyph, font=f)
        d.text(((size-(bb[2]-bb[0]))/2 - bb[0],
                (size-(bb[3]-bb[1]))/2 - bb[1]), glyph, font=f, fill=gcolor)
    m = squircle_mask(size, int(size * 0.23))
    im.putalpha(m)
    return im


# wallpaper
bg = vgrad(WW, HH, (15, 23, 42), (30, 41, 59)).convert("RGBA")
# soft teal glow to tie in with the app
glow = Image.new("RGBA", (WW, HH), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([WW*0.1, HH*0.05, WW*0.9, HH*0.55], fill=(13, 148, 136, 60))
glow = glow.filter(ImageFilter.GaussianBlur(120*SS))
bg = Image.alpha_composite(bg, glow)

draw = ImageDraw.Draw(bg)

# clock
fc = ImageFont.truetype(FONT, int(150 * SS))
draw.text((WW/2, 150*SS), "9:41", font=fc, fill=(255, 255, 255, 235), anchor="mm")
fd = ImageFont.truetype(FONT, int(36 * SS))
draw.text((WW/2, 250*SS), "Saturday, June 21", font=fd,
          fill=(226, 232, 240, 200), anchor="mm")

# grid of apps
icon_sz = int(150 * SS)
cols = 4
margin = int(70 * SS)
gap_x = (WW - 2*margin - cols*icon_sz) // (cols - 1)
top = int(360 * SS)
gap_y = int(70 * SS)
label_f = ImageFont.truetype(FONT, int(28 * SS))

apps = [
    ((59, 130, 246), "M", "Mail"), ((34, 197, 94), "P", "Phone"),
    ((168, 85, 247), "A", "Notes"), ((249, 115, 22), "C", "Cal"),
    ((14, 165, 233), "S", "Safari"), ((236, 72, 153), "P", "Photos"),
    ("STASH", None, "Stash"), ((100, 116, 139), "S", "Settings"),
    ((250, 204, 21), "N", "News"), ((20, 184, 166), "M", "Maps"),
    ((239, 68, 68), "Y", "Music"), ((96, 165, 250), "T", "Tasks"),
]

stash = Image.open(ICON).convert("RGBA").resize((icon_sz, icon_sz), Image.LANCZOS)
stash.putalpha(squircle_mask(icon_sz, int(icon_sz * 0.23)))

for i, (color, glyph, name) in enumerate(apps):
    r, c = divmod(i, cols)
    x = margin + c * (icon_sz + gap_x)
    y = top + r * (icon_sz + gap_y + int(40*SS))
    # subtle drop shadow
    sh = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    sm = squircle_mask(icon_sz, int(icon_sz*0.23))
    shimg = Image.new("RGBA", (icon_sz, icon_sz), (0, 0, 0, 110))
    shimg.putalpha(sm.point(lambda v: int(v*0.45)))
    sh.paste(shimg, (x, y+int(8*SS)), shimg)
    sh = sh.filter(ImageFilter.GaussianBlur(10*SS))
    bg = Image.alpha_composite(bg, sh)
    if color == "STASH":
        tile = stash
        highlight = True
    else:
        tile = placeholder(icon_sz, color, glyph)
        highlight = False
    bg.paste(tile, (x, y), tile)
    d2 = ImageDraw.Draw(bg)
    d2.text((x + icon_sz/2, y + icon_sz + int(26*SS)), name, font=label_f,
            fill=(255, 255, 255, 240), anchor="mm")
    if highlight:
        d2.rounded_rectangle([x-6*SS, y-6*SS, x+icon_sz+6*SS, y+icon_sz+6*SS],
                             radius=int(icon_sz*0.27), outline=(45, 212, 191, 255),
                             width=int(5*SS))

# dock
dock_y = HH - int(230*SS)
dock = Image.new("RGBA", bg.size, (0, 0, 0, 0))
ImageDraw.Draw(dock).rounded_rectangle(
    [margin*0.7, dock_y, WW-margin*0.7, dock_y+int(180*SS)],
    radius=int(60*SS), fill=(255, 255, 255, 38))
dock = dock.filter(ImageFilter.GaussianBlur(2*SS))
bg = Image.alpha_composite(bg, dock)
dock_apps = [((59, 130, 246), "P"), ((34, 197, 94), "M"),
             ((168, 85, 247), "S"), ("STASH", None)]
dsz = int(140*SS)
dgap = (WW - 2*int(margin*1.1) - 4*dsz)//3
for i, (color, glyph) in enumerate(dock_apps):
    x = int(margin*1.1) + i*(dsz+dgap)
    y = dock_y + int(20*SS)
    if color == "STASH":
        t = Image.open(ICON).convert("RGBA").resize((dsz, dsz), Image.LANCZOS)
        t.putalpha(squircle_mask(dsz, int(dsz*0.23)))
    else:
        t = placeholder(dsz, color, glyph)
    bg.paste(t, (x, y), t)

bg.convert("RGB").resize((900, 1600), Image.LANCZOS).save(OUT)
print("wrote", OUT)
