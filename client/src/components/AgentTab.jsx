import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Send, Loader, X, Terminal, ChevronDown, Check, FileText } from 'lucide-react';
import { Terminal as XTerm } from 'xterm';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

const stripAnsi = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

// ─── Portal Dropdown ────────────────────────────────────────────────────────────
// Renders into document.body so it's completely outside any overflow/stacking context
function PortalDropdown({ open, anchorRef, onClose, children }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (open && anchorRef.current) {
      setRect(anchorRef.current.getBoundingClientRect());
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (anchorRef.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    // Use mousedown so it fires before blur
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open, onClose]);

  if (!open || !rect) return null;

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 2147483647, // max z-index
        background: 'rgba(10, 10, 12, 0.98)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '12px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.9)',
        padding: '6px',
        maxHeight: '260px',
        overflowY: 'auto',
      }}
      // Prevent the mousedown outside-click handler from triggering
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

function DropdownItem({ label, desc, isActive, onClick }) {
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{
        padding: '9px 12px',
        borderRadius: '8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: isActive ? 'rgba(0,255,102,0.08)' : 'transparent',
        color: isActive ? 'var(--accent-color)' : 'var(--text-primary)',
        marginBottom: '2px',
        transition: 'background 0.1s',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: '13px', fontWeight: '700', whiteSpace: 'nowrap' }}>{label}</span>
        {desc && (
          <span style={{ fontSize: '10px', color: isActive ? 'rgba(0,255,102,0.6)' : 'var(--text-muted)', marginTop: '2px' }}>
            {desc}
          </span>
        )}
      </div>
      {isActive && <Check size={13} style={{ color: 'var(--accent-color)', marginLeft: '10px', flexShrink: 0 }} />}
    </div>
  );
}

