import { configure } from '@testing-library/react';

// The console's components pull in the kit (Base UI, cmdk, …). Under a parallel `turbo test` the
// first render of a lazily-loaded page can spend over a second in the transformer, which is
// testing-library's default `waitFor` budget. 5s keeps the assertions about behaviour, not load.
configure({ asyncUtilTimeout: 5000 });
