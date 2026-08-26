import { existsSync, readdirSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { writeFile } from 'fs/promises';
import { createRequire } from 'module';
import crossSpawn from 'cross-spawn';
import path from 'path';
import { fileURLToPath } from 'url';
import { select, input, confirm, password } from '@inquirer/prompts';
import { isatty } from 'tty';
import ora from 'ora';
import chalk from 'chalk';

const require = createRequire(import.meta.url);

// ─── Constants ────────────────────────────────────────────────────────────────

const GITHUB_URL_REGEX = /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;
const ALLOWED_ROUTE_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_PARAM_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ROUTE_SEGMENT_LENGTH = 100;
const MAX_API_SCAN_DEPTH = 100;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const API_EXTS = ['.ts', '.js'] as const;

// GitHub's default branch is always "main" - we normalize to it rather
// than trying to detect/guess a remote's default branch name.
const DEFAULT_BRANCH = 'main';

type Platform = 'node' | 'netlify' | 'vercel' | 'cloudflare' | 'deno';
type NonNodePlatform = Exclude<Platform, 'node'>;

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
  platform: 'web' | 'windows' | 'macos' | 'ios' | 'linux' | 'android';
  webHosting?: Platform;
  githubRepo: string;
  projectName: string;
  skipPrompts: boolean;
}

// ─── Platform Adapters ──────────────────────────────────────────────────────

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
  node: { label: 'Node.js (default — bini-server)', configFile: null },
  netlify: { label: 'Netlify', configFile: 'netlify.toml' },
  vercel: { label: 'Vercel', configFile: 'vercel.json' },
  cloudflare: { label: 'Cloudflare Workers', configFile: 'wrangler.toml' },
  deno: { label: 'Deno Deploy', configFile: null },
};

const WEB_NEXT_STEPS: Record<Platform, string[]> = {
  node: [
    `Build: ${chalk.yellow('npm run build')}`,
    `Start: ${chalk.yellow('npm start')}`,
    `Served by ${chalk.cyan('bini-server')} on ${chalk.yellow('$PORT')} (default 3000)`,
  ],
  netlify: [
    `Connect your repo to ${chalk.cyan('Netlify')}`,
    `Build command: ${chalk.yellow('npm run build')}`,
    `Publish directory: ${chalk.yellow('dist')}`,
    `API routes run on ${chalk.cyan('Edge Functions')}`,
  ],
  vercel: [
    `Connect your repo to ${chalk.cyan('Vercel')}`,
    `Build command: ${chalk.yellow('npm run build')}`,
    `API routes run on ${chalk.cyan('Node.js Runtime')}`,
  ],
  cloudflare: [
    `Install Wrangler: ${chalk.yellow('npm install -g wrangler')}`,
    `Run: ${chalk.yellow('wrangler deploy')}`,
    `Your worker handles API routes`,
  ],
  deno: [
    `Connect your repo to ${chalk.cyan('Deno Deploy')}`,
    `Set entrypoint: ${chalk.yellow('server/index.ts')}`,
    `Build command: ${chalk.yellow('npm run build')}`,
    `Runtime: ${chalk.cyan('Dynamic App')}`,
  ],
};

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = {
  info: (m: string) => console.log(`${chalk.cyan.bold('[bini-deploy]')} ${m}`),
  success: (m: string) => console.log(`${chalk.green.bold('[bini-deploy]')} ${m}`),
  warn: (m: string) => console.warn(`${chalk.yellow.bold('[bini-deploy]')} ${m}`),
  error: (m: string) => console.error(`${chalk.red.bold('[bini-deploy]')} ${m}`),
};

// ─── Utilities ──────────────────────────────────────────────────────────────

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

// ─── API Route Scanner ──────────────────────────────────────────────────────

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

