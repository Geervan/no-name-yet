import React, { useState, useEffect } from 'react';
import { Folder, Plus, GitBranch, ArrowRight, Activity, Link2 } from 'lucide-react';

export default function WorkspacesTab({ apiHost, token, activeWorkspace, onSelectWorkspace }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  
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
  const [searchQuery, setSearchQuery] = useState('');

  const filteredWorkspaces = workspaces.filter(name =>
    name.toLowerCase().includes(searchQuery.toLowerCase())
  );

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

  useEffect(() => {
    fetchWorkspaces();
  }, [apiHost, token]);

  const handleClone = async (e) => {
    e.preventDefault();
    if (!cloneUrl) return;
    setCloning(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/workspaces/clone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ repoUrl: cloneUrl, folderName: cloneFolder })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCloneUrl('');
      setCloneFolder('');
      fetchWorkspaces();
      if (data.workspace) {
        onSelectWorkspace(data.workspace);
      }
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name: newProjectName })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNewProjectName('');
      fetchWorkspaces();
      if (data.workspace) {
        onSelectWorkspace(data.workspace);
      }
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name: customName, absolutePath: customPath })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setCustomName('');
      setCustomPath('');
      fetchWorkspaces();
      if (data.workspace) {
        onSelectWorkspace(data.workspace);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="tab-panel">
      <div className="eyebrow-badge">WORKSPACE HUB</div>
      <h2 className="section-title">Projects</h2>

      {error && (
        <div className="double-bezel-card" style={{ borderColor: '#ef4444', boxShadow: '4px 4px 0px 0px #ef4444' }}>
          <div className="double-bezel-card-inner" style={{ color: '#f87171', fontSize: '12px', fontWeight: 'bold' }}>
            [ERROR] {error}
          </div>
        </div>
      )}

      {/* Workspaces List */}
      <div className="double-bezel-card">
        <div className="double-bezel-card-inner">
          <h3 style={{ fontSize: '13px', fontWeight: '800', textTransform: 'uppercase', marginBottom: '14px', borderBottom: '1px solid var(--color-zinc-800)', paddingBottom: '6px' }}>
            Registered Projects
          </h3>
          {/* Search bar */}
          {!loading && workspaces.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <input
                type="text"
                className="input-field"
                placeholder="Search projects by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ fontSize: '12px', height: '36px' }}
              />
            </div>
          )}

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-color)', fontSize: '12px', fontWeight: 'bold' }}>
              <Activity className="animate-spin" size={14} />
              SCANNING LOCAL DISKS...
            </div>
          ) : filteredWorkspaces.length === 0 ? (
            <p className="text-sub">{searchQuery ? 'No matching projects found.' : 'No projects mapped. Link an existing local folder or clone a repository below.'}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '340px', overflowY: 'auto', paddingRight: '4px' }}>
              {filteredWorkspaces.map((name) => {
                const isActive = activeWorkspace === name;
                return (
                  <button
                    key={name}
                    onClick={() => onSelectWorkspace(name)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      background: isActive ? 'var(--accent-color-dim)' : 'var(--bg-base)',
                      border: '2px solid',
                      borderColor: isActive ? 'var(--accent-color)' : 'var(--text-primary)',
                      color: isActive ? 'var(--accent-color)' : 'var(--text-primary)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: '800',
                      fontSize: '13px',
                      borderRadius: '0px',
                      boxShadow: isActive ? '2px 2px 0px 0px var(--accent-color)' : '3px 3px 0px 0px #ffffff',
                      transform: isActive ? 'translate(1px, 1px)' : 'none',
                      transition: 'all 0.1s ease',
                      flexShrink: 0
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Folder size={16} style={{ color: isActive ? 'var(--accent-color)' : 'var(--text-primary)' }} />
                      <span>{name}</span>
                    </div>
                    {isActive ? (
                      <span style={{ fontSize: '9px', background: 'var(--accent-color)', color: '#000000', padding: '2px 6px', fontWeight: '800' }}>ACTIVE</span>
                    ) : (
                      <ArrowRight size={14} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Link Existing Local Folder (E.g. web-forge-hackathon) */}
      <div className="double-bezel-card">
        <div className="double-bezel-card-inner">
          <h3 style={{ fontSize: '13px', fontWeight: '800', textTransform: 'uppercase', marginBottom: '14px', borderBottom: '1px solid var(--color-zinc-800)', paddingBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Link2 size={14} style={{ color: 'var(--accent-color)' }} />
            Link Local Folder
          </h3>
          <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="input-group" style={{ marginBottom: '0' }}>
              <label className="input-label">Project Tag Name</label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g., ems"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                disabled={registering}
                required
              />
            </div>
            <div className="input-group" style={{ marginBottom: '0' }}>
              <label className="input-label">Absolute Path on Host</label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g., e:/web-forge-hackathon"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                disabled={registering}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={registering || !customName || !customPath} style={{ marginTop: '4px' }}>
              <span>{registering ? 'Adding local path...' : 'Link Path'}</span>
              <div className="btn-icon-wrapper">
                <Plus size={14} />
              </div>
            </button>
          </form>
        </div>
      </div>

      {/* Clone Git Repo */}
      <div className="double-bezel-card">
        <div className="double-bezel-card-inner">
          <h3 style={{ fontSize: '13px', fontWeight: '800', textTransform: 'uppercase', marginBottom: '14px', borderBottom: '1px solid var(--color-zinc-800)', paddingBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <GitBranch size={14} style={{ color: 'var(--accent-color)' }} />
            Clone Git Repository
          </h3>
          <form onSubmit={handleClone} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="input-group" style={{ marginBottom: '0' }}>
              <label className="input-label">Git URL</label>
              <input
                type="text"
                className="input-field"
                placeholder="https://github.com/user/repo.git"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                disabled={cloning}
                required
              />
            </div>
            <div className="input-group" style={{ marginBottom: '0' }}>
              <label className="input-label">Target Directory Name</label>
              <input
                type="text"
                className="input-field"
                placeholder="Folder name (optional)"
                value={cloneFolder}
                onChange={(e) => setCloneFolder(e.target.value)}
                disabled={cloning}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={cloning || !cloneUrl} style={{ marginTop: '4px' }}>
              <span>{cloning ? 'Cloning repo...' : 'Clone Repo'}</span>
              <div className="btn-icon-wrapper">
                <Plus size={14} />
              </div>
            </button>
          </form>
        </div>
      </div>

      {/* Create New Workspace */}
      <div className="double-bezel-card" style={{ marginBottom: '100px' }}>
        <div className="double-bezel-card-inner">
          <h3 style={{ fontSize: '13px', fontWeight: '800', textTransform: 'uppercase', marginBottom: '14px', borderBottom: '1px solid var(--color-zinc-800)', paddingBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Folder size={14} style={{ color: 'var(--accent-color)' }} />
            Create Blank Project
          </h3>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="input-group" style={{ marginBottom: '0' }}>
              <label className="input-label">Project Folder Name</label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g., node-app"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                disabled={creating}
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={creating || !newProjectName} style={{ marginTop: '4px' }}>
              <span>{creating ? 'Creating project...' : 'Init Project'}</span>
              <div className="btn-icon-wrapper">
                <Plus size={14} />
              </div>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
