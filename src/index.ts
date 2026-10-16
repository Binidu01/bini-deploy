import { existsSync, readdirSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { writeFile } from 'fs/promises';
import { createRequire } from 'module';
import crossSpawn from 'cross-spawn';
import path from 'path';
import { fileURLToPath } from 'url';
import { isatty } from 'tty';
import { styleText } from 'node:util';
import * as clack from '@clack/prompts';

const require = createRequire(import.meta.url);

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

const password = (o: { message: string; validate?: (v: string) => true | string }): Promise<string> =>
  ask<string>(clack.password({ message: o.message, mask: '*', validate: toValidate(o.validate) }));

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

function createSpinner(initial: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const tty = Boolean(process.stdout.isTTY);
  let timer: NodeJS.Timeout | undefined;
  let text = initial;
  let frame = 0;

  const render = (): void => {
    process.stdout.write(`\r\x1b[2K${paint('cyan', frames[frame++ % frames.length] as string)} ${text}`);
  };
  const clear = (): void => {
    if (tty) process.stdout.write('\r\x1b[2K');
  };

  const spinner = {
    get isSpinning(): boolean {
      return timer !== undefined;
    },
    get text(): string {
      return text;
    },
    set text(value: string) {
      text = value;
    },
    start(message?: string) {
      if (message) text = message;
      if (timer === undefined && tty) {
        render();
        timer = setInterval(render, 80);
        timer.unref();
      } else if (timer === undefined) {
        log.step(text);
        timer = setInterval(() => {}, 1 << 30);
        timer.unref();
      }
      return spinner;
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
        clear();
      }
    },
    fail(message: string) {
      spinner.stop();
      log.error(message);
    },
  };
  return spinner;
}

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;
const ALLOWED_ROUTE_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_PARAM_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ROUTE_SEGMENT_LENGTH = 100;
const MAX_API_SCAN_DEPTH = 100;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const API_EXTS = ['.ts', '.js'] as const;

const DEFAULT_BRANCH = 'main';

const ACTIONS = {
  checkout: 'actions/checkout@v4.2.2',
  setupNode: 'actions/setup-node@v4.1.0',
  setupPnpm: 'pnpm/action-setup@v4.1.0',
  setupBun: 'oven-sh/setup-bun@v2.0.1',
  setupJava: 'actions/setup-java@v4.5.0',
  rustToolchain: 'dtolnay/rust-toolchain@stable',
  rustCache: 'swatinem/rust-cache@v2.7.5',
  uploadArtifact: 'actions/upload-artifact@v4.4.3',
} as const;

type Platform = 'node' | 'netlify' | 'vercel' | 'cloudflare' | 'deno';
type NonNodePlatform = Exclude<Platform, 'node'>;

type NativePlatform = 'desktop' | 'android' | 'ios';

type SigningTarget = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

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
  targets: NativePlatform[];
  webHosting?: Platform;
  githubRepo: string;
  projectName: string;
  skipPrompts: boolean;
  noSign: boolean;
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
    `If you use Workers Builds, the Worker name in the dashboard must match ${c.yellow('name')} in ${c.yellow('wrangler.toml')}`,
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

