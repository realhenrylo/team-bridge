# Agent Room website

Comic-style, responsive Chinese project website. Static HTML, CSS and JavaScript
are authored directly in `dist/`; no framework build or dependencies are needed.

- Production: https://agentroom.online
- Preview from repository root: `pnpm website:dev` (http://localhost:4173).
- Deploy from repository root: `pnpm website:deploy`.
- `dist/app.js` contains the Claude Code / Codex installation tabs and copy controls.

## Production deployment

`wrangler.website.jsonc` at the repository root configures an independent static
Worker named `agentteam-website`. Its custom domain is `agentroom.online`.
Cloudflare manages the DNS record and certificate for the custom domain.
The room service at `hub.agentroom.online` uses a separate Worker and config.

The domain is intentionally served directly by this Worker, not through Sites
custom-domain DNS. Do not configure a second deployment to manage this hostname.

## Sites copy

The initial website was also published at
https://agentteam.codex-tech.chatgpt.site. `.openai/hosting.json` identifies that
existing Sites project; reuse its project ID if updating that copy. Production
updates use `pnpm website:deploy`. For Sites releases, prepare an isolated
site-root checkout and push/package the exact validated source.

## Validation

Run `node --check website/dist/app.js` from the repository root. Verify local
asset references and anchor targets when editing HTML. The site uses native
`details` elements, keyboard-navigable installation tabs, reduced-motion support,
and clipboard error handling.
