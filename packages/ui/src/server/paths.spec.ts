import { describe, expect, it } from 'vitest';
import {
  apiBaseFor,
  CONFIG_ELEMENT_ID,
  contentTypeFor,
  injectApiBase,
  mountPathFor,
  rewriteRelativeAssets,
  safeAssetSegments,
  trimSlashes,
} from './paths.js';

describe('trimSlashes', () => {
  it('collapses and strips slashes', () => {
    expect(trimSlashes('/telescope//')).toBe('telescope');
    expect(trimSlashes('telescope')).toBe('telescope');
    expect(trimSlashes('/')).toBe('');
  });
});

describe('mountPathFor / apiBaseFor', () => {
  it('normalizes the mount and derives the api base', () => {
    expect(mountPathFor('/telescope')).toBe('/telescope');
    expect(mountPathFor('telescope/')).toBe('/telescope');
    expect(apiBaseFor('/telescope')).toBe('/telescope/api');
    expect(apiBaseFor('/')).toBe('/api');
  });
});

describe('contentTypeFor', () => {
  it('maps common extensions', () => {
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('main.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('unknown.xyz')).toBe('application/octet-stream');
  });
});

describe('safeAssetSegments', () => {
  it('normalizes safe paths', () => {
    expect(safeAssetSegments('assets/app.js')).toEqual(['assets', 'app.js']);
    expect(safeAssetSegments('./assets//app.js')).toEqual(['assets', 'app.js']);
    expect(safeAssetSegments(['assets', 'app.js'])).toEqual(['assets', 'app.js']);
  });
  it('rejects traversal and control chars', () => {
    expect(safeAssetSegments('../secret')).toBeNull();
    expect(safeAssetSegments('a/../../b')).toBeNull();
    expect(safeAssetSegments('a\\b')).toBeNull();
    expect(safeAssetSegments('a\0b')).toBeNull();
  });
});

describe('rewriteRelativeAssets', () => {
  it('rewrites relative ./ asset URLs to absolute mount-based URLs', () => {
    const html =
      '<script type="module" src="./assets/index-abc.js"></script>' +
      "<link rel='stylesheet' href='./assets/index-def.css'>";
    expect(rewriteRelativeAssets(html, '/telescope')).toBe(
      '<script type="module" src="/telescope/assets/index-abc.js"></script>' +
        "<link rel='stylesheet' href='/telescope/assets/index-def.css'>",
    );
  });

  it('honours a custom mount', () => {
    expect(rewriteRelativeAssets('<img src="./a.png">', '/__tele')).toBe(
      '<img src="/__tele/a.png">',
    );
  });

  it('leaves the html untouched at a root mount', () => {
    const html = '<script src="./assets/x.js"></script>';
    expect(rewriteRelativeAssets(html, '/')).toBe(html);
  });
});

describe('injectApiBase', () => {
  const block = (out: string) =>
    new RegExp(`<script type="application/json" id="${CONFIG_ELEMENT_ID}">([^]*?)</script>`).exec(
      out,
    );

  it('inserts the base as a JSON data block before </head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectApiBase(html, '/telescope/api');
    expect(JSON.parse(block(out)?.[1] ?? '')).toEqual({ apiBase: '/telescope/api' });
    expect(out.indexOf(CONFIG_ELEMENT_ID)).toBeLessThan(out.indexOf('</head>'));
  });
  it('never emits an executable inline script', () => {
    // A host CSP of `script-src 'self' 'nonce-…'` drops an inline script without a word, and the
    // console then 404s on every request while rendering fine. A data block cannot be refused.
    const out = injectApiBase('<head></head>', '/telescope/api');
    expect(out).not.toContain('window.__TELESCOPE_DASHBOARD_BASE__');
    expect(out).not.toMatch(/<script>/);
  });
  it('escapes a base that would otherwise close the data block early', () => {
    const out = injectApiBase('<head></head>', '/a</script><b>');
    expect(out.split('</script>')).toHaveLength(2);
    expect(JSON.parse(block(out)?.[1] ?? '').apiBase).toBe('/a</script><b>');
  });
  it('prepends when there is no head', () => {
    const out = injectApiBase('<body></body>', '/x/api');
    expect(out.startsWith('<script type="application/json"')).toBe(true);
  });
});