function SelectorButton({ label, desc, open, disabled, onClick, anchorRef }) {
  return (
    <button
      ref={anchorRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        background: 'var(--bg-card-inner)',
        border: `1px solid ${open ? 'var(--accent-color)' : 'var(--border-glow)'}`,
        color: 'var(--text-primary)',
        padding: '10px 14px',
        borderRadius: '10px',
        outline: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: open ? '0 0 0 3px rgba(0,255,102,0.1)' : 'none',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        textAlign: 'left',
        height: '52px',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {desc && (
          <span style={{ fontSize: '10px', fontWeight: '400', color: 'var(--text-secondary)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {desc}
          </span>
        )}
      </div>
      <ChevronDown
        size={15}
        style={{
          color: 'var(--text-muted)',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s',
          marginLeft: '10px',
          flexShrink: 0,
        }}
      />
    </button>
  );
}

// ─── Main AgentTab Component ────────────────────────────────────────────────────
export default function AgentTab({ apiHost, wsHost, token, activeWorkspace, terminalBuffers = {}, problems = [], onAgentFinish }) {
  const [providers, setProviders] = useState([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  
  const [provider, setProvider]             = useState('antigravity');
  const [profile, setProfile]               = useState('gemini-3.5-flash-medium');
  const [loadingModels, setLoadingModels]   = useState(false);

  const [promptText, setPromptText]   = useState('');
  const [running, setRunning]         = useState(false);
  const [statusText, setStatusText]   = useState('');
  const [hasTerminalSession, setHasTerminalSession] = useState(false);

  const wsRef      = useRef(null);
  const termContainerRef = useRef(null);
  const termInstanceRef = useRef(null);
  const fullscreenContainerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const agentDidWorkRef = useRef(false);

  // Fullscreen terminal state
  const [termFullscreen, setTermFullscreen] = useState(false);

  // Dropdown state
  const [providerOpen, setProviderOpen] = useState(false);
  const [profileOpen, setProfileOpen]   = useState(false);
  const providerAnchorRef = useRef(null);
  const profileAnchorRef  = useRef(null);

  const [authUrl, setAuthUrl] = useState(null);
  const [agentActionLoading, setAgentActionLoading] = useState(false);
  const [agentError, setAgentError]     = useState('');
  const [agentSuccess, setAgentSuccess] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [changedFiles, setChangedFiles] = useState([]);
  const [loadingChanges, setLoadingChanges] = useState(false);

  // `@`-mention autocomplete state
  const [flatFiles, setFlatFiles] = useState([]);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(-1);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const textareaRef = useRef(null);

  // ── Flatten files list helper ─────────────────────────────────────────────
  const flattenTree = (nodes) => {
    let list = [];
    nodes.forEach(node => {
      if (node.type === 'file') {
        list.push(node.path);
      } else if (node.type === 'directory' && node.children) {
        list.push(...flattenTree(node.children));
      }
    });
    return list;
  };

  // ── Fetch dynamic providers list from host ────────────────────────────────
  useEffect(() => {
    setLoadingProviders(true);
    fetch(`${apiHost}/api/agent/providers`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        if (data.providers && data.providers.length > 0) {
          setProvider(data.providers[0].value);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingProviders(false));
  }, [apiHost, token]);

  // ── Fetch file tree for autocomplete references ──────────────────────────
  useEffect(() => {
    if (!activeWorkspace) return;
    fetch(`${apiHost}/api/files/tree?workspace=${encodeURIComponent(activeWorkspace)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => {
        setFlatFiles(flattenTree(data.tree || []));
      })
      .catch(() => {});
  }, [activeWorkspace, apiHost, token]);

  // ── Load provider models dynamically from host CLI ─────────────────────────
  useEffect(() => {
    if (!provider) return;
    setLoadingModels(true);
    fetch(`${apiHost}/api/models?provider=${provider}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        const models = (data.models || []).map((m) => ({
          value: m.value,
          label: m.label,
          desc: m.desc,
        }));
        if (models.length > 0) {
          // Update the profiles for this provider in the providers list
          setProviders(prev => prev.map(p => p.value === provider ? { ...p, profiles: models } : p));
          
          // Auto select first model if active profile is not in the list
          if (!models.some(m => m.value === profile)) {
            setProfile(models[0].value);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingModels(false));
  }, [provider, apiHost, token]);

  // ── Initialize and attach XTerm terminal dynamically ──────────────────────
  useEffect(() => {
    if (hasTerminalSession && termContainerRef.current && !termInstanceRef.current) {
      const term = new XTerm({
        cursorBlink: true,
        scrollback: 5000,
        cols: 220,
        rows: 50,
        theme: {
          background: '#070709',
          foreground: '#f4f4f5',
          cursor: '#00ff66',
          selectionBackground: 'rgba(0, 255, 102, 0.3)'
        },
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        disableStdin: false,
      });

      term.loadAddon(new WebLinksAddon());
      term.open(termContainerRef.current);
      termInstanceRef.current = term;

      // iOS touch scrollback: translate swipe gestures into XTerm scroll
      const container = termContainerRef.current;
      let touchStartY = 0;
      const onTouchStart = (e) => { touchStartY = e.touches[0].clientY; };
      const onTouchMove = (e) => {
        const dy = touchStartY - e.touches[0].clientY;
        touchStartY = e.touches[0].clientY;
        const lines = Math.round(dy / 20);
        if (lines !== 0) {
          term.scrollLines(lines);
          e.preventDefault();
        }
      };
      container.addEventListener('touchstart', onTouchStart, { passive: true });
      container.addEventListener('touchmove', onTouchMove, { passive: false });
      term._touchCleanup = () => {
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
      };

      term.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data }));
        }
        // When user hits Enter in the terminal, reset work detection and take fresh backup
        if (data === '\r' || data === '\n') {
          agentDidWorkRef.current = false;
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          setChangedFiles([]);
          // Take a fresh backup before the agent processes this new prompt
          fetch(`${apiHost}/api/agent/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ workspace: activeWorkspace }),
          }).catch(() => {});
        }
      });
    }

    return () => {
      if (!hasTerminalSession && termInstanceRef.current) {
        if (termInstanceRef.current._touchCleanup) {
          termInstanceRef.current._touchCleanup();
        }
        termInstanceRef.current.dispose();
        termInstanceRef.current = null;
      }
    };
  }, [hasTerminalSession]);

  // ── Re-attach XTerm when toggling fullscreen ──────────────────────────────
  useEffect(() => {
    if (!termInstanceRef.current || !hasTerminalSession) return;
    const container = termFullscreen
      ? fullscreenContainerRef.current
      : termContainerRef.current;
    if (container) {
      termInstanceRef.current.open(container);
      // Notify PTY of new terminal size
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: termInstanceRef.current.cols,
          rows: termInstanceRef.current.rows,
        }));
      }
    }
  }, [termFullscreen]);

  // ── Cleanup WS on unmount ─────────────────────────────────────────────────
  useEffect(() => () => { 
    if (wsRef.current) wsRef.current.close();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (termInstanceRef.current) {
      if (termInstanceRef.current._touchCleanup) {
        termInstanceRef.current._touchCleanup();
      }
      termInstanceRef.current.dispose();
      termInstanceRef.current = null;
    }
  }, []);

  // ── Fetch changed files from host ─────────────────────────────────────────
  const fetchChangedFiles = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoadingChanges(true);
    try {
      const res = await fetch(
        `${apiHost}/api/agent/diff?workspace=${encodeURIComponent(activeWorkspace)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const data = await res.json();
      setChangedFiles(data.files || []);
    } catch {
      // silently fail
    } finally {
      setLoadingChanges(false);
    }
  }, [activeWorkspace, apiHost, token]);

  // ── Mentions queries autocomplete list helper ──────────────────────────────
  const getMentionSuggestions = () => {
    const termKeys = Object.keys(terminalBuffers || {});
    const baseSuggestions = [
      { type: 'context', value: 'terminal', label: '@terminal', desc: 'Attach all active shell outputs' },
      ...termKeys.map(k => ({ type: 'context', value: k, label: `@${k}`, desc: `Attach only ${k} output` })),
      { type: 'context', value: 'problems', label: '@problems', desc: 'Attach all active compiler warning/error problems' }
    ];
    
    const fileSuggestions = flatFiles.map(f => ({
      type: 'file',
      value: `file:${f}`,
      label: `@file:${f}`,
      desc: `Attach content of file: ${f}`
    }));
    
    const all = [...baseSuggestions, ...fileSuggestions];
    
    if (!mentionQuery) return all.slice(0, 8);
    return all
      .filter(s => s.label.toLowerCase().includes(`@${mentionQuery.toLowerCase()}`))
      .slice(0, 8);
  };

  const suggestions = getMentionSuggestions();

  // ── Textarea onchange listener to catch @ ───────────────────────────────
  const handleTextareaChange = (e) => {
    const val = e.target.value;
    setPromptText(val);

    const selectionStart = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, selectionStart);
    const words = textBeforeCursor.split(/[\s\n]/);
    const lastWord = words[words.length - 1];

    if (lastWord.startsWith('@')) {
      setMentionQuery(lastWord.slice(1));
      setMentionIndex(selectionStart - lastWord.length);
      setShowMentionPopup(true);
      setSelectedMentionIndex(0);
    } else {
      setShowMentionPopup(false);
    }
  };

  const handleSelectMention = (suggestion) => {
    const before = promptText.slice(0, mentionIndex);
    const after = promptText.slice(mentionIndex + mentionQuery.length + 1);
    const tag = suggestion.label;
    const newText = before + tag + ' ' + after;
    
    setPromptText(newText);
    setShowMentionPopup(false);
    
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const cursor = before.length + tag.length + 1;
        textareaRef.current.setSelectionRange(cursor, cursor);
      }
    }, 10);
  };

  const handleTextareaKeyDown = (e) => {
    if (showMentionPopup && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIndex(prev => (prev + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelectMention(suggestions[selectedMentionIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionPopup(false);
      }
    } else if (e.key === 'Enter' && !e.shiftKey && !running && promptText.trim()) {
      e.preventDefault();
      runAgent();
    }
  };

  // ── Run agent via WebSocket with async context fetching ──────────────────
  const runAgent = async () => {
    if (!promptText.trim() || !activeWorkspace) return;

    setRunning(true);
    setStatusText('Resolving context references...');
    setHasTerminalSession(true);
    setChangedFiles([]);
    setAgentError('');
    setAgentSuccess('');
    setAuthUrl(null);
    if (wsRef.current) wsRef.current._urlBuffer = '';
    agentDidWorkRef.current = false;

    // Snapshot workspace before agent writes anything
    try {
      await fetch(`${apiHost}/api/agent/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ workspace: activeWorkspace }),
      });
    } catch (_) { /* non-fatal */ }

    // Pre-clear terminal if already exists
    if (termInstanceRef.current) {
      termInstanceRef.current.clear();
    }

    // Pre-fetch files context
    let enrichedPrompt = promptText;
    
    // Find all @file:path matches
    const fileRegex = /@file:([a-zA-Z0-9_\-\.\/\\ ]+)/g;
    const fileMatches = [...promptText.matchAll(fileRegex)];
    
    const fileContexts = [];
    for (const match of fileMatches) {
      const filePath = match[1].trim();
      try {
        setStatusText(`Loading file: ${filePath}...`);
        const res = await fetch(`${apiHost}/api/files/content?workspace=${encodeURIComponent(activeWorkspace)}&filePath=${encodeURIComponent(filePath)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!data.error && data.content !== undefined) {
          fileContexts.push(`=== FILE CONTEXT: ${filePath} ===\n${data.content}\n=== END FILE CONTEXT ===`);
        }
      } catch (err) {
        console.error(`Failed to fetch file content for ${filePath}`, err);
      }
    }

    // Parse @problems
    if (promptText.includes('@problems') && problems.length > 0) {
      const ptext = problems.map((p) => `- [${p.type.toUpperCase()}] ${p.file}:${p.line}: ${p.msg}`).join('\n');
      fileContexts.push(`=== PROBLEMS CONTEXT ===\n${ptext}\n=== END PROBLEMS CONTEXT ===`);
    }

    // Parse @terminal (all buffers)
    if (promptText.includes('@terminal')) {
      const buf = Object.entries(terminalBuffers).map(([id, val]) => `[Shell: ${id}]\n${val.slice(-1500)}`).join('\n\n');
      if (buf) {
        fileContexts.push(`=== SHELL CONTEXT ===\n${buf}\n=== END SHELL CONTEXT ===`);
      }
    } else {
      // Check for specific terminal sessions like @shell-1
      Object.entries(terminalBuffers).forEach(([id, val]) => {
        if (promptText.includes(`@${id}`)) {
          fileContexts.push(`=== SHELL CONTEXT: ${id} ===\n${val.slice(-1500)}\n=== END SHELL CONTEXT ===`);
        }
      });
    }

    if (fileContexts.length > 0) {
      enrichedPrompt = `${fileContexts.join('\n\n')}\n\n${enrichedPrompt}`;
    }

    //setStatusText('Connecting to host daemon...');
    
    const wsUrl = `${wsHost}/ws/agent?workspace=${encodeURIComponent(activeWorkspace)}&provider=${provider}&model=${encodeURIComponent(profile)}&prompt=${encodeURIComponent(enrichedPrompt)}&token=${token}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'status') {
          setStatusText(payload.data);
        } else if (payload.type === 'log') {
          if (termInstanceRef.current) {
            termInstanceRef.current.write(payload.data);
          }
          // Detect auth/login URLs — buffer last 2000 chars of output and scan the whole thing
          // (URLs get split across multiple log chunks by the terminal)
          if (!wsRef._urlBuffer) wsRef._urlBuffer = '';
          wsRef._urlBuffer = (wsRef._urlBuffer + stripAnsi(payload.data)).slice(-2000);
          // Remove spaces/newlines within URL (terminal word-wrap artifacts)
          const cleanBuffer = wsRef._urlBuffer.replace(/\r?\n/g, '');
          const urlMatch = cleanBuffer.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+|https:\/\/[^\s"'<>]*(?:login|auth|oauth|cloudflareaccess|argotunnel)[^\s"'<>]*/);
          if (urlMatch) {
            const url = urlMatch[0].replace(/\s+/g, '');
            setAuthUrl(prev => prev === url ? prev : url);
          }
          // Detect real agent work (tool use, edits, thoughts)
          if (!agentDidWorkRef.current && /Edit\(|Thought|✓|Write\(|Read\(/i.test(payload.data)) {
            agentDidWorkRef.current = true;
          }
          // Only arm silence timer once agent has done real work
          if (agentDidWorkRef.current) {
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
              // Don't stop the CLI — just fetch diff and show accept/reject bar
              fetchChangedFiles();
            }, 4000);
          }
        } else if (payload.type === 'error') {
          if (termInstanceRef.current) {
            termInstanceRef.current.write(`\r\n[ERROR] ${payload.data}\r\n`);
          }
          setStatusText('Agent failed');
        } else if (payload.type === 'close') {
          setRunning(false);
          setStatusText(payload.code === 0 ? 'Agent finished' : 'Agent failed');
          fetchChangedFiles();
          if (onAgentFinish) onAgentFinish();
        }
      } catch {
        if (termInstanceRef.current) {
          termInstanceRef.current.write(event.data);
        }
      }
    };

    wsRef.current.onerror = () => {
      if (termInstanceRef.current) {
        termInstanceRef.current.write('\r\n[WEBSOCKET ERROR] Connection lost.\r\n');
      }
      setStatusText('Connection error');
      setRunning(false);
    };

    wsRef.current.onclose = () => {
      setRunning(prev => {
        // If we were still running when WS closed, fetch changes
        if (prev) fetchChangedFiles();
        return false;
      });
    };
  };

  const cancelAgent = () => {
    if (wsRef.current) wsRef.current.close();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    setRunning(false);
    setStatusText('Cancelled');
  };

  // Send raw input to the running agent PTY (for yes/no prompts etc.)
  const sendToAgent = (text) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
    }
  };

  // ── Accept All: delete backup, keep agent's files ────────────────────────
  const handleAcceptAll = async () => {
    setAgentActionLoading(true);
    setAgentError('');
    try {
      await fetch(`${apiHost}/api/agent/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ workspace: activeWorkspace }),
      });
      setAgentSuccess('Changes accepted.');
      setTimeout(() => { setChangedFiles([]); setAgentSuccess(''); }, 1500);
    } catch (err) {
      setAgentError(err.message);
    } finally {
      setAgentActionLoading(false);
    }
  };

  // ── Reject All: restore workspace from backup ─────────────────────────────
  const executeDiscard = async () => {
    setConfirmDiscard(false);
    setAgentActionLoading(true);
    setAgentError('');
    try {
      const res = await fetch(`${apiHost}/api/agent/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ workspace: activeWorkspace }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAgentSuccess('Files restored to previous state.');
      if (onAgentFinish) onAgentFinish();
      setTimeout(() => { setChangedFiles([]); setAgentSuccess(''); }, 1500);
    } catch (err) {
      setAgentError(err.message || 'Restore failed');
    } finally {
      setAgentActionLoading(false);
    }
  };

  // ── Resolved profile list ─────────────────────────────────────────────────
  const currentProvider = providers.find((p) => p.value === provider) || providers[0];
  const profileList = currentProvider?.profiles || [];
  const currentProfile = profileList.find((p) => p.value === profile);

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Select a workspace to prompt agents.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ paddingBottom: '120px', position: 'relative' }}>
      <div className="eyebrow-badge">Agent Orchestration</div>
      <h2 className="section-title">AI Coding Agent</h2>

      {/* ── Accept / Reject panel — inline below header ── */}
      {changedFiles.length > 0 && (
        <div style={{
          background: 'rgba(7,7,9,0.98)',
          border: '1px solid rgba(37,99,235,0.4)',
          borderRadius: '12px',
          padding: '12px 14px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileText size={14} style={{ color: '#60a5fa' }} />
              <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                Agent changed {changedFiles.length} file{changedFiles.length !== 1 ? 's' : ''}
              </span>
            </div>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {changedFiles.map(f => f.path.split('/').pop()).join(', ').slice(0, 40)}{changedFiles.map(f => f.path.split('/').pop()).join(', ').length > 40 ? '…' : ''}
            </span>
          </div>
          {confirmDiscard ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: '#f87171', fontWeight: '600', flex: 1 }}>Discard all changes?</span>
              <button onClick={() => setConfirmDiscard(false)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-glow)', borderRadius: '6px', color: 'var(--text-primary)', padding: '7px 14px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
              <button onClick={executeDiscard} disabled={agentActionLoading} style={{ background: '#ef4444', border: 'none', borderRadius: '6px', color: '#fff', padding: '7px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>Discard</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setConfirmDiscard(true)} disabled={agentActionLoading} style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', color: '#f87171', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>✕ Reject</button>
              <button onClick={handleAcceptAll} disabled={agentActionLoading} style={{ flex: 1, background: 'linear-gradient(135deg,#2563eb,#1d4ed8)', border: 'none', borderRadius: '8px', color: '#fff', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: 'pointer', boxShadow: '0 2px 16px rgba(37,99,235,0.5)' }}>✓ Accept</button>
            </div>
          )}
          {agentError && <div style={{ color: '#f87171', fontSize: '12px', fontWeight: '600' }}>✕ {agentError}</div>}
          {agentSuccess && <div style={{ color: 'var(--accent-color)', fontSize: '12px', fontWeight: '600' }}>✓ {agentSuccess}</div>}
        </div>
      )}

      {/* ── Auth URL button — shown when CLI outputs a login link ── */}
      {authUrl && (
        <div style={{
          background: 'rgba(234,179,8,0.08)',
          border: '1px solid rgba(234,179,8,0.3)',
          borderRadius: '12px',
          padding: '12px 14px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <span style={{ fontSize: '12px', fontWeight: '700', color: '#fbbf24' }}>🔐 Authentication required</span>
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
              background: 'linear-gradient(135deg,#d97706,#b45309)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              padding: '12px',
              fontSize: '14px',
              fontWeight: '700',
              textAlign: 'center',
              textDecoration: 'none',
              boxShadow: '0 2px 16px rgba(217,119,6,0.4)',
            }}
          >
            Open Login Link →
          </a>
          {/* Copyable full URL */}
          <input
            readOnly
            value={authUrl}
            onFocus={e => e.target.select()}
            style={{
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              padding: '8px 10px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              wordBreak: 'break-all',
              width: '100%',
              boxSizing: 'border-box',
              userSelect: 'all',
            }}
          />
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => navigator.clipboard?.writeText(authUrl).then(() => alert('Copied!')).catch(() => {})}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
              padding: '8px',
              fontSize: '12px',
              fontWeight: '700',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            📋 Copy Clean URL
          </button>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => setAuthUrl(null)}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer', textAlign: 'left' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Provider + Profile selection ──────────────────────────────────── */}
      <div className="double-bezel-card" style={{ marginBottom: '16px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          
          {loadingProviders ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)', padding: '10px 0' }}>
              <Loader className="animate-spin" size={13} style={{ color: 'var(--accent-color)' }} />
              <span>Scanning host config...</span>
            </div>
          ) : (
            <>
              {/* Provider */}
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label">Provider</label>
                <SelectorButton
                  anchorRef={providerAnchorRef}
                  label={currentProvider?.label || 'Select Provider'}
                  desc={currentProvider?.desc || ''}
                  open={providerOpen}
                  disabled={running}
                  onClick={() => { if (!running) { setProviderOpen(v => !v); setProfileOpen(false); } }}
                />
                <PortalDropdown open={providerOpen} anchorRef={providerAnchorRef} onClose={() => setProviderOpen(false)}>
                  {providers.map((opt) => (
                    <DropdownItem
                      key={opt.value}
                      label={opt.label}
                      desc={opt.desc}
                      isActive={opt.value === provider}
                      onClick={() => { setProvider(opt.value); setProviderOpen(false); }}
                    />
                  ))}
                </PortalDropdown>
              </div>

              {/* Divider */}
              <div style={{ height: '1px', background: 'var(--border-glow)' }} />

              {/* Profile */}
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label">Agent Profile</label>
                {loadingModels ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)', padding: '14px 0' }}>
                    <Loader className="animate-spin" size={13} style={{ color: 'var(--accent-color)' }} />
                    <span>Loading models…</span>
                  </div>
                ) : (
                  <>
                    <SelectorButton
                      anchorRef={profileAnchorRef}
                      label={currentProfile?.label ?? (profileList.length === 0 ? 'No profiles available' : 'Select profile')}
                      desc={currentProfile?.desc ?? ''}
                      open={profileOpen}
                      disabled={running || profileList.length === 0}
                      onClick={() => { if (!running && profileList.length > 0) { setProfileOpen(v => !v); setProviderOpen(false); } }}
                    />
                    <PortalDropdown open={profileOpen} anchorRef={profileAnchorRef} onClose={() => setProfileOpen(false)}>
                      {profileList.map((opt) => (
                        <DropdownItem
                          key={opt.value}
                          label={opt.label}
                          desc={opt.desc}
                          isActive={opt.value === profile}
                          onClick={() => { setProfile(opt.value); setProfileOpen(false); }}
                        />
                      ))}
                    </PortalDropdown>
                  </>
                )}
              </div>
            </>
          )}

        </div>
      </div>

      {/* ── Context reference help guide ────────────────────────────────────── */}
      {/* <div className="double-bezel-card" style={{ marginBottom: '12px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.01)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={14} style={{ color: 'var(--accent-color)' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Type <strong>@</strong> in the prompt below to link resources: <strong>@terminal</strong> (CLI buffer), <strong>@problems</strong> (warning lists), or <strong>@file:path</strong> (files content).
            </span>
          </div>
        </div>
      </div> */}

      {/* ── Prompt Area with autocomplete mention popup ──────────────────── */}
      <div className="double-bezel-card" style={{ position: 'relative', overflow: 'visible' }}>
        <div className="double-bezel-card-inner" style={{ padding: '12px', position: 'relative', overflow: 'visible' }}>
          
          {/* Autocomplete Popup */}
          {showMentionPopup && suggestions.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: 'calc(100% - 10px)',
              left: '12px',
              right: '12px',
              background: 'rgba(10, 10, 12, 0.98)',
              backdropFilter: 'blur(20px)',
              border: '1px solid var(--accent-color-dim)',
              borderRadius: '10px',
              boxShadow: '0 -8px 32px rgba(0,0,0,0.8)',
              padding: '6px',
              zIndex: 350,
              maxHeight: '180px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column'
            }}>
              {suggestions.map((item, index) => (
                <div
                  key={item.value}
                  onClick={() => handleSelectMention(item)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    background: index === selectedMentionIndex ? 'rgba(0, 255, 102, 0.08)' : 'transparent',
                    color: index === selectedMentionIndex ? 'var(--accent-color)' : 'var(--text-primary)',
                    display: 'flex',
                    flexDirection: 'column',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={() => setSelectedMentionIndex(index)}
                >
                  <span style={{ fontSize: '12px', fontWeight: '700' }}>{item.label}</span>
                  <span style={{ fontSize: '9px', color: index === selectedMentionIndex ? 'rgba(0,255,102,0.65)' : 'var(--text-muted)', marginTop: '2px' }}>
                    {item.desc}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <textarea
              ref={textareaRef}
              className="input-field"
              placeholder="Describe what you need the agent to do (use @ to add context)…"
              value={promptText}
              onChange={handleTextareaChange}
              onKeyDown={handleTextareaKeyDown}
              disabled={running}
              style={{
                flex: 1,
                minHeight: '64px',
                maxHeight: '140px',
                padding: '12px',
                borderRadius: '10px',
                fontSize: '14px',
                resize: 'none',
                border: '1px solid var(--border-glow)',
              }}
            />
            {running ? (
              <button
                onClick={cancelAgent}
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  color: '#ef4444',
                  width: '44px',
                  height: '44px',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <X size={16} />
              </button>
            ) : (
              <button
                onClick={runAgent}
                disabled={!promptText.trim()}
                style={{
                  background: promptText.trim() ? 'linear-gradient(135deg, #00ff66 0%, #00cc52 100%)' : 'var(--bg-card-inner)',
                  border: promptText.trim() ? 'none' : '1px solid var(--border-glow)',
                  color: promptText.trim() ? '#000' : 'var(--text-muted)',
                  width: '44px',
                  height: '44px',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: promptText.trim() ? 'pointer' : 'not-allowed',
                  flexShrink: 0,
                  transition: 'all 0.2s',
                }}
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
            {currentProvider?.label || '—'} · {currentProfile?.label ?? '—'} {running ? '· Running…' : '· Enter to send'}
          </p>
        </div>
      </div>


      {/* ── Fullscreen Terminal Overlay ───────────────────────────────────── */}
      {hasTerminalSession && termFullscreen && ReactDOM.createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#070709', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border-glow)', background: 'rgba(10,10,12,0.95)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={13} style={{ color: 'var(--accent-color)' }} />
              <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Agent Output</span>
              {running && <Loader className="animate-spin" size={12} style={{ color: 'var(--accent-color)' }} />}
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{statusText}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {running && (
                <button onClick={cancelAgent} style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px', color: '#f87171', padding: '6px 12px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>Stop</button>
              )}
              <button onClick={() => setTermFullscreen(false)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-glow)', borderRadius: '6px', color: 'var(--text-primary)', padding: '6px 12px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>✕ Shrink</button>
            </div>
          </div>
          {/* Scrollable terminal wrapper — fills all space, scrolls both axes */}
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px 8px 8px', minHeight: 0 }}>
            <div
              ref={fullscreenContainerRef}
              style={{ minWidth: 'max-content', minHeight: '100%' }}
            />
          </div>          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--border-glow)', background: 'rgba(10,10,12,0.95)', flexShrink: 0 }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '700', flexShrink: 0 }}>Reply:</span>
              {[
                { label: 'Yes',     value: 'y\r',    color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.25)' },
                { label: 'No',      value: 'n\r',    color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
                { label: '↵',       value: '\r',     color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
                { label: '↑',       value: '\x1b[A', color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
                { label: '↓',       value: '\x1b[B', color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
              ].map(({ label, value, color, bg, border }) => (
                <button key={label} onClick={() => sendToAgent(value)} style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', color, padding: '8px 12px', fontSize: '13px', fontWeight: '700', cursor: 'pointer', fontFamily: 'var(--font-mono)', WebkitTapHighlightColor: 'transparent', flexShrink: 0 }}>{label}</button>
              ))}
              {/* Ctrl+C separated on the right — destructive action */}
              <button onClick={() => sendToAgent('\x03')} style={{ marginLeft: 'auto', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '6px', color: '#fbbf24', padding: '8px 12px', fontSize: '11px', fontWeight: '700', cursor: 'pointer', fontFamily: 'var(--font-mono)', WebkitTapHighlightColor: 'transparent', flexShrink: 0 }}>⌃C</button>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* ── Agent Terminal (inline card) ─────────────────────────────────────── */}
      {hasTerminalSession && (
        <div className="double-bezel-card" style={{ marginTop: '16px' }}>
          <div className="double-bezel-card-inner" style={{ padding: '12px' }}>
            {/* Header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-secondary)', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Terminal size={12} style={{ color: 'var(--accent-color)' }} />
                Agent Output
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {running && <Loader className="animate-spin" size={12} style={{ color: 'var(--accent-color)' }} />}
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusText}</span>
                {/* Expand to fullscreen */}
                <button
                  onClick={() => setTermFullscreen(true)}
                  title="Expand fullscreen"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glow)', borderRadius: '6px', color: 'var(--text-secondary)', padding: '4px 10px', fontSize: '11px', cursor: 'pointer' }}
                >
                  ⛶ Full
                </button>
                {running ? (
                  <button onClick={cancelAgent} style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px', color: '#f87171', padding: '4px 8px', fontSize: '11px', fontWeight: '700', cursor: 'pointer' }}>Stop</button>
                ) : (
                  <button onClick={() => { setHasTerminalSession(false); if (termInstanceRef.current) { termInstanceRef.current.dispose(); termInstanceRef.current = null; } }} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glow)', borderRadius: '6px', color: 'var(--text-secondary)', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' }}>Close</button>
                )}
              </div>
            </div>

            {/* Terminal container — xterm manages its own scroll internally */}
            <div
              style={{
                height: termFullscreen ? '1px' : '320px',
                border: '1px solid var(--border-glow)',
                borderRadius: '8px',
                overflow: 'hidden',
                background: '#070709',
                cursor: 'text',
                visibility: termFullscreen ? 'hidden' : 'visible',
              }}
              onClick={() => termInstanceRef.current?.focus()}
            >
              <div
                ref={termContainerRef}
                style={{
                  padding: '8px',
                  height: '100%',
                }}
              />
            </div>

            {/* Reply bar — always shown while running, inline view only */}
            {running && !termFullscreen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: '700', flexShrink: 0 }}>Reply:</span>
                {[
                  { label: 'Yes',     value: 'y\r',      color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.25)' },
                  { label: 'No',      value: 'n\r',      color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
                  { label: '↵',       value: '\r',        color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
                  { label: '↑',       value: '\x1b[A',   color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
                  { label: '↓',       value: '\x1b[B',   color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.05)', border: 'var(--border-glow)' },
                ].map(({ label, value, color, bg, border }) => (
                  <button key={label} onMouseDown={e => e.preventDefault()} onClick={() => sendToAgent(value)} style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', color, padding: '8px 12px', fontSize: '13px', fontWeight: '700', cursor: 'pointer', fontFamily: 'var(--font-mono)', userSelect: 'none', WebkitTapHighlightColor: 'transparent', flexShrink: 0 }}>{label}</button>
                ))}
                {/* Ctrl+C pushed right */}
                <button onClick={() => sendToAgent('\x03')} style={{ marginLeft: 'auto', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '6px', color: '#fbbf24', padding: '8px 12px', fontSize: '11px', fontWeight: '700', cursor: 'pointer', fontFamily: 'var(--font-mono)', userSelect: 'none', WebkitTapHighlightColor: 'transparent', flexShrink: 0 }}>⌃C</button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
