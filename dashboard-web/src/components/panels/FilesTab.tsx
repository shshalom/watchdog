import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Folder, FolderOpen, ChevronRight, Lock, LockOpen, Eye, EyeOff,
  Search, X, FileText, Loader2,
} from 'lucide-react';
import { apiClient } from '../../services/api-client';
import type { FsEntry, LockWatchState } from '../../models/types';
import { extensionColor } from '../../models/types';

// ── Types ─────────────────────────────────────────────────────────────

type FileFilter = 'all' | 'locked' | 'watched';

interface TreeNode extends FsEntry {
  children: TreeNode[] | null; // null = not yet loaded, [] = empty dir
  loading: boolean;
  expanded: boolean;
}

interface Props {
  lockWatchState: LockWatchState;
  projectPath?: string;
  onToggleLock: (path: string, currentlyLocked: boolean) => void;
  onToggleWatch: (path: string, currentlyWatched: boolean) => void;
}

// ── Helper: path is locked/watched (exact OR prefix) ─────────────────

function isLockedPath(path: string, locks: string[]): boolean {
  return locks.some(l => path === l || path.startsWith(l + '/'));
}

function isWatchedPath(path: string, watches: string[]): boolean {
  return watches.some(w => path === w || path.startsWith(w + '/'));
}

