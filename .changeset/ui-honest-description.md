---
'@adonis-agora/telescope-ui': patch
---

Correct the package description. It advertised a "dependency-light React SPA" with five views;
the published package depends on Base UI, `class-variance-authority`, `clsx` and `tailwind-merge`
and is built with Tailwind CSS, and the console has grown an overview, CPU profiles, live queue
and schedule consoles, extension pages and client-side exports. The description now says so, and
notes that the `/client` subpath remains a dependency-free fetch client.
