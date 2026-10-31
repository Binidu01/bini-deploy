import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  realpathSync,
  copyFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isatty } from 'node:tty';
import { styleText, parseArgs as nodeParseArgs } from 'node:util';
import * as clack from '@clack/prompts';
import simpleGit, { type SimpleGit } from 'simple-git';
import crossSpawn, { sync as spawnSync } from 'cross-spawn';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Format = Parameters<typeof styleText>[0];

const colorEnabled =
  !process.env.NO_COLOR &&
  ((process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') || Boolean(process.stdout.isTTY));

const paint = (f: Format, s: string): string => (colorEnabled ? styleText(f, s) : s);
const fmt = (f: Format) => (s: string): string => paint(f, s);
const c = {
  dim: fmt('dim'),
  bold: fmt('bold'),
  cyan: fmt('cyan'),
  green: fmt('green'),
  yellow: fmt('yellow'),
  red: fmt('red'),
  heading: fmt(['bold', 'cyan']),
};

type TagColor = 'cyan' | 'green' | 'yellow' | 'red' | 'blue' | 'magenta';
const tagged = (color: TagColor, label: string, out: (m: string) => void = console.log) => (m: string): void =>
  out(`${paint(['bold', color], label)} ${m}`);

const log = {
  info: tagged('cyan', 'INFO'),
  success: tagged('green', 'OK'),
  warn: tagged('yellow', 'WARN', console.warn),
  error: tagged('red', 'ERROR', console.error),
  step: tagged('blue', 'STEP'),
  skip: tagged('yellow', 'SKIP'),
  command: tagged('magenta', 'RUN'),
  plain: (m: string): void => console.log(m),
};

class ExitPromptError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'ExitPromptError';
  }
}

async function ask<T>(prompt: Promise<T | symbol>): Promise<T> {
  const value = await prompt;
  if (clack.isCancel(value)) throw new ExitPromptError();
  return value as T;
}

const toValidate =
  (check?: (v: string) => true | string, fallback = '') =>
  (v: string | undefined): string | undefined => {
    if (!check) return undefined;
    const result = check(v || fallback);
    return result === true ? undefined : result;
  };

const select = <T extends string | boolean>(o: {
  message: string;
  choices: { name: string; value: T }[];
  default?: T;
}): Promise<T> =>
  ask<T>(
    clack.select<T>({
      message: o.message,
      options: o.choices.map(({ name, value }) => ({ value, label: name })) as never,
      initialValue: o.default,
    }),
  );

const input = (o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string> =>
  ask<string>(
    clack.text({
      message: o.message,
      defaultValue: o.default,
      placeholder: o.default,
      validate: toValidate(o.validate, o.default),
    }),
  );

const confirm = (o: { message: string; default?: boolean }): Promise<boolean> =>
  ask<boolean>(clack.confirm({ message: o.message, initialValue: o.default !== false }));

const checkbox = async <T extends string>(o: {
  message: string;
  choices: { name: string; value: T; checked?: boolean }[];
  required?: boolean;
  validate?: (values: T[]) => true | string;
}): Promise<T[]> => {
  let current = o.choices.filter((ch) => ch.checked).map((ch) => ch.value);

  for (;;) {
    const values = await ask<T[]>(
      clack.multiselect<T>({
        message: o.message,
        options: o.choices.map((ch) => ({ value: ch.value, label: ch.name })) as never,
        initialValues: current,
        required: o.required ?? false,
      }),
    );

    const result = o.validate?.(values);
    if (result === undefined || result === true) return values;

    log.error(result);
    current = values;
  }
};

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;
const ALLOWED_ROUTE_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_PARAM_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ROUTE_SEGMENT_LENGTH = 100;
const MAX_API_SCAN_DEPTH = 100;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const API_EXTS = ['.ts', '.js'] as const;

const DEFAULT_BRANCH = 'main';
const DEFAULT_COMMIT_MESSAGE = 'chore: add deployment configuration';

type Platform = 'node' | 'netlify' | 'vercel' | 'cloudflare' | 'deno';
type NonNodePlatform = Exclude<Platform, 'node'>;
type NativeTarget = 'desktop' | 'android' | 'ios';
type SigningTarget = 'windows' | 'macos' | 'linux' | 'android' | 'ios';
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const WORKFLOW_FILES: Record<NativeTarget, string> = {
  desktop: 'desktop.yml',
  android: 'android.yml',
  ios: 'ios.yml',
};

const NATIVE_LABELS: Record<NativeTarget, string> = {
  desktop: 'Desktop (Windows, macOS, Linux)',
  android: 'Android',
  ios: 'iOS',
};

const SIGNING_LABELS: Record<SigningTarget, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
};

const SIGNING_PLATFORM: Record<SigningTarget, NativeTarget> = {
  windows: 'desktop',
  macos: 'desktop',
  linux: 'desktop',
  android: 'android',
  ios: 'ios',
};

const SIGNING_ENV_FILE = '.env.signing';

const SECRET_GROUPS: Record<SigningTarget, string[]> = {
  windows: ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_PUBLISHER'],
  macos: [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'KEYCHAIN_PASSWORD',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_P8',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ],
  linux: [
    'GPG_PRIVATE_KEY',
    'SIGN',
    'SIGN_KEY',
    'APPIMAGETOOL_FORCE_SIGN',
    'TAURI_SIGNING_RPM_KEY',
    'APPIMAGETOOL_SIGN_PASSPHRASE',
    'TAURI_SIGNING_RPM_KEY_PASSPHRASE',
    'LINUX_PUBLISHER',
  ],
  android: [
    'ANDROID_KEY_BASE64',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_PUBLISHER',
  ],
  ios: [
    'IOS_CERTIFICATE',
    'IOS_CERTIFICATE_PASSWORD',
    'IOS_MOBILE_PROVISION',
    'APPLE_DEVELOPMENT_TEAM',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_P8',
  ],
};

interface ApiRoute {
  routePath: string;
  filePath: string;
}

interface AdapterConfig {
  pkg?: string;
  importLine?: string;
  exportLine: string;
  outFile: (cwd: string, ts: boolean) => string;
  stripsApiPrefix: boolean;
  usesDenoRuntime: boolean;
  spaFallback?: boolean;
}

interface DeployAnswers {
  platform: 'web' | 'native';
  targets: NativeTarget[];
  webHosting?: Platform;
  githubRepo: string;
  projectName: string;
  skipPrompts: boolean;
  commitMessage?: string;
}

const ADAPTERS: Record<NonNodePlatform, AdapterConfig> = {
  netlify: {
    importLine: `import { Hono } from 'https://deno.land/x/hono@v4.3.11/mod.ts';\nimport { handle } from 'https://deno.land/x/hono@v4.3.11/adapter/netlify/index.ts';`,
    exportLine: `export default handle(app);`,
    outFile: (cwd, ts) => path.join(cwd, 'netlify', 'edge-functions', ts ? 'api.ts' : 'api.js'),
    stripsApiPrefix: false,
    usesDenoRuntime: true,
  },
  cloudflare: {
    pkg: 'hono',
    exportLine: `export default app;`,
    outFile: (cwd, ts) => path.join(cwd, ts ? 'worker.ts' : 'worker.js'),
    stripsApiPrefix: false,
    usesDenoRuntime: false,
    spaFallback: true,
  },
  deno: {
    importLine: `import { Hono } from 'https://deno.land/x/hono@v4.3.11/mod.ts';`,
    exportLine: `Deno.serve({ port: Number(Deno.env.get('PORT') ?? 3000) }, app.fetch);`,
    outFile: (cwd, ts) => path.join(cwd, 'server', ts ? 'index.ts' : 'index.js'),
    stripsApiPrefix: false,
    usesDenoRuntime: true,
  },
  vercel: {
    pkg: 'hono',
    exportLine: `export default app;`,
    outFile: (cwd, ts) => path.join(cwd, 'api', ts ? 'index.ts' : 'index.js'),
    stripsApiPrefix: false,
    usesDenoRuntime: false,
  },
};

const HOSTING_CONFIGS: Record<Platform, { label: string; configFile: string | null }> = {
  node: { label: 'Node', configFile: null },
  netlify: { label: 'Netlify', configFile: 'netlify.toml' },
  vercel: { label: 'Vercel', configFile: 'vercel.json' },
  cloudflare: { label: 'Cloudflare Workers', configFile: 'wrangler.toml' },
  deno: { label: 'Deno Deploy', configFile: null },
};

const WEB_NEXT_STEPS: Record<Platform, (pm: PackageManager) => string[]> = {
  node: (pm) => [
    `Build: ${c.yellow(scriptCommand(pm, 'build'))}`,
    `Start: ${c.yellow(scriptCommand(pm, 'start'))}`,
    `Served by ${c.cyan('bini-server')} on ${c.yellow('$PORT')} (default 3000)`,
  ],
  netlify: (pm) => [
    `Connect your repo to ${c.cyan('Netlify')}`,
    `Build command: ${c.yellow(scriptCommand(pm, 'build'))}`,
    `Publish directory: ${c.yellow('dist')}`,
    `API routes run on ${c.cyan('Edge Functions')}`,
  ],
  vercel: (pm) => [
    `Connect your repo to ${c.cyan('Vercel')}`,
    `Build command: ${c.yellow(scriptCommand(pm, 'build'))}`,
    `API routes run on ${c.cyan('Node.js Runtime')}`,
  ],
  cloudflare: (pm) => [
    `Install Wrangler: ${c.yellow(pm === 'npm' ? 'npm install -g wrangler' : `${pm} add -g wrangler`)}`,
    `Run: ${c.yellow(scriptCommand(pm, 'build'))} then ${c.yellow('wrangler deploy')}`,
    `Worker name in the dashboard must match ${c.yellow('name')} in ${c.yellow('wrangler.toml')}`,
    `Your worker handles ${c.cyan('/api/*')} routes`,
  ],
  deno: (pm) => [
    `Connect your repo to ${c.cyan('Deno Deploy')}`,
    `Set entrypoint: ${c.yellow('server/index.ts')}`,
    `Build command: ${c.yellow(scriptCommand(pm, 'build'))}`,
    `Runtime: ${c.cyan('Dynamic App')}`,
  ],
};

function isInteractive(): boolean {
  try {
    return isatty(process.stdin.fd) && isatty(process.stdout.fd);
  } catch {
    return false;
  }
}

function isExitPromptError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function toWorkerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return cleaned || 'my-app';
}

