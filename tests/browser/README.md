# Browser checks

Run `npm ci`, `npx playwright install chromium`, then `npm run test:browser`.
Playwright starts Vite automatically. To use a locally installed Chromium browser,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

The tests intercept API requests with fixtures and delayed/error responses. They
check the real React interface without creating records on a backend.
`npm run test:ui` runs the API, domain and observation engine checks separately.
