# Inbox feature

Keep the route thin and all feature modules outside Expo Router's `app/` tree.
The screen composes hooks and UI; search, result projection, selection, rendering,
and layout have separate entry points listed in the root task map.

Search must snapshot both pre-search collapse state and height. Preserve the
opening drag-dismiss suppression, web mousedown focus handling, and native
keyboard listener cleanup. Result projection remains local and pure apart from
facet routing; do not introduce fetches on focus or keystrokes. Placeholder,
inline-detail, and folder items must retain their discriminants and stable IDs.

Use inbox-screen, selection, folder management, back-handler, suggestion-shelf,
and facet-placeholder suites according to the changed behavior. Layout changes
must retain native overlay elevation and web stacking behavior.