function fileColor(name: string): string {
  return extensionColor(name);
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

// ── Component ─────────────────────────────────────────────────────────

export default function FilesTab({ lockWatchState, projectPath, onToggleLock, onToggleWatch }: Props) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<FileFilter>('all');
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [browseRoot, setBrowseRoot] = useState('~');   // '~' = $HOME, '/' = filesystem root
  const [pathInput, setPathInput] = useState('');
  const [showPathInput, setShowPathInput] = useState(false);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const openCtxMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, path });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => closeCtxMenu();
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [ctxMenu, closeCtxMenu]);

  // Search state
  const [searchResults, setSearchResults] = useState<FsEntry[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialized = useRef(false);

  const { locks, watches } = lockWatchState;

  // ── Load a root directory ─────────────────────────────────────────

  const loadRoot = useCallback((root: string) => {
    setLoadingRoot(true);
    setRoots([]);
    apiClient.browseFsDir(root).then(entries => {
      setRoots(entries.map(e => entryToNode(e)));
      setLoadingRoot(false);
    }).catch(() => setLoadingRoot(false));
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    loadRoot('~');
  }, [loadRoot]);

  // ── Two-phase debounced search ─────────────────────────────────────
  // Phase 1: search project dir immediately (fast).
  // Phase 2: search HOME and merge, deduplicating by path.

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const q = searchText.trim();
    if (!q) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        if (projectPath) {
          // Phase 1 — project dir (fast)
          const projectResults = await apiClient.searchFs(q, projectPath);
          setSearchResults(projectResults);
          setSearchLoading(true); // still loading HOME

          // Phase 2 — HOME (may be slower), merge deduped
          const homeResults = await apiClient.searchFs(q);
          const seen = new Set(projectResults.map(r => r.path));
          const extra = homeResults.filter(r => !seen.has(r.path));
          setSearchResults([...projectResults, ...extra]);
        } else {
          const results = await apiClient.searchFs(q);
          setSearchResults(results);
        }
      } catch {
        setSearchResults(prev => prev ?? []);
      }
      setSearchLoading(false);
    }, 300);
  }, [searchText, projectPath]);

  // ── Expand / load a directory ────────────────────────────────────

  const expandNode = useCallback(async (path: string) => {
    const updateTree = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.map(n => {
        if (n.path === path) {
          if (n.children !== null) {
            return { ...n, expanded: !n.expanded };
          }
          return { ...n, expanded: true, loading: true };
        }
        if (n.children) {
          return { ...n, children: updateTree(n.children) };
        }
        return n;
      });
    };

    setRoots(prev => updateTree(prev));

    const needsLoad = (nodes: TreeNode[]): boolean => {
      for (const n of nodes) {
        if (n.path === path && n.children === null) return true;
        if (n.children && needsLoad(n.children)) return true;
      }
      return false;
    };

    if (needsLoad(roots)) {
      try {
        const entries = await apiClient.browseFsDir(path);
        const children = entries.map(e => entryToNode(e));

        const setChildren = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map(n => {
            if (n.path === path) return { ...n, children, loading: false };
            if (n.children) return { ...n, children: setChildren(n.children) };
            return n;
          });

        setRoots(prev => setChildren(prev));
      } catch {
        const setFailed = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map(n => {
            if (n.path === path) return { ...n, children: [], loading: false };
            if (n.children) return { ...n, children: setFailed(n.children) };
            return n;
          });
        setRoots(prev => setFailed(prev));
      }
    }
  }, [roots]);

  // ── Counts for filter badges (from canonical lock/watch state) ────

  const lockedCount = locks.length;
  const watchedCount = watches.length;

  // ── Merge locked/watched matches into search results ─────────────
  // Files outside HOME (e.g. /tmp) won't be found by the server search,
  // but if they're locked/watched we can surface them client-side.
  const mergedSearchResults: FsEntry[] | null = (() => {
    if (!searchResults) return null;
    const serverPaths = new Set(searchResults.map(r => r.path));
    const allTracked = [...locks, ...watches];
    const extra = allTracked
      .filter(path => {
        if (serverPaths.has(path)) return false;
        const name = path.split('/').pop() || path;
        return name.toLowerCase().includes(searchText.trim().toLowerCase());
      })
      .map(path => ({
        name: path.split('/').pop() || path,
        path,
        is_dir: false,
        is_locked: isLockedPath(path, locks),
        is_watched: isWatchedPath(path, watches),
      }));
    return [...extra, ...searchResults];
  })();

  // ── Determine what content mode to show ──────────────────────────
  // Priority: locked/watched filter > search > tree

  const showLocked = filter === 'locked';
  const showWatched = filter === 'watched';
  const showSearch = filter === 'all' && searchText.trim().length > 0;
  const showTree = !showLocked && !showWatched && !showSearch;

  // Flat list for locked/watched filters — derived from canonical state, filtered by search
  const q = searchText.trim().toLowerCase();
  const lockedFlatList: FsEntry[] = locks
    .filter(path => !q || (path.split('/').pop() || path).toLowerCase().includes(q))
    .map(path => ({
      name: path.split('/').pop() || path,
      path,
      is_dir: false,
      is_locked: true,
      is_watched: isWatchedPath(path, watches),
    }));

  const watchedFlatList: FsEntry[] = watches
    .filter(path => !q || (path.split('/').pop() || path).toLowerCase().includes(q))
    .map(path => ({
      name: path.split('/').pop() || path,
      path,
      is_dir: false,
      is_locked: isLockedPath(path, locks),
      is_watched: true,
    }));

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="flex items-center gap-1.5 px-3 py-[7px]">
        <Search size={12} className="text-white/20 flex-shrink-0" />
        <input
          type="text"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="Search files…"
          className="flex-1 bg-transparent text-[13px] text-white placeholder-white/20 outline-none"
        />
        {searchText && (
          <button onClick={() => setSearchText('')} className="text-white/20 hover:text-white/40 cursor-pointer">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="h-px bg-white/[0.08]" />

      {/* Root path bar */}
      <div className="flex items-center gap-1 px-3 py-1.5">
        {showPathInput ? (
          <input
            autoFocus
            type="text"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && pathInput.trim()) {
                const p = pathInput.trim();
                setBrowseRoot(p);
                loadRoot(p);
                setShowPathInput(false);
              }
              if (e.key === 'Escape') setShowPathInput(false);
            }}
            onBlur={() => setShowPathInput(false)}
            placeholder="/path/to/dir"
            className="flex-1 bg-transparent text-[11px] font-mono text-white/70 placeholder-white/20 outline-none"
          />
        ) : (
          <>
            {(['~', '/'] as const).map(r => (
              <button
                key={r}
                onClick={() => { setBrowseRoot(r); loadRoot(r); }}
                className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                  browseRoot === r ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}
              >{r === '~' ? '~ home' : '/ root'}</button>
            ))}
            <button
              onClick={() => { setPathInput(browseRoot); setShowPathInput(true); }}
              className="ml-auto text-[10px] text-white/20 hover:text-white/50 cursor-pointer transition-colors"
              title="Enter custom path"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          </>
        )}
      </div>
      <div className="h-px bg-white/[0.08]" />

      {/* Filter pills */}
      <div className="flex items-center gap-1 px-3 py-1.5">
        <FilterPill label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterPill label="Locked" count={lockedCount} active={filter === 'locked'} onClick={() => setFilter('locked')} />
        <FilterPill label="Watched" count={watchedCount} active={filter === 'watched'} onClick={() => setFilter('watched')} />
      </div>
      <div className="h-px bg-white/[0.08]" />

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-1">

        {/* Locked filter — flat list from canonical locks array */}
        {showLocked && (
          lockedCount === 0 ? (
            <EmptyFilterState label="No locked files" />
          ) : (
            lockedFlatList.map(entry => (
              <FlatRow
                key={entry.path}
                entry={entry}
                locks={locks}
                watches={watches}
                onToggleLock={onToggleLock}
                onToggleWatch={onToggleWatch}
                onContextMenu={openCtxMenu}
              />
            ))
          )
        )}

        {/* Watched filter — flat list from canonical watches array */}
        {showWatched && (
          watchedCount === 0 ? (
            <EmptyFilterState label="No watched files" />
          ) : (
            watchedFlatList.map(entry => (
              <FlatRow
                key={entry.path}
                entry={entry}
                locks={locks}
                watches={watches}
                onToggleLock={onToggleLock}
                onToggleWatch={onToggleWatch}
                onContextMenu={openCtxMenu}
              />
            ))
          )
        )}

        {/* Search results — flat list from server search */}
        {showSearch && (
          searchLoading && !mergedSearchResults?.length ? (
            <div className="flex items-center justify-center py-8 text-white/20">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : !mergedSearchResults || mergedSearchResults.length === 0 ? (
            <EmptyFilterState label={mergedSearchResults === null ? 'Searching…' : `No results for "${searchText}"`} />
          ) : (
            mergedSearchResults.map(entry => (
              <FlatRow
                key={entry.path}
                entry={entry}
                locks={locks}
                watches={watches}
                onToggleLock={onToggleLock}
                onToggleWatch={onToggleWatch}
                onContextMenu={openCtxMenu}
                showDirectory
              />
            ))
          )
        )}

        {/* Context menu */}
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            path={ctxMenu.path}
            onClose={closeCtxMenu}
          />
        )}

        {/* Tree mode */}
        {showTree && (
          loadingRoot ? (
            <div className="flex items-center justify-center py-8 text-white/20">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : roots.length === 0 ? (
            <EmptyState />
          ) : (
            roots.map(node => (
              <TreeNodeRow
                key={node.path}
                node={node}
                depth={0}
                locks={locks}
                watches={watches}
                onExpand={expandNode}
                onToggleLock={onToggleLock}
                onToggleWatch={onToggleWatch}
                onContextMenu={openCtxMenu}
              />
            ))
          )
        )}
      </div>
    </div>
  );
}

