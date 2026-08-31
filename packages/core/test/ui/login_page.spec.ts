import { describe, expect, it } from 'vitest';
import { renderLoginPage } from '../../src/ui/login_page.js';

describe('renderLoginPage', () => {
  const html = renderLoginPage('/telescope');

  it('keeps the "Sign in — Telescope" title', () => {
    expect(html).toContain('<title>Sign in — Telescope</title>');
  });

  it('requires username but leaves password optional (no HTML `required`)', () => {
    const usernameInput = html.match(/<input id="username"[^>]*>/)?.[0];
    const passwordInput = html.match(/<input id="password"[^>]*>/)?.[0];
    expect(usernameInput).toContain('required');
    expect(passwordInput).toBeDefined();
    expect(passwordInput).not.toContain('required');
  });

  it('mirrors the dark zinc / emerald palette', () => {
    expect(html).toContain('#09090b');
    expect(html).toContain('#18181b');
    expect(html).toContain('#34d399');
    expect(html).toContain('ui-monospace');
  });

  it('posts to `<basePath>/login`, as a real form AND from the script', () => {
    expect(html).toContain('<form id="login-form" method="post" action="/telescope/login"');
    expect(html).toContain('"/telescope/login"');
  });

  it('works without JavaScript: returnTo rides in a hidden field, defaulting to the base path', () => {
    expect(html).toContain('<input type="hidden" name="returnTo" value="/telescope" />');
    expect(renderLoginPage('')).toContain('name="returnTo" value="/"');
    const deep = renderLoginPage('/telescope', { returnTo: '/telescope/runs/42' });
    expect(deep).toContain('name="returnTo" value="/telescope/runs/42"');
    expect(deep).toContain(JSON.stringify('/telescope/runs/42'));
  });

  it('refuses an open-redirect returnTo and escapes what it echoes', () => {
    for (const bad of ['//evil.com', 'https://evil.com/x', 'runs', 42, undefined]) {
      expect(renderLoginPage('/telescope', { returnTo: bad })).toContain(
        'name="returnTo" value="/telescope"',
      );
    }
    const quoted = renderLoginPage('/telescope', {
      returnTo: '/telescope/x"><script>alert(1)</script>',
    });
    expect(quoted).not.toContain('<script>alert(1)');
    expect(quoted).toContain('value="/telescope/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    // Inside the inline script the value is JSON with `<`/`>` escaped, so the HTML parser cannot
    // see a premature `</script>`: the page still has exactly one closing script tag.
    expect(quoted).toContain('\\u003c/script\\u003e');
    expect(quoted.split('</script>')).toHaveLength(2);
  });

  it('shows the error notice server-side for the no-JS round trip', () => {
    expect(html).toContain('<p id="error" role="alert">');
    expect(renderLoginPage('/telescope', { error: true })).toContain(
      '<p id="error" role="alert" style="display:block">',
    );
  });

  it('carries the CSP nonce on both the <style> and the <script>', () => {
    const nonced = renderLoginPage('/telescope', { nonce: 'n0nce"x' });
    expect(nonced).toContain('<style nonce="n0nce&quot;x">');
    expect(nonced).toContain('<script nonce="n0nce&quot;x">');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  it('embeds basePath via JSON so a quote in it cannot break out of the script', () => {
    // basePath is developer-controlled config, but it is still injected through JSON.stringify so a
    // stray quote is escaped rather than closing the string literal / injecting script.
    const injected = renderLoginPage('/tele"scope');
    expect(injected).toContain(JSON.stringify('/tele"scope/login'));
    expect(injected).not.toContain('"/tele"scope/login"');
  });
});
