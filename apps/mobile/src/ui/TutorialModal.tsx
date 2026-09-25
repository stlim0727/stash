import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import { usePalette } from '@/theme';
import { Button } from '@/ui/Button';

export interface TutorialModalProps {
  visible: boolean;
  onClose: () => void;
}

interface TutorialSlide {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  badgeKey: MessageKey;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  points: { icon: keyof typeof Ionicons.glyphMap; textKey: MessageKey }[];
}

const SLIDES: TutorialSlide[] = [
  {
    key: 'capture',
    icon: 'flash-outline',
    badgeKey: 'tutorial.step1.badge',
    titleKey: 'tutorial.step1.title',
    bodyKey: 'tutorial.step1.body',
    points: [
      { icon: 'share-outline', textKey: 'tutorial.step1.point1' },
      { icon: 'create-outline', textKey: 'tutorial.step1.point2' },
      { icon: 'cloud-offline-outline', textKey: 'tutorial.step1.point3' },
    ],
  },
  {
    key: 'inbox',
    icon: 'file-tray-full-outline',
    badgeKey: 'tutorial.step2.badge',
    titleKey: 'tutorial.step2.title',
    bodyKey: 'tutorial.step2.body',
    points: [
      { icon: 'layers-outline', textKey: 'tutorial.step2.point1' },
      { icon: 'open-outline', textKey: 'tutorial.step2.point2' },
      { icon: 'search-outline', textKey: 'tutorial.step2.point3' },
    ],
  },
  {
    key: 'review',
    icon: 'sparkles-outline',
    badgeKey: 'tutorial.step3.badge',
    titleKey: 'tutorial.step3.title',
    bodyKey: 'tutorial.step3.body',
    points: [
      { icon: 'bulb-outline', textKey: 'tutorial.step3.point1' },
      { icon: 'shield-checkmark-outline', textKey: 'tutorial.step3.point2' },
      { icon: 'checkmark-done-circle-outline', textKey: 'tutorial.step3.point3' },
    ],
  },
  {
    key: 'graph',
    icon: 'git-network-outline',
    badgeKey: 'tutorial.step4.badge',
    titleKey: 'tutorial.step4.title',
    bodyKey: 'tutorial.step4.body',
    points: [
      { icon: 'map-outline', textKey: 'tutorial.step4.point1' },
      { icon: 'git-merge-outline', textKey: 'tutorial.step4.point2' },
      { icon: 'compass-outline', textKey: 'tutorial.step4.point3' },
    ],
  },
];

/**
 * Reusable introductory feature tutorial modal.
 *
 * Walks beginners through Stash's 4 core UX pillars:
 * 1. Instant Capture (OS share sheet & memos)
 * 2. Smart Inbox (card/list view, fast search, direct link-out)
 * 3. AI Triage (batch review of non-destructive tag/summary suggestions)
 * 4. Knowledge Graph (interactive map connecting bookmarks and tags)
 *
 * Accessible via the empty Inbox onboarding state and the Settings screen.
 */
