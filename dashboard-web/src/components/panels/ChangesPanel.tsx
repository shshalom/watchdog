import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import {
  FilePlus,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  X,
  XCircle,
  Plus,
  Minus,
  PlusCircle,
  PencilLine,
  Trash2,
  ArrowLeftRight,
  Circle,
  Copy,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';
import type {
  FileChangeVM,
  DiffHunk,
  DiffLine,
  FileOperation,
} from '../../models/types';
import { extensionColor, operationColor } from '../../models/types';
import { apiClient } from '../../services/api-client';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChangesPanelProps {
  fileChanges: FileChangeVM[];
  isExpanded: boolean;
  onToggle: () => void;
  navigateToPath: string | null;
  onNavigateHandled: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOccurrences(search: string, text: string): number {
  if (!search) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = text.indexOf(search, idx);
    if (pos === -1) break;
    count++;
    idx = pos + search.length;
  }
  return count;
}

function countMatchesInDiff(file: FileChangeVM, searchText: string): number {
  if (!searchText) return 0;
  const lower = searchText.toLowerCase();
  return file.hunks
    .flatMap((h) => h.lines)
    .reduce((sum, line) => sum + countOccurrences(lower, line.content.toLowerCase()), 0);
}

function operationIcon(op: FileOperation) {
  switch (op) {
    case 'create': return PlusCircle;
    case 'modify': return PencilLine;
    case 'delete': return Trash2;
    case 'rename': return ArrowLeftRight;
    default: return Circle;
  }
}

// ---------------------------------------------------------------------------
// Flattened entry for rendering diff
// ---------------------------------------------------------------------------

interface FlatEntry {
  hunk: DiffHunk;
  line: DiffLine | null;
}

function flattenHunks(hunks: DiffHunk[]): FlatEntry[] {
  return hunks.flatMap((hunk) => [
    { hunk, line: null },
    ...hunk.lines.map((line) => ({ hunk, line })),
  ]);
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------

function ContextMenu({
  x, y, file, onClose,
}: {
  x: number; y: number; file: FileChangeVM; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const copyPath = useCallback(() => {
    navigator.clipboard.writeText(file.path);
    onClose();
  }, [file.path, onClose]);

  const revealInFinder = useCallback(() => {
    apiClient.revealInFinder(file.path).catch(() => {});
    onClose();
  }, [file.path, onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(y, window.innerHeight - 120),
    left: Math.min(x, window.innerWidth - 200),
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="w-48 py-1 rounded-lg border border-white/[0.08] bg-zinc-900/95 backdrop-blur shadow-2xl"
    >
      <button
        onClick={copyPath}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200
                   hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        Copy Path
      </button>
      <button
        onClick={revealInFinder}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200
                   hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <FolderOpen className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        Reveal in Finder
      </button>
      <div className="h-px bg-white/[0.06] my-1" />
      <button
        disabled
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-400/40
                   cursor-not-allowed text-left"
        title="Coming soon — requires server endpoint"
      >
        <RotateCcw className="w-3.5 h-3.5 shrink-0" />
        Revert Changes
      </button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Resize Handle
// Direct DOM mutation during drag — zero React re-renders until mouseup.
// ---------------------------------------------------------------------------

function ResizeHandle({
  panelRef,
  isResizingRef,
  onWidthCommit,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  isResizingRef: React.RefObject<boolean>;
  onWidthCommit: (w: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const panelEl = panelRef.current;
      if (!panelEl) return;

      setActive(true);
      isResizingRef.current = true;
      panelEl.style.transition = 'none'; // kill width transition during drag
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const startX = e.clientX;
      const startWidth = panelEl.offsetWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 350), 900);
        panelEl.style.width = `${w}px`; // direct DOM — no React re-render
      };

      const onMouseUp = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 350), 900);
        isResizingRef.current = false;
        setActive(false);
        panelEl.style.transition = ''; // restore transition
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        onWidthCommit(w); // one React re-render only on release
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [panelRef, isResizingRef, onWidthCommit],
  );

  return (
    <div
      className="absolute left-0 top-0 bottom-0 w-[10px] flex items-center justify-center z-10 cursor-col-resize"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={onMouseDown}
    >
      <div
        className="w-[4px] h-10 rounded-full transition-colors duration-150"
        style={{
          backgroundColor: active
            ? 'rgba(255,255,255,0.4)'
            : hovered
              ? 'rgba(255,255,255,0.25)'
              : 'rgba(255,255,255,0.1)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ChangesPanel({
  fileChanges,
  isExpanded,
  onToggle,
  navigateToPath,
  onNavigateHandled,
}: ChangesPanelProps) {
  const [selectedFile, setSelectedFile] = useState<FileChangeVM | null>(null);
  const [listSearchText, setListSearchText] = useState('');
  const [contentSearchText, setContentSearchText] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [panelWidth, setPanelWidth] = useState(520);
  const [computedMaxH, setComputedMaxH] = useState('calc(100vh - 120px)');

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const matchRefs = useRef<Map<number, HTMLElement>>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // Measure real top position → panel never overflows viewport bottom.
  // Skip updates during active resize to avoid overwriting direct DOM mutations.
  useLayoutEffect(() => {
    if (!isExpanded) return;
    const update = () => {
      if (isResizingRef.current) return;
      const el = panelRef.current;
      if (!el) return;
      const { top } = el.getBoundingClientRect();
      setComputedMaxH(`${Math.max(window.innerHeight - top - 12, 200)}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [isExpanded]);

  // Navigate-to-path handling
  useEffect(() => {
    if (!navigateToPath) return;
    if (!isExpanded) onToggle();
    const file = fileChanges.find((f) => f.path === navigateToPath);
    if (file) setSelectedFile(file);
    onNavigateHandled();
  }, [navigateToPath, fileChanges, isExpanded, onToggle, onNavigateHandled]);

  // Reset search when switching files
  useEffect(() => {
    setContentSearchText('');
    setCurrentMatchIndex(0);
  }, [selectedFile?.id]);

  // Reset match index when search text changes
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [contentSearchText]);

  // Scroll to current match
  const scrollToCurrentMatch = useCallback((idx: number) => {
    const el = matchRefs.current.get(idx);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Register a match ref
  const setMatchRef = useCallback((idx: number, el: HTMLElement | null) => {
    if (el) matchRefs.current.set(idx, el);
    else matchRefs.current.delete(idx);
  }, []);

  // -----------------------------------------------------------------------
  // Collapsed button
  // -----------------------------------------------------------------------

  if (!isExpanded) {
    return (
      <button
        onClick={onToggle}
        className="changes-btn-enter changes-warp-btn relative glass-panel flex items-center justify-center
                   w-[40px] h-[40px] cursor-pointer"
        style={{ borderRadius: 12 }}
      >
        <FilePlus className="w-[18px] h-[18px] text-zinc-300" />
        {fileChanges.length > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center
                       rounded-full bg-blue-500 text-white text-[9px] font-bold leading-none px-1"
          >
            {fileChanges.length}
          </span>
        )}
      </button>
    );
  }

  // -----------------------------------------------------------------------
  // Expanded panel
  // -----------------------------------------------------------------------

  const width = selectedFile ? panelWidth : 330;
  const maxH = selectedFile ? computedMaxH : '40vh';

  return (
    <div
      ref={panelRef}
      className="changes-panel-enter glass-panel relative flex flex-col overflow-hidden"
      style={{
        width,
        maxHeight: maxH,
        minHeight: selectedFile ? 300 : 200,
        transition: 'width 0.3s cubic-bezier(0.34, 1.2, 0.64, 1)',
      }}
    >
      {selectedFile && (
        <ResizeHandle
          panelRef={panelRef}
          isResizingRef={isResizingRef}
          onWidthCommit={setPanelWidth}
        />
      )}

      <PanelHeader
        selectedFile={selectedFile}
        fileChanges={fileChanges}
        onBack={() => {
          setSelectedFile(null);
          setContentSearchText('');
          setCurrentMatchIndex(0);
        }}
        onClose={() => {
          onToggle();
          setSelectedFile(null);
          setContentSearchText('');
        }}
      />

      <div className="h-px bg-white/[0.08]" />

      {fileChanges.length === 0 ? (
        <EmptyState />
      ) : selectedFile ? (
        <DiffContentView
          file={selectedFile}
          contentSearchText={contentSearchText}
          setContentSearchText={setContentSearchText}
          currentMatchIndex={currentMatchIndex}
          setCurrentMatchIndex={setCurrentMatchIndex}
          scrollContainerRef={scrollContainerRef}
          scrollToCurrentMatch={scrollToCurrentMatch}
          setMatchRef={setMatchRef}
          matchRefs={matchRefs}
        />
      ) : (
        <FileListView
          fileChanges={fileChanges}
          searchText={listSearchText}
          setSearchText={setListSearchText}
          onSelectFile={setSelectedFile}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel Header
// ---------------------------------------------------------------------------

function PanelHeader({
  selectedFile, fileChanges, onBack, onClose,
}: {
  selectedFile: FileChangeVM | null;
  fileChanges: FileChangeVM[];
  onBack: () => void;
  onClose: () => void;
}) {
  if (selectedFile) {
    return (
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="text-sm">Changes</span>
        </button>
        <div className="flex-1" />
        <span className="text-sm font-semibold text-zinc-100 truncate max-w-[200px]">
          {selectedFile.name}
        </span>
        <DiffStatBadge additions={selectedFile.additions} removals={selectedFile.removals} />
        <CloseButton onClick={onClose} />
      </div>
    );
  }

  const totalAdd = fileChanges.reduce((s, f) => s + f.additions, 0);
  const totalRem = fileChanges.reduce((s, f) => s + f.removals, 0);

  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
      <FilePlus className="w-4 h-4 text-zinc-400" />
      <span className="text-base font-semibold text-zinc-100">Changes</span>
      <div className="flex-1" />
      {(totalAdd > 0 || totalRem > 0) && (
        <DiffStatBadge additions={totalAdd} removals={totalRem} />
      )}
      <CloseButton onClick={onClose} />
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer">
      <XCircle className="w-4 h-4" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Diff Stat Badge
// ---------------------------------------------------------------------------

function DiffStatBadge({ additions, removals }: { additions: number; removals: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-bold tabular-nums">
      {additions > 0 && <span className="text-green-400">+{additions}</span>}
      {removals > 0 && <span className="text-red-400">&minus;{removals}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 py-12 px-6 gap-3">
      <div className="relative w-14 h-14 flex items-center justify-center">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'conic-gradient(rgba(255,255,255,0.15), rgba(255,255,255,0.04), rgba(255,255,255,0.15))',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 1px), #000 calc(100% - 1px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 1px), #000 calc(100% - 1px))',
          }}
        />
        <div className="w-[54px] h-[54px] rounded-full bg-white/[0.04] backdrop-blur flex items-center justify-center">
          <FilePlus className="w-[22px] h-[22px] text-zinc-500" strokeWidth={1.2} />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-zinc-200">No Changes Yet</p>
        <p className="text-sm text-zinc-500 mt-1 leading-relaxed">
          File changes made by the agent<br />will appear here.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File List View
// ---------------------------------------------------------------------------

function FileListView({
  fileChanges, searchText, setSearchText, onSelectFile,
}: {
  fileChanges: FileChangeVM[];
  searchText: string;
  setSearchText: (t: string) => void;
  onSelectFile: (f: FileChangeVM) => void;
}) {
  const filtered = useMemo(() => {
    if (!searchText) return fileChanges;
    const lower = searchText.toLowerCase();
    return fileChanges.filter(
      (f) => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower),
    );
  }, [fileChanges, searchText]);

  return (
    <div className="flex flex-col flex-1 min-h-0 py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Search className="w-3 h-3 text-zinc-600 shrink-0" />
        <input
          type="text"
          placeholder="Filter files"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none border-none"
        />
        {searchText && (
          <button onClick={() => setSearchText('')} className="text-zinc-600 hover:text-zinc-400 cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="h-px bg-white/[0.06]" />

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <Search className="w-5 h-5 text-zinc-600" />
          <span className="text-sm text-zinc-500">No matching files</span>
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 min-h-0">
          {filtered.map((file) => (
            <FileListRow key={file.id} file={file} onClick={() => onSelectFile(file)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File List Row (context menu on right-click)
// ---------------------------------------------------------------------------

function FileListRow({ file, onClick }: { file: FileChangeVM; onClick: () => void }) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const extColor = extensionColor(file.path);
  const opColor = operationColor(file.operation);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={handleContextMenu}
        className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.04]
                   transition-colors cursor-pointer text-left"
      >
        <div
          className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
          style={{ backgroundColor: extColor + '26' }}
        >
          <span className="text-[8px] font-bold font-mono leading-none" style={{ color: extColor }}>
            {file.ext}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-zinc-100 truncate">{file.name}</span>
            <span
              className="shrink-0 text-[8px] font-bold px-1.5 py-[1px] rounded-full"
              style={{ color: opColor, backgroundColor: opColor + '1F' }}
            >
              {file.operation.toUpperCase()}
            </span>
          </div>
          <p className="text-xs font-mono text-zinc-600 truncate mt-0.5">{file.directory}</p>
        </div>

        <DiffStatBadge additions={file.additions} removals={file.removals} />
        <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
      </button>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          file={file}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Diff Content View
// Perf: pre-computed cumulative offsets (O(n) total vs O(n²)).
//       currentMatchIndex changes update DOM directly — no row re-renders.
// ---------------------------------------------------------------------------

function DiffContentView({
  file,
  contentSearchText,
  setContentSearchText,
  currentMatchIndex,
  setCurrentMatchIndex,
  scrollContainerRef,
  scrollToCurrentMatch,
  setMatchRef,
  matchRefs,
}: {
  file: FileChangeVM;
  contentSearchText: string;
  setContentSearchText: (t: string) => void;
  currentMatchIndex: number;
  setCurrentMatchIndex: (n: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  scrollToCurrentMatch: (idx: number) => void;
  setMatchRef: (idx: number, el: HTMLElement | null) => void;
  matchRefs: React.RefObject<Map<number, HTMLElement>>;
}) {
  const allEntries = useMemo(() => flattenHunks(file.hunks), [file.hunks]);

  const totalMatches = useMemo(
    () => countMatchesInDiff(file, contentSearchText),
    [file, contentSearchText],
  );

  // Pre-compute cumulative match offsets once — O(n) total instead of O(n²) per render.
  const cumulativeOffsets = useMemo(() => {
    if (!contentSearchText) return null;
    const lower = contentSearchText.toLowerCase();
    const offsets = new Array<number>(allEntries.length).fill(0);
    let count = 0;
    for (let i = 0; i < allEntries.length; i++) {
      offsets[i] = count;
      const { line } = allEntries[i];
      if (line) count += countOccurrences(lower, line.content.toLowerCase());
    }
    return offsets;
  }, [allEntries, contentSearchText]);

  // Scroll to top when file changes.
  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [file.id, scrollContainerRef]);

  // Apply current-match highlight directly in the DOM — no row re-renders needed.
  useEffect(() => {
    matchRefs.current.forEach((el, idx) => {
      const isCurrent = idx === currentMatchIndex;
      el.style.backgroundColor = isCurrent ? 'rgba(250, 204, 21, 0.8)' : 'rgba(250, 204, 21, 0.25)';
      el.style.color = isCurrent ? '#000' : '#facc15';
    });
  }, [currentMatchIndex, matchRefs]);

  const OpIcon = operationIcon(file.operation);
  const opColor = operationColor(file.operation);

  const handlePrev = useCallback(() => {
    if (totalMatches <= 0) return;
    const next = (currentMatchIndex - 1 + totalMatches) % totalMatches;
    setCurrentMatchIndex(next);
    scrollToCurrentMatch(next);
  }, [totalMatches, currentMatchIndex, setCurrentMatchIndex, scrollToCurrentMatch]);

  const handleNext = useCallback(() => {
    if (totalMatches <= 0) return;
    const next = (currentMatchIndex + 1) % totalMatches;
    setCurrentMatchIndex(next);
    scrollToCurrentMatch(next);
  }, [totalMatches, currentMatchIndex, setCurrentMatchIndex, scrollToCurrentMatch]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Search className="w-3 h-3 text-zinc-600 shrink-0" />
        <input
          type="text"
          placeholder="Search in diff"
          value={contentSearchText}
          onChange={(e) => setContentSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (e.shiftKey) handlePrev();
              else handleNext();
            }
          }}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none border-none"
        />
        {contentSearchText && (
          <>
            <span className="text-xs tabular-nums text-zinc-500 shrink-0">
              {totalMatches > 0 ? currentMatchIndex + 1 : 0}/{totalMatches}
            </span>
            <button onClick={handlePrev} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleNext} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { setContentSearchText(''); setCurrentMatchIndex(0); }}
              className="text-zinc-600 hover:text-zinc-400 cursor-pointer"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="h-px bg-white/[0.06]" />

      {/* File path */}
      <div className="flex items-center gap-1.5 px-4 py-1.5">
        <OpIcon className="w-3 h-3 shrink-0" style={{ color: opColor }} />
        <span className="text-xs font-mono text-zinc-600 truncate">{file.path}</span>
      </div>

      <div className="h-px bg-white/[0.04]" />

      {/* Diff scroll area */}
      <div ref={scrollContainerRef} className="overflow-y-auto flex-1 min-h-0 px-2 py-3">
        {allEntries.map((entry, index) => {
          if (!entry.line) {
            return <HunkHeaderRow key={`hunk-${entry.hunk.id}`} hunk={entry.hunk} />;
          }
          return (
            <DiffLineRow
              key={`line-${entry.line.id}`}
              line={entry.line}
              globalOffset={cumulativeOffsets ? cumulativeOffsets[index] : 0}
              searchText={contentSearchText}
              setMatchRef={setMatchRef}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hunk Header Row
// ---------------------------------------------------------------------------

const HunkHeaderRow = React.memo(function HunkHeaderRow({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="w-full text-left px-3 py-1 bg-blue-500/[0.06] rounded-sm mb-px">
      <span className="text-[11px] font-medium font-mono text-blue-400/80">{hunk.header}</span>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Diff Line Row — memoized. currentMatchIndex no longer a prop;
// the parent DiffContentView updates current-match DOM styling directly.
// ---------------------------------------------------------------------------

const DiffLineRow = React.memo(function DiffLineRow({
  line,
  globalOffset,
  searchText,
  setMatchRef,
}: {
  line: DiffLine;
  globalOffset: number;
  searchText: string;
  setMatchRef: (idx: number, el: HTMLElement | null) => void;
}) {
  const bgClass =
    line.type === 'addition'
      ? 'bg-green-500/[0.08]'
      : line.type === 'removal'
        ? 'bg-red-500/[0.08]'
        : '';

  return (
    <div className={`flex items-baseline py-[2px] ${bgClass} rounded-sm`}>
      <span className="shrink-0 w-8 text-right text-[11px] font-mono text-zinc-700 select-none">
        {line.oldLineNum ?? ''}
      </span>
      <span className="shrink-0 w-8 text-right text-[11px] font-mono text-zinc-700 select-none mr-1">
        {line.newLineNum ?? ''}
      </span>

      <span className="shrink-0 w-3.5 flex items-center justify-center mr-1.5">
        {line.type === 'addition' && (
          <span className="w-[10px] h-[10px] rounded-full bg-green-500/80 flex items-center justify-center">
            <Plus className="w-[6px] h-[6px] text-white" strokeWidth={3} />
          </span>
        )}
        {line.type === 'removal' && (
          <span className="w-[10px] h-[10px] rounded-full bg-red-500/80 flex items-center justify-center">
            <Minus className="w-[6px] h-[6px] text-white" strokeWidth={3} />
          </span>
        )}
      </span>

      <span className="text-[13px] font-mono text-zinc-200 whitespace-pre select-text min-h-[1em] break-all">
        {searchText ? (
          <HighlightedText
            text={line.content || ' '}
            search={searchText}
            startMatchIdx={globalOffset}
            setMatchRef={setMatchRef}
          />
        ) : (
          line.content || ' '
        )}
      </span>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Highlighted Text
// Renders all matches with dim-yellow style. Parent's useEffect handles
// which one is "current" via direct DOM mutation — no prop needed here.
// ---------------------------------------------------------------------------

const HighlightedText = React.memo(function HighlightedText({
  text,
  search,
  startMatchIdx,
  setMatchRef,
}: {
  text: string;
  search: string;
  startMatchIdx: number;
  setMatchRef: (idx: number, el: HTMLElement | null) => void;
}) {
  const parts = useMemo(() => {
    const result: { text: string; matchIdx: number | null }[] = [];
    const lower = text.toLowerCase();
    const searchLower = search.toLowerCase();
    let lastEnd = 0;
    let localIdx = 0;

    if (!searchLower) return [{ text, matchIdx: null }];

    let pos = 0;
    while (true) {
      const found = lower.indexOf(searchLower, pos);
      if (found === -1) break;
      if (found > lastEnd) result.push({ text: text.slice(lastEnd, found), matchIdx: null });
      result.push({ text: text.slice(found, found + searchLower.length), matchIdx: startMatchIdx + localIdx });
      lastEnd = found + searchLower.length;
      pos = lastEnd;
      localIdx++;
    }
    if (lastEnd < text.length) result.push({ text: text.slice(lastEnd), matchIdx: null });
    if (result.length === 0) result.push({ text, matchIdx: null });
    return result;
  }, [text, search, startMatchIdx]);

  return (
    <>
      {parts.map((part, i) => {
        if (part.matchIdx === null) return <span key={i}>{part.text}</span>;
        return (
          <mark
            key={i}
            ref={(el) => setMatchRef(part.matchIdx!, el)}
            className="rounded-sm px-px"
            style={{
              backgroundColor: 'rgba(250, 204, 21, 0.25)',
              color: '#facc15',
            }}
          >
            {part.text}
          </mark>
        );
      })}
    </>
  );
});
