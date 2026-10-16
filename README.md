# bini-deploy

**Zero-config deployment for [Bini.js](https://bini.js.org) projects: web hosting, or desktop, Android and iOS builds and releases on GitHub Actions, all from one CLI.**

`bini-deploy` generates the right configuration for the target you pick, helps you set up code signing for native builds, and pushes everything to a GitHub repository. A single run deploys either **web** or **native** targets (see [One run, one kind of target](#one-run-one-kind-of-target)).

[![npm version](https://img.shields.io/npm/v/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![npm downloads](https://img.shields.io/npm/dm/bini-deploy.svg)](https://www.npmjs.com/package/bini-deploy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/bini-deploy.svg)](https://nodejs.org)
[![vite](https://img.shields.io/badge/vite-8-646cff.svg?logo=vite&logoColor=white)](https://vitejs.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

---

## Features

- **Web hosting, generated for you** - Netlify, Vercel, Cloudflare Workers, Deno Deploy, or Node. Writes the config file and wires up your API routes.
- **Native builds and releases on GitHub Actions** - generates `desktop.yml`, `android.yml` and `ios.yml` (Tauri). Every push to `main` builds the app and publishes a GitHub release tagged `v<version>` with the installers attached. Builds run on GitHub, so you can deploy iOS without owning a Mac.
- **iOS works without Apple credentials** - with no complete signing setup, the iOS workflow builds a simulator-only app and uploads it as the `ios-simulator` artifact instead of failing (no release is published for it).
- **File-based API routing** - files in `src/app/api/` are scanned and mounted as routes (dynamic segments and catch-alls included).
- **Prerendered pages and real 404s** - on Cloudflare and Deno Deploy, pages prerendered by `bini-ssg` are served directly and unknown routes return your build's `404.html` with a real `404` status. Missing files (`robots.txt`, `favicon.ico`...) return a real `404` on every host.
- **Automatic CORS** - API routes get `Access-Control-Allow-Origin: *` on every non-Node hosting adapter.
- **Guided code signing** - runs `create-bini-app sign <target> --ci-only` for each platform that has no saved signing values, then uploads the saved values as GitHub secrets **before** pushing, so the first CI run already sees them. Windows, Linux and Android can use a self-signed key that the workflow generates once and reuses.
- **Package-manager aware** - the build command, install step and printed next steps follow your lockfile (npm, pnpm, yarn or bun), falling back to the tool that launched `bini-deploy` when there is no lockfile.
- **Git push built in** - initializes the repo if needed, sets a local git identity if missing, handles authentication, commits and pushes.
- **Always pushes to `main`**.
- **Interactive or scriptable** - prompts by default, or flags plus `--yes` for scripts.

## Requirements

- Node.js **>= 20.19**
- Vite **>= 6**
- A GitHub repository to push to (created ahead of time), addressed as `https://github.com/<owner>/<repo>` (see [Git behavior](#git-behavior))
- `git` on your `PATH`
- A Bini.js project. For native targets, a Tauri project created by [`create-bini-app`](https://www.npmjs.com/package/create-bini-app) (see [Native builds](#native-builds-desktop-android-ios)) whose `package.json` has a `version` field. When `bini-deploy` runs the signing step it uses the project's local `node_modules/.bin/create-bini-app` if present, otherwise `npx create-bini-app` (not pinned to a version).
- Optional: the GitHub CLI (`gh`), logged in, to upload signing secrets automatically
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

```
bini-deploy [options]
```

| Flag | Description |
|------|-------------|
| `--platform <targets>` | `web`, or any of `desktop`, `android`, `ios`, comma-separated (e.g. `desktop,android`). `web` cannot be combined with the others. `windows`, `macos` and `linux` are accepted as aliases for `desktop` (with a warning: one workflow builds all three) |
| `--hosting <name>` | Hosting provider for web: `node` (default with `--yes`), `netlify`, `vercel`, `cloudflare`, `deno`. Ignored for native targets |
| `--repo <url>` | GitHub repository URL, e.g. `https://github.com/you/your-app` |
| `--generate-entry <host>` | Generate the production API entry file only (`netlify`, `vercel`, `cloudflare`, `deno`) |
| `--nosign` | Native only: skip the code signing prompts, the secret upload and the `SECRETS_PAT` check |
| `--yes`, `-y` | Skip prompts and use the flags (`--platform` and `--repo` are required) |
| `--help`, `-h` | Show usage |

Without `--yes`, `bini-deploy` needs an interactive terminal and exits with an error otherwise. In interactive mode the prompts decide everything: `--platform`, `--hosting` and `--repo` are only read together with `--yes`. After the prompts, a summary is shown and you confirm before anything is generated or pushed. `--nosign` and `--generate-entry` work in both modes (`--generate-entry` needs no terminal).

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

# Native, without signing
bini-deploy --platform desktop --repo https://github.com/you/your-app -y --nosign

# Generate only the Netlify API entry file (no config, no push)
bini-deploy --generate-entry netlify

# Follow the prompts
bini-deploy
```

> `--generate-entry` writes only the API entry file, but it still removes leftover files from other hosting providers (see [What cleanup deletes](#what-cleanup-deletes)).

## Web hosting

| Provider | Runtime | Files generated |
|----------|---------|-----------------|
| **Node** (default with `--yes`) | Node (`bini-server`) | None. `bini-server` handles build and serve; `bini-deploy` cleans up and pushes |
| **Netlify** | Edge Functions (Deno) | `netlify.toml`, `netlify/edge-functions/api.ts`, `netlify/edge-functions/spa-fallback.ts` |
| **Vercel** | Node.js Runtime | `vercel.json`, `api/index.ts`, and `api/tsconfig.json` (TypeScript projects only) |
| **Cloudflare Workers** | Workers + Static Assets | `wrangler.toml`, `worker.ts` (handles `/api/*` only) |
| **Deno Deploy** | Deno | `server/index.ts` (API entry and static server for prerendered pages), no config file |

Notes:

- API entry files (`api.ts`, `api/index.ts`, `worker.ts`, `server/index.ts`) are only generated when `src/app/api/` exists and has at least one route. Otherwise that step is skipped with a warning. Extensions are `.ts` for TypeScript projects and `.js` otherwise (Netlify's `spa-fallback` follows the same rule).
- The config files are still written when the entry file is skipped, so they can point at a file that doesn't exist (`function = "api"` in `netlify.toml`, `main = "worker.ts"` in `wrangler.toml`), and Deno Deploy has no entrypoint at all. If your project has no API routes, add one before deploying to these hosts.
- For Vercel and Cloudflare, the generated entry imports `hono` from npm, so deploy checks that it's installed. If it isn't, deploy prints the install command and stops. Netlify and Deno import Hono from a URL (`hono@v4.3.11`), so no local install is needed.
- The build command written to `netlify.toml` and `vercel.json` uses your package manager (for example `pnpm run build`), detected from your lockfile.
- On Vercel, `api/tsconfig.json` extends your root `tsconfig.json` with `types: []` and `skipLibCheck: true`, so Vercel's second type-check of `api/*.ts` doesn't fail on project-level types like `node` or `vite/client`.
- On Cloudflare, the Worker `name` comes from your repository name, lowercased and reduced to letters, digits and dashes (max 63 characters). `wrangler.toml` serves `./dist` as assets through the `ASSETS` binding and sets `compatibility_date = "2025-04-09"`.

### Static files, prerendered pages and 404s

| Provider | Extension-less paths (`/about`) |
|----------|----------------------------------|
| **Vercel** | Prerendered page if it exists, otherwise `index.html`. `vercel.json` rewrites `/api/(.*)` to `/api/index`, and extension-less paths to `/index.html`. |
| **Netlify** | Prerendered page if it exists, otherwise `index.html`. An edge function rewrites to `/index.html` only when the response is a `404` and the path has no extension. It runs on every non-API request. |
| **Cloudflare** | Prerendered page if it exists, otherwise `404.html` with status 404. `not_found_handling = "404-page"` and `run_worker_first = ["/api/*"]` are set in `wrangler.toml`. |
| **Deno Deploy** | Prerendered page, then the nearest `bini-ssg` shell (a parent `index.html` containing `__BINI_SHELL__`), otherwise `dist/404.html` with status 404. `index.html` is only used for `/`. |
| **Node** | Handled by `bini-server` |

Paths with a file extension that don't exist return a real `404` on every host. `/api/*` always goes to your API routes.

> **Cloudflare:** don't change `not_found_handling` to `"single-page-application"` and don't remove `run_worker_first`. With `404-page` enabled, Cloudflare answers unmatched paths with `404.html` without running your Worker, so `/api/*` would return the 404 page.

> **Dynamic routes on Cloudflare and Deno:** `bini-ssg` writes a shell for dynamic patterns at the parent path (`/blog/:id` becomes `dist/blog/index.html`). Deno serves that shell for `/blog/123`. Cloudflare only matches exact files, so `/blog/123` returns `404.html` there. A top-level dynamic route such as `/:id` has no parent shell and returns `404` on both. For client-only dynamic routes, use Vercel or Netlify.

### API routes

Any `.ts` or `.js` file in `src/app/api/` becomes a route:

```
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
- Names may only contain letters, numbers, `_` and `-` (max 100 characters); param names must be valid identifiers. Anything else is skipped with a warning.

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

If a route file imports from `hono`, it's mounted with `app.route('/api', yourApp)`. The mount point is always `/api`, not the file's path, so define the full sub-path inside the app:

```typescript
// src/app/api/hello.ts
import { Hono } from 'hono';

const app = new Hono();
app.get('/hello', (c) => c.json({ message: 'Hello from Hono!' }));

export default app;
```

This serves `GET /api/hello`.

## Native builds (desktop, Android, iOS)

Native targets are [Tauri](https://tauri.app) apps built by GitHub Actions. `bini-deploy` writes one workflow per target into `.github/workflows/`:

| Target | Workflow | Runner | Output (Artifacts, and release assets) |
|--------|----------|--------|--------------------|
| Desktop | `desktop.yml` | one job each for Windows (`windows-latest`), macOS (`macos-latest`) and Linux (`ubuntu-22.04`) | Artifacts: `src-tauri/target/release/bundle/**`, one per OS (`desktop-Windows`, `desktop-macOS`, `desktop-Linux`). Release: `.msi`, NSIS `.exe`, `.dmg`, `.app.tar.gz`, `.AppImage`, `.deb`, `.rpm` |
| Android | `android.yml` | `ubuntu-latest` (JDK 17, Android NDK) | `.apk` and `.aab` |
| iOS | `ios.yml` | `macos-latest` | Signed: `.ipa` (artifact `ios` and release asset). Unsigned: `ios-simulator.zip` (artifact `ios-simulator` only, no release) |

Each workflow runs on **every push to `main`**, and can also be started manually (**Actions > Run workflow**). Pushing a tag does not trigger a build. Because deploy itself pushes to `main`, the first build starts as soon as the push lands (the signing secrets are uploaded before that push, see [What happens when you deploy a native target](#what-happens-when-you-deploy-a-native-target)). Builds are available from the **Artifacts** section of the run and from the GitHub release (see [Releases](#releases)). Workflows are regenerated every time you deploy, so don't edit them by hand. They use Node 22 and the stable Rust toolchain (with a Rust build cache), pin GitHub Actions to exact versions (except `dtolnay/rust-toolchain`, which tracks `stable`), request `contents: write` permission (needed to publish releases), cancel an older run of the same workflow on the same ref, and time out after 60 minutes. Since a new push to `main` cancels a run that is still in progress, a quick second push can cancel the first build before its release is published.

The workflows install dependencies with your package manager (`npm ci`, `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`, or yarn's frozen/immutable install when there is a lockfile; plain `install` when there is none), regenerate the app icons from `public/logo.png` with your `tauri:icon` script, and build with the scripts that `create-bini-app` adds to `package.json`: `tauri:build`, `android:build` and `ios:build`. Deploy only checks for the build scripts, so keep `tauri:icon` in `package.json` or the workflows will fail at the icon step. With pnpm, the workflow pins pnpm 10 unless `package.json` has a `packageManager` field; with yarn, Berry is detected from `.yarnrc.yml`.

### Releases

After each successful build, every workflow publishes a GitHub release with [`softprops/action-gh-release`](https://github.com/softprops/action-gh-release):

- The tag and release name are `v<version>`, where `<version>` is the `version` field of `package.json` (so `1.2.0` becomes `v1.2.0`). Release notes are generated automatically.
- The installers are attached to the release in addition to being uploaded as run artifacts. Desktop attaches the Windows, macOS and Linux bundles from its three jobs to the same release.
- The release step only runs on `main`. A manual run started from another branch still builds and uploads artifacts, but publishes no release.
- If `package.json` has no `version`, the workflow stops at its "Read app version" step with an error.
- The tag comes from the version, not from the commit, so bump `version` in `package.json` when you want a new release. Pushes that keep the same version publish to the same `v<version>` release.
- iOS only publishes a release when the build is signed. An unsigned iOS build is a simulator build: there is no `.ipa`, so it only uploads the `ios-simulator` artifact.

### Before you deploy

Deploy does **not** create the native project. It requires:

- `src-tauri/tauri.conf.json`, and
- the build script for each selected target in `package.json` (`tauri:build`, `android:build`, `ios:build`).

If either is missing, deploy stops and tells you to run `create-bini-app add <target>`. Both come from `create-bini-app add`: the first native target creates `src-tauri/` and adds all the native scripts. On Windows and Linux, run `add desktop` to get that shared setup; the iOS project itself is generated in CI.

Deploy does not check for the `version` field in `package.json`; the workflows do, at build time (see [Releases](#releases)).

If `src-tauri/gen/android` or `src-tauri/gen/apple` isn't in your repository, the workflow generates it on the runner (`tauri android init --ci` / `tauri ios init --ci`), using the identifier and app name from your `tauri.conf.json`.

### What happens when you deploy a native target

1. **Cleanup and project check** - web hosting files are removed first (see [What cleanup deletes](#what-cleanup-deletes)), then deploy checks that `src-tauri/tauri.conf.json` and the build scripts exist (see above). If the check fails, the hosting files are already gone, so commit them first if you want to keep them. The signing files are then added to `.gitignore` so secrets are never committed.
2. **Code signing prompts** - skipped entirely with `--nosign`. With `--yes`, or without a terminal, deploy only warns about platforms that have no saved signing values. Otherwise, for every platform being deployed that has **no** saved signing values yet, you are asked whether to set it up now; platforms that already have values are skipped without a prompt (to redo one, run the sign command yourself). Saying yes runs, with the terminal handed over to it:

   ```
   create-bini-app sign <target> --ci-only
   ```

   using the project's local `node_modules/.bin/create-bini-app` if it exists, otherwise `npx create-bini-app` (not pinned to a version, so `npx` fetches the latest release unless you have it installed). Desktop covers three targets (`windows`, `macos`, `linux`), Android and iOS one each. The values are saved to `.env.signing`. If signing does not finish, deploy warns and carries on. Skipped targets still build in CI, just unsigned (ad-hoc signed on macOS, simulator-only on iOS).
3. **Workflows are generated** into `.github/workflows/`.
4. **Secrets are uploaded** to the repository with the GitHub CLI (see below), **before** anything is pushed. The push to `main` starts the workflows immediately, so uploading first means the very first run already sees the secrets.
5. **`SECRETS_PAT` is checked** when `.env.signing` holds a generated-key publisher value (`WINDOWS_PUBLISHER`, `LINUX_PUBLISHER` or `ANDROID_PUBLISHER`), also before the push.
6. **Everything is committed and pushed** to `main` (see [Git behavior](#git-behavior)).

`--nosign` skips steps 2, 4 and 5.

### Signing secrets

Values saved in `.env.signing` are uploaded as repository secrets with the names below, and the workflows read them. Only the values that exist, for the targets you are deploying, are uploaded. They are sent to `gh` over stdin and never printed.

| Target | Secrets |
|--------|---------|
| Windows | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_PUBLISHER` |
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | `GPG_PRIVATE_KEY`, `SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `APPIMAGETOOL_FORCE_SIGN`, `LINUX_PUBLISHER`, `TAURI_SIGNING_RPM_KEY`, `TAURI_SIGNING_RPM_KEY_PASSPHRASE` |
| Android | `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_PUBLISHER` |
| iOS | `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`, `APPLE_DEVELOPMENT_TEAM`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` |

`APPLE_API_KEY_PATH` (a local path) is never uploaded. Signing files (`.env.signing`, `.bini-signing/`, `tauri.windows.conf.json`, `tauri.macos.conf.json`, `tauri.ios.conf.json`, `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.p8`, `*.mobileprovision`, `*.key`, `keystore.properties`) are added to `.gitignore` before anything is committed.

**GitHub CLI:** the upload needs `gh` installed and logged in (`gh auth status`). Deploy does not install it or log in for you. If `gh` is missing or logged out, deploy prints the repository's secrets page and the secret names to add by hand, and carries on (the first build is then unsigned until you add them and re-run the workflow). In an interactive run you are asked to confirm the upload first; with `--yes` it uploads without asking when `gh` is logged in. The upload goes to the repository URL you gave deploy, which is not necessarily the one your existing `origin` points to.

**`SECRETS_PAT` and generated keys.** Windows, Linux and Android can use a self-signed key that the workflow creates on the first build (when `.env.signing` holds `WINDOWS_PUBLISHER`, `LINUX_PUBLISHER` or `ANDROID_PUBLISHER` and no real credentials). To reuse it later, the workflow saves it as a GitHub secret, which needs a repository secret named `SECRETS_PAT`: a fine-grained token for this repository with **Secrets: Read and write**. Without it, a new key is created on every build, and the workflow prints a warning if saving fails. After the upload, deploy checks for `SECRETS_PAT` with `gh secret list`. In an interactive run it offers to add it from a token you paste; with `--yes`, without a terminal, or when `gh` can't list secrets, it only prints how to add it by hand. macOS and iOS cannot be generated.

### Per-platform behavior in CI

For each platform the workflow uses, in order: real or saved credentials from secrets, then a generated self-signed key (Windows, Linux, Android), then nothing.

- **Windows** - imports your `.pfx` into the certificate store and signs with it. With only `WINDOWS_PUBLISHER`, it creates a self-signed certificate for that publisher. With neither, and a cloud or hardware key set up through `sign --sign-command` (`src-tauri/tauri.cloud-sign.conf.json`, which is committed), the build uses that config, and the workflow installs the signing tool it recognizes from the command: Azure Artifact Signing (`artifact-signing-cli`), Azure Key Vault (`relic`), SSL.com eSigner (`CodeSignTool`) or `jsign`. For any other tool it prints a warning, and you must add the install step yourself. With none of these, the build is unsigned.
- **macOS** - when `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` exist, the workflow exports your Apple values and writes `APPLE_SIGNING_IDENTITY` into `tauri.conf.json` in the runner (so set it too). Tauri notarizes when an App Store Connect API key or Apple ID credentials are present. Without a certificate it uses an ad-hoc signature (`-`).
- **Linux** - imports your GPG key (or generates one for `LINUX_PUBLISHER`, without a passphrase) and signs both the AppImage and the RPM. A signing failure fails the build instead of producing an unsigned AppImage. With no key, both are unsigned.
- **Android** - uses your keystore (`ANDROID_KEY_BASE64`), or creates one when both `ANDROID_PUBLISHER` and `ANDROID_KEYSTORE_PASSWORD` are set (alias defaults to `upload`), then wires Gradle with `create-bini-app sign android`. With neither, the release build is unsigned.
- **iOS** - decided by two checks in the build step:
  - *API key* = `APPLE_API_KEY_P8`, `APPLE_API_KEY` and `APPLE_API_ISSUER` are all set.
  - *Certificate* = `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` and `IOS_MOBILE_PROVISION` are all set.

  | You provide | Result |
  |-------------|--------|
  | API key **and** certificate | Signed `.ipa`, exported as `app-store-connect` |
  | API key **and** `APPLE_DEVELOPMENT_TEAM` | Signed `.ipa` with Xcode automatic signing |
  | Anything else (nothing, certificate only, API key only, partial values) | **Simulator-only build, the job still succeeds** |

  The simulator fallback unsets the Apple variables, removes `bundle.iOS.developmentTeam` from `tauri.conf.json` in the runner's checkout (the file in your repository is not changed), runs the build with `--target aarch64-sim --debug`, zips the resulting `.app` into `ios-simulator.zip` and uploads it as the `ios-simulator` artifact. It runs on a simulator only (not a real device or TestFlight), and no release is published. If the build produces no `.app`, the "Package simulator app" step fails with "No .app found". Note that a certificate without an API key (or vice versa) does not give you a signed build: it silently falls back to the simulator.

## What cleanup deletes

Every deploy runs a cleanup step before it generates anything, including native deploys and `--generate-entry`.

When you deploy web to hosting provider X, everything belonging to the *other* providers is removed:

- their generated entry files (`netlify/edge-functions/api.ts`, `api/index.ts`, `worker.ts`, `server/index.ts`, with the extension matching your project's language),
- their config files (`netlify.toml`, `vercel.json`, `wrangler.toml`), and
- their directories: **`netlify/`**, **`api/`** (Vercel) and **`server/`** (Deno), each deleted recursively.

Choosing **Node**, or deploying any **native** target, removes all of them. If your project has its own `api/` or `server/` folder with unrelated code, move it before running `bini-deploy`.

## Git behavior

- **Repository URL** - must look like `https://github.com/<owner>/<repo>` (letters, digits, `_` and `-` only, no `.git` suffix, no trailing slash, no SSH URLs), or deploy stops with "Invalid GitHub repository URL". In an interactive run, an existing `origin` is read and used without asking, so a remote written as `.../repo.git` fails this check: set it to the plain form first.
- **Existing remote** - an existing `origin` is used as-is and never changed. Otherwise the repository URL is added as `origin`.
- **Staging** - `git add --all` stages everything, so check your `.gitignore`. The commit message is `chore: add deployment configuration`. If the commit fails, deploy warns and still tries to push.
- **Always `main`** - the push is `git push -u origin HEAD:main`. On another branch, deploy checks out `main` if it exists, otherwise renames the current branch. New repositories are created with `git init -b main`.
- **Git identity** - if `user.name` or `user.email` aren't set, you're prompted once and they're stored in this repository's local config only. Without a terminal it fails fast and prints the `git config` commands to run.
- **Authentication** - if the push fails with an auth error, you're prompted for a GitHub username and a Personal Access Token and it's saved through git's credential store. The token needs the `repo` scope, plus the **`workflow`** scope to push `.github/workflows` files. This runs `git config --global credential.helper store`, a **global** setting that keeps credentials in plain text in `~/.git-credentials`. If you prefer another helper (Git Credential Manager, macOS Keychain), configure it beforehand. Without a terminal, deploy stops and prints how to configure credentials yourself.
- **Remote ahead** - if the push is rejected because the remote has commits you don't (for example an auto-created README), deploy fetches `origin/main` and merges with `--allow-unrelated-histories -X ours`. For any file on both sides, **your local version wins**; files that only exist remotely are merged in. A warning is printed first. If the merge fails, it stops and prints the manual steps.
- **Failure classification** - failures are reported as authentication, repository not found, or non-fast-forward. Only the last triggers the merge recovery. Others show the raw git error.

## Troubleshooting

### Native: "No Tauri project found" or a missing script

Deploy needs `src-tauri/tauri.conf.json` and the `tauri:build`, `android:build` or `ios:build` script. Run `npx create-bini-app@latest add <desktop|android|ios>` first, then deploy again. On Windows or Linux, `add desktop` creates the shared setup that iOS builds in CI also need. Web hosting files may already have been removed by the time this error appears.

### Native: the workflow can't be pushed

Your token is missing the `workflow` scope. Create a new Personal Access Token with `repo` and `workflow` and run deploy again.

### Native: secrets weren't uploaded

The GitHub CLI is missing or not logged in (or you declined the upload prompt). Install it, run `gh auth login`, then run deploy again. You can also add the secrets by hand at `https://github.com/<you>/<repo>/settings/secrets/actions`.

### Native: the first build is unsigned even though I saved credentials

Secrets are uploaded before the push, so this means the upload didn't happen or didn't finish: `gh` was missing or logged out, you declined the prompt, you used `--nosign`, or some secrets failed to upload (deploy prints a warning). Add the missing secrets, then re-run the workflow from the **Actions** tab.

### Native: a new signing key is created on every build

The workflow can't save the generated key because `SECRETS_PAT` is missing or its token lacks **Secrets: Read and write** for this repository. Add it at `https://github.com/<you>/<repo>/settings/secrets/actions`, or run deploy again and accept the prompt.

### Native: a platform builds unsigned

No signing values were saved for it. Run `npx create-bini-app@latest sign <target> --ci-only` (or answer yes to the prompt on the next deploy) and deploy again so the secrets are uploaded. macOS and iOS need real Apple credentials; they cannot be generated.

### iOS: I only get `ios-simulator.zip`, no `.ipa` and no release

The build ran without a complete signing setup, so it fell back to a simulator build (this is intentional, not a failure). You need either the API key trio (`APPLE_API_KEY_P8`, `APPLE_API_KEY`, `APPLE_API_ISSUER`) plus `APPLE_DEVELOPMENT_TEAM`, or the API key trio plus the certificate trio (`IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`). Save them with `npx create-bini-app@latest sign ios --ci-only`, run deploy again to upload them, and the next build will be signed.

### Native: the workflow fails at "Generate app icons"

The workflows run your `tauri:icon` script (which needs `public/logo.png`). Restore the script, or run `create-bini-app add` again to bring the native scripts back.

### Native: the workflow fails at "Read app version"

`package.json` has no `version` field. Add one (for example `"version": "0.1.0"`) and push again. The release tag is `v<version>`.

### Native: no release appeared

Releases are only published from runs on `main`, after the build and artifact upload succeed. Check the run's "Publish GitHub release" step. A newer push to `main` cancels a run that is still in progress, and an unsigned iOS build is a simulator build with no `.ipa` to attach (so iOS publishes no release).

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

Issues and pull requests are welcome. To add a hosting provider, extend the `Platform` type, `ADAPTERS`, `HOSTING_CONFIGS`, `WEB_NEXT_STEPS` and the `platformDirs` map in `cleanupPlatformArtifacts`, and add a case to `generateHostingConfig` in `src/index.ts`. For native targets, the workflow builders (`buildDesktopWorkflow`, `buildAndroidWorkflow`, `buildIosWorkflow`), the shared `versionStep` and `releaseStep`, and the signing lists (`SIGNING_SECRETS`, `SIGNING_MARKERS`, `SIGNING_GITIGNORE`) are the places to change.

```bash
git clone https://github.com/Binidu01/bini-deploy
cd bini-deploy
pnpm install
pnpm build
```

## License

[MIT](./LICENSE)