#!/usr/bin/env python3
"""Generate app-icon concept PNGs for Stash.

Renders each concept at 4x (SSAA) then downsamples for crisp anti-aliasing.
Outputs 1024px masters, a rounded-corner iOS-style preview, a small 96px
legibility check, and a contact sheet comparing all concepts.
"""
import math
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 1024            # final master size
SS = 4              # supersample factor
W = S * SS          # working size


# ---------------------------------------------------------------- helpers
def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def vertical_gradient(size, top, bottom):
    """Smooth vertical gradient image."""
    grad = Image.new("RGB", (1, size), 0)
    for y in range(size):
        grad.putpixel((0, y), lerp_color(top, bottom, y / (size - 1)))
    return grad.resize((size, size))


def diagonal_gradient(size, c1, c2):
    """Diagonal (TL->BR) gradient using a rotated tall gradient."""
    big = int(size * 1.5)
    g = Image.new("RGB", (1, big), 0)
    for y in range(big):
        g.putpixel((0, y), lerp_color(c1, c2, y / (big - 1)))
    g = g.resize((big, big)).rotate(45, expand=True, resample=Image.BICUBIC)
    left = (g.width - size) // 2
    top = (g.height - size) // 2
    return g.crop((left, top, left + size, top + size))


def radial_glow(size, center, radius, color, max_alpha):
    """Soft radial glow as an RGBA layer."""
    layer = Image.new("L", (size, size), 0)
    px = layer.load()
    cx, cy = center
    r2 = radius * radius
    for y in range(size):
        for x in range(size):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if d2 < r2:
                t = 1 - math.sqrt(d2) / radius
                px[x, y] = int(max_alpha * (t ** 2))
    out = Image.new("RGBA", (size, size), color + (0,))
    out.putalpha(layer)
    return out


def bookmark_path(cx, cy, w, h, notch):
    """Classic bookmark ribbon: rounded top, V-notch bottom. Returns polygon
    pts for the body (sans rounded corners) -- corners added separately."""
    half = w / 2
    return [
        (cx - half, cy - h / 2),
        (cx + half, cy - h / 2),
        (cx + half, cy + h / 2),
        (cx, cy + h / 2 - notch),
        (cx - half, cy + h / 2),
    ]


def draw_bookmark(draw, cx, cy, w, h, notch, radius, fill):
    """Draw a bookmark with rounded top corners + sharp V notch."""
    half = w / 2
    top = cy - h / 2
    bot = cy + h / 2
    # main rounded-top rectangle region
    draw.rounded_rectangle([cx - half, top, cx + half, bot], radius=radius,
                           fill=fill)
    # square off the bottom rounded corners by overpainting a rect
    draw.rectangle([cx - half, cy, cx + half, bot], fill=fill)
    # cut the V-notch by painting it with transparent — handled by caller mask
    return (cx - half, top, cx + half, bot)


def notch_triangle(cx, cy, w, h, notch):
    half = w / 2
    bot = cy + h / 2
    return [(cx - half, bot), (cx, bot - notch), (cx + half, bot)]


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def finalize(img):
    """Downsample working image to master size."""
    return img.resize((S, S), Image.LANCZOS)


def drop_shadow(shape_rgba, blur, offset, color=(0, 0, 0), alpha=120):
    """Return an RGBA shadow layer from a shape's alpha channel."""
    a = shape_rgba.split()[-1]
    sh = Image.new("RGBA", shape_rgba.size, color + (0,))
    solid = Image.new("L", shape_rgba.size, 0)
    solid.paste(a, (0, 0))
    sh.putalpha(solid.point(lambda v: int(v / 255 * alpha)))
    sh = ImageChops.offset(sh, offset[0], offset[1])
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    return sh


