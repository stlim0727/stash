# Implementation Plan: Web Screenshot Interop (STASH-28) & Web Layout Sheet/FABs (STASH-29)

This plan details the changes required to address two desktop-web bugs:
1. **STASH-28**: Fix the feedback screenshot checkbox being hidden on web due to interop load issues with `html2canvas` and timeout constraint.
2. **STASH-29**: Align the FAB buttons closer to the centered inbox content container on web, and display the Add Bookmark screen as a right-side slide-over sheet instead of a full-screen presentation on desktop.

As per user preferences, these two independent fixes will be committed and proposed via separate git branches and PRs to keep them isolated.

---

## Proposed Changes: Part 1 (STASH-28: Web Feedback Screenshot Checkbox)

**Target Branch:** `agent/fix-web-report-screenshot`

### Components & Files

#### [MODIFY] [screenshot.ts](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/feedback/screenshot.ts)
- Modify the dynamic import of `html2canvas` to support both ESM and CommonJS default exports in the Metro bundler.
- Adjust the destructuring assignment to retrieve `html2canvas` using the interop fallback pattern:
  ```typescript
  const html2canvasModule = await import('html2canvas');
  const html2canvas = html2canvasModule.default ?? html2canvasModule;
  ```

#### [MODIFY] [FloatingReportButton.tsx](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/feedback/FloatingReportButton.tsx)
- Import `Platform` from `'react-native'`.
- Increase `SCREENSHOT_CAPTURE_TIMEOUT_MS` on web from `1200` to `4000` to accommodate slow DOM clone/render times by `html2canvas`.
  ```typescript
  const SCREENSHOT_CAPTURE_TIMEOUT_MS = Platform.OS === 'web' ? 4000 : 1200;
  ```

---

## Proposed Changes: Part 2 (STASH-29: Web FAB Layout & Add Bookmark Sheet)

**Target Branch:** `agent/fix-web-layout-add-sheet`

### Components & Files

#### [MODIFY] [_layout.tsx](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/app/_layout.tsx)
- In the navigation stack registration for `add`, change the screen presentation options to matching `report` and `settings`:
  ```tsx
  <Stack.Screen
    name="add"
    options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
  />
  ```

#### [MODIFY] [add.tsx](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/app/add.tsx)
- Import `useWindowDimensions`, `Platform`, and `Pressable` from `'react-native'`.
- Import `Ionicons` from `'@expo/vector-icons'`.
- Import `useSafeAreaInsets` from `'react-native-safe-area-context'`.
- Determine whether to render as a sheet:
  ```typescript
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const asSheet = width >= 760;
  ```
- Re-architect the return tree:
  - If `asSheet` is true, render a drawer modal overlay:
    - Backdrop `Pressable` that calls `router.back()` on press.
    - Side sheet panel constrained to `maxWidth: 460` (or `520`), right-aligned.
    - Custom header with a title and close button calling `router.back()`.
  - If `asSheet` is false, render the full-screen view (like the current one, but wrapping it with a custom header since `headerShown` is now false).

#### [MODIFY] [index.tsx](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/app/index.tsx)
- Position the `+` FAB dynamically on web:
  - Calculate `marginX = Math.max(0, (winWidth - contentMaxWidth) / 2)`.
  - Pass the calculated `right: Platform.OS === 'web' ? marginX + 20 : 20` style dynamically to the FAB wrapper.

#### [MODIFY] [FloatingReportButton.tsx](file:///c:/Users/stlim/.gemini/antigravity-ide/scratch/stash/apps/mobile/src/feedback/FloatingReportButton.tsx)
- Position the feedback report FAB dynamically on web:
  - Add `const { width: winWidth } = useWindowDimensions();`.
  - Calculate `marginX = Math.max(0, (winWidth - 720) / 2)`.
  - Apply dynamic positioning `right: Platform.OS === 'web' ? marginX + 16 : 16` to `styles.button`.

---

## Verification Plan

### Automated Verification
- Run `pnpm typecheck` to verify complete type safety.
- Run `pnpm test` and `pnpm test:components` to verify no regressions in domain or components logic.
- Run `CI=1 pnpm exec expo export --platform web` in `apps/mobile` to verify clean production bundles.

### Manual Verification
- We will serve a local web build (`pnpm dev:web` or `expo export` local server) to verify:
  1. The feedback screenshot checkbox is successfully loaded and functional on web.
  2. The FAB buttons are aligned close to the centered inbox column on desktop viewports.
  3. The `+` button opens the Add Bookmark screen as a right-side drawer panel with a dim backdrop on widescreen desktop.
