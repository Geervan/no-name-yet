import React, { useState, useEffect } from 'react';
import { Layers, Folder, Cpu, Terminal as TermIcon, GitBranch, Play, ShieldAlert, Key, Globe, LogOut, ArrowLeft } from 'lucide-react';
import WorkspacesTab from './components/WorkspacesTab';
import FilesTab from './components/FilesTab';
import AgentTab from './components/AgentTab';
import TerminalTab from './components/TerminalTab';
import GitTab from './components/GitTab';
import PreviewTab from './components/PreviewTab';

function parseProblemsFromBuffer(bufferText) {
  if (!bufferText) return [];
  const lines = bufferText.split(/\r?\n/);
  const problems = [];
  
  const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  const patterns = [
    // TypeScript / ESLint: path/file.ts:12:34 - error TS1234: Message
    /([a-zA-Z0-9_\-\.\/\\ ]+\.[a-zA-Z0-9]+):(\d+):(\d+)(?:\s*-\s*(error|warning)\s+.*)?:\s*(.*)/i,
    // C/C++: filename.c:12:34: error: message
    /([a-zA-Z0-9_\-\.\/\\ ]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning):\s*(.*)/i,
    // Python traceback: File "path/file.py", line 12, in function
    /File\s+"([^"]+\.[a-zA-Z0-9]+)",\s+line\s+(\d+)/i,
    // Webpack: ERROR in ./src/index.js 12:34-45
    /ERROR\s+in\s+([a-zA-Z0-9_\-\.\/\\ ]+\.[a-zA-Z0-9]+)\s+(\d+):(\d+)/i,
    // Exception stacks: at Object.<anonymous> (D:\path\file.js:12:34)
    /at\s+(?:[a-zA-Z0-9_.]+\s+\()?(?:file:\/\/\/)?([a-zA-Z]:[\\\/][a-zA-Z0-9_\-\.\/\\ ]+\.[a-zA-Z0-9]+):(\d+):(\d+)\)?/i
  ];

  for (let i = 0; i < lines.length; i++) {
    const cleanLine = stripAnsi(lines[i]).trim();
    if (!cleanLine) continue;

    for (const regex of patterns) {
      const match = cleanLine.match(regex);
      if (match) {
        let file = '', lineNum = 1, colNum = 1, type = 'error', msg = cleanLine;

        if (regex === patterns[0]) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          type = match[4]?.toLowerCase() === 'warning' ? 'warning' : 'error';
          msg = match[5] || 'Compiler issue';
        } else if (regex === patterns[1]) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          type = match[4].toLowerCase();
          msg = match[5] || 'Compiler error';
        } else if (regex === patterns[2]) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          const nextLine = lines[i + 1] ? stripAnsi(lines[i + 1]).trim() : '';
          msg = nextLine ? `Traceback error: ${nextLine}` : 'Python traceback execution error';
        } else if (regex === patterns[3]) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          msg = 'Webpack Compilation Error';
        } else if (regex === patterns[4]) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          msg = 'Exception Stack Trace Location';
        }

        file = file.replace(/\\/g, '/');
        const fileBasename = file.split('/').pop();

        problems.push({
          id: `${file}-${lineNum}-${msg.slice(0, 40)}`,
          file,
          fileBasename,
          line: lineNum,
          column: colNum,
          type,
          msg,
          rawLine: cleanLine
        });
        break;
      }
    }
  }

  return problems;
}

