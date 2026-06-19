import React, { useState, useEffect } from 'react';
import { Folder, Plus, GitBranch, ArrowRight, Activity, Link2, Search, Lock, Globe, Code, RefreshCw, Check, Trash2 } from 'lucide-react';

export default function WorkspacesTab({ apiHost, token, activeWorkspace, onSelectWorkspace }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);

  // GitHub repos state
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [cloningRepo, setCloningRepo] = useState('');

  // Create / Clone States
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneFolder, setCloneFolder] = useState('');
  const [newProjectName, setNewProjectName] = useState('');

  // Custom Local Folder States
  const [customName, setCustomName] = useState('');
  const [customPath, setCustomPath] = useState('');

  const [cloning, setCloning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  // Active section
  const [activeSection, setActiveSection] = useState('github'); // 'github' | 'manual'
  const [manualSearch, setManualSearch] = useState('');

  const [modalConfig, setModalConfig] = useState(null);
  const [deleteFilesChecked, setDeleteFilesChecked] = useState(false);

  const handleDeleteWorkspace = async (workspaceName, deleteFiles) => {
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ workspace: workspaceName, deleteFiles })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      // If we deleted the currently active workspace, clear it
      if (activeWorkspace === workspaceName) {
        onSelectWorkspace('');
      }
      
      fetchWorkspaces();
      fetchRepos();
    } catch (err) {
      setError(err.message || 'Failed to delete workspace');
    }
  };

  const fetchWorkspaces = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorkspaces(data.workspaces || []);
    } catch (err) {
      setError(err.message || 'Failed to fetch workspaces');
    } finally {
      setLoading(false);
    }
  };

  const fetchRepos = async () => {
    setReposLoading(true);
    setReposError('');
    try {
      const res = await fetch(`${apiHost}/api/github/repos`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRepos(data.repos || []);
    } catch (err) {
      setReposError(err.message);
    } finally {
      setReposLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkspaces();
    fetchRepos();
  }, [apiHost, token]);

  const handleCloneRepo = async (repo) => {
    setCloningRepo(repo.name);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ repoUrl: repo.cloneUrl, folderName: repo.name })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Mark as cloned
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, cloned: true } : r));
      fetchWorkspaces();
      if (data.workspace) onSelectWorkspace(data.workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setCloningRepo('');
    }
  };

  const handleClone = async (e) => {
    e.preventDefault();
    if (!cloneUrl) return;
    setCloning(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ repoUrl: cloneUrl, folderName: cloneFolder })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCloneUrl(''); setCloneFolder('');
      fetchWorkspaces(); fetchRepos();
      if (data.workspace) onSelectWorkspace(data.workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setCloning(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newProjectName) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newProjectName })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNewProjectName('');
      fetchWorkspaces();
      if (data.workspace) onSelectWorkspace(data.workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!customName || !customPath) return;
    setRegistering(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: customName, absolutePath: customPath })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCustomName(''); setCustomPath('');
      fetchWorkspaces();
      if (data.workspace) onSelectWorkspace(data.workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setRegistering(false);
    }
  };

  const filteredRepos = repos.filter(r =>
    r.name.toLowerCase().includes(repoSearch.toLowerCase()) ||
    (r.description || '').toLowerCase().includes(repoSearch.toLowerCase())
  );

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  return (
    <div className="tab-panel" style={{ paddingBottom: '120px' }}>
      <div className="eyebrow-badge">WORKSPACE HUB</div>
      <h2 className="section-title">Projects</h2>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', padding: '10px 14px', color: '#f87171', fontSize: '12px', marginBottom: '16px' }}>
          {error}
        </div>
      )}

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button
          onClick={() => setActiveSection('github')}
          style={{
            flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: '700', cursor: 'pointer',
            background: activeSection === 'github' ? 'var(--accent-color)' : 'var(--bg-card)',
            color: activeSection === 'github' ? '#000' : 'var(--text-secondary)',
            border: 'none',
          }}
        >
          GitHub Repos
        </button>
        <button
          onClick={() => setActiveSection('manual')}
          style={{
            flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: '700', cursor: 'pointer',
            background: activeSection === 'manual' ? 'rgba(255,255,255,0.08)' : 'var(--bg-card)',
            color: activeSection === 'manual' ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border-glow)',
          }}
        >
          Manual
        </button>
      </div>

      {activeSection === 'github' && (
        <>
          {/* Search + refresh */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
              <input
                type="text"
                className="input-field"
                placeholder="Search repos..."
                value={repoSearch}
                onChange={e => setRepoSearch(e.target.value)}
                style={{ paddingLeft: '34px', height: '40px', fontSize: '13px' }}
              />
            </div>
            <button
              onClick={fetchRepos}
              disabled={reposLoading}
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-glow)', borderRadius: '10px', padding: '0 12px', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
              <RefreshCw size={14} className={reposLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          {reposError && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '12px 14px', color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>
              {reposError.includes('not configured') ? (
                <>Add <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '4px' }}>GITHUB_TOKEN</code> to your server <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '4px' }}>.env</code> to enable this.</>
              ) : reposError}
            </div>
          )}

          {reposLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '12px', padding: '20px 0' }}>
              <Activity size={14} className="animate-spin" style={{ color: 'var(--accent-color)' }} />
              Loading repos from GitHub...
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filteredRepos.length === 0 && !reposError && (
                <p className="text-sub">No repos found{repoSearch ? ` matching "${repoSearch}"` : ''}.</p>
              )}
              {filteredRepos.map(repo => {
                const isActive = activeWorkspace === repo.name;
                const isCloning = cloningRepo === repo.name;
                return (
                  <div
                    key={repo.name}
                    style={{
                      background: isActive ? 'rgba(0,255,102,0.05)' : 'var(--bg-card)',
                      border: `1px solid ${isActive ? 'var(--accent-color)' : 'var(--border-glow)'}`,
                      borderRadius: '12px',
                      padding: '12px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                    }}
                  >
                    {/* Icon */}
                    <div style={{ flexShrink: 0, color: repo.private ? 'var(--text-muted)' : 'var(--accent-color)' }}>
                      {repo.private ? <Lock size={15} /> : <Globe size={15} />}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '700', color: isActive ? 'var(--accent-color)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {repo.name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                        {repo.language && (
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <Code size={9} />
                            {repo.language}
                          </span>
                        )}
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{timeAgo(repo.pushedAt)}</span>
                      </div>
                    </div>

                    {/* Action button */}
                    {isActive ? (
                      <span style={{ fontSize: '10px', background: 'var(--accent-color)', color: '#000', padding: '3px 8px', borderRadius: '6px', fontWeight: '700', flexShrink: 0 }}>
                        ACTIVE
                      </span>
                    ) : repo.cloned ? (
                      <button
                        onClick={() => onSelectWorkspace(repo.name)}
                        style={{ background: 'rgba(0,255,102,0.08)', border: '1px solid rgba(0,255,102,0.2)', borderRadius: '8px', color: 'var(--accent-color)', padding: '6px 12px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Check size={12} />
                        Open
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCloneRepo(repo)}
                        disabled={!!cloningRepo}
                        style={{ background: 'var(--bg-card-inner)', border: '1px solid var(--border-glow)', borderRadius: '8px', color: 'var(--text-secondary)', padding: '6px 12px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px', opacity: cloningRepo && !isCloning ? 0.5 : 1 }}
                      >
                        {isCloning ? <Activity size={12} className="animate-spin" /> : <GitBranch size={12} />}
                        {isCloning ? 'Cloning...' : 'Clone'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {activeSection === 'manual' && (
        <>
          {/* Existing workspaces */}
          <div className="double-bezel-card">
            <div className="double-bezel-card-inner">
              <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '12px' }}>Active Workspaces</h3>
              {!loading && workspaces.length > 0 && (
                <div style={{ position: 'relative', marginBottom: '10px' }}>
                  <Search size={13} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    className="input-field"
                    placeholder="Search workspaces..."
                    value={manualSearch}
                    onChange={e => setManualSearch(e.target.value)}
                    style={{ paddingLeft: '34px', height: '36px', fontSize: '12px' }}
                  />
                </div>
              )}
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <Activity size={13} className="animate-spin" style={{ color: 'var(--accent-color)' }} />
                  Scanning...
                </div>
              ) : workspaces.length === 0 ? (
                <p className="text-sub">No workspaces yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                  {workspaces.filter(n => n.toLowerCase().includes(manualSearch.toLowerCase())).map(name => {
                    const isActive = activeWorkspace === name;
                    return (
                      <div
                        key={name}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 12px', borderRadius: '8px',
                          background: isActive ? 'rgba(0,255,102,0.08)' : 'rgba(255,255,255,0.02)',
                          border: isActive ? '1px solid var(--border-accent)' : '1px solid var(--border-glow)',
                        }}
                      >
                        <button
                          onClick={() => onSelectWorkspace(name)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: isActive ? 'var(--accent-color)' : 'var(--text-primary)',
                            fontSize: '13px', fontWeight: '600', textAlign: 'left',
                            display: 'flex', alignItems: 'center', gap: '8px',
                            cursor: 'pointer', flex: 1, padding: 0, outline: 'none'
                          }}
                        >
                          <Folder size={14} />
                          <span>{name}</span>
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {isActive && <span style={{ fontSize: '9px', background: 'var(--accent-color)', color: '#000', padding: '2px 6px', borderRadius: '4px', fontWeight: '800' }}>ACTIVE</span>}
                          <button
                            onClick={() => {
                              setDeleteFilesChecked(false);
                              setModalConfig({
                                workspaceName: name,
                                title: 'Delete Workspace',
                                message: `Are you sure you want to remove "${name}" from your workspaces?`
                              });
                            }}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '4px',
                              transition: 'color 0.2s',
                              outline: 'none'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                            title="Delete Workspace"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Clone URL */}
          <div className="double-bezel-card">
            <div className="double-bezel-card-inner">
              <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <GitBranch size={13} style={{ color: 'var(--accent-color)' }} />
                Clone URL
              </h3>
              <form onSubmit={handleClone} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <input type="text" className="input-field" placeholder="https://github.com/user/repo.git" value={cloneUrl} onChange={e => setCloneUrl(e.target.value)} disabled={cloning} required />
                <input type="text" className="input-field" placeholder="Folder name (optional)" value={cloneFolder} onChange={e => setCloneFolder(e.target.value)} disabled={cloning} />
                <button type="submit" className="btn-primary" disabled={cloning || !cloneUrl}>
                  <span>{cloning ? 'Cloning...' : 'Clone'}</span>
                  <div className="btn-icon-wrapper"><Plus size={14} /></div>
                </button>
              </form>
            </div>
          </div>

          {/* Link local folder */}
          <div className="double-bezel-card">
            <div className="double-bezel-card-inner">
              <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Link2 size={13} style={{ color: 'var(--accent-color)' }} />
                Link Local Folder
              </h3>
              <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <input type="text" className="input-field" placeholder="Name (e.g., ems)" value={customName} onChange={e => setCustomName(e.target.value)} disabled={registering} required />
                <input type="text" className="input-field" placeholder="Absolute path (e.g., /home/ubuntu/ems)" value={customPath} onChange={e => setCustomPath(e.target.value)} disabled={registering} required />
                <button type="submit" className="btn-primary" disabled={registering || !customName || !customPath}>
                  <span>{registering ? 'Linking...' : 'Link Path'}</span>
                  <div className="btn-icon-wrapper"><Link2 size={14} /></div>
                </button>
              </form>
            </div>
          </div>

          {/* Create blank */}
          <div className="double-bezel-card">
            <div className="double-bezel-card-inner">
              <h3 style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Folder size={13} style={{ color: 'var(--accent-color)' }} />
                New Blank Project
              </h3>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <input type="text" className="input-field" placeholder="Project name" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} disabled={creating} required />
                <button type="submit" className="btn-primary" disabled={creating || !newProjectName}>
                  <span>{creating ? 'Creating...' : 'Create'}</span>
                  <div className="btn-icon-wrapper"><Plus size={14} /></div>
                </button>
              </form>
            </div>
          </div>
        </>
      )}

      {/* Custom dialog modal overlay */}
      {modalConfig && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(5, 5, 8, 0.85)',
          backdropFilter: 'blur(6px)',
          zIndex: 300,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px'
        }}>
          <div className="double-bezel-card" style={{ width: '100%', maxWidth: '360px', marginBottom: '0' }}>
            <div className="double-bezel-card-inner">
              <h3 style={{ fontSize: '15px', fontWeight: '700', marginBottom: '10px', color: 'var(--text-primary)' }}>
                {modalConfig.title}
              </h3>
              <p className="text-sub" style={{ marginBottom: '16px', fontSize: '13px', lineHeight: '1.5' }}>
                {modalConfig.message}
              </p>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
                <input
                  type="checkbox"
                  id="deleteFilesCheckbox"
                  checked={deleteFilesChecked}
                  onChange={(e) => setDeleteFilesChecked(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: '#ef4444' }}
                />
                <label htmlFor="deleteFilesCheckbox" style={{ fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  Also delete project files from disk
                </label>
              </div>
              
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setModalConfig(null)}
                  className="btn-secondary"
                  style={{ padding: '8px 12px', fontSize: '11px', width: 'auto', boxShadow: 'none' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    handleDeleteWorkspace(modalConfig.workspaceName, deleteFilesChecked);
                    setModalConfig(null);
                  }}
                  className="btn-primary"
                  style={{
                    padding: '8px 16px',
                    fontSize: '11px',
                    width: 'auto',
                    boxShadow: 'none',
                    background: '#ef4444',
                    color: '#fff',
                    borderColor: '#ef4444'
                  }}
                >
                  Confirm Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
