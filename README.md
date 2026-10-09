# bini-deploy

**Zero-config deployment for [Bini.js](https://binijs.com) projects - web, desktop, and mobile, all from one CLI.**

`bini-deploy` scans your project, generates the right hosting configuration for your target platform, and pushes it straight to GitHub. No YAML spelunking, no platform-specific docs to read first.

[![npm version](https://img.shields.io/npm/v/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![npm downloads](https://img.shields.io/npm/dm/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/bini-deploy.svg)](https://nodejs.org)
[![vite](https://img.shields.io/badge/vite-8-646cff.svg?logo=vite&logoColor=white)](https://vitejs.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

---

## Features

- **Web hosting, generated for you** - Netlify, Vercel, Cloudflare Workers, or Deno Deploy. Picks the right adapter, writes the config file, and wires up your API routes automatically.
- **File-based API routing** - drop files in `src/app/api/`, `bini-deploy` scans them and mounts each one as a route (dynamic segments and catch-alls included).
- **Correct SPA fallback and real 404s** - extension-less paths (`/about`, `/dashboard/settings`) fall back to `index.html`, while missing files (`robots.txt`, `ai-catalog.json`, `favicon.ico`…) return a genuine `404` - using the `404.html` your build produces - instead of being answered with `index.html`.
- **Automatic CORS** - API routes get permissive CORS headers (`Access-Control-Allow-Origin: *`) out of the box on every non-Node hosting adapter (Netlify, Vercel, Cloudflare, Deno), so your frontend can call them without extra setup.
- **Native platform support** - Windows, macOS, Linux, iOS, and Android via Tauri/Capacitor, with tailored next-step instructions for each.
- **Git push built in** - initializes the repo if needed, sets up git identity and authentication if they're missing, commits, and pushes, so `bini-deploy` is genuinely one command from zero to deployed.
- **Automatic git identity setup** - if `user.name`/`user.email` aren't configured, `bini-deploy` prompts for them once and sets them for the repository only (never touches your global identity).
- **Automatic GitHub authentication** - if a push is rejected because of bad or missing credentials, `bini-deploy` prompts for a username and Personal Access Token and saves it through git's credential store, so future pushes to that host won't prompt again.
- **Clear, specific push failures** - a rejected push is classified (bad credentials, repository not found, or genuinely diverged history) so you get an accurate error and the right recovery step instead of one generic failure.
- **Interactive or scriptable** - walk through prompts, or skip them entirely with flags for CI.
- **Automatic platform cleanup** - removes entry files, config files, and directories left over from a previously selected platform every time you deploy, including when you switch back to Node or to a native platform.
- **Always pushes to main** - never pushes to `master`.
- **Hono support** - detects Hono apps and mounts them correctly.
- **Dependency checks** - for adapters that import `hono` as an npm package (Vercel, Cloudflare), verifies it's installed before generating an entry and tells you the exact install command if it's missing. Netlify and Deno Deploy import Hono from a URL, so no local install is required for those.

## Installation

```bash
npm install --save-dev bini-deploy
# or
pnpm add -D bini-deploy
# or
yarn add -D bini-deploy
```

## Quick start

Interactive mode - just run it and answer the prompts:

```bash
npx bini-deploy
```

Non-interactive mode - for scripts and CI:

```bash
npx bini-deploy --platform web --hosting vercel --repo https://github.com/you/your-app --yes
```

## Usage

```
bini-deploy [options]
```

| Flag | Description |
|------|-------------|
| `--platform <type>` | Target platform: `web`, `windows`, `macos`, `ios`, `linux`, `android` |
| `--hosting <name>` | Hosting provider (web only): `node` (default with `--yes`), `netlify`, `vercel`, `cloudflare`, `deno` |
| `--repo <url>` | GitHub repository URL, e.g. `https://github.com/you/your-app` |
| `--generate-entry <host>` | Generate the production API entry file only (`netlify`, `vercel`, `cloudflare`, `deno`) |
| `--yes`, `-y` | Skip interactive prompts and use the flags provided (`--platform` and `--repo` are required) |
| `--help`, `-h` | Show usage information |

Without `--yes`, `bini-deploy` needs an interactive terminal (TTY) and exits with an error otherwise. `--hosting` is only used when `--platform` is `web`.

### Examples

```bash
# Deploy a web app to Vercel, non-interactively
bini-deploy --platform web --hosting vercel --repo https://github.com/you/your-app --yes

# Deploy a desktop build for Windows
bini-deploy --platform windows --repo https://github.com/you/your-app -y

# Generate only the Netlify API entry file (useful for debugging)
bini-deploy --generate-entry netlify

# Just run it and follow the prompts
bini-deploy
```

> `--generate-entry` only writes the API entry file (no hosting config, no git push), but it still runs the platform cleanup described below.

## Supported hosting providers

| Provider | Runtime | Files generated |
|----------|---------|-----------------|
| **Node.js** (default) | Node (`bini-server`) | None - `bini-server` handles build/serve, `bini-deploy` just pushes to GitHub |
| **Netlify** | Edge Functions (Deno) | `netlify.toml`, `netlify/edge-functions/spa-fallback.ts`, and `netlify/edge-functions/api.ts` (API entry) |
| **Vercel** | Node.js Runtime | `vercel.json`, `api/index.ts` (API entry), and `api/tsconfig.json` (TypeScript projects only) |
| **Cloudflare Workers** | Workers | `wrangler.toml` and `worker.ts` (API entry + SPA fallback) |
| **Deno Deploy** | Deno | `server/index.ts` (API entry + static file server + SPA fallback) - no config file |

Notes:

- **API entry files** (`api.ts`, `api/index.ts`, `worker.ts`, `server/index.ts`) are only generated when `src/app/api/` exists and contains at least one route. Otherwise that step is skipped with a warning. The extension is `.ts` for TypeScript projects and `.js` otherwise (this also applies to Netlify's `spa-fallback`, which is always generated).
- Node is the default because Bini.js ships with `bini-server`, a zero-dependency production server (`npm run build && npm start`). Choosing it skips config generation entirely - `bini-deploy` just cleans up and pushes.
- On Vercel, `api/tsconfig.json` extends your root `tsconfig.json` with `types: []` and `skipLibCheck: true`. Vercel's function builder type-checks `api/*.ts` a second time using the nearest tsconfig, and this stops it from failing to resolve project-level types such as `node` or `vite/client`. Your own type check is unaffected.
- Cloudflare's generated `wrangler.toml` always points `main` at `worker.ts`, and expects a `dist` build output.

## Static files, SPA fallback, and 404s

For a single-page app, "page" URLs should serve `index.html`, but a missing static file should be a real `404` - otherwise `/robots.txt` or `/ai-catalog.json` would silently return HTML. The rule on every generated adapter is the same:

- **Path has a file extension** (`.txt`, `.json`, `.png`, …) and doesn't exist → real `404`, using your build's `404.html` where the host supports it.
- **Path has no file extension** and doesn't exist → `index.html` (client-side routing takes over).
- **`/api/*`** → handled by your API routes, never by the SPA fallback.

How each host implements it:

| Provider | Mechanism |
|----------|-----------|
| **Vercel** | `vercel.json` rewrites: `/api/(.*)` → `/api/index`, and `/((?!.*\.[a-zA-Z0-9]+$).*)` → `/index.html` (extension-less paths only). Missing files fall through to Vercel's own `404.html` handling. |
| **Netlify** | `netlify.toml` redirects can't use regex or negation, so there is no `/* → /index.html` redirect. A generated edge function (`spa-fallback.ts`, or `.js` in JavaScript projects) runs on every non-API request and rewrites to `/index.html` only when the response is a `404` **and** the path has no extension. Netlify serves your `404.html` for everything else. Trade-off: that function runs on each non-API request. |
| **Cloudflare** | `wrangler.toml` sets `not_found_handling = "404-page"`, so Cloudflare serves your `404.html` natively. The worker falls back to `index.html` only for extension-less paths. |
| **Deno Deploy** | The generated server reads files from `./dist`, serves `./dist/404.html` (status 404) for missing files with an extension, and `./dist/index.html` for extension-less paths. Falls back to plain text if `404.html` doesn't exist. Common content types (`html`, `css`, `js`, `json`, `txt`, `xml`, `svg`, `ico`, `webmanifest`, `woff2`, `png`, `jpg`) are set; anything else is `application/octet-stream`. |
| **Node** | Handled by `bini-server`. |

> **Cloudflare:** don't change `not_found_handling` to `"single-page-application"` - Cloudflare would then serve `index.html` for missing files again, which defeats the rule above.

## API routes

Any `.ts` or `.js` file in `src/app/api/` becomes an API route:

```
src/app/api/
├── index.ts          → /api
├── users/
│   ├── index.ts       → /api/users
│   └── [id].ts        → /api/users/:id
└── posts/
    └── [...slug].ts    → /api/posts/*
```

Rules:

- `index` maps to its folder; `[param]` becomes `:param`; `[...name]` becomes a catch-all `*`.
- Files and folders starting with `_` or `.` are ignored (handy for helpers).
- Route and folder names may only contain letters, numbers, `_` and `-`; param names must be valid identifiers. Anything else is skipped with a warning.

Each plain route file should export a default handler that accepts a `Request` and returns a `Response` (or a JSON-serializable value):

```typescript
// src/app/api/users/[id].ts
export default async function handler(req: Request) {
  const id = new URL(req.url).pathname.split('/').pop();
  return { id, name: 'Ada Lovelace' };
}
```

Handler errors are caught and returned as `500 { "error": "Internal Server Error" }`.

> **Note on ESM projects:** if your `package.json` has `"type": "module"` (Bini.js projects do by default), Node's native ESM loader requires every relative import to include its file extension. `bini-deploy` generates its own imports with the correct `.js` extension for Vercel and Cloudflare (and `.ts` for Netlify and Deno), but if your route files import their own local helpers (e.g. `./utils`), include the extension too (`./utils.js`), or the deployed function can crash at invocation with `ERR_MODULE_NOT_FOUND` even though the build succeeds.

### Hono support

If a route file imports from `hono`, `bini-deploy` treats it as a Hono app and mounts it with `app.route('/api', yourApp)`. The mount point is always `/api` - **not** the file's path - so define the full sub-path inside your app:

```typescript
// src/app/api/hello.ts
import { Hono } from 'hono';

const app = new Hono();

app.get('/hello', (c) => c.json({ message: 'Hello from Hono!' }));
app.post('/hello', async (c) => {
  const body = await c.req.json();
  return c.json({ received: body });
});

export default app;
```

This serves `GET /api/hello` and `POST /api/hello`.

## How it works

1. **Clean** - removes leftover entry files, config files, and directories from any previously selected platform. This runs no matter what you pick next, including Node or a native platform.
2. **Scan** - scans `src/app/api/` for route files.
3. **Generate** - writes the platform-specific entry file and hosting configuration.
4. **Push** - stages everything, commits, and pushes to your GitHub repository.
5. **Deploy** - your hosting platform deploys from GitHub.

### What cleanup deletes

When you deploy to platform X, everything belonging to the *other* platforms is removed:

- their generated entry files and config files (`netlify.toml`, `vercel.json`, `wrangler.toml`), and
- their whole directories: **`netlify/`**, **`api/`** (Vercel), and **`server/`** (Deno) - each deleted recursively unless it belongs to the platform you selected.

If your project has its own `api/` or `server/` folder with unrelated code, move it before running `bini-deploy`.

### Native platforms

For `windows`, `macos`, `linux`, `ios`, and `android`, no hosting configuration is generated; `bini-deploy` cleans up, pushes, and prints next steps. Those steps assume your project already defines these scripts and tooling:

- Desktop (Tauri): `npm run tauri:dev` and `npm run build:<platform>`
- Mobile (Capacitor): `npx cap add <platform>` and `npm run build:<platform>`

### Git behavior

- **Existing remote** - if the project already has an `origin`, it's used as-is and never changed. Otherwise the provided URL is added as `origin`.
- **Staging** - `git add --all` stages **everything** in the working tree, so make sure your `.gitignore` is correct. The commit message is `chore: add deployment configuration`.
- **Always main** - the push is `git push -u origin HEAD:main`. If you're on another branch, `bini-deploy` checks out `main` if it exists, otherwise renames the current branch to `main`. New repositories are created with `git init -b main`.
- **Git identity** - if `user.name`/`user.email` aren't set, you're prompted once; they're stored in this repository's local config. In a non-interactive run with no identity, `bini-deploy` fails fast and prints the exact `git config` commands to run.
- **GitHub authentication** - if the push fails with an authentication error, you're prompted for a GitHub username and a Personal Access Token (with `repo` scope; GitHub no longer accepts account passwords over HTTPS). To remember it, `bini-deploy` runs `git config --global credential.helper store` and saves the credential with `git credential approve`. Note this is a **global** setting and the `store` helper keeps credentials in plain text in `~/.git-credentials`. If you'd rather use another helper (Git Credential Manager, macOS Keychain, …), configure it beforehand.
- **Remote-ahead recovery** - if the push is rejected because the remote has commits you don't have (e.g. GitHub auto-created a README), `bini-deploy` fetches `origin/main` and merges with `--allow-unrelated-histories -X ours`. For any file that exists on both sides, **your local version wins and the remote version is discarded**; files that only exist on the remote are merged in. A warning is printed before the merge. If the merge still fails, it stops and prints the manual recovery steps.
- **Accurate failure diagnostics** - failures are classified as authentication, repository not found, or non-fast-forward; the merge recovery above only runs for the last one. Other failures surface the raw git error.

## Requirements

- Node.js **>= 18**
- Vite **>= 6**
- A GitHub repository to push to (created ahead of time)
- `git` available on your `PATH`

## Contributing

Issues and pull requests are welcome. If you're adding a new hosting provider, extend `ADAPTERS` and `HOSTING_CONFIGS` and add a case to `generateHostingConfig` in `src/index.ts` - the config-driven structure means most providers only need a new entry, not new branching logic.

```bash
git clone https://github.com/Binidu01/bini-deploy
cd bini-deploy
pnpm install
pnpm build
```

## License

[MIT](./LICENSE)