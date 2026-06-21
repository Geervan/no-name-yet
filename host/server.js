import express from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, exec, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import pty from 'node-pty';

// Load config
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const SECURITY_TOKEN = process.env.SECURITY_TOKEN || 'dev-secret-token-123456';
const WORKSPACES_ROOTS = (process.env.WORKSPACES_ROOT || '')
  .split(',')
  .map(r => r.trim())
  .filter(Boolean)
  .map(r => path.resolve(r));

if (WORKSPACES_ROOTS.length === 0) {
  WORKSPACES_ROOTS.push(path.resolve(path.join(__dirname, '..')));
}
const WORKSPACES_ROOT = WORKSPACES_ROOTS[0];
const WORKSPACES_CONFIG_PATH = path.join(__dirname, 'workspaces.json');

// ── Workspace Service Registry ────────────────────────────────────────────────
// Tracks which ports belong to each workspace and their service type.
// Shape: Map<workspaceName, { frontend: number|null, backend: number|null, backendPrefix: string }>
const workspaceServices = new Map();

// Tracks the most recently accessed gateway port for the fallback proxy.
// Single-user local dev tool: one active preview session at a time.
// This allows the fallback proxy to serve arbitrarily deep ES module import
// chains (App.tsx → Login.tsx → Button.tsx → ...) without needing the
// Referer header to chain back to a gateway URL.
let lastActiveGatewayPort = null;

// Detect stack type from workspace directory
const detectWorkspaceStack = async (wsPath) => {
  const topology = { frontend: null, backend: null, backendPrefix: '/api', stack: [] };
  try {
    const pkgPath = path.join(wsPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) topology.stack.push('nextjs');
      if (deps['vite']) topology.stack.push('vite');
      if (deps['react-scripts']) topology.stack.push('cra');
      if (deps['express']) topology.stack.push('express');
      if (deps['fastify']) topology.stack.push('fastify');
      if (deps['koa']) topology.stack.push('koa');
      if (deps['hono']) topology.stack.push('hono');
      const scripts = pkg.scripts || {};
      const allScripts = Object.values(scripts).join(' ');
      if (allScripts.includes('vite') && !topology.stack.includes('vite')) topology.stack.push('vite');
      if (allScripts.includes('next') && !topology.stack.includes('nextjs')) topology.stack.push('nextjs');
    }
    const reqPath = path.join(wsPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const req = await fs.promises.readFile(reqPath, 'utf8');
      if (/fastapi/i.test(req)) topology.stack.push('fastapi');
      if (/flask/i.test(req)) topology.stack.push('flask');
      if (/django/i.test(req)) topology.stack.push('django');
    }
    const pyprojPath = path.join(wsPath, 'pyproject.toml');
    if (fs.existsSync(pyprojPath)) {
      const pyproj = await fs.promises.readFile(pyprojPath, 'utf8');
      if (/fastapi/i.test(pyproj)) topology.stack.push('fastapi');
      if (/flask/i.test(pyproj)) topology.stack.push('flask');
    }
    if (fs.existsSync(wsPath)) {
      const subdirs = fs.readdirSync(wsPath, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      topology.hasFrontendDir = subdirs.some(d => ['frontend','client','web','ui'].includes(d));
      topology.hasBackendDir  = subdirs.some(d => ['backend','server','api','app'].includes(d));
    }
  } catch (err) {
    console.error('[Gateway] Stack detection error:', err.message);
  }
  topology.stack = [...new Set(topology.stack)];
  return topology;
};

// Build the gateway patcher script injected into HTML responses.
// Transparently rewrites fetch/XHR/WebSocket calls so the browser
// routes everything through the single gateway URL.
const buildGatewayPatcherScript = (workspaceName, currentPort, trailingSlash = false) =>
`<script>
(function() {
  var _workspaceName = ${JSON.stringify(workspaceName)};
  var _currentPort   = ${currentPort};
  var _trailingSlash = ${trailingSlash};
  var _gwBase        = '/gateway/' + encodeURIComponent(_workspaceName) + '/port/' + _currentPort;

  // Patch Location.prototype.pathname to transparently hide gateway/preview prefixes from routers
  try {
    var descPathname = Object.getOwnPropertyDescriptor(Location.prototype, 'pathname');
    if (descPathname && descPathname.get) {
      var origGetPathname = descPathname.get;
      Object.defineProperty(Location.prototype, 'pathname', {
        get: function() {
          var path = origGetPathname.call(this);
          if (path.indexOf('/gateway/') === 0) {
            var parts = path.split('/');
            if (parts.length >= 5 && parts[3] === 'port') {
              return '/' + parts.slice(5).join('/');
            }
          } else if (path.indexOf('/preview/') === 0) {
            var parts = path.split('/');
            if (parts.length >= 3) {
              return '/' + parts.slice(3).join('/');
            }
          }
          return path;
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {
    console.error('[GW] Failed to patch Location.pathname:', e);
  }

  function rewriteUrl(urlStr, baseHref) {
    try {
      var u = new URL(urlStr, baseHref || location.href);
      var rest = u.pathname + u.search + u.hash;

      // ── Same-origin relative paths ────────────────────────────────────────
      // When the page is loaded via the gateway (e.g. https://tunnel.xyz/gateway/.../port/3000/),
      // any relative fetch like /_next/data/... or /api/... resolves to the tunnel origin.
      // The tunnel host IS the same as location.hostname, so we detect this and reroute
      // through the gateway prefix so it reaches the dev server instead of the gateway server.
      if (u.hostname === location.hostname) {
        // Already going through a gateway/preview/ws-static path — don't rewrite, but fix trailing slash if needed
        if (rest.startsWith('/gateway/') || rest.startsWith('/preview/') || rest.startsWith('/ws-static/')) {
          if (_trailingSlash) {
            var pathname = u.pathname;
            if (!pathname.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(pathname)) {
              return location.origin + pathname + '/' + u.search + u.hash;
            }
          }
          return urlStr;
        }
        
        if (_trailingSlash) {
          var pathname = u.pathname;
          if (!pathname.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(pathname)) {
            rest = pathname + '/' + u.search + u.hash;
          }
        }
        // Everything else is an app-relative path (/_next/..., /static/..., /public/..., etc.)
        // Reroute through the gateway so it reaches the dev server
        return location.origin + _gwBase + rest;
      }

      // ── Explicit localhost / 127.0.0.1 URLs ──────────────────────────────
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return urlStr;
      var port = u.port ? parseInt(u.port) : 80;
      
      // If the port matches the gateway's port, check if it's a relative URL that resolved to the root origin
      var gwPort = parseInt(location.port || (location.protocol === 'https:' ? '443' : '80'));
      if (port === gwPort) {
        if (!rest.startsWith('/gateway/') && !rest.startsWith('/preview/') && !rest.startsWith('/ws-static/')) {
          if (_trailingSlash) {
            var pathname = u.pathname;
            if (!pathname.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(pathname)) {
              rest = pathname + '/' + u.search + u.hash;
            }
          }
          return location.origin + '/gateway/' + encodeURIComponent(_workspaceName) + '/port/' + _currentPort + rest;
        }
        return urlStr;
      }
      
      // For any other localhost port (e.g. backend port 5000), route it through the gateway at that port
      if (_trailingSlash) {
        var pathname = u.pathname;
        if (!pathname.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(pathname)) {
          rest = pathname + '/' + u.search + u.hash;
        }
      }
      return location.origin + '/gateway/' + encodeURIComponent(_workspaceName) + '/port/' + port + rest;
    } catch(e) { return urlStr; }
  }

  // 1. Patch WebSocket (Vite HMR, Next.js, etc.)
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    try {
      var u = new URL(url, location.href);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === location.hostname) {
        var gwPort = parseInt(location.port || (location.protocol === 'https:' ? '443' : '80'));
        var port = u.port ? parseInt(u.port) : null;
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        var targetPort = (port && port !== gwPort) ? port : _currentPort;
        // Strip any existing gateway prefix from pathname to prevent duplication
        var pathname = u.pathname || '/';
        var gatewayPrefix = '/gateway/' + encodeURIComponent(_workspaceName) + '/port/' + targetPort;
        if (pathname.startsWith(gatewayPrefix)) {
          pathname = pathname.substring(gatewayPrefix.length) || '/';
        }
        url = proto + '://' + location.host + '/gateway/' + encodeURIComponent(_workspaceName) + '/__ws/' + targetPort + pathname + (u.search||'');
        console.log('[GW-WS] rewritten to:', url);
      }
    } catch(e) { console.log('[GW-WS] error:', e); }
    console.log('[GW-WS] connecting:', url);
    if (protocols !== undefined) return new _OrigWS(url, protocols);
    return new _OrigWS(url);
  }
  PatchedWS.prototype = _OrigWS.prototype;
  PatchedWS.CONNECTING = _OrigWS.CONNECTING; PatchedWS.OPEN = _OrigWS.OPEN;
  PatchedWS.CLOSING = _OrigWS.CLOSING; PatchedWS.CLOSED = _OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  // 2. Patch fetch
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var urlStr = (input instanceof Request) ? input.url : String(input);
      var rewritten = rewriteUrl(urlStr);
      if (rewritten !== urlStr) {
        if (input instanceof Request) {
          var initOpts = {};
          var keys = ['method', 'headers', 'credentials', 'cache', 'redirect', 'referrer', 'integrity', 'keepalive', 'signal'];
          for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (input[k] !== undefined) initOpts[k] = input[k];
          }
          if (input.mode !== 'navigate') {
            initOpts.mode = input.mode;
          }
          if (input.method !== 'GET' && input.method !== 'HEAD') {
            try {
              initOpts.body = input.clone().body;
            } catch(e) {}
          }
          input = new Request(rewritten, initOpts);
        } else {
          input = rewritten;
        }
      }
    } catch(e) {
      console.log('[GW-WS] fetch rewrite error:', e);
    }
    return _origFetch.call(this, input, init);
  };

  // 3. Patch XMLHttpRequest
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try { if (typeof url === 'string') url = rewriteUrl(url); } catch(e) {}
    return _origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };

  function rewriteHistoryUrl(urlStr) {
    if (!urlStr) return urlStr;
    try {
      var u = new URL(urlStr, location.href);
      if (u.hostname === location.hostname) {
        var rest = u.pathname + u.search + u.hash;
        if (!rest.startsWith('/gateway/') && !rest.startsWith('/preview/') && !rest.startsWith('/ws-static/')) {
          var newPath = _gwBase + (rest.startsWith('/') ? rest : '/' + rest);
          return location.origin + newPath;
        }
      }
      return urlStr;
    } catch(e) { return urlStr; }
  }

  // 4. Clean token from URL bar and patch History API
  if (window.history) {
    var _origPush = window.history.pushState;
    window.history.pushState = function(state, title, url) {
      var target = url;
      if (target !== undefined && target !== null) {
        target = rewriteHistoryUrl(String(target));
      }
      return _origPush.call(this, state, title, target);
    };

    var _origReplace = window.history.replaceState;
    window.history.replaceState = function(state, title, url) {
      var target = url;
      if (target !== undefined && target !== null) {
        target = rewriteHistoryUrl(String(target));
      }
      return _origReplace.call(this, state, title, target);
    };

    var _u = new URL(window.location.href);
    if (_u.searchParams.has('token') || _u.searchParams.has('t')) {
      _u.searchParams.delete('token'); _u.searchParams.delete('t');
      window.history.replaceState({}, document.title, _u.pathname + _u.search + _u.hash);
    }
  }
})();
</script>`;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());

// ── HTML file preview — serves workspace files with correct MIME types ───────
// GET /api/files/preview?workspace=X&filePath=Y&token=Z
app.get('/api/files/preview', async (req, res) => {
  const { workspace, filePath, token: reqToken } = req.query;
  if (reqToken !== SECURITY_TOKEN) return res.status(401).send('Unauthorized');
  if (!workspace || !filePath) return res.status(400).send('Missing params');

  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const absPath = path.join(wsRoot, filePath);
    if (!absPath.startsWith(wsRoot)) return res.status(403).send('Forbidden');

    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) return res.status(400).send('Not a file');

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.html': 'text/html', '.htm': 'text/html',
      '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.webp': 'image/webp',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    };

    if (ext === '.html' || ext === '.htm') {
      let html = await fs.promises.readFile(absPath, 'utf8');
      // Directory of the HTML file relative to workspace root (e.g. "chernobyl")
      const fileDir = path.dirname(filePath).replace(/\\/g, '/');
      const base = fileDir === '.' ? '' : fileDir + '/';

      // Rewrite relative src/href to route through this endpoint
      const rewrite = (attr, val) => {
        // Skip absolute URLs, data URIs, anchors, mailto
        if (/^(https?:|\/\/|data:|mailto:|#|javascript:)/i.test(val)) return `${attr}="${val}"`;
        // Remove leading ./
        const clean = val.replace(/^\.\//, '');
        const resolved = base + clean;
        return `${attr}="/api/files/preview?workspace=${encodeURIComponent(workspace)}&filePath=${encodeURIComponent(resolved)}&token=${encodeURIComponent(reqToken)}"`;
      };

      html = html
        .replace(/\bsrc="([^"]+)"/g, (_, v) => rewrite('src', v))
        .replace(/\bsrc='([^']+)'/g, (_, v) => rewrite('src', v))
        .replace(/\bhref="([^"]+)"/g, (_, v) => rewrite('href', v))
        .replace(/\bhref='([^']+)'/g, (_, v) => rewrite('href', v));

      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.sendFile(absPath);
  } catch (err) {
    res.status(404).send('Not found: ' + err.message);
  }
});