// ── Flat Row (search results / locked / watched) ───────────────────

interface FlatRowProps {
  entry: FsEntry;
  locks: string[];
  watches: string[];
  onToggleLock: (path: string, locked: boolean) => void;
  onToggleWatch: (path: string, watched: boolean) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  showDirectory?: boolean;
}

function FlatRow({ entry, locks, watches, onToggleLock, onToggleWatch, onContextMenu, showDirectory }: FlatRowProps) {
  const locked = isLockedPath(entry.path, locks);
  const watched = isWatchedPath(entry.path, watches);

  return (
    <div
      className="group flex items-center gap-1 px-3 pr-2 py-1 hover:bg-white/[0.03] transition-colors"
      onContextMenu={e => onContextMenu(e, entry.path)}
    >
      {/* Icon */}
      <span className="w-2 h-2 rounded-full flex-shrink-0 mr-1" style={{ background: fileColor(entry.name) }} />

      {/* Name + directory */}
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] truncate ${locked ? 'text-orange-400/80' : watched ? 'text-blue-400/80' : 'text-white/70'}`}>
          {entry.name}
        </div>
        {showDirectory && (
          <div className="text-[10px] text-white/20 truncate">{parentDir(entry.path)}</div>
        )}
      </div>

      {/* Action buttons */}
      <div className={`flex items-center gap-0.5 flex-shrink-0 ${locked || watched ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
        <button
          onClick={e => { e.stopPropagation(); onToggleLock(entry.path, locked); }}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
          title={locked ? 'Unlock file' : 'Lock file'}
        >
          {locked
            ? <Lock size={10} className="text-orange-400" />
            : <LockOpen size={10} className="text-white/20 hover:text-white/50" />}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onToggleWatch(entry.path, watched); }}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
          title={watched ? 'Stop watching' : 'Watch file'}
        >
          {watched
            ? <Eye size={10} className="text-blue-400" />
            : <EyeOff size={10} className="text-white/20 hover:text-white/50" />}
        </button>
      </div>
    </div>
  );
}