function toTitleCase(slug: string): string {
  const words = slug.split(/[-_.\s]+/).filter(Boolean);
  return words.length === 0 ? 'My App' : words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function isTypeScriptProject(): boolean {
  const cwd = process.cwd();

  const mainEntries = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'];
  for (const entry of mainEntries) {
    if (existsSync(path.join(cwd, entry))) {
      return entry.includes('.ts');
    }
  }

  if (existsSync(path.join(cwd, 'tsconfig.json'))) return true;

  const appDir = path.join(cwd, 'src/app');
  if (existsSync(appDir)) {
    const hasTsFile = (dir: string, depth = 0): boolean => {
      if (depth > 5) return false;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (hasTsFile(path.join(dir, entry.name), depth + 1)) return true;
          } else {
            const ext = path.extname(entry.name);
            if (ext === '.tsx' || ext === '.ts') return true;
          }
        }
      } catch {
        return false;
      }
      return false;
    };
    if (hasTsFile(appDir)) return true;
  }

  return false;
}

function isValidRouteSegment(segment: string): boolean {
  if (!segment || segment.length === 0) return false;
  if (segment.length > MAX_ROUTE_SEGMENT_LENGTH) return false;
  if (segment.includes('..') || segment.includes('//')) return false;
  return ALLOWED_ROUTE_PATTERN.test(segment);
}

function isValidParamName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > MAX_ROUTE_SEGMENT_LENGTH) return false;
  return ALLOWED_PARAM_PATTERN.test(name);
}

function normalizeRoutePath(routePath: string, basePath: string = ''): string {
  let normalized = routePath.replace(/\/+/g, '/');
  if (normalized === '') return basePath || '/';
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  if (normalized.endsWith('/') && normalized !== '/') normalized = normalized.slice(0, -1);

  if (basePath && basePath !== '/') {
    const cleanBasePath = basePath.replace(/\/$/, '');
    normalized = cleanBasePath + normalized;
  }

  return normalized;
}

function scanApiRoutes(dir: string, baseRoute = '', basePath: string = '', depth = 0): ApiRoute[] {
  if (depth > MAX_API_SCAN_DEPTH) {
    log.warn(`Maximum API directory depth reached at ${dir}`);
    return [];
  }

  const routes: ApiRoute[] = [];
  if (!existsSync(dir)) return routes;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const isCatchAll = entry.name.startsWith('[...') && entry.name.endsWith(']');
        const isDynamic = entry.name.startsWith('[') && entry.name.endsWith(']');

        let segment: string;
        if (isCatchAll) {
          segment = '*';
        } else if (isDynamic) {
          const paramName = entry.name.slice(1, -1);
          if (!isValidParamName(paramName)) {
            log.warn(`Invalid API parameter name: ${paramName}`);
            continue;
          }
          segment = `:${paramName}`;
        } else {
          if (!isValidRouteSegment(entry.name)) {
            log.warn(`Invalid API directory name: ${entry.name}`);
            continue;
          }
          segment = entry.name;
        }

        routes.push(...scanApiRoutes(fullPath, `${baseRoute}/${segment}`, basePath, depth + 1));
        continue;
      }

      const ext = path.extname(entry.name);
      const base = path.basename(entry.name, ext);
      if (!(API_EXTS as readonly string[]).includes(ext)) continue;

      const isCatchAll = base.startsWith('[...') && base.endsWith(']');
      const isDynamic = base.startsWith('[') && base.endsWith(']');

      let rawRoutePath: string;
      if (isCatchAll) {
        rawRoutePath = `${baseRoute}/*`;
      } else if (base === 'index') {
        rawRoutePath = baseRoute || '/';
      } else if (isDynamic) {
        const paramName = base.slice(1, -1);
        if (!isValidParamName(paramName)) {
          log.warn(`Invalid API parameter name: ${paramName}`);
          continue;
        }
        rawRoutePath = `${baseRoute}/:${paramName}`;
      } else {
        if (!isValidRouteSegment(base)) {
          log.warn(`Invalid API route name: ${base}`);
          continue;
        }
        rawRoutePath = `${baseRoute}/${base}`;
      }

      const routePath = normalizeRoutePath(rawRoutePath, basePath);
      routes.push({ routePath, filePath: fullPath });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to scan API routes: ${message}`);
  }

  return routes;
}

function resolveEntryImportPath(filePath: string, outFile: string, usesDenoRuntime: boolean): string {
  const rel = norm(path.relative(path.dirname(outFile), filePath));
  if (usesDenoRuntime) {
    const withTs = rel.replace(/\.tsx$/, '.ts');
    return withTs.startsWith('.') ? withTs : `./${withTs}`;
  }
  const stripped = rel.replace(/\.(ts|tsx|js|jsx)$/, '');
  const withJsExt = `${stripped}.js`;
  return withJsExt.startsWith('.') ? withJsExt : `./${withJsExt}`;
}

function buildRouteImports(
  routes: ApiRoute[],
  outFile: string,
  enableCors: boolean,
  platform: NonNodePlatform,
): { imports: string[]; mountings: string[]; corsLine: string | null; corsImport: string | null } {
  const imports: string[] = [];
  const mountings: string[] = [];
  const adapter = ADAPTERS[platform];
  const usesDenoRuntime = adapter.usesDenoRuntime;
  const isNetlify = platform === 'netlify';
  const importedModules = new Set<string>();

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    if (!route) continue;

    const imp = resolveEntryImportPath(route.filePath, outFile, usesDenoRuntime);

    if (importedModules.has(imp)) continue;
    importedModules.add(imp);

    const name = `_route${i}`;
    imports.push(`import ${name} from '${imp}';`);

    let src = '';
    try {
      const stats = statSync(route.filePath);
      if (stats.size <= MAX_FILE_SIZE) {
        src = readFileSync(route.filePath, 'utf8');
      }
    } catch {
      // unreadable file: treated as a plain handler
    }

    const isHonoApp = src.includes("from 'hono'") || src.includes('from "hono"');

    if (isHonoApp) {
      mountings.push(`app.route('/api', ${name});`);
    } else {
      const mountPath = route.routePath ?? '/';
      mountings.push(`app.all('${mountPath}', async (c) => {
    try {
      const r = await ${name}(c.req.raw);
      return r instanceof Response ? r : c.json(r);
    } catch (error) {
      console.error(\`API Error on \${c.req.path}:\`, error);
      return c.json({ error: 'Internal Server Error' }, 500);
    }
  });`);
    }
  }

  const corsPattern = '/api/*';
  let corsLine: string | null = null;
  let corsImport: string | null = null;

  if (enableCors) {
    if (isNetlify) {
      corsLine = `app.use('${corsPattern}', async (c, next) => {
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.res.headers });
  });`;
    } else {
      corsLine = `app.use('${corsPattern}', cors({ origin: '*', allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));`;
      corsImport = `import { cors } from 'hono/cors';`;
    }
  }

  return { imports, mountings, corsLine, corsImport };
}