function resolveEntryImportPath(
  filePath: string,
  outFile: string,
  usesDenoRuntime: boolean,
): string {
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
    `  // Paths with a file extension: serve the file as-is, otherwise a real 404`,
    `  if (/\\.[a-zA-Z0-9]+$/.test(pathname)) {`,
    `    const file = await tryRead(pathname);`,
    `    if (!file) return notFound();`,
    `    const ext = pathname.split('.').pop();`,
    `    return new Response(file, {`,
    `      headers: { 'Content-Type': contentTypes[ext] || 'application/octet-stream' },`,
    `    });`,
    `  }`,
    ``,
    `  // Extensionless paths: the prerendered page dist/<route>/index.html`,
    `  const clean = pathname.replace(/\\/+$/, '');`,
    `  const page = await tryRead(clean + '/index.html');`,
    `  if (page) return htmlResponse(page);`,
    ``,
    `  // Dynamic routes (/blog/123): nearest parent shell written by bini-ssg`,
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

  const { imports, mountings, corsLine, corsImport } = buildRouteImports(
    routes,
    outFile,
    enableCors,
    platform,
  );

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
      `Missing required package for platform '${platform}'.\n` +
      `  Run: npm install ${adapter.pkg}`
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
  basePath: string = ''
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

async function generateHostingConfig(
  hosting: NonNodePlatform,
  projectName: string,
): Promise<string | null> {
  const cwd = process.cwd();
  const pm = detectPackageManager().pm;

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

      await writeFile(
        path.join(edgeDir, ts ? 'spa-fallback.ts' : 'spa-fallback.js'),
        fallbackBody,
      );
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

const WORKFLOWS_DIR = path.join('.github', 'workflows');
const NODE_VERSION = '22';
const LINUX_RUNNER = 'ubuntu-22.04';

const workflowHeader = (pm: PackageManager): string =>
  [
    '# Auto-generated by bini-deploy - do not edit.',
    `# Regenerated every time you run \`${scriptCommand(pm, 'deploy')}\`.`,
  ].join('\n');

const WORKFLOW_FILES: Record<NativePlatform, string> = {
  desktop: 'desktop.yml',
  android: 'android.yml',
  ios: 'ios.yml',
};

const NATIVE_BUILD_SCRIPTS: Record<NativePlatform, string> = {
  desktop: 'tauri:build',
  android: 'android:build',
  ios: 'ios:build',
};

const NATIVE_LABELS: Record<NativePlatform, string> = {
  desktop: 'Desktop (Windows, macOS, Linux)',
  android: 'Android',
  ios: 'iOS',
};

interface PackageManagerInfo {
  pm: PackageManager;
  hasLock: boolean;
  pnpmNeedsVersion: boolean;
  yarnBerry: boolean;
}

const LOCK_FILES: Array<[file: string, pm: PackageManager]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
];

function readPackageJson(): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function detectPackageManager(): PackageManagerInfo {
  const cwd = process.cwd();
  const pkg = readPackageJson();
  const hit = LOCK_FILES.find(([file]) => existsSync(path.join(cwd, file)));

  let pm: PackageManager = 'npm';
  let hasLock = false;
  if (hit) {
    pm = hit[1];
    hasLock = true;
  } else {
    const ua = process.env.npm_config_user_agent?.split(' ')[0]?.split('/')[0];
    if (ua === 'bun' || ua === 'yarn' || ua === 'pnpm' || ua === 'npm') pm = ua;
  }

  const yarnBerry = pm === 'yarn' && existsSync(path.join(cwd, '.yarnrc.yml'));
  return { pm, hasLock, pnpmNeedsVersion: pm === 'pnpm' && !pkg?.packageManager, yarnBerry };
}

function scriptCommand(pm: PackageManager, script: string, args: string[] = []): string {
  if (pm === 'npm') return `npm run ${script}${args.length ? ` -- ${args.join(' ')}` : ''}`;
  return `${pm} run ${script}${args.length ? ` ${args.join(' ')}` : ''}`;
}

function installCommand(info: PackageManagerInfo): string {
  switch (info.pm) {
    case 'npm':
      return info.hasLock ? 'npm ci' : 'npm install';
    case 'pnpm':
      return info.hasLock ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'bun':
      return info.hasLock ? 'bun install --frozen-lockfile' : 'bun install';
    case 'yarn':
      if (!info.hasLock) return 'yarn install';
      return info.yarnBerry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  }
}

const indent = (text: string, spaces: number): string =>
  text
    .split('\n')
    .map((line) => (line.length > 0 ? ' '.repeat(spaces) + line : line))
    .join('\n');

const ghx = (text: string): string => text.replace(/§\{\{/g, () => '$' + '{{');

const secretEnv = (names: string[]): string => names.map((n) => `${n}: §{{ secrets.${n} }}`).join('\n');

function setupSteps(info: PackageManagerInfo): string[] {
  const steps: string[] = [`- uses: ${ACTIONS.checkout}`];
  if (info.pm === 'pnpm') {
    steps.push(
      info.pnpmNeedsVersion
        ? `- uses: ${ACTIONS.setupPnpm}\n  with:\n    version: 10`
        : `- uses: ${ACTIONS.setupPnpm}`,
    );
  }
  if (info.pm === 'bun') steps.push(`- uses: ${ACTIONS.setupBun}`);
  const cache = info.hasLock && info.pm !== 'bun' ? `\n    cache: ${info.pm}` : '';
  steps.push(`- uses: ${ACTIONS.setupNode}\n  with:\n    node-version: '${NODE_VERSION}'${cache}`);
  return steps;
}

const installStep = (info: PackageManagerInfo): string =>
  `- name: Install dependencies\n  run: ${installCommand(info)}`;

const iconStep = (pm: PackageManager): string =>
  `- name: Generate app icons\n  run: ${scriptCommand(pm, 'tauri:icon')}`;

function rustSteps(targets?: string[]): string[] {
  const toolchain = targets?.length
    ? `- name: Install Rust\n  uses: ${ACTIONS.rustToolchain}\n  with:\n    targets: ${targets.join(',')}`
    : `- name: Install Rust\n  uses: ${ACTIONS.rustToolchain}`;
  return [toolchain, `- uses: ${ACTIONS.rustCache}\n  with:\n    workspaces: src-tauri`];
}

const WORKFLOW_TRIGGERS = `on:
  workflow_dispatch:
  push:
    tags:
      - 'v*'

permissions:
  contents: read`;

function renderWorkflow(head: string, jobLines: string, steps: string[], pm: PackageManager): string {
  return (
    ghx(
      [workflowHeader(pm), head, '', WORKFLOW_TRIGGERS, '', jobLines, '    steps:', steps.map((s) => indent(s, 6)).join('\n\n')].join('\n'),
    ) + '\n'
  );
}

type CloudSignTool = 'artifact-signing' | 'relic' | 'sslcom' | 'jsign' | 'unknown' | null;

function detectCloudSignTool(projectPath: string): CloudSignTool {
  const confPath = path.join(projectPath, 'src-tauri', 'tauri.cloud-sign.conf.json');
  if (!existsSync(confPath)) return null;
  try {
    const conf = JSON.parse(readFileSync(confPath, 'utf8')) as {
      bundle?: { windows?: { signCommand?: string } };
    };
    const cmd = conf.bundle?.windows?.signCommand ?? '';
    if (/artifact-signing-cli/i.test(cmd)) return 'artifact-signing';
    if (/relic/i.test(cmd)) return 'relic';
    if (/CodeSignTool|eSigner|ssl\.com/i.test(cmd)) return 'sslcom';
    if (/jsign/i.test(cmd)) return 'jsign';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function cloudSignInstallSteps(tool: CloudSignTool): string[] {
  switch (tool) {
    case 'artifact-signing':
      return [
        `- name: Install Azure Artifact Signing CLI
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    dotnet tool install --global artifact-signing-cli
    echo "$env:USERPROFILE\\.dotnet\\tools" | Out-File -FilePath $env:GITHUB_PATH -Append`,
      ];
    case 'relic':
      return [
        `- name: Install relic (Azure Key Vault signing)
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    cargo install relic
    echo "$env:USERPROFILE\\.cargo\\bin" | Out-File -FilePath $env:GITHUB_PATH -Append`,
      ];
    case 'sslcom':
      return [
        `- name: Install SSL.com eSigner CodeSignTool
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    Invoke-WebRequest -Uri "https://www.ssl.com/download/codesigntool/CodeSignTool-latest.zip" -OutFile CodeSignTool.zip
    Expand-Archive CodeSignTool.zip -DestinationPath .
    echo "$PWD\\CodeSignTool" | Out-File -FilePath $env:GITHUB_PATH -Append`,
      ];
    case 'jsign':
      return [
        `- name: Install jsign
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    Invoke-WebRequest -Uri "https://github.com/ebourg/jsign/releases/latest/download/jsign.jar" -OutFile jsign.jar
    echo "JSIGN_JAR=$PWD\\jsign.jar" | Out-File -FilePath $env:GITHUB_ENV -Append`,
      ];
    default:
      return [];
  }
}

const WINDOWS_SIGN_SCRIPT = `$confPath = 'src-tauri/tauri.conf.json'
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
if (-not $conf.bundle) { $conf | Add-Member -NotePropertyName bundle -NotePropertyValue ([pscustomobject]@{}) }
if (-not $conf.bundle.windows) { $conf.bundle | Add-Member -NotePropertyName windows -NotePropertyValue ([pscustomobject]@{}) }
$win = $conf.bundle.windows
$win.PSObject.Properties.Remove('certificateThumbprint')
$thumbprint = $null
if ($env:WINDOWS_CERTIFICATE) {
  $pfx = Join-Path $env:RUNNER_TEMP 'bini-certificate.pfx'
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  $pw = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $imported = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\\CurrentUser\\My -Password $pw
  Remove-Item $pfx -Force
  $thumbprint = ($imported | Where-Object { $_.HasPrivateKey } | Select-Object -First 1).Thumbprint
  Write-Host 'Windows certificate imported.'
} elseif ($env:WINDOWS_PUBLISHER) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=' + $env:WINDOWS_PUBLISHER) -CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
  $thumbprint = $cert.Thumbprint
  Write-Host ('Created a self-signed certificate for ' + $env:WINDOWS_PUBLISHER + '.')
  if ($env:GH_TOKEN) {
    $pfxPassword = [guid]::NewGuid().ToString('N')
    $pfx = Join-Path $env:RUNNER_TEMP 'bini-generated.pfx'
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pfxPassword -AsPlainText -Force) | Out-Null
    gh secret set WINDOWS_CERTIFICATE --repo $env:GITHUB_REPOSITORY --body ([Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx)))
    $certExit = $LASTEXITCODE
    gh secret set WINDOWS_CERTIFICATE_PASSWORD --repo $env:GITHUB_REPOSITORY --body $pfxPassword
    $pwExit = $LASTEXITCODE
    Remove-Item $pfx -Force
    if ($certExit -eq 0 -and $pwExit -eq 0) {
      Write-Host 'Saved the certificate as a GitHub secret: later builds reuse it.'
    } else {
      Write-Host '::warning title=SECRETS_PAT could not save the certificate::gh secret set failed. This certificate is temporary and a new one will be created on every build. Check that SECRETS_PAT exists and has Secrets: Read and write for this repository.'
    }
  } else {
    Write-Host 'No SECRETS_PAT secret: this certificate is temporary and a new one is created on every build.'
  }
} elseif (Test-Path 'src-tauri/tauri.cloud-sign.conf.json') {
  'BINI_TAURI_ARGS=--config src-tauri/tauri.cloud-sign.conf.json' | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  Write-Host 'Using src-tauri/tauri.cloud-sign.conf.json for Windows cloud signing.'
} else {
  Write-Host 'No Windows signing secrets found: building an unsigned Windows app.'
}
if ($thumbprint) {
  $win | Add-Member -NotePropertyName certificateThumbprint -NotePropertyValue $thumbprint -Force
  $win | Add-Member -NotePropertyName digestAlgorithm -NotePropertyValue 'sha256' -Force
  $win | Add-Member -NotePropertyName timestampUrl -NotePropertyValue 'http://timestamp.digicert.com' -Force
}
$conf | ConvertTo-Json -Depth 32 | Set-Content -Path $confPath -Encoding utf8`;

function macosSignScript(): string {
  const exportVar = (name: string): string => `  if [ -n "$${name}" ]; then echo "${name}=$${name}" >> "$GITHUB_ENV"; fi`;
  return [
    `identity=''`,
    `if [ -n "$APPLE_CERTIFICATE" ] && [ -n "$APPLE_CERTIFICATE_PASSWORD" ]; then`,
    `  identity="$APPLE_SIGNING_IDENTITY"`,
    exportVar('APPLE_CERTIFICATE'),
    exportVar('APPLE_CERTIFICATE_PASSWORD'),
    exportVar('KEYCHAIN_PASSWORD'),
    exportVar('APPLE_API_ISSUER'),
    exportVar('APPLE_API_KEY'),
    exportVar('APPLE_ID'),
    exportVar('APPLE_PASSWORD'),
    exportVar('APPLE_TEAM_ID'),
    `  if [ -n "$APPLE_API_KEY_P8" ]; then`,
    `    key_path="$RUNNER_TEMP/AuthKey.p8"`,
    `    echo "$APPLE_API_KEY_P8" | base64 --decode > "$key_path"`,
    `    echo "APPLE_API_KEY_PATH=$key_path" >> "$GITHUB_ENV"`,
    `  fi`,
    `else`,
    `  echo "No macOS signing secrets found: building with an ad-hoc signature."`,
    `fi`,
    `if [ -z "$identity" ]; then identity='-'; fi`,
    `echo "APPLE_SIGNING_IDENTITY=$identity" >> "$GITHUB_ENV"`,
    `tmp="$(mktemp)"`,
    `jq --arg id "$identity" '.bundle.macOS.signingIdentity = $id' src-tauri/tauri.conf.json > "$tmp"`,
    `mv "$tmp" src-tauri/tauri.conf.json`,
  ].join('\n');
}

const LINUX_SIGN_SCRIPT = [
  `key_id=''`,
  `rpm_armored=''`,
  `if [ -n "$GPG_PRIVATE_KEY" ]; then`,
  `  echo "$GPG_PRIVATE_KEY" | base64 --decode | gpg --batch --import`,
  `  echo "$GPG_PRIVATE_KEY" | base64 --decode > "$RUNNER_TEMP/rpm-signing-key.asc"`,
  `  rpm_armored="$RUNNER_TEMP/rpm-signing-key.asc"`,
  `  key_id="$SIGN_KEY"`,
  `elif [ -n "$LINUX_PUBLISHER" ]; then`,
  `  name="$LINUX_PUBLISHER"`,
  `  if [ \${#name} -lt 5 ]; then name="$name App"; fi`,
  `  printf '%s\\n' 'Key-Type: RSA' 'Key-Length: 4096' 'Subkey-Type: RSA' 'Subkey-Length: 4096' "Name-Real: $name" 'Expire-Date: 3y' '%no-protection' '%commit' > "$RUNNER_TEMP/gpg-batch"`,
  `  gpg --batch --pinentry-mode loopback --gen-key "$RUNNER_TEMP/gpg-batch"`,
  `  rm -f "$RUNNER_TEMP/gpg-batch"`,
  `  key_id="$(gpg --list-secret-keys --with-colons --keyid-format LONG | awk -F: '/^sec:/ {print $5; exit}')"`,
  `  gpg --batch --armor --export-secret-keys "$key_id" > "$RUNNER_TEMP/rpm-signing-key.asc"`,
  `  rpm_armored="$RUNNER_TEMP/rpm-signing-key.asc"`,
  `  echo "Created a GPG key for $LINUX_PUBLISHER."`,
  `  if [ -n "$GH_TOKEN" ]; then`,
  `    gpg --batch --armor --export-secret-keys "$key_id" | base64 -w0 > "$RUNNER_TEMP/gpg.b64"`,
  `    gh secret set GPG_PRIVATE_KEY --repo "$GITHUB_REPOSITORY" < "$RUNNER_TEMP/gpg.b64"`,
  `    key_exit=$?`,
  `    printf '%s' "$key_id" | gh secret set SIGN_KEY --repo "$GITHUB_REPOSITORY"`,
  `    id_exit=$?`,
  `    rm -f "$RUNNER_TEMP/gpg.b64"`,
  `    if [ "$key_exit" -eq 0 ] && [ "$id_exit" -eq 0 ]; then`,
  `      echo "Saved the key as a GitHub secret: later builds reuse it."`,
  `    else`,
  `      echo "::warning title=SECRETS_PAT could not save the GPG key::gh secret set failed. This key is temporary and a new one will be created on every build. Check that SECRETS_PAT exists and has Secrets: Read and write for this repository."`,
  `    fi`,
  `  else`,
  `    echo "No SECRETS_PAT secret: this key is temporary and a new one is created on every build."`,
  `  fi`,
  `fi`,
  `if [ -z "$key_id" ]; then`,
  `  echo "No Linux signing secrets found: the AppImage and RPM will be unsigned."`,
  `  exit 0`,
  `fi`,
  `{ echo "SIGN=1"; echo "SIGN_KEY=$key_id"; echo "APPIMAGETOOL_FORCE_SIGN=1"; } >> "$GITHUB_ENV"`,
  `if [ -n "$APPIMAGETOOL_SIGN_PASSPHRASE" ]; then`,
  `  echo "APPIMAGETOOL_SIGN_PASSPHRASE=$APPIMAGETOOL_SIGN_PASSPHRASE" >> "$GITHUB_ENV"`,
  `  echo "TAURI_SIGNING_RPM_KEY_PASSPHRASE=$APPIMAGETOOL_SIGN_PASSPHRASE" >> "$GITHUB_ENV"`,
  `fi`,
  `if [ -n "$rpm_armored" ] && [ -f "$rpm_armored" ]; then`,
  `  {`,
  `    echo "TAURI_SIGNING_RPM_KEY<<EOF"`,
  `    cat "$rpm_armored"`,
  `    echo "EOF"`,
  `  } >> "$GITHUB_ENV"`,
  `fi`,
].join('\n');

function buildDesktopWorkflow(info: PackageManagerInfo): string {
  const pm = info.pm;
  const cloudTool = detectCloudSignTool(process.cwd());

  const steps: string[] = [
    ...setupSteps(info),
    ...cloudSignInstallSteps(cloudTool),
    ...(cloudTool === 'unknown' ? [`- name: Warn about unknown Windows cloud signing tool
  if: runner.os == 'Windows'
  shell: pwsh
  run: Write-Host '::warning title=Windows cloud signing tool not installed::tauri.cloud-sign.conf.json is present but the signCommand does not match a tool this workflow knows how to install. Add an install step for your vendor CLI (Azure Artifact Signing, Azure Key Vault/relic, SSL.com eSigner, jsign) or the Windows build will fail.'`] : []),
    ...rustSteps(),
    `- name: Install Linux dependencies
  if: runner.os == 'Linux'
  run: |
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`,
    installStep(info),
    iconStep(pm),
    `- name: Configure Windows signing
  if: runner.os == 'Windows'
  shell: pwsh
  env:
${indent(secretEnv(['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_PUBLISHER']), 4)}
    GH_TOKEN: §{{ secrets.SECRETS_PAT }}
  run: |
${indent(WINDOWS_SIGN_SCRIPT, 4)}`,
    `- name: Configure macOS signing
  if: runner.os == 'macOS'
  env:
${indent(secretEnv(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'KEYCHAIN_PASSWORD', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']), 4)}
  run: |
${indent(macosSignScript(), 4)}`,
    `- name: Configure Linux signing
  if: runner.os == 'Linux'
  env:
${indent(secretEnv(['GPG_PRIVATE_KEY', 'SIGN_KEY', 'APPIMAGETOOL_SIGN_PASSPHRASE', 'LINUX_PUBLISHER', 'APPIMAGETOOL_FORCE_SIGN', 'TAURI_SIGNING_RPM_KEY', 'TAURI_SIGNING_RPM_KEY_PASSPHRASE']), 4)}
    GH_TOKEN: §{{ secrets.SECRETS_PAT }}
  run: |
${indent(LINUX_SIGN_SCRIPT, 4)}`,
    `- name: Build desktop app
  env:
    TAURI: 'true'
  run: |
    ${scriptCommand(pm, NATIVE_BUILD_SCRIPTS.desktop, ['§{{ env.BINI_TAURI_ARGS }}'])}`,
    `- uses: ${ACTIONS.uploadArtifact}
  with:
    name: desktop-§{{ matrix.label }}
    path: src-tauri/target/release/bundle/**
    if-no-files-found: error`,
  ];

  const job = `concurrency:
  group: desktop-§{{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: Build (§{{ matrix.label }})
    runs-on: §{{ matrix.os }}
    timeout-minutes: 60
    defaults:
      run:
        shell: bash
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: windows-latest, label: Windows }
          - { os: macos-latest, label: macOS }
          - { os: ${LINUX_RUNNER}, label: Linux }`;

  return renderWorkflow('name: Bini Desktop', job, steps, pm);
}

const ANDROID_SIGN_SCRIPT = [
  `keystore="$RUNNER_TEMP/release.jks"`,
  `alias="\${ANDROID_KEY_ALIAS:-upload}"`,
  `if [ -x "./node_modules/.bin/create-bini-app" ]; then`,
  `  CREATE_BINI_APP_CMD="./node_modules/.bin/create-bini-app"`,
  `else`,
  `  CREATE_BINI_APP_CMD="npx create-bini-app"`,
  `fi`,
  `if [ -n "$ANDROID_KEY_BASE64" ]; then`,
  `  echo "$ANDROID_KEY_BASE64" | base64 --decode > "$keystore"`,
  `elif [ -n "$ANDROID_PUBLISHER" ] && [ -n "$BINI_SIGN_PASSWORD" ]; then`,
  `  keytool -genkeypair -keystore "$keystore" -keyalg RSA -keysize 2048 -validity 10000 -alias "$alias" -storepass:env BINI_SIGN_PASSWORD -keypass:env BINI_SIGN_PASSWORD -dname "CN=$ANDROID_PUBLISHER, OU=Dev, O=$ANDROID_PUBLISHER, C=US"`,
  `  export BINI_KEY_PASSWORD="$BINI_SIGN_PASSWORD"`,
  `  echo "Created a keystore for $ANDROID_PUBLISHER."`,
  `  if [ -n "$GH_TOKEN" ]; then`,
  `    base64 -w0 "$keystore" > "$RUNNER_TEMP/release.b64"`,
  `    gh secret set ANDROID_KEY_BASE64 --repo "$GITHUB_REPOSITORY" < "$RUNNER_TEMP/release.b64"`,
  `    secret_exit=$?`,
  `    rm -f "$RUNNER_TEMP/release.b64"`,
  `    if [ "$secret_exit" -eq 0 ]; then`,
  `      echo "Saved the keystore as a GitHub secret: later builds reuse it."`,
  `    else`,
  `      echo "::warning title=SECRETS_PAT could not save the keystore::gh secret set failed. This keystore is temporary and a new one will be created on every build. Check that SECRETS_PAT exists and has Secrets: Read and write for this repository."`,
  `    fi`,
  `  else`,
  `    echo "No SECRETS_PAT secret: this keystore is temporary and a new one is created on every build."`,
  `  fi`,
  `else`,
  `  echo "No Android signing secrets found: the release build will be unsigned."`,
  `  exit 0`,
  `fi`,
  `$CREATE_BINI_APP_CMD sign android "$keystore" --alias "$alias"`,
].join('\n');

function buildAndroidWorkflow(info: PackageManagerInfo): string {
  const pm = info.pm;

  const steps: string[] = [
    ...setupSteps(info),
    `- uses: ${ACTIONS.setupJava}
  with:
    distribution: temurin
    java-version: '17'`,
    ...rustSteps(['aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android']),
    `- name: Select Android NDK
  run: echo "NDK_HOME=$ANDROID_NDK_LATEST_HOME" >> "$GITHUB_ENV"`,
    installStep(info),
    `- name: Initialize Android project (if missing)
  run: |
    if [ ! -d src-tauri/gen/android ]; then
      ${scriptCommand(pm, 'tauri', ['android', 'init', '--ci'])}
    fi`,
    iconStep(pm),
    `- name: Configure Android signing
  env:
${indent(secretEnv(['ANDROID_KEY_BASE64', 'ANDROID_KEY_ALIAS', 'ANDROID_PUBLISHER']), 4)}
    BINI_SIGN_PASSWORD: §{{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    BINI_KEY_PASSWORD: §{{ secrets.ANDROID_KEY_PASSWORD }}
    GH_TOKEN: §{{ secrets.SECRETS_PAT }}
  run: |
${indent(ANDROID_SIGN_SCRIPT, 4)}`,
    `- name: Build Android app
  run: |
    ${scriptCommand(pm, NATIVE_BUILD_SCRIPTS.android)}`,
    `- uses: ${ACTIONS.uploadArtifact}
  with:
    name: android
    path: |
      src-tauri/gen/android/app/build/outputs/**/*.apk
      src-tauri/gen/android/app/build/outputs/**/*.aab
    if-no-files-found: error`,
  ];

  const job = `concurrency:
  group: android-§{{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: Build (Android)
    runs-on: ubuntu-latest
    timeout-minutes: 60
    defaults:
      run:
        shell: bash`;

  return renderWorkflow('name: Bini Android', job, steps, pm);
}

function buildIosWorkflow(info: PackageManagerInfo): string {
  const pm = info.pm;

  const signed = scriptCommand(pm, NATIVE_BUILD_SCRIPTS.ios, ['--export-method', 'app-store-connect']);
  const simulator = scriptCommand(pm, NATIVE_BUILD_SCRIPTS.ios, ['--target', 'aarch64-sim', '--debug']);

  const steps: string[] = [
    ...setupSteps(info),
    ...rustSteps(['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios']),
    installStep(info),
    `- name: Initialize iOS project (if missing)
  run: |
    if [ ! -d src-tauri/gen/apple ]; then
      ${scriptCommand(pm, 'tauri', ['ios', 'init', '--ci'])}
    fi`,
    iconStep(pm),
    `- name: Build iOS app
  env:
${indent(secretEnv(['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM', 'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8']), 4)}
  run: |
    if [ -z "$APPLE_DEVELOPMENT_TEAM" ]; then unset APPLE_DEVELOPMENT_TEAM; fi
    if [ -n "$APPLE_API_KEY_P8" ]; then
      key_path="$RUNNER_TEMP/AuthKey.p8"
      echo "$APPLE_API_KEY_P8" | base64 --decode > "$key_path"
      echo "APPLE_API_KEY_PATH=$key_path" >> "$GITHUB_ENV"
    fi
    if [ -n "$IOS_CERTIFICATE" ] && [ -n "$IOS_CERTIFICATE_PASSWORD" ] && [ -n "$IOS_MOBILE_PROVISION" ]; then
      ${signed}
    elif [ -n "$APPLE_API_KEY_P8" ] && [ -n "$APPLE_DEVELOPMENT_TEAM" ]; then
      echo "Using Xcode automatic signing with the App Store Connect API key."
      ${signed}
    else
      echo "No iOS signing secrets found: building for the simulator only."
      unset IOS_CERTIFICATE IOS_CERTIFICATE_PASSWORD IOS_MOBILE_PROVISION
      ${simulator}
    fi`,
    `- uses: ${ACTIONS.uploadArtifact}
  with:
    name: ios
    path: src-tauri/gen/apple/build/**/*.ipa
    if-no-files-found: warn`,
  ];

  const job = `concurrency:
  group: ios-§{{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: Build (iOS)
    runs-on: macos-latest
    timeout-minutes: 60
    defaults:
      run:
        shell: bash`;

  return renderWorkflow('name: Bini iOS', job, steps, pm);
}

function generateWorkflows(targets: NativePlatform[]): string[] {
  const cwd = process.cwd();
  const info = detectPackageManager();
  const dir = path.join(cwd, WORKFLOWS_DIR);
  mkdirSync(dir, { recursive: true });

  const builders: Record<NativePlatform, (i: PackageManagerInfo) => string> = {
    desktop: buildDesktopWorkflow,
    android: buildAndroidWorkflow,
    ios: buildIosWorkflow,
  };

  const written: string[] = [];
  for (const target of targets) {
    const file = path.join(dir, WORKFLOW_FILES[target]);
    writeFileSync(file, builders[target](info), 'utf8');
    written.push(toPosixPath(path.relative(cwd, file)));
  }
  return written;
}

function assertNativeProject(targets: NativePlatform[]): void {
  const cwd = process.cwd();
  if (!existsSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'))) {
    throw new Error(
      'No Tauri project found (src-tauri/tauri.conf.json is missing).\n' +
      '  Add one first: create-bini-app add <desktop|android|ios>\n' +
      '  No Mac? Run `add desktop` (it creates the shared src-tauri/): the iOS project itself is generated in CI.'
    );
  }

  const scripts = (readPackageJson()?.scripts ?? {}) as Record<string, string>;
  const missing = targets.filter((t) => !scripts[NATIVE_BUILD_SCRIPTS[t]]);
  if (missing.length > 0) {
    throw new Error(
      `package.json has no "${missing.map((t) => NATIVE_BUILD_SCRIPTS[t]).join('", "')}" script.\n` +
      `  Add the native scripts: create-bini-app add ${missing.join(' ')}`
    );
  }
}

const SIGNING_ENV_FILE = '.env.signing';

const SIGNING_GITIGNORE = [
  '.env.signing',
  '.bini-signing/',
  'tauri.windows.conf.json',
  'tauri.macos.conf.json',
  'tauri.ios.conf.json',
  '*.jks',
  '*.keystore',
  '*.p12',
  '*.pfx',
  '*.p8',
  '*.mobileprovision',
  '*.key',
  'keystore.properties',
];

const SIGNING_SECRETS: Record<SigningTarget, string[]> = {
  windows: ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_PUBLISHER'],
  macos: [
    'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'KEYCHAIN_PASSWORD',
    'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8',
    'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
  ],
  linux: [
    'GPG_PRIVATE_KEY', 'SIGN_KEY', 'APPIMAGETOOL_SIGN_PASSPHRASE', 'LINUX_PUBLISHER',
    'APPIMAGETOOL_FORCE_SIGN',
    'TAURI_SIGNING_RPM_KEY', 'TAURI_SIGNING_RPM_KEY_PASSPHRASE',
  ],
  android: ['ANDROID_KEY_BASE64', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_PUBLISHER'],
  ios: [
    'IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM',
    'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8',
  ],
};

const SIGNING_MARKERS: Record<SigningTarget, string[]> = {
  windows: ['WINDOWS_CERTIFICATE', 'WINDOWS_PUBLISHER'],
  macos: ['APPLE_CERTIFICATE'],
  linux: ['GPG_PRIVATE_KEY', 'LINUX_PUBLISHER'],
  android: ['ANDROID_KEY_BASE64', 'ANDROID_PUBLISHER'],
  ios: ['IOS_CERTIFICATE', 'APPLE_API_KEY'],
};

const SIGNING_LABELS: Record<SigningTarget, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
};

function signingTargetsFor(targets: NativePlatform[]): SigningTarget[] {
  const list: SigningTarget[] = [];
  if (targets.includes('desktop')) list.push('windows', 'macos', 'linux');
  if (targets.includes('android')) list.push('android');
  if (targets.includes('ios')) list.push('ios');
  return list;
}

function readSigningEnv(): Record<string, string> {
  const file = path.join(process.cwd(), SIGNING_ENV_FILE);
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;

  try {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
      if (!match) continue;
      let value = match[2] ?? '';
      if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).replace(/'\\''/g, "'");
      }
      out[match[1] as string] = value;
    }
  } catch {
    // unreadable file: treated as no values
  }
  return out;
}

function isSigned(target: SigningTarget, env: Record<string, string>): boolean {
  if (SIGNING_MARKERS[target].some((name) => env[name])) return true;
  return target === 'windows' && existsSync(path.join(process.cwd(), 'src-tauri', 'tauri.cloud-sign.conf.json'));
}

function ensureSigningIgnored(): void {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(gitignorePath, 'utf8');
  } catch {
    // no .gitignore yet
  }

  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = SIGNING_GITIGNORE.filter((entry) => !have.has(entry));
  if (missing.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
  log.info('Added signing files to .gitignore so secrets are never pushed');
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCmd(cmd: string, args: string[], opts: { input?: string } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(cmd, args, { cwd: process.cwd(), windowsHide: true, stdio: 'pipe' });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr + err.message }));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));

    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

