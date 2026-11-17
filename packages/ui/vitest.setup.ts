import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The console's components pull in the kit (Base UI, cmdk, …). Under a parallel `turbo test` the
// first render of a lazily-loaded page can spend over a second in the transformer, which is
// testing-library's default `waitFor` budget. 5s keeps the assertions about behaviour, not load.
configure({ asyncUtilTimeout: 5000 });

// Pages keep their filters in the URL hash (`#/entries?type=query&after=…`). jsdom keeps one
// `location` per file, so reset it after each test: a page-2 cursor or a filter left by one test
// must not open the next one filtered.
afterEach(() => {
  window.history.replaceState(null, '', '/');
});
