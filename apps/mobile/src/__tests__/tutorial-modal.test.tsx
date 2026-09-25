import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { TutorialModal } from '@/ui/TutorialModal';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe('TutorialModal', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  test('does not render content when not visible', async () => {
    const screen = await render(
      <TutorialModal visible={false} onClose={onClose} />,
    );
    expect(screen.queryByTestId('tutorial-slide-0')).toBeNull();
  });

  test('renders Slide 0 on open and allows navigating forward through all 4 slides', async () => {
    const screen = await render(
      <TutorialModal visible={true} onClose={onClose} />,
    );

    // Slide 0: Capture
    expect(screen.getByTestId('tutorial-slide-0')).toBeTruthy();
    expect(screen.getByText('Capture without leaving your flow')).toBeTruthy();
    expect(screen.getByText('1-tap OS Share Sheet integration')).toBeTruthy();

    // On slide 0, Skip is shown instead of Back
    expect(screen.getByTestId('tutorial-skip-button')).toBeTruthy();
    expect(screen.queryByTestId('tutorial-back-button')).toBeNull();

    // Next -> Slide 1: Inbox
    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-next-button'));
    });
    expect(screen.getByTestId('tutorial-slide-1')).toBeTruthy();
    expect(screen.getByText('Browse your way, find in milliseconds')).toBeTruthy();
    expect(screen.getByTestId('tutorial-back-button')).toBeTruthy();

    // Next -> Slide 2: AI Triage
    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-next-button'));
    });
    expect(screen.getByTestId('tutorial-slide-2')).toBeTruthy();
    expect(screen.getByText('Save now, organize with AI later')).toBeTruthy();

    // Next -> Slide 3: Knowledge Graph (Final slide)
    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-next-button'));
    });
    expect(screen.getByTestId('tutorial-slide-3')).toBeTruthy();
    expect(screen.getByText('Watch your knowledge connect')).toBeTruthy();
    expect(screen.getByText('Get Started')).toBeTruthy();

    // Press Get Started -> calls onClose
    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-next-button'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('back button navigates to previous slide', async () => {
    const screen = await render(
      <TutorialModal visible={true} onClose={onClose} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-next-button')); // to slide 1
    });
    expect(screen.getByTestId('tutorial-slide-1')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-back-button')); // back to slide 0
    });
    expect(screen.getByTestId('tutorial-slide-0')).toBeTruthy();
  });

  test('clicking a dot jumps directly to that slide', async () => {
    const screen = await render(
      <TutorialModal visible={true} onClose={onClose} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-dot-2'));
    });
    expect(screen.getByTestId('tutorial-slide-2')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-dot-3'));
    });
    expect(screen.getByTestId('tutorial-slide-3')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-dot-0'));
    });
    expect(screen.getByTestId('tutorial-slide-0')).toBeTruthy();
  });

  test('close button and skip button dismiss modal', async () => {
    const screen = await render(
      <TutorialModal visible={true} onClose={onClose} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-close-button'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('tutorial-skip-button'));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
