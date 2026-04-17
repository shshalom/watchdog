import type { GraphNodeVM } from '../../models/types';
import { operationColor } from '../../models/types';

interface Props {
  node: GraphNodeVM;
  position: { x: number; y: number };
  onDismiss: () => void;
  onViewDiff: () => void;
  onViewAudit: () => void;
}

export function NodeDetailCard({ node, position, onDismiss, onViewDiff, onViewAudit }: Props) {
  const opColor = operationColor(node.operation);
  const opLabel = node.operation === 'create' ? 'Created' : node.operation === 'modify' ? 'Modified' : node.operation === 'delete' ? 'Deleted' : node.operation === 'read' ? 'Read' : 'Unknown';

  const auditBadge = () => {
    if (node.auditStatus === 'drift') return { color: '#ef4444', label: 'Drift', bg: 'rgba(239,68,68,0.12)' };
    if (node.auditStatus === 'aligned') return { color: '#22c55e', label: 'Aligned', bg: 'rgba(34,197,94,0.1)' };
    return { color: '#6b7280', label: 'Pending', bg: 'rgba(107,114,128,0.1)' };
  };

  const badge = auditBadge();

  // Clamp position to viewport
  const x = Math.min(Math.max(position.x, 160), window.innerWidth - 160);
  const y = Math.min(Math.max(position.y - 120, 140), window.innerHeight - 140);

  return (
    <div
      className="fixed z-50 w-[280px] glass-panel animate-in fade-in zoom-in-95 duration-200"
      style={{ left: x, top: y, transform: 'translate(-50%, 0)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-3.5">
        <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: `${node.color}33` }}>
          <span className="text-[10px] font-bold font-mono" style={{ color: node.color }}>{node.ext || '?'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold truncate">{node.name}</p>
          <p className="text-[10px] text-white/40 truncate">{node.directory}</p>
        </div>
        <button onClick={onDismiss} className="w-5 h-5 rounded-full bg-white/5 flex items-center justify-center text-white/30 hover:text-white/60 cursor-pointer">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="h-px bg-white/5" />

      {/* Stats */}
      <div className="flex items-center gap-4 px-3.5 py-2.5">
        <span className="flex items-center gap-1 text-[10px] font-medium" style={{ color: opColor }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" /></svg>
          {opLabel}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-medium text-white/40">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h10M4 18h14" /></svg>
          {node.changeSize} lines
        </span>
        <div className="flex-1" />
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-semibold" style={{ color: badge.color, background: badge.bg }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: badge.color }} />
          {badge.label}
        </span>
      </div>

      {/* References */}
      {node.imports.length > 0 && (
        <>
          <div className="h-px bg-white/5" />
          <div className="px-3.5 py-2.5">
            <p className="text-[9px] font-bold text-white/20 tracking-wider mb-1.5">REFERENCES</p>
            <div className="flex flex-wrap gap-1">
              {node.imports.slice(0, 8).map(ref => (
                <span key={ref} className="px-1.5 py-0.5 text-[10px] font-mono text-white/40 bg-white/5 rounded">{ref}</span>
              ))}
              {node.imports.length > 8 && <span className="text-[10px] text-white/20">+{node.imports.length - 8}</span>}
            </div>
          </div>
        </>
      )}

      <div className="h-px bg-white/5" />

      {/* Actions */}
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <button onClick={onViewDiff} className="flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 cursor-pointer">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
          View Diff
        </button>
        <button onClick={onViewAudit} className="flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 cursor-pointer">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          View Audit
        </button>
      </div>
    </div>
  );
}