function getDenoSpaFallback(): string[] {
  return [
    `// Serve the build's real 404.html (falls back to plain text if missing)`,
    `const notFound = async () => {`,
    `  try {`,
    `    const page = await Deno.readFile('./dist/404.html');`,
    `    return new Response(page, { status: 404, headers: { 'Content-Type': 'text/html' } });`,
    `  } catch {`,
    `    return new Response('File not found', { status: 404 });`,
    `  }`,
    `};`,
    ``,
    `const contentTypes = {`,
    `  html: 'text/html',`,
    `  css: 'text/css',`,
    `  js: 'application/javascript',`,
    `  mjs: 'application/javascript',`,
    `  json: 'application/json',`,
    `  txt: 'text/plain',`,
    `  xml: 'application/xml',`,
    `  svg: 'image/svg+xml',`,
    `  ico: 'image/x-icon',`,
    `  webmanifest: 'application/manifest+json',`,
    `  woff: 'font/woff',`,
    `  woff2: 'font/woff2',`,
    `  png: 'image/png',`,
    `  jpg: 'image/jpeg',`,
    `  jpeg: 'image/jpeg',`,
    `  webp: 'image/webp',`,
    `  avif: 'image/avif',`,
    `  gif: 'image/gif',`,
    `};`,
    ``,
    `const tryRead = async (p) => {`,
    `  try {`,
    `    return await Deno.readFile('./dist' + p);`,
    `  } catch {`,
    `    return null;`,
    `  }`,
    `};`,
    ``,
    `const htmlResponse = (body) =>`,
    `  new Response(body, { headers: { 'Content-Type': 'text/html' } });`,
    ``,
    `// Serve static files from dist (must come AFTER API routes)`,
    `app.get('/*', async (c) => {`,
    `  let pathname = c.req.path;`,
    `  if (pathname.startsWith('/api/')) {`,
    `    return c.text('API route not found', 404);`,
    `  }`,
    `  try {`,
    `    pathname = decodeURIComponent(pathname);`,
    `  } catch {`,
    `    return notFound();`,
    `  }`,
    `  if (pathname.includes('..') || pathname.includes('\\\\')) return notFound();`,
    ``,
    `  if (/\\.[a-zA-Z0-9]+$/.test(pathname)) {`,
    `    const file = await tryRead(pathname);`,
    `    if (!file) return notFound();`,
    `    const ext = pathname.split('.').pop();`,
    `    return new Response(file, {`,
    `      headers: { 'Content-Type': contentTypes[ext] || 'application/octet-stream' },`,
    `    });`,
    `  }`,
    ``,
    `  const clean = pathname.replace(/\\/+$/, '');`,
    `  const page = await tryRead(clean + '/index.html');`,
    `  if (page) return htmlResponse(page);`,
    ``,
    `  const parts = clean.split('/').filter(Boolean);`,
    `  while (parts.length > 1) {`,
    `    parts.pop();`,
    `    const shell = await tryRead('/' + parts.join('/') + '/index.html');`,
    `    if (shell && new TextDecoder().decode(shell).includes('__BINI_SHELL__')) {`,
    `      return htmlResponse(shell);`,
    `    }`,
    `  }`,
    ``,
    `  return notFound();`,
    `});`,
  ];
}

function getCloudflareSpaFallback(): string[] {
  return [
    `// Only /api/* reaches this Worker (run_worker_first in wrangler.toml).`,
    `// Everything else is served by Workers Static Assets, including the real 404.html.`,
    `app.all('*', async (c) => {`,
    `  if (c.req.path.startsWith('/api/')) {`,
    `    return c.json({ error: 'API route not found' }, 404);`,
    `  }`,
    `  return c.env.ASSETS.fetch(c.req.raw);`,
    `});`,
  ];
}

function buildEntryContent(
  routes: ApiRoute[],
  platform: NonNodePlatform,
  enableCors: boolean,
  outFile: string,
): string {
  const adapter = ADAPTERS[platform];
  const usesDenoRuntime = adapter.usesDenoRuntime;
  const isNetlify = platform === 'netlify';
  const isCloudflare = platform === 'cloudflare';

  const { imports, mountings, corsLine, corsImport } = buildRouteImports(routes, outFile, enableCors, platform);

  const lines: string[] = [
    `// Auto-generated by bini-deploy - do not edit.`,
    `// Add routes by creating files in src/app/api/`,
    `// Generated at: ${new Date().toISOString()}`,
    ``,
  ];

  if (usesDenoRuntime) {
    if (adapter.importLine) {
      lines.push(...adapter.importLine.split('\n'));
    } else {
      lines.push(`import { Hono } from 'https://deno.land/x/hono@v4.3.11/mod.ts';`);
    }

    if (corsImport && !isNetlify) {
      lines.push(`import { cors } from 'https://deno.land/x/hono@v4.3.11/middleware.ts';`);
    }

    for (const imp of imports) {
      let denoImp = imp;
      if (imp.includes("from './") && !imp.includes('.ts') && !imp.includes('.js')) {
        denoImp = imp.replace(/from '\.\/([^']+)'/, `from './$1.ts'`);
      }
      lines.push(denoImp);
    }
  } else {
    lines.push(`import { Hono } from 'hono';`);
    if (adapter.importLine) {
      lines.push(...adapter.importLine.split('\n'));
    }
    if (corsImport) {
      lines.push(corsImport);
    }
    lines.push(...imports);
  }

  lines.push(``);
  lines.push(`const app = new Hono();`);

  if (corsLine) {
    lines.push(corsLine);
  }

  lines.push(...mountings);
  lines.push(``);

  if (platform === 'deno') {
    lines.push(...getDenoSpaFallback());
  }

  if (isCloudflare && adapter.spaFallback) {
    lines.push(...getCloudflareSpaFallback());
  }

  lines.push(...adapter.exportLine.split('\n'));

  return lines.join('\n') + '\n';
}

function checkAdapter(platform: NonNodePlatform): void {
  const adapter = ADAPTERS[platform];
  if (!adapter.pkg) return;

  try {
    require.resolve(adapter.pkg, { paths: [process.cwd()] });
  } catch {
    throw new Error(
      `Missing required package for platform '${platform}'.\n` + `  Run: npm install ${adapter.pkg}`,
    );
  }
}