// Redirect navigation requests to / back to the gateway/preview if they came from it
app.get('/', (req, res, next) => {
  const referer = req.headers.referer;
  if (referer && (referer.includes('/gateway/') || referer.includes('/preview/'))) {
    const isHtmlRequest = req.headers.accept && req.headers.accept.includes('text/html');
    if (isHtmlRequest) {
      let port = null;
      let workspaceName = null;
      let isPreviewMode = false;

      const previewMatch = referer.match(/\/preview\/(\d+)/);
      const gatewayMatch = referer.match(/\/gateway\/([^/]+)\/port\/(\d+)/);
      if (previewMatch) {
        port = parseInt(previewMatch[1], 10);
        isPreviewMode = true;
      } else if (gatewayMatch) {
        workspaceName = decodeURIComponent(gatewayMatch[1]);
        port = parseInt(gatewayMatch[2], 10);
      }

      if (!port && lastActiveGatewayPort) {
        port = lastActiveGatewayPort;
      }
      if (!workspaceName && port) {
        for (const [wsName, svcs] of workspaceServices.entries()) {
          if (svcs.frontend === port || svcs.backend === port) {
            workspaceName = wsName;
            break;
          }
        }
      }

      if (port) {
        let targetUrl;
        if (isPreviewMode) {
          targetUrl = `/preview/${port}/`;
        } else {
          targetUrl = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}/`;
        }
        console.log(`[Gateway Redirect] Redirecting root navigation from Referer: ${targetUrl}`);
        return res.redirect(302, targetUrl);
      }
    }
  }
  next();
});

// Serve static client build if it exists
const distPath = path.resolve(__dirname, '../client/dist');
if (fs.existsSync(distPath)) {
  console.log(`[Host Daemon] Serving static client files from: ${distPath}`);
  app.use(express.static(distPath));
}

// Token verification middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== SECURITY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
};

// Helper to load custom workspaces mapping
const getCustomWorkspaces = () => {
  try {
    if (fs.existsSync(WORKSPACES_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read workspaces.json', err);
  }
  return {};
};

// Helper to save custom workspaces mapping
const saveCustomWorkspaces = (data) => {
  try {
    fs.writeFileSync(WORKSPACES_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write workspaces.json', err);
  }
};

// Helper to resolve workspace path and prevent directory traversal
const resolveWorkspacePath = (workspaceName, subPath = '') => {
  const customs = getCustomWorkspaces();
  let root = null;

  if (customs[workspaceName]) {
    root = path.resolve(customs[workspaceName]);
  } else {
    for (const r of WORKSPACES_ROOTS) {
      const candidate = path.resolve(r, workspaceName);
      if (fs.existsSync(candidate)) {
        root = candidate;
        break;
      }
    }
    if (!root) {
      root = path.resolve(WORKSPACES_ROOT, workspaceName);
    }
  }

  // Prevent directory traversal
  const absolutePath = path.resolve(root, subPath);
  const relative = path.relative(root, absolutePath);
  const isSub = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isSub) {
    throw new Error('Access denied: Out of workspace bounds');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Workspace path does not exist: ${absolutePath}`);
  }
  
  // Add workspace to git safe.directory to fix dubious ownership error
  exec(`git config --global --replace-all safe.directory "${absolutePath.replace(/\\/g, '/')}"`, (err) => {
    if (err) {
      // Silently fail - don't block workspace access if git config fails
      console.error(`Git safe.directory config skipped for ${absolutePath}`);
    }
  });
  
  return absolutePath;
};

// Helper to forward parsed request body if consumed by express.json()
const forwardRequestBody = (req, proxyReq) => {
  if (req.body && (typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.write(bodyData);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyData = new URLSearchParams(req.body).toString();
      proxyReq.write(bodyData);
    } else {
      proxyReq.write(req.body);
    }
    proxyReq.end();
  } else {
    req.pipe(proxyReq, { end: true });
  }
};

// --- REST Endpoints ---

// ── Workspace Gateway — single URL per workspace, routes to frontend + backend ─
// /gateway/:workspace/          → frontend port (e.g. Vite on 3000)
// /gateway/:workspace/api/*     → backend port  (e.g. Express/Flask on 8000)
// /gateway/:workspace/__ws/:port/* → WebSocket passthrough (HTTP upgrade handled in server.on('upgrade'))

// ── SSE passthrough for Next.js HMR (/_next/webpack-hmr, /_next/eventsource) ─
// Must be defined BEFORE the main gateway route so it takes priority.
app.get('/gateway/:workspace/port/:port/_next/webpack-hmr', (req, res) => {
  _gatewaySSE(req, res);
});
app.get('/gateway/:workspace/port/:port/_next/eventsource', (req, res) => {
  _gatewaySSE(req, res);
});
function _gatewaySSE(req, res) {
  // Auth via cookie
  let cookieToken = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('='); acc[k] = v; return acc;
    }, {});
    cookieToken = cookies['portable_token'];
  }
  const authorized = req.query.token === SECURITY_TOKEN || cookieToken === SECURITY_TOKEN;
  if (!authorized) { res.status(401).end('Unauthorized'); return; }

  const port = parseInt(req.params.port, 10);
  const match = req.path.match(/^\/gateway\/[^/]+\/port\/\d+(\/.*)$/);
  const subPath = match ? match[1] : req.path;

  // Prepend basePath if Next.js config contains it
  let finalPath = subPath;
  try {
    const workspaceName = req.params.workspace;
    const wsRoot = resolveWorkspacePath(workspaceName);
    const configFile = ['next.config.mjs','next.config.js','next.config.ts','next.config.cjs']
      .find(f => fs.existsSync(path.join(wsRoot, f)));
    const hasBasePath = configFile
      && /basePath\s*:/.test(fs.readFileSync(path.join(wsRoot, configFile), 'utf8'));
    if (hasBasePath) {
      finalPath = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}${subPath}`;
    }
  } catch (e) {
    // fallback to original subPath
  }

  // Set SSE headers — no buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const options = {
    hostname: 'localhost',
    port,
    path: finalPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''),
    method: 'GET',
    headers: {
      ...req.headers,
      host: `localhost:${port}`,
      accept: 'text/event-stream',
    },
  };
  delete options.headers['authorization'];

  const proxyReq = http.request(options, (proxyRes) => {
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', () => res.end());
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
}

// ── Auto-patch next.config.js with basePath + assetPrefix ────────────────────
// POST /api/workspaces/patch-nextconfig  { workspace, port }
app.post('/api/workspaces/patch-nextconfig', authenticate, async (req, res) => {
  const { workspace, port } = req.body;
  if (!workspace || !port) return res.status(400).json({ error: 'Missing workspace or port' });
  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const gwBase = `/gateway/${encodeURIComponent(workspace)}/port/${port}`;
    // Find next.config file (js, mjs, ts)
    const candidates = ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.cjs'];
    let configPath = null;
    for (const c of candidates) {
      const p = path.join(wsRoot, c);
      if (fs.existsSync(p)) { configPath = p; break; }
    }
    if (!configPath) {
      // Create a minimal one
      configPath = path.join(wsRoot, 'next.config.mjs');
      await fs.promises.writeFile(configPath,
        `const nextConfig = {\n  basePath: '${gwBase}',\n  assetPrefix: '${gwBase}',\n};\nexport default nextConfig;\n`
      );
      return res.json({ status: 'created', file: 'next.config.mjs', gwBase });
    }
    let content = await fs.promises.readFile(configPath, 'utf8');
    // Remove existing basePath / assetPrefix lines
    content = content
      .replace(/^\s*basePath\s*:.*,?\n?/gm, '')
      .replace(/^\s*assetPrefix\s*:.*,?\n?/gm, '');
    // Inject before the closing of the config object — handles both JS and TS type annotations
    content = content.replace(
      /(const|let|var)\s+nextConfig\s*(?::\s*\w+\s*)?\s*=\s*\{/,
      `$1 nextConfig: NextConfig = {\n  basePath: '${gwBase}',\n  assetPrefix: '${gwBase}',`
    );
    await fs.promises.writeFile(configPath, content, 'utf8');
    res.json({ status: 'patched', file: path.basename(configPath), gwBase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Port-Isolated Workspace Gateway Routing ──────────────────────────────
app.all('/gateway/:workspace/port/:port*', async (req, res) => {
  // Auth: cookie or ?token=
  let cookieToken = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('='); acc[k] = v; return acc;
    }, {});
    cookieToken = cookies['portable_token'];
  }
  const tokenParam = req.query.token;
  const authorized = tokenParam === SECURITY_TOKEN || cookieToken === SECURITY_TOKEN;
  if (!authorized) return res.status(401).send('Unauthorized');

  if (tokenParam === SECURITY_TOKEN) {
    res.setHeader('Set-Cookie', `portable_token=${tokenParam}; Path=/; HttpOnly; SameSite=Lax`);
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, Cookie');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const workspaceName = req.params.workspace;

  // Use regex to parse port and subPath accurately
  const match = req.path.match(/^\/gateway\/([^/]+)\/port\/(\d+)(.*)$/);
  if (!match) {
    return res.status(400).send('Invalid gateway URL');
  }
  const port = parseInt(match[2], 10);
  const subPath = match[3] || '/';

  if (!port || port < 1024 || port > 65535) {
    return res.status(400).send('Invalid port');
  }

  // Only update lastActiveGatewayPort if it's not a backend API request
  const services = workspaceServices.get(workspaceName);
  const isBackend = services && (services.backend === port || subPath.startsWith(services.backendPrefix || '/api'));
  if (!isBackend) {
    lastActiveGatewayPort = port;
  }

  // Redirect if missing trailing slash so relative paths resolve correctly
  if (req.path === `/gateway/${encodeURIComponent(workspaceName)}/port/${port}`) {
    const qs = req.url.slice(req.path.length);
    return res.redirect(301, `/gateway/${encodeURIComponent(workspaceName)}/port/${port}/${qs}`);
  }

  // Base path of the gateway for this specific port
  const gwBase = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}`;

  // Check if Next.js config contains trailingSlash: true
  let trailingSlash = false;
  try {
    const wsRoot = resolveWorkspacePath(workspaceName);
    const configFile = ['next.config.mjs','next.config.js','next.config.ts','next.config.cjs']
      .find(f => fs.existsSync(path.join(wsRoot, f)));
    if (configFile) {
      const content = fs.readFileSync(path.join(wsRoot, configFile), 'utf8');
      trailingSlash = /trailingSlash\s*:\s*true/.test(content);
    }
  } catch (e) {
    // ignore
  }

  // Build the client patcher script to inject
  const patcherScript = buildGatewayPatcherScript(workspaceName, port, trailingSlash);

  // Strip query token before forwarding
  const forwardQuery = { ...req.query };
  delete forwardQuery.token;
  delete forwardQuery.t;
  const qs = new URLSearchParams(forwardQuery).toString();

  // Forward the full path including gateway prefix when basePath is set in next.config
  // so Next.js can match its own basePath-prefixed routes correctly.
  let fullTargetPath;
  try {
    const wsRoot = resolveWorkspacePath(workspaceName);
    const configFile = ['next.config.mjs','next.config.js','next.config.ts','next.config.cjs']
      .find(f => fs.existsSync(path.join(wsRoot, f)));
    const hasBasePath = configFile
      && /basePath\s*:/.test(fs.readFileSync(path.join(wsRoot, configFile), 'utf8'));
    fullTargetPath = hasBasePath
      ? (gwBase + (subPath === '/' ? '/' : subPath) + (qs ? `?${qs}` : ''))
      : (subPath + (qs ? `?${qs}` : ''));
  } catch {
    fullTargetPath = subPath + (qs ? `?${qs}` : '');
  }

  const proxyHeaders = {
    ...req.headers,
    host: `localhost:${port}`,
    'accept-encoding': 'gzip, deflate',
  };
  delete proxyHeaders['authorization'];

  if (req.body && (typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const bodyData = JSON.stringify(req.body);
      proxyHeaders['content-length'] = Buffer.byteLength(bodyData);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyData = new URLSearchParams(req.body).toString();
      proxyHeaders['content-length'] = Buffer.byteLength(bodyData);
    }
  }

  const proxyOptions = {
    hostname: 'localhost',
    port: port,
    path: fullTargetPath || '/',
    method: req.method,
    headers: proxyHeaders,
  };

  const proxyReq = http.request(proxyOptions, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const encoding = proxyRes.headers['content-encoding'] || '';
    const isHtml = contentType.includes('text/html');
    console.log(`[Gateway Proxy] ${req.method} ${fullTargetPath} → ${proxyRes.statusCode} ct="${contentType}" enc="${encoding}" isHtml=${isHtml}`);

    const outHeaders = { ...proxyRes.headers };
    // Strip embedding-blocking headers
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];

    // Rewrite Set-Cookie paths to prevent cookie collision between workspaces
    // Isolate by workspace folder prefix rather than port to allow sharing cookies between frontend and backend of the same workspace
    if (outHeaders['set-cookie']) {
      const cookies = Array.isArray(outHeaders['set-cookie'])
        ? outHeaders['set-cookie']
        : [outHeaders['set-cookie']];
      const wsBase = `/gateway/${encodeURIComponent(workspaceName)}`;
      outHeaders['set-cookie'] = cookies.map(cookieStr => {
        if (/path=\/[^;]*/i.test(cookieStr)) {
          return cookieStr.replace(/path=\/[^;]*/i, `Path=${wsBase}`);
        } else if (!/path=/i.test(cookieStr)) {
          return cookieStr + `; Path=${wsBase}`;
        }
        return cookieStr;
      });
    }

    // Rewrite redirect locations to stay within this port's gateway
    if (outHeaders.location) {
      const loc = outHeaders.location;
      const locNorm = loc.replace(/\/$/, '');
      const reqNorm = req.path.replace(/\/$/, '');
      // Trailing-slash loop: Next.js redirects /gwBase/ → /gwBase endlessly.
      // Break it by stripping the trailing slash from the location so the
      // browser lands on /gwBase which our proxy already handles without redirect.
      if (locNorm === reqNorm && reqNorm === gwBase) {
        // They're the same path — just remove trailing slash from location
        outHeaders.location = loc.endsWith('/') ? loc.slice(0, -1) : loc + '/';
      } else if (loc.startsWith('/') && !loc.startsWith(gwBase)) {
        outHeaders.location = gwBase + loc;
      } else {
        const relativeLoc = loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1):\d+/, '');
        if (relativeLoc.startsWith('/') && !relativeLoc.startsWith(gwBase)) {
          outHeaders.location = gwBase + relativeLoc;
        } else {
          outHeaders.location = relativeLoc;
        }
      }
    }

    if (isHtml) {
      delete outHeaders['content-encoding'];
      delete outHeaders['content-length'];

      let stream = proxyRes;
      if (encoding === 'gzip')         stream = proxyRes.pipe(zlib.createGunzip());
      else if (encoding === 'deflate')  stream = proxyRes.pipe(zlib.createInflate());
      else if (encoding === 'br')       stream = proxyRes.pipe(zlib.createBrotliDecompress());

      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        // ── Strip CSP meta tag entirely (nonces are per-tag, can't be reused) ──
        let rewritten = body.replace(/<meta[^>]+Content-Security-Policy[^>]*>/gi, '');

        // Rewrite absolute asset paths
        rewritten = rewritten
          .replace(/https?:\/\/localhost:\d+\/(?!gateway\/|preview\/|ws\/|api\/)/g, `${gwBase}/`)
          .replace(/(src|href|action)="\/(?!\/|gateway\/|preview\/)/g, `$1="${gwBase}/`)
          .replace(/(src|href|action)='\/(?!\/|gateway\/|preview\/)/g,  `$1='${gwBase}/`)
          .replace(/url\(\/(?!\/|gateway\/|preview\/)/g,                `url(${gwBase}/`)
          .replace(/from\s+"\/(?!\/|gateway\/|preview\/)/g, `from "${gwBase}/`)
          .replace(/from\s+'\/(?!\/|gateway\/|preview\/)/g, `from '${gwBase}/`)
          .replace(/import\s+"\/(?!\/|gateway\/|preview\/)/g, `import "${gwBase}/`)
          .replace(/import\s+'\/(?!\/|gateway\/|preview\/)/g, `import '${gwBase}/`);

        // ── Inject patcher after <meta charset> with no nonce needed (CSP stripped) ──
        const charsetMeta = rewritten.match(/<meta[^>]+charset[^>]*>/i);
        if (charsetMeta) {
          rewritten = rewritten.replace(charsetMeta[0], `${charsetMeta[0]}${patcherScript}`);
        } else if (rewritten.includes('<head>')) {
          rewritten = rewritten.replace('<head>', `<head>${patcherScript}`);
        } else if (rewritten.includes('</head>')) {
          rewritten = rewritten.replace('</head>', `${patcherScript}</head>`);
        } else {
          rewritten = patcherScript + rewritten;
        }

        outHeaders['content-length'] = Buffer.byteLength(rewritten, 'utf8');
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(rewritten, 'utf8');
      });
      stream.on('error', () => {
        if (!res.headersSent) res.status(502).send('Decompression error');
      });
    } else {
      // Non-HTML content: pass through with fixed CORS headers
      outHeaders['access-control-allow-origin'] = req.headers['origin'] || '*';
      if (req.headers['origin']) {
        outHeaders['access-control-allow-credentials'] = 'true';
        outHeaders['vary'] = (outHeaders['vary'] ? outHeaders['vary'] + ', ' : '') + 'Origin';
      }
      outHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
      outHeaders['access-control-allow-headers'] = req.headers['access-control-request-headers'] || 'Content-Type, Authorization';

      // Fix missing MIME types
      const requestPath = subPath || '/';
      const ext = path.extname(requestPath).toLowerCase();
      if (ext === '.css' && !outHeaders['content-type']) {
        outHeaders['content-type'] = 'text/css; charset=utf-8';
      } else if (ext === '.js' && !outHeaders['content-type']) {
        outHeaders['content-type'] = 'application/javascript; charset=utf-8';
      }

      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).type('html').send(`
        <html><body style="background:#0a0a0a;color:#e5e7eb;font-family:monospace;padding:40px;max-width:600px;margin:auto">
          <h2 style="color:#f87171">⚡ Port unreachable</h2>
          <p>Cannot connect to <strong style="color:#fff">localhost:${port}</strong></p>
          <p style="color:#9ca3af">Is the dev server running on port ${port}? Check your terminal tab.</p>
          <pre style="background:#111;border:1px solid #333;padding:12px;border-radius:8px;color:#f87171;margin-top:8px">${err.message}</pre>
        </body></html>`);
    }
  });

  forwardRequestBody(req, proxyReq);
});