# ---------------------------------------------------------------- concept 1
# "Stack" — three offset bookmark ribbons = a stash/collection, indigo gradient
def concept_stack():
    img = diagonal_gradient(W, (99, 102, 241), (37, 99, 235)).convert("RGBA")
    # subtle top glow
    img = Image.alpha_composite(
        img, radial_glow(W, (W * 0.32, W * 0.28), W * 0.55,
                         (255, 255, 255), 60))

    cx, cy = W / 2, W / 2
    bw, bh = W * 0.30, W * 0.46
    notch = bh * 0.20
    radius = W * 0.045

    # back ribbons (tinted), offset up-left and up-right for a fanned stack
    layers = [
        (-W * 0.085, -W * 0.055, (255, 255, 255, 90)),
        (W * 0.085, -W * 0.055, (255, 255, 255, 130)),
        (0, 0, (255, 255, 255, 255)),
    ]
    for dx, dy, fill in layers:
        shp = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(shp)
        ox, oy = cx + dx, cy + dy
        d.rounded_rectangle([ox - bw / 2, oy - bh / 2, ox + bw / 2, oy + bh / 2],
                            radius=radius, fill=fill)
        d.rectangle([ox - bw / 2, oy, ox + bw / 2, oy + bh / 2], fill=fill)
        # notch cut
        nm = Image.new("L", (W, W), 255)
        nd = ImageDraw.Draw(nm)
        nd.polygon(notch_triangle(ox, oy, bw, bh, notch), fill=0)
        a = shp.split()[-1]
        shp.putalpha(ImageChops.multiply(a, nm))
        if fill[3] == 255:
            img = Image.alpha_composite(img, drop_shadow(shp, W * 0.02,
                                        (0, int(W * 0.012)), alpha=110))
        img = Image.alpha_composite(img, shp)
    return finalize(img)


# ---------------------------------------------------------------- concept 2
# "Glow" — single bold ribbon, vibrant violet->magenta gradient, soft glow
def concept_glow():
    img = diagonal_gradient(W, (124, 58, 237), (236, 72, 153)).convert("RGBA")
    img = Image.alpha_composite(
        img, radial_glow(W, (W * 0.5, W * 0.42), W * 0.5,
                         (255, 255, 255), 70))
    cx, cy = W / 2, W * 0.5
    bw, bh = W * 0.38, W * 0.56
    notch = bh * 0.22
    radius = W * 0.06

    shp = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(shp)
    d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
                        radius=radius, fill=(255, 255, 255, 255))
    d.rectangle([cx - bw / 2, cy, cx + bw / 2, cy + bh / 2],
                fill=(255, 255, 255, 255))
    nm = Image.new("L", (W, W), 255)
    nd = ImageDraw.Draw(nm)
    nd.polygon(notch_triangle(cx, cy, bw, bh, notch), fill=0)
    shp.putalpha(ImageChops.multiply(shp.split()[-1], nm))

    # vertical sheen on the ribbon (white -> faint lilac)
    sheen = vertical_gradient(W, (255, 255, 255), (226, 232, 240)).convert("RGBA")
    sheen.putalpha(shp.split()[-1])

    img = Image.alpha_composite(img, drop_shadow(shp, W * 0.03,
                                (0, int(W * 0.018)), alpha=130))
    img = Image.alpha_composite(img, sheen)
    return finalize(img)


# ---------------------------------------------------------------- concept 3
# "Plus" — bookmark with an accent + tab, signalling "save / add", teal+lime
def concept_plus():
    img = diagonal_gradient(W, (13, 148, 136), (16, 185, 129)).convert("RGBA")
    img = Image.alpha_composite(
        img, radial_glow(W, (W * 0.7, W * 0.25), W * 0.5,
                         (190, 255, 230), 70))
    cx, cy = W * 0.46, W * 0.52
    bw, bh = W * 0.34, W * 0.52
    notch = bh * 0.22
    radius = W * 0.055

    shp = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(shp)
    d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
                        radius=radius, fill=(255, 255, 255, 255))
    d.rectangle([cx - bw / 2, cy, cx + bw / 2, cy + bh / 2],
                fill=(255, 255, 255, 255))
    nm = Image.new("L", (W, W), 255)
    nd = ImageDraw.Draw(nm)
    nd.polygon(notch_triangle(cx, cy, bw, bh, notch), fill=0)
    shp.putalpha(ImageChops.multiply(shp.split()[-1], nm))
    img = Image.alpha_composite(img, drop_shadow(shp, W * 0.028,
                                (0, int(W * 0.016)), alpha=120))
    img = Image.alpha_composite(img, shp)

    # accent "+" badge top-right (amber), like an add/save action
    badge = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bx, by = cx + bw * 0.55, cy - bh * 0.42
    br = W * 0.10
    bd.ellipse([bx - br, by - br, bx + br, by + br], fill=(251, 191, 36, 255))
    arm, th = br * 0.52, br * 0.20
    bd.rounded_rectangle([bx - arm, by - th, bx + arm, by + th], radius=th,
                         fill=(17, 94, 89, 255))
    bd.rounded_rectangle([bx - th, by - arm, bx + th, by + arm], radius=th,
                         fill=(17, 94, 89, 255))
    img = Image.alpha_composite(img, drop_shadow(badge, W * 0.02,
                                (0, int(W * 0.01)), alpha=110))
    img = Image.alpha_composite(img, badge)
    return finalize(img)