// ─── Route Import Builder ─────────────────────────────────────────────────

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
      // Skip if file can't be read
    }

    const isHonoApp = src.includes("from 'hono'") || src.includes('from "hono"');

    if (isHonoApp) {
      mountings.push(`app.route('/api', ${name});`);
    } else {
      const mountPath = `/api${route.routePath ?? '/'}`;
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

// ─── Entry Content Builder ─────────────────────────────────────────────────

function getDenoSpaFallback(): string[] {
  return [
    `// Serve static files from dist (must come AFTER API routes)`,
    `app.get('/*', async (c) => {`,
    `  if (c.req.path.startsWith('/api/')) {`,
    `    return c.text('API route not found', 404);`,
    `  }`,
    `  const filePath = c.req.path === '/' ? '/index.html' : c.req.path;`,
    `  try {`,
    `    const file = await Deno.readFile(\`./dist\${filePath}\`);`,
    `    const ext = filePath.split('.').pop();`,
    `    const contentType = {`,
    `      'html': 'text/html',`,
    `      'css': 'text/css',`,
    `      'js': 'application/javascript',`,
    `      'json': 'application/json',`,
    `      'png': 'image/png',`,
    `      'jpg': 'image/jpeg',`,
    `      'jpeg': 'image/jpeg'`,
    `    }[ext] || 'text/plain';`,
    `    return new Response(file, {`,
    `      headers: { 'Content-Type': contentType }`,
    `    });`,
    `  } catch {`,
    `    try {`,
    `      const indexHtml = await Deno.readFile('./dist/index.html');`,
    `      return new Response(indexHtml, {`,
    `        headers: { 'Content-Type': 'text/html' }`,
    `      });`,
    `    } catch {`,
    `      return c.text('File not found', 404);`,
    `    }`,
    `  }`,
    `});`,
  ];
}

function getCloudflareSpaFallback(): string[] {
  return [
    `// SPA fallback - serves index.html for all non-API, non-asset requests`,
    `app.get('*', async (c) => {`,
    `  const request = c.req.raw;`,
    `  const env = c.env;`,
    `  const assetResponse = await env.ASSETS.fetch(request);`,
    `  if (assetResponse.status === 200) {`,
    `    return assetResponse;`,
    `  }`,
    `  const indexHtml = await env.ASSETS.fetch(new URL('/index.html', request.url));`,
    `  return indexHtml;`,
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

// ─── Production Entry Generator ────────────────────────────────────────────

function checkAdapter(platform: NonNodePlatform): void {
  const adapter = ADAPTERS[platform];
  if (!adapter.pkg) return;

  try {
    require.resolve(adapter.pkg, { paths: [process.cwd()] });
  } catch {
    throw new Error(
      `[bini-deploy] Missing required package for platform '${platform}'.\n` +
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
      } catch (error) {
        // Ignore if file can't be removed
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
      } catch (error) {
        // Ignore if file can't be removed
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
      } catch (error) {
        // Ignore if directory can't be removed
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

// ─── Hosting Config Generators ─────────────────────────────────────────────

async function generateHostingConfig(
  hosting: NonNodePlatform,
  projectName: string,
): Promise<string | null> {
  const cwd = process.cwd();

  cleanupPlatformArtifacts(hosting, isTypeScriptProject());

  const configFile = HOSTING_CONFIGS[hosting].configFile;
  if (!configFile) return null;

  const outFile = path.join(cwd, configFile);

  switch (hosting) {
    case 'netlify': {
      const config = `
[build]
  command = "npm run build"
  publish = "dist"

[[edge_functions]]
  path = "/api/*"
  function = "api"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
`;
      await writeFile(outFile, config.trim());
      return outFile;
    }

    case 'vercel': {
      const config = {
        buildCommand: 'npm run build',
        rewrites: [
          { source: '/api/(.*)', destination: '/api/index' },
          { source: '/(.*)', destination: '/index.html' }
        ]
      };
      await writeFile(outFile, JSON.stringify(config, null, 2));
      return outFile;
    }

    case 'cloudflare': {
      const config = `
name = "${projectName}"
main = "worker.ts"
compatibility_date = "2025-04-09"

[assets]
directory = "./dist"
binding = "ASSETS"
`;
      await writeFile(outFile, config.trim());
      return outFile;
    }

    default:
      return null;
  }
}

// ─── Git Helpers ────────────────────────────────────────────────────────────

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a git command and ALWAYS resolves (never rejects on non-zero exit),
 * capturing stdout/stderr so callers can classify the failure instead of
 * guessing. Rejects only on true spawn failure (e.g. git not installed).
 * Pass `inherit: true` to also stream output live for long operations
 * (push/fetch) while still capturing it for classification.
 */
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

/**
 * Classifies a git stderr blob so we stop treating every push failure as
 * "diverged history". Auth failures, missing/renamed repos, and genuine
 * non-fast-forward rejections all need different recovery paths.
 */
function classifyGitError(stderr: string): GitFailureKind {
  const text = stderr.toLowerCase();

  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('terminal prompts disabled') ||
    text.includes('permission denied') ||
    text.includes('403')
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

/**
 * Ensures git user.name/user.email are set (git refuses to commit
 * otherwise). Prompts interactively when possible; in a non-interactive
 * context it fails fast with clear instructions instead of letting the
 * underlying prompt library throw an opaque TTY error.
 */
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

  // Set locally (this repo only) - never silently touches the user's
  // global git identity.
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

/**
 * Called only after a push has actually failed with an auth-classified
 * error. Prompts for a GitHub username + Personal Access Token (GitHub no
 * longer accepts account passwords for git over HTTPS) and stores it via
 * git's own credential store - the same mechanism `git config
 * credential.helper store` sets up - so future pushes to this host don't
 * prompt again.
 */
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
    'Personal access tokens, with "repo" scope).'
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
      mask: '*',
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
    // githubRepo is already validated against GITHUB_URL_REGEX before this
    // point, so this is unreachable in practice - falls back defensively.
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

// ─── GitHub Push ────────────────────────────────────────────────────────────

async function pushToGitHub(githubRepo: string): Promise<void> {
  const cwd = process.cwd();
  const isGitRepo = existsSync(path.join(cwd, '.git'));

  if (!isGitRepo) {
    log.info('Initializing git repository...');
    // Create the repo already on "main" - avoids the master->main rename
    // dance entirely for brand-new repos.
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
    // If remote exists, NEVER update or change it.
  }

  log.info('Adding files to git...');
  const addResult = await runGit(['add', '--all']);
  if (addResult.code !== 0) {
    throw new Error(`git add failed:\n${addResult.stderr.trim()}`);
  }

  await ensureGitIdentity();

  const statusResult = await runGit(['status', '--porcelain']);
  const hasChanges = statusResult.code === 0 && statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    log.info('Committing changes...');
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

  // Normalize to "main" - GitHub's default branch is always main.
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

  log.info('Pushing to GitHub...');

  const attemptPush = () => runGit(['push', '-u', 'origin', `HEAD:${DEFAULT_BRANCH}`], { inherit: true });

  let result = await attemptPush();

  if (result.code === 0) {
    log.success('Push successful');
    return;
  }

  let kind = classifyGitError(result.stderr);

  // Auth failure: prompt once for credentials and retry, instead of
  // crashing or silently misreporting it as a merge conflict.
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
        `Push still failed after configuring credentials - double-check the token has 'repo' scope and hasn't expired.\n` +
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

  // Anything that isn't a real non-fast-forward rejection: surface the raw
  // git error directly instead of forcing it through the merge-recovery
  // path (which was masking real failures like auth/network/repo issues).
  if (kind !== 'non-fast-forward') {
    throw new Error(
      `Push failed:\n${result.stderr.trim() || result.stdout.trim() || 'Unknown git error.'}`
    );
  }

  log.warn('Push rejected - the remote has commits that are not present locally.');
  log.info('Attempting to fetch and merge remote changes...');

  const fetchResult = await runGit(['fetch', 'origin', DEFAULT_BRANCH]);
  if (fetchResult.code !== 0) {
    throw new Error(
      `Failed to fetch '${DEFAULT_BRANCH}' from origin.\n` +
      `Raw git error:\n${fetchResult.stderr.trim()}`
    );
  }

  // NOTE: -X ours is intentional and must stay. When the same file
  // differs between local and remote, the local version is kept and the
  // remote version is discarded for that file. Files that only exist on
  // the remote (and don't conflict with anything local) are still merged
  // in as usual.
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

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Partial<DeployAnswers> & { generateEntry?: NonNodePlatform } {
  const args = process.argv.slice(2);
  const result: Partial<DeployAnswers> & { generateEntry?: NonNodePlatform } = { skipPrompts: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform' && args[i + 1]) {
      result.platform = args[++i] as DeployAnswers['platform'];
    } else if (arg === '--hosting' && args[i + 1]) {
      result.webHosting = args[++i] as Platform;
    } else if (arg === '--repo' && args[i + 1]) {
      result.githubRepo = args[++i];
    } else if (arg === '--generate-entry' && args[i + 1]) {
      result.generateEntry = args[++i] as NonNodePlatform;
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
  console.log(`
${chalk.cyan.bold('bini-deploy')} - Deploy Bini.js projects

${chalk.bold('Usage:')}
  bini-deploy [options]

${chalk.bold('Options:')}
  --platform <type>       Target platform: web, windows, macos, ios, linux, android
  --hosting <name>        Hosting provider: node, netlify, vercel, cloudflare, deno
  --repo <url>            GitHub repository URL
  --generate-entry <host> Generate production entry file only (netlify, vercel, cloudflare, deno)
  --yes, -y               Skip interactive prompts (use provided flags)
  --help, -h              Show this help message

${chalk.bold('Examples:')}
  bini-deploy --platform web --hosting vercel --repo https://github.com/user/my-app --yes
  bini-deploy --platform windows --repo https://github.com/user/my-app -y
  bini-deploy --generate-entry netlify
  bini-deploy
`);
}

async function getAnswersInteractive(): Promise<DeployAnswers> {
  const platform = await select<DeployAnswers['platform']>({
    message: 'Select your target platform:',
    choices: [
      { name: 'Web', value: 'web' },
      { name: 'Windows', value: 'windows' },
      { name: 'macOS', value: 'macos' },
      { name: 'iOS', value: 'ios' },
      { name: 'Linux', value: 'linux' },
      { name: 'Android', value: 'android' },
    ],
  });

  let webHosting: Platform | undefined;

  if (platform === 'web') {
    webHosting = await select<Platform>({
      message: 'Select hosting provider:',
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
      message: 'Enter your GitHub repository URL:',
      validate: (input: string) =>
        GITHUB_URL_REGEX.test(input) || 'Please enter a valid GitHub repository URL',
    });
  }

  return {
    platform,
    webHosting,
    githubRepo,
    projectName: githubRepo.split('/').pop() || 'my-app',
    skipPrompts: false,
  };
}

async function getAnswersFromFlags(flags: Partial<DeployAnswers>): Promise<DeployAnswers> {
  if (!flags.platform) {
    throw new Error('--platform is required when using --yes flag');
  }

  if (!flags.githubRepo) {
    throw new Error('--repo is required when using --yes flag');
  }

  const webHosting = flags.platform === 'web' ? flags.webHosting ?? 'node' : flags.webHosting;

  return {
    platform: flags.platform as DeployAnswers['platform'],
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

  if (!answers.githubRepo) {
    throw new Error('GitHub repository URL is required');
  }

  if (!GITHUB_URL_REGEX.test(answers.githubRepo)) {
    throw new Error('Invalid GitHub repository URL');
  }
}

// ─── Execute Deployment ─────────────────────────────────────────────────────

async function executeDeployment(answers: DeployAnswers): Promise<void> {
  const spinner = ora({
    text: 'Generating deployment files...',
    color: 'cyan',
  }).start();

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

    if (platform !== 'web') {
      spinner.text = `Preparing ${platform} for deployment...`;
      cleanupPlatformArtifacts('node', isTypeScriptProject());
      log.info(`No configuration needed for ${platform} - pushing existing files to GitHub`);
    }

    spinner.text = 'Pushing to GitHub...';
    // Stop the spinner before git push/prompts take over stdout - the
    // spinner and inherited git/inquirer output fight over the terminal
    // line otherwise, which can look like the process "just closed" while
    // it's actually still running.
    spinner.stop();
    await pushToGitHub(githubRepo);

    log.success('All files generated and pushed to GitHub');

    console.log(`\n${chalk.cyan.bold('  --- Deployment Complete ---')}`);
    console.log(`  ${chalk.gray('Platform:')}  ${answers.platform}`);
    if (answers.platform === 'web' && answers.webHosting) {
      console.log(`  ${chalk.gray('Hosting:')}   ${HOSTING_CONFIGS[answers.webHosting].label}`);
    }
    console.log(`  ${chalk.gray('Repository:')} ${chalk.cyan(answers.githubRepo)}`);

    showNextSteps(answers);
  } catch (error) {
    if (spinner.isSpinning) spinner.fail('Deployment failed');
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    throw error;
  }
}

// ─── Next Steps ─────────────────────────────────────────────────────────────

function printSteps(steps: string[]): void {
  steps.forEach((step, i) => console.log(`  ${chalk.green(`${i + 1}.`)} ${step}`));
}

function showNextSteps(answers: DeployAnswers): void {
  console.log(`\n${chalk.cyan.bold('  --- Next Steps ---')}`);

  const { platform, webHosting, githubRepo } = answers;

  if (platform === 'web' && webHosting) {
    printSteps(WEB_NEXT_STEPS[webHosting]);
  } else if (platform === 'windows' || platform === 'macos' || platform === 'linux') {
    printSteps([
      `Clone the repo: ${chalk.cyan(`git clone ${githubRepo}`)}`,
      `Install: ${chalk.yellow('npm install')}`,
      `Run Tauri dev: ${chalk.yellow('npm run tauri:dev')}`,
      `Build: ${chalk.yellow(`npm run build:${platform}`)}`,
    ]);
  } else if (platform === 'ios' || platform === 'android') {
    printSteps([
      `Clone the repo: ${chalk.cyan(`git clone ${githubRepo}`)}`,
      `Install: ${chalk.yellow('npm install')}`,
      `Add platform: ${chalk.yellow(`npx cap add ${platform}`)}`,
      `Build: ${chalk.yellow(`npm run build:${platform}`)}`,
    ]);
  }

  console.log(`  ${chalk.gray(`Repository: ${githubRepo}`)}\n`);
}

// ─── CLI Entry ──────────────────────────────────────────────────────────────

async function deployCLI(): Promise<void> {
  const flags = parseArgs();

  console.log(`\n${chalk.cyan.bold('  --- Bini.js Deploy ---')}\n`);

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

    validateAnswers(answers);

    const hostingLabel = answers.webHosting ? HOSTING_CONFIGS[answers.webHosting].label : 'N/A';

    console.log(`\n${chalk.cyan.bold('  --- Deployment Summary ---')}`);
    console.log(`  ${chalk.gray('Platform:')}  ${answers.platform}`);
    if (answers.platform === 'web') {
      console.log(`  ${chalk.gray('Hosting:')}   ${hostingLabel}`);
    }
    console.log(`  ${chalk.gray('Repository:')} ${chalk.cyan(answers.githubRepo)}`);

    if (!answers.skipPrompts && isInteractive()) {
      let confirmed: boolean;
      try {
        confirmed = await confirm({
          message: 'Generate deployment files and push to GitHub?',
          default: true,
        });
      } catch (err) {
        if (isExitPromptError(err)) {
          log.info('Deployment cancelled.');
          return;
        }
        throw err;
      }

      if (!confirmed) {
        log.info('Deployment cancelled.');
        return;
      }
    }

    await executeDeployment(answers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Deployment failed: ${message}`);
    process.exit(1);
  }
}

// ─── Main Entry ─────────────────────────────────────────────────────────────

// FIX: package managers (npm, yarn, and especially pnpm) install CLI bins
// as symlinks in node_modules/.bin. process.argv[1] is the unresolved
// symlink path, while import.meta.url reflects the file Node actually
// loaded after following the symlink - so a plain path.resolve() compare
// mismatches and isMainModule was silently false whenever this ran through
// a devDependency/.bin invocation (npm run <script>, npx, etc). That made
// deployCLI() never get called: no prompts, no error, no output, just an
// immediate clean exit. realpathSync() resolves both sides to the same
// real filesystem path regardless of how many symlink layers sit between
// them (pnpm in particular nests these through its content-addressable
// store).
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

// ─── Exports ──────────────────────────────────────────────────────────────────

export type { Platform, NonNodePlatform, DeployAnswers, ApiRoute };
