import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Shield, RefreshCcw, ExternalLink } from 'lucide-react';

export default function PreviewTab({ apiHost, wsHost, token, activeWorkspace }) {
  const [port, setPort] = useState('3000');
  const [previewUrl, setPreviewUrl] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);
  const wsRef = useRef(null);
  const logsEndRef = useRef(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Connect to the terminal stream for the dev server (term-1 or dynamic)
  // To keep logs synchronized, we connect to the WebSocket stream of the first terminal session
  useEffect(() => {
    if (!activeWorkspace) return;

    if (wsRef.current) wsRef.current.close();
    setLogs([]);

    // We stream logs from 'term-1' which is the default terminal session where npm run dev is run
    const wsUrl = `${wsHost}/ws/terminal/term-1?workspace=${encodeURIComponent(activeWorkspace)}&token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'data') {
          setLogs(prev => [...prev, payload.data]);
        }
      } catch (err) {
        setLogs(prev => [...prev, event.data]);
      }
    };

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [activeWorkspace]);

  const handleReload = () => {
    // Force iframe reload by appending timestamp
    setPreviewUrl(`${apiHost}/preview/${port}/?t=${Date.now()}`);
  };

  useEffect(() => {
    if (port) {
      setPreviewUrl(`${apiHost}/preview/${port}/`);
    }
  }, [port, apiHost]);

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Please select a workspace to launch previews.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingBottom: '0' }}>
      <div className="eyebrow-badge">Live Sandbox</div>
      
      {/* Port Config and Controls */}
      <div className="double-bezel-card" style={{ marginBottom: '12px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justify: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '700' }}>PORT:</span>
              <input
                type="number"
                className="input-field"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                style={{ width: '80px', padding: '6px 10px', height: '32px', fontSize: '13px', marginBottom: '0' }}
              />
            </div>
            
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={handleReload}
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-glow)',
                  borderRadius: '8px',
                  padding: '6px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Reload Preview"
              >
                <RefreshCcw size={14} />
              </button>
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid var(--border-accent)',
                  borderRadius: '8px',
                  padding: '6px',
                  color: 'var(--accent-color)',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Open in new tab"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Embedded Live IFrame Container */}
      <div className="double-bezel-card" style={{ flex: 1, minHeight: '340px', position: 'relative', marginBottom: '16px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '0', height: '100%', minHeight: '324px', overflow: 'hidden', position: 'relative', borderRadius: '18px' }}>
          {previewUrl ? (
            <iframe
              src={previewUrl}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: '#ffffff',
                borderRadius: '16px'
              }}
              title="Live Preview"
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
              No port active
            </div>
          )}

          {/* Secure Tunnel Badge overlay */}
          <div style={{
            position: 'absolute',
            top: '12px',
            left: '12px',
            background: 'rgba(5, 5, 5, 0.85)',
            border: '1px solid var(--border-glow)',
            padding: '4px 8px',
            borderRadius: '99px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '9px',
            color: 'var(--text-secondary)',
            backdropFilter: 'blur(4px)',
            pointerEvents: 'none'
          }}>
            <Shield size={10} style={{ color: 'var(--accent-color)' }} />
            <span>Tunneled connection</span>
          </div>
        </div>
      </div>

      {/* Collapsible Console Logs Overlay at bottom */}
      <div style={{
        background: 'rgba(18, 18, 18, 0.95)',
        borderTop: '1px solid var(--border-glow)',
        borderBottom: 'none',
        position: 'fixed',
        bottom: '90px', // Right above the bottom navbar
        left: '16px',
        right: '16px',
        borderRadius: '16px 16px 0 0',
        zIndex: 50,
        boxShadow: '0 -10px 20px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: showLogs ? '240px' : '40px',
        transition: 'max-height 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        {/* Drawer header / click to toggle */}
        <div
          onClick={() => setShowLogs(!showLogs)}
          style={{
            height: '40px',
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            borderBottom: showLogs ? '1px solid var(--border-glow)' : 'none'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={14} style={{ color: 'var(--accent-color)' }} />
            <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Terminal logs (Shell 1)
            </span>
          </div>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            {showLogs ? 'Tap to Collapse' : 'Tap to Expand'}
          </span>
        </div>

        {/* Scrollable console logs */}
        {showLogs && (
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px',
            background: '#070707',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: '#a1a1aa',
            lineHeight: '1.5'
          }}>
            {logs.map((log, index) => (
              <span key={index} style={{ whiteSpace: 'pre-wrap' }}>{log}</span>
            ))}
            {logs.length === 0 && <span style={{ color: 'var(--text-muted)' }}>Idle. Waiting for output from Shell 1...</span>}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