// ── Live port proxy — forwards /preview/<port>/* to localhost:<port> ─────────
// Used by PreviewTab to embed running dev servers in an iframe
app.all('/preview/:port*', (req, res) => {
  let tokenParam = req.query.token;
  
  // Parse cookies manually
  let cookieToken = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {});
    cookieToken = cookies['portable_token'];
  }

  const authorized = tokenParam === SECURITY_TOKEN || cookieToken === SECURITY_TOKEN;
  if (!authorized) {
    return res.status(401).send('Unauthorized');
  }

  // Set cookie if token was passed in query to establish session
  if (tokenParam === SECURITY_TOKEN) {
    res.setHeader('Set-Cookie', `portable_token=${tokenParam}; Path=/; HttpOnly; SameSite=Lax`);
  }

  const port = parseInt(req.params.port, 10);
  if (!port || port < 1024 || port > 65535) {
    return res.status(400).send('Invalid port');
  }
  
  const subPath = req.params[0] || '/';
  if (port !== 8080 && !subPath.startsWith('/api')) {
    lastActiveGatewayPort = port;
  }

  // Handle CORS preflight — browsers send this before every cross-origin API call
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, Cookie');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  // Build target path — strip /preview/<port> prefix and our token params
  const suffix = req.params[0] || '/';
  const urlObj = new URL(`http://localhost${suffix || '/'}`);
  
  // Forward original query parameters
  for (const [key, val] of Object.entries(req.query)) {
    urlObj.searchParams.set(key, val);
  }
  
  urlObj.searchParams.delete('token');
  urlObj.searchParams.delete('t');
  const targetPath = (urlObj.pathname || '/') + (urlObj.search || '');

  const proxyHeaders = {
    ...req.headers,
    host: `localhost:${port}`,
    // Accept both compressed and plain — we'll handle decompression ourselves
    'accept-encoding': 'gzip, deflate',
  };
  delete proxyHeaders['authorization'];

  if (req.body && (typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const bodyData = JSON.stringify(req.body);
      proxyHeaders['content-length'] = Buffer.byteLength(bodyData);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyData = new URLSearchParams(req.body).toString();
      proxyHeaders['content-length'] = Buffer.byteLength(bodyData);
    }
  }

  const options = {
    hostname: 'localhost',
    port,
    path: targetPath,
    method: req.method,
    headers: proxyHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const encoding = proxyRes.headers['content-encoding'] || '';
    const isHtml = contentType.includes('text/html');

    // Strip headers that block iframe embedding
    const outHeaders = { ...proxyRes.headers };
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];

    // Rewrite Set-Cookie paths to prevent cookie collision between workspaces
    // Allow sharing cookies between all preview ports since they reside under /preview
    if (outHeaders['set-cookie']) {
      const cookies = Array.isArray(outHeaders['set-cookie'])
        ? outHeaders['set-cookie']
        : [outHeaders['set-cookie']];
      outHeaders['set-cookie'] = cookies.map(cookieStr => {
        const pathPrefix = `/preview`;
        if (/path=\/[^;]*/i.test(cookieStr)) {
          return cookieStr.replace(/path=\/[^;]*/i, `Path=${pathPrefix}`);
        } else if (!/path=/i.test(cookieStr)) {
          return cookieStr + `; Path=${pathPrefix}`;
        }
        return cookieStr;
      });
    }

    // Rewrite redirect locations to stay within the proxy
    if (outHeaders.location) {
      const loc = outHeaders.location;
      if (loc.startsWith('/') && !loc.startsWith(`/preview/${port}`)) {
        outHeaders.location = `/preview/${port}${loc}`;
      } else {
        const relativeLoc = loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1):\d+/, '');
        if (relativeLoc.startsWith('/') && !relativeLoc.startsWith(`/preview/${port}`)) {
          outHeaders.location = `/preview/${port}${relativeLoc}`;
        } else {
          outHeaders.location = relativeLoc;
        }
      }
    }

    // For HTML: decompress if needed, rewrite asset paths, re-send as plain utf8
    if (isHtml) {
      delete outHeaders['content-encoding'];
      delete outHeaders['content-length']; // will change after rewrite

      let stream = proxyRes;
      if (encoding === 'gzip') {
        stream = proxyRes.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = proxyRes.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = proxyRes.pipe(zlib.createBrotliDecompress());
      }

      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { body += chunk; });
      stream.on('end', () => {
        // Rewrite absolute asset paths so they route through the proxy
        let rewritten = body
          .replace(/(src|href|action)="\/(?!\/)/g, `$1="/preview/${port}/`)
          .replace(/(src|href|action)='\/(?!\/)/g,  `$1='/preview/${port}/`)
          .replace(/url\(\/(?!\/)/g,                `url(/preview/${port}/`);

        // ── Proxy Patcher Script ─────────────────────────────────────────────
        // Injected before any app code runs. Transparently routes:
        //   • WebSocket connections (Vite HMR, webpack-dev-server) → /preview/:port/...
        //   • fetch() calls to localhost:port → /preview/:port/...
        //   • XMLHttpRequest calls to localhost:port → /preview/:port/...
        // Zero changes required in any project.
        const scriptToInject = `<script>
(function() {
  var _proxyPort = ${port};

  // Patch Location.prototype.pathname to transparently hide gateway/preview prefixes from routers
  try {
    var descPathname = Object.getOwnPropertyDescriptor(Location.prototype, 'pathname');
    if (descPathname && descPathname.get) {
      var origGetPathname = descPathname.get;
      Object.defineProperty(Location.prototype, 'pathname', {
        get: function() {
          var path = origGetPathname.call(this);
          if (path.indexOf('/gateway/') === 0) {
            var parts = path.split('/');
            if (parts.length >= 5 && parts[3] === 'port') {
              return '/' + parts.slice(5).join('/');
            }
          } else if (path.indexOf('/preview/') === 0) {
            var parts = path.split('/');
            if (parts.length >= 3) {
              return '/' + parts.slice(3).join('/');
            }
          }
          return path;
        },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {
    console.error('[GW] Failed to patch Location.pathname:', e);
  }

  // 1. Patch WebSocket — redirect HMR and dev-server sockets through proxy
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    try {
      var u = new URL(url, location.href);
      // Redirect any localhost:port WS or any WS to current host root
      var targetPort = u.port ? parseInt(u.port) : (u.hostname === location.hostname ? _proxyPort : null);
      if (targetPort && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === location.hostname)) {
        var proto = location.protocol === 'https:' ? 'wss' : 'ws';
        url = proto + '://' + location.host + '/preview/' + targetPort + (u.pathname || '/') + (u.search || '');
      }
    } catch(e) {}
    if (protocols !== undefined) return new _OrigWS(url, protocols);
    return new _OrigWS(url);
  }
  PatchedWS.prototype = _OrigWS.prototype;
  PatchedWS.CONNECTING = _OrigWS.CONNECTING;
  PatchedWS.OPEN = _OrigWS.OPEN;
  PatchedWS.CLOSING = _OrigWS.CLOSING;
  PatchedWS.CLOSED = _OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  // 2. Patch fetch — redirect localhost API calls through proxy
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var urlStr = (input instanceof Request) ? input.url : input;
      if (typeof urlStr === 'string') {
        var u = new URL(urlStr);
        if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port) {
          var newUrl = location.origin + '/preview/' + u.port + u.pathname + u.search + u.hash;
          input = (input instanceof Request) ? new Request(newUrl, input) : newUrl;
        }
      }
    } catch(e) {}
    return _origFetch.call(this, input, init);
  };

  // 3. Patch XMLHttpRequest — same redirect
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (typeof url === 'string') {
        var u = new URL(url, location.href);
        if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port) {
          url = location.origin + '/preview/' + u.port + u.pathname + u.search + u.hash;
        }
      }
    } catch(e) {}
    return _origOpen.apply(this, arguments);
  };

  function rewriteHistoryUrl(urlStr) {
    if (!urlStr) return urlStr;
    try {
      var u = new URL(urlStr, location.href);
      if (u.hostname === location.hostname) {
        var rest = u.pathname + u.search + u.hash;
        if (!rest.startsWith('/gateway/') && !rest.startsWith('/preview/') && !rest.startsWith('/ws-static/')) {
          var newPath = '/preview/' + _proxyPort + (rest.startsWith('/') ? rest : '/' + rest);
          return location.origin + newPath;
        }
      }
      return urlStr;
    } catch(e) { return urlStr; }
  }

  // 4. Clean token/timestamp from URL bar and patch History API
  if (window.history) {
    var _origPush = window.history.pushState;
    window.history.pushState = function(state, title, url) {
      var target = url;
      if (target !== undefined && target !== null) {
        target = rewriteHistoryUrl(String(target));
      }
      return _origPush.call(this, state, title, target);
    };

    var _origReplace = window.history.replaceState;
    window.history.replaceState = function(state, title, url) {
      var target = url;
      if (target !== undefined && target !== null) {
        target = rewriteHistoryUrl(String(target));
      }
      return _origReplace.call(this, state, title, target);
    };

    var url = new URL(window.location.href);
    if (url.searchParams.has('token') || url.searchParams.has('t')) {
      url.searchParams.delete('token');
      url.searchParams.delete('t');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    }
  }
})();
</script>`;

        // Inject as the very first thing inside <head> so it runs before any app JS
        if (rewritten.includes('<head>')) {
          rewritten = rewritten.replace('<head>', `<head>${scriptToInject}`);
        } else if (rewritten.includes('</head>')) {
          rewritten = rewritten.replace('</head>', `${scriptToInject}</head>`);
        } else if (rewritten.includes('</body>')) {
          rewritten = rewritten.replace('</body>', `${scriptToInject}</body>`);
        } else {
          rewritten = scriptToInject + rewritten;
        }

        outHeaders['content-length'] = Buffer.byteLength(rewritten, 'utf8');
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(rewritten, 'utf8');
      });
      stream.on('error', () => {
        if (!res.headersSent) res.status(502).send('Decompression error');
      });
    } else {
      // Non-HTML: pass through (images, JS, CSS etc.)
      // Fix CORS headers so browser accepts API responses from the proxied backend
      outHeaders['access-control-allow-origin'] = req.headers['origin'] || '*';
      if (req.headers['origin']) {
        outHeaders['access-control-allow-credentials'] = 'true';
        outHeaders['vary'] = (outHeaders['vary'] ? outHeaders['vary'] + ', ' : '') + 'Origin';
      }
      outHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
      outHeaders['access-control-allow-headers'] = req.headers['access-control-request-headers'] || 'Content-Type, Authorization';

      // Ensure proper MIME types
      const requestPath = suffix || '/';
      const ext = path.extname(requestPath).toLowerCase();
      
      if (ext === '.css' && !outHeaders['content-type']) {
        outHeaders['content-type'] = 'text/css; charset=utf-8';
      } else if (ext === '.js' && !outHeaders['content-type']) {
        outHeaders['content-type'] = 'application/javascript; charset=utf-8';
      }
      
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(`Cannot connect to localhost:${port} — is the dev server running?\n\n${err.message}`);
    }
  });

  forwardRequestBody(req, proxyReq);
});