// ── Tree Node Row ──────────────────────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  locks: string[];
  watches: string[];
  onExpand: (path: string) => void;
  onToggleLock: (path: string, locked: boolean) => void;
  onToggleWatch: (path: string, watched: boolean) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
}

function TreeNodeRow({
  node, depth, locks, watches,
  onExpand, onToggleLock, onToggleWatch, onContextMenu,
}: TreeNodeRowProps) {
  const locked = isLockedPath(node.path, locks);
  const watched = isWatchedPath(node.path, watches);

  return (
    <>
      <div
        className="group flex items-center gap-1 pr-2 py-1 hover:bg-white/[0.03] transition-colors"
        style={{ paddingLeft: 14 + depth * 16 }}
        onContextMenu={e => onContextMenu(e, node.path)}
      >
        {/* Expand toggle (dirs only) */}
        {node.is_dir ? (
          <button
            onClick={() => onExpand(node.path)}
            className="w-3 h-3 flex items-center justify-center text-white/30 cursor-pointer flex-shrink-0"
          >
            {node.loading ? (
              <Loader2 size={9} className="animate-spin" />
            ) : (
              <ChevronRight
                size={9}
                strokeWidth={3}
                style={{ transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
              />
            )}
          </button>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {/* Icon */}
        {node.is_dir ? (
          node.expanded
            ? <FolderOpen size={12} className="text-white/40 flex-shrink-0" />
            : <Folder size={12} className="text-white/40 flex-shrink-0" />
        ) : (
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: fileColor(node.name) }}
          />
        )}

        {/* Name */}
        <button
          onClick={() => node.is_dir && onExpand(node.path)}
          className={`flex-1 text-[12px] text-left truncate transition-colors cursor-default ${
            locked ? 'text-orange-400/80' : watched ? 'text-blue-400/80' : 'text-white/70'
          } ${node.is_dir ? 'cursor-pointer' : ''}`}
        >
          {node.name}
        </button>

        {/* Action buttons */}
        <div className={`flex items-center gap-0.5 flex-shrink-0 ${locked || watched ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
          <button
            onClick={e => { e.stopPropagation(); onToggleLock(node.path, locked); }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
            title={locked ? `Unlock ${node.is_dir ? 'folder' : 'file'}` : `Lock ${node.is_dir ? 'folder' : 'file'}`}
          >
            {locked
              ? <Lock size={10} className="text-orange-400" />
              : <LockOpen size={10} className="text-white/20 hover:text-white/50" />}
          </button>

          {!node.is_dir && (
            <button
              onClick={e => { e.stopPropagation(); onToggleWatch(node.path, watched); }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer transition-colors"
              title={watched ? 'Stop watching' : 'Watch file'}
            >
              {watched
                ? <Eye size={10} className="text-blue-400" />
                : <EyeOff size={10} className="text-white/20 hover:text-white/50" />}
            </button>
          )}
        </div>
      </div>

      {/* Children */}
      {node.is_dir && node.expanded && node.children && node.children.map(child => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          locks={locks}
          watches={watches}
          onExpand={onExpand}
          onToggleLock={onToggleLock}
          onToggleWatch={onToggleWatch}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

// ── Filter Pill ─────────────────────────────────────────────────────

function FilterPill({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[11px] rounded-full transition-colors cursor-pointer ${
        active ? 'bg-white/10 font-semibold text-white' : 'text-white/30 hover:text-white/50'
      }`}
    >
      {label}
      {count != null && count > 0 && (
        <span className="ml-1 text-white/20">{count}</span>
      )}
    </button>
  );
}

// ── Empty States ────────────────────────────────────────────────────

function EmptyFilterState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-white/20 text-[12px]">
      {label}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 py-8 text-center">
      <div className="relative w-14 h-14">
        <div className="absolute inset-0 rounded-full" style={{
          background: 'conic-gradient(rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.04) 75%, rgba(255,255,255,0.15) 100%)',
          padding: '1px',
        }}>
          <div className="w-full h-full rounded-full backdrop-blur-xl bg-white/[0.05] flex items-center justify-center">
            <FileText size={22} className="text-white/40" strokeWidth={1.5} />
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="font-semibold">No Project Files</p>
        <p className="text-[13px] text-white/40 leading-relaxed">
          Add a project to browse{'\n'}its files here.
        </p>
      </div>
    </div>
  );
}

