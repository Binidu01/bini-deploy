# bini-deploy

[![npm version](https://img.shields.io/npm/v/bini-deploy?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-deploy)
[![npm downloads](https://img.shields.io/npm/dm/bini-deploy?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-deploy)
[![license](https://img.shields.io/npm/l/bini-deploy?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-deploy)
[![node](https://img.shields.io/node/v/bini-deploy?color=339933&labelColor=0a0a0a&style=flat-square)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/typescript-ready-3178c6?labelColor=0a0a0a&style=flat-square)](https://www.typescriptlang.org)

[![node](https://img.shields.io/badge/node-supported-339933?labelColor=0a0a0a&style=flat-square&logo=nodedotjs&logoColor=white)](#web-deployment)
[![netlify](https://img.shields.io/badge/netlify-supported-00C7B7?labelColor=0a0a0a&style=flat-square&logo=netlify&logoColor=white)](#web-deployment)
[![vercel](https://img.shields.io/badge/vercel-supported-ffffff?labelColor=0a0a0a&style=flat-square&logo=vercel&logoColor=white)](#web-deployment)
[![cloudflare workers](https://img.shields.io/badge/cloudflare%20workers-supported-F38020?labelColor=0a0a0a&style=flat-square&logo=cloudflare&logoColor=white)](#web-deployment)
[![deno deploy](https://img.shields.io/badge/deno%20deploy-supported-70ffaf?labelColor=0a0a0a&style=flat-square&logo=deno&logoColor=white)](#web-deployment)
[![tauri](https://img.shields.io/badge/tauri-desktop%20%C2%B7%20android%20%C2%B7%20ios-24C8DB?labelColor=0a0a0a&style=flat-square&logo=tauri&logoColor=white)](#native-deployment)
[![github actions](https://img.shields.io/badge/github%20actions-workflows-2088FF?labelColor=0a0a0a&style=flat-square&logo=githubactions&logoColor=white)](#native-deployment)

**Deployment tooling for Bini.js projects: generates hosting files for web targets, copies CI workflows for native targets, and pushes the result to GitHub.**

One CLI that prepares a Bini.js project for Node, Netlify, Vercel, Cloudflare Workers, or Deno Deploy, or for desktop, Android, and iOS builds on GitHub Actions, and then commits and pushes to a branch of your GitHub repository.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Usage](#usage)
- [Options](#options)
- [Interactive and non-interactive runs](#interactive-and-non-interactive-runs)
- [Web deployment](#web-deployment)
- [Native deployment](#native-deployment)
- [Git and GitHub](#git-and-github)
- [Dry run](#dry-run)
- [Generated files and cleanup](#generated-files-and-cleanup)
- [Programmatic API](#programmatic-api)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Web hosts.** Node, Netlify, Vercel, Cloudflare Workers, and Deno Deploy.
- **Native targets.** Desktop (Windows, macOS, and Linux from one workflow), Android, and iOS, through GitHub Actions workflow templates.
- **API entry generation.** For hosts that need one, writes a small entry that imports `fetch()` from the compiled API bundle `dist/api/index.mjs`.
- **TypeScript or JavaScript.** Entries are written as `.ts` or `.js` depending on the project.
- **SSG-aware.** Detects `bini-ssg` and adjusts Netlify and Vercel fallbacks.
- **Vite `base` support.** API paths and fallbacks include the detected base.
- **Safe overwrites.** Files it writes carry a marker comment (or, for JSON, a recognizable shape); cleanup and overwrite checks only touch files it generated.
- **Signing secrets.** Uploads values from `.env.signing` as GitHub repository secrets with the GitHub CLI, filtered by the selected native targets.
- **Branch selection.** Pick the branch to push to with `--branch`, or choose from the remote's branches interactively.
- **Dry run.** Preview what would be written or removed without pushing.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | A version whose `node:util` provides `styleText` and `parseArgs` |
| `git` | Used through `simple-git` for every git operation |
| A GitHub repository | An HTTPS URL such as `https://github.com/user/my-app` |
| Git credentials | Pushes use git over HTTPS. The CLI recommends Git Credential Manager (see [Troubleshooting](#troubleshooting)) |
| GitHub CLI (`gh`), logged in | Only for native deploys that upload signing secrets |
| `create-bini-app` | Only for the optional signing step (`create-bini-app sign <target> --ci-only`). Resolved from `node_modules/.bin`, otherwise run through your package manager's runner |
| A Bini.js project | For native deploys the CLI warns when `bini-router` is not in `package.json` |

`bini-deploy` depends on `@clack/prompts`, `simple-git`, and `cross-spawn`. Output colors follow `NO_COLOR` and `FORCE_COLOR`.

---

## Usage

```bash
bini-deploy [options]
```

Examples:

```bash
bini-deploy
bini-deploy --platform web --hosting vercel --repo https://github.com/user/my-app --yes
bini-deploy --platform web --hosting netlify --repo https://github.com/user/my-app --branch production --yes
bini-deploy --platform desktop,android,ios --repo https://github.com/user/my-app -y
bini-deploy --platform desktop --repo https://github.com/user/my-app --dry-run
bini-deploy --generate-entry netlify
```

---

## Options

| Option | Description |
| --- | --- |
| `--platform <targets>` | `web`, or any of `desktop`, `android`, `ios` (comma-separated). `web` cannot be combined with the others. `windows`, `macos`, and `linux` are accepted as aliases of `desktop` and print a warning |
| `--hosting <name>` | Web only: `node`, `netlify`, `vercel`, `cloudflare`, `deno`. With `--yes` it defaults to `node` |
| `--repo <url>` | GitHub repository URL |
| `--branch`, `-b <name>` | Branch to push to. Default: the remote's default branch, otherwise `main`. Interactive runs show a list of the remote's branches |
| `--generate-entry <host>` | Generate the production entry file only (`netlify`, `vercel`, `cloudflare`, `deno`) and exit |
| `--message`, `-m <text>` | Commit message. Default: `chore: add deployment configuration` (prompted for in interactive runs) |
| `--dry-run` | Show what would be written, removed, and pushed, but do nothing |
| `--yes`, `-y` | Skip prompts. Requires `--platform` and `--repo` |
| `--help`, `-h` | Print help |

Unknown options are an error.

The repository URL must match `https://github.com/<owner>/<repo>`, where owner and repo contain only letters, digits, `_`, and `-` (no `.git` suffix).

---

## Interactive and non-interactive runs

**Interactive** (a TTY on stdin and stdout, no `--yes`):

1. Choose platforms (Web, Desktop, Android, iOS). Web cannot be combined with the others.
2. For web, choose a hosting provider.
3. The repository comes from the existing `origin` remote when the project is already a git repository; otherwise you are asked for the URL.
4. Choose the branch (see [Branch selection](#branch-selection)).
5. A summary is printed and you confirm before anything is written or pushed.

**Non-interactive** (`--yes`): `--platform` and `--repo` are required; the branch comes from `--branch` or the remote default. Without `--yes` and without a TTY the CLI exits with an error asking you to pass `--yes` with the required options.

---

## Web deployment

For hosts other than Node, `bini-deploy` generates an API entry (when needed) and a hosting configuration. It then removes files it generated earlier for other hosts, stages everything, commits, and pushes.

### Common behavior

- **API entry.** Imports `dist/api/index.mjs`, which `bini-router` writes during the build and which exports `fetch(request, env?, ctx?)`. Routing, CORS, and base handling live in that bundle, not in the entry.
- **No API routes.** The API directory is `src/app/api`. If it contains no `.ts` or `.js` route files (names starting with `_` or `.` are skipped), no API entry is written, except for Deno, whose entry is also its static file server.
- **Language.** `.ts` entries are written when `src/main.tsx` or `src/main.ts` exists, or, with no `src/main.*`, when `tsconfig.json` exists or `src/app` contains `.ts` or `.tsx` files. Otherwise `.js` is used.
- **Vite `base`.** Read from `BINI_BASE`, `VITE_BASE`, or `BASE`; otherwise from a `base: '…'` string literal in `vite.config.ts`, `.js`, `.mts`, or `.mjs`. The value is normalized to a leading slash without a trailing one (empty for `/`, `.`, or `./`).
- **Package manager.** Detected from the lockfile (`bun.lockb`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), defaulting to npm. It is used for the build command written into configs and in the printed next steps.
- **`bini-ssg`.** When `bini-ssg` is in `dependencies` or `devDependencies`, the run stops unless the installed `bini-router` mentions `getShellRoutes` (found in `node_modules/bini-router`'s `dist/index.js`, `dist/index.mjs`, `index.js`, or `dist/index.d.ts`). If `bini-router` cannot be inspected, only a warning is printed.
- **Existing configs.** A config file that exists and was not generated by `bini-deploy` is left untouched, with a warning.

### Per host

| Host | Files | Details |
| --- | --- | --- |
| **Node** | None | The next steps point to your `build` and `start` scripts and to `bini-server`, which listens on `$PORT` (default 3000) |
| **Netlify** | `netlify/functions/api.mjs`, `netlify.toml`, and (without `bini-ssg`) `netlify/edge-functions/spa-fallback.ts` or `.js` | The function exports a handler that calls `api.fetch(request)` and declares the paths `<base>/api` and `<base>/api/*`. `netlify.toml` sets the build command and `publish = "dist"`, adds `included_files = ["dist/api/**"]` when the project has API routes, and with `bini-ssg` adds a `[[redirects]]` rule from `/*` to `/404.html` with status `404`. Without `bini-ssg` the edge function rewrites page requests that would 404 to `<base>/index.html` and excludes `<base>/api/*` |
| **Vercel** | `api/index.ts` or `.js`, `vercel.json`, and `api/tsconfig.json` for TypeScript projects with API routes | The entry exports `{ fetch }` that calls `api.fetch(request)`. `vercel.json` has `buildCommand`, `base` when one was detected, and `rewrites`: `<base>/api/(.*)` to `<base>/api/index` when the project has API routes, plus (without `bini-ssg`) a rewrite of page paths without a file extension to `<base>/index.html` |
| **Cloudflare Workers** | `worker.ts` or `.js` (API routes only), `wrangler.toml`, `public/.assetsignore` | The Worker sends `<base>/api` and `<base>/api/*` to `api.fetch(request, env, ctx)` and everything else to `env.ASSETS.fetch(request)`. `wrangler.toml` has `name` (derived from the repository name, lowercased and sanitized to at most 63 characters, falling back to `my-app`), `main` and `compatibility_flags = ["nodejs_compat"]` when there are API routes, `compatibility_date = "2025-04-09"`, `keep_vars = true`, an `[assets]` section with `directory = "./dist"`, `binding = "ASSETS"` (API routes only), `not_found_handling = "404-page"`, and `run_worker_first = ["<base>/api/*"]` (API routes only). `public/.assetsignore` gets `/api/` and `/.bini/`; existing lines are kept |
| **Deno Deploy** | `server/index.ts` or `.js` | A static server for `dist/` that also serves the API when the project has API routes. It listens on `PORT` (default 3000). For each request it strips the base, serves an existing file (paths containing `..`, `\`, or a null byte get the not-found response), then `<path>/index.html`, then a matching shell folder (`[param]`, `[...slug]`, or `[[...slug]]`), then `404.html` with status `404`. No separate config file is written |

The generated entries start with a marker comment and `// @ts-nocheck`, so TypeScript does not need declarations for the `.mjs` bundle.

### Next steps

After a successful web deploy the CLI prints host-specific next steps: the build command, publish or entrypoint settings, where to add environment variables, and for Cloudflare the `wrangler deploy` command.

---

## Native deployment

Native deploys target `desktop`, `android`, and `ios`. The CLI:

1. **Verifies the project.**
   - `src-tauri/tauri.conf.json` must exist, otherwise the run fails with instructions to run `create-bini-app add <desktop|android|ios>`.
   - `@tauri-apps/cli` must be in `dependencies` or `devDependencies`.
   - A warning is printed when `bini-router` is missing from `package.json`, or when `package.json` has none of the expected build scripts for a target (`tauri:build` / `tauri:<target>:build` / `<target>:build`).
2. **Removes generated web hosting files** (see [Generated files and cleanup](#generated-files-and-cleanup)).
3. **Copies workflow templates** from the package's own `templates/workflows` folder into `.github/workflows/`: `desktop.yml`, `android.yml`, and `ios.yml` for the selected targets. Existing files with those names are overwritten. A missing template is an error.
4. **Offers signing setup.** If `.env.signing` is missing or has no values: interactive runs ask whether to run `create-bini-app sign <target> --ci-only` for each selected target (Windows, macOS, and Linux under `desktop`, plus Android and iOS); non-interactive runs print a warning that CI builds will be unsigned.
5. **Uploads signing secrets** with `gh secret set <NAME> -R <owner/repo>` for the values in `.env.signing` that belong to the selected targets. It checks that `gh` is installed first, normalizes line endings, and trims the RPM and GPG keys. Failures are reported per secret, with a link to the repository's secrets page.
6. **Pushes** the project to GitHub.

Secret names uploaded per signing target:

| Target | Secrets |
| --- | --- |
| Windows | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_PUBLISHER` |
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `KEYCHAIN_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Linux | `GPG_PRIVATE_KEY`, `SIGN`, `SIGN_KEY`, `APPIMAGETOOL_FORCE_SIGN`, `TAURI_SIGNING_RPM_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `TAURI_SIGNING_RPM_KEY_PASSPHRASE`, `LINUX_PUBLISHER` |
| Android | `ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_PUBLISHER` |
| iOS | `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`, `APPLE_DEVELOPMENT_TEAM`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` |

`.env.signing` uses `KEY=value` lines. Values written in POSIX single quotes (including multi-line values) are decoded before upload. The file is read from the project root and is never committed by `bini-deploy` itself, but see [Git and GitHub](#git-and-github): `git add --all` stages everything that is not ignored.

---

## Git and GitHub

All git work goes through `simple-git`.

1. **Repository.** If there is no `.git` folder, `git init --initial-branch <branch>` runs and `origin` is added. If `.git` exists, an existing `origin` is used; otherwise `origin` is added with the repository URL.
2. **Branch switching.** Before staging, the current branch is compared with the target:
   - the target is checked out when it exists locally;
   - in a repository with no commits, the unborn branch is renamed to the target;
   - otherwise the target is created from the current work (your current branch is not renamed).
3. **Stage.** `git add --all` stages everything not ignored by your `.gitignore`. Keep files such as `.env.signing`, `.env`, and key files in `.gitignore`.
4. **Identity.** If `user.name` or `user.email` is not configured, interactive runs prompt for them and set them for the repository; non-interactive runs fail with instructions.
5. **Commit.** Uses `--message`, a prompt (interactive, default `chore: add deployment configuration`), or the default. With nothing to commit it continues.
6. **Push.** `git push origin HEAD:<branch> --set-upstream`.
7. **Rejected push.** If the remote has commits you don't have, the CLI fetches the branch and merges `origin/<branch>` with `--allow-unrelated-histories -X ours` (your local version wins for conflicting files), then pushes again. If the merge fails, it prints the commands to finish manually.

Push errors are classified: authentication problems print a Git Credential Manager setup guide, a missing repository prints a "repository not found" message, and anything else prints the raw git error.

### Branch selection

The branch is chosen once, after the answers are validated:

1. `--branch` / `-b`, if given. The name must be a valid git branch name; if the branch does not exist on the remote yet, a note says it will be created.
2. Otherwise, in an interactive run, a list of the remote's branches (read with `git ls-remote --heads`), with the remote's default branch pre-selected and a "New branch..." entry.
3. Otherwise, the remote's default branch (read with `git ls-remote --symref <remote> HEAD`), or `main` when the repository is empty or unreachable.

The lookup uses `origin` when the project already has it, otherwise the repository URL. It needs the same credentials as pushing; for a private repository without credentials the list is empty and the CLI falls back to `main`.

---

## Dry run

With `--dry-run`, nothing is pushed and no secrets are uploaded.

- **Web (non-Node hosts).** Logs that the entry and configuration would be generated and lists generated files from other hosts that would be removed.
- **Web (Node).** Lists generated hosting files that would be removed.
- **Native.** Lists the workflow files that would be written and the generated web files that would be removed, and notes that secrets would be uploaded.

Interactive dry runs skip the final confirmation.

---

## Generated files and cleanup

Every generated file contains `Auto-generated by bini-deploy` (JSON files cannot, so they are recognized by their content: `vercel.json` when it has only `buildCommand`, `rewrites`, and `base`; `api/tsconfig.json` when it extends `../tsconfig.json` with an empty `types` list).

When you deploy to a host, files generated earlier for the other hosts are removed:

| Host | Files checked for removal |
| --- | --- |
| Netlify | `netlify/functions/api.mjs`, `netlify/edge-functions/spa-fallback.ts` / `.js`, `netlify/edge-functions/api.ts` / `.js`, `netlify.toml` |
| Vercel | `api/index.ts` / `.js`, `api/tsconfig.json`, `vercel.json` |
| Cloudflare | `worker.ts` / `.js`, `wrangler.toml` |
| Deno | `server/index.ts` / `.js` |

Empty `netlify/functions`, `netlify/edge-functions`, `netlify`, `api`, and `server` folders are removed afterwards. Choosing Node or a native target removes all of the above. For the selected host, the entry generated for the other language (`.ts` vs `.js`) is removed. `public/.assetsignore` is not removed.

---

## Programmatic API

```ts
import { generateProductionEntry } from 'bini-deploy'
import type { Platform, NonNodePlatform, NativeTarget, SigningTarget, DeployAnswers } from 'bini-deploy'
```

| Export | Description |
| --- | --- |
| `generateProductionEntry(platform: NonNodePlatform, apiDir?: string): Promise<void>` | Writes the API entry for a host (the same as `--generate-entry`). `apiDir` defaults to `src/app/api` under the current working directory. Runs the `getShellRoutes` check first when `bini-ssg` is installed |
| `Platform` | `'node' \| 'netlify' \| 'vercel' \| 'cloudflare' \| 'deno'` |
| `NonNodePlatform` | `Platform` without `'node'` |
| `NativeTarget` | `'desktop' \| 'android' \| 'ios'` |
| `SigningTarget` | `'windows' \| 'macos' \| 'linux' \| 'android' \| 'ios'` |
| `DeployAnswers` | The resolved answers: `platform`, `targets`, `webHosting`, `githubRepo`, `projectName`, `skipPrompts`, `commitMessage`, `branch` |

The CLI only runs when the module is executed as the main script, not when it is imported.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, `--help`, or `--generate-entry` completed |
| `1` | An error (invalid options, failed deployment, missing TTY without `--yes`) |
| `130` | Cancelled with a prompt cancel or `SIGINT` |
| `143` | `SIGTERM` |

---

## Troubleshooting

**`--platform is required when using --yes flag` / `--repo is required when using --yes flag`**
Non-interactive runs need both options.

**`Interactive mode requires a TTY`**
There is no terminal. Pass `--yes` with `--platform` and `--repo`.

**`Invalid GitHub repository URL`**
The URL must be `https://github.com/<owner>/<repo>` with letters, digits, `_`, and `-` only, and no `.git` suffix. The same check applies to an `origin` URL read from an existing repository.

**`Invalid branch name`**
`--branch` must be a valid git branch name and must not start with `-`.

**`bini-router is too old (missing getShellRoutes)`**
`bini-ssg` is installed but the installed `bini-router` does not mention `getShellRoutes`. Upgrade `bini-router` and run again. The check looks inside `node_modules/bini-router` in the project.

**`No Tauri project found`**
Native deploys need `src-tauri/tauri.conf.json`. Run `create-bini-app add <desktop|android|ios>` first.

**`Missing workflow template`**
The package's `templates/workflows/<target>.yml` file was not found next to the installed package.

**`Git identity is not configured`**
Set `user.name` and `user.email` with `git config`, or run interactively to be prompted.

**`Push failed: GitHub rejected the request`**
Configure Git Credential Manager and run again. On Windows, Git for Windows 2.29+ bundles it. On macOS, `brew install --cask git-credential-manager`. On Linux, install `git-credential-manager` and run `git config --global credential.helper manager`.

**`GitHub CLI (gh) was not found or is not working`**
Install `gh` and run `gh auth login`, or add the secrets by hand on the repository's `settings/secrets/actions` page.

**`No .env.signing found. CI builds will be unsigned`**
Run `create-bini-app sign <target> --ci-only` for each target, then run `bini-deploy` again.

**`<file> already exists and was not generated by bini-deploy`**
The existing config was left untouched. Merge the settings by hand, or remove the file and run again.

**Automatic merge failed**
The remote and local histories conflict. Resolve the conflicts, commit, and push to the branch yourself; the error message lists the commands.