export function TutorialModal({ visible, onClose }: TutorialModalProps) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);

  // Reset to first slide whenever opened.
  useEffect(() => {
    if (visible) {
      setStep(0);
    }
  }, [visible]);

  // Support web keyboard shortcuts: Left/Right to navigate, Escape to dismiss.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight') {
        setStep((s) => Math.min(s + 1, SLIDES.length - 1));
      } else if (e.key === 'ArrowLeft') {
        setStep((s) => Math.max(s - 1, 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, onClose]);

  const slide = SLIDES[step];
  const isLast = step === SLIDES.length - 1;

  const handleNext = useCallback(() => {
    if (isLast) {
      onClose();
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, onClose]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  if (!slide) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="tutorial-modal"
    >
      <Pressable
        style={[
          styles.backdrop,
          {
            paddingTop: Math.max(insets.top + 16, 24),
            paddingBottom: Math.max(insets.bottom + 16, 24),
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('tutorial.closeA11y')}
        onPress={onClose}
      >
        {/* Swallow backdrop clicks on the card itself */}
        <Pressable
          style={[
            styles.card,
            {
              backgroundColor: palette.card,
              borderColor: palette.border,
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          {/* Header Row: Step indicator + Close Button */}
          <View style={styles.headerRow}>
            <View
              style={[
                styles.stepBadge,
                { backgroundColor: palette.accentSoft },
              ]}
            >
              <Text style={[styles.stepBadgeText, { color: palette.accentText }]}>
                {t(slide.badgeKey)}
              </Text>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('tutorial.closeA11y')}
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && { opacity: 0.6 },
              ]}
              testID="tutorial-close-button"
            >
              <Ionicons name="close" size={20} color={palette.textSecondary} />
            </Pressable>
          </View>

          {/* Slide Content */}
          <View style={styles.slideBody} testID={`tutorial-slide-${step}`}>
            <View
              style={[
                styles.heroIconCircle,
                { backgroundColor: palette.accentSoft },
              ]}
            >
              <Ionicons name={slide.icon} size={36} color={palette.accent} />
            </View>

            <Text style={[styles.slideTitle, { color: palette.text }]}>
              {t(slide.titleKey)}
            </Text>

            <Text
              style={[styles.slideDescription, { color: palette.textSecondary }]}
            >
              {t(slide.bodyKey)}
            </Text>

            {/* Feature Points */}
            <View style={styles.pointsList}>
              {slide.points.map((pt, idx) => (
                <View
                  key={idx}
                  style={[
                    styles.pointRow,
                    { backgroundColor: palette.mutedSurface },
                  ]}
                >
                  <Ionicons
                    name={pt.icon}
                    size={16}
                    color={palette.accent}
                    style={styles.pointIcon}
                  />
                  <Text
                    style={[styles.pointText, { color: palette.text }]}
                    numberOfLines={2}
                  >
                    {t(pt.textKey)}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* Footer: Progress Dots + Actions */}
          <View style={styles.footer}>
            <View
              style={styles.dotsRow}
              accessible
              accessibilityRole="tablist"
              accessibilityLabel={t('tutorial.stepIndicator', {
                current: step + 1,
                total: SLIDES.length,
              })}
            >
              {SLIDES.map((_, idx) => (
                <Pressable
                  key={idx}
                  accessibilityRole="tab"
                  accessibilityLabel={t('tutorial.stepIndicator', {
                    current: idx + 1,
                    total: SLIDES.length,
                  })}
                  accessibilityState={{ selected: idx === step }}
                  onPress={() => setStep(idx)}
                  hitSlop={8}
                  testID={`tutorial-dot-${idx}`}
                  style={[
                    styles.dot,
                    idx === step
                      ? [styles.activeDot, { backgroundColor: palette.accent }]
                      : { backgroundColor: palette.border },
                  ]}
                />
              ))}
            </View>

            <View style={styles.actionsRow}>
              {step > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={handleBack}
                  testID="tutorial-back-button"
                  style={styles.navButton}
                >
                  {t('tutorial.back')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={onClose}
                  testID="tutorial-skip-button"
                  style={styles.navButton}
                >
                  {t('tutorial.skip')}
                </Button>
              )}

              <Button
                variant="primary"
                size="sm"
                onPress={handleNext}
                testID="tutorial-next-button"
                style={styles.navButton}
              >
                {isLast ? t('tutorial.getStarted') : t('tutorial.next')}
              </Button>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 16,
    ...Platform.select({
      web: {
        boxShadow: '0px 16px 36px rgba(0, 0, 0, 0.22)',
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.22,
        shadowRadius: 20,
        elevation: 6,
      },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  stepBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  closeButton: {
    padding: 4,
    borderRadius: 12,
  },
  slideBody: {
    alignItems: 'center',
    gap: 12,
  },
  heroIconCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  slideTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  slideDescription: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  pointsList: {
    width: '100%',
    gap: 8,
    marginTop: 4,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 10,
  },
  pointIcon: {
    flexShrink: 0,
  },
  pointText: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  footer: {
    marginTop: 6,
    gap: 14,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  activeDot: {
    width: 22,
    borderRadius: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  navButton: {
    minWidth: 90,
  },
});