function resolveCreateBiniAppCli(): { bin: string; args: string[] } | null {
  const binName = process.platform === 'win32' ? 'create-bini-app.cmd' : 'create-bini-app';
  const local = path.join(process.cwd(), 'node_modules', '.bin', binName);
  if (existsSync(local)) return { bin: local, args: [] };
  return null;
}

function createBiniAppCommand(subargs: string[]): { bin: string; args: string[] } {
  const local = resolveCreateBiniAppCli();
  if (local) return { bin: local.bin, args: subargs };
  return { bin: 'npx', args: ['create-bini-app', ...subargs] };
}

function runSignCli(target: SigningTarget): Promise<boolean> {
  const { bin, args } = createBiniAppCommand(['sign', target, '--ci-only']);
  log.command(`${bin} ${args.join(' ')}`);

  return new Promise((resolve) => {
    const child = crossSpawn(bin, args, { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function ensureSigning(targets: NativePlatform[], skipPrompts: boolean): Promise<void> {
  const list = signingTargetsFor(targets);
  if (list.length === 0) return;

  const interactive = !skipPrompts && isInteractive();

  for (const target of list) {
    const label = SIGNING_LABELS[target];
    const signed = isSigned(target, readSigningEnv());

    if (!interactive) {
      if (!signed) {
        log.warn(`${label}: no signing values found, CI will build it unsigned. Set it up with: create-bini-app sign ${target} --ci-only`);
      }
      continue;
    }

    if (signed) {
      log.skip(`${label}: signing already configured, skipping the prompt.`);
      continue;
    }

    const run = await confirm({
      message: `${label}: set up signing for GitHub Actions now?`,
      default: true,
    });
    if (!run) {
      log.skip(`${label}. CI will build it unsigned.`);
      continue;
    }

    if (!(await runSignCli(target))) {
      log.warn(`${label} signing did not finish. CI will build it unsigned until you run: create-bini-app sign ${target} --ci-only`);
    }
  }
}

const GENERATED_PUBLISHERS = ['WINDOWS_PUBLISHER', 'LINUX_PUBLISHER', 'ANDROID_PUBLISHER'];

async function ensureSecretsPat(githubRepo: string, skipPrompts: boolean): Promise<void> {
  const env = readSigningEnv();
  if (!GENERATED_PUBLISHERS.some((name) => env[name])) return;

  const slug = githubRepo.replace(/^https:\/\/github\.com\//, '');
  const list = await runCmd('gh', ['secret', 'list', '--repo', slug]);
  if (list.code === 0 && /^SECRETS_PAT\s/m.test(list.stdout)) return;

  const manual = (): void => {
    log.warn('SECRETS_PAT is not set, so generated signing keys are temporary and a new one is created on every build.');
    log.info(`Create a fine-grained token for this repository with "Secrets: Read and write", then add it as ${c.yellow('SECRETS_PAT')} at https://github.com/${slug}/settings/secrets/actions`);
  };

  if (list.code !== 0 || skipPrompts || !isInteractive()) {
    manual();
    return;
  }

  try {
    const add = await confirm({ message: 'Add SECRETS_PAT now so the workflow can save generated keys and reuse them?', default: true });
    if (!add) {
      manual();
      return;
    }
    const token = await password({
      message: 'Token (fine-grained, this repository, Secrets: Read and write):',
      validate: (v: string) => v.trim().length > 0 || 'Token is required',
    });
    const result = await runCmd('gh', ['secret', 'set', 'SECRETS_PAT', '--repo', slug], { input: token.trim() });
    if (result.code === 0) log.success('SECRETS_PAT saved. Generated keys are created once and reused.');
    else manual();
  } catch (err) {
    if (isExitPromptError(err)) return;
    throw err;
  }
}

async function uploadSigningSecrets(githubRepo: string, targets: NativePlatform[], skipPrompts: boolean): Promise<void> {
  const env = readSigningEnv();
  const names: string[] = [];
  for (const target of signingTargetsFor(targets)) {
    for (const name of SIGNING_SECRETS[target]) {
      if (env[name] && !names.includes(name)) names.push(name);
    }
  }

  if (names.length === 0) {
    log.info(`No signing values in ${SIGNING_ENV_FILE}, so no GitHub secrets were uploaded. CI builds will be unsigned.`);
    return;
  }

  const slug = githubRepo.replace(/^https:\/\/github\.com\//, '');
  const manual = (): void => {
    log.warn('Could not upload the signing secrets automatically. Add them in the repository settings:');
    log.info(`https://github.com/${slug}/settings/secrets/actions`);
    log.info(`Names: ${names.join(', ')}`);
    log.info('Or install the GitHub CLI (gh), run `gh auth login`, and run deploy again.');
  };

  const auth = await runCmd('gh', ['auth', 'status']);
  if (auth.code !== 0) {
    manual();
    return;
  }

  if (!skipPrompts && isInteractive()) {
    try {
      const ok = await confirm({
        message: `Upload ${names.length} signing secret(s) from ${SIGNING_ENV_FILE} to ${slug}?`,
        default: true,
      });
      if (!ok) {
        log.skip(`Upload cancelled. Run deploy again later, or add them at https://github.com/${slug}/settings/secrets/actions`);
        return;
      }
    } catch (err) {
      if (isExitPromptError(err)) return;
      throw err;
    }
  }

  let uploaded = 0;
  for (const name of names) {
    const result = await runCmd('gh', ['secret', 'set', name, '--repo', slug], { input: env[name] });
    if (result.code === 0) {
      uploaded++;
    } else {
      log.warn(`Could not set ${name}: ${(result.stderr || 'gh failed').trim().split('\n').pop()}`);
    }
  }

  if (uploaded === names.length) log.success(`Uploaded ${uploaded} signing secret(s) to GitHub`);
  else log.warn(`Uploaded ${uploaded} of ${names.length} signing secret(s). Add the rest at https://github.com/${slug}/settings/secrets/actions`);
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], opts: { inherit?: boolean } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn('git', args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: opts.inherit ? ['inherit', 'pipe', 'pipe'] : 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.inherit) process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.inherit) process.stderr.write(text);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function getGitConfig(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = crossSpawn('git', ['config', key], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? output.trim() : null));
  });
}

type GitFailureKind = 'auth' | 'not-found' | 'non-fast-forward' | 'unknown';

function classifyGitError(stderr: string): GitFailureKind {
  const text = stderr.toLowerCase();

  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('terminal prompts disabled') ||
    text.includes('permission denied') ||
    text.includes('403') ||
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

  if (
    text.includes('non-fast-forward') ||
    text.includes('fetch first') ||
    text.includes('updates were rejected')
  ) {
    return 'non-fast-forward';
  }

  return 'unknown';
}

async function ensureGitIdentity(): Promise<void> {
  const [existingName, existingEmail] = await Promise.all([
    getGitConfig('user.name'),
    getGitConfig('user.email'),
  ]);

  if (existingName && existingEmail) return;

  if (!isInteractive()) {
    const missing = [
      !existingName ? 'user.name' : null,
      !existingEmail ? 'user.email' : null,
    ].filter(Boolean).join(' and ');
    throw new Error(
      `Git identity is not configured (missing ${missing}) and no terminal is available to prompt for it.\n` +
      `Configure it first, e.g.:\n` +
      `  git config --global user.name "Your Name"\n` +
      `  git config --global user.email "you@example.com"`
    );
  }

  log.warn('Git author identity is not set - needed to create a commit.');

  let gitName = existingName;
  let gitEmail = existingEmail;

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

  if (gitName) {
    const r = await runGit(['config', 'user.name', gitName]);
    if (r.code !== 0) throw new Error(`Failed to set git user.name:\n${r.stderr.trim()}`);
  }
  if (gitEmail) {
    const r = await runGit(['config', 'user.email', gitEmail]);
    if (r.code !== 0) throw new Error(`Failed to set git user.email:\n${r.stderr.trim()}`);
  }

  log.success('Git identity configured for this repository.');
}

async function ensureGitCredentials(githubRepo: string): Promise<void> {
  if (!isInteractive()) {
    throw new Error(
      'GitHub authentication failed and no terminal is available to prompt for credentials.\n' +
      'Configure credentials first, e.g.:\n' +
      '  git config --global credential.helper store\n' +
      '  git push   (enter your GitHub username and a Personal Access Token once - git will remember it)'
    );
  }

  log.warn('GitHub rejected the push - authentication is required.');
  log.info(
    'GitHub no longer accepts account passwords for git over HTTPS - use a ' +
    'Personal Access Token instead (GitHub -> Settings -> Developer settings -> ' +
    'Personal access tokens, with "repo" scope; add "workflow" scope to push GitHub Actions files).'
  );

  let username: string;
  let token: string;

  try {
    username = await input({
      message: 'GitHub username:',
      validate: (v: string) => v.trim().length > 0 || 'Username is required',
    });

    token = await password({
      message: 'GitHub Personal Access Token:',
      validate: (v: string) => v.trim().length > 0 || 'Token is required',
    });
  } catch (err) {
    if (isExitPromptError(err)) {
      throw new Error('Cancelled - GitHub credentials are required to push.');
    }
    throw err;
  }

  let host = 'github.com';
  try {
    host = new URL(githubRepo).host;
  } catch {
    // already validated against GITHUB_URL_REGEX
  }

  const helperResult = await runGit(['config', '--global', 'credential.helper', 'store']);
  if (helperResult.code !== 0) {
    throw new Error(`Failed to configure credential.helper:\n${helperResult.stderr.trim()}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn('git', ['credential', 'approve'], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      code === 0 ? resolve() : reject(new Error(`Failed to save credentials: ${stderr.trim()}`));
    });
    child.stdin?.write(`protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`);
    child.stdin?.end();
  });

  log.success("Credentials saved - future pushes to this host won't prompt again.");
}

async function pushToGitHub(githubRepo: string): Promise<void> {
  const cwd = process.cwd();
  const isGitRepo = existsSync(path.join(cwd, '.git'));

  if (!isGitRepo) {
    log.step('Initializing git repository...');
    const initResult = await runGit(['init', '-b', DEFAULT_BRANCH]);
    if (initResult.code !== 0) {
      throw new Error(`git init failed:\n${(initResult.stderr || initResult.stdout).trim()}`);
    }
    log.info(`Setting remote origin: ${githubRepo}`);
    const remoteAddResult = await runGit(['remote', 'add', 'origin', githubRepo]);
    if (remoteAddResult.code !== 0) {
      throw new Error(`Failed to add remote 'origin':\n${remoteAddResult.stderr.trim()}`);
    }
  } else {
    let remoteExists = false;
    const remotesResult = await runGit(['remote']);
    if (remotesResult.code === 0 && remotesResult.stdout.includes('origin')) {
      remoteExists = true;
      const urlResult = await runGit(['remote', 'get-url', 'origin']);
      log.info(urlResult.code === 0 ? `Using existing remote: ${urlResult.stdout.trim()}` : 'Using existing remote');
    }

    if (!remoteExists) {
      log.info(`Setting remote origin: ${githubRepo}`);
      const remoteAddResult = await runGit(['remote', 'add', 'origin', githubRepo]);
      if (remoteAddResult.code !== 0) {
        throw new Error(`Failed to add remote 'origin':\n${remoteAddResult.stderr.trim()}`);
      }
    }
  }

  log.step('Adding files to git...');
  const addResult = await runGit(['add', '--all']);
  if (addResult.code !== 0) {
    throw new Error(`git add failed:\n${addResult.stderr.trim()}`);
  }

  await ensureGitIdentity();

  const statusResult = await runGit(['status', '--porcelain']);
  const hasChanges = statusResult.code === 0 && statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    log.step('Committing changes...');
    const commitResult = await runGit(['commit', '-m', 'chore: add deployment configuration']);
    if (commitResult.code === 0) {
      log.success('Changes committed');
    } else if (/nothing to commit/i.test(commitResult.stdout + commitResult.stderr)) {
      log.info('No changes to commit');
    } else {
      log.warn(`Failed to commit changes, continuing...\n${commitResult.stderr.trim()}`);
    }
  } else {
    log.info('No changes to commit');
  }

  const branchResult = await runGit(['branch', '--show-current']);
  const currentBranch = branchResult.stdout.trim();

  if (currentBranch && currentBranch !== DEFAULT_BRANCH) {
    log.info(`Switching from ${currentBranch} to ${DEFAULT_BRANCH}...`);
    const listResult = await runGit(['branch', '--list', DEFAULT_BRANCH]);
    if (listResult.stdout.trim()) {
      await runGit(['checkout', DEFAULT_BRANCH]);
    } else {
      await runGit(['branch', '-m', currentBranch, DEFAULT_BRANCH]);
    }
  }

  log.step('Pushing to GitHub...');

  const attemptPush = () => runGit(['push', '-u', 'origin', `HEAD:${DEFAULT_BRANCH}`], { inherit: true });

  let result = await attemptPush();

  if (result.code === 0) {
    log.success('Push successful');
    return;
  }

  let kind = classifyGitError(result.stderr);

  if (kind === 'auth') {
    await ensureGitCredentials(githubRepo);
    result = await attemptPush();
    if (result.code === 0) {
      log.success('Push successful');
      return;
    }
    kind = classifyGitError(result.stderr);
    if (kind === 'auth') {
      throw new Error(
        `Push still failed after configuring credentials - double-check the token has 'repo' scope (and 'workflow' scope for GitHub Actions files) and hasn't expired.\n` +
        `Raw git error:\n${result.stderr.trim()}`
      );
    }
  }

  if (kind === 'not-found') {
    throw new Error(
      `Push failed: repository not found at '${githubRepo}'.\n` +
      `  - Confirm the repository exists and the URL is correct\n` +
      `  - Confirm your account has push access to it\n` +
      `Raw git error:\n${result.stderr.trim()}`
    );
  }

  if (kind !== 'non-fast-forward') {
    throw new Error(
      `Push failed:\n${result.stderr.trim() || result.stdout.trim() || 'Unknown git error.'}`
    );
  }

  log.warn('Push rejected - the remote has commits that are not present locally.');
  log.step('Attempting to fetch and merge remote changes...');

  const fetchResult = await runGit(['fetch', 'origin', DEFAULT_BRANCH]);
  if (fetchResult.code !== 0) {
    throw new Error(
      `Failed to fetch '${DEFAULT_BRANCH}' from origin.\n` +
      `Raw git error:\n${fetchResult.stderr.trim()}`
    );
  }

  log.warn(
    'Merging remote history with -X ours: for any file that exists both ' +
    'locally and on the remote, your local version will be kept and the ' +
    'remote version discarded. Files that only exist on the remote are ' +
    'still merged in normally.'
  );

  const mergeResult = await runGit([
    'merge',
    `origin/${DEFAULT_BRANCH}`,
    '--allow-unrelated-histories',
    '-X',
    'ours',
    '-m',
    'chore: merge remote changes',
  ]);

  if (mergeResult.code !== 0) {
    throw new Error(
      'Automatic merge failed, likely due to conflicting files (e.g. README.md).\n' +
      'Resolve the conflicts manually, then run:\n' +
      '  git add .\n' +
      '  git commit\n' +
      `  git push -u origin ${DEFAULT_BRANCH}\n\n` +
      `Raw git error:\n${mergeResult.stderr.trim()}`
    );
  }

  result = await attemptPush();
  if (result.code === 0) {
    log.success('Push successful after merging remote changes');
    return;
  }

  throw new Error(
    'Push still failed after merging remote changes.\n' +
    'You can resolve this manually by running:\n' +
    `  git pull origin ${DEFAULT_BRANCH} --allow-unrelated-histories -X ours\n` +
    `  git push -u origin ${DEFAULT_BRANCH}\n\n` +
    `Raw git error:\n${result.stderr.trim()}`
  );
}

const NATIVE_ALIASES: Record<string, NativePlatform> = {
  desktop: 'desktop',
  windows: 'desktop',
  macos: 'desktop',
  linux: 'desktop',
  android: 'android',
  ios: 'ios',
};

function parsePlatformArg(raw: string): { platform: 'web' | 'native'; targets: NativePlatform[] } {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error('--platform requires a value (web, desktop, android, ios)');

  const hasWeb = parts.includes('web');
  const targets: NativePlatform[] = [];

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

function parseArgs(): Partial<DeployAnswers> & { generateEntry?: NonNodePlatform; platformArg?: string } {
  const args = process.argv.slice(2);
  const result: Partial<DeployAnswers> & { generateEntry?: NonNodePlatform; platformArg?: string } = {
    skipPrompts: false,
    noSign: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform' && args[i + 1]) {
      result.platformArg = args[++i];
    } else if (arg === '--hosting' && args[i + 1]) {
      result.webHosting = args[++i] as Platform;
    } else if (arg === '--repo' && args[i + 1]) {
      result.githubRepo = args[++i];
    } else if (arg === '--generate-entry' && args[i + 1]) {
      result.generateEntry = args[++i] as NonNodePlatform;
    } else if (arg === '--nosign') {
      result.noSign = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.skipPrompts = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  return result;
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
  --nosign                Native only: skip the create-bini-app sign step
  --yes, -y               Skip interactive prompts (use provided flags)
  --help, -h              Show this help message

${c.heading('Native targets:')}
  Generates GitHub Actions workflows (.github/workflows/desktop.yml, android.yml, ios.yml) and removes
  web hosting files. Builds run on GitHub, so this works from any OS.
  Signing is set up with ${c.yellow('create-bini-app sign <target> --ci-only')}:
    Windows, Linux, Android  let the workflow generate a self-signed key (a publisher name, plus a keystore
                             password for Android) or use real credentials. A generated key is created on
                             the first build, saved as a GitHub secret and reused, which needs a repository
                             secret ${c.yellow('SECRETS_PAT')} (deploy offers to add it).
    macOS, iOS               cannot be generated: real Apple credentials, otherwise macOS signs ad-hoc and
                             iOS builds for the simulator only.
  Everything in .env.signing is uploaded as GitHub secrets with the GitHub CLI.
  Windows cloud signing (Azure Artifact Signing, Azure Key Vault/relic, SSL.com eSigner, jsign) is detected
  from tauri.cloud-sign.conf.json and the matching CLI is installed by the generated workflow.
  App icons are regenerated from public/logo.png before every build.

${c.heading('Examples:')}
${[
  'bini-deploy --platform web --hosting vercel --repo https://github.com/user/my-app --yes',
  'bini-deploy --platform desktop,android,ios --repo https://github.com/user/my-app -y',
  'bini-deploy --generate-entry netlify',
  'bini-deploy',
].map((e) => `  ${c.dim(e)}`).join('\n')}
`);
}

async function getAnswersInteractive(): Promise<DeployAnswers> {
  const picked = await checkbox<'web' | NativePlatform>({
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
  const targets = picked.filter((p): p is NativePlatform => p !== 'web');

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
    const remotesResult = await runGit(['remote']);
    if (remotesResult.code === 0 && remotesResult.stdout.includes('origin')) {
      const urlResult = await runGit(['remote', 'get-url', 'origin']);
      if (urlResult.code === 0) {
        githubRepo = urlResult.stdout.trim();
        log.info(`Using existing git remote: ${githubRepo}`);
      }
    }
  }

  if (!githubRepo) {
    githubRepo = await input({
      message: 'GitHub repository URL?',
      validate: (value: string) =>
        GITHUB_URL_REGEX.test(value) || 'Please enter a valid GitHub repository URL',
    });
  }

  return {
    platform: kind,
    targets,
    webHosting,
    githubRepo,
    projectName: githubRepo.split('/').pop() || 'my-app',
    skipPrompts: false,
    noSign: false,
  };
}

async function getAnswersFromFlags(
  flags: Partial<DeployAnswers> & { platformArg?: string },
): Promise<DeployAnswers> {
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
    noSign: Boolean(flags.noSign),
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

async function executeDeployment(answers: DeployAnswers): Promise<void> {
  const spinner = createSpinner('Generating deployment files...').start();

  try {
    const { platform, webHosting, githubRepo, projectName } = answers;

    if (platform === 'web' && webHosting && webHosting !== 'node') {
      spinner.text = `Generating production API entry for ${webHosting}...`;

      try {
        await generateProductionEntry(webHosting);
      } catch (error) {
        log.warn('Failed to generate production entry, but continuing...');
      }

      spinner.text = `Generating ${HOSTING_CONFIGS[webHosting].label} configuration...`;
      const configPath = await generateHostingConfig(webHosting, projectName);
      if (configPath) {
        log.info(`Generated ${path.relative(process.cwd(), configPath)}`);
      }
    } else if (platform === 'web') {
      spinner.text = 'Cleaning up old platform artifacts...';
      cleanupPlatformArtifacts('node', isTypeScriptProject());
    }

    if (platform === 'native') {
      spinner.text = 'Removing web hosting files...';
      cleanupPlatformArtifacts('node', isTypeScriptProject());

      spinner.text = 'Checking the Tauri project...';
      assertNativeProject(answers.targets);
      ensureSigningIgnored();

      spinner.stop();
      if (!answers.noSign) await ensureSigning(answers.targets, answers.skipPrompts);

      spinner.start('Generating GitHub workflows...');
      const workflows = generateWorkflows(answers.targets);
      spinner.stop();
      for (const file of workflows) log.info(`Generated ${file}`);
    }

    spinner.stop();
    await pushToGitHub(githubRepo);

    if (platform === 'native' && !answers.noSign) {
      await uploadSigningSecrets(githubRepo, answers.targets, answers.skipPrompts);
      await ensureSecretsPat(githubRepo, answers.skipPrompts);
    }

    log.success('All files generated and pushed to GitHub');

    log.plain(`\n${c.heading('Deployment complete')}`);
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
  log.plain(`\n${c.heading('Next steps')}`);

  const { platform, webHosting, githubRepo } = answers;

  if (platform === 'web' && webHosting) {
    printSteps(WEB_NEXT_STEPS[webHosting](detectPackageManager().pm));
  } else if (platform === 'native') {
    const files = answers.targets.map((t) => WORKFLOW_FILES[t]);
    const env = readSigningEnv();
    const unsigned = signingTargetsFor(answers.targets).filter((t) => !isSigned(t, env));

    const steps = [
      `Open ${c.cyan(`${githubRepo}/actions`)}`,
      `Run a workflow (${c.yellow(files.join(', '))}) with "Run workflow", or push a tag: ${c.yellow('git tag v1.0.0 && git push --tags')}`,
      `Download the builds from the ${c.cyan('Artifacts')} section of the run`,
    ];
    if (unsigned.length > 0 && !answers.noSign) {
      steps.push(
        `Unsigned in CI: ${unsigned.map((t) => SIGNING_LABELS[t]).join(', ')} (macOS then signs ad-hoc). Set up with ${c.yellow('create-bini-app sign <target> --ci-only')}, then run deploy again`,
      );
    }
    printSteps(steps);
  }

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
      answers.noSign = Boolean(flags.noSign);
    }

    validateAnswers(answers);

    const hostingLabel = answers.webHosting ? HOSTING_CONFIGS[answers.webHosting].label : 'N/A';

    log.plain(`\n${c.heading('Deployment summary')}`);
    log.plain(`  ${c.dim('Platform:')}   ${answers.platform === 'native' ? answers.targets.join(', ') : answers.platform}`);
    if (answers.platform === 'web') {
      log.plain(`  ${c.dim('Hosting:')}    ${hostingLabel}`);
    }
    log.plain(`  ${c.dim('Repository:')} ${c.cyan(answers.githubRepo)}\n`);

    if (!answers.skipPrompts && isInteractive()) {
      const confirmed = await confirm({
        message: 'Generate deployment files and push to GitHub?',
        default: true,
      });

      if (!confirmed) {
        log.info('Deployment cancelled.');
        return;
      }
    }

    await executeDeployment(answers);
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

export type { Platform, NonNodePlatform, NativePlatform, DeployAnswers, ApiRoute };