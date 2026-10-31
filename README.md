# bini-deploy

**Zero-config deployment for [Bini.js](https://bini.js.org) projects: web hosting, or desktop, Android and iOS builds and releases on GitHub Actions, all from one CLI.**

`bini-deploy` generates the right configuration for the target you pick and pushes everything to a GitHub repository. For native targets it also uploads your code-signing values from `.env.signing` as GitHub repository secrets (using the GitHub CLI) and can offer to run `create-bini-app sign` for you. A single run deploys either **web** or **native** targets (see [One run, one kind of target](#one-run-one-kind-of-target)).

[![npm version](https://img.shields.io/npm/v/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![npm downloads](https://img.shields.io/npm/dm/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/bini-deploy.svg)](https://nodejs.org)
[![vite](https://img.shields.io/badge/vite-8-646cff.svg?logo=vite&logoColor=white)](https://vitejs.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

---

## Features

- **Web hosting, generated for you** - Netlify, Vercel, Cloudflare Workers, Deno Deploy, or Node. Writes the config file and wires up your API routes.
- **Native builds and releases on GitHub Actions** - copies `desktop.yml`, `android.yml` and `ios.yml` (Tauri) into `.github/workflows/`. Every push to `main` builds the app and attaches the installers to a GitHub release tagged `app-v<version>`. Builds run on GitHub, so you can deploy iOS without owning a Mac.
- **iOS works without Apple credentials** - with no signing credentials, the iOS workflow builds a simulator-only app and uploads it as the `ios-build` artifact instead of failing (no release is published for it).
- **File-based API routing** - files in `src/app/api/` are scanned and mounted as routes (dynamic segments and catch-alls included).
- **Prerendered pages and real 404s** - on Cloudflare and Deno Deploy, pages prerendered by `bini-ssg` are served directly and unknown routes return your build's `404.html` with a real `404` status. Missing files (`robots.txt`, `favicon.ico`...) return a real `404` on every host.
- **Automatic CORS** - API routes get `Access-Control-Allow-Origin: *` on every non-Node hosting adapter.
- **Signing secrets uploaded for you** - for native targets, deploy reads `.env.signing` and uploads the values for the selected targets with `gh secret set`, before pushing, so the first build already has them. If `.env.signing` is missing, an interactive run offers to create it with `create-bini-app sign`.
- **Package-manager aware** - the build command written to `netlify.toml` and `vercel.json`, and the printed next steps, follow your lockfile (bun, pnpm, yarn or npm), falling back to npm when there is no lockfile.
- **Git push built in** - initializes the repo if needed, sets a local git identity if missing, commits and pushes. Authentication is left to your git credential setup (Git Credential Manager recommended).
- **Always pushes to `main`**.
- **Dry run** - `--dry-run` skips the confirmation, the workflow copy, the secret upload and the push (it is not side-effect free, see [Usage](#usage)).
- **Interactive or scriptable** - prompts by default, or flags plus `--yes` for scripts.
- **Color output** - colors are disabled when `NO_COLOR` is set and forced on with `FORCE_COLOR`.

## Requirements

- Node.js **>= 20.19**
- Vite **>= 6**
- A GitHub repository to push to (created ahead of time), addressed as `https://github.com/<owner>/<repo>` (see [Git behavior](#git-behavior))
- `git` on your `PATH`, with working HTTPS credentials for GitHub (see [Git behavior](#git-behavior))
- A Bini.js project. For native targets, a Tauri project created by [`create-bini-app`](https://www.npmjs.com/package/create-bini-app) (see [Native builds](#native-builds-desktop-android-ios)). The Android and iOS workflows require a `version` field in `package.json`
- For native targets with signing: the GitHub CLI ([`gh`](https://cli.github.com)), installed and logged in (`gh auth login`), with permission to manage the repository's Actions secrets. Without `gh`, deploy still pushes, but you must add the secrets by hand
- For Cloudflare: a recent Wrangler version (array patterns for `run_worker_first`)

## Installation

```bash
npm install --save-dev bini-deploy
# or
pnpm add -D bini-deploy
# or
yarn add -D bini-deploy
```

Add a script if your project doesn't have one:

```json
{ "scripts": { "deploy": "bini-deploy" } }
```

## Quick start

Interactive, just answer the prompts:

```bash
npm run deploy
# or
npx bini-deploy
```

Non-interactive, for scripts and CI:

```bash
npx bini-deploy --platform web --hosting vercel --repo https://github.com/you/your-app --yes
```

## Usage

```text
bini-deploy [options]
```

| Flag | Description |
| --- | --- |
| `--platform <targets>` | `web`, or any of `desktop`, `android`, `ios`, comma-separated (e.g. `desktop,android`). `web` cannot be combined with the others. `windows`, `macos` and `linux` are accepted as aliases for `desktop` (with a warning: one workflow builds all three) |
| `--hosting <name>` | Hosting provider for web: `node` (default with `--yes`), `netlify`, `vercel`, `cloudflare`, `deno`. Ignored for native targets |
| `--repo <url>` | GitHub repository URL, e.g. `https://github.com/you/your-app` |
| `--generate-entry <host>` | Generate the production API entry file only (`netlify`, `vercel`, `cloudflare`, `deno`), then exit |
| `--message`, `-m <text>` | Commit message. Default: `chore: add deployment configuration`. When omitted in an interactive run, you are prompted (Enter keeps the default) |
| `--dry-run` | Skip the confirmation prompt, the workflow copy (native), the secret upload (native) and the git push. See the warning below |
| `--yes`, `-y` | Skip prompts and use the flags (`--platform` and `--repo` are required) |
| `--help`, `-h` | Show usage |

Unknown flags are rejected with an error. Without `--yes`, `bini-deploy` needs an interactive terminal and exits with an error otherwise. In interactive mode the prompts decide everything: `--platform`, `--hosting` and `--repo` are only read together with `--yes` (`--message` and `--dry-run` work in both modes). After the prompts, a summary is shown and you confirm before anything is generated or pushed (no confirmation is asked with `--dry-run`). `--generate-entry` needs no terminal.

> **`--dry-run` is not read-only.** It still runs the cleanup step, so leftover hosting files and directories are deleted (see [What cleanup deletes](#what-cleanup-deletes)). For web targets it still writes the hosting config and API entry files. For native targets it still runs the project check, and it only lists the workflow files it *would* write. It skips the workflow copy, the signing prompts, the secret upload and the push. Commit or back up your work first.

Exit codes: `0` on success, `1` on an error, `130` when you cancel (Ctrl+C), `143` on `SIGTERM`.

### One run, one kind of target

A run deploys **either** web **or** one or more native targets. Selecting `web` together with `desktop`, `android` or `ios` is rejected in the prompt and by `--platform`. Run `bini-deploy` once for each kind.

> **Order matters.** Deploying native targets removes all web hosting files, and deploying web removes the files of the other hosting providers (see [What cleanup deletes](#what-cleanup-deletes)). If you deploy native after web, commit or back up the hosting files you want to keep.

### Examples

```bash
# Web to Vercel, no prompts
bini-deploy --platform web --hosting vercel --repo https://github.com/you/your-app --yes

# Desktop, Android and iOS builds
bini-deploy --platform desktop,android,ios --repo https://github.com/you/your-app -y

# Custom commit message
bini-deploy --platform desktop --repo https://github.com/you/your-app -y -m "ci: add desktop build"

# Check which workflows would be written (nothing is copied, uploaded or pushed)
bini-deploy --platform desktop --repo https://github.com/you/your-app --dry-run -y

# Generate only the Netlify API entry file (no config, no push)
bini-deploy --generate-entry netlify

# Follow the prompts
bini-deploy
```

> `--generate-entry` writes only the API entry file, but it still removes leftover files from other hosting providers (see [What cleanup deletes](#what-cleanup-deletes)).

## Web hosting

| Provider | Runtime | Files generated |
| --- | --- | --- |
| **Node** (default with `--yes`) | Node (`bini-server`) | None. `bini-server` serves the build on `$PORT` (default 3000); `bini-deploy` cleans up and pushes |
| **Netlify** | Edge Functions (Deno) | `netlify.toml`, `netlify/edge-functions/api.ts`, `netlify/edge-functions/spa-fallback.ts` |
| **Vercel** | Node.js Runtime | `vercel.json`, `api/index.ts`, and `api/tsconfig.json` (TypeScript projects only) |
| **Cloudflare Workers** | Workers + Static Assets | `wrangler.toml`, `worker.ts` (handles `/api/*` only) |
| **Deno Deploy** | Deno | `server/index.ts` (API entry and static server for prerendered pages), no config file |

After a web deploy, `bini-deploy` prints provider-specific next steps (build command, publish directory, entrypoint and so on).

Notes:

- API entry files (`api.ts`, `api/index.ts`, `worker.ts`, `server/index.ts`) are only generated when `src/app/api/` exists and has at least one route. Otherwise that step is skipped with a warning. Extensions are `.ts` for TypeScript projects and `.js` otherwise (Netlify's `spa-fallback` follows the same rule).
- The config files are still written when the entry file is skipped, so they can point at a file that doesn't exist (`function = "api"` in `netlify.toml`, `main = "worker.ts"` in `wrangler.toml`), and Deno Deploy has no entrypoint at all. If your project has no API routes, add one before deploying to these hosts.
- For Vercel and Cloudflare, the generated entry imports `hono` from npm, so deploy checks that it's installed. If it isn't, deploy prints the install command and stops. Netlify and Deno import Hono from a URL (`hono@v4.3.11`), so no local install is needed.
- The build command written to `netlify.toml` and `vercel.json` uses your package manager (for example `pnpm run build`), detected from your lockfile (npm when there is none).
- On Vercel, `api/tsconfig.json` extends your root `tsconfig.json` with `types: []` and `skipLibCheck: true`, so Vercel's second type-check of `api/*.ts` doesn't fail on project-level types like `node` or `vite/client`.
- On Cloudflare, the Worker `name` comes from your repository name, lowercased and reduced to letters, digits and dashes (max 63 characters, falling back to `my-app`). `wrangler.toml` serves `./dist` as assets through the `ASSETS` binding and sets `compatibility_date = "2025-04-09"`.

### Static files, prerendered pages and 404s

| Provider | Extension-less paths (`/about`) |
| --- | --- |
| **Vercel** | Prerendered page if it exists, otherwise `index.html`. `vercel.json` rewrites `/api/(.*)` to `/api/index`, and extension-less paths to `/index.html`. |
| **Netlify** | Prerendered page if it exists, otherwise `index.html`. An edge function rewrites to `/index.html` only when the response is a `404` and the path has no extension. It runs on every non-API request. |
| **Cloudflare** | Prerendered page if it exists, otherwise `404.html` with status 404. `not_found_handling = "404-page"` and `run_worker_first = ["/api/*"]` are set in `wrangler.toml`. |
| **Deno Deploy** | Prerendered page, then the nearest `bini-ssg` shell (a parent `index.html` containing `__BINI_SHELL__`), otherwise `dist/404.html` with status 404. `index.html` is only used for `/`. |
| **Node** | Handled by `bini-server` |

Paths with a file extension that don't exist return a real `404` on every host. `/api/*` always goes to your API routes.

> **Cloudflare:** don't change `not_found_handling` to `"single-page-application"` and don't remove `run_worker_first`. With `404-page` enabled, Cloudflare answers unmatched paths with `404.html` without running your Worker, so `/api/*` would return the 404 page. **Dynamic routes on Cloudflare and Deno:** `bini-ssg` writes a shell for dynamic patterns at the parent path (`/blog/:id` becomes `dist/blog/index.html`). Deno serves that shell for `/blog/123`. Cloudflare only matches exact files, so `/blog/123` returns `404.html` there. A top-level dynamic route such as `/:id` has no parent shell and returns `404` on both. For client-only dynamic routes, use Vercel or Netlify.

### API routes

Any `.ts` or `.js` file in `src/app/api/` becomes a route:

```text
src/app/api/
├── index.ts          → /api
├── users/
│   ├── index.ts       → /api/users
│   └── [id].ts        → /api/users/:id
└── posts/
    └── [...slug].ts    → /api/posts/*
```

- `index` maps to its folder, `[param]` becomes `:param`, `[...name]` becomes a catch-all `*`.
- Files and folders starting with `_` or `.` are ignored.
- Names may only contain letters, numbers, `_` and `-` (max 100 characters); param names must be valid identifiers. Anything else is skipped with a warning. Directories nested deeper than 100 levels are not scanned.

A plain route file exports a default handler that takes a `Request` and returns a `Response` or a JSON-serializable value:

```typescript
// src/app/api/users/[id].ts
export default async function handler(req: Request) {
  const id = new URL(req.url).pathname.split('/').pop();
  return { id, name: 'Ada Lovelace' };
}
```

Errors thrown by a plain handler are caught and returned as `500 { "error": "Internal Server Error" }`.

> **ESM projects:** with `"type": "module"` (the Bini.js default), Node requires file extensions on relative imports. `bini-deploy` writes its own imports correctly, but if your route files import local helpers, include the extension (`./utils.js`) or the deployed function can crash with `ERR_MODULE_NOT_FOUND`.

#### Hono

If a route file imports from `hono` (detected by reading the file, up to 10 MB), it's mounted with `app.route('/api', yourApp)`. The mount point is always `/api`, not the file's path, so define the full sub-path inside the app:

```typescript
// src/app/api/hello.ts
import { Hono } from 'hono';

const app = new Hono();
app.get('/hello', (c) => c.json({ message: 'Hello from Hono!' }));

export default app;
```

This serves `GET /api/hello`.

## Native builds (desktop, Android, iOS)

Native targets are [Tauri](https://tauri.app) apps built by GitHub Actions. `bini-deploy` copies one workflow per target from its own templates (`templates/workflows/`) into `.github/workflows/`:

| Target | Workflow | Runners | Output |
| --- | --- | --- | --- |
| Desktop | `desktop.yml` | Four jobs: Windows (`windows-latest`), macOS Apple Silicon and macOS Intel (both `macos-latest`, with `--target aarch64-apple-darwin` / `x86_64-apple-darwin`), and Linux (`ubuntu-22.04`) | Installers attached to a **draft** GitHub release by `tauri-apps/tauri-action` (no run artifacts) |
| Android | `android.yml` | `ubuntu-latest` (JDK 17, Android NDK) | `.apk` and `.aab`: artifact `android-release`, and release assets |
| iOS | `ios.yml` | `macos-latest` | Signed: `.ipa` (artifact `ios-build` and release asset). Unsigned: simulator `.app` (artifact `ios-build` only, no release) |

Each workflow runs on **every push to `main`**, and can also be started manually (**Actions > Run workflow**). Pushing a tag does not trigger a build. Because deploy itself pushes to `main`, the first build starts as soon as the push lands. Deploy uploads your signing secrets before pushing, so that build already has them, unless `.env.signing` is missing or an upload failed (see [Signing secrets](#signing-secrets)).

The workflow files are overwritten with the packaged templates every time you deploy (they carry a "Managed by bini-deploy" header), so don't edit them by hand. They use the LTS Node.js version and the stable Rust toolchain (with a Rust build cache), reference GitHub Actions by major version (`@v4`, `@v1`, `@v2`; `dtolnay/rust-toolchain` tracks `stable`), request `contents: write` permission (needed to publish releases), and time out after 60 minutes. The desktop matrix uses `fail-fast: false`, so one failing platform doesn't cancel the others. There is no `concurrency` setting: runs for successive pushes are not cancelled. A commented-out Linux arm64 job is included in `desktop.yml` for public repositories.

The workflows install dependencies with your package manager, chosen from your lockfile: `pnpm install --frozen-lockfile` (pnpm 10 is set up when `pnpm-lock.yaml` exists), `yarn install --frozen-lockfile`, `bun install --frozen-lockfile` (bun is set up with `oven-sh/setup-bun`), `npm ci`, or plain `npm install` when there is no lockfile. They then run your **`tauri:icon`** script to generate the app icons (keep it in `package.json`, the workflows fail without it; deploy does not check for it). The desktop workflow builds through `tauri-apps/tauri-action`, and the Android and iOS workflows call `npx tauri android build` / `npx tauri ios build` directly, so the workflows do not use your `tauri:build`, `android:build` or `ios:build` scripts. Those scripts only matter for local builds, and deploy warns when they are missing.

### Releases

All three workflows publish to a GitHub release tagged `app-v<version>`:

- **Desktop** - `tauri-action` creates a **draft** release named `App v<version> (<platform label>)` and attaches the Windows, macOS (Apple Silicon and Intel) and Linux installers to it. You publish the draft yourself.
- **Android** - `softprops/action-gh-release` publishes (not as a draft) a release named `App v<version> (Android)` with the `.apk` and `.aab` attached and generated release notes.
- **iOS** - the same action publishes `App v<version> (iOS)` with the `.ipa` attached, but only for signed builds.
- Android and iOS read `<version>` from the `version` field of `package.json` (with `jq`) and stop with an error if it is missing. Desktop uses the app version that `tauri-action` reads from your Tauri project.
- The Android and iOS release steps only run on `main`. A manual run from another branch still builds and uploads artifacts, but publishes no release.
- The tag comes from the version, not from the commit, so bump the version when you want a new release. Pushes that keep the same version publish to the same `app-v<version>` tag.
- An unsigned iOS build is a simulator build: there is no `.ipa`, so it only uploads the `ios-build` artifact and no release is published.

### Before you deploy

Deploy does **not** create the native project. It stops with an error if either of these is missing:

- `src-tauri/tauri.conf.json`, or
- `@tauri-apps/cli` in `dependencies` or `devDependencies`.

It also warns (without stopping) when the project doesn't look like a Bini.js project (`bini-router` missing) and when `package.json` has no local build script for a selected target (`tauri:build` or `desktop:build`; `tauri:android:build` or `android:build`; `tauri:ios:build` or `ios:build`). All of these come from `create-bini-app add`: the first native target creates `src-tauri/` and adds all the native scripts and packages. On Windows and Linux, run `add desktop` to get that shared setup; the iOS project itself is generated in CI.

Deploy does not check for the `version` field in `package.json`; the Android and iOS workflows do, at build time (see [Releases](#releases)).

If `src-tauri/gen/android` or `src-tauri/gen/apple` isn't in your repository, the workflow generates it on the runner (`tauri android init --ci` / `tauri ios init --ci`), using the identifier and app name from your `tauri.conf.json`.

### What happens when you deploy a native target

1. **Cleanup** - all web hosting files are removed (see [What cleanup deletes](#what-cleanup-deletes)). This happens first, so if a later step fails the hosting files are already gone; commit them first if you want to keep them.
2. **Project check** - deploy verifies `src-tauri/tauri.conf.json` and `@tauri-apps/cli` and warns about missing build scripts (see [Before you deploy](#before-you-deploy)).
3. **Workflows are copied** into `.github/workflows/`, overwriting existing files. With `--dry-run` it only lists them.
4. **Signing setup** - if `.env.signing` doesn't exist, an interactive run asks whether to run `create-bini-app sign` now, then asks per target (Windows, macOS, Linux, Android, iOS, limited to the targets you selected) and runs `create-bini-app sign <target> --ci-only` for each you accept. With `--yes` or without a terminal, deploy only warns that CI builds will be unsigned.
5. **Secrets are uploaded** with `gh secret set` for the values in `.env.signing` that belong to the selected targets (see [Signing secrets](#signing-secrets)). A failed upload is reported but does not stop the deploy.
6. **Everything is committed and pushed** to `main` (see [Git behavior](#git-behavior)). Skipped with `--dry-run`.
7. A **deployment summary** is printed. Unlike web deploys, native deploys print no further next steps.

Deploy does not edit `.gitignore`.

> **Keep signing files out of git.** Deploy stages everything with `git add --all`. Make sure `.env.signing`, keystores (`*.jks`, `*.keystore`), certificates (`*.p12`, `*.pfx`, `*.p8`, `*.mobileprovision`, `*.key`), `keystore.properties` and the local `tauri.*.conf.json` signing overrides are in your `.gitignore` before you deploy.

### Signing secrets

Set up signing values with `npx create-bini-app@latest sign <target> --ci-only`, which saves them in `.env.signing` (deploy can run this for you, see above). When you deploy a native target, deploy reads that file (including multi-line single-quoted values such as ASCII-armored keys) and uploads each value to the repository with:

```bash
gh secret set NAME -R owner/repo
```

The value is piped through stdin, so special characters such as `'` or `$` are safe, and line endings are normalized to `\n`.

Notes:

- Only names that belong to the targets you selected are uploaded (the groups are listed below). Names in `.env.signing` that belong to no group are ignored.
- `gh` must be installed and logged in (`gh auth login`) with permission to manage the repository's Actions secrets. No bash-compatible shell is needed.
- If `gh` is missing or not working (checked with `gh --version`), deploy prints `GitHub CLI (gh) was not found or is not working. Install it and run gh auth login.` once, links to the secrets page, skips all uploads, and continues with the push, so the first build runs unsigned. If `gh` is installed but not logged in, each secret fails with gh's own error and the summary links to the secrets page. `--dry-run` does not check for `gh`. If none of the values in `.env.signing` belong to the selected targets, it reports that nothing was uploaded.
- If some uploads fail, deploy prints how many succeeded and links to `https://github.com/<owner>/<repo>/settings/secrets/actions` so you can add the rest by hand. After adding secrets, re-run the workflow from the **Actions** tab (or push again).
- If `.env.signing` is missing or empty, nothing is uploaded and CI builds are unsigned.

The groups deploy uploads, per target:

| Target | Secrets |
| --- | --- |
| Windows | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_PUBLISHER` |
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | `GPG_PRIVATE_KEY`, `SIGN`, `SIGN_KEY`, `APPIMAGETOOL_FORCE_SIGN`, `TAURI_SIGNING_RPM_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `TAURI_SIGNING_RPM_KEY_PASSPHRASE`, `LINUX_PUBLISHER` |
| Android | `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_PUBLISHER` |
| iOS | `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`, `APPLE_DEVELOPMENT_TEAM`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` |

The bundled workflows read these secrets (the secrets marked *manual* are never uploaded by deploy, add them yourself if you use them):

- **Desktop**: `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `GPG_PRIVATE_KEY`, `SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `TAURI_SIGNING_RPM_KEY`, `TAURI_SIGNING_RPM_KEY_PASSPHRASE`, plus *manual*: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (cloud signing) and `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (Tauri updater).
- **Android**: `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`.
- **iOS**: `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`, `KEYCHAIN_PASSWORD`, `APPLE_DEVELOPMENT_TEAM`, `APPLE_API_KEY_P8`.

`WINDOWS_PUBLISHER`, `LINUX_PUBLISHER` and `ANDROID_PUBLISHER` are uploaded when present but are not used by the bundled workflows: the workflows do not generate self-signed keys. `KEYCHAIN_PASSWORD` is shared by macOS and iOS, and the Apple API key values by macOS and iOS.

### Per-platform behavior in CI

Each workflow exports only the secrets that have a value to `$GITHUB_ENV` (an empty variable would count as "set" for Tauri), later steps test those exported values, and a warning is printed when a platform is built unsigned.

- **Windows** - when `WINDOWS_CERTIFICATE` is set, the `.pfx` (base64) is imported into the certificate store and used to sign. Without it, the build is unsigned unless a cloud `signCommand` is configured in a `src-tauri/tauri*.json` config; the workflow then installs the signer it recognizes from that config: `artifact-signing-cli` (Azure Artifact Signing, via `dotnet tool`) or `relic` (via `cargo install`). Any other signing tool you must install yourself.
- **macOS** - with `APPLE_CERTIFICATE` set, `tauri-action` signs using `APPLE_SIGNING_IDENTITY`; without it the app is ad-hoc signed (`-`), which is not distributable. If `APPLE_API_KEY_P8` is set, it is decoded to a key file and exposed as `APPLE_API_KEY_PATH`. Tauri notarizes when an App Store Connect API key or Apple ID credentials are present.
- **Linux** - when `GPG_PRIVATE_KEY` is set (base64), the key is imported and the AppImage is signed (`SIGN=1`, `SIGN_KEY`, `APPIMAGETOOL_FORCE_SIGN=1`, plus the passphrase if provided). The RPM is signed when `TAURI_SIGNING_RPM_KEY` is provided. With no key, the AppImage is unsigned.
- **Android** - when `ANDROID_KEY_BASE64` is set, the keystore is decoded and a `src-tauri/gen/android/keystore.properties` file is written from the alias and password secrets. Without it, the workflow warns that the APK/AAB is unsigned. It runs `npx tauri android build --apk --aab`.
- **iOS** - decided by two checks:
  - *Certificate* = `IOS_CERTIFICATE` is set. The workflow creates a temporary keychain, adds it to the search list, imports the `.p12` and installs the provisioning profile (`IOS_MOBILE_PROVISION`).
  - *API key* = `APPLE_API_KEY_P8` is set. It is decoded to a key file and exposed as `APPLE_API_KEY_PATH`.

  | You provide | Result |
  | --- | --- |
  | Certificate and/or API key | Signed build: `npx tauri ios build --export-method app-store-connect`, `.ipa` uploaded and released |
  | Neither | **Simulator-only build, the job still succeeds**: `npx tauri ios build --target aarch64-sim`, uploaded as `ios-build`, no release |

## What cleanup deletes

Every deploy runs a cleanup step before it generates anything, including native deploys, `--generate-entry` and `--dry-run`.

When you deploy web to hosting provider X, everything belonging to the *other* providers is removed:

- their generated entry files (`netlify/edge-functions/api.ts`, `api/index.ts`, `worker.ts`, `server/index.ts`, with the extension matching your project's language),
- their config files (`netlify.toml`, `vercel.json`, `wrangler.toml`), and
- their directories: **`netlify/`**, **`api/`** (Vercel) and **`server/`** (Deno), each deleted recursively.

Choosing **Node**, or deploying any **native** target, removes all of them. If your project has its own `api/` or `server/` folder with unrelated code, move it before running `bini-deploy`.

## Git behavior

- **Repository URL** - must look like `https://github.com/<owner>/<repo>` (letters, digits, `_` and `-` only, no `.git` suffix, no trailing slash, no SSH URLs), or deploy stops with "Invalid GitHub repository URL". In an interactive run, an existing `origin` is read and used without asking, so a remote written as `.../repo.git` fails this check: set it to the plain form first.
- **Existing remote** - an existing `origin` is used as-is and never changed. Otherwise the repository URL is added as `origin`.
- **Staging and commit** - `git add --all` stages everything, so check your `.gitignore`. The commit message is `--message` if given, otherwise (interactive runs with changes to commit) whatever you enter at the prompt, otherwise `chore: add deployment configuration`. If the commit fails, deploy warns and still tries to push. With nothing to commit, it just pushes.
- **Always `main`** - the push is `git push -u origin HEAD:main`. On another branch, deploy switches to `main` (checking it out if it exists, otherwise renaming the current branch) **before** staging and committing, so the deployment files are committed on `main`. If the switch fails because of local changes, commit or stash them and run again. New repositories are initialized with `main` as the initial branch.
- **Git identity** - if `user.name` or `user.email` aren't set, you're prompted once and they're stored in this repository's local config only. Without a terminal it fails fast and prints the `git config` commands to run.
- **Authentication** - deploy does not prompt for credentials and does not change your git configuration. If the push fails with an authentication error, deploy stops and prints how to set up [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) (GCM), which signs in through your browser once and stores the credential in your OS keychain (no Personal Access Token needed):
  - **Windows** - Git for Windows 2.29+ bundles GCM: push once and sign in.
  - **macOS** - `brew install --cask git-credential-manager`
  - **Linux** - install `git-credential-manager`, then `git config --global credential.helper manager`

  If you use a Personal Access Token instead, it needs the `repo` scope, plus **`workflow`** to push `.github/workflows` files.
- **Remote ahead** - if the push is rejected because the remote has commits you don't (for example an auto-created README), deploy fetches `origin/main` and merges with `--allow-unrelated-histories -X ours`. For any file on both sides, **your local version wins**; files that only exist remotely are merged in. A warning is printed first. If the merge or the follow-up push fails, it stops and prints the manual steps.
- **Failure classification** - push failures are sorted into authentication, repository not found, and non-fast-forward. Authentication prints the GCM guide above, non-fast-forward triggers the merge recovery, repository-not-found adds a short checklist, and everything else shows the raw git error.

## Troubleshooting

### Native: "No Tauri project found" or "@tauri-apps/cli is not installed"

Deploy needs `src-tauri/tauri.conf.json` and `@tauri-apps/cli` in your dependencies. Run `npx create-bini-app@latest add <desktop|android|ios>` first, then deploy again. On Windows or Linux, `add desktop` creates the shared setup that iOS builds in CI also need. Web hosting files may already have been removed by the time this error appears.

### Native: the push fails with an authentication error

Set up Git Credential Manager as described in [Git behavior](#git-behavior) and run deploy again. If you use a Personal Access Token, make sure it has the `workflow` scope, which pushing `.github/workflows` requires.

### Native: secrets weren't uploaded

Deploy uploads secrets with `gh secret set`, only for the selected targets and only when `.env.signing` exists. Check that:

- `.env.signing` exists (create it with `npx create-bini-app@latest sign <target> --ci-only`, or accept the offer to do so in an interactive run),
- `gh` is installed (get it from <https://cli.github.com>) and logged in (`gh auth login`), and your account may manage Actions secrets on the repository,
- the names are in the [upload groups](#signing-secrets) (`AZURE_*` and `TAURI_SIGNING_PRIVATE_KEY*` must be added by hand).

Failed uploads are listed in the output. Add the missing ones at `https://github.com/<owner>/<repo>/settings/secrets/actions`, then re-run the workflow.

### Native: the first build is unsigned even though I saved credentials

Secrets are uploaded before the push, so this normally means the upload failed or `.env.signing` didn't exist at the time. Add the missing secrets (see above), then re-run the workflow from the **Actions** tab.

### Native: a platform builds unsigned

No signing values were saved for it, or its secrets haven't been added to the repository. Run `npx create-bini-app@latest sign <target> --ci-only`, run deploy again, and check the upload output. macOS and iOS need real Apple credentials.

### iOS: I only get a simulator `.app` in `ios-build`, no `.ipa` and no release

Neither `IOS_CERTIFICATE` nor `APPLE_API_KEY_P8` was available to the workflow, so it fell back to a simulator build (this is intentional, not a failure). Save the iOS signing values with `npx create-bini-app@latest sign ios --ci-only`, run deploy again (or add the secrets by hand), and re-run the workflow.

### Native: the workflow fails at "Generate app icons"

The workflows run your `tauri:icon` script. Restore the script, or run `create-bini-app add` again to bring the native scripts back.

### Android / iOS: the workflow fails at "Read version"

`package.json` has no `version` field. Add one (for example `"version": "0.1.0"`) and push again. The release tag is `app-v<version>`.

### Native: no release appeared

- **Desktop** releases are created as **drafts**: open the repository's Releases page and publish the draft.
- **Android and iOS** releases are only published from runs on `main`, after the build and artifact upload succeed. Check the run's "Publish GitHub release" step.
- An unsigned iOS build is a simulator build with no `.ipa` to attach, so iOS publishes no release.

### My files disappeared after deploying

Cleanup deletes the other providers' files and directories (`netlify/`, `api/`, `server/`) and, for native deploys and Node, all of them, even with `--dry-run`. Restore them from git (`git checkout -- <path>`) and see [What cleanup deletes](#what-cleanup-deletes).

### Cloudflare: the first deploy fails, the second works

Check the Cloudflare build log (Deployments > Build log). Common causes:

- **Worker name mismatch** - with Workers Builds, the dashboard's Worker name must match `name` in `wrangler.toml`.
- **Repository connected before the push** - run `bini-deploy` first, then connect the repo, otherwise the first build runs without `wrangler.toml` and `worker.ts`.
- **No API routes** - `wrangler.toml` points at `worker.ts`, which is only generated when `src/app/api/` has at least one route.
- **Transient first-deploy errors** - a new Worker with static assets can fail during asset upload; retrying resolves it.

### Cloudflare: `/api/*` shows the 404 page

Your `wrangler.toml` lacks `run_worker_first = ["/api/*"]`. Rerun `bini-deploy` to regenerate it and redeploy.

### Deno Deploy: every route hydrates from `index.html`

The generated `server/index.ts` is from an older version. Run `bini-deploy --generate-entry deno` (or a full deploy) and redeploy.

## Contributing

Issues and pull requests are welcome. To add a hosting provider, extend the `Platform` type, `ADAPTERS`, `HOSTING_CONFIGS`, `WEB_NEXT_STEPS` and the `platformDirs` map in `cleanupPlatformArtifacts`, and add a case to `generateHostingConfig` in `src/index.ts`. For native targets, the workflows are static files in `templates/workflows/` (`desktop.yml`, `android.yml`, `ios.yml`), mapped by `WORKFLOW_FILES` in `src/index.ts`; the secret names uploaded for each target are defined by `SECRET_GROUPS` (with `SIGNING_PLATFORM` mapping each signing target to its workflow), so a secret a workflow reads must also be listed there to be uploaded automatically.

```bash
git clone https://github.com/Binidu01/bini-deploy
cd bini-deploy
pnpm install
pnpm build
```

## License

[MIT](./LICENSE)
