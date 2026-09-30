// Jest uses native resolution by default; explicitly exercise the web storage reader.
const { readDurableBookmarks } = jest.requireActual<typeof import('@/storage/durable-snapshot')>('../storage/durable-snapshot.ts');

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
test('missing, denied, or malformed web storage never confirms the memory fallback', async () => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  expect(await readDurableBookmarks()).toBeNull();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('Storage denied'); } } });
  expect(await readDurableBookmarks()).toBeNull();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{invalid' } });
  expect(await readDurableBookmarks()).toBeNull();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '[null]' } });
  expect(await readDurableBookmarks()).toBeNull();
});
test('web confirmation reads the actual persisted bookmark snapshot', async () => {
  const records = [{ id: 'saved-record', title: 'Written to storage' }];
  const getItem = jest.fn(() => JSON.stringify(records));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem } });
  expect(await readDurableBookmarks()).toEqual(records);
  expect(getItem).toHaveBeenCalledWith('stash.bookmarks');
});
