# bini-deploy

**Zero-config deployment for [Bini.js](https://binijs.com) projects — web, desktop, and mobile, all from one CLI.**

`bini-deploy` scans your project, generates the right hosting configuration for your target platform, and pushes it straight to GitHub. No YAML spelunking, no platform-specific docs to read first.

[![npm version](https://img.shields.io/npm/v/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![npm downloads](https://img.shields.io/npm/dm/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/bini-deploy.svg)](https://nodejs.org)
[![vite](https://img.shields.io/badge/vite-8-646cff.svg?logo=vite&logoColor=white)](https://vitejs.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

---

## Features

- **Web hosting, generated for you** — Netlify, Vercel, Cloudflare Workers, or Deno Deploy. Picks the right adapter, writes the config file, and wires up your API routes automatically.
- **File-based API routing** — drop files in `src/app/api/`, `bini-deploy` scans them and mounts each one as a route (dynamic segments and catch-alls included).
- **Native platform support** — Windows, macOS, Linux, iOS, and Android via Tauri/Capacitor, with tailored next-step instructions for each.
- **Git push built in** — initializes the repo if needed, commits, and pushes, so `bini-deploy` is genuinely one command from zero to deployed.
- **Interactive or scriptable** — walk through prompts, or skip them entirely with flags for CI.
- **Automatic platform cleanup** — removes old configuration files and directories when switching platforms, keeping your repository clean.
- **Always pushes to main** — automatically handles branch naming, never pushes to master.
- **Hono support** — detects Hono apps and mounts them correctly.

## Installation

```bash
npm install --save-dev bini-deploy
# or
pnpm add -D bini-deploy
# or
yarn add -D bini-deploy
```

## Quick start

Interactive mode — just run it and answer the prompts:

```bash
npx bini-deploy
```

Non-interactive mode — for scripts and CI:

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
| `--hosting <name>` | Hosting provider (web only): `node` (default), `netlify`, `vercel`, `cloudflare`, `deno` |
| `--repo <url>` | GitHub repository URL, e.g. `https://github.com/you/your-app` |
| `--generate-entry <host>` | Generate production entry file only (netlify, vercel, cloudflare, deno) |
| `--yes`, `-y` | Skip interactive prompts and use the flags provided |
| `--help`, `-h` | Show usage information |

### Examples

```bash
# Deploy a web app to Vercel, non-interactively
bini-deploy --platform web --hosting vercel --repo https://github.com/you/your-app --yes

# Deploy a desktop build for Windows
bini-deploy --platform windows --repo https://github.com/you/your-app -y

# Generate only the Netlify entry file (useful for debugging)
bini-deploy --generate-entry netlify

# Just run it and follow the prompts
bini-deploy
```

## Supported hosting providers

| Provider | Runtime | Config generated |
|----------|---------|------------------|
| **Node.js** (default) | Node (`bini-server`) | None — `bini-server` handles build/serve out of the box, `bini-deploy` just pushes to GitHub |
| **Netlify** | Edge Functions (Deno) | `netlify.toml` + `netlify/edge-functions/api.ts` |
| **Vercel** | Edge Runtime | `vercel.json` + `api/index.ts` |
| **Cloudflare Workers** | Workers | `wrangler.toml` + `worker.ts` |
| **Deno Deploy** | Deno | `server/index.ts` |

Node is the default because Bini.js ships with `bini-server`, a zero-dependency production server (`npm run build && npm start`). Choosing it in the CLI skips config generation entirely — there's nothing to adapt, so `bini-deploy` just commits and pushes.

## API routes

Any file in `src/app/api/` becomes an API route, following the same conventions as file-based routers you're likely already used to:

```
src/app/api/
├── index.ts          → /api
├── users/
│   ├── index.ts       → /api/users
│   └── [id].ts        → /api/users/:id
└── posts/
    └── [...slug].ts    → /api/posts/*
```

Each route file should export a default handler that accepts a `Request` and returns a `Response` (or a JSON-serializable value):

```typescript
// src/app/api/users/[id].ts
export default async function handler(req: Request) {
  const id = new URL(req.url).pathname.split('/').pop();
  return { id, name: 'Ada Lovelace' };
}
```

### Hono support

If your route file imports from `hono`, `bini-deploy` detects it and mounts it as a full Hono app:

```typescript
// src/app/api/hello/route.ts
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.json({ message: 'Hello from Hono!' }));
app.post('/', async (c) => {
  const body = await c.req.json();
  return c.json({ received: body });
});

export default app;
```

## How it works

1. **Scan** — `bini-deploy` scans your `src/app/api/` directory for route files
2. **Generate** — Creates the platform-specific entry file and configuration
3. **Clean** — Removes old configuration files from other platforms
4. **Push** — Commits and pushes everything to your GitHub repository
5. **Deploy** — Your hosting platform automatically deploys from GitHub

### Git behavior

- **Existing remote** — If your project already has a git remote configured, `bini-deploy` uses it without modification
- **New projects** — If no remote exists, `bini-deploy` adds the provided URL as `origin`
- **No remote updates** — Once a remote is set, it is never changed or updated
- **Always main** — `bini-deploy` always pushes to the `main` branch, automatically renaming `master` to `main` if needed

This ensures you can run `bini-deploy` multiple times without accidentally pushing to the wrong repository.

## Requirements

- Node.js **>= 18**
- Vite **>= 6**
- A GitHub repository to push to (created ahead of time)
- `git` available on your `PATH`

## Contributing

Issues and pull requests are welcome. If you're adding a new hosting provider, extend `HOSTING_CONFIGS` and the generator functions in `src/index.ts` — the config-driven structure means most providers only need a new entry, not new branching logic.

```bash
git clone https://github.com/Binidu01/bini-deploy
cd bini-deploy
pnpm install
pnpm build
```

## License

[MIT](./LICENSE)
