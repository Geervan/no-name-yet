import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Folder, FolderOpen, FileCode, Search, Save, X, Trash2, FilePlus, FolderPlus, RotateCcw, Play } from 'lucide-react';

// ── Lightweight syntax tokenizer ────────────────────────────────────────────────
// No dependencies — just regex-based token colouring for common languages
const TOKEN_RULES = [
  // Strings (double/single/template)
  { type: 'string',   re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,  color: '#a3e635' },
  // Comments
  { type: 'comment',  re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g,                     color: '#6b7280' },
  // Keywords
  { type: 'keyword',  re: /\b(const|let|var|function|class|return|if|else|for|while|import|export|default|from|async|await|try|catch|throw|new|this|typeof|instanceof|of|in|do|switch|case|break|continue|true|false|null|undefined|void|delete|yield|extends|super|static|get|set|type|interface|enum|namespace|abstract|implements|public|private|protected|readonly|def|print|and|or|not|is|pass|lambda|with|as|global|nonlocal|raise|finally|elif|assert)\b/g, color: '#818cf8' },
  // Numbers
  { type: 'number',   re: /\b(\d+\.?\d*)\b/g,                                            color: '#fb923c' },
  // Functions/methods
  { type: 'func',     re: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g,                     color: '#38bdf8' },
  // Tags (JSX/HTML)
  { type: 'tag',      re: /(<\/?[a-zA-Z][a-zA-Z0-9]*)/g,                                 color: '#f472b6' },
  // Attributes
  { type: 'attr',     re: /\s([a-zA-Z-]+)(?==)/g,                                        color: '#fbbf24' },
];

function highlight(code) {
  if (!code) return '';
  // Escape HTML
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Build a map of [start, end, color] ranges from all rules
  const ranges = [];
  for (const rule of TOKEN_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(escaped)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, color: rule.color });
    }
  }

  // Sort by start, remove overlaps (first-come wins)
  ranges.sort((a, b) => a.start - b.start);
  const used = [];
  const clean = [];
  for (const r of ranges) {
    if (!used.some(u => r.start < u.end && r.end > u.start)) {
      clean.push(r);
      used.push(r);
    }
  }

  // Build output string
  let out = '';
  let pos = 0;
  for (const r of clean) {
    out += escaped.slice(pos, r.start);
    out += `<span style="color:${r.color}">${escaped.slice(r.start, r.end)}</span>`;
    pos = r.end;
  }
  out += escaped.slice(pos);
  // Ensure trailing newline renders correctly
  return out + '\n';
}

