import assert from 'node:assert/strict';

import { ko } from '@/i18n/ko';
import { palettes } from '@/theme';

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const [theme, palette] of Object.entries(palettes)) {
  test(`${theme} tag cloud text meets 4.5:1 against its background`, () => {
    assert.ok(contrast(palette.accentText, palette.background) >= 4.5);
  });
  test(`${theme} primary button text meets 4.5:1 contrast`, () => {
    assert.ok(contrast(palette.accentForeground, palette.accent) >= 4.5);
  });
  for (const background of ['background', 'surface', 'mutedSurface', 'accentSoft'] as const) {
    test(`${theme} body, metadata and control outlines on ${background}`, () => {
      assert.ok(contrast(palette.text, palette[background]) >= 4.5);
      assert.ok(contrast(palette.textSecondary, palette[background]) >= 4.5);
      assert.ok(contrast(palette.controlBorder, palette[background]) >= 3);
    });
  }
}

test('new library and reporting copy has Korean translations', () => {
  for (const key of ['library.paused', 'library.retry', 'library.resume', 'library.saved', 'library.guest', 'library.failed', 'library.waiting', 'report.shareReport'] as const) {
    assert.ok(ko[key]);
  }
});
