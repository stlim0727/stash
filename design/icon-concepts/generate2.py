#!/usr/bin/env python3
"""Second batch of Stash app-icon concepts (more variety + bolder looks)."""
import math
from PIL import Image, ImageDraw, ImageFilter, ImageChops, ImageOps, ImageFont

FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

S = 1024
SS = 4
W = S * SS
OUT = "/home/user/stash/design/icon-concepts"


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def vgrad(size, top, bottom):
    g = Image.new("RGB", (1, size), 0)
    for y in range(size):
        g.putpixel((0, y), lerp_color(top, bottom, y / (size - 1)))
    return g.resize((size, size))


def dgrad(size, c1, c2):
    big = int(size * 1.5)
    g = Image.new("RGB", (1, big), 0)
    for y in range(big):
        g.putpixel((0, y), lerp_color(c1, c2, y / (big - 1)))
    g = g.resize((big, big)).rotate(45, expand=True, resample=Image.BICUBIC)
    l = (g.width - size) // 2
    t = (g.height - size) // 2
    return g.crop((l, t, l + size, t + size))


def glow(size, center, radius, color, max_alpha):
    layer = Image.new("L", (size, size), 0)
    px = layer.load()
    cx, cy = center
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            if d < radius:
                px[x, y] = int(max_alpha * ((1 - d / radius) ** 2))
    out = Image.new("RGBA", (size, size), color + (0,))
    out.putalpha(layer)
    return out


def notch_tri(cx, cy, w, h, notch):
    half = w / 2
    bot = cy + h / 2
    return [(cx - half, bot), (cx, bot - notch), (cx + half, bot)]


def ribbon_alpha(cx, cy, bw, bh, notch, radius):
    """Return an L-mode alpha for a classic bookmark ribbon."""
    shp = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(shp)
    d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
                        radius=radius, fill=255)
    d.rectangle([cx - bw / 2, cy, cx + bw / 2, cy + bh / 2], fill=255)
    nm = Image.new("L", (W, W), 255)
    ImageDraw.Draw(nm).polygon(notch_tri(cx, cy, bw, bh, notch), fill=0)
    return ImageChops.multiply(shp, nm)


def shadow_from_alpha(alpha, blur, offset, a=120):
    sh = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sh.putalpha(alpha.point(lambda v: int(v / 255 * a)))
    sh = ImageChops.offset(sh, offset[0], offset[1])
    return sh.filter(ImageFilter.GaussianBlur(blur))


def fill_with(alpha, rgb_img):
    out = rgb_img.convert("RGBA")
    out.putalpha(alpha)
    return out


def finalize(img):
    return img.resize((S, S), Image.LANCZOS)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1],
                                        radius=radius, fill=255)
    return m


