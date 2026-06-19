import React, { useState, useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { Play, Clipboard, RotateCcw, Plus, Trash2, ChevronRight, FileCode } from 'lucide-react';
import 'xterm/css/xterm.css';

export default function TerminalTab({ apiHost, wsHost, token, activeWorkspace, onTerminalData, problems = [], onSelectFile }) {
  const [sessions, setSessions] = useState(['shell-1']);
  const [activeSession, setActiveSession] = useState('shell-1');
  const [expandedFiles, setExpandedFiles] = useState({});
  const termContainers = useRef({}); // containers DOM nodes
  const termInstances = useRef({});  // XTerm instances
  const sockets = useRef({});        // Websocket references

  // Group problems by file path
  const groupedProblems = problems.reduce((groups, prob) => {
    const filePath = prob.file;
    if (!groups[filePath]) {
      groups[filePath] = [];
    }
    groups[filePath].push(prob);
    return groups;
  }, {});

  useEffect(() => {
    const filePaths = Object.keys(groupedProblems);
    setExpandedFiles(prev => {
      const next = { ...prev };
      filePaths.forEach(fp => {
        if (next[fp] === undefined) {
          next[fp] = true; // default expanded
        }
      });
      return next;
    });
  }, [problems]);

  const toggleFileGroup = (filePath) => {
    setExpandedFiles(prev => ({
      ...prev,
      [filePath]: !prev[filePath]
    }));
  };

  // Helper to spawn a terminal session
  const initTerminal = (sessionId, retryDelay = 1000) => {
    if (!activeWorkspace) return;

    // Clean up if already exists
    if (termInstances.current[sessionId]) {
      if (termInstances.current[sessionId]._touchCleanup) {
        termInstances.current[sessionId]._touchCleanup();
      }
      termInstances.current[sessionId].dispose();
    }
    if (sockets.current[sessionId]) {
      sockets.current[sessionId].close();
    }

    const container = termContainers.current[sessionId];
    if (!container) return;

    // Create XTerm instance with custom tech styling
    const term = new XTerm({
      cursorBlink: true,
      scrollback: 5000,
      cols: 220,
      rows: 24,
      theme: {
        background: '#0a0a0a',
        foreground: '#10b981', // green text
        cursor: '#10b981',
        selectionBackground: 'rgba(16, 185, 129, 0.3)'
      },
      fontSize: 12,
      fontFamily: 'var(--font-mono)',
      convertEol: true,
    });

    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // Ensure cursor is visible when user interacts with terminal
    const ensureCursorVisible = () => {
      term.focus();
      // Force cursor to be visible by resetting cursor blink
      term.cursorBlink = true;
    };

    container.addEventListener('touchstart', ensureCursorVisible, { passive: true });
    container.addEventListener('focus', ensureCursorVisible);
    container.addEventListener('click', ensureCursorVisible);

    // iOS touch scrollback: translate swipe gestures into XTerm scroll
    let touchStartX = 0;
    let touchStartY = 0;
    const onTouchStart = (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    };
    const onTouchMove = (e) => {
      const dx = touchStartX - e.touches[0].clientX;
      const dy = touchStartY - e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      
      // Determine dominant direction of swipe
      const isHorizontal = Math.abs(dx) > Math.abs(dy);
      
      if (isHorizontal) {
        // Horizontal scroll - each ~20px of swipe = scroll viewport
        const scrollAmount = dx * 2; // Multiplier for smoother horizontal scroll
        term.element.scrollLeft += scrollAmount;
        e.preventDefault();
      } else {
        // Vertical scroll - each ~20px of swipe = 1 line scroll
        const lines = Math.round(dy / 20);
        if (lines !== 0) {
          term.scrollLines(lines);
          e.preventDefault();
        }
      }
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    // Store cleanup refs on the term object
    term._touchCleanup = () => {
      container.removeEventListener('touchstart', ensureCursorVisible);
      container.removeEventListener('focus', ensureCursorVisible);
      container.removeEventListener('click', ensureCursorVisible);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
    };

    // Focus so keyboard input is captured immediately
    setTimeout(() => term.focus(), 80);

    term.write('Connecting to persistent terminal server...\n');
    termInstances.current[sessionId] = term;

    // Connect WebSocket
    const wsUrl = `${wsHost}/ws/terminal/${sessionId}?workspace=${encodeURIComponent(activeWorkspace)}&token=${token}`;
    const ws = new WebSocket(wsUrl);
    sockets.current[sessionId] = ws;

    ws.onopen = () => {
      // Reset retry delay on successful connection
      sockets.current[sessionId]._retryDelay = 1000;

      // Send actual XTerm dimensions to the server so the PTY cols/rows match
      // what the user sees. This prevents garbled line-wrapping on wide terminals.
      const term = termInstances.current[sessionId];
      if (term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'data') {
          term.write(payload.data);
          if (onTerminalData) {
            onTerminalData(sessionId, payload.data);
          }
        } else if (payload.type === 'exit') {
          term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
        } else if (payload.type === 'error') {
          // Server rejected this session (e.g. workspace path not found).
          // Show it clearly so the user knows what's wrong instead of a blank green cursor.
          term.write(`\r\n\x1b[31m[Server error]\x1b[0m ${payload.data || ''}\r\n`);
        }
      } catch (err) {
        term.write(event.data);
        if (onTerminalData) {
          onTerminalData(sessionId, event.data);
        }
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    ws.onclose = () => {
      if (document.hidden) {
        // Tab is in background — reconnect when visible again
        const onVisible = () => {
          document.removeEventListener('visibilitychange', onVisible);
          if (sockets.current[sessionId] === ws) {
            initTerminal(sessionId, 1000);
          }
        };
        document.addEventListener('visibilitychange', onVisible);
        return;
      }
      // Tab is visible — reconnect with backoff
      const delay = Math.min((ws._retryDelay || 1000) * 1.5, 15000);
      term.write(`\r\n[Reconnecting in ${Math.round(delay / 1000)}s...]\r\n`);
      setTimeout(() => {
        if (sockets.current[sessionId] === ws) {
          initTerminal(sessionId, delay);
        }
      }, delay);
    };

    ws.onerror = () => {
      term.write('\r\n[Connection Error]');
    };

    ws._retryDelay = retryDelay;
  };

  useEffect(() => {
    if (activeWorkspace && activeSession !== 'problems') {
      initTerminal(activeSession);
    }

    return () => {
      // Clean up all sessions on unmount
      Object.keys(termInstances.current).forEach(id => {
        if (termInstances.current[id]._touchCleanup) {
          termInstances.current[id]._touchCleanup();
        }
        termInstances.current[id].dispose();
      });
      Object.keys(sockets.current).forEach(id => {
        sockets.current[id].close();
      });
    };
  }, [activeWorkspace, activeSession]);

  // Re-focus the terminal whenever switching to a shell session
  useEffect(() => {
    if (activeSession !== 'problems' && termInstances.current[activeSession]) {
      setTimeout(() => termInstances.current[activeSession]?.focus(), 80);
    }
  }, [activeSession]);

  const addSession = () => {
    let idx = 1;
    while (sessions.includes(`shell-${idx}`)) {
      idx++;
    }
    const newId = `shell-${idx}`;
    setSessions(prev => [...prev, newId]);
    setActiveSession(newId);
  };

  const removeSession = (id, e) => {
    e.stopPropagation();
    if (sessions.length === 1) return; // keep at least one

    // Clean up
    if (termInstances.current[id]) {
      termInstances.current[id].dispose();
      delete termInstances.current[id];
    }
    if (sockets.current[id]) {
      sockets.current[id].close();
      delete sockets.current[id];
    }

    const nextSessions = sessions.filter(s => s !== id);
    setSessions(nextSessions);
    if (activeSession === id) {
      setActiveSession(nextSessions[0]);
    }
  };

  const runQuickCommand = (cmdText) => {
    const ws = sockets.current[activeSession];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: `${cmdText}\r` }));
    }
  };

  const handleGithubAuth = async () => {
    const term = termInstances.current[activeSession];
    if (term) {
      term.write(`\r\n\x1b[35m[GitHub Auth] Connecting credentials...\x1b[0m\r\n`);
    }
    try {
      const res = await fetch(`${apiHost}/api/git/github-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ workspace: activeWorkspace })
      });
      const data = await res.json();
      if (res.ok) {
        if (term) {
          term.write(`\x1b[32m[GitHub Auth] ✓ ${data.log || 'Success'}\x1b[0m\r\n`);
        }
      } else {
        if (term) {
          term.write(`\x1b[31m[GitHub Auth Error] ✗ ${data.error || 'Failed'}\x1b[0m\r\n`);
        }
      }
    } catch (err) {
      if (term) {
        term.write(`\x1b[31m[GitHub Auth Error] ✗ Connection failed: ${err.message}\x1b[0m\r\n`);
      }
    }
  };

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Please select a workspace to launch terminals.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', paddingBottom: '120px' }}>
      <div className="eyebrow-badge">Virtual Shells</div>
      <h2 className="section-title" style={{ marginBottom: 4 }}>Persistent Terminals</h2>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>Directory:</span>
        <span style={{ color: 'var(--accent-color)' }}>/{activeWorkspace}</span>
      </div>

      {/* Terminal tabs selectors */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', overflowX: 'auto', overflowY: 'hidden', padding: '8px 4px', minHeight: '48px', width: '100%' }}>
        {sessions.map((id, index) => {
          const isActive = activeSession === id;
          return (
            <div
              key={id}
              onClick={() => setActiveSession(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: isActive ? 'var(--bg-card-inner)' : 'transparent',
                border: '1px solid',
                borderColor: isActive ? 'var(--accent-color)' : 'var(--border-glow)',
                color: isActive ? 'var(--accent-color)' : 'var(--text-secondary)',
                padding: '6px 12px',
                borderRadius: '16px',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              <span>Shell {index + 1}</span>
              {sessions.length > 1 && (
                <button
                  onClick={(e) => removeSession(id, e)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                >
                  <Trash2 size={12} hover={{ color: '#ef4444' }} />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={addSession}
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border-glow)',
            color: 'var(--text-primary)',
            padding: '6px',
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: '8px'
          }}
        >
          <Plus size={14} />
        </button>

        {/* Problems selector tab pushed to the right */}
        <div
          onClick={() => setActiveSession('problems')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: activeSession === 'problems' ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
            border: '1px solid',
            borderColor: activeSession === 'problems' ? '#ef4444' : 'var(--border-glow)',
            color: activeSession === 'problems' ? '#f87171' : 'var(--text-secondary)',
            padding: '6px 12px',
            borderRadius: '16px',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            marginLeft: 'auto'
          }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: problems.length > 0 ? '#ef4444' : 'var(--text-muted)' }} />
          <span>Problems ({problems.length})</span>
        </div>
      </div>

      {/* Quick Action Commands Panel */}
      <div className="double-bezel-card" style={{ marginBottom: '12px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '12px' }}>
          <span style={{ fontSize: '10px', textTransform: 'uppercase', tracking: '1px', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px', fontWeight: '700' }}>
            Quick Actions
          </span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => runQuickCommand('npm run dev -- -p 3000')}
              style={{
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid var(--border-accent)',
                color: 'var(--accent-color)',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              npm run dev
            </button>
            <button
              onClick={() => runQuickCommand('npm test')}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-glow)',
                color: 'var(--text-primary)',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              npm test
            </button>
            <button
              onClick={() => runQuickCommand('git status')}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-glow)',
                color: 'var(--text-primary)',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              git status
            </button>
            <button
              onClick={() => runQuickCommand('npm install')}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-glow)',
                color: 'var(--text-primary)',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              npm i
            </button>
            <button
              onClick={handleGithubAuth}
              style={{
                background: 'rgba(167, 139, 250, 0.12)',
                border: '1px solid rgba(167, 139, 250, 0.35)',
                color: '#c084fc',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              🔑 GitHub Auth
            </button>
            <button
              onClick={() => runQuickCommand('\x03')}
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                fontSize: '11px',
                fontWeight: '600',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)'
              }}
            >
              Ctrl+C
            </button>
          </div>
        </div>
      </div>

      {/* Terminal View Container */}
      <div className="double-bezel-card" style={{ height: '400px', background: '#0a0a0a', display: 'flex', flexDirection: 'column' }}>
        <div className="double-bezel-card-inner" style={{ padding: '8px', flex: 1, background: '#0a0a0a', overflow: activeSession === 'problems' ? 'auto' : 'hidden' }}>
          {activeSession === 'problems' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px' }}>
              {problems.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  No compilation or lint errors detected in terminal streams.
                </div>
              ) : (
                Object.keys(groupedProblems).map((filePath) => {
                  const fileIssues = groupedProblems[filePath];
                  const isExpanded = expandedFiles[filePath] !== false; // default true
                  const errorsCount = fileIssues.filter(i => i.type === 'error').length;
                  const warningsCount = fileIssues.filter(i => i.type === 'warning').length;

                  return (
                    <div key={filePath} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-glow)', borderRadius: '8px', overflow: 'hidden' }}>
                      {/* File Group Header */}
                      <div
                        onClick={() => toggleFileGroup(filePath)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          background: 'rgba(255,255,255,0.02)',
                          borderBottom: isExpanded ? '1px solid var(--border-glow)' : 'none',
                          cursor: 'pointer',
                          userSelect: 'none'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '70%', overflow: 'hidden' }}>
                          <ChevronRight
                            size={12}
                            style={{
                              color: 'var(--text-secondary)',
                              transform: isExpanded ? 'rotate(90deg)' : 'none',
                              transition: 'transform 0.15s',
                              flexShrink: 0
                            }}
                          />
                          <FileCode size={14} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
                          <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {filePath.split('/').pop()}
                          </span>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {filePath}
                          </span>
                        </div>

                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          {errorsCount > 0 && (
                            <span style={{ fontSize: '9px', fontWeight: '700', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', padding: '2px 6px', borderRadius: '4px' }}>
                              {errorsCount}
                            </span>
                          )}
                          {warningsCount > 0 && (
                            <span style={{ fontSize: '9px', fontWeight: '700', background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', padding: '2px 6px', borderRadius: '4px' }}>
                              {warningsCount}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* File Group Issues List */}
                      {isExpanded && (
                        <div style={{ display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.2)' }}>
                          {fileIssues.map((prob) => (
                            <div
                              key={prob.id}
                              onClick={() => onSelectFile && onSelectFile(prob.file, prob.line)}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '10px',
                                padding: '8px 12px',
                                borderBottom: '1px solid rgba(255,255,255,0.02)',
                                cursor: 'pointer',
                                transition: 'background 0.2s',
                                textAlign: 'left'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                              <span style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: prob.type === 'error' ? '#ef4444' : '#f59e0b',
                                marginTop: '6px',
                                flexShrink: 0
                              }} />

                              <span style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '10px',
                                color: 'var(--text-muted)',
                                padding: '1px 4px',
                                background: 'rgba(255,255,255,0.04)',
                                borderRadius: '3px',
                                marginTop: '2px',
                                flexShrink: 0
                              }}>
                                {prob.line}:{prob.column || 1}
                              </span>

                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                                <p style={{ fontSize: '11px', color: 'var(--text-primary)', lineHeight: '1.4', margin: 0, wordBreak: 'break-word' }}>
                                  {prob.msg}
                                </p>
                                <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {prob.rawLine}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            sessions.map((id) => (
              <div
                key={id}
                ref={(el) => (termContainers.current[id] = el)}
                onClick={() => termInstances.current[id]?.focus()}
                style={{
                  display: activeSession === id ? 'block' : 'none',
                  height: '100%',
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  background: '#0a0a0a',
                  cursor: 'text',
                  touchAction: 'pan-y',
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