// ── Context Menu ────────────────────────────────────────────────────

function ContextMenu({ x, y, path, onClose }: {
  x: number; y: number; path: string; onClose: () => void;
}) {
  // Flip up if near bottom of viewport
  const top = y + 160 > window.innerHeight ? y - 80 : y;
  const left = x + 180 > window.innerWidth ? x - 180 : x;

  const copy = () => {
    navigator.clipboard?.writeText(path).catch(() => {});
    onClose();
  };

  const reveal = () => {
    import('../../services/api-client').then(({ apiClient }) => {
      apiClient.revealInFinder(path).catch(() => {});
    });
    onClose();
  };

  return (
    <div
      className="fixed z-[9999] py-1 rounded-xl bg-[#1c1c1e]/95 backdrop-blur-xl border border-white/[0.1] shadow-2xl min-w-[180px]"
      style={{ top, left }}
      onMouseDown={e => e.stopPropagation()}
    >
      <button
        onClick={reveal}
        className="w-full flex items-center gap-2.5 px-3 py-[7px] text-[13px] text-white/80 hover:bg-white/[0.07] transition-colors cursor-pointer text-left"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-blue-400 flex-shrink-0">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        Show in Finder
      </button>
      <div className="h-px bg-white/[0.07] mx-2 my-0.5" />
      <button
        onClick={copy}
        className="w-full flex items-center gap-2.5 px-3 py-[7px] text-[13px] text-white/80 hover:bg-white/[0.07] transition-colors cursor-pointer text-left"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-white/40 flex-shrink-0">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy Path
      </button>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function entryToNode(e: FsEntry): TreeNode {
  return { ...e, children: null, loading: false, expanded: false };
}