export default function App() {
  const [apiHost, setApiHost] = useState(() => localStorage.getItem('portable_api_host') || 'http://localhost:8000');
  const [token, setToken] = useState(() => localStorage.getItem('portable_token') || 'dev-secret-token-123456');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState('');
  
  // Connection Form temp states
  const [inputHost, setInputHost] = useState(apiHost);
  const [inputToken, setInputToken] = useState(token);

  // Core App states
  const [activeTab, setActiveTab] = useState('workspaces');
  const [activeWorkspace, setActiveWorkspace] = useState(() => localStorage.getItem('portable_active_workspace') || '');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [isFileEditing, setIsFileEditing] = useState(false);

  const [fileTreeKey, setFileTreeKey] = useState(0);
  const [terminalBuffers, setTerminalBuffers] = useState({});
  const [problems, setProblems] = useState([]);
  const [fileToOpen, setFileToOpen] = useState(null);

  // Calculate WS Host automatically from HTTP Host
  const getWsHost = (httpHost) => {
    try {
      const url = new URL(httpHost);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${url.host}`;
    } catch (_) {
      return httpHost.replace(/^http/, 'ws');
    }
  };

  const wsHost = getWsHost(apiHost);

  const checkAuth = async (hostToCheck, tokenToCheck) => {
    setAuthChecking(true);
    setAuthError('');
    // Normalize host: strip trailing slash, ensure protocol
    let normalizedHost = hostToCheck.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalizedHost)) {
      normalizedHost = 'https://' + normalizedHost;
    }
    try {
      const res = await fetch(`${normalizedHost}/api/auth/check`, {
        headers: { 'Authorization': `Bearer ${tokenToCheck.trim()}` }
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.status === 200 && contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data.status === 'ok') {
          setIsAuthenticated(true);
          localStorage.setItem('portable_api_host', normalizedHost);
          localStorage.setItem('portable_token', tokenToCheck.trim());
          setApiHost(normalizedHost);
          setToken(tokenToCheck.trim());
          return;
        }
      }

      setIsAuthenticated(false);
      if (!contentType.includes('application/json')) {
        setAuthError(`Auth failed: Target port is a web/SPA server, not the Host Daemon. Please check the port (defaults to 5000).`);
      } else {
        const body = await res.text().catch(() => '');
        setAuthError(`Auth failed (${res.status}): ${body || 'Invalid token'}`);
      }
    } catch (err) {
      setIsAuthenticated(false);
      setAuthError(`Connection failed: ${err.message}`);
    } finally {
      setAuthChecking(false);
    }
  };

  useEffect(() => {
    if (apiHost && token) {
      checkAuth(apiHost, token);
    } else {
      setAuthChecking(false);
    }
  }, []);

  // Use visualViewport to detect keyboard and shrink content area accordingly
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      const keyboardHeight = window.innerHeight - vv.height;
      const isOpen = keyboardHeight > 100;
      setKeyboardOpen(isOpen);

      // Shrink the app-content so focused inputs stay above keyboard
      const content = document.querySelector('.app-content');
      if (content) {
        content.style.paddingBottom = isOpen
          ? `${keyboardHeight + 16}px`
          : '110px';
      }
      // Also scroll the focused element into view
      if (isOpen) {
        setTimeout(() => {
          const active = document.activeElement;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 100);
      }
    };

    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const handleTerminalData = (sessionId, data) => {
    setTerminalBuffers(prev => {
      const current = prev[sessionId] || '';
      // Keep last 4000 characters
      const updated = (current + data).slice(-4000);
      
      // Parse problems from the updated buffer
      const parsed = parseProblemsFromBuffer(updated);
      
      // Update problems state
      setProblems(prevProblems => {
        const otherProblems = prevProblems.filter(p => p.sessionId !== sessionId);
        const sessionProblems = parsed.map(p => ({ ...p, sessionId }));
        
        // Remove duplicates based on unique combination of file, line, and message snippet
        const map = new Map();
        [...otherProblems, ...sessionProblems].forEach(p => {
          map.set(`${p.file}-${p.line}-${p.msg.slice(0, 100)}`, p);
        });
        return Array.from(map.values());
      });

      return {
        ...prev,
        [sessionId]: updated
      };
    });
  };

  const handleSaveFileProblems = (filePath, fileProblems) => {
    setProblems(prev => {
      // Filter out any previous syntax or error problems for this file
      const otherProblems = prev.filter(p => p.file !== filePath);
      return [...otherProblems, ...fileProblems];
    });
  };

  const handleSelectFile = (filePath, line) => {
    setFileToOpen({ path: filePath, line });
    setActiveTab('files');
  };

  const handleConnect = (e) => {
    e.preventDefault();
    checkAuth(inputHost, inputToken);
  };

  const handleDisconnect = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('portable_token');
    localStorage.removeItem('portable_active_workspace');
    setActiveWorkspace('');
    setInputToken('');
  };

  const handleSelectWorkspace = (workspaceName) => {
    setActiveWorkspace(workspaceName);
    localStorage.setItem('portable_active_workspace', workspaceName);
    setActiveTab('files');
  };

  if (authChecking) {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="bg-glow-container">
          <div className="bg-glow-orb-1"></div>
          <div className="bg-glow-orb-2"></div>
        </div>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div className="eyebrow-badge">Syncing Sandbox</div>
          <h1 className="app-title" style={{ fontSize: '24px' }}>Antigravity Portable</h1>
          <p className="text-sub" style={{ opacity: 0.6 }}>Authenticating tunnel connection...</p>
        </div>
      </div>
    );
  }

  // Connection Lock Screen
  if (!isAuthenticated) {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="bg-glow-container">
          <div className="bg-glow-orb-1"></div>
          <div className="bg-glow-orb-2"></div>
        </div>
        
        <div className="double-bezel-card" style={{ width: '90%', maxWidth: '380px' }}>
          <div className="double-bezel-card-inner">
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div className="eyebrow-badge" style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                <Key size={10} />
                Access Locked
              </div>
              <h1 className="app-title" style={{ fontSize: '22px', marginTop: '10px' }}>Connect Daemon</h1>
              <p className="text-sub" style={{ marginTop: '4px' }}>Expose host using Cloudflare Tunnels</p>
            </div>

            {authError && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: '#f87171',
                padding: '10px',
                borderRadius: '10px',
                fontSize: '12px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <ShieldAlert size={14} />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="input-group" style={{ marginBottom: '0' }}>
                <label className="input-label">Host Daemon URL</label>
                <input
                  type="text"
                  className="input-field"
                  value={inputHost}
                  onChange={(e) => setInputHost(e.target.value)}
                  placeholder="e.g., http://localhost:5000"
                  required
                />
              </div>

              <div className="input-group" style={{ marginBottom: '0' }}>
                <label className="input-label">Security Token</label>
                <input
                  type="password"
                  className="input-field"
                  value={inputToken}
                  onChange={(e) => setInputToken(e.target.value)}
                  placeholder="Enter token"
                  required
                />
              </div>

              <button type="submit" className="btn-primary" style={{ marginTop: '8px' }}>
                <span>Connect to Host</span>
                <div className="btn-icon-wrapper">
                  <Globe size={14} />
                </div>
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Authenticated Dashboard Layout
  return (
    <div className="app-container">
      <div className="bg-glow-container">
        <div className="bg-glow-orb-1"></div>
        <div className="bg-glow-orb-2"></div>
      </div>

      {/* Persistent Header */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {activeWorkspace && activeTab !== 'workspaces' && (
            <button
              onClick={() => setActiveTab('workspaces')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: '4px'
              }}
              title="Back to Workspaces"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <h1 className="app-title">Antigravity Portable</h1>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: activeWorkspace ? 'var(--accent-color)' : 'var(--text-muted)' }} />
              {activeWorkspace ? `Workspace: ${activeWorkspace}` : 'No Workspace Selected'}
            </span>
          </div>
        </div>
        
        <button
          onClick={handleDisconnect}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center'
          }}
          title="Disconnect Daemon"
        >
          <LogOut size={16} />
        </button>
      </header>

      {/* Main Tab Render Window */}
      <main className="app-content" style={{ position: 'relative', height: '100%' }}>
        <div style={{ display: activeTab === 'workspaces' ? 'block' : 'none', height: '100%' }}>
          <WorkspacesTab
            apiHost={apiHost}
            token={token}
            activeWorkspace={activeWorkspace}
            onSelectWorkspace={handleSelectWorkspace}
          />
        </div>
        <div style={{ display: activeTab === 'files' ? 'block' : 'none', height: '100%' }}>
          <FilesTab
            key={fileTreeKey}
            apiHost={apiHost}
            token={token}
            activeWorkspace={activeWorkspace}
            fileToOpen={fileToOpen}
            onFileOpened={() => setFileToOpen(null)}
            onSaveFileProblems={handleSaveFileProblems}
            onRefreshRequest={() => setFileTreeKey(k => k + 1)}
            onEditingChange={setIsFileEditing}
          />
        </div>
        <div style={{ display: activeTab === 'agent' ? 'block' : 'none', height: '100%' }}>
          <AgentTab
            apiHost={apiHost}
            wsHost={wsHost}
            token={token}
            activeWorkspace={activeWorkspace}
            terminalBuffers={terminalBuffers}
            problems={problems}
            onAgentFinish={() => setFileTreeKey(k => k + 1)}
          />
        </div>
        <div style={{ display: activeTab === 'terminal' ? 'block' : 'none', height: '100%' }}>
          <TerminalTab
            apiHost={apiHost}
            wsHost={wsHost}
            token={token}
            activeWorkspace={activeWorkspace}
            onTerminalData={handleTerminalData}
            problems={problems}
            onSelectFile={handleSelectFile}
          />
        </div>
        <div style={{ display: activeTab === 'git' ? 'block' : 'none', height: '100%' }}>
          <GitTab
            apiHost={apiHost}
            token={token}
            activeWorkspace={activeWorkspace}
          />
        </div>
        <div style={{ display: activeTab === 'preview' ? 'block' : 'none', height: '100%' }}>
          <PreviewTab
            apiHost={apiHost}
            wsHost={wsHost}
            token={token}
            activeWorkspace={activeWorkspace}
          />
        </div>
      </main>

      {/* Bottom PWA Tab bar — hidden when editing a file or keyboard is up */}
      {!isFileEditing && !keyboardOpen && (
      <nav className="app-navbar">
        <button
          onClick={() => setActiveTab('workspaces')}
          className={`nav-item ${activeTab === 'workspaces' ? 'active' : ''}`}
        >
          <Layers size={20} strokeWidth={1.5} />
          <span>Workspaces</span>
        </button>
        
        <button
          onClick={() => setActiveTab('files')}
          className={`nav-item ${activeTab === 'files' ? 'active' : ''}`}
        >
          <Folder size={20} strokeWidth={1.5} />
          <span>Files</span>
        </button>
        
        <button
          onClick={() => setActiveTab('agent')}
          className={`nav-item ${activeTab === 'agent' ? 'active' : ''}`}
        >
          <Cpu size={20} strokeWidth={1.5} />
          <span>Agent</span>
        </button>
        
        <button
          onClick={() => setActiveTab('terminal')}
          className={`nav-item ${activeTab === 'terminal' ? 'active' : ''}`}
        >
          <TermIcon size={20} strokeWidth={1.5} />
          <span>Terminal</span>
        </button>
        
        <button
          onClick={() => setActiveTab('git')}
          className={`nav-item ${activeTab === 'git' ? 'active' : ''}`}
        >
          <GitBranch size={20} strokeWidth={1.5} />
          <span>Git</span>
        </button>
        
        <button
          onClick={() => setActiveTab('preview')}
          className={`nav-item ${activeTab === 'preview' ? 'active' : ''}`}
        >
          <Play size={20} strokeWidth={1.5} />
          <span>Preview</span>
        </button>
      </nav>
      )}
    </div>
  );
}
