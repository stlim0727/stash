import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * Web-only: the static HTML shell wrapped around every route during
 * `expo export --platform web`. This runs in Node during static rendering (not
 * in the browser), so it must stay side-effect free.
 *
 * Beyond Expo's default template it wires up the PWA: the web manifest (which
 * declares the Web Share Target pointing at `/add`, so an installed Stash shows
 * up in the OS share sheet), the theme color, and an apple-touch-icon. The
 * manifest + icons are served from `public/`.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#208aef" />
        <link rel="apple-touch-icon" href="/icon-1024.png" />
        <meta name="mobile-web-app-capable" content="yes" />

        {/*
          Disable body scrolling on web so ScrollView components work as
          expected. Required by Expo Router's static rendering.
        */}
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