// Check authentication
app.get('/api/auth/check', authenticate, (req, res) => {
  res.json({ status: 'ok', workspacesRoot: WORKSPACES_ROOT });
});

// Fetch supported agent providers and profiles dynamically
app.get('/api/agent/providers', authenticate, (req, res) => {
  const providers = [
    {
      value: 'antigravity',
      label: 'Antigravity',
      desc: 'AI-native IDE agent — context-aware, repository-wide',
      profiles: [
        { value: 'gemini-3.5-flash-low',   label: 'Gemini 3.5 Flash · Low',        desc: 'Lightweight — quick patches and autocomplete' },
        { value: 'gemini-3.5-flash-medium',label: 'Gemini 3.5 Flash · Medium',      desc: 'Balanced — most everyday coding tasks' },
        { value: 'gemini-3.5-flash-high',  label: 'Gemini 3.5 Flash · High',        desc: 'Deep reasoning — complex multi-file refactors' },
        { value: 'gemini-3.1-pro-low',     label: 'Gemini 3.1 Pro · Low',           desc: 'Pro intelligence, efficient token budget' },
        { value: 'gemini-3.1-pro-high',    label: 'Gemini 3.1 Pro · High',          desc: 'Pro intelligence, maximum quality output' },
        { value: 'claude-sonnet-4.6-think',label: 'Claude Sonnet 4.6 · Thinking',   desc: 'Extended reasoning chains — architecture work' },
        { value: 'claude-opus-4.6-think',  label: 'Claude Opus 4.6 · Thinking',     desc: 'Elite model — hardest problems and rewrites' },
        { value: 'gpt-oss-120b-medium',    label: 'GPT-OSS 120B · Medium',          desc: 'Open-source backbone — good general coverage' },
      ],
    },
    /*{
      value: 'copilot',
      label: 'GitHub Copilot',
      desc: 'Context-rich code completion and suggestion CLI',
      profiles: [
        { value: 'gpt-4o',             label: 'GPT-4o',              desc: 'Default Copilot engine for code generation' },
        { value: 'claude-3.5-sonnet',  label: 'Claude 3.5 Sonnet',   desc: 'Copilot with Anthropic backend — strong debugging' },
      ],
    },*/
    {
      value: 'codex',
      label: 'Codex CLI',
      desc: 'Legacy code translation and API drafting',
      profiles: [
        { value: 'code-davinci-002',   label: 'Code Davinci 002',    desc: 'Legacy model — code translation and scaffolding' },
      ],
    },
    /*{
      value: 'devin',
      label: 'Devin',
      desc: 'Autonomous full-stack engineering subagent',
      profiles: [
        { value: 'devin-autonomous',   label: 'Devin Autonomous',    desc: 'Multi-agent execution with sandbox environment' },
      ],
    },*/
    /*{
      value: 'ollama',
      label: 'Ollama (Local)',
      desc: 'Run open-source models on your host machine',
      profiles: [],
    },*/
  ];
  res.json({ providers });
});