# ---------------------------------------------------------------- concept 4
# "Sunset" — energetic orange->pink gradient, bold ribbon with notch shadow
def concept_sunset():
    img = diagonal_gradient(W, (251, 146, 60), (239, 68, 68)).convert("RGBA")
    img = Image.alpha_composite(
        img, radial_glow(W, (W * 0.3, W * 0.2), W * 0.55,
                         (255, 237, 160), 90))
    cx, cy = W / 2, W * 0.5
    bw, bh = W * 0.38, W * 0.56
    notch = bh * 0.24
    radius = W * 0.06

    shp = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(shp)
    d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
                        radius=radius, fill=(255, 255, 255, 255))
    d.rectangle([cx - bw / 2, cy, cx + bw / 2, cy + bh / 2],
                fill=(255, 255, 255, 255))
    nm = Image.new("L", (W, W), 255)
    nd = ImageDraw.Draw(nm)
    nd.polygon(notch_triangle(cx, cy, bw, bh, notch), fill=0)
    shp.putalpha(ImageChops.multiply(shp.split()[-1], nm))

    img = Image.alpha_composite(img, drop_shadow(shp, W * 0.03,
                                (0, int(W * 0.02)), alpha=140))
    img = Image.alpha_composite(img, shp)

    # inner notch accent triangle (coral) to add depth at the V
    tri = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    td = ImageDraw.Draw(tri)
    inset = bh * 0.10
    td.polygon([(cx - bw / 2 + inset, cy + bh / 2 - inset * 0.3),
                (cx, cy + bh / 2 - notch),
                (cx + bw / 2 - inset, cy + bh / 2 - inset * 0.3)],
               fill=(239, 68, 68, 80))
    tri.putalpha(ImageChops.multiply(tri.split()[-1], shp.split()[-1]))
    img = Image.alpha_composite(img, tri)
    return finalize(img)


# ---------------------------------------------------------------- output
concepts = {
    "01-stack-indigo": concept_stack,
    "02-glow-violet": concept_glow,
    "03-plus-teal": concept_plus,
    "04-sunset": concept_sunset,
}

masters = {}
for name, fn in concepts.items():
    im = fn().convert("RGB")
    im.save(f"/home/user/stash/design/icon-concepts/{name}.png")
    masters[name] = im

# rounded iOS-style previews + small legibility checks
mask = rounded_mask(S, int(S * 0.225))
for name, im in masters.items():
    rr = im.convert("RGBA")
    rr.putalpha(mask)
    rr.save(f"/home/user/stash/design/icon-concepts/{name}-rounded.png")
    im.resize((96, 96), Image.LANCZOS).save(
        f"/home/user/stash/design/icon-concepts/{name}-96.png")

# contact sheet: 2x2 rounded previews on neutral bg with labels
pad, cell = 60, 460
sheet = Image.new("RGB", (pad * 3 + cell * 2, pad * 3 + cell * 2), (24, 24, 27))
for i, name in enumerate(concepts):
    rr = masters[name].convert("RGBA")
    rr.putalpha(rounded_mask(S, int(S * 0.225)))
    thumb = rr.resize((cell, cell), Image.LANCZOS)
    r, c = divmod(i, 2)
    x = pad + c * (cell + pad)
    y = pad + r * (cell + pad)
    sheet.paste(thumb, (x, y), thumb)
sheet.save("/home/user/stash/design/icon-concepts/_contact-sheet.png")
print("done")
