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
  FileText,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  X,
  XCircle,
  Lock,
  LockOpen,
  Plus,
  Copy,
  FolderOpen,
  MinusCircle,
} from 'lucide-react';
import type { SpecVM } from '../../models/types';
import { apiClient } from '../../services/api-client';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SpecPanelProps {
  specs: SpecVM[];
  isExpanded: boolean;
  onToggle: () => void;
  auditMode?: string;
  /** Called after any spec add/remove so the parent can refresh the spec list */
  onSpecsChanged?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MatchOccurrence {
  lineIdx: number;
}

/** All individual match occurrences across all lines, in order. */
function findAllOccurrences(lines: string[], query: string): MatchOccurrence[] {
  if (!query) return [];
  const lc = query.toLowerCase();
  const result: MatchOccurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLc = lines[i].toLowerCase();
    let pos = 0;
    while (true) {
      const found = lineLc.indexOf(lc, pos);
      if (found === -1) break;
      result.push({ lineIdx: i });
      pos = found + lc.length;
    }
  }
  return result;
}

/** Map from lineIdx → global index of its first occurrence. */
function buildLineMatchOffsets(occurrences: MatchOccurrence[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < occurrences.length; i++) {
    const { lineIdx } = occurrences[i];
    if (!map.has(lineIdx)) map.set(lineIdx, i);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------

function ContextMenu({
  x, y, spec, onClose, onUnlink,
}: {
  x: number; y: number; spec: SpecVM; onClose: () => void; onUnlink: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(y, window.innerHeight - 110),
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
        onClick={() => { onUnlink(); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/[0.08] transition-colors cursor-pointer text-left"
      >
        <MinusCircle className="w-3.5 h-3.5 shrink-0" />
        Unlink Spec
      </button>
      <div className="h-px bg-white/[0.06] my-1" />
      <button
        onClick={() => { navigator.clipboard.writeText(spec.path); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        Copy Path
      </button>
      <button
        onClick={() => { apiClient.revealInFinder(spec.path).catch(() => {}); onClose(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.06] transition-colors cursor-pointer text-left"
      >
        <FolderOpen className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        Reveal in Finder
      </button>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Resize Handle (same pattern as ChangesPanel — no React re-renders during drag)
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
      panelEl.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const startX = e.clientX;
      const startWidth = panelEl.offsetWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 350), 900);
        panelEl.style.width = `${w}px`;
      };

      const onMouseUp = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const w = Math.min(Math.max(startWidth - delta, 350), 900);
        isResizingRef.current = false;
        setActive(false);
        panelEl.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        onWidthCommit(w);
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
// Spec List Row (gap 4: ext badge, gap 6: context menu)
// ---------------------------------------------------------------------------

const SpecListRow = React.memo(function SpecListRow({
  spec,
  hitCount,
  onClick,
  onUnlink,
  isLearning,
}: {
  spec: SpecVM;
  hitCount: number;
  onClick: () => void;
  onUnlink: () => void;
  isLearning: boolean;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.04] transition-colors cursor-pointer text-left"
      >
        {/* Ext badge — always blue for specs */}
        <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-blue-500/[0.15]">
          <span className="text-[8px] font-bold font-mono leading-none text-blue-400">
            {spec.ext.toUpperCase()}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-100 truncate">{spec.name}</p>
          <p className="text-xs font-mono text-zinc-600 truncate mt-0.5">{spec.path}</p>
        </div>

        {hitCount > 0 && (
          <span className="shrink-0 text-[9px] font-bold px-1.5 py-[2px] rounded-full bg-orange-500/20 text-orange-400">
            {hitCount}
          </span>
        )}

        {isLearning
          ? <LockOpen className="w-3 h-3 text-blue-400/70 shrink-0" />
          : <Lock className="w-3 h-3 text-orange-400/60 shrink-0" />}
        <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
      </button>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          spec={spec}
          onClose={() => setCtxMenu(null)}
          onUnlink={onUnlink}
        />
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// Highlighted Line Text (occurrence-level, registers match refs for DOM styling)
// ---------------------------------------------------------------------------

const HighlightedLineText = React.memo(function HighlightedLineText({
  text,
  search,
  globalOffset,
  setMatchRef,
}: {
  text: string;
  search: string;
  globalOffset: number;
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
      result.push({ text: text.slice(found, found + searchLower.length), matchIdx: globalOffset + localIdx });
      lastEnd = found + searchLower.length;
      pos = lastEnd;
      localIdx++;
    }
    if (lastEnd < text.length) result.push({ text: text.slice(lastEnd), matchIdx: null });
    if (result.length === 0) result.push({ text, matchIdx: null });
    return result;
  }, [text, search, globalOffset]);

  return (
    <>
      {parts.map((part, i) => {
        if (part.matchIdx === null) return <span key={i}>{part.text}</span>;
        return (
          <mark
            key={i}
            ref={(el) => setMatchRef(part.matchIdx!, el)}
            className="rounded-sm px-px"
            style={{ backgroundColor: 'rgba(253, 224, 71, 0.25)', color: 'rgb(253, 224, 71)' }}
          >
            {part.text}
          </mark>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// Spec Line Row (gap 7: pulse flash, gap 8: hit line bg)
// Memoized — currentMatchIndex NOT a prop, DOM-updated by parent.
// ---------------------------------------------------------------------------

const SpecLineRow = React.memo(function SpecLineRow({
  lineIdx,
  line,
  hasBP,
  isHit,
  isTriggered,
  gutterWidth,
  searchText,
  globalOffset,
  setMatchRef,
  onToggleBP,
  setLineRef,
}: {
  lineIdx: number;
  line: string;
  hasBP: boolean;
  isHit: boolean;
  isTriggered: boolean;
  gutterWidth: number;
  searchText: string;
  globalOffset: number;
  setMatchRef: (idx: number, el: HTMLElement | null) => void;
  onToggleBP: () => void;
  setLineRef: (el: HTMLDivElement | null) => void;
}) {
  const [pulsing, setPulsing] = useState(false);
  const wasTriggered = useRef(isTriggered);

  // gap 7: pulse flash when breakpoint first becomes triggered
  useEffect(() => {
    if (isTriggered && !wasTriggered.current) {
      setPulsing(true);
      const t = setTimeout(() => setPulsing(false), 1050);
      return () => clearTimeout(t);
    }
    wasTriggered.current = isTriggered;
  }, [isTriggered]);

  const hasSearch = searchText.length > 0;
  const isMatchLine = hasSearch && globalOffset >= 0;

  return (
    <div
      ref={setLineRef}
      className={[
        'flex items-stretch hover:bg-white/[0.025]',
        isTriggered ? 'bg-orange-500/[0.10]' : isHit ? 'bg-orange-500/[0.04]' : '',
      ].join(' ')}
    >
      {/* Pulse flash overlay */}
      {pulsing && (
        <div className="spec-pulse-flash absolute inset-0 pointer-events-none" />
      )}

      {/* Gutter */}
      <button
        onClick={onToggleBP}
        className="relative shrink-0 flex items-center justify-end gap-1 pr-2 pl-2 text-zinc-700
                   hover:text-zinc-500 transition-colors cursor-pointer select-none border-r border-white/[0.05]"
        style={{ minWidth: gutterWidth * 8 + 32 }}
        title={hasBP ? 'Remove breakpoint' : 'Add breakpoint'}
      >
        {hasBP ? (
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isTriggered
                ? 'bg-orange-400 shadow-[0_0_4px_rgba(251,146,60,0.6)]'
                : 'bg-blue-400 shadow-[0_0_4px_rgba(96,165,250,0.5)]'
            }`}
          />
        ) : (
          <span className="w-2 h-2 shrink-0" />
        )}
        <span className="tabular-nums text-[11px] font-mono" style={{ minWidth: gutterWidth * 8 }}>
          {lineIdx + 1}
        </span>
      </button>

      {/* Line content */}
      <div className="flex-1 px-3 whitespace-pre-wrap break-words text-zinc-300 text-[13px] font-mono leading-[22px]">
        {isMatchLine && searchText
          ? <HighlightedLineText
              text={line || ' '}
              search={searchText}
              globalOffset={globalOffset}
              setMatchRef={setMatchRef}
            />
          : (line || ' ')
        }
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Spec Content View
// ---------------------------------------------------------------------------

function SpecContentView({
  spec,
  breakpoints,
  onToggleBreakpoint,
  searchText,
  onSearchChange,
  currentMatchIndex,
  onSetMatchIndex,
  onBack,
  onClose,
  isLearning,
}: {
  spec: SpecVM;
  breakpoints: Set<number>;
  onToggleBreakpoint: (line: number) => void;
  searchText: string;
  onSearchChange: (v: string) => void;
  currentMatchIndex: number;
  onSetMatchIndex: (i: number) => void;
  onBack: () => void;
  onClose: () => void;
  isLearning: boolean;
}) {
  const lines = useMemo(() => spec.content.split('\n'), [spec.content]);

  // gap 9: occurrence-level search (not line-level)
  const allOccurrences = useMemo(
    () => findAllOccurrences(lines, searchText),
    [lines, searchText],
  );

  const lineMatchOffsets = useMemo(
    () => buildLineMatchOffsets(allOccurrences),
    [allOccurrences],
  );

  const totalMatches = allOccurrences.length;
  const gutterWidth = String(lines.length).length;

  const matchRefs = useRef<Map<number, HTMLElement>>(new Map());
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const setMatchRef = useCallback((idx: number, el: HTMLElement | null) => {
    if (el) matchRefs.current.set(idx, el);
    else matchRefs.current.delete(idx);
  }, []);

  const setLineRef = useCallback((lineIdx: number, el: HTMLDivElement | null) => {
    if (el) lineRefs.current.set(lineIdx, el);
    else lineRefs.current.delete(lineIdx);
  }, []);

  // Direct DOM current-match styling — no re-render on prev/next
  useEffect(() => {
    matchRefs.current.forEach((el, idx) => {
      const isCurrent = idx === currentMatchIndex;
      el.style.backgroundColor = isCurrent ? 'rgba(250, 204, 21, 0.8)' : 'rgba(253, 224, 71, 0.25)';
      el.style.color = isCurrent ? '#000' : 'rgb(253, 224, 71)';
    });
  }, [currentMatchIndex]);

  // Scroll to the line containing the current occurrence
  useEffect(() => {
    if (allOccurrences.length === 0) return;
    const lineIdx = allOccurrences[currentMatchIndex]?.lineIdx;
    if (lineIdx === undefined) return;
    lineRefs.current.get(lineIdx)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentMatchIndex, allOccurrences]);

  // Scroll to top when spec changes
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [spec.id]);

  const handlePrev = useCallback(() => {
    if (totalMatches === 0) return;
    onSetMatchIndex((currentMatchIndex - 1 + totalMatches) % totalMatches);
  }, [currentMatchIndex, totalMatches, onSetMatchIndex]);

  const handleNext = useCallback(() => {
    if (totalMatches === 0) return;
    onSetMatchIndex((currentMatchIndex + 1) % totalMatches);
  }, [currentMatchIndex, totalMatches, onSetMatchIndex]);

  const bpCount = breakpoints.size;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header — gap 5: "< Specs" text, gap 6: bp count */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="text-sm">Specs</span>
        </button>
        <div className="flex-1" />
        <span className="text-sm font-semibold text-zinc-100 truncate max-w-[180px]">{spec.name}</span>
        {bpCount > 0 && (
          <span className="flex items-center gap-1 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="text-[11px] font-bold text-blue-400">{bpCount}</span>
          </span>
        )}
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer shrink-0">
          <XCircle className="w-4 h-4" />
        </button>
      </div>

      <div className="h-px bg-white/[0.08]" />

      {/* Search bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Search className="w-3 h-3 text-zinc-600 shrink-0" />
        <input
          type="text"
          placeholder="Search in spec"
          value={searchText}
          onChange={(e) => { onSearchChange(e.target.value); onSetMatchIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { if (e.shiftKey) handlePrev(); else handleNext(); }
          }}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none border-none"
        />
        {searchText && (
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
              onClick={() => { onSearchChange(''); onSetMatchIndex(0); }}
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
        {isLearning
          ? <LockOpen className="w-3 h-3 text-blue-400/70 shrink-0" />
          : <Lock className="w-3 h-3 text-orange-400/60 shrink-0" />}
        <span className="text-xs font-mono text-zinc-600 truncate">{spec.path}</span>
      </div>

      <div className="h-px bg-white/[0.04]" />

      {/* Lines */}
      <div ref={scrollRef} className="overflow-y-auto flex-1 min-h-0 py-2 relative">
        {lines.map((line, idx) => {
          const hasBP = breakpoints.has(idx);
          const isHit = spec.hitLines.has(idx);
          const isTriggered = hasBP && isHit;
          const globalOffset = lineMatchOffsets.has(idx) ? lineMatchOffsets.get(idx)! : -1;

          return (
            <SpecLineRow
              key={idx}
              lineIdx={idx}
              line={line}
              hasBP={hasBP}
              isHit={isHit}
              isTriggered={isTriggered}
              gutterWidth={gutterWidth}
              searchText={searchText}
              globalOffset={globalOffset}
              setMatchRef={setMatchRef}
              onToggleBP={() => onToggleBreakpoint(idx)}
              setLineRef={(el) => setLineRef(idx, el)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spec List View
// ---------------------------------------------------------------------------

function SpecListView({
  specs,
  searchText,
  onSearchChange,
  onSelect,
  onUnlink,
  isLearning,
}: {
  specs: SpecVM[];
  searchText: string;
  onSearchChange: (v: string) => void;
  onSelect: (spec: SpecVM) => void;
  onUnlink: (spec: SpecVM) => void;
  isLearning: boolean;
}) {
  const filtered = useMemo(() => {
    if (!searchText) return specs;
    const lc = searchText.toLowerCase();
    return specs.filter((s) => s.name.toLowerCase().includes(lc) || s.path.toLowerCase().includes(lc));
  }, [specs, searchText]);

  return (
    <div className="flex flex-col flex-1 min-h-0 py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Search className="w-3 h-3 text-zinc-600 shrink-0" />
        <input
          type="text"
          placeholder="Filter specs"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none border-none"
        />
        {searchText && (
          <button onClick={() => onSearchChange('')} className="text-zinc-600 hover:text-zinc-400 cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="h-px bg-white/[0.06]" />

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <Search className="w-5 h-5 text-zinc-600" />
          <span className="text-sm text-zinc-500">No matching specs</span>
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 min-h-0">
          {filtered.map((spec) => (
            <SpecListRow
              key={spec.id}
              spec={spec}
              hitCount={spec.hitLines.size}
              onClick={() => onSelect(spec)}
              onUnlink={() => onUnlink(spec)}
              isLearning={isLearning}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState({ onLinkFiles }: { onLinkFiles: () => void }) {
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
          <FileText className="w-[22px] h-[22px] text-zinc-500" strokeWidth={1.2} />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-zinc-200">No Specs Linked</p>
        <p className="text-sm text-zinc-500 mt-1 leading-relaxed">
          Link spec files to a session<br />to view them here.
        </p>
      </div>
      <button
        onClick={onLinkFiles}
        className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium
                   text-zinc-300 border border-white/[0.12] hover:bg-white/[0.06]
                   transition-colors cursor-pointer mt-1"
      >
        <Plus className="w-3.5 h-3.5" />
        Link Specs
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpecPanel (main export)
// ---------------------------------------------------------------------------

export default function SpecPanel({ specs, isExpanded, onToggle, auditMode, onSpecsChanged }: SpecPanelProps) {
  const [selectedSpec, setSelectedSpec] = useState<SpecVM | null>(null);
  const [listSearchText, setListSearchText] = useState('');
  const [contentSearchText, setContentSearchText] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [breakpoints, setBreakpoints] = useState<Map<string, Set<number>>>(() => new Map());
  const [panelWidth, setPanelWidth] = useState(520);
  const [computedMaxH, setComputedMaxH] = useState('calc(100vh - 120px)');

  const panelRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // Keep selectedSpec reference fresh when specs array updates
  const activeSpec = useMemo(() => {
    if (!selectedSpec) return null;
    return specs.find((s) => s.id === selectedSpec.id) ?? selectedSpec;
  }, [specs, selectedSpec]);

  // Total hit lines across all specs (for collapsed badge)
  const totalHits = useMemo(
    () => specs.reduce((sum, s) => sum + s.hitLines.size, 0),
    [specs],
  );

  // Measured maxHeight — same approach as ChangesPanel
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
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [isExpanded]);

  // Reset search when switching specs
  useEffect(() => {
    setContentSearchText('');
    setCurrentMatchIndex(0);
  }, [selectedSpec?.id]);

  // Reset match index when search text changes
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [contentSearchText]);

  const handleUnlinkSpec = useCallback(async (spec: SpecVM) => {
    const remaining = specs.filter((s) => s.path !== spec.path).map((s) => s.path);
    await apiClient.reloadSpecs(remaining);
    onSpecsChanged?.();
  }, [specs, onSpecsChanged]);

  const handleLinkFiles = useCallback(async () => {
    const picked = await apiClient.pickFiles('Select spec files');
    if (picked.length === 0) return;
    const currentPaths = specs.map((s) => s.path);
    const toAdd = picked.filter((p) => !currentPaths.includes(p));
    if (toAdd.length > 0) {
      await apiClient.reloadSpecs([...currentPaths, ...toAdd]);
      onSpecsChanged?.();
    }
  }, [specs, onSpecsChanged]);

  const toggleBreakpoint = useCallback((specId: string, line: number) => {
    setBreakpoints((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(specId) ?? []);
      if (set.has(line)) set.delete(line); else set.add(line);
      next.set(specId, set);
      return next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // Collapsed button (gap 1: 34×34 square, warp, btn-pop animation)
  // -----------------------------------------------------------------------

  if (!isExpanded) {
    return (
      <button
        onClick={onToggle}
        className="changes-btn-enter changes-warp-btn relative glass-panel flex items-center justify-center
                   w-[40px] h-[40px] cursor-pointer"
        style={{ borderRadius: 12 }}
      >
        <FileText className="w-[18px] h-[18px] text-zinc-300" />
        {totalHits > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center
                       rounded-full bg-orange-500 text-white text-[9px] font-bold leading-none px-1"
          >
            {totalHits}
          </span>
        )}
      </button>
    );
  }

  // -----------------------------------------------------------------------
  // Expanded panel
  // -----------------------------------------------------------------------

  const isLearning = auditMode === 'learning';
  const width = activeSpec ? panelWidth : 330;
  const maxH = activeSpec ? computedMaxH : '40vh';

  return (
    <div
      ref={panelRef}
      className="changes-panel-enter glass-panel relative flex flex-col overflow-hidden"
      style={{
        width,
        maxHeight: maxH,
        minHeight: activeSpec ? 300 : 200,
        transition: 'width 0.3s cubic-bezier(0.34, 1.2, 0.64, 1)',
      }}
    >
      {activeSpec && (
        <ResizeHandle panelRef={panelRef} isResizingRef={isResizingRef} onWidthCommit={setPanelWidth} />
      )}

      {/* Header — list state */}
      {!activeSpec && (
        <>
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
            <FileText className="w-4 h-4 text-zinc-400" />
            <span className="text-base font-semibold text-zinc-100">Specs</span>
            <div className="flex-1" />
            <button
              onClick={handleLinkFiles}
              className="text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
              title="Link spec files"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button onClick={onToggle} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
          <div className="h-px bg-white/[0.08]" />
        </>
      )}

      {/* Body */}
      {specs.length === 0 ? (
        <EmptyState onLinkFiles={handleLinkFiles} />
      ) : activeSpec ? (
        <SpecContentView
          spec={activeSpec}
          breakpoints={breakpoints.get(activeSpec.id) ?? new Set()}
          onToggleBreakpoint={(line) => toggleBreakpoint(activeSpec.id, line)}
          searchText={contentSearchText}
          onSearchChange={setContentSearchText}
          currentMatchIndex={currentMatchIndex}
          onSetMatchIndex={setCurrentMatchIndex}
          isLearning={isLearning}
          onBack={() => {
            setSelectedSpec(null);
            setContentSearchText('');
            setCurrentMatchIndex(0);
          }}
          onClose={() => {
            onToggle();
            setSelectedSpec(null);
            setContentSearchText('');
          }}
        />
      ) : (
        <SpecListView
          specs={specs}
          searchText={listSearchText}
          onSearchChange={setListSearchText}
          onUnlink={handleUnlinkSpec}
          isLearning={isLearning}
          onSelect={(spec) => {
            setSelectedSpec(spec);
            setContentSearchText('');
            setCurrentMatchIndex(0);
          }}
        />
      )}
    </div>
  );
}
