#!/usr/bin/env python3
"""Build production icon assets for Stash from concept 03 (Plus / teal).

Outputs into apps/mobile/assets/images:
  icon.png                     1024 RGB   full app icon (gradient + mark)
  favicon.png                    48 RGBA  downscaled icon
  android-icon-background.png  1024 RGBA  teal gradient + glow (full bleed)
  android-icon-foreground.png 1024 RGBA  mark only, scaled to safe zone
  android-icon-monochrome.png 1024 RGBA  flat silhouette for themed icons
  splash-icon.png              512 RGBA  mark only on transparent
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SS = 4
W = 1024 * SS
# repo-relative: design/icon-source/ -> apps/mobile/assets/images
DST = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "apps", "mobile", "assets", "images"))

TEAL_TOP = (13, 148, 136)
TEAL_BOT = (16, 185, 129)
GLOW = (190, 255, 230)
AMBER = (251, 191, 36)
DEEP = (17, 94, 89)


def lerp_color(c1, c2, t):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3))


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


def shadow_from_alpha(alpha, blur, offset, a=120):
    sh = Image.new("RGBA", alpha.size, (0, 0, 0, 0))
    sh.putalpha(alpha.point(lambda v: int(v / 255 * a)))
    sh = ImageChops.offset(sh, offset[0], offset[1])
    return sh.filter(ImageFilter.GaussianBlur(blur))


# ---- background layer (teal gradient + corner glow) -------------------
def background():
    img = dgrad(W, TEAL_TOP, TEAL_BOT).convert("RGBA")
    return Image.alpha_composite(
        img, glow(W, (W * 0.7, W * 0.25), W * 0.5, GLOW, 70))


# ---- the logo mark (ribbon + amber "+" badge) ------------------------
# Rendered on its own transparent canvas so it can be scaled/placed freely.
# Returns (mark_rgba, silhouette_alpha) both full WxW, content centered.
def build_mark(scale):
    """scale = ribbon height as fraction of W."""
    cx, cy = W * 0.5, W * 0.5
    bh = W * scale
    bw = bh * (0.34 / 0.52)
    notch = bh * 0.22
    r = bw * 0.16

    # ribbon alpha
    ra = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(ra)
    d.rounded_rectangle([cx - bw/2, cy - bh/2, cx + bw/2, cy + bh/2],
                        radius=r, fill=255)
    d.rectangle([cx - bw/2, cy, cx + bw/2, cy + bh/2], fill=255)
    nm = Image.new("L", (W, W), 255)
    ImageDraw.Draw(nm).polygon(notch_tri(cx, cy, bw, bh, notch), fill=0)
    ra = ImageChops.multiply(ra, nm)

    # badge geometry (top-right of ribbon)
    bx, by = cx + bw * 0.55, cy - bh * 0.42
    br = bh * 0.21
    badge_a = Image.new("L", (W, W), 0)
    ImageDraw.Draw(badge_a).ellipse([bx-br, by-br, bx+br, by+br], fill=255)

    # compose colored mark
    mark = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    white = Image.new("RGBA", (W, W), (255, 255, 255, 255)); white.putalpha(ra)
    mark = Image.alpha_composite(mark, white)
    badge = Image.new("RGBA", (W, W), AMBER + (255,)); badge.putalpha(badge_a)
    mark = Image.alpha_composite(mark, badge)
    # plus glyph (deep teal) on badge
    pl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pl)
    arm, th = br * 0.52, br * 0.20
    pd.rounded_rectangle([bx-arm, by-th, bx+arm, by+th], radius=th, fill=DEEP+(255,))
    pd.rounded_rectangle([bx-th, by-arm, bx+th, by+arm], radius=th, fill=DEEP+(255,))
    mark = Image.alpha_composite(mark, pl)

    # silhouette = ribbon ∪ badge (for monochrome / shadow)
    sil = ImageChops.lighter(ra, badge_a)
    # plus alpha alone (for knocking out of the monochrome silhouette)
    plus_a = pl.split()[-1]
    return mark, sil, plus_a


def center_crop_box(alpha):
    bbox = alpha.getbbox()
    return bbox


def finalize(img, size):
    return img.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------- build
bg = background()

# Full app icon: mark fairly large, centered (slight optical left already
# baked into badge on the right, so keep geometric center).
mark_icon, sil_icon, _ = build_mark(0.52)
icon = bg.copy()
icon = Image.alpha_composite(icon, shadow_from_alpha(sil_icon, W*0.028, (0, int(W*0.016)), 120))
icon = Image.alpha_composite(icon, mark_icon)
icon_rgb = finalize(icon, 1024).convert("RGB")
icon_rgb.save(f"{DST}/icon.png")
icon_rgb.resize((48, 48), Image.LANCZOS).save(f"{DST}/favicon.png")

# Android background (full bleed gradient)
finalize(bg, 1024).save(f"{DST}/android-icon-background.png")

# Android foreground: mark scaled into the safe zone (~60% of canvas),
# transparent background, subtle shadow for depth.
mark_fg, sil_fg, plus_fg = build_mark(0.40)
fg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
fg = Image.alpha_composite(fg, shadow_from_alpha(sil_fg, W*0.022, (0, int(W*0.012)), 90))
fg = Image.alpha_composite(fg, mark_fg)
finalize(fg, 1024).save(f"{DST}/android-icon-foreground.png")

# Android monochrome: flat white silhouette (system tints it), same scale
mono = Image.new("RGBA", (W, W), (255, 255, 255, 0))
mono.putalpha(ImageChops.subtract(sil_fg, plus_fg))
finalize(mono, 1024).save(f"{DST}/android-icon-monochrome.png")

# Splash icon: mark on transparent (shown over teal splash bg), 512
mark_sp, sil_sp, _ = build_mark(0.46)
sp = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sp = Image.alpha_composite(sp, mark_sp)
finalize(sp, 512).save(f"{DST}/splash-icon.png")

print("assets written")
