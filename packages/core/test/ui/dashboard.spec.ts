import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/ui/dashboard.js';

describe('renderDashboard', () => {
  it('returns a self-contained HTML document', () => {
    const html = renderDashboard('/telescope/api');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Telescope</title>');
    // inline, no build step: styles + script live in the page
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  it('injects the supplied API base path and leaves no placeholder', () => {
    const html = renderDashboard('/telescope/api');
    expect(html).toContain("var API_BASE = '/telescope/api'");
    expect(html).not.toContain('__TELESCOPE_API_BASE__');
  });

  it('references the JSON API endpoints the page consumes', () => {
    const html = renderDashboard('/custom/api');
    expect(html).toContain("API_BASE + '/entries'");
    expect(html).toContain("API_BASE + '/entries/'");
    expect(html).toContain("API_BASE + '/stats'");
  });

  it('escapes a path that could break the script string', () => {
    const html = renderDashboard("/telescope'/api");
    expect(html).toContain("var API_BASE = '/telescope\\'/api'");
  });
});