# -------- 05 Monogram "S": ribbon body with an S carved out (negative space)
def c_mono():
    img = dgrad(W, (56, 189, 248), (37, 99, 235)).convert("RGBA")
    img = Image.alpha_composite(img, glow(W, (W*.3, W*.25), W*.5, (255,255,255), 55))
    cx, cy = W/2, W*.5
    bw, bh, notch, r = W*.46, W*.62, W*.62*.18, W*.07
    alpha = ribbon_alpha(cx, cy, bw, bh, notch, r)
    ribbon = fill_with(alpha, Image.new("RGB", (W, W), (255, 255, 255)))
    # carve a clean "S" glyph (negative space -> gradient shows through)
    s = Image.new("L", (W, W), 0)
    sd = ImageDraw.Draw(s)
    font = ImageFont.truetype(FONT_BOLD, int(bh * 0.74))
    bb = sd.textbbox((0, 0), "S", font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    sd.text((cx - tw/2 - bb[0], (cy - bh*0.06) - th/2 - bb[1]), "S",
            font=font, fill=255)
    cut = ImageChops.subtract(alpha, s)
    ribbon.putalpha(cut)
    img = Image.alpha_composite(img, shadow_from_alpha(alpha, W*.025, (0, int(W*.014)), 120))
    img = Image.alpha_composite(img, ribbon)
    return finalize(img)


# -------- 06 Dark / neon: charcoal bg, glowing gradient ribbon
def c_neon():
    img = vgrad(W, (24, 24, 34), (10, 10, 16).__class__((10, 10, 16))).convert("RGBA") \
        if False else vgrad(W, (28, 27, 38), (12, 12, 20)).convert("RGBA")
    cx, cy = W/2, W*.5
    bw, bh, notch, r = W*.40, W*.58, W*.58*.22, W*.065
    alpha = ribbon_alpha(cx, cy, bw, bh, notch, r)
    grad = dgrad(W, (167, 139, 250), (236, 72, 153))
    ribbon = fill_with(alpha, grad)
    # neon outer glow: blurred colored copy
    neon = fill_with(alpha, grad).filter(ImageFilter.GaussianBlur(W*.03))
    halo = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    halo = Image.alpha_composite(halo, neon)
    img = Image.alpha_composite(img, halo)
    img = Image.alpha_composite(img, halo)  # intensify glow
    img = Image.alpha_composite(img, ribbon)
    return finalize(img)


# -------- 07 Dog-ear / 3D fold: bookmark with a folded corner for depth
def c_fold():
    img = dgrad(W, (45, 138, 239), (29, 78, 216)).convert("RGBA")
    img = Image.alpha_composite(img, glow(W, (W*.7, W*.25), W*.5, (200,230,255), 60))
    cx, cy = W/2, W*.5
    bw, bh, notch, r = W*.42, W*.58, W*.58*.22, W*.06
    alpha = ribbon_alpha(cx, cy, bw, bh, notch, r)
    base = fill_with(alpha, vgrad(W, (255, 255, 255), (224, 232, 245)))
    img = Image.alpha_composite(img, shadow_from_alpha(alpha, W*.03, (0, int(W*.02)), 130))
    img = Image.alpha_composite(img, base)
    # folded top-right corner triangle (shaded) for 3D
    fold = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fold)
    fs = bw*.42
    x2, y1 = cx + bw/2, cy - bh/2
    fd.polygon([(x2 - fs, y1), (x2, y1 + fs), (x2 - fs, y1 + fs)],
               fill=(150, 180, 220, 255))
    fold.putalpha(ImageChops.multiply(fold.split()[-1], alpha))
    img = Image.alpha_composite(img, fold)
    # the lifted corner casting onto body
    return finalize(img)


# -------- 08 Layered cards: stacked saved-link cards behind a ribbon
def c_cards():
    img = dgrad(W, (99, 102, 241), (139, 92, 246)).convert("RGBA")
    cx, cy = W/2, W*.52
    # three stacked rounded cards fanned
    for i, (dx, dy, a, sc) in enumerate([(-W*.11, W*.10, 150, .80),
                                          (-W*.02, W*.05, 200, .90),
                                          (W*.07, 0, 255, 1.0)]):
        cw, ch, r = W*.34*sc, W*.40*sc, W*.04
        ca = Image.new("L", (W, W), 0)
        ImageDraw.Draw(ca).rounded_rectangle(
            [cx+dx-cw/2, cy+dy-ch/2, cx+dx+cw/2, cy+dy+ch/2], radius=r, fill=a)
        card = fill_with(ca, Image.new("RGB", (W, W), (255, 255, 255)))
        img = Image.alpha_composite(img, shadow_from_alpha(ca, W*.015, (0, int(W*.008)), 80))
        img = Image.alpha_composite(img, card)
    # small ribbon badge sitting on the front card
    bx, by = cx + W*.07, cy - W*.05
    bw, bh, notch, r = W*.11, W*.17, W*.17*.28, W*.012
    alpha = ribbon_alpha(bx, by, bw, bh, notch, r)
    ribbon = fill_with(alpha, dgrad(W, (236, 72, 153), (239, 68, 68)))
    img = Image.alpha_composite(img, ribbon)
    return finalize(img)


