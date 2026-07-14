import { describe, expect, it } from 'vitest';
import {
  apiBaseFor,
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
  it('inserts the base global before </head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectApiBase(html, '/telescope/api');
    expect(out).toContain('window.__TELESCOPE_DASHBOARD_BASE__="/telescope/api"');
    expect(out.indexOf('__TELESCOPE_DASHBOARD_BASE__')).toBeLessThan(out.indexOf('</head>'));
  });
  it('prepends when there is no head', () => {
    const out = injectApiBase('<body></body>', '/x/api');
    expect(out.startsWith('<script>')).toBe(true);
  });
});