// Fetch supported models for a provider dynamically
app.get('/api/models', authenticate, async (req, res) => {
  const { provider } = req.query;
  if (!provider) return res.status(400).json({ error: 'Missing provider' });

  let models = [];
  if (provider === 'antigravity') {
    const cliPath = process.env.ANTIGRAVITY_CLI_PATH || 'D:\\antigravity-cli\\agy.exe';
    exec(`"${cliPath}" models`, { timeout: 3000 }, (err, stdout, stderr) => {
      const fallbackList = [
        { value: 'gemini-3.5-flash-lowly',    label: 'Gemini 3.5 Flash · Low',        desc: 'Lightweight — quick patches and autocomplete' },
        { value: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash · Medium',      desc: 'Balanced — most everyday coding tasks' },
        { value: 'gemini-3.5-flash-high',   label: 'Gemini 3.5 Flash · High',        desc: 'Deep reasoning — complex multi-file refactors' },
        { value: 'gemini-3.1-pro-low',      label: 'Gemini 3.1 Pro · Low',           desc: 'Pro intelligence, efficient token budget' },
        { value: 'gemini-3.1-pro-high',     label: 'Gemini 3.1 Pro · High',          desc: 'Pro intelligence, maximum quality output' },
        { value: 'claude-sonnet-4.6-think', label: 'Claude Sonnet 4.6 · Thinking',   desc: 'Extended reasoning chains — architecture work' },
        { value: 'claude-opus-4.6-think',   label: 'Claude Opus 4.6 · Thinking',     desc: 'Elite model — hardest problems and rewrites' },
        { value: 'gpt-oss-120b-medium',     label: 'GPT-OSS 120B · Medium',          desc: 'Open-source backbone — good general coverage' }
      ];
      if (err || !stdout) {
        return res.json({ models: fallbackList });
      }
      
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const list = lines
        .filter(l => !l.startsWith('Usage') && !l.includes('available') && !l.includes('flags') && !l.includes(':'))
        .map(name => {
          const label = name
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          return {
            value: name,
            label: label,
            desc: `CLI model: ${name}`
          };
        });

      if (list.length === 0) {
        return res.json({ models: fallbackList });
      }
      res.json({ models: list });
    });
    return;
  } else if (provider === 'copilot') {
    // GitHub Copilot CLI does not expose a machine-readable models subcommand.
    // Return a curated static list that reflects the current Copilot model roster.
    const copilotModels = [
      { value: 'gpt-4o',             label: 'GPT-4o',              desc: 'Fast flagship model — strong coding and debugging' },
      { value: 'gpt-4.1',            label: 'GPT-4.1',             desc: 'Latest GPT-4 with improved instruction following' },
      { value: 'claude-opus-4-5',    label: 'Claude Opus 4.5',     desc: 'Anthropic — highest quality, complex tasks' },
      { value: 'claude-sonnet-4-5',  label: 'Claude Sonnet 4.5',   desc: 'Anthropic — balanced speed and intelligence' },
      { value: 'claude-haiku-3-5',   label: 'Claude Haiku 3.5',    desc: 'Anthropic — fastest, great for quick patches' },
      { value: 'gemini-2.0-flash',   label: 'Gemini 2.0 Flash',    desc: 'Google — fast multimodal model' },
      { value: 'o3',                  label: 'o3',                  desc: 'OpenAI reasoning model — complex problem solving' },
      { value: 'o4-mini',            label: 'o4-mini',              desc: 'OpenAI lightweight reasoning model' },
    ];
    return res.json({ models: copilotModels });
  } else if (provider === 'codex') {
    const cliPath = process.env.CODEX_CLI_PATH || 'D:\\npm-global\\codex.cmd';
    const fallbackList = [
      { value: 'gpt-5.5',   label: 'GPT-5.5',      desc: 'Strongest agentic coding model' },
      { value: 'gpt-5.4',   label: 'GPT-5.4',       desc: 'Strong model for everyday coding' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', desc: 'Small, fast, cost-efficient' },
    ];

    const parts = cliPath.trim().split(/\s+/);
    const cmd = parts[0];
    const baseArgs = parts.slice(1);
    // debug models outputs JSON with a "models" array
    const args = [...baseArgs, 'debug', 'models'];

    const cmdString = `"${cmd}" ${args.join(' ')}`;
    exec(cmdString, { timeout: 6000, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      if (err || !stdout) {
        console.error('[Host Daemon] Codex CLI query failed, using fallback list:', err?.message || stderr);
        return res.json({ models: fallbackList });
      }

      try {
        const data = JSON.parse(stdout);
        // The JSON has a top-level "models" array with slug, display_name, description, visibility
        const rawModels = data.models || [];
        const list = rawModels
          .filter(m => m.visibility === 'list' || !m.visibility) // skip hidden models
          .map(m => ({
            value: m.slug || m.value,
            label: m.display_name || m.label || m.slug,
            desc: m.description || `Codex model: ${m.slug}`
          }));

        if (list.length === 0) {
          return res.json({ models: fallbackList });
        }
        res.json({ models: list });
      } catch (parseErr) {
        console.error('[Host Daemon] Failed to parse Codex CLI output:', parseErr);
        res.json({ models: fallbackList });
      }
    });
    return;
  } else if (provider === 'devin') {
    models = [
      { value: 'devin-autonomous', label: 'Devin Autonomous Core', desc: 'Multi-agent system with sandbox execution' }
    ];
    return res.json({ models });
  } else if (provider === 'ollama') {
    // Query Ollama CLI dynamically on the host to see what models it actually has installed!
    exec('ollama list', (err, stdout, stderr) => {
      if (err) {
        console.error('Ollama CLI query failed, returning fallback list', err);
        return res.json({
          models: [{ value: 'llama3', label: 'Llama 3', desc: 'Local model fallback' }]
        });
      }
      const lines = stdout.split('\n').slice(1); // Skip header line
      const list = lines
        .map(line => line.trim().split(/\s+/)[0])
        .filter(Boolean)
        .map(name => ({
          value: name,
          label: name,
          desc: `Local Ollama model: ${name}`
        }));
      if (list.length === 0) {
        list.push({ value: 'llama3', label: 'Llama 3', desc: 'Local model fallback' });
      }
      res.json({ models: list });
    });
  } else {
    return res.json({
      models: [{ value: 'default', label: 'Default Model', desc: 'Provider default model' }]
    });
  }
});

// List workspaces (local subdirs + registered customs)
app.get('/api/workspaces', authenticate, async (req, res) => {
  try {
    const localWorkspaces = [];
    for (const root of WORKSPACES_ROOTS) {
      if (fs.existsSync(root)) {
        const items = await fs.promises.readdir(root, { withFileTypes: true });
        items
          .filter(item => item.isDirectory())
          .map(item => item.name)
          .filter(name => !['node_modules', '.git', 'host', 'client', '.agents', '.gemini'].includes(name) && !name.endsWith('.agent-backup'))
          .forEach(name => {
            if (!localWorkspaces.includes(name)) {
              localWorkspaces.push(name);
            }
          });
      }
    }
    
    const customs = getCustomWorkspaces();
    const allWorkspaces = Array.from(new Set([...localWorkspaces, ...Object.keys(customs)]));
    
    res.json({ workspaces: allWorkspaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register an existing directory as a workspace
app.post('/api/workspaces/register', authenticate, async (req, res) => {
  const { name, absolutePath } = req.body;
  if (!name || !absolutePath) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const resolvedPath = path.resolve(absolutePath);
    // Verify directory exists
    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Provided path is not a directory' });
    }

    const customs = getCustomWorkspaces();
    customs[name] = resolvedPath;
    saveCustomWorkspaces(customs);

    res.json({ status: 'success', workspace: name });
  } catch (err) {
    res.status(500).json({ error: `Directory validation failed: ${err.message}` });
  }
});

// Delete workspace
app.post('/api/workspaces/delete', authenticate, async (req, res) => {
  const { workspace, deleteFiles } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const customs = getCustomWorkspaces();
    let isCustom = false;
    let customPath = null;
    if (customs[workspace]) {
      isCustom = true;
      customPath = customs[workspace];
      delete customs[workspace];
      saveCustomWorkspaces(customs);
    }

    if (deleteFiles) {
      let wsPath = null;
      if (isCustom) {
        wsPath = customPath;
      } else {
        for (const root of WORKSPACES_ROOTS) {
          const candidate = path.resolve(root, workspace);
          if (fs.existsSync(candidate)) {
            wsPath = candidate;
            break;
          }
        }
      }

      if (wsPath && fs.existsSync(wsPath)) {
        const resolvedPath = path.resolve(wsPath);
        const resolvedRoot = path.resolve(WORKSPACES_ROOT);
        const isSelfOrParent = resolvedRoot.startsWith(resolvedPath) || resolvedPath === '/' || resolvedPath === os.homedir();
        if (isSelfOrParent) {
          throw new Error('Access denied: Cannot delete system or root directories');
        }
        await fs.promises.rm(resolvedPath, { recursive: true, force: true });
      }
    }

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register service ports for a workspace (frontend + backend + backendPrefix)
app.post('/api/workspaces/register-service', authenticate, (req, res) => {
  const { workspace, frontend, backend, backendPrefix } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  const existing = workspaceServices.get(workspace) || { frontend: null, backend: null, backendPrefix: '/api' };
  const updated = {
    frontend: frontend !== undefined ? (frontend ? parseInt(frontend, 10) : null) : existing.frontend,
    backend:  backend  !== undefined ? (backend  ? parseInt(backend,  10) : null) : existing.backend,
    backendPrefix: backendPrefix || existing.backendPrefix || '/api',
  };
  workspaceServices.set(workspace, updated);
  console.log(`[Gateway] Registered services for ${workspace}:`, updated);
  const gwUrl = `/gateway/${encodeURIComponent(workspace)}/port/${updated.frontend || updated.backend || '3000'}/`;
  res.json({ status: 'ok', workspace, services: updated, gateway: gwUrl });
});

// Query workspace topology: detected stack + registered ports + gateway URL
app.get('/api/workspaces/topology', authenticate, async (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  let wsPath = '';
  const customs = getCustomWorkspaces();
  if (customs[workspace]) {
    wsPath = customs[workspace];
  } else {
    for (const root of WORKSPACES_ROOTS) {
      const checkPath = path.join(root, workspace);
      if (fs.existsSync(checkPath)) { wsPath = checkPath; break; }
    }
  }

  const stackInfo = wsPath ? await detectWorkspaceStack(wsPath) : { stack: [] };
  const registered = workspaceServices.get(workspace) || { frontend: null, backend: null, backendPrefix: '/api' };
  const frontendPort = registered.frontend || (registered.backend ? registered.backend : '3000');
  const gwUrl = `/gateway/${encodeURIComponent(workspace)}/port/${frontendPort}/`;

  res.json({
    workspace,
    wsPath: wsPath ? path.resolve(wsPath) : '',
    gateway: gwUrl,
    services: registered,
    stack: stackInfo.stack,
    hasFrontendDir: stackInfo.hasFrontendDir || false,
    hasBackendDir: stackInfo.hasBackendDir || false,
  });
});

// Detect the active port for a workspace by scanning processes
app.get('/api/workspaces/detect-port', authenticate, async (req, res) => {
  const { workspace } = req.query;
  if (!workspace) {
    return res.status(400).json({ error: 'Workspace is required' });
  }

  // Find the workspace path
  let wsPath = '';
  const customs = getCustomWorkspaces();
  if (customs[workspace]) {
    wsPath = customs[workspace];
  } else {
    for (const root of WORKSPACES_ROOTS) {
      const checkPath = path.join(root, workspace);
      if (fs.existsSync(checkPath)) {
        wsPath = checkPath;
        break;
      }
    }
  }

  if (!wsPath) {
    return res.json({ port: null });
  }

  const normalizedWsPath = wsPath.replace(/\\/g, '/').toLowerCase();

  try {
    if (process.platform === 'win32') {
      const cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | ForEach-Object { $proc = Get-CimInstance Win32_Process -Filter \\"ProcessId = $($_.OwningProcess)\\" -ErrorAction SilentlyContinue; if ($proc) { [PSCustomObject]@{ Port = $_.LocalPort; Path = $proc.ExecutablePath; Cmd = $proc.CommandLine } } } | ConvertTo-Json"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('Error detecting port:', error);
          return res.json({ port: null });
        }
        try {
          let processes = JSON.parse(stdout);
          if (!Array.isArray(processes)) {
            processes = processes ? [processes] : [];
          }
          
          const matches = processes.filter(p => {
            const pathMatch = p.Path && p.Path.replace(/\\/g, '/').toLowerCase().includes(normalizedWsPath);
            const cmdMatch = p.Cmd && p.Cmd.replace(/\\/g, '/').toLowerCase().includes(normalizedWsPath);
            return (pathMatch || cmdMatch) && Number(p.Port) !== Number(PORT);
          });

          if (matches.length > 0) {
            matches.sort((a, b) => a.Port - b.Port);
            const detectedPorts = matches.map(m => Number(m.Port));

            // Auto-register ports into the gateway service registry
            // Heuristic: ports < 6000 are usually frontend (3000, 5173)
            //            ports >= 6000 are usually backend (8000, 8080, etc.)
            const existing = workspaceServices.get(workspace) || {};
            if (!existing.frontend && detectedPorts.length >= 1) {
              const frontendCandidates = detectedPorts.filter(p => p < 6000);
              const backendCandidates  = detectedPorts.filter(p => p >= 6000);
              const newSvc = {
                frontend: frontendCandidates[0] || detectedPorts[0],
                backend:  backendCandidates[0]  || (detectedPorts.length > 1 ? detectedPorts[1] : null),
                backendPrefix: existing.backendPrefix || '/api',
              };
              workspaceServices.set(workspace, newSvc);
              console.log(`[Gateway] Auto-registered ports for ${workspace}:`, newSvc);
            }

            const topology = workspaceServices.get(workspace) || null;
            const gateway  = topology ? `/gateway/${encodeURIComponent(workspace)}/port/${topology.frontend || '3000'}/` : null;
            return res.json({ port: detectedPorts[0], ports: detectedPorts, topology, gateway });
          }
        } catch (e) {
          console.error('Error parsing process JSON:', e);
        }
        res.json({ port: null, ports: [], topology: null, gateway: null });
      });
    } else {
      res.json({ port: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GitHub repos list
app.get('/api/github/repos', authenticate, async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  const username = process.env.GITHUB_USERNAME;
  if (!token || !username) return res.status(400).json({ error: 'GITHUB_TOKEN and GITHUB_USERNAME not configured in .env' });

  try {
    const { default: https } = await import('https');
    const fetchPage = (page) => new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member&visibility=all`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Antigravity-Portable',
          'Accept': 'application/vnd.github+json',
        }
      };
      https.get(options, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Failed to parse GitHub response')); }
        });
      }).on('error', reject);
    });

    // Fetch up to 3 pages (300 repos)
    let allRepos = [];
    for (let page = 1; page <= 3; page++) {
      const page_data = await fetchPage(page);
      if (!Array.isArray(page_data)) {
        // GitHub returned an error object
        const msg = page_data.message || JSON.stringify(page_data);
        return res.status(401).json({ error: `GitHub API error: ${msg}` });
      }
      allRepos = allRepos.concat(page_data);
      if (page_data.length < 100) break;
    }

    // Get list of already-cloned workspaces
    const clonedNames = new Set();
    for (const root of WORKSPACES_ROOTS) {
      if (fs.existsSync(root)) {
        const items = fs.readdirSync(root, { withFileTypes: true });
        items.filter(i => i.isDirectory()).forEach(i => clonedNames.add(i.name));
      }
    }
    const customs = getCustomWorkspaces();
    Object.keys(customs).forEach(k => clonedNames.add(k));

    const repos = allRepos.map(r => ({
      name: r.name,
      fullName: r.full_name,
      description: r.description || '',
      private: r.private,
      language: r.language || '',
      pushedAt: r.pushed_at,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      cloned: clonedNames.has(r.name),
    }));

    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clone a repository
app.post('/api/workspaces/clone', authenticate, (req, res) => {
  const { repoUrl, folderName } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'Missing repoUrl' });
  
  const targetName = folderName || repoUrl.split('/').pop().replace('.git', '');
  const targetPath = path.join(WORKSPACES_ROOT, targetName);

  const git = spawn('git', ['clone', repoUrl, targetPath]);
  let errorMsg = '';

  git.stderr.on('data', (data) => {
    errorMsg += data.toString();
  });

  git.on('close', (code) => {
    if (code === 0) {
      res.json({ status: 'success', workspace: targetName });
    } else {
      res.status(500).json({ error: `Clone failed with code ${code}. ${errorMsg}` });
    }
  });
});

// Create new empty project
app.post('/api/workspaces/create', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const targetPath = path.join(WORKSPACES_ROOT, name);
  try {
    await fs.promises.mkdir(targetPath, { recursive: true });
    const git = spawn('git', ['init'], { cwd: targetPath });
    git.on('close', async () => {
      // Create a dummy readme
      await fs.promises.writeFile(path.join(targetPath, 'README.md'), `# ${name}\nCreated via Portable Dev Environment.`);
      res.json({ status: 'success', workspace: name });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kill ports occupied by workspace services
app.post('/api/workspaces/kill-ports', authenticate, async (req, res) => {
  const { workspace, ports } = req.body;
  if (!ports || !Array.isArray(ports)) {
    return res.status(400).json({ error: 'Missing ports array' });
  }

  const results = [];
  for (const portStr of ports) {
    const port = parseInt(portStr, 10);
    if (!port || port < 1024 || port > 65535) continue;

    try {
      if (process.platform === 'win32') {
        const stdout = execSync(`netstat -ano`).toString();
        const lines = stdout.split('\n');
        const pids = new Set();
        for (const line of lines) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && !isNaN(pid) && pid !== '0') {
              pids.add(parseInt(pid, 10));
            }
          }
        }
        for (const pid of pids) {
          console.log(`[Host Daemon] Killing PID ${pid} holding port ${port}...`);
          try {
            execSync(`taskkill /F /PID ${pid}`);
          } catch (e) {}
        }
      } else {
        try {
          execSync(`lsof -t -i:${port} | xargs kill -9`);
        } catch (e) {}
      }
      results.push({ port, status: 'freed' });
    } catch (err) {
      results.push({ port, status: 'error', error: err.message });
    }
  }

  res.json({ status: 'success', results });
});

// File tree list
app.get('/api/files/tree', authenticate, async (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const rootPath = resolveWorkspacePath(workspace);
    const getTree = async (dirPath) => {
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const nodes = [];
      for (const item of items) {
        const itemPath = path.join(dirPath, item.name);
        const relativePath = path.relative(rootPath, itemPath).replace(/\\/g, '/');

        // Ignore heavy folders
        if (['node_modules', '.git', 'dist', '.next', 'build', '.gemini'].includes(item.name)) {
          continue;
        }

        if (item.isDirectory()) {
          nodes.push({
            name: item.name,
            path: relativePath,
            type: 'directory',
            children: await getTree(itemPath),
          });
        } else {
          nodes.push({
            name: item.name,
            path: relativePath,
            type: 'file',
          });
        }
      }
      // Sort directories first, then files
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    };

    const tree = await getTree(rootPath);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve workspace files as static assets for HTML preview ─────────────────
// GET /ws-static/<token>/<workspace>/<filepath>
app.get('/ws-static/:token/*', (req, res) => {
  if (req.params.token !== SECURITY_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  // req.params[0] = "workspace/path/to/file.html"
  const parts = req.params[0].split('/');
  const workspace = decodeURIComponent(parts[0]);
  const filePath = parts.slice(1).map(decodeURIComponent).join('/');

  let wsRoot;
  try {
    wsRoot = resolveWorkspacePath(workspace);
  } catch {
    return res.status(404).send('Workspace not found');
  }

  const absPath = path.join(wsRoot, filePath);
  // Prevent path traversal
  if (!absPath.startsWith(wsRoot)) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(absPath, (err) => {
    if (err) res.status(404).send('File not found');
  });
});

// File content read
app.get('/api/files/content', authenticate, async (req, res) => {
  const { workspace, filePath } = req.query;
  if (!workspace || !filePath) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const absolutePath = resolveWorkspacePath(workspace, filePath);
    const stat = await fs.promises.stat(absolutePath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }
    const content = await fs.promises.readFile(absolutePath, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File save
app.post('/api/files/save', authenticate, async (req, res) => {
  const { workspace, filePath, content } = req.body;
  if (!workspace || !filePath || content === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const absolutePath = resolveWorkspacePath(workspace, filePath);
    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    
    // Ensure trailing newline
    let finalContent = content;
    if (content.length > 0 && !content.endsWith('\n')) {
      finalContent = content + '\n';
    }
    
    await fs.promises.writeFile(absolutePath, finalContent, 'utf8');

    // Run syntax checker
    const ext = path.extname(absolutePath).toLowerCase();
    const problems = [];
    if (ext === '.py') {
      exec(`python -m py_compile "${absolutePath}"`, (err, stdout, stderr) => {
        const output = stderr || stdout;
        if (err && output) {
          const lineMatch = output.match(/line\s+(\d+)/i);
          const msgLines = output.split('\n').map(l => l.trim()).filter(Boolean);
          const errorMsg = msgLines[msgLines.length - 1] || 'Python syntax error';
          const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
          problems.push({
            id: `python-syntax-${filePath}-${line}-${Date.now()}`,
            file: filePath,
            fileBasename: path.basename(filePath),
            line,
            column: 1,
            type: 'error',
            msg: errorMsg,
            rawLine: output
          });
        }
        res.json({ status: 'success', problems });
      });
    } else if (ext === '.js' || ext === '.jsx') {
      exec(`node --check "${absolutePath}"`, (err, stdout, stderr) => {
        const output = stderr || stdout;
        if (err && output) {
          const lineMatch = output.match(/:(\d+)\r?\n/);
          const firstLine = output.split('\n')[0] || '';
          const errorMsg = output.split('\n').find(l => l.includes('SyntaxError') || l.includes('ReferenceError') || l.includes('Error')) || firstLine || 'JS syntax error';
          const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
          problems.push({
            id: `node-syntax-${filePath}-${line}-${Date.now()}`,
            file: filePath,
            fileBasename: path.basename(filePath),
            line,
            column: 1,
            type: 'error',
            msg: errorMsg.trim(),
            rawLine: output
          });
        }
        res.json({ status: 'success', problems });
      });
    } else {
      res.json({ status: 'success', problems });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File global grep search
app.get('/api/files/search', authenticate, async (req, res) => {
  const { workspace, query } = req.query;
  if (!workspace || !query) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const rootPath = resolveWorkspacePath(workspace);
    
    // We can use a simple node script to search files recursively
    // For large folders we ignore node_modules and .git
    const results = [];
    const searchDir = async (dirPath) => {
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const item of items) {
        const itemPath = path.join(dirPath, item.name);
        if (['node_modules', '.git', 'dist', '.next', 'build', '.gemini'].includes(item.name)) continue;

        if (item.isDirectory()) {
          await searchDir(itemPath);
        } else {
          try {
            const content = await fs.promises.readFile(itemPath, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
              if (line.toLowerCase().includes(query.toLowerCase())) {
                results.push({
                  path: path.relative(rootPath, itemPath).replace(/\\/g, '/'),
                  line: index + 1,
                  content: line.trim(),
                });
              }
            });
          } catch (_) {
            // Ignore binary files or read errors
          }
        }
      }
    };

    await searchDir(rootPath);
    res.json({ results: results.slice(0, 100) }); // Limit to 100 results
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git status
app.get('/api/git/status', authenticate, (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['status', '--porcelain'], { cwd });
    let stdout = '';
    let stderr = '';
    git.stdout.on('data', (data) => stdout += data.toString());
    git.stderr.on('data', (data) => stderr += data.toString());
    git.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: stderr.trim() || 'Failed to read git status (not a git repository?)' });
      }
      const files = stdout.split('\n').filter(line => line.trim()).map(line => {
        const code = line.slice(0, 2);
        const filePath = line.slice(3).trim();
        return { code, path: filePath };
      });
      res.json({ files });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent backup / restore / diff ────────────────────────────────────────────
const BACKUP_SUFFIX = '.agent-backup';

app.post('/api/agent/backup', authenticate, async (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const backupRoot = wsRoot + BACKUP_SUFFIX;
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
    await fs.promises.cp(wsRoot, backupRoot, {
      recursive: true,
      filter: (src) => !src.includes('.git') && !src.includes('node_modules') && !src.includes(BACKUP_SUFFIX),
    });
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/restore', authenticate, async (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const backupRoot = wsRoot + BACKUP_SUFFIX;
    if (!fs.existsSync(backupRoot)) return res.status(404).json({ error: 'No backup found' });

    // Instead of deleting the workspace (causes EBUSY on Windows),
    // walk the backup and overwrite files one by one, then delete extras
    const restoreDir = async (srcDir, destDir) => {
      const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
      await fs.promises.mkdir(destDir, { recursive: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          await restoreDir(src, dest);
        } else {
          await fs.promises.copyFile(src, dest);
        }
      }
      // Remove files in dest that don't exist in src (excluding .git/node_modules)
      const destEntries = await fs.promises.readdir(destDir, { withFileTypes: true });
      const srcNames = new Set(entries.map(e => e.name));
      for (const de of destEntries) {
        if (de.name === '.git' || de.name === 'node_modules') continue;
        if (!srcNames.has(de.name)) {
          const target = path.join(destDir, de.name);
          await fs.promises.rm(target, { recursive: true, force: true });
        }
      }
    };

    await restoreDir(backupRoot, wsRoot);
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/accept', authenticate, async (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const backupRoot = wsRoot + BACKUP_SUFFIX;
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compare workspace to backup and return list of changed files
app.get('/api/agent/diff', authenticate, async (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  try {
    const wsRoot = resolveWorkspacePath(workspace);
    const backupRoot = wsRoot + BACKUP_SUFFIX;
    if (!fs.existsSync(backupRoot)) return res.json({ files: [] });

    const changed = [];

    const TEXT_EXTS = new Set(['.html','.htm','.css','.js','.ts','.jsx','.tsx','.json','.md','.txt','.xml','.svg','.yml','.yaml','.env','.sh','.py','.rb','.php','.java','.c','.cpp','.h','.cs','.go','.rs','.vue','.astro','.toml','.ini','.cfg']);

    const walk = async (relPath) => {
      const curPath = path.join(wsRoot, relPath);
      const bakPath = path.join(backupRoot, relPath);
      const stat = await fs.promises.stat(curPath).catch(() => null);
      if (!stat) return;
      if (stat.isDirectory()) {
        const name = path.basename(curPath);
        if (name === '.git' || name === 'node_modules') return;
        const entries = await fs.promises.readdir(curPath);
        for (const e of entries) await walk(relPath ? relPath + '/' + e : e);
      } else {
        const ext = path.extname(curPath).toLowerCase();
        if (!TEXT_EXTS.has(ext)) return; // skip binary files
        const curContent = await fs.promises.readFile(curPath, 'utf8').catch(() => '');
        const bakContent = await fs.promises.readFile(bakPath, 'utf8').catch(() => '');
        if (curContent !== bakContent) {
          const curLines = curContent.split('\n').length;
          const bakLines = bakContent.split('\n').length;
          changed.push({
            path: relPath,
            additions: Math.max(0, curLines - bakLines),
            deletions: Math.max(0, bakLines - curLines),
          });
        }
      }
    };

    await walk('');
    res.json({ files: changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git status with additions/deletions diff summary
app.get('/api/git/status-diff', authenticate, async (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    
    // 1. Get git status
    exec('git status --porcelain', { cwd }, async (err, stdoutStatus) => {
      if (err) {
        return res.json({ files: [] });
      }

      const statusLines = stdoutStatus.split('\n').filter(line => line.trim());
      const files = statusLines.map(line => {
        const code = line.slice(0, 2);
        const filePath = line.slice(3).trim();
        return {
          code,
          path: filePath,
          additions: 0,
          deletions: 0
        };
      });

      if (files.length === 0) {
        return res.json({ files: [] });
      }

      // 2. Get git diff --numstat for tracked unstaged changes
      exec('git diff --numstat', { cwd }, async (errDiff, stdoutNumstat) => {
        const diffMap = new Map();
        if (!errDiff && stdoutNumstat) {
          stdoutNumstat.split('\n').filter(Boolean).forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              const additions = parseInt(parts[0], 10) || 0;
              const deletions = parseInt(parts[1], 10) || 0;
              const filePath = parts[2];
              diffMap.set(filePath, { additions, deletions });
            }
          });
        }

        // 3. Get git diff --cached --numstat for staged changes
        exec('git diff --cached --numstat', { cwd }, async (errCached, stdoutCached) => {
          const cachedMap = new Map();
          if (!errCached && stdoutCached) {
            stdoutCached.split('\n').filter(Boolean).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 3) {
                const additions = parseInt(parts[0], 10) || 0;
                const deletions = parseInt(parts[1], 10) || 0;
                const filePath = parts[2];
                cachedMap.set(filePath, { additions, deletions });
              }
            });
          }

          // 4. Resolve details for each file
          for (const file of files) {
            const key = file.path;
            
            // Merge unstaged and staged diff stats
            const unstaged = diffMap.get(key) || { additions: 0, deletions: 0 };
            const staged = cachedMap.get(key) || { additions: 0, deletions: 0 };
            
            file.additions = unstaged.additions + staged.additions;
            file.deletions = unstaged.deletions + staged.deletions;

            // If it is untracked and has no diff stats, count its lines as additions
            if (file.code.includes('?') && file.additions === 0 && file.deletions === 0) {
              try {
                const fullPath = path.join(cwd, file.path);
                const content = await fs.promises.readFile(fullPath, 'utf8');
                // count lines, handle empty files
                file.additions = content ? content.split('\n').length : 0;
                file.deletions = 0;
              } catch (_) {
                file.additions = 0;
                file.deletions = 0;
              }
            }
          }

          res.json({ files });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git diff
app.get('/api/git/diff', authenticate, (req, res) => {
  const { workspace, filePath } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const args = ['diff'];
    if (filePath) args.push(filePath);
    
    const git = spawn('git', args, { cwd });
    let stdout = '';
    git.stdout.on('data', (data) => stdout += data.toString());
    git.on('close', () => {
      res.json({ diff: stdout });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git commit & push
app.post('/api/git/commit', authenticate, (req, res) => {
  const { workspace, message, files } = req.body;
  if (!workspace || !message) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    
    // Step 1: Check if remote exists before attempting push
    const gitRemote = spawn('git', ['remote', '-v'], { cwd });
    let remoteOutput = '';
    gitRemote.stdout.on('data', (data) => remoteOutput += data.toString());
    
    gitRemote.on('close', (remoteCode) => {
      const hasRemote = remoteOutput.trim().length > 0;
      
      // Step 2: Add files
      const addArgs = files && files.length > 0 ? ['add', ...files] : ['add', '.'];
      const gitAdd = spawn('git', addArgs, { cwd });
      
      gitAdd.on('close', (addCode) => {
        if (addCode !== 0) return res.status(500).json({ error: 'Git add failed' });
        
        // Step 3: Commit
        const gitCommit = spawn('git', ['commit', '-m', message], { cwd });
        
        gitCommit.on('close', (commitCode) => {
          // If git commit fails (e.g. nothing to commit), we still try to push or return success
          if (!hasRemote) {
            // No remote configured - commit succeeded but can't push
            return res.json({ status: 'success', log: 'Committed successfully (no remote configured - use "git remote add" to enable pushing)' });
          }
          
          // Step 4: Push
          const gitPush = spawn('git', ['push'], { cwd });
          let pushStderr = '';
          gitPush.stderr.on('data', (data) => pushStderr += data.toString());
          
          gitPush.on('close', (pushCode) => {
            if (pushCode === 0) {
              res.json({ status: 'success', log: 'Committed and pushed successfully' });
            } else {
              res.status(500).json({ error: `Push failed: ${pushStderr}` });
            }
          });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git pull
app.post('/api/git/pull', authenticate, (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['pull'], { cwd });
    let stdout = '';
    let stderr = '';
    git.stdout.on('data', (data) => stdout += data.toString());
    git.stderr.on('data', (data) => stderr += data.toString());
    git.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success', output: stdout });
      } else {
        res.status(500).json({ error: `Pull failed: ${stderr || stdout}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File or Directory delete
app.delete('/api/files/delete', authenticate, async (req, res) => {
  const { workspace, filePath } = req.body;
  if (!workspace || !filePath) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const absolutePath = resolveWorkspacePath(workspace, filePath);
    const stat = await fs.promises.stat(absolutePath);
    if (stat.isDirectory()) {
      await fs.promises.rm(absolutePath, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(absolutePath);
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new directory
app.post('/api/files/mkdir', authenticate, async (req, res) => {
  const { workspace, dirPath } = req.body;
  if (!workspace || !dirPath) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const absolutePath = resolveWorkspacePath(workspace, dirPath);
    await fs.promises.mkdir(absolutePath, { recursive: true });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git discard changes in a file (reject file edits)
app.post('/api/git/discard', authenticate, (req, res) => {
  const { workspace, filePath } = req.body;
  if (!workspace || !filePath) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['checkout', '--', filePath], { cwd });
    
    git.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success' });
      } else {
        const gitRestore = spawn('git', ['restore', filePath], { cwd });
        gitRestore.on('close', (restoreCode) => {
          if (restoreCode === 0) {
            res.json({ status: 'success' });
          } else {
            res.status(500).json({ error: 'Failed to discard changes' });
          }
        });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git discard all unstaged/staged modifications (reject all edits)
app.post('/api/git/discard-all', authenticate, (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const gitReset = spawn('git', ['reset', '--hard'], { cwd });
    gitReset.on('close', (resetCode) => {
      const gitClean = spawn('git', ['clean', '-fd'], { cwd });
      gitClean.on('close', (cleanCode) => {
        if (resetCode === 0 && cleanCode === 0) {
          res.json({ status: 'success' });
        } else {
          res.status(500).json({ error: 'Discard all failed' });
        }
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git init
app.post('/api/git/init', authenticate, (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['init'], { cwd });
    let stderr = '';
    git.stderr.on('data', (d) => stderr += d.toString());
    git.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success', log: 'Initialized empty Git repository' });
      } else {
        res.status(500).json({ error: `Git init failed: ${stderr}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git GitHub Auth Helper
app.post('/api/git/github-auth', authenticate, (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  const username = process.env.GITHUB_USERNAME;
  const token = process.env.GITHUB_TOKEN;
  if (!username || !token) {
    return res.status(400).json({ error: 'GITHUB_USERNAME and GITHUB_TOKEN are not configured in .env' });
  }

  try {
    const cwd = resolveWorkspacePath(workspace);
    const gitRemote = spawn('git', ['remote', 'get-url', 'origin'], { cwd });
    let output = '';
    gitRemote.stdout.on('data', (d) => output += d.toString());
    gitRemote.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: 'Failed to retrieve git remote. Is this a git repository?' });
      }
      let url = output.trim();
      let repoPath = '';
      
      if (url.startsWith('git@github.com:')) {
        repoPath = url.replace('git@github.com:', '');
      } else if (url.startsWith('https://github.com/')) {
        repoPath = url.replace('https://github.com/', '');
      } else {
        const match = url.match(/github\.com[/:](.*)$/);
        if (match) {
          repoPath = match[1];
        }
      }

      if (!repoPath) {
        return res.status(400).json({ error: `Unsupported git remote URL format: ${url}` });
      }

      repoPath = repoPath.replace(/^[^/]+@/, '');

      const authUrl = `https://${username}:${token}@github.com/${repoPath}`;
      const gitSetUrl = spawn('git', ['remote', 'set-url', 'origin', authUrl], { cwd });
      gitSetUrl.on('close', (setCode) => {
        if (setCode === 0) {
          res.json({ status: 'success', authenticatedUrl: `https://github.com/${repoPath}`, log: 'GitHub credentials successfully linked to local repository.' });
        } else {
          res.status(500).json({ error: 'Failed to update remote URL.' });
        }
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git Add All (git add .)
app.post('/api/git/add-all', authenticate, (req, res) => {
  const { workspace } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const gitAdd = spawn('git', ['add', '.'], { cwd });
    gitAdd.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success', log: 'Staged all changes successfully (git add .)' });
      } else {
        res.status(500).json({ error: 'Failed to stage changes.' });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git list branches
app.get('/api/git/branches', authenticate, (req, res) => {
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['branch', '-a'], { cwd });
    let output = '';
    git.stdout.on('data', (d) => output += d.toString());
    git.on('close', (code) => {
      if (code !== 0) return res.status(500).json({ error: 'Failed to list branches' });
      const lines = output.split('\n');
      const branchMap = new Map();
      
      lines.forEach(line => {
        const isCurrent = line.startsWith('*');
        let rawName = line.replace(/^\*\s*/, '').trim();
        if (!rawName || rawName.includes('->')) return;
        
        // Strip remote prefix if present: remotes/origin/branch-name -> branch-name
        const cleanName = rawName.replace(/^remotes\/[^/]+\//, '');
        
        if (!branchMap.has(cleanName) || isCurrent) {
          branchMap.set(cleanName, { name: cleanName, isCurrent });
        }
      });
      
      const branches = Array.from(branchMap.values());
      res.json({ branches });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git push to specific branch
app.post('/api/git/push', authenticate, (req, res) => {
  const { workspace, branch } = req.body;
  if (!workspace) return res.status(400).json({ error: 'Missing workspace' });
  const targetBranch = branch || 'main';

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['push', 'origin', targetBranch], { cwd });
    let stderr = '';
    git.stderr.on('data', (d) => stderr += d.toString());
    git.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success', log: `Pushed successfully to branch: ${targetBranch}` });
      } else {
        res.status(500).json({ error: `Push failed: ${stderr}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git checkout branch
app.post('/api/git/checkout', authenticate, (req, res) => {
  const { workspace, branch } = req.body;
  if (!workspace || !branch) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const cwd = resolveWorkspacePath(workspace);
    const git = spawn('git', ['checkout', branch], { cwd });
    let stderr = '';
    git.stderr.on('data', (d) => stderr += d.toString());
    git.on('close', (code) => {
      if (code === 0) {
        res.json({ status: 'success', log: `Checked out to branch: ${branch}` });
      } else {
        res.status(500).json({ error: `Checkout failed: ${stderr}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate /preview/:port/* route removed — primary handler above covers all cases.

// --- Fallback Referer-based Proxy ---
// Catch requests that don't match any route above but were initiated by a proxied page.
app.all('*', (req, res, next) => {
  const referer = req.headers.referer;
  let port = null;
  let workspaceName = null;

  let isPreviewMode = false;
  if (referer) {
    const previewMatch = referer.match(/\/preview\/(\d+)/);
    const gatewayMatch = referer.match(/\/gateway\/([^/]+)\/port\/(\d+)/);
    if (previewMatch) {
      port = parseInt(previewMatch[1], 10);
      isPreviewMode = true;
    } else if (gatewayMatch) {
      workspaceName = decodeURIComponent(gatewayMatch[1]);
      port = parseInt(gatewayMatch[2], 10);
    }
  }

  // Fallback: if no port detected from Referer, check lastActiveGatewayPort
  if (!port && lastActiveGatewayPort) {
    port = lastActiveGatewayPort;
  }

  // Lookup workspace name if not found but port is known
  if (!workspaceName && port) {
    for (const [wsName, svcs] of workspaceServices.entries()) {
      if (svcs.frontend === port || svcs.backend === port) {
        workspaceName = wsName;
        break;
      }
    }
  }

  if (port) {
    // Verify token via cookie or referer parameter
    let cookieToken = null;
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
        const [k, v] = c.trim().split('=');
        acc[k] = v;
        return acc;
      }, {});
      cookieToken = cookies['portable_token'];
    }
    
    let refererToken = null;
    try {
      if (referer) {
        const refUrl = new URL(referer);
        refererToken = refUrl.searchParams.get('token');
      }
    } catch (e) {}

    const isAuthed = (cookieToken === SECURITY_TOKEN || refererToken === SECURITY_TOKEN);
    const isFromPreview = referer && (referer.includes('/preview/') || referer.includes('/gateway/'));

    if (isAuthed || isFromPreview) {
      // Reconstruct target path with basePath if Next.js config contains it
      let targetPath = req.url;
      if (workspaceName) {
        try {
          const wsRoot = resolveWorkspacePath(workspaceName);
          const configFile = ['next.config.mjs','next.config.js','next.config.ts','next.config.cjs']
            .find(f => fs.existsSync(path.join(wsRoot, f)));
          const hasBasePath = configFile
            && /basePath\s*:/.test(fs.readFileSync(path.join(wsRoot, configFile), 'utf8'));
          
          // Redirect page navigation requests to keep them inside the gateway/preview prefix
          const isHtmlRequest = req.headers.accept && req.headers.accept.includes('text/html');
          const isAlreadyPrefixed = req.url.startsWith('/gateway/') || req.url.startsWith('/preview/');
          if (isHtmlRequest && !isAlreadyPrefixed) {
            let targetUrl;
            if (isPreviewMode) {
              targetUrl = `/preview/${port}${req.url}`;
            } else {
              targetUrl = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}${req.url}`;
            }
            console.log(`[Gateway Redirect] Redirecting HTML navigation: ${req.url} → ${targetUrl}`);
            return res.redirect(302, targetUrl);
          }

          if (hasBasePath) {
            targetPath = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}${req.url}`;
          }
        } catch (e) {}
      }

      // Proxy request to localhost:port
      const options = {
        hostname: 'localhost',
        port,
        path: targetPath,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${port}`,
        },
      };
      
      delete options.headers['authorization'];

      const proxyReq = http.request(options, (proxyRes) => {
        const outHeaders = { ...proxyRes.headers };
        outHeaders['access-control-allow-origin'] = req.headers['origin'] || '*';
        if (req.headers['origin']) {
          outHeaders['access-control-allow-credentials'] = 'true';
          outHeaders['vary'] = (outHeaders['vary'] ? outHeaders['vary'] + ', ' : '') + 'Origin';
        }
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).send(`Fallback Proxy Error: ${err.message}`);
        }
      });

      forwardRequestBody(req, proxyReq);
      return;
    }
  }
  next();
});

// --- WebSockets for Terminals and Agents ---
const terminals = new Map(); // stores PTY / spawn objects
const terminalBuffers = new Map(); // stores buffered output to catch up client

// Keepalive: ping all clients every 30s to prevent Cloudflare 100s timeout
const keepAliveInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.ping();
    }
  });
}, 30000);

wss.on('close', () => clearInterval(keepAliveInterval));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const pathname = url.pathname;

  // ── Gateway WebSocket proxy (/gateway/:workspace/__ws/:port/*) ──────────
  // The patcher script rewrites ws://localhost:PORT to this path.
  const gatewayWsMatch = pathname.match(/^\/gateway\/([^/]+)\/__ws\/(\d+)(\/.*)?$/);
  if (gatewayWsMatch) {
    const workspaceName = decodeURIComponent(gatewayWsMatch[1]);
    const port = parseInt(gatewayWsMatch[2], 10);
    let subPath = gatewayWsMatch[3] || '/';
    // Strip any gateway prefix from subPath to prevent duplication
    const gatewayPrefix = `/gateway/${workspaceName}/port/${port}`;
    if (subPath.startsWith(gatewayPrefix)) {
      subPath = subPath.substring(gatewayPrefix.length) || '/';
    }

    // Prepend basePath if Next.js config contains it
    let finalPath = subPath;
    try {
      const wsRoot = resolveWorkspacePath(workspaceName);
      const configFile = ['next.config.mjs','next.config.js','next.config.ts','next.config.cjs']
        .find(f => fs.existsSync(path.join(wsRoot, f)));
      const hasBasePath = configFile
        && /basePath\s*:/.test(fs.readFileSync(path.join(wsRoot, configFile), 'utf8'));
      if (hasBasePath) {
        finalPath = `/gateway/${encodeURIComponent(workspaceName)}/port/${port}${subPath}`;
      }
    } catch (e) {
      // fallback to original subPath
    }

    // Append original search parameters (HMR client ID, etc.)
    finalPath += url.search || '';

    console.log(`[Gateway WS] ${workspaceName} → localhost:${port}${finalPath}`);

    let cookieToken = null;
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
        const [k, v] = c.trim().split('='); acc[k] = v; return acc;
      }, {});
      cookieToken = cookies['portable_token'];
    }
    const authorized = token === SECURITY_TOKEN || cookieToken === SECURITY_TOKEN;
    // For __ws (HMR proxying), also allow same-origin requests with no explicit auth
    // since the browser already authenticated when loading the page
    const isSameOrigin = !req.headers['origin'] || req.headers['origin'].includes(req.headers['host']);
    if (!authorized && !isSameOrigin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    // Forward the full WS handshake headers to the upstream dev server
    const forwardHeaders = [
      `GET ${finalPath} HTTP/1.1`,
      `Host: localhost:${port}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
      `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`,
    ];
    if (req.headers['sec-websocket-protocol']) {
      forwardHeaders.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
    }
    if (req.headers['sec-websocket-extensions']) {
      forwardHeaders.push(`Sec-WebSocket-Extensions: ${req.headers['sec-websocket-extensions']}`);
    }
    forwardHeaders.push('', '');

    const upstream = net.connect(port, 'localhost', () => {
      upstream.write(forwardHeaders.join('\r\n'));
      console.log(`[Gateway WS] Connected to localhost:${port}`);
    });
    upstream.on('error', (err) => { 
      console.error(`[Gateway WS] Upstream error: ${err.message}`);
      socket.destroy(); 
    });
    socket.on('error', (err) => { 
      console.error(`[Gateway WS] Socket error: ${err.message}`);
      upstream.destroy(); 
    });
    upstream.pipe(socket);
    socket.pipe(upstream);
    return;
  }

  // ── Preview port WebSocket proxy (/preview/:port/...) ───────────────────
  // Matches: /preview/:port/... OR any WS upgrade from a page whose cookie is set
  const previewMatch = pathname.match(/^\/preview\/(\d+)(\/.*)?$/);
  if (previewMatch) {
    const port = parseInt(previewMatch[1], 10);
    const subPath = previewMatch[2] || '/';
    const searchString = url.search || '';

    // Auth: token in query OR cookie
    let cookieToken = null;
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
        const [k, v] = c.trim().split('=');
        acc[k] = v;
        return acc;
      }, {});
      cookieToken = cookies['portable_token'];
    }
    const authorized = token === SECURITY_TOKEN || cookieToken === SECURITY_TOKEN;
    if (!authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Pipe the WebSocket upgrade through to the local dev server
    const upstream = net.connect(port, 'localhost', () => {
      upstream.write(
        `GET ${subPath}${searchString} HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
        (req.headers['sec-websocket-protocol'] ? `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}\r\n` : '') +
        `\r\n`
      );
    });

    upstream.on('error', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      upstream.destroy();
    });

    upstream.pipe(socket);
    socket.pipe(upstream);
    return;
  }

  // Also proxy WS upgrades that don't match /preview/:port but come from a preview page
  // (e.g. Vite connecting to ws://tunnel.domain.com/ without /preview/ prefix)
  let cookieToken = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {});
    cookieToken = cookies['portable_token'];
  }

  // Check if this WS comes from a preview/gateway-authenticated session (for HMR root-path fallback)
  const referer = req.headers['referer'] || req.headers['origin'] || '';
  const refPreviewMatch = referer.match(/\/preview\/(\d+)/);
  const refGatewayMatch = referer.match(/\/gateway\/([^/]+)\/port\/(\d+)/);

  let port = null;
  if (refPreviewMatch) {
    port = parseInt(refPreviewMatch[1], 10);
  } else if (refGatewayMatch) {
    port = parseInt(refGatewayMatch[2], 10);
  }

  if (port && (cookieToken === SECURITY_TOKEN)) {
    // Proxy this WS to the detected preview port
    const upstream = net.connect(port, 'localhost', () => {
      upstream.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
        (req.headers['sec-websocket-protocol'] ? `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}\r\n` : '') +
        `\r\n`
      );
    });

    upstream.on('error', () => { socket.destroy(); });
    socket.on('error', () => { upstream.destroy(); });
    upstream.pipe(socket);
    socket.pipe(upstream);
    return;
  }

  // ── Our own terminal/agent WebSockets ────────────────────────────────────
  if (token !== SECURITY_TOKEN && cookieToken !== SECURITY_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Pattern matching: /ws/terminal/:id
  const termMatch = pathname.match(/^\/ws\/terminal\/([a-zA-Z0-9_-]+)$/);
  if (termMatch) {
    const termId = termMatch[1];
    const workspace = url.searchParams.get('workspace');

    if (!workspace) {
      ws.send(JSON.stringify({ type: 'error', data: 'Missing workspace parameter' }));
      ws.close();
      return;
    }

    // Key is compound: termId + workspace so each workspace gets its own persistent shell.
    // Switching workspaces spawns a fresh shell in the correct cwd instead of reusing
    // the old shell from the previous workspace (which caused the green-cursor-only bug).
    const termKey = `${termId}:${workspace}`;

    let proc = terminals.get(termKey);

    // If terminal process doesn't exist for this workspace, spawn it
    if (!proc) {
      let cwd;
      try {
        cwd = resolveWorkspacePath(workspace);
      } catch (err) {
        console.error(`[Host Daemon] Terminal workspace resolution failed: ${err.message}`);
        ws.send(JSON.stringify({ type: 'error', data: `Workspace not found: ${workspace}\r\n${err.message}` }));
        ws.close();
        return;
      }
      const isWindows = process.platform === 'win32';
      // Prefer bash over sh on Linux for a proper interactive prompt
      let shellCmd = isWindows ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh');
      if (isWindows) {
        const winDir = process.env.SystemRoot || 'C:\\Windows';
        const standardPs = path.join(winDir, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        if (fs.existsSync(standardPs)) {
          shellCmd = standardPs;
        }
      }
      const shellArgs = isWindows ? ['-NoLogo', '-ExecutionPolicy', 'Bypass'] : ['-l'];

      try {
        console.log(`[Host Daemon] Spawning PTY terminal: ${shellCmd} cwd=${cwd}`);
        const terminalEnv = { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' };
        delete terminalEnv.PORT;
        proc = pty.spawn(shellCmd, shellArgs, {
          name: 'xterm-256color',
          cols: 220,
          rows: 24,
          cwd,
          env: terminalEnv,
        });

        terminals.set(termKey, proc);
        terminalBuffers.set(termKey, []);

        proc.onData((data) => {
          terminalBuffers.get(termKey).push(data);
          if (terminalBuffers.get(termKey).length > 200) {
            terminalBuffers.get(termKey).shift();
          }
          broadcastToTerminal(termKey, { type: 'data', data });
        });

        proc.onExit(({ exitCode }) => {
          broadcastToTerminal(termKey, { type: 'exit', code: exitCode });
          terminals.delete(termKey);
          terminalBuffers.delete(termKey);
        });

        proc.isPty = true;

        // Custom prompt: dynamic current directory — updates on cd
        // Linux: show last 2 path segments relative to workspace root (/Portfolio/subdir $)
        // Windows: show path relative to workspace root
        setTimeout(() => {
          if (isWindows) {
            proc.write(`function prompt { $rel = $PWD.Path -replace [regex]::Escape((Get-Location).Drive.Root), '/'; "PS $rel> " }; Clear-Host\r`);
          } else {
            proc.write(`export PS1='\\[\\033[01;32m\\]\\w \\$\\[\\033[00m\\] '; clear\r`);
          }
        }, 300);
      } catch (ptyError) {
        console.error('[Host Daemon] Failed to spawn PTY, falling back to child_process.spawn', ptyError);
        proc = spawn(shellCmd, shellArgs, {
          cwd,
          env: { ...process.env, FORCE_COLOR: '1' },
        });

        terminals.set(termKey, proc);
        terminalBuffers.set(termKey, []);

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          terminalBuffers.get(termKey).push(text);
          if (terminalBuffers.get(termKey).length > 200) {
            terminalBuffers.get(termKey).shift();
          }
          broadcastToTerminal(termKey, { type: 'data', data: text });
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          terminalBuffers.get(termKey).push(text);
          broadcastToTerminal(termKey, { type: 'data', data: text });
        });

        proc.on('close', () => {
          broadcastToTerminal(termKey, { type: 'exit', code: 0 });
          terminals.delete(termKey);
          terminalBuffers.delete(termKey);
        });

        proc.isPty = false;
      }
    }

    // Tag this WS client with the compound key so broadcastToTerminal reaches it
    ws.termId = termKey;

    // Send buffered catch-up text so reconnecting clients see previous output immediately
    const buffer = terminalBuffers.get(termKey) || [];
    if (buffer.length > 0) {
      ws.send(JSON.stringify({ type: 'data', data: buffer.join('') }));
    }

    ws.on('message', (msg) => {
      try {
        const payload = JSON.parse(msg.toString('utf8'));
        if (payload.type === 'input') {
          let inputData = payload.data;
          if (proc.isPty) {
            proc.write(inputData);
          } else {
            if (inputData === '\r') {
              inputData = process.platform === 'win32' ? '\r\n' : '\n';
            }
            proc.stdin.write(inputData);
          }
        } else if (payload.type === 'resize' && proc.isPty) {
          // Client sends actual XTerm dimensions after init so PTY wrapping matches
          const cols = Math.max(40, Math.min(500, parseInt(payload.cols, 10) || 220));
          const rows = Math.max(10, Math.min(100, parseInt(payload.rows, 10) || 24));
          try { proc.resize(cols, rows); } catch (_) {}
        }
      } catch (err) {
        // Raw input fallback
        const inputData = msg.toString('utf8');
        if (proc.isPty) {
          proc.write(inputData);
        } else {
          proc.stdin.write(inputData);
        }
      }
    });

    ws.on('close', () => {
      // We do NOT kill the terminal process here — persistent across reconnects.
      // The process stays alive, buffering output in terminalBuffers, ready for reconnect.
    });
  }

  // Pattern matching: /ws/agent
  if (pathname === '/ws/agent') {
    const workspace = url.searchParams.get('workspace');
    const provider = url.searchParams.get('provider') || 'antigravity';
    const model = url.searchParams.get('model') || 'gemini-1.5-pro';
    const prompt = url.searchParams.get('prompt');

    if (!workspace || !prompt) {
      ws.send(JSON.stringify({ type: 'error', data: 'Missing parameters' }));
      ws.close();
      return;
    }

    // Save prompt & model details to brain folder for active AI session reference
    const brainDir = process.env.BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
    try {
      if (fs.existsSync(brainDir)) {
        const reqPath = path.join(brainDir, 'agent_request.json');
        fs.writeFileSync(reqPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          provider,
          model,
          prompt,
          workspace
        }, null, 2), 'utf8');
        console.log(`[Host Daemon] Saved agent request to brain: ${reqPath}`);
      }
    } catch (err) {
      console.error('Failed to log agent request in brain', err);
    }

    let cwd;
    try {
      cwd = resolveWorkspacePath(workspace);
    } catch (err) {
      console.error(`[Host Daemon] Agent workspace resolution failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', data: err.message }));
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: 'status' + provider }));

    let cmd = provider;
    let args = [];
    
    if (provider === 'antigravity') {
      if (process.env.ANTIGRAVITY_CLI_PATH) {
        const parts = process.env.ANTIGRAVITY_CLI_PATH.trim().split(/\s+/);
        cmd = parts[0];
        const baseArgs = parts.slice(1);
        args = [...baseArgs, 'chat', '--profile', model, '--dangerously-skip-permissions', prompt];
      } else {
        cmd = 'agy';
        args = ['chat', '--profile', model, '--dangerously-skip-permissions', prompt];
      }
    } else if (provider === 'copilot') {
      // GitHub Copilot CLI (v1.2.0): suggest subcommand for shell command suggestions
      if (process.env.COPILOT_CLI_PATH) {
        const parts = process.env.COPILOT_CLI_PATH.trim().split(/\s+/);
        cmd = parts[0];
        const baseArgs = parts.slice(1);
        args = [...baseArgs, 'suggest', '-t', 'shell', prompt];
      } else {
        cmd = 'D:\\gh\\copilot\\copilot.exe';
        args = ['suggest', '-t', 'shell', prompt];
      }
    } else if (provider === 'codex') {
      // Codex CLI: use exec subcommand for non-interactive fully-autonomous run
      if (process.env.CODEX_CLI_PATH) {
        const parts = process.env.CODEX_CLI_PATH.trim().split(/\s+/);
        cmd = parts[0];
        const baseArgs = parts.slice(1);
        args = [...baseArgs, 'exec', '--dangerously-bypass-approvals-and-sandbox', '-m', model, '-C', cwd, prompt];
      } else {
        cmd = 'codex';
        args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '-m', model, '-C', cwd, prompt];
      }
    } else {
      cmd = provider;
      args = [prompt];
    }

    let ptyProcess = null;
    let cpProcess = null;

    ws.on('message', (msg) => {
      try {
        const payload = JSON.parse(msg.toString('utf8'));
        if (payload.type === 'input') {
          const inputData = payload.data;
          if (ptyProcess) {
            ptyProcess.write(inputData);
          } else if (cpProcess) {
            cpProcess.stdin.write(inputData);
          }
        }
      } catch (err) {
        console.error('[Host Daemon] Failed to handle agent WS input', err);
      }
    });

    ws.on('close', () => {
      console.log('[Host Daemon] Agent WS closed. Killing process.');
      try {
        if (ptyProcess) {
          ptyProcess.kill();
        }
        if (cpProcess) {
          cpProcess.kill();
        }
      } catch (err) {
        console.error('[Host Daemon] Failed to kill process', err);
      }
    });

    try {
      console.log(`[Host Daemon] Spawning agent PTY: ${cmd} ${args.join(' ')}`);
      // Build env for the agent process
      const agentEnv = { ...process.env, FORCE_COLOR: '1' };
      delete agentEnv.PORT;
      ptyProcess = pty.spawn(cmd, args, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd,
        env: agentEnv,
      });

      ptyProcess.onData((data) => {
        // Stream raw data directly to client logs
        ws.send(JSON.stringify({ type: 'log', data }));
      });

      ptyProcess.onExit(({ exitCode }) => {
        ws.send(JSON.stringify({ type: 'close', code: exitCode }));
        ws.close();
      });
    } catch (ptyError) {
      console.error('[Host Daemon] Failed to spawn agent PTY, falling back to spawn', ptyError);
      
      cpProcess = spawn(cmd, args, { cwd, shell: true });

      cpProcess.stdout.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'log', data: data.toString() }));
      });

      cpProcess.stderr.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'log', data: data.toString() }));
      });

      cpProcess.on('close', (code) => {
        ws.send(JSON.stringify({ type: 'close', code }));
        ws.close();
      });
    }
  }
});

function broadcastToTerminal(termId, message) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.termId === termId) {
      client.send(JSON.stringify(message));
    }
  });
}

server.listen(PORT, () => {
  console.log(`[Host Daemon] Listening on http://localhost:${PORT}`);
  console.log(`[Host Daemon] Workspaces directory: ${WORKSPACES_ROOT}`);

  // On startup, clean up any leftover .agent-backup folders (treat as accepted)
  for (const root of WORKSPACES_ROOTS) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.agent-backup')) {
          const backupPath = path.join(root, entry.name);
          fs.rm(backupPath, { recursive: true, force: true }, (err) => {
            if (!err) console.log(`[Host Daemon] Cleaned up stale backup: ${backupPath}`);
          });
        }
      }
    } catch (err) {
      console.error('[Host Daemon] Backup cleanup error:', err.message);
    }
  }
});
