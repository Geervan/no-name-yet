import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { spawn, exec } from 'child_process';
import { fileURLToPath } from 'url';
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
  return absolutePath;
};

// --- REST Endpoints ---

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
          .filter(name => !['node_modules', '.git', 'host', 'client', '.agents', '.gemini'].includes(name))
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
    git.stdout.on('data', (data) => stdout += data.toString());
    git.on('close', () => {
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
    
    // Step 1: Add files
    const addArgs = files && files.length > 0 ? ['add', ...files] : ['add', '.'];
    const gitAdd = spawn('git', addArgs, { cwd });
    
    gitAdd.on('close', (addCode) => {
      if (addCode !== 0) return res.status(500).json({ error: 'Git add failed' });
      
      // Step 2: Commit
      const gitCommit = spawn('git', ['commit', '-m', message], { cwd });
      
      gitCommit.on('close', (commitCode) => {
        // If git commit fails (e.g. nothing to commit), we still try to push or return success
        // Step 3: Push
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

// --- Dynamic Preview Proxy ---
// Relays requests on the server (like asset fetching/AJAX requests from phone) to local port
app.all('/preview/:port/*', async (req, res) => {
  const { port } = req.params;
  const targetPath = req.params[0] || '';
  const queryString = req.url.split('?')[1] || '';
  const targetUrl = `http://localhost:${port}/${targetPath}${queryString ? '?' + queryString : ''}`;

  try {
    const parsedUrl = new URL(targetUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method,
      headers: { ...req.headers },
    };
    
    // Clean up proxy headers to avoid loops
    delete options.headers.host;
    delete options.headers.referer;

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      res.status(502).send(`Proxy error: ${err.message}`);
    });

    req.pipe(proxyReq, { end: true });
  } catch (err) {
    res.status(500).send(`Proxy controller error: ${err.message}`);
  }
});

// --- WebSockets for Terminals and Agents ---
const terminals = new Map(); // stores PTY / spawn objects
const terminalBuffers = new Map(); // stores buffered output to catch up client

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (token !== SECURITY_TOKEN) {
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

    let proc = terminals.get(termId);

    // If terminal process doesn't exist, spawn it
    if (!proc) {
      let cwd;
      try {
        cwd = resolveWorkspacePath(workspace);
      } catch (err) {
        console.error(`[Host Daemon] Terminal workspace resolution failed: ${err.message}`);
        ws.send(JSON.stringify({ type: 'error', data: err.message }));
        ws.close();
        return;
      }
      const isWindows = process.platform === 'win32';
      let shellCmd = isWindows ? 'powershell.exe' : 'sh';
      if (isWindows) {
        const winDir = process.env.SystemRoot || 'C:\\Windows';
        const standardPs = path.join(winDir, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        if (fs.existsSync(standardPs)) {
          shellCmd = standardPs;
        }
      }
      const shellArgs = isWindows ? ['-NoLogo', '-ExecutionPolicy', 'Bypass'] : [];

      try {
        console.log(`[Host Daemon] Spawning PTY terminal shell: ${shellCmd}`);
        proc = pty.spawn(shellCmd, shellArgs, {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd,
          env: { ...process.env, FORCE_COLOR: '1' },
        });

        terminals.set(termId, proc);
        terminalBuffers.set(termId, []);

        proc.onData((data) => {
          terminalBuffers.get(termId).push(data);
          if (terminalBuffers.get(termId).length > 200) {
            terminalBuffers.get(termId).shift();
          }
          broadcastToTerminal(termId, { type: 'data', data });
        });

        proc.onExit(({ exitCode }) => {
          broadcastToTerminal(termId, { type: 'exit', code: exitCode });
          terminals.delete(termId);
          terminalBuffers.delete(termId);
        });

        proc.isPty = true;
      } catch (ptyError) {
        console.error('[Host Daemon] Failed to spawn PTY, falling back to child_process.spawn', ptyError);
        proc = spawn(shellCmd, shellArgs, {
          cwd,
          env: { ...process.env, FORCE_COLOR: '1' },
        });

        terminals.set(termId, proc);
        terminalBuffers.set(termId, []);

        proc.stdout.on('data', (data) => {
          const text = data.toString();
          terminalBuffers.get(termId).push(text);
          if (terminalBuffers.get(termId).length > 200) {
            terminalBuffers.get(termId).shift();
          }
          broadcastToTerminal(termId, { type: 'data', data: text });
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString();
          terminalBuffers.get(termId).push(text);
          broadcastToTerminal(termId, { type: 'data', data: text });
        });

        proc.on('close', () => {
          broadcastToTerminal(termId, { type: 'exit', code: 0 });
          terminals.delete(termId);
          terminalBuffers.delete(termId);
        });

        proc.isPty = false;
      }
    }

    // Assign ws reference
    ws.termId = termId;

    // Send buffered catch-up text
    const buffer = terminalBuffers.get(termId) || [];
    ws.send(JSON.stringify({ type: 'data', data: buffer.join('') }));

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
        }
      } catch (err) {
        let inputData = msg.toString('utf8');
        if (proc.isPty) {
          proc.write(inputData);
        } else {
          if (inputData === '\r') {
            inputData = process.platform === 'win32' ? '\r\n' : '\n';
          }
          proc.stdin.write(inputData);
        }
      }
    });

    ws.on('close', () => {
      // We do NOT kill the terminal process here! That's what keeps it persistent.
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
    const brainDir = 'C:/Users/Geervan/.gemini/antigravity-ide/brain/8c76bd4c-a3f4-407f-8490-f5ffafcd2e55';
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
        if (baseArgs.length > 0) {
          args = [...baseArgs, '--profile', model, '--dangerously-skip-permissions', '--prompt', prompt];
        } else {
          args = ['run', '--profile', model, '--dangerously-skip-permissions', '--prompt', prompt];
        }
      } else {
        cmd = 'D:\\Antigravity\\bin\\antigravity.cmd';
        if (!fs.existsSync(cmd)) {
          cmd = 'antigravity';
        }
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
});