# -------- 09 Cutout: ribbon as negative space punched out of a squircle
def c_cutout():
    grad = dgrad(W, (251, 113, 133), (124, 58, 237))
    img = grad.convert("RGBA")
    cx, cy = W/2, W*.5
    bw, bh, notch, r = W*.34, W*.50, W*.50*.22, W*.05
    alpha = ribbon_alpha(cx, cy, bw, bh, notch, r)
    # punch a white rounded panel then knock the ribbon out of it
    panel = Image.new("L", (W, W), 0)
    pm = W*.20
    ImageDraw.Draw(panel).rounded_rectangle([pm, pm, W-pm, W-pm], radius=W*.10, fill=255)
    knocked = ImageChops.subtract(panel, alpha)
    white = fill_with(knocked, Image.new("RGB", (W, W), (255, 255, 255)))
    img = Image.alpha_composite(img, shadow_from_alpha(panel, W*.02, (0, int(W*.012)), 70))
    img = Image.alpha_composite(img, white)
    return finalize(img)


# -------- 10 Spark: bookmark + lightning notch = fast capture
def c_spark():
    img = dgrad(W, (250, 204, 21), (245, 158, 11)).convert("RGBA")
    img = Image.alpha_composite(img, glow(W, (W*.3, W*.25), W*.5, (255,255,210), 80))
    cx, cy = W/2, W*.5
    bw, bh, notch, r = W*.40, W*.58, W*.58*.30, W*.06
    alpha = ribbon_alpha(cx, cy, bw, bh, notch, r)
    ribbon = fill_with(alpha, Image.new("RGB", (W, W), (30, 27, 75)))
    img = Image.alpha_composite(img, shadow_from_alpha(alpha, W*.028, (0, int(W*.016)), 120))
    img = Image.alpha_composite(img, ribbon)
    # lightning bolt cut (negative) inside the ribbon
    bolt = Image.new("L", (W, W), 0)
    bd = ImageDraw.Draw(bolt)
    bd.polygon([(cx+ W*.03, cy - bh*.30), (cx - W*.07, cy + bh*.02),
                (cx, cy + bh*.02), (cx - W*.03, cy + bh*.30),
                (cx + W*.08, cy - bh*.05), (cx + W*.005, cy - bh*.05)], fill=255)
    cut = ImageChops.subtract(alpha, bolt)
    ribbon2 = fill_with(cut, Image.new("RGB", (W, W), (30, 27, 75)))
    img2 = img.copy()
    # redraw ribbon with bolt knocked out so gradient shows through
    base = img2
    base = Image.alpha_composite(base, shadow_from_alpha(alpha, W*.028, (0, int(W*.016)), 120))
    return finalize(img)  # keep simple solid version


concepts = {
    "05-monogram-s": c_mono,
    "06-neon-dark": c_neon,
    "07-fold-3d": c_fold,
    "08-stacked-cards": c_cards,
    "09-cutout": c_cutout,
    "10-spark": c_spark,
}

masters = {}
for name, fn in concepts.items():
    im = fn().convert("RGB")
    im.save(f"{OUT}/{name}.png")
    masters[name] = im

mask = rounded_mask(S, int(S * 0.225))
for name, im in masters.items():
    rr = im.convert("RGBA"); rr.putalpha(mask)
    rr.save(f"{OUT}/{name}-rounded.png")
    im.resize((96, 96), Image.LANCZOS).save(f"{OUT}/{name}-96.png")

# contact sheet 2x3
pad, cell, cols = 50, 380, 3
rows = 2
sheet = Image.new("RGB", (pad*(cols+1)+cell*cols, pad*(rows+1)+cell*rows), (24,24,27))
for i, name in enumerate(concepts):
    rr = masters[name].convert("RGBA"); rr.putalpha(rounded_mask(S, int(S*0.225)))
    thumb = rr.resize((cell, cell), Image.LANCZOS)
    r, c = divmod(i, cols)
    sheet.paste(thumb, (pad+c*(cell+pad), pad+r*(cell+pad)), thumb)
sheet.save(f"{OUT}/_contact-sheet-2.png")
print("done")
