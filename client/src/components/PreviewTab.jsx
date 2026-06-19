import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield, RefreshCcw, ExternalLink, Layers,
  Zap, Server, Globe, Settings, CheckCircle2
} from 'lucide-react';

const STACK_ICONS = {
  vite:    { label: 'Vite',     color: '#a78bfa' },
  nextjs:  { label: 'Next.js',  color: '#ffffff' },
  cra:     { label: 'CRA',      color: '#61dafb' },
  express: { label: 'Express',  color: '#6ee7b7' },
  fastify: { label: 'Fastify',  color: '#f59e0b' },
  flask:   { label: 'Flask',    color: '#fb923c' },
  fastapi: { label: 'FastAPI',  color: '#34d399' },
  django:  { label: 'Django',   color: '#4ade80' },
  hono:    { label: 'Hono',     color: '#f97316' },
  koa:     { label: 'Koa',      color: '#94a3b8' },
};

export default function PreviewTab({ apiHost, token, activeWorkspace }) {
  const [topology, setTopology]         = useState(null);
  const [detecting, setDetecting]       = useState(false);
  const [previewUrl, setPreviewUrl]     = useState('');
  const [showConfig, setShowConfig]     = useState(false);
  const [iframeKey, setIframeKey]       = useState(0);
  const [manualFrontend, setManualFrontend] = useState('');
  const [manualBackend,  setManualBackend]  = useState('');
  const [manualPrefix,   setManualPrefix]   = useState('/api');
  const [saving, setSaving]             = useState(false);
  const [killing, setKilling]           = useState(false);
  const [saveMsg, setSaveMsg]           = useState('');
  const [patching, setPatching]         = useState(false);
  const [patchMsg, setPatchMsg]         = useState('');
  const [iframeLoading, setIframeLoading] = useState(false);
  const [iframeError, setIframeError]   = useState('');
  const manuallyConfigured = useRef(false); // true once user clicks Apply

  // ── Fetch topology (stack + registered services) ──────────────────────────
  const fetchTopology = useCallback(async () => {
    if (!activeWorkspace) return;
    setDetecting(true);
    try {
      // 1. Ask detect-port to find running processes and auto-register them
      const detectRes = await fetch(
        `${apiHost}/api/workspaces/detect-port?workspace=${encodeURIComponent(activeWorkspace)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (detectRes.ok) {
        const detectData = await detectRes.json();
        if (detectData.ports && detectData.ports.length > 0) {
          // Ports were found and auto-registered — now pull the full topology
        }
      }

      // 2. Fetch full topology (stack detection + registered ports + gateway URL)
      const topoRes = await fetch(
        `${apiHost}/api/workspaces/topology?workspace=${encodeURIComponent(activeWorkspace)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (topoRes.ok) {
        const topoData = await topoRes.json();
        setTopology(topoData);

        // Seed manual fields from current registration
        if (topoData.services) {
          setManualFrontend(topoData.services.frontend?.toString() || '');
          setManualBackend(topoData.services.backend?.toString()   || '');
          setManualPrefix(topoData.services.backendPrefix           || '/api');
        }

        // Only update the preview URL from auto-detect if the user hasn't
        // manually configured a port yet (to prevent poll from wiping manual input)
        if (!manuallyConfigured.current) {
          if (topoData.services?.frontend || topoData.services?.backend) {
            setPreviewUrl(
              `${apiHost}${topoData.gateway}?token=${encodeURIComponent(token)}`
            );
          } else if (topoData.services?.frontend) {
            setPreviewUrl(
              `${apiHost}/preview/${topoData.services.frontend}/?token=${encodeURIComponent(token)}`
            );
          }
        }
      }
    } catch (err) {
      console.error('Topology fetch failed:', err);
    } finally {
      setDetecting(false);
    }
  }, [activeWorkspace, apiHost, token]);

  useEffect(() => {
    fetchTopology();
    const interval = setInterval(fetchTopology, 4000);
    return () => clearInterval(interval);
  }, [fetchTopology]);

  // Set loading state when preview URL changes
  useEffect(() => {
    if (previewUrl) {
      setIframeLoading(true);
      setIframeError('');

      // Auto-clear loading state after 5 seconds to prevent getting stuck if background connections (like HMR) hang the load event
      const timer = setTimeout(() => {
        setIframeLoading(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [previewUrl]);

  // ── Save manual service registration ──────────────────────────────────────
  const handleSaveServices = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/register-service`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace:     activeWorkspace,
          frontend:      manualFrontend ? parseInt(manualFrontend, 10) : null,
          backend:       manualBackend  ? parseInt(manualBackend,  10) : null,
          backendPrefix: manualPrefix   || '/api',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSaveMsg('✓ Saved');
        manuallyConfigured.current = true;
        setTopology(prev => ({ ...prev, services: data.services, gateway: data.gateway }));
        setPreviewUrl(`${apiHost}${data.gateway}?token=${encodeURIComponent(token)}`);
        setIframeKey(k => k + 1);
        setTimeout(() => setSaveMsg(''), 2500);
      } else {
        setSaveMsg('✗ Failed');
      }
    } catch {
      setSaveMsg('✗ Error');
    } finally {
      setSaving(false);
    }
  };

  const handleKillPorts = async () => {
    setKilling(true);
    setSaveMsg('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/kill-ports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: activeWorkspace,
          ports: [
            manualFrontend ? parseInt(manualFrontend, 10) : null,
            manualBackend ? parseInt(manualBackend, 10) : null,
          ].filter(Boolean)
        })
      });
      if (res.ok) {
        setSaveMsg('✓ Ports freed');
        setTimeout(() => setSaveMsg(''), 2500);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveMsg(`✗ ${data.error || 'Failed'}`);
        setTimeout(() => setSaveMsg(''), 2500);
      }
    } catch {
      setSaveMsg('✗ Error');
      setTimeout(() => setSaveMsg(''), 2500);
    } finally {
      setKilling(false);
    }
  };

  const handleReload = () => {
    setIframeLoading(true);
    setIframeError('');
    setIframeKey(k => k + 1);
  };

  const handleIframeLoad = () => {
    setIframeLoading(false);
    setIframeError('');
  };

  const handleIframeError = () => {
    setIframeLoading(false);
    setIframeError('Failed to load preview. Check if dev server is running.');
  };

  const handlePatchNextConfig = async () => {
    if (!topology?.services?.frontend) return;
    setPatching(true);
    setPatchMsg('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/patch-nextconfig`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: activeWorkspace, port: topology.services.frontend }),
      });
      const data = await res.json();
      if (res.ok) {
        setPatchMsg(`✓ Patched ${data.file} — restart your dev server`);
      } else {
        setPatchMsg(`✗ ${data.error}`);
      }
    } catch {
      setPatchMsg('✗ Error');
    } finally {
      setPatching(false);
      setTimeout(() => setPatchMsg(''), 6000);
    }
  };

  const hasServices = topology?.services?.frontend || topology?.services?.backend;
  const stack       = topology?.stack || [];
  const isNextJs    = stack.includes('nextjs');

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Select a workspace to use Live Preview.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingBottom: 0 }}>
      <div className="eyebrow-badge">
        <Layers size={10} style={{ marginRight: 4 }} />
        Workspace Gateway
      </div>

      {/* ── Topology header card ─────────────────────────────────────────── */}
      <div className="double-bezel-card" style={{ marginBottom: 10 }}>
        <div className="double-bezel-card-inner" style={{ padding: '10px 14px' }}>

          {/* Stack badges */}
          {stack.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {stack.map(s => {
                const info = STACK_ICONS[s] || { label: s, color: '#94a3b8' };
                return (
                  <span key={s} style={{
                    background: `${info.color}18`,
                    border: `1px solid ${info.color}55`,
                    color: info.color,
                    borderRadius: 99, padding: '2px 8px',
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
                  }}>
                    {info.label}
                  </span>
                );
              })}
            </div>
          )}

          {/* Service rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Frontend service */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Globe size={12} style={{ color: '#a78bfa', flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700, width: 62 }}>FRONTEND</span>
              {topology?.services?.frontend ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <span style={{ fontSize: 11, color: '#a78bfa', fontFamily: 'var(--font-mono)' }}>
                    :{topology.services.frontend}
                  </span>
                  {isNextJs && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                      <button
                        onClick={handlePatchNextConfig}
                        disabled={patching}
                        title="Auto-patch next.config.js"
                        style={{
                          background: 'rgba(217, 119, 6, 0.12)',
                          border: '1px solid rgba(217, 119, 6, 0.35)',
                          borderRadius: 6,
                          color: '#fbbf24',
                          padding: '0 8px',
                          height: 22,
                          fontSize: 10,
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {patching ? <RefreshCcw size={8} style={{ animation: 'spin 1s linear infinite' }} /> : '⚡'}
                        {patching ? 'Patching…' : 'Patch NextConfig'}
                      </button>
                      {patchMsg && (
                        <span style={{ fontSize: 9, fontWeight: 600, color: patchMsg.startsWith('✓') ? '#34d399' : '#f87171' }}>
                          {patchMsg}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {detecting ? 'scanning…' : 'not detected'}
                </span>
              )}
            </div>
            {/* Backend service */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Server size={12} style={{ color: '#34d399', flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700, width: 62 }}>BACKEND</span>
              {topology?.services?.backend ? (
                <span style={{ fontSize: 11, color: '#34d399', fontFamily: 'var(--font-mono)' }}>
                  :{topology.services.backend}
                </span>
              ) : (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {detecting ? 'scanning…' : 'none registered'}
                </span>
              )}
            </div>
          </div>

          {/* Gateway URL + controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-glow)' }}>
            <Zap size={11} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700 }}>GATEWAY</span>
            <span style={{
              flex: 1, fontSize: 10, color: hasServices ? 'var(--accent-color)' : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {hasServices ? (topology?.gateway || `/gateway/${activeWorkspace}/`) : 'start a server first'}
            </span>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={handleReload}
                title="Reload preview"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-glow)', borderRadius: 6, padding: 5, color: 'var(--text-primary)', cursor: 'pointer', display: 'flex' }}
              >
                <RefreshCcw size={12} />
              </button>
              {previewUrl && (
                <a
                  href={previewUrl} target="_blank" rel="noreferrer"
                  style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid var(--border-accent)', borderRadius: 6, padding: 5, color: 'var(--accent-color)', display: 'flex' }}
                  title="Open in browser"
                >
                  <ExternalLink size={12} />
                </a>
              )}
              <button
                onClick={() => setShowConfig(v => !v)}
                title="Configure services"
                style={{
                  background: showConfig ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${showConfig ? '#a78bfa88' : 'var(--border-glow)'}`,
                  borderRadius: 6, padding: 5, color: showConfig ? '#a78bfa' : 'var(--text-muted)', cursor: 'pointer', display: 'flex',
                }}
              >
                <Settings size={12} />
              </button>
            </div>
          </div>

          {/* ── Config drawer ────────────────────────────────────────────── */}
          {showConfig && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-glow)' }}>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
                Manually assign ports when auto-detect can't match them to this workspace:
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>FRONTEND PORT</span>
                  <input
                    type="number" placeholder="3000" value={manualFrontend}
                    onChange={e => setManualFrontend(e.target.value)}
                    className="input-field"
                    style={{ width: 80, padding: '4px 8px', height: 28, fontSize: 12, marginBottom: 0 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>BACKEND PORT</span>
                  <input
                    type="number" placeholder="8000" value={manualBackend}
                    onChange={e => setManualBackend(e.target.value)}
                    className="input-field"
                    style={{ width: 80, padding: '4px 8px', height: 28, fontSize: 12, marginBottom: 0 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700 }}>API PREFIX</span>
                  <input
                    type="text" placeholder="/api" value={manualPrefix}
                    onChange={e => setManualPrefix(e.target.value)}
                    className="input-field"
                    style={{ width: 70, padding: '4px 8px', height: 28, fontSize: 12, marginBottom: 0 }}
                  />
                </label>
                <button
                  onClick={handleSaveServices}
                  disabled={saving}
                  style={{
                    height: 28, padding: '0 12px', fontSize: 11, fontWeight: 700,
                    background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
                    border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                  }}
                >
                  {saving ? <RefreshCcw size={10} /> : <CheckCircle2 size={10} />}
                  {saving ? 'Saving…' : 'Apply'}
                </button>
                <button
                  onClick={handleKillPorts}
                  disabled={killing}
                  style={{
                    height: 28, padding: '0 12px', fontSize: 11, fontWeight: 700,
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: 6, color: '#f87171', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                  }}
                >
                  {killing ? <RefreshCcw size={10} style={{ animation: 'spin 1s linear infinite' }} /> : <Shield size={10} />}
                  {killing ? 'Killing…' : 'Kill Ports'}
                </button>
                {saveMsg && (
                  <span style={{ fontSize: 11, color: saveMsg.startsWith('✓') ? '#34d399' : '#f87171', fontWeight: 700 }}>
                    {saveMsg}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 8 }}>
                Gateway routes each port isolated at <code style={{ color: '#a78bfa' }}>/gateway/:workspace/port/:port/</code>.
                Any client-side fetch/XHR calls targeting localhost ports are automatically rewritten to route through the gateway.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Next.js description banner removed, button moved to frontend row */}

      {/* ── Iframe preview ───────────────────────────────────────────────────── */}
      <div className="double-bezel-card" style={{ flex: 1, minHeight: 300, position: 'relative', marginBottom: 16 }}>
        <div className="double-bezel-card-inner" style={{ padding: 0, height: '100%', minHeight: 284, overflow: 'hidden', position: 'relative', borderRadius: 18 }}>
          {previewUrl ? (
            <>
              <iframe
                key={iframeKey}
                src={previewUrl}
                style={{ width: '100%', height: '100%', border: 'none', background: '#fff', borderRadius: 16 }}
                title="Live Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation allow-presentation"
                onLoad={handleIframeLoad}
                onError={handleIframeError}
              />

              {/* Loading indicator */}
              {iframeLoading && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(255,255,255,0.9)', zIndex: 10,
                }}>
                  <RefreshCcw size={24} style={{ color: '#a78bfa', animation: 'spin 1s linear infinite' }} />
                </div>
              )}

              {/* Error message */}
              {iframeError && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.8)', zIndex: 10, padding: 20,
                }}>
                  <div style={{ textAlign: 'center', color: '#fff' }}>
                    <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{iframeError}</p>
                    <button
                      onClick={handleReload}
                      style={{
                        background: '#a78bfa', border: 'none', borderRadius: 6,
                        padding: '8px 16px', color: '#fff', cursor: 'pointer',
                        fontSize: 12, fontWeight: 600,
                      }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {/* Shield badge */}
              <div style={{
                position: 'absolute', top: 10, left: 10,
                background: 'rgba(5,5,5,0.85)', border: '1px solid var(--border-glow)',
                padding: '3px 8px', borderRadius: 99,
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 9, color: 'var(--text-secondary)',
                backdropFilter: 'blur(4px)', pointerEvents: 'none',
              }}>
                <Shield size={9} style={{ color: 'var(--accent-color)' }} />
                <span>Gateway proxy</span>
              </div>

              {/* Open in browser */}
              <a
                href={previewUrl} target="_blank" rel="noreferrer"
                style={{
                  position: 'absolute', bottom: 10, right: 10,
                  background: 'rgba(5,5,5,0.9)', border: '1px solid var(--border-accent)',
                  padding: '7px 13px', borderRadius: 99,
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, fontWeight: 700, color: 'var(--accent-color)',
                  textDecoration: 'none', backdropFilter: 'blur(8px)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                }}
              >
                <ExternalLink size={11} />
                Open in browser
              </a>
            </>
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, padding: 24,
            }}>
              <Zap size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', margin: 0 }}>
                No services running
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', margin: 0, maxWidth: 260, lineHeight: 1.6 }}>
                Start your dev server from the <strong>Terminal</strong> tab, then come back here.
                Ports are detected automatically.
              </p>
              <div style={{
                background: '#0d0d0d', border: '1px solid var(--border-glow)',
                borderRadius: 8, padding: '10px 14px', fontSize: 10,
                fontFamily: 'var(--font-mono)', color: '#6ee7b7',
                textAlign: 'left', width: '100%', maxWidth: 280,
              }}>
                <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>$ open Terminal tab, then:</div>
                <div>npm run dev      <span style={{ color: '#a78bfa' }}># Vite/Next.js</span></div>
                <div>python main.py   <span style={{ color: '#34d399' }}># Flask/FastAPI</span></div>
                <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                  Or click <Settings size={9} style={{ display: 'inline', verticalAlign: 'middle' }} /> above to enter ports manually.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