function cleanupPlatformArtifacts(hosting: Platform, ts: boolean): void {
  const cwd = process.cwd();
  const allPlatforms: NonNodePlatform[] = ['netlify', 'vercel', 'cloudflare', 'deno'];

  for (const platform of allPlatforms) {
    if (platform === hosting) continue;
    const adapter = ADAPTERS[platform];
    const oldFile = adapter.outFile(cwd, ts);
    if (existsSync(oldFile)) {
      try {
        unlinkSync(oldFile);
        log.info(`Removed old entry: ${path.relative(cwd, oldFile)}`);
      } catch {
        // ignore
      }
    }
  }

  for (const platform of allPlatforms) {
    if (platform === hosting) continue;
    const configFile = HOSTING_CONFIGS[platform].configFile;
    if (!configFile) continue;
    const filePath = path.join(cwd, configFile);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        log.info(`Removed old config: ${configFile}`);
      } catch {
        // ignore
      }
    }
  }

  const platformDirs: Record<NonNodePlatform, string> = {
    netlify: 'netlify',
    vercel: 'api',
    cloudflare: '',
    deno: 'server',
  };

  for (const platform of allPlatforms) {
    if (platform === hosting) continue;
    const dir = platformDirs[platform];
    if (!dir) continue;
    const dirPath = path.join(cwd, dir);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
        log.info(`Removed old directory: ${dir}`);
      } catch {
        // ignore
      }
    }
  }
}

