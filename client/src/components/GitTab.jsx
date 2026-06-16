import React, { useState, useEffect } from 'react';
import { GitCommit, GitPullRequest, ChevronRight, FileCode, Check, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';

export default function GitTab({ apiHost, token, activeWorkspace }) {
  const [changedFiles, setChangedFiles] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState({});
  const [commitMessage, setCommitMessage] = useState('');
  const [activeDiffFile, setActiveDiffFile] = useState(null);
  const [diffContent, setDiffContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [gitRunning, setGitRunning] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState('');
  const [modalConfig, setModalConfig] = useState(null);

  const fetchGitStatus = async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError('');
    setLog('');
    try {
      const res = await fetch(`${apiHost}/api/git/status?workspace=${activeWorkspace}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setChangedFiles(data.files || []);
      // Reset selections
      const initialSelections = {};
      (data.files || []).forEach(f => {
        initialSelections[f.path] = true; // default select all
      });
      setSelectedFiles(initialSelections);
    } catch (err) {
      setError(err.message || 'Failed to read git status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGitStatus();
    setActiveDiffFile(null);
    setDiffContent('');
    setCommitMessage('');
  }, [activeWorkspace]);

  const viewDiff = async (filePath) => {
    setError('');
    setLog('');
    try {
      const res = await fetch(`${apiHost}/api/git/diff?workspace=${activeWorkspace}&filePath=${filePath}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActiveDiffFile(filePath);
      setDiffContent(data.diff || 'No changes detected.');
    } catch (err) {
      setError(err.message || 'Failed to fetch diff');
    }
  };

  const handleToggleFile = (path) => {
    setSelectedFiles(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  const handleCommitPush = async (e) => {
    e.preventDefault();
    if (!commitMessage || !activeWorkspace) return;

    setGitRunning(true);
    setError('');
    setLog('');
    
    // Gather files selected for commit
    const filesToCommit = Object.keys(selectedFiles).filter(path => selectedFiles[path]);

    try {
      const res = await fetch(`${apiHost}/api/git/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          workspace: activeWorkspace,
          message: commitMessage,
          files: filesToCommit
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setLog(data.log || 'Push completed successfully.');
      setCommitMessage('');
      setActiveDiffFile(null);
      fetchGitStatus();
    } catch (err) {
      setError(err.message || 'Commit/Push failed');
    } finally {
      setGitRunning(false);
    }
  };

  const handlePull = async () => {
    setGitRunning(true);
    setError('');
    setLog('');
    try {
      const res = await fetch(`${apiHost}/api/git/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ workspace: activeWorkspace })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setLog(data.output || 'Pulled updates successfully.');
      fetchGitStatus();
    } catch (err) {
      setError(err.message || 'Pull failed');
    } finally {
      setGitRunning(false);
    }
  };

  const handleDiscardFile = (filePath, e) => {
    e.stopPropagation();
    setModalConfig({
      title: 'Discard File Changes',
      message: `Are you sure you want to discard ALL modifications in "${filePath}"? This will revert the file to its last committed state and cannot be undone.`,
      confirmText: 'Discard modifications',
      isDanger: true,
      onConfirm: async () => {
        setGitRunning(true);
        setError('');
        setLog('');
        try {
          const res = await fetch(`${apiHost}/api/git/discard`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              workspace: activeWorkspace,
              filePath
            })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          setLog(`Discarded changes in: ${filePath}`);
          fetchGitStatus();
        } catch (err) {
          setError(err.message || 'Discard failed');
        } finally {
          setGitRunning(false);
        }
      }
    });
  };

  const handleDiscardAll = () => {
    setModalConfig({
      title: 'Discard All Workspace Changes',
      message: 'DANGER! Are you sure you want to discard ALL unstaged/staged changes in this workspace? This will hard-revert your working directory to the last Git commit and permanently delete untracked files.',
      confirmText: 'Discard Everything',
      isDanger: true,
      onConfirm: async () => {
        setGitRunning(true);
        setError('');
        setLog('');
        try {
          const res = await fetch(`${apiHost}/api/git/discard-all`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              workspace: activeWorkspace
            })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          setLog('Discarded all changes and cleaned directory.');
          fetchGitStatus();
        } catch (err) {
          setError(err.message || 'Failed to discard all changes');
        } finally {
          setGitRunning(false);
        }
      }
    });
  };

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Please select a workspace to manage Git repository.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ marginBottom: '100px' }}>
      <div className="eyebrow-badge">Repository Versioning</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 className="section-title" style={{ margin: '0' }}>Git Control</h2>
        <button
          onClick={fetchGitStatus}
          disabled={loading || gitRunning}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent-color)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            fontWeight: '600'
          }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div className="double-bezel-card" style={{ borderColor: 'rgba(239, 68, 68, 0.2)' }}>
          <div className="double-bezel-card-inner" style={{ color: '#f87171', fontSize: '13px' }}>
            {error}
          </div>
        </div>
      )}

      {log && (
        <div className="double-bezel-card" style={{ borderColor: 'rgba(16, 185, 129, 0.2)' }}>
          <div className="double-bezel-card-inner" style={{ color: 'var(--accent-color)', fontSize: '13px', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>
            {log}
          </div>
        </div>
      )}

      {/* Changed Files List */}
      <div className="double-bezel-card">
        <div className="double-bezel-card-inner">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {changedFiles.length > 0 && (
                <input
                  type="checkbox"
                  checked={changedFiles.length > 0 && changedFiles.every(f => selectedFiles[f.path])}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const next = {};
                    changedFiles.forEach(f => {
                      next[f.path] = checked;
                    });
                    setSelectedFiles(next);
                  }}
                  style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                  title="Select / Deselect All"
                />
              )}
              <h3 style={{ fontSize: '14px', fontWeight: '600' }}>Changed Files</h3>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {changedFiles.length > 0 && (
                <button
                  onClick={handleDiscardAll}
                  disabled={gitRunning}
                  style={{
                    background: 'rgba(239, 68, 68, 0.05)',
                    border: '1px solid rgba(239, 68, 68, 0.15)',
                    borderRadius: '8px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    fontWeight: '600',
                    color: '#f87171',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  title="Discard all changes in workspace"
                >
                  <RotateCcw size={11} />
                  <span>Discard All</span>
                </button>
              )}
              <button
                onClick={handlePull}
                disabled={gitRunning}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-glow)',
                  borderRadius: '8px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <GitPullRequest size={12} />
                <span>Pull</span>
              </button>
            </div>
          </div>

          {loading ? (
            <p className="text-sub">Checking workspace git diff status...</p>
          ) : changedFiles.length === 0 ? (
            <p className="text-sub">No modifications detected. Clean working tree.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
              {changedFiles.map((file) => (
                <div
                  key={file.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 10px',
                    background: 'rgba(255, 255, 255, 0.01)',
                    border: '1px solid var(--border-glow)',
                    borderRadius: '8px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '70%' }}>
                    <input
                      type="checkbox"
                      checked={!!selectedFiles[file.path]}
                      onChange={() => handleToggleFile(file.path)}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                    />
                    <FileCode size={14} style={{ color: 'var(--text-secondary)' }} />
                    <span style={{ fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-primary)' }}>
                      {file.path}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{
                      fontSize: '9px',
                      fontWeight: '700',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: file.code === '??' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                      color: file.code === '??' ? '#ef4444' : 'var(--accent-color)'
                    }}>
                      {file.code === '??' ? 'Untracked' : 'Modified'}
                    </span>
                    <button
                      onClick={(e) => handleDiscardFile(file.path, e)}
                      disabled={gitRunning}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '4px',
                        transition: 'color 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                      title="Discard Changes"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      onClick={() => viewDiff(file.path)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent-color)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center'
                      }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Diff Output Panel */}
      {activeDiffFile && (
        <div className="double-bezel-card">
          <div className="double-bezel-card-inner">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '10px', textTransform: 'uppercase', tracking: '1px', color: 'var(--text-secondary)', fontWeight: '700' }}>
                Diff: {activeDiffFile.split('/').pop()}
              </span>
              <button
                onClick={() => setActiveDiffFile(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <XCircleIcon />
              </button>
            </div>
            <div style={{
              background: '#0a0a0a',
              borderRadius: '10px',
              padding: '12px',
              maxHeight: '220px',
              overflowY: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              lineHeight: '1.5',
              border: '1px solid var(--border-glow)'
            }}>
              {diffContent.split('\n').map((line, i) => {
                let color = 'var(--text-primary)';
                let bg = 'transparent';
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  color = '#34d399'; // green text
                  bg = 'rgba(52, 211, 153, 0.05)';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  color = '#f87171'; // red text
                  bg = 'rgba(239, 68, 68, 0.05)';
                } else if (line.startsWith('@@')) {
                  color = 'var(--text-muted)';
                }
                return (
                  <div key={i} style={{ color, background: bg, whiteSpace: 'pre-wrap' }}>
                    {line}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Commit & Push Form */}
      {changedFiles.length > 0 && (
        <div className="double-bezel-card">
          <div className="double-bezel-card-inner">
            <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <GitCommit size={16} style={{ color: 'var(--accent-color)' }} />
              Commit and Push Changes
            </h3>
            <form onSubmit={handleCommitPush} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="input-group" style={{ marginBottom: '0' }}>
                <label className="input-label">Commit Message</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g., fix: attendance checkout limits"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  disabled={gitRunning}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={gitRunning || !commitMessage || Object.values(selectedFiles).filter(Boolean).length === 0}
              >
                <span>{gitRunning ? 'Shipping modifications...' : 'Commit & Push Changes'}</span>
                <div className="btn-icon-wrapper">
                  <Check size={14} />
                </div>
              </button>
            </form>
          </div>
        </div>
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
                    modalConfig.onConfirm();
                    setModalConfig(null);
                  }}
                  className="btn-primary"
                  style={{
                    padding: '8px 16px',
                    fontSize: '11px',
                    width: 'auto',
                    boxShadow: 'none',
                    background: modalConfig.isDanger ? '#ef4444' : 'var(--accent-color)',
                    color: modalConfig.isDanger ? '#fff' : '#000',
                    borderColor: modalConfig.isDanger ? '#ef4444' : '#000'
                  }}
                >
                  {modalConfig.confirmText || 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function XCircleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}