export default function FilesTab({ apiHost, token, activeWorkspace, fileToOpen, onFileOpened, onSaveFileProblems, onRefreshRequest, onEditingChange }) {
  const [tree, setTree] = useState([]);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Editor state
  const [editingFile, setEditingFile] = useState(null); // { path, content }
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [modalConfig, setModalConfig] = useState(null);
  const [modalInput, setModalInput] = useState('');
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);
  const textareaRef = useRef(null);

  const fetchFileTree = async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/files/tree?workspace=${activeWorkspace}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTree(data.tree || []);
    } catch (err) {
      setError(err.message || 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFileTree();
    // Reset editor on workspace change
    setEditingFile(null);
    setSearchQuery('');
    setSearchResults([]);
  }, [activeWorkspace]);

  useEffect(() => {
    if (fileToOpen && fileToOpen.path) {
      openFileInEditor(fileToOpen.path);
    }
  }, [fileToOpen]);

  useEffect(() => {
    if (editingFile && fileToOpen && editingFile.path === fileToOpen.path && textareaRef.current) {
      const line = fileToOpen.line || 1;
      const content = editorContent || '';
      const lines = content.split('\n');
      
      let charIndex = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
        charIndex += lines[i].length + 1;
      }
      
      const targetLineLength = lines[Math.min(line - 1, lines.length - 1)]?.length || 0;
      
      const textarea = textareaRef.current;
      textarea.focus();
      textarea.setSelectionRange(charIndex, charIndex + targetLineLength);
      
      const lineHeight = 20.8;
      const targetScroll = Math.max(0, (line - 5) * lineHeight);
      textarea.scrollTop = targetScroll;
      // Sync the highlighted pre
      const pre = textarea.previousSibling;
      if (pre) pre.scrollTop = targetScroll;
      
      if (onFileOpened) {
        onFileOpened();
      }
    }
  }, [editingFile, fileToOpen, editorContent]);

  const toggleFolder = (path) => {
    setExpandedFolders(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  const openFileInEditor = async (filePath) => {
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/files/content?workspace=${activeWorkspace}&filePath=${filePath}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setEditingFile({ path: filePath, content: data.content });
      setEditorContent(data.content);
      setShowHtmlPreview(false);
      if (onEditingChange) onEditingChange(true);
    } catch (err) {
      setError(err.message || 'Failed to open file');
    }
  };

  const closeEditor = () => {
    setEditingFile(null);
    setShowHtmlPreview(false);
    if (onEditingChange) onEditingChange(false);
  };

  const saveFile = async () => {
    if (!editingFile) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/files/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          workspace: activeWorkspace,
          filePath: editingFile.path,
          content: editorContent
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setEditingFile(prev => ({ ...prev, content: editorContent }));
      
      // Notify parent about save-time problems (syntax checks)
      if (onSaveFileProblems) {
        onSaveFileProblems(editingFile.path, data.problems || []);
      }
    } catch (err) {
      setError(err.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  };

  const createNewFile = (defaultPath = '') => {
    setModalInput(defaultPath);
    setModalConfig({
      title: 'Create New File',
      message: 'Enter the path of the new file relative to the active workspace directory.',
      showInput: true,
      placeholder: 'e.g., src/components/Header.jsx',
      confirmText: 'Create File',
      onConfirm: async (filename) => {
        if (!filename) return;
        try {
          const res = await fetch(`${apiHost}/api/files/save`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              workspace: activeWorkspace,
              filePath: filename,
              content: ''
            })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          await fetchFileTree();
          openFileInEditor(filename);
        } catch (err) {
          setError(`Failed to create file: ${err.message}`);
        }
      }
    });
  };

  const createNewFolder = (defaultPath = '') => {
    setModalInput(defaultPath);
    setModalConfig({
      title: 'Create New Folder',
      message: 'Enter the path of the new directory relative to the active workspace directory.',
      showInput: true,
      placeholder: 'e.g., src/assets/images',
      confirmText: 'Create Folder',
      onConfirm: async (foldername) => {
        if (!foldername) return;
        try {
          const res = await fetch(`${apiHost}/api/files/mkdir`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              workspace: activeWorkspace,
              dirPath: foldername
            })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          fetchFileTree();
        } catch (err) {
          setError(`Failed to create directory: ${err.message}`);
        }
      }
    });
  };

  const deleteFileOrFolder = (nodePath, e) => {
    e.stopPropagation();
    setModalConfig({
      title: 'Delete Item',
      message: `Are you sure you want to permanently delete "${nodePath}"? This cannot be undone.`,
      showInput: false,
      confirmText: 'Delete Permanently',
      isDanger: true,
      onConfirm: async () => {
        try {
          const res = await fetch(`${apiHost}/api/files/delete`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              workspace: activeWorkspace,
              filePath: nodePath
            })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          if (editingFile && editingFile.path === nodePath) {
            setEditingFile(null);
            if (onEditingChange) onEditingChange(false);
          }

          fetchFileTree();
        } catch (err) {
          setError(`Deletion failed: ${err.message}`);
        }
      }
    });
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery) return;
    setSearching(true);
    setError('');
    try {
      const res = await fetch(`${apiHost}/api/files/search?workspace=${activeWorkspace}&query=${searchQuery}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResults(data.results || []);
    } catch (err) {
      setError(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  // Render directory tree recursively
  const renderTreeNodes = (nodes, depth = 0) => {
    return nodes.map((node) => {
      const isFolder = node.type === 'directory';
      const isExpanded = expandedFolders[node.path];

      if (isFolder) {
        return (
          <div key={node.path} style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingRight: '12px',
                width: '100%'
              }}
              onMouseEnter={(e) => {
                const btn = e.currentTarget.querySelector('.delete-btn-node');
                if (btn) btn.style.opacity = '1';
                const inlineActions = e.currentTarget.querySelector('.folder-inline-actions');
                if (inlineActions) inlineActions.style.opacity = '1';
              }}
              onMouseLeave={(e) => {
                const btn = e.currentTarget.querySelector('.delete-btn-node');
                if (btn) btn.style.opacity = '0.3';
                const inlineActions = e.currentTarget.querySelector('.folder-inline-actions');
                if (inlineActions) inlineActions.style.opacity = '0.7';
              }}
            >
              <button
                onClick={() => toggleFolder(node.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 12px',
                  paddingLeft: `${depth * 14 + 12}px`,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-primary)',
                  textAlign: 'left',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  flex: 1
                }}
              >
                {isExpanded ? (
                  <FolderOpen size={16} style={{ color: 'var(--accent-color)' }} />
                ) : (
                  <Folder size={16} style={{ color: 'var(--text-secondary)' }} />
                )}
                <span>{node.name}</span>
              </button>
              
              <div 
                className="folder-inline-actions" 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '4px', 
                  opacity: 0.7, 
                  transition: 'opacity 0.2s',
                  marginRight: '8px'
                }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); createNewFile(node.path + '/'); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-color)',
                    cursor: 'pointer',
                    padding: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  title="Add File inside this folder"
                >
                  <FilePlus size={14} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); createNewFolder(node.path + '/'); }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent-color)',
                    cursor: 'pointer',
                    padding: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  title="Add Folder inside this folder"
                >
                  <FolderPlus size={14} />
                </button>
              </div>

              <button
                className="delete-btn-node"
                onClick={(e) => deleteFileOrFolder(node.path, e)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  opacity: 0.3,
                  transition: 'opacity 0.2s, color 0.2s',
                  display: 'flex',
                  alignItems: 'center'
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
                title="Delete Folder"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {isExpanded && node.children && renderTreeNodes(node.children, depth + 1)}
          </div>
        );
      } else {
        return (
          <div
            key={node.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingRight: '12px',
              background: editingFile?.path === node.path ? 'rgba(16, 185, 129, 0.05)' : 'transparent',
              width: '100%'
            }}
            onMouseEnter={(e) => {
              const btn = e.currentTarget.querySelector('.delete-btn-node');
              if (btn) btn.style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              const btn = e.currentTarget.querySelector('.delete-btn-node');
              if (btn) btn.style.opacity = '0.3';
            }}
          >
            <button
              onClick={() => openFileInEditor(node.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                paddingLeft: `${depth * 14 + 12}px`,
                background: 'transparent',
                border: 'none',
                color: editingFile?.path === node.path ? 'var(--accent-color)' : 'var(--text-secondary)',
                textAlign: 'left',
                fontSize: '13px',
                cursor: 'pointer',
                flex: 1
              }}
            >
              <FileCode size={16} style={{ opacity: 0.8 }} />
              <span>{node.name}</span>
            </button>
            {/* Play/preview button for HTML files */}
            {node.name.match(/\.html?$/i) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openFileInEditor(node.path);
                  setTimeout(() => setShowHtmlPreview(true), 100);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-color)',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  opacity: 0.8,
                }}
                title="Preview HTML"
              >
                <Play size={14} fill="currentColor" />
              </button>
            )}
            <button
              className="delete-btn-node"
              onClick={(e) => deleteFileOrFolder(node.path, e)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px',
                opacity: 0.3,
                transition: 'opacity 0.2s, color 0.2s',
                display: 'flex',
                alignItems: 'center'
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
              title="Delete File"
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      }
    });
  };

  if (!activeWorkspace) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', marginTop: '40px' }}>
        <p className="text-sub">Please select or clone a workspace to browse files.</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      
      {/* File Editor Overlay */}
      {editingFile ? (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--bg-base)',
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          height: '100dvh',
          width: '100%',
          maxWidth: '480px',
          margin: '0 auto',
          borderLeft: '1px solid var(--border-glow)',
          borderRight: '1px solid var(--border-glow)'
        }}>
          {/* Editor Header */}
          <div style={{
            flexShrink: 0,
            height: '56px',
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-glow)',
            background: 'rgba(10,10,10,0.95)',
            gap: '8px',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {editingFile.path.split('/').pop()}
              </span>
              <span style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {editingFile.path}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              {/* HTML Preview button — only for .html files */}
              {editingFile.path.match(/\.html?$/i) && (
                <button
                  onClick={() => setShowHtmlPreview(v => !v)}
                  style={{
                    background: showHtmlPreview ? 'rgba(0,255,102,0.1)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${showHtmlPreview ? 'var(--accent-color)' : 'var(--border-glow)'}`,
                    borderRadius: '8px',
                    padding: '6px 10px',
                    fontSize: '11px',
                    fontWeight: '600',
                    color: showHtmlPreview ? 'var(--accent-color)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  {showHtmlPreview ? '< >' : '⬡ Preview'}
                </button>
              )}
              <button
                onClick={saveFile}
                disabled={saving || editorContent === editingFile.content}
                style={{
                  background: editorContent !== editingFile.content ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                  color: editorContent !== editingFile.content ? '#000' : 'var(--text-muted)',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: '700',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: editorContent !== editingFile.content ? 'pointer' : 'default',
                }}
              >
                <Save size={13} />
                <span>{saving ? '...' : 'Save'}</span>
              </button>
              <button
                onClick={closeEditor}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--border-glow)',
                  borderRadius: '8px',
                  padding: '6px 8px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* HTML Preview mode */}
          {showHtmlPreview ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--border-glow)', background: 'rgba(10,10,10,0.9)', flexShrink: 0 }}>
                <button
                  onClick={() => {
                    const previewUrl = `${apiHost}/api/files/preview?workspace=${encodeURIComponent(activeWorkspace)}&filePath=${encodeURIComponent(editingFile.path)}&token=${token}`;
                    window.open(previewUrl, '_blank');
                  }}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glow)', borderRadius: '6px', color: 'var(--text-secondary)', padding: '6px 12px', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}
                >
                  ↗ Open in new tab
                </button>
              </div>
              <iframe
                src={`${apiHost}/api/files/preview?workspace=${encodeURIComponent(activeWorkspace)}&filePath=${encodeURIComponent(editingFile.path)}&token=${token}`}
                style={{ flex: 1, border: 'none', background: '#fff', width: '100%', display: 'block' }}
                title="HTML Preview"
              />
            </div>
          ) : (
            /* Editor Area — keyboard pushes this up naturally via dvh */
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0a0a', minHeight: 0 }}>
              {/* Highlighted pre */}
              <pre
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  margin: 0,
                  padding: '16px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  whiteSpace: 'pre',
                  wordBreak: 'normal',
                  overflowWrap: 'normal',
                  color: '#e4e4e7',
                  pointerEvents: 'none',
                  overflow: 'hidden',
                  tabSize: 2,
                }}
                dangerouslySetInnerHTML={{ __html: highlight(editorContent) }}
              />
              {/* Transparent textarea */}
              <textarea
                ref={textareaRef}
                value={editorContent}
                onChange={(e) => {
                  setEditorContent(e.target.value);
                }}
                onScroll={(e) => {
                  const pre = e.currentTarget.previousSibling;
                  if (pre) {
                    pre.scrollTop = e.currentTarget.scrollTop;
                    pre.scrollLeft = e.currentTarget.scrollLeft;
                  }
                }}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  background: 'transparent',
                  border: 'none',
                  color: 'transparent',
                  caretColor: '#e4e4e7',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  padding: '16px',
                  outline: 'none',
                  resize: 'none',
                  whiteSpace: 'pre',
                  wordBreak: 'normal',
                  overflowWrap: 'normal',
                  overflow: 'auto',
                  tabSize: 2,
                  WebkitTextFillColor: 'transparent',
                }}
              />
            </div>
          )}
        </div>
      ) : null}

      <div className="eyebrow-badge">Workspace Files</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-glow)', paddingBottom: '8px' }}>
        <h2 className="section-title" style={{ margin: 0, border: 'none', padding: 0 }}>{activeWorkspace}</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={fetchFileTree}
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-glow)',
              borderRadius: '8px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '8px',
            }}
            title="Refresh file tree"
          >
            <RotateCcw size={15} />
          </button>
          <button
            onClick={() => createNewFile('')}
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-glow)',
              borderRadius: '8px',
              color: 'var(--accent-color)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: '600',
              padding: '8px 12px'
            }}
            title="Create New File"
          >
            <FilePlus size={15} />
            <span>File</span>
          </button>
          <button
            onClick={() => createNewFolder('')}
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-glow)',
              borderRadius: '8px',
              color: 'var(--accent-color)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: '600',
              padding: '8px 12px'
            }}
            title="Create New Directory"
          >
            <FolderPlus size={15} />
            <span>Folder</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="double-bezel-card" style={{ borderColor: 'rgba(239, 68, 68, 0.2)' }}>
          <div className="double-bezel-card-inner" style={{ color: '#f87171', fontSize: '13px' }}>
            {error}
          </div>
        </div>
      )}

      {/* Global Search Bar */}
      <div className="double-bezel-card" style={{ marginBottom: '16px' }}>
        <div className="double-bezel-card-inner" style={{ padding: '12px' }}>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type="text"
                className="input-field"
                placeholder="Grep search in code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: '100%', paddingLeft: '36px', height: '40px' }}
              />
              <Search size={14} style={{ position: 'absolute', left: '12px', top: '13px', color: 'var(--text-secondary)' }} />
            </div>
            <button
              type="submit"
              disabled={searching || !searchQuery}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-glow)',
                color: 'var(--text-primary)',
                borderRadius: '12px',
                padding: '0 16px',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              {searching ? 'Grep...' : 'Find'}
            </button>
          </form>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div style={{ marginTop: '12px', maxHeight: '160px', overflowY: 'auto', borderTop: '1px solid var(--border-glow)', paddingTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '10px', textTransform: 'uppercase', tracking: '1px', color: 'var(--text-secondary)' }}>Search Results</span>
                <button
                  onClick={() => { setSearchResults([]); setSearchQuery(''); }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--accent-color)', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {searchResults.map((res, i) => (
                  <button
                    key={i}
                    onClick={() => openFileInEditor(res.path)}
                    style={{
                      width: '100%',
                      background: 'rgba(255, 255, 255, 0.01)',
                      border: '1px solid var(--border-glow)',
                      borderRadius: '8px',
                      padding: '8px',
                      color: 'var(--text-primary)',
                      textAlign: 'left',
                      cursor: 'pointer'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: '600', color: 'var(--accent-color)' }}>
                      <span>{res.path.split('/').pop()}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Line {res.line}</span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                      {res.content}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Directory Browser */}
      <div className="double-bezel-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginBottom: '10px' }}>
        <div className="double-bezel-card-inner" style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
          {loading ? (
            <p className="text-sub" style={{ padding: '8px' }}>Reading directory structure...</p>
          ) : tree.length === 0 ? (
            <p className="text-sub" style={{ padding: '8px' }}>Empty repository.</p>
          ) : (
            <div>{renderTreeNodes(tree)}</div>
          )}
        </div>
      </div>


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
              
              {modalConfig.showInput && (
                <input
                  type="text"
                  className="input-field"
                  value={modalInput}
                  onChange={(e) => setModalInput(e.target.value)}
                  placeholder={modalConfig.placeholder}
                  style={{ width: '100%', marginBottom: '16px' }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      modalConfig.onConfirm(modalInput);
                      setModalConfig(null);
                      setModalInput('');
                    }
                  }}
                />
              )}
              
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    setModalConfig(null);
                    setModalInput('');
                  }}
                  className="btn-secondary"
                  style={{ padding: '8px 12px', fontSize: '11px', width: 'auto', boxShadow: 'none' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    modalConfig.onConfirm(modalInput);
                    setModalConfig(null);
                    setModalInput('');
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
