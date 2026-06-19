import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import type { ReactNode } from 'react';

// Device locale is controllable per test (jest hoists the mock; the `mock`
// prefix lets the factory close over it).
const mockState: { locales: Array<{ languageTag: string; languageCode: string }> } = {
  locales: [{ languageTag: 'en-US', languageCode: 'en' }],
};
jest.mock('expo-localization', () => ({
  getLocales: () => mockState.locales,
}));
jest.mock('@/storage/repository', () => {
  const { createFakeRepositoryModule } = require('./helpers/fake-repository');
  return createFakeRepositoryModule();
});

import { I18nProvider, useI18n } from '@/i18n';
import { LOCALE_PREF_KEY } from '@/i18n/locale';

const repoMock = require('@/storage/repository') as {
  __reset: () => void;
  __meta: (key: string) => string | null;
};

function Probe() {
  const { t, locale, setLocalePreference } = useI18n();
  return (
    <>
      <Text testID="label">{t('common.cancel')}</Text>
      <Text testID="locale">{locale}</Text>
      <Pressable testID="to-ko" onPress={() => setLocalePreference('ko')}>
        <Text>ko</Text>
      </Pressable>
    </>
  );
}

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

beforeEach(() => {
  repoMock.__reset();
  mockState.locales = [{ languageTag: 'en-US', languageCode: 'en' }];
});

test('renders the device locale (English) by default', async () => {
  const screen = await wrap(<Probe />);
  await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe('en'));
  expect(screen.getByTestId('label').props.children).toBe('Cancel');
});

test('a Korean device renders Korean without any override', async () => {
  mockState.locales = [{ languageTag: 'ko-KR', languageCode: 'ko' }];
  const screen = await wrap(<Probe />);
  await waitFor(() => expect(screen.getByTestId('label').props.children).toBe('취소'));
  expect(screen.getByTestId('locale').props.children).toBe('ko');
});

test('a manual override switches language and is persisted', async () => {
  const screen = await wrap(<Probe />);
  await waitFor(() => expect(screen.getByTestId('label').props.children).toBe('Cancel'));

  await act(async () => {
    fireEvent.press(screen.getByTestId('to-ko'));
  });

  await waitFor(() => expect(screen.getByTestId('label').props.children).toBe('취소'));
  expect(screen.getByTestId('locale').props.children).toBe('ko');
  await waitFor(() => expect(repoMock.__meta(LOCALE_PREF_KEY)).toBe('ko'));
});