export async function generateProductionEntry(
  platform: NonNodePlatform,
  apiDir?: string,
  enableCors: boolean = true,
  basePath: string = '',
): Promise<void> {
  const cwd = process.cwd();
  const srcApiDir = apiDir || path.join(cwd, 'src/app/api');

  const ts = isTypeScriptProject();

  cleanupPlatformArtifacts(platform, ts);

  if (!existsSync(srcApiDir)) {
    log.warn('No API directory found, skipping production entry generation');
    return;
  }

  const routes = scanApiRoutes(srcApiDir, '/api', basePath);
  if (routes.length === 0) {
    log.warn('No API routes found, skipping production entry generation');
    return;
  }

  log.info(`Found ${routes.length} API route(s)`);

  try {
    checkAdapter(platform);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const adapter = ADAPTERS[platform];
  const outFile = adapter.outFile(cwd, ts);

  const dir = path.dirname(outFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = buildEntryContent(routes, platform, enableCors, outFile);

  try {
    writeFileSync(outFile, content, 'utf8');
    log.success(`Generated: ${toPosixPath(path.relative(cwd, outFile))}`);
  } catch (error) {
    log.error(`Failed to write production entry file: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function generateHostingConfig(hosting: NonNodePlatform, projectName: string): Promise<string | null> {
  const cwd = process.cwd();
  const pm = detectPackageManager();

  cleanupPlatformArtifacts(hosting, isTypeScriptProject());

  const configFile = HOSTING_CONFIGS[hosting].configFile;
  if (!configFile) return null;

  const outFile = path.join(cwd, configFile);
  const buildCommand = scriptCommand(pm, 'build');

  switch (hosting) {
    case 'netlify': {
      const config = `
[build]
  command = "${buildCommand}"
  publish = "dist"

[[edge_functions]]
  path = "/api/*"
  function = "api"
`;
      await writeFile(outFile, config.trim());

      const ts = isTypeScriptProject();
      const edgeDir = path.join(cwd, 'netlify', 'edge-functions');
      mkdirSync(edgeDir, { recursive: true });

      const staleFallback = path.join(edgeDir, ts ? 'spa-fallback.js' : 'spa-fallback.ts');
      if (existsSync(staleFallback)) {
        try {
          unlinkSync(staleFallback);
        } catch {
          // ignore
        }
      }

      const fallbackBody = ts
        ? `// Auto-generated by bini-deploy - do not edit.
import type { Context } from 'https://edge.netlify.com';

export default async (request: Request, context: Context) => {
  const response = await context.next();
  const { pathname } = new URL(request.url);
  const isPage =
    (request.method === 'GET' || request.method === 'HEAD') &&
    !/\\.[a-zA-Z0-9]+$/.test(pathname);
  if (response.status === 404 && isPage) {
    return context.rewrite('/index.html');
  }
  return response;
};

export const config = { path: '/*', excludedPath: ['/api/*'] };
`
        : `// Auto-generated by bini-deploy - do not edit.
export default async (request, context) => {
  const response = await context.next();
  const { pathname } = new URL(request.url);
  const isPage =
    (request.method === 'GET' || request.method === 'HEAD') &&
    !/\\.[a-zA-Z0-9]+$/.test(pathname);
  if (response.status === 404 && isPage) {
    return context.rewrite('/index.html');
  }
  return response;
};

export const config = { path: '/*', excludedPath: ['/api/*'] };
`;

      await writeFile(path.join(edgeDir, ts ? 'spa-fallback.ts' : 'spa-fallback.js'), fallbackBody);
      return outFile;
    }

    case 'vercel': {
      const config = {
        buildCommand,
        rewrites: [
          { source: '/api/(.*)', destination: '/api/index' },
          { source: '/((?!.*\\.[a-zA-Z0-9]+$).*)', destination: '/index.html' },
        ],
      };
      await writeFile(outFile, JSON.stringify(config, null, 2));

      if (isTypeScriptProject()) {
        const apiDir = path.join(cwd, 'api');
        mkdirSync(apiDir, { recursive: true });
        await writeFile(
          path.join(apiDir, 'tsconfig.json'),
          JSON.stringify(
            {
              extends: '../tsconfig.json',
              compilerOptions: { types: [], skipLibCheck: true },
            },
            null,
            2,
          ) + '\n',
        );
      }

      return outFile;
    }

    case 'cloudflare': {
      const ts = isTypeScriptProject();
      const workerName = toWorkerName(projectName);

      const config = `
name = "${workerName}"
main = "${ts ? 'worker.ts' : 'worker.js'}"
compatibility_date = "2025-04-09"

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "404-page"
run_worker_first = ["/api/*"]
`;
      await writeFile(outFile, config.trim() + '\n');
      return outFile;
    }

    default:
      return null;
  }
}

// Order mirrors bini-cli's LOCKFILE_NAMES (bun first).
const LOCK_FILES: Array<[file: string, pm: PackageManager]> = [
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

function readPackageJson(): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function detectPackageManager(): PackageManager {
  const cwd = process.cwd();
  for (const [file, pm] of LOCK_FILES) {
    if (existsSync(path.join(cwd, file))) return pm;
  }
  return 'npm';
}

function scriptCommand(pm: PackageManager, script: string, args: string[] = []): string {
  if (pm === 'npm') return `npm run ${script}${args.length ? ` -- ${args.join(' ')}` : ''}`;
  return `${pm} run ${script}${args.length ? ` ${args.join(' ')}` : ''}`;
}

/* ────────────────────── Signing secrets + workflow writer ────────────────────── */

/**
 * Parses a POSIX single-quoted shell string (the format bini-cli writes to
 * .env.signing). `'\''` is the escape for a literal single quote. Returns the
 * decoded value, or null if the string is not (yet) a complete quoted value.
 */
function parseShellSingleQuoted(s: string): string | null {
  if (!s.startsWith("'")) return null;
  let out = '';
  let i = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      if (s.slice(i, i + 4) === "'\\''") {
        out += "'";
        i += 4;
        continue;
      }
      if (i === s.length - 1) return out;
      return null;
    }
    out += ch;
    i++;
  }
  return null;
}

function readSigningEnv(): Record<string, string> {
  const file = path.join(process.cwd(), SIGNING_ENV_FILE);
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // unreadable file: treated as no values
    return out;
  }

  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1] as string;
    const rest = match[2] ?? '';

    if (rest.startsWith("'")) {
      // Keep consuming lines until the quoted value closes (multi-line values,
      // e.g. the ASCII-armored TAURI_SIGNING_RPM_KEY).
      let accumulated = rest;
      while (parseShellSingleQuoted(accumulated) === null && i + 1 < lines.length) {
        i++;
        accumulated += '\n' + (lines[i] ?? '');
      }
      out[key] = parseShellSingleQuoted(accumulated) ?? accumulated;
    } else {
      out[key] = rest;
    }
    i++;
  }
  return out;
}

function uploadSecrets(githubRepo: string, targets?: NativeTarget[]): void {
  const env = readSigningEnv();
  const slug = githubRepo.replace(/^https:\/\/github\.com\//, '');

  if (Object.keys(env).length === 0) {
    log.warn(`No ${SIGNING_ENV_FILE} found. CI builds will be unsigned.`);
    log.info('Set up signing first: create-bini-app sign <target>');
    return;
  }

  let names = Object.keys(env);
  if (targets) {
    const allowed = new Set<string>();
    for (const target of Object.keys(SECRET_GROUPS) as SigningTarget[]) {
      if (targets.includes(SIGNING_PLATFORM[target])) {
        for (const name of SECRET_GROUPS[target]) allowed.add(name);
      }
    }
    names = names.filter((name) => allowed.has(name));
  }

  if (names.length === 0) {
    log.warn('No values in .env.signing match the selected targets. Nothing to upload.');
    return;
  }

  const ghCheck = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  if (ghCheck.error || ghCheck.status !== 0) {
    log.error('GitHub CLI (gh) was not found or is not working. Install it and run `gh auth login`.');
    log.plain(`\n${c.dim('Or add the secrets manually at:')}`);
    log.plain(`  ${c.cyan(`https://github.com/${slug}/settings/secrets/actions`)}\n`);
    return;
  }

  log.plain(`\n${c.heading('Uploading repository secrets')}`);

  let uploaded = 0;
  for (const name of names) {
    let value = env[name];
    if (value === undefined) continue;

    // 1. readSigningEnv() already decoded the shell quoting; do not strip quotes again.
    // 2. Normalize line endings to prevent GitHub Actions errors with \r\n
    value = value.replace(/\r\n/g, '\n');

    // 3. Clean up the RPM Key formatting (strip any trailing whitespace)
    if (name === 'TAURI_SIGNING_RPM_KEY' || name === 'GPG_PRIVATE_KEY') {
      value = value.trim();
    }

    log.info(`Uploading secret: ${name}...`);

    // 4. Spawn gh secret set, piping the clean value directly to stdin
    const result = spawnSync('gh', ['secret', 'set', name, '-R', slug], {
      input: value,
      stdio: ['pipe', 'ignore', 'pipe'],
      encoding: 'utf8',
    });

    if (result.error || result.status !== 0) {
      const errorMsg = result.stderr || result.error?.message || 'Unknown error';
      log.error(`  Failed to upload ${name}: ${String(errorMsg).trim()}`);
    } else {
      log.success(`  Success: ${name}`);
      uploaded++;
    }
  }

  if (uploaded === names.length) {
    log.success(`All ${uploaded} secrets successfully uploaded to GitHub!`);
  } else {
    log.warn(`Uploaded ${uploaded}/${names.length} secrets.`);
    log.plain(`\n${c.dim('You may need to add the missing ones manually at:')}`);
    log.plain(`  ${c.cyan(`https://github.com/${slug}/settings/secrets/actions`)}\n`);
  }
}

/* ─────────────── Signing helper (runs create-bini-app sign) ─────────────── */

function createBiniAppCommand(args: string[]): { bin: string; args: string[] } {
  const binName = process.platform === 'win32' ? 'create-bini-app.cmd' : 'create-bini-app';
  const local = path.join(process.cwd(), 'node_modules', '.bin', binName);
  if (existsSync(local)) return { bin: local, args };

  const pm = detectPackageManager();
  switch (pm) {
    case 'pnpm':
      return { bin: 'pnpm', args: ['dlx', 'create-bini-app', ...args] };
    case 'yarn':
      return { bin: 'yarn', args: ['dlx', 'create-bini-app', ...args] };
    case 'bun':
      return { bin: 'bunx', args: ['create-bini-app', ...args] };
    case 'npm':
    default:
      return { bin: 'npx', args: ['--yes', '--silent', 'create-bini-app', ...args] };
  }
}

function runCreateBiniAppSign(args: string[]): Promise<boolean> {
  const { bin, args: fullArgs } = createBiniAppCommand(args);
  log.command(`${bin} ${fullArgs.join(' ')}`);

  return new Promise((resolve) => {
    const child = crossSpawn(bin, fullArgs, {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code: number | null) => resolve(code === 0));
  });
}

async function askForSigningTargets(answers: DeployAnswers): Promise<void> {
  const candidateTargets = (Object.keys(SIGNING_LABELS) as SigningTarget[]).filter((t) =>
    answers.targets.includes(SIGNING_PLATFORM[t]),
  );

  for (const target of candidateTargets) {
    const label = SIGNING_LABELS[target];
    const sign = await confirm({
      message: `Sign ${label} for GitHub Actions?`,
      default: true,
    });
    if (!sign) {
      log.skip(`${label}: signing skipped.`);
      continue;
    }

    // Prerequisite checks (e.g. gpg for Linux) are owned by bini-cli, which
    // prints the install guide itself when something is missing.
    if (!(await runCreateBiniAppSign(['sign', target, '--ci-only']))) {
      log.warn(`${label} signing did not finish. CI builds for that target will be unsigned.`);
    }
  }
}

function writeWorkflows(targets: NativeTarget[], dryRun: boolean): string[] {
  const cwd = process.cwd();
  const dir = path.join(cwd, '.github', 'workflows');
  const templates = path.join(__dirname, '..', 'templates', 'workflows');
  const written: string[] = [];

  for (const target of targets) {
    const src = path.join(templates, WORKFLOW_FILES[target]);
    const dest = path.join(dir, WORKFLOW_FILES[target]);
    if (!existsSync(src)) {
      throw new Error(`Missing workflow template: ${src}`);
    }
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(src, dest);
    }
    written.push(toPosixPath(path.relative(cwd, dest)));
  }

  return written;
}

function isBiniProject(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, any>;
    return Boolean(pkg.dependencies?.['bini-router'] || pkg.devDependencies?.['bini-router']);
  } catch {
    return false;
  }
}

function verifyNativeProject(targets: NativeTarget[]): void {
  const cwd = process.cwd();

  if (!isBiniProject(cwd)) {
    log.warn('This does not look like a Bini.js project (bini-router missing in package.json).');
  }

  if (!existsSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'))) {
    throw new Error(
      'No Tauri project found (src-tauri/tauri.conf.json is missing).\n' +
        '  Add one first: create-bini-app add <desktop|android|ios>\n' +
        '  No Mac? Run `add desktop` (it creates the shared src-tauri/): the iOS project itself is generated in CI.',
    );
  }

  const pkg = readPackageJson();
  const deps: Record<string, string> = {
    ...((pkg?.dependencies ?? {}) as Record<string, string>),
    ...((pkg?.devDependencies ?? {}) as Record<string, string>),
  };

  if (!deps['@tauri-apps/cli']) {
    throw new Error('@tauri-apps/cli is not installed.\n  Run: create-bini-app add <desktop|android|ios>');
  }

  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const missing = targets.filter((t) => !scripts[`tauri:${t === 'desktop' ? 'build' : `${t}:build`}`] && !scripts[`${t}:build`]);
  if (missing.length > 0) {
    log.warn(`package.json is missing build scripts for ${missing.join(', ')}. Local builds may need: create-bini-app add ${missing.join(' ')}`);
  }
}

async function deployNative(answers: DeployAnswers, dryRun: boolean): Promise<void> {
  const spinner = clack.spinner();
  spinner.start('Preparing native deploy...');

  try {
    verifyNativeProject(answers.targets);

    spinner.message('Writing workflow templates...');
    const written = writeWorkflows(answers.targets, dryRun);
    for (const f of written) log.info(`${dryRun ? 'Would write' : 'Wrote'} ${f}`);

    spinner.stop();

    const missingSigning = Object.keys(readSigningEnv()).length === 0;
    if (missingSigning && !dryRun) {
      if (answers.skipPrompts || !isInteractive()) {
        log.warn(`No ${SIGNING_ENV_FILE} found. CI builds will be unsigned.`);
        log.info('Set up signing first: create-bini-app sign <target> --ci-only');
      } else {
        const proceed = await confirm({
          message: `No ${SIGNING_ENV_FILE} found. Run create-bini-app sign now?`,
          default: true,
        });
        if (proceed) await askForSigningTargets(answers);
      }
    } else if (missingSigning && dryRun) {
      log.warn(`No ${SIGNING_ENV_FILE} found. A real run would invoke create-bini-app sign.`);
    }

    log.plain('');
    if (dryRun) {
      log.info('Dry run: would upload signing secrets with `gh secret set`.');
    } else {
      uploadSecrets(answers.githubRepo, answers.targets);
    }

    if (dryRun) {
      log.plain(`\n${c.yellow('Dry run:')} no files pushed.`);
      return;
    }

    log.step('Pushing to GitHub...');
    await pushToGitHub(answers.githubRepo, {
      commitMessage: answers.commitMessage,
      interactive: !answers.skipPrompts && isInteractive(),
    });
    log.success('Native deploy complete.');
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

/* ─────────────────────────── Git helpers ─────────────────────────── */

function makeGit(): SimpleGit {
  return simpleGit({ baseDir: process.cwd() });
}

type GitFailureKind = 'auth' | 'not-found' | 'non-fast-forward' | 'unknown';

function classifyGitError(message: string): GitFailureKind {
  const text = message.toLowerCase();

  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('terminal prompts disabled') ||
    text.includes('permission denied') ||
    text.includes('403') ||
    text.includes('could not read from remote repository') ||
    text.includes('support for password authentication') ||
    (text.includes('workflow') && text.includes('scope'))
  ) {
    return 'auth';
  }

  if (
    text.includes('repository not found') ||
    text.includes("couldn't find remote ref") ||
    text.includes('does not exist')
  ) {
    return 'not-found';
  }

  if (text.includes('non-fast-forward') || text.includes('fetch first') || text.includes('updates were rejected')) {
    return 'non-fast-forward';
  }

  return 'unknown';
}

async function ensureGitIdentity(git: SimpleGit): Promise<void> {
  const [existingName, existingEmail] = await Promise.all([
    git.getConfig('user.name').catch(() => null),
    git.getConfig('user.email').catch(() => null),
  ]);

  const name = existingName?.value ?? null;
  const email = existingEmail?.value ?? null;

  if (name && email) return;

  if (!isInteractive()) {
    const missing = [!name ? 'user.name' : null, !email ? 'user.email' : null].filter(Boolean).join(' and ');
    throw new Error(
      `Git identity is not configured (missing ${missing}) and no terminal is available to prompt for it.\n` +
        `Configure it first, e.g.:\n` +
        `  git config --global user.name "Your Name"\n` +
        `  git config --global user.email "you@example.com"`,
    );
  }

  log.warn('Git author identity is not set - needed to create a commit.');

  let gitName = name;
  let gitEmail = email;

  try {
    if (!gitName) {
      gitName = await input({
        message: 'Your name (for git commits):',
        validate: (v: string) => v.trim().length > 0 || 'Name is required',
      });
    }

    if (!gitEmail) {
      gitEmail = await input({
        message: 'Your email (for git commits):',
        validate: (v: string) => /\S+@\S+\.\S+/.test(v) || 'Enter a valid email address',
      });
    }
  } catch (err) {
    if (isExitPromptError(err)) {
      throw new Error('Cancelled - a git identity is required to commit.');
    }
    throw err;
  }

  if (gitName) await git.addConfig('user.name', gitName);
  if (gitEmail) await git.addConfig('user.email', gitEmail);

  log.success('Git identity configured for this repository.');
}

function authHint(githubRepo: string, rawMessage: string): string {
  const slug = githubRepo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  return (
    'Push failed: GitHub rejected the request.\n' +
    '  Configure git credentials for GitHub over HTTPS with Git Credential Manager (GCM),\n' +
    '  then re-run bini-deploy. GCM opens a browser once and stores the credential in\n' +
    '  your OS keychain, so later pushes are silent. No PAT needed.\n\n' +
    '  Windows   Git for Windows 2.29+ already bundles GCM: just push once and sign in.\n' +
    '  macOS     brew install --cask git-credential-manager\n' +
    '  Linux     install GCM (git-credential-manager) and set:\n' +
    "              git config --global credential.helper manager\n\n" +
    `  Repo: https://github.com/${slug}\n` +
    `Raw git error:\n${rawMessage.trim()}`
  );
}

async function switchToDefaultBranch(git: SimpleGit): Promise<void> {
  // symbolic-ref also works on a repository with no commits yet.
  const current = (await git.raw(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
  if (!current || current === DEFAULT_BRANCH) return;

  log.info(`Switching from ${current} to ${DEFAULT_BRANCH}...`);
  try {
    const branches = await git.branchLocal();
    if (branches.all.includes(DEFAULT_BRANCH)) {
      await git.checkout(DEFAULT_BRANCH);
    } else {
      await git.raw(['branch', '-m', current, DEFAULT_BRANCH]);
    }
  } catch (err) {
    throw new Error(
      `Could not switch to '${DEFAULT_BRANCH}'. Commit or stash your local changes, then run again.\n` +
        `Raw git error:\n${(err as Error).message.trim()}`,
    );
  }
}

async function pushToGitHub(
  githubRepo: string,
  opts: { commitMessage?: string; interactive?: boolean } = {},
): Promise<void> {
  const cwd = process.cwd();
  const isGitRepo = existsSync(path.join(cwd, '.git'));
  const git = makeGit();

  if (!isGitRepo) {
    log.step('Initializing git repository...');
    try {
      await git.init(['--initial-branch', DEFAULT_BRANCH]);
    } catch (err) {
      throw new Error(`git init failed:\n${(err as Error).message}`);
    }
    log.info(`Setting remote origin: ${githubRepo}`);
    await git.addRemote('origin', githubRepo);
  } else {
    const remotes = await git.getRemotes(true).catch(() => []);
    const origin = remotes.find((r) => r.name === 'origin');
    if (origin) {
      log.info(`Using existing remote: ${origin.refs.fetch || origin.refs.push}`);
    } else {
      log.info(`Setting remote origin: ${githubRepo}`);
      await git.addRemote('origin', githubRepo);
    }
  }

  // Switch to main BEFORE staging/committing so the commit lands on main.
  await switchToDefaultBranch(git);

  log.step('Adding files to git...');
  await git.add(['--all']);

  await ensureGitIdentity(git);

  const status = await git.status();
  const hasChanges = status.files.length > 0;

  if (hasChanges) {
    let commitMessage = opts.commitMessage?.trim() || '';
    if (!commitMessage && opts.interactive) {
      commitMessage = (
        await input({
          message: 'Commit message (press Enter for the default):',
          default: DEFAULT_COMMIT_MESSAGE,
        })
      ).trim();
    }
    if (!commitMessage) commitMessage = DEFAULT_COMMIT_MESSAGE;

    log.step('Committing changes...');
    try {
      await git.commit(commitMessage);
      log.success('Changes committed');
    } catch (err) {
      const msg = (err as Error).message;
      if (/nothing to commit/i.test(msg)) {
        log.info('No changes to commit');
      } else {
        log.warn(`Failed to commit changes, continuing...\n${msg.trim()}`);
      }
    }
  } else {
    log.info('No changes to commit');
  }

  log.step('Pushing to GitHub...');

  const attemptPush = () => git.push('origin', `HEAD:${DEFAULT_BRANCH}`, ['--set-upstream']);

  try {
    await attemptPush();
    log.success('Push successful');
    return;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const kind = classifyGitError(message);

    if (kind === 'auth') {
      throw new Error(authHint(githubRepo, message));
    }

    if (kind === 'not-found') {
      throw new Error(
        `Push failed: repository not found at '${githubRepo}'.\n` +
          `  - Confirm the repository exists and the URL is correct\n` +
          `  - Confirm your account has push access to it\n` +
          `Raw git error:\n${message.trim()}`,
      );
    }

    if (kind !== 'non-fast-forward') {
      throw new Error(`Push failed:\n${message.trim() || 'Unknown git error.'}`);
    }

    log.warn('Push rejected - the remote has commits that are not present locally.');
    log.step('Attempting to fetch and merge remote changes...');

    try {
      await git.fetch('origin', DEFAULT_BRANCH);
    } catch (fetchErr) {
      throw new Error(
        `Failed to fetch '${DEFAULT_BRANCH}' from origin.\n` + `Raw git error:\n${(fetchErr as Error).message.trim()}`,
      );
    }

    log.warn(
      'Merging remote history with -X ours: for any file that exists both ' +
        'locally and on the remote, your local version will be kept and the ' +
        'remote version discarded. Files that only exist on the remote are ' +
        'still merged in normally.',
    );

    try {
      await git.raw([
        'merge',
        `origin/${DEFAULT_BRANCH}`,
        '--allow-unrelated-histories',
        '-X',
        'ours',
        '-m',
        'chore: merge remote changes',
      ]);
    } catch (mergeErr) {
      throw new Error(
        'Automatic merge failed, likely due to conflicting files (e.g. README.md).\n' +
          'Resolve the conflicts manually, then run:\n' +
          '  git add .\n' +
          '  git commit\n' +
          `  git push -u origin ${DEFAULT_BRANCH}\n\n` +
          `Raw git error:\n${(mergeErr as Error).message.trim()}`,
      );
    }

    try {
      await git.push('origin', `HEAD:${DEFAULT_BRANCH}`, ['--set-upstream']);
      log.success('Push successful after merging remote changes');
    } catch (finalErr) {
      throw new Error(
        'Push still failed after merging remote changes.\n' +
          'You can resolve this manually by running:\n' +
          `  git pull origin ${DEFAULT_BRANCH} --allow-unrelated-histories -X ours\n` +
          `  git push -u origin ${DEFAULT_BRANCH}\n\n` +
          `Raw git error:\n${(finalErr as Error).message.trim()}`,
      );
    }
  }
}

/* ─────────────────────────── CLI ─────────────────────────── */

const NATIVE_ALIASES: Record<string, NativeTarget> = {
  desktop: 'desktop',
  windows: 'desktop',
  macos: 'desktop',
  linux: 'desktop',
  android: 'android',
  ios: 'ios',
};

function parsePlatformArg(raw: string): { platform: 'web' | 'native'; targets: NativeTarget[] } {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error('--platform requires a value (web, desktop, android, ios)');

  const hasWeb = parts.includes('web');
  const targets: NativeTarget[] = [];

  for (const part of parts) {
    if (part === 'web') continue;
    const target = NATIVE_ALIASES[part];
    if (!target) throw new Error(`Unknown platform "${part}". Use: web, desktop, android, ios`);
    if (part === 'windows' || part === 'macos' || part === 'linux') {
      log.warn(`"${part}" is part of "desktop" now: one workflow builds Windows, macOS and Linux.`);
    }
    if (!targets.includes(target)) targets.push(target);
  }

  if (hasWeb && targets.length > 0) {
    throw new Error('web cannot be combined with desktop, android or ios. Run bini-deploy once for each.');
  }
  return hasWeb ? { platform: 'web', targets: [] } : { platform: 'native', targets };
}

const CLI_OPTIONS = {
  platform: { type: 'string' },
  hosting: { type: 'string' },
  repo: { type: 'string' },
  'generate-entry': { type: 'string' },
  message: { type: 'string', short: 'm' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parseArgs() {
  try {
    const { values } = nodeParseArgs({
      args: process.argv.slice(2),
      options: CLI_OPTIONS,
      allowPositionals: false,
      strict: true,
    });

    if (values.help) {
      showHelp();
      process.exit(0);
    }

    return {
      platformArg: values.platform as string | undefined,
      webHosting: values.hosting as Platform | undefined,
      githubRepo: values.repo as string | undefined,
      generateEntry: values['generate-entry'] as NonNodePlatform | undefined,
      commitMessage: values.message as string | undefined,
      dryRun: Boolean(values['dry-run']),
      skipPrompts: Boolean(values.yes),
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error(message);
    log.info('Run with --help to see available options.');
    process.exit(1);
  }
}

function showHelp(): void {
  log.plain(`
${c.heading('bini-deploy')} - Deploy Bini.js projects

${c.heading('Usage:')}
  bini-deploy [options]

${c.heading('Options:')}
  --platform <targets>    web, or any of desktop, android, ios (comma-separated, e.g. desktop,android)
                          desktop = Windows + macOS + Linux from one workflow
  --hosting <name>        Hosting provider for web: node, netlify, vercel, cloudflare, deno
  --repo <url>            GitHub repository URL
  --generate-entry <host> Generate production entry file only (netlify, vercel, cloudflare, deno)
  --message, -m <text>    Commit message (default: "chore: add deployment configuration"; prompted when interactive)
  --dry-run               Show what would be written and pushed, but do nothing
  --yes, -y               Skip interactive prompts (use provided flags)
  --help, -h              Show this help message

${c.heading('Git auth:')}
  Pushes use git over HTTPS. Configure Git Credential Manager (GCM) once and git
  will sign in through your browser (no Personal Access Token needed):
    Windows   Git for Windows 2.29+ bundles GCM; just push once and sign in
    macOS     brew install --cask git-credential-manager
    Linux     install git-credential-manager, then:
                git config --global credential.helper manager

${c.heading('Native targets:')}
  Copies .github/workflows/{desktop,android,ios}.yml from bini-deploy's own templates
  (kept in sync with the Tauri docs). If .env.signing is missing, it offers to run
  create-bini-app sign for each target that is part of this project (interactive runs
  only). It then uploads the values in .env.signing for the selected targets as
  repository secrets with the GitHub CLI (gh must be installed and logged in), and
  pushes the project to GitHub.

  Signing is configured by ${c.yellow('create-bini-app sign <target> --ci-only')}:
    Windows      a .pfx file, or a cloud signCommand in tauri.windows.conf.json
    macOS        a .p12 with an Apple signing identity; notarization via API key or Apple ID
    Linux        your GPG key (gpg --full-gen-key); CI reads GPG_PRIVATE_KEY + SIGN_KEY
    iOS          Apple Distribution .p12 + provisioning profile, or App Store Connect API key
    Android      a keystore .jks + password; keytool generates it locally or you supply one

  Builds, signing, and releases are done by tauri-action (desktop) or plain
  npx tauri android|ios build steps (mobile), as documented on v2.tauri.app.

${c.heading('Examples:')}
${[
  'bini-deploy --platform web --hosting vercel --repo https://github.com/user/my-app --yes',
  'bini-deploy --platform desktop,android,ios --repo https://github.com/user/my-app -y',
  'bini-deploy --platform desktop --repo https://github.com/user/my-app --dry-run',
  'bini-deploy --generate-entry netlify',
  'bini-deploy',
]
  .map((e) => `  ${c.dim(e)}`)
  .join('\n')}
`);
}

async function getAnswersInteractive(): Promise<DeployAnswers> {
  const picked = await checkbox<'web' | NativeTarget>({
    message: 'Platforms?',
    choices: [
      { name: 'Web', value: 'web' },
      { name: NATIVE_LABELS.desktop, value: 'desktop' },
      { name: NATIVE_LABELS.android, value: 'android' },
      { name: NATIVE_LABELS.ios, value: 'ios' },
    ],
    required: true,
    validate: (values) =>
      !(values.includes('web') && values.length > 1) ||
      'Web cannot be combined with desktop, Android or iOS - run deploy once for each.',
  });

  const kind: 'web' | 'native' = picked.includes('web') ? 'web' : 'native';
  const targets = picked.filter((p): p is NativeTarget => p !== 'web');

  let webHosting: Platform | undefined;
  if (kind === 'web') {
    webHosting = await select<Platform>({
      message: 'Hosting provider?',
      choices: Object.entries(HOSTING_CONFIGS).map(([key, config]) => ({
        name: config.label,
        value: key as Platform,
      })),
    });
  }

  let githubRepo = '';
  const isGitRepo = existsSync(path.join(process.cwd(), '.git'));

  if (isGitRepo) {
    const git = makeGit();
    const remotes = await git.getRemotes(true).catch(() => []);
    const origin = remotes.find((r) => r.name === 'origin');
    if (origin) {
      githubRepo = origin.refs.fetch || origin.refs.push;
      log.info(`Using existing git remote: ${githubRepo}`);
    }
  }

  if (!githubRepo) {
    githubRepo = await input({
      message: 'GitHub repository URL?',
      validate: (value: string) => GITHUB_URL_REGEX.test(value) || 'Please enter a valid GitHub repository URL',
    });
  }

  return {
    platform: kind,
    targets,
    webHosting,
    githubRepo,
    projectName: githubRepo.split('/').pop() || 'my-app',
    skipPrompts: false,
  };
}

async function getAnswersFromFlags(flags: {
  platformArg?: string;
  githubRepo?: string;
  webHosting?: Platform;
}): Promise<DeployAnswers> {
  if (!flags.platformArg) {
    throw new Error('--platform is required when using --yes flag');
  }

  if (!flags.githubRepo) {
    throw new Error('--repo is required when using --yes flag');
  }

  const { platform, targets } = parsePlatformArg(flags.platformArg);
  const webHosting = platform === 'web' ? flags.webHosting ?? 'node' : flags.webHosting;

  return {
    platform,
    targets,
    webHosting,
    githubRepo: flags.githubRepo,
    projectName: flags.githubRepo.split('/').pop() || 'my-app',
    skipPrompts: true,
  };
}

function validateAnswers(answers: DeployAnswers): void {
  if (!answers.platform) {
    throw new Error('Platform is required');
  }

  if (answers.platform === 'web' && !answers.webHosting) {
    throw new Error('Hosting provider is required for web platform');
  }

  if (answers.platform === 'native' && answers.targets.length === 0) {
    throw new Error('Select at least one native target (desktop, android, ios)');
  }

  if (!answers.githubRepo) {
    throw new Error('GitHub repository URL is required');
  }

  if (!GITHUB_URL_REGEX.test(answers.githubRepo)) {
    throw new Error('Invalid GitHub repository URL');
  }
}

async function executeDeployment(answers: DeployAnswers, dryRun: boolean): Promise<void> {
  const spinner = clack.spinner();
  spinner.start('Generating deployment files...');

  try {
    const { platform, webHosting, githubRepo, projectName } = answers;

    if (platform === 'web' && webHosting && webHosting !== 'node') {
      spinner.message(`Generating production API entry for ${webHosting}...`);

      try {
        await generateProductionEntry(webHosting);
      } catch {
        log.warn('Failed to generate production entry, but continuing...');
      }

      spinner.message(`Generating ${HOSTING_CONFIGS[webHosting].label} configuration...`);
      const configPath = await generateHostingConfig(webHosting, projectName);
      if (configPath) {
        log.info(`Generated ${path.relative(process.cwd(), configPath)}`);
      }
    } else if (platform === 'web') {
      spinner.message('Cleaning up old platform artifacts...');
      cleanupPlatformArtifacts('node', isTypeScriptProject());
    }

    if (platform === 'native') {
      spinner.message('Removing web hosting files...');
      cleanupPlatformArtifacts('node', isTypeScriptProject());
      spinner.stop();
      await deployNative(answers, dryRun);
    } else {
      spinner.stop();
      if (dryRun) {
        log.plain(`\n${c.yellow('Dry run:')} no files pushed.`);
        return;
      }
      await pushToGitHub(githubRepo, {
        commitMessage: answers.commitMessage,
        interactive: !answers.skipPrompts && isInteractive(),
      });
    }

    log.success(dryRun ? 'Dry run complete' : 'All files generated and pushed to GitHub');

    log.plain(`\n${c.heading('Deployment summary')}`);
    log.plain(`  ${c.dim('Platform:')}   ${answers.platform === 'native' ? answers.targets.join(', ') : answers.platform}`);
    if (answers.platform === 'web' && answers.webHosting) {
      log.plain(`  ${c.dim('Hosting:')}    ${HOSTING_CONFIGS[answers.webHosting].label}`);
    }
    log.plain(`  ${c.dim('Repository:')} ${c.cyan(answers.githubRepo)}`);

    showNextSteps(answers);
  } catch (error) {
    spinner.stop();
    if (!isExitPromptError(error)) {
      log.error(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function printSteps(steps: string[]): void {
  steps.forEach((step, i) => log.plain(`  ${c.green(`${i + 1}.`)} ${step}`));
}

function showNextSteps(answers: DeployAnswers): void {
  const { webHosting, githubRepo } = answers;
  if (answers.platform !== 'web' || !webHosting) return;

  log.plain(`\n${c.heading('Next steps')}`);
  printSteps(WEB_NEXT_STEPS[webHosting](detectPackageManager()));
  log.plain(`  ${c.dim(`Repository: ${githubRepo}`)}\n`);
}

async function deployCLI(): Promise<void> {
  const flags = parseArgs();

  log.plain(`\n${c.heading('Bini.js Deploy')}\n`);

  try {
    if (flags.generateEntry) {
      await generateProductionEntry(flags.generateEntry);
      process.exit(0);
    }

    let answers: DeployAnswers;

    if (flags.skipPrompts) {
      answers = await getAnswersFromFlags(flags);
    } else if (!isInteractive()) {
      log.error('Interactive mode requires a TTY. Use --yes flag with required options.');
      log.info('Example: bini-deploy --platform web --hosting vercel --repo https://github.com/user/repo --yes');
      process.exit(1);
    } else {
      answers = await getAnswersInteractive();
    }

    answers.commitMessage = flags.commitMessage;

    validateAnswers(answers);

    const hostingLabel = answers.webHosting ? HOSTING_CONFIGS[answers.webHosting].label : 'N/A';

    log.plain(`\n${c.heading('Deployment summary')}`);
    log.plain(`  ${c.dim('Platform:')}   ${answers.platform === 'native' ? answers.targets.join(', ') : answers.platform}`);
    if (answers.platform === 'web') {
      log.plain(`  ${c.dim('Hosting:')}    ${hostingLabel}`);
    }
    log.plain(`  ${c.dim('Repository:')} ${c.cyan(answers.githubRepo)}\n`);

    if (flags.dryRun) {
      log.plain(`${c.yellow('Dry run:')} no files will be written and nothing will be pushed.\n`);
    }

    if (!answers.skipPrompts && isInteractive() && !flags.dryRun) {
      const confirmed = await confirm({
        message: 'Generate deployment files and push to GitHub?',
        default: true,
      });

      if (!confirmed) {
        log.info('Deployment cancelled.');
        return;
      }
    }

    await executeDeployment(answers, Boolean(flags.dryRun));
  } catch (error) {
    if (isExitPromptError(error)) {
      log.plain('');
      log.warn('Operation cancelled.');
      process.exit(130);
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Deployment failed: ${message}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  log.plain('');
  log.warn('Operation cancelled.');
  process.exit(130);
});
process.on('SIGTERM', () => process.exit(143));

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  deployCLI().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    process.exit(1);
  });
}

export type { Platform, NonNodePlatform, NativeTarget, SigningTarget, DeployAnswers, ApiRoute };