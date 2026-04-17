import { useRef, useEffect, useCallback } from 'react';
import type { GraphNodeVM, AuditStatus } from '../../models/types';
import { extensionColor } from '../../models/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GraphViewProps {
  nodes: GraphNodeVM[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null, screenPos: { x: number; y: number }) => void;
  hasSessions?: boolean;
  isSessionSelected?: boolean;
  isLoading?: boolean;
  onResumeSession?: () => void;
  watchedPaths?: string[];
  connectionMode?: 'references' | 'temporal';
  sizeFactor?: number;
  repulsionForce?: number;
  lineWidth?: number;
  gridOpacity?: number;
  showFileTypes?: boolean;
  ambientMotion?: boolean;
  showClusters?: boolean;
  clusterOpacity?: number;
  showDeleted?: boolean;
  minCollapse?: number;
}

// ---------------------------------------------------------------------------
// Internal physics node
// ---------------------------------------------------------------------------

interface PhysicsNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  radius: number;
  color: string;
  name: string;
  ext: string;
  directory: string;
  auditStatus: AuditStatus;
  imports: string[];
  changeSize: number;
  spawnTime: number;
  animationProgress: number;
  // Extended
  operation: string;       // 'create' | 'modify' | 'delete' | 'read' | 'bash' | 'unknown'
  activityTime: number;    // performance.now() when last touched — drives pulse animation
  isWatched: boolean;
  timestamp: number;       // ms epoch — for temporal connections
  selectionProgress: number; // 0→1 spring animation when selected
  dimProgress: number;       // 0→1 when node is dimmed (not connected to selection)
}

// ---------------------------------------------------------------------------
// Connection between two physics node indices
// ---------------------------------------------------------------------------

interface Connection {
  i: number;
  j: number;
  opacity: number;
  temporal?: boolean; // purple tint for temporal mode
}

// ---------------------------------------------------------------------------
// Cluster boundary info
// ---------------------------------------------------------------------------

interface ClusterInfo {
  directory: string;
  hull: { x: number; y: number }[];     // world-space convex hull of node centers
  centroid: { x: number; y: number };   // world-space centroid
  color: string;
  nodeCount: number;
  hasDrift: boolean;
  maxRadius: number;                    // largest node radius in world space
  indices: number[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function blendHex(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  const blend = (c: number) => Math.round(c + (255 - c) * factor);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}

// ---------------------------------------------------------------------------
// Convex hull (Graham scan) — matches Swift implementation exactly
// ---------------------------------------------------------------------------

function convexHull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return [...pts];
  const start = pts.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x)) ? b : a);
  const sorted = [...pts].sort((a, b) => {
    const angA = Math.atan2(a.y - start.y, a.x - start.x);
    const angB = Math.atan2(b.y - start.y, b.x - start.x);
    if (Math.abs(angA - angB) > 0.0001) return angA - angB;
    const dA = (a.x - start.x) ** 2 + (a.y - start.y) ** 2;
    const dB = (b.x - start.x) ** 2 + (b.y - start.y) ** 2;
    return dA - dB;
  });
  const hull: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cross <= 0) hull.pop(); else break;
    }
    hull.push(p);
  }
  return hull;
}


// ---------------------------------------------------------------------------
// Catmull-Rom closed spline through hull points — proven smooth rendering
// ---------------------------------------------------------------------------

function catmullRomClosed(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], segments = 16) {
  if (pts.length < 2) return;
  const n = pts.length;
  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const t2 = t * t, t3 = t2 * t;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  ctx.moveTo(result[0].x, result[0].y);
  for (let i = 1; i < result.length; i++) ctx.lineTo(result[i].x, result[i].y);
  ctx.closePath();
}

function operationGlowColor(op: string): string {
  switch (op) {
    case 'create': return '#22c55e';
    case 'modify': return '#f97316';
    case 'read':   return '#06b6d4';
    case 'delete': return '#ef4444';
    default:       return '#ffffff';
  }
}

function nodeRadius(changeSize: number, factor = 2.5): number {
  return Math.max(8, Math.min(24, 8 + Math.sqrt(changeSize) * factor));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GraphView({
  nodes, selectedNodeId, onSelectNode,
  hasSessions, isSessionSelected, isLoading, onResumeSession,
  watchedPaths, connectionMode, sizeFactor = 2.5,
  repulsionForce = 70, lineWidth = 1.0, gridOpacity = 3,
  showFileTypes = true, ambientMotion = true, showClusters = true,
  clusterOpacity = 8, showDeleted = true, minCollapse = 4,
}: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Mutable state refs (no re-renders needed for physics)
  const physicsRef = useRef<PhysicsNode[]>([]);
  const connectionsRef = useRef<Connection[]>([]);
  const transformRef = useRef({ offsetX: 0, offsetY: 0, scale: 1 });
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0, startX: 0, startY: 0, didDrag: false });
  const watchedPathsRef = useRef<string[]>(watchedPaths ?? []);
  const connectionModeRef = useRef(connectionMode ?? 'references');
  const collapseProgressRef = useRef<Map<string, number>>(new Map());
  const sizeFactorRef = useRef(sizeFactor);
  const repulsionRef = useRef(repulsionForce);
  const lineWidthRef = useRef(lineWidth);
  const gridOpacityRef = useRef(gridOpacity);
  const showFileTypesRef = useRef(showFileTypes);
  const ambientMotionRef = useRef(ambientMotion);
  const showClustersRef = useRef(showClusters);
  const clusterOpacityRef = useRef(clusterOpacity);
  const showDeletedRef = useRef(showDeleted);
  const minCollapseRef = useRef(minCollapse);

  // Keep refs in sync
  useEffect(() => { watchedPathsRef.current = watchedPaths ?? []; }, [watchedPaths]);
  useEffect(() => {
    sizeFactorRef.current = sizeFactor;
    // Immediately update radii of all existing nodes — syncNodes only runs on new file activity
    for (const pn of physicsRef.current) {
      pn.radius = nodeRadius(pn.changeSize, sizeFactor);
    }
  }, [sizeFactor]);
  useEffect(() => { repulsionRef.current = repulsionForce; }, [repulsionForce]);
  useEffect(() => { lineWidthRef.current = lineWidth; }, [lineWidth]);
  useEffect(() => { gridOpacityRef.current = gridOpacity; }, [gridOpacity]);
  useEffect(() => { showFileTypesRef.current = showFileTypes; }, [showFileTypes]);
  useEffect(() => { ambientMotionRef.current = ambientMotion; }, [ambientMotion]);
  useEffect(() => { showClustersRef.current = showClusters; }, [showClusters]);
  useEffect(() => { clusterOpacityRef.current = clusterOpacity; }, [clusterOpacity]);
  useEffect(() => { showDeletedRef.current = showDeleted; }, [showDeleted]);
  useEffect(() => { minCollapseRef.current = minCollapse; }, [minCollapse]);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const nodesSnapshotRef = useRef<GraphNodeVM[]>([]);
  const selectedRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelectNode);

  // Keep callback ref current
  onSelectRef.current = onSelectNode;
  selectedRef.current = selectedNodeId;

  // ------------------------------------------------------------------
  // Sync nodes into physics simulation
  // ------------------------------------------------------------------

  const syncNodes = useCallback((incoming: GraphNodeVM[]) => {
    const existing = physicsRef.current;
    const existingById = new Map(existing.map((n) => [n.id, n]));
    const incomingIds = new Set(incoming.map((n) => n.id));

    // Remove stale
    const kept = existing.filter((n) => incomingIds.has(n.id));

    // Update existing nodes' audit status / color / operation
    const watched = watchedPathsRef.current;
    for (const pn of kept) {
      const src = incoming.find((n) => n.id === pn.id);
      if (src) {
        pn.auditStatus = src.auditStatus;
        pn.color = src.color || extensionColor(src.path);
        pn.name = src.name;
        pn.changeSize = src.changeSize;
        pn.radius = nodeRadius(src.changeSize, sizeFactorRef.current);
        pn.imports = src.imports;
        if (src.operation !== pn.operation) pn.activityTime = performance.now();
        pn.operation = src.operation;
        pn.isWatched = watched.some(w => pn.id === w || pn.id.startsWith(w + '/'));
        if (src.timestamp) pn.timestamp = new Date(src.timestamp).getTime();
      }
    }

    // Cluster layout for new nodes
    const now = performance.now();
    const dirCenters = new Map<string, { x: number; y: number; count: number }>();

    for (const pn of kept) {
      const entry = dirCenters.get(pn.directory) || { x: 0, y: 0, count: 0 };
      entry.x += pn.x;
      entry.y += pn.y;
      entry.count += 1;
      dirCenters.set(pn.directory, entry);
    }

    const goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));
    const clusterRadius = 250;
    const allDirs = [...new Set(incoming.map((n) => n.directory))].sort();
    const dirAngle = new Map<string, number>();
    allDirs.forEach((d, i) => {
      dirAngle.set(d, (i * 2 * Math.PI) / Math.max(allDirs.length, 1) - Math.PI / 2);
    });

    for (const node of incoming) {
      if (existingById.has(node.id)) continue;

      let cx: number;
      let cy: number;
      const entry = dirCenters.get(node.directory);
      if (entry && entry.count > 0) {
        cx = entry.x / entry.count;
        cy = entry.y / entry.count;
      } else {
        const angle = dirAngle.get(node.directory) ?? Math.random() * Math.PI * 2;
        cx = Math.cos(angle) * clusterRadius;
        cy = Math.sin(angle) * clusterRadius;
      }

      const idx = (entry?.count ?? 0);
      const angle = idx * goldenAngle;
      const dist = 40 + idx * 30;
      const tx = cx + Math.cos(angle) * dist;
      const ty = cy + Math.sin(angle) * dist;

      const pn: PhysicsNode = {
        id: node.id,
        x: cx + (Math.random() - 0.5) * 20,
        y: cy + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        targetX: tx,
        targetY: ty,
        radius: nodeRadius(node.changeSize, sizeFactorRef.current),
        color: node.color || extensionColor(node.path),
        name: node.name,
        operation: node.operation,
        activityTime: performance.now(),
        isWatched: watched.some(w => node.id === w || node.id.startsWith(w + '/')),
        timestamp: node.timestamp ? new Date(node.timestamp).getTime() : 0,
        selectionProgress: 0,
        dimProgress: 0,
        ext: node.ext,
        directory: node.directory,
        auditStatus: node.auditStatus,
        imports: node.imports,
        changeSize: node.changeSize,
        spawnTime: now,
        animationProgress: 0,
      };

      kept.push(pn);

      // Update dir center tracking
      const dirEntry = dirCenters.get(node.directory) || { x: 0, y: 0, count: 0 };
      dirEntry.x += tx;
      dirEntry.y += ty;
      dirEntry.count += 1;
      dirCenters.set(node.directory, dirEntry);
    }

    physicsRef.current = kept;

    // Rebuild connections
    buildConnections(kept);
  }, []);

  // ------------------------------------------------------------------
  // Build import-based connections
  // ------------------------------------------------------------------

  const buildConnections = useCallback((pNodes: PhysicsNode[], mode?: string) => {
    const resolvedMode = mode ?? connectionModeRef.current;
    const conns: Connection[] = [];

    if (resolvedMode === 'temporal') {
      // Temporal: connect files modified close in time, purple tint.
      // Window is relative to session span so it works whether session lasted
      // 30s or several hours — always shows the most temporally related files.
      const sorted = pNodes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.timestamp > 0)
        .sort((a, b) => a.n.timestamp - b.n.timestamp);

      if (sorted.length >= 2) {
        const span = sorted[sorted.length - 1].n.timestamp - sorted[0].n.timestamp;
        // Window = 30% of session span, min 30s, max 10min
        const WINDOW_MS = Math.min(600000, Math.max(30000, span * 0.3));

        for (let k = 0; k < sorted.length; k++) {
          for (let m = k + 1; m < sorted.length; m++) {
            const diff = sorted[m].n.timestamp - sorted[k].n.timestamp;
            if (diff > WINDOW_MS) break;
            const proximity = 1 - diff / WINDOW_MS;
            conns.push({ i: sorted[k].i, j: sorted[m].i, opacity: 0.1 + proximity * 0.25, temporal: true });
          }
        }
      }
    } else {
      // References: import matching + sibling bonds
      const stemToIndices = new Map<string, number[]>();
      for (let i = 0; i < pNodes.length; i++) {
        const name = pNodes[i].name;
        const dot = name.lastIndexOf('.');
        const stem = (dot >= 0 ? name.slice(0, dot) : name).toLowerCase();
        const arr = stemToIndices.get(stem) || [];
        arr.push(i);
        stemToIndices.set(stem, arr);
      }
      const seen = new Set<string>();
      for (let i = 0; i < pNodes.length; i++) {
        for (const imp of pNodes[i].imports) {
          const targets = stemToIndices.get(imp.toLowerCase());
          if (!targets) continue;
          for (const j of targets) {
            if (j === i) continue;
            const k = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (!seen.has(k)) { seen.add(k); conns.push({ i, j, opacity: 0.1 }); }
          }
        }
      }
      // Sibling bonds
      const dirGroups = new Map<string, number[]>();
      for (let i = 0; i < pNodes.length; i++) {
        const arr = dirGroups.get(pNodes[i].directory) || [];
        arr.push(i);
        dirGroups.set(pNodes[i].directory, arr);
      }
      for (const indices of dirGroups.values()) {
        if (indices.length < 2) continue;
        for (let k = 0; k < indices.length - 1; k++) {
          const a = indices[k], b = indices[k + 1];
          const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
          if (!seen.has(ek)) { seen.add(ek); conns.push({ i: a, j: b, opacity: 0.06 }); }
        }
      }
    }

    connectionsRef.current = conns;
  }, []);

  // Rebuild connections when mode changes (declared after buildConnections)
  useEffect(() => {
    connectionModeRef.current = connectionMode ?? 'references';
    buildConnections(physicsRef.current, connectionMode ?? 'references');
  }, [connectionMode, buildConnections]);

  // ------------------------------------------------------------------
  // Physics tick
  // ------------------------------------------------------------------

  const physicsTick = useCallback((dt: number) => {
    const pNodes = physicsRef.current;
    const n = pNodes.length;
    if (n === 0) return;

    // Pre-compute connected set for dim animation
    const sel = selectedRef.current;
    const connectedSet = new Set<string>();
    if (sel) {
      connectedSet.add(sel);
      const selIdx = pNodes.findIndex(p => p.id === sel);
      if (selIdx >= 0) {
        for (const conn of connectionsRef.current) {
          if (conn.i === selIdx) connectedSet.add(pNodes[conn.j].id);
          if (conn.j === selIdx) connectedSet.add(pNodes[conn.i].id);
        }
      }
    }

    const now = performance.now();
    const damping = 0.92;
    // Map repulsionForce (20-200 UI range) → physics strength (1000-15000)
    const repulsionStrength = repulsionRef.current * 70;
    const centerStrength = 0.002;
    const skipDistSq = 500 * 500; // Skip repulsion for very distant pairs

    // Repulsion (Coulomb) — O(n^2) with distance cutoff
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pNodes[j].x - pNodes[i].x;
        let dy = pNodes[j].y - pNodes[i].y;
        const distSq = dx * dx + dy * dy;

        if (distSq > skipDistSq) continue;

        const dist = Math.max(1, Math.sqrt(distSq));
        const minDist = pNodes[i].radius + pNodes[j].radius + 10;

        if (dist < minDist * 4) {
          const force = repulsionStrength / (distSq + 100);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          pNodes[i].vx -= fx;
          pNodes[i].vy -= fy;
          pNodes[j].vx += fx;
          pNodes[j].vy += fy;
        }

        // Hard collision
        if (dist < minDist) {
          const overlap = minDist - dist;
          const push = overlap * 0.5;
          const nx = dx / dist;
          const ny = dy / dist;
          pNodes[i].x -= nx * push;
          pNodes[i].y -= ny * push;
          pNodes[j].x += nx * push;
          pNodes[j].y += ny * push;
        }
      }
    }

    // Cluster cohesion — pull same-directory nodes toward their group centroid
    // Without this, nodes drift up to 500 world units apart and boundaries look terrible.
    const clusterCohesion = 0.004;
    const dirGroups = new Map<string, { sx: number; sy: number; count: number }>();
    for (const pn of pNodes) {
      const g = dirGroups.get(pn.directory) ?? { sx: 0, sy: 0, count: 0 };
      g.sx += pn.x; g.sy += pn.y; g.count++;
      dirGroups.set(pn.directory, g);
    }
    for (const pn of pNodes) {
      const g = dirGroups.get(pn.directory);
      if (!g || g.count < 2) continue;
      const cx = g.sx / g.count;
      const cy = g.sy / g.count;
      pn.vx += (cx - pn.x) * clusterCohesion;
      pn.vy += (cy - pn.y) * clusterCohesion;
    }

    // Centering force + target attraction + damping + ambient motion
    for (let i = 0; i < n; i++) {
      const pn = pNodes[i];

      // Pull toward center
      pn.vx -= pn.x * centerStrength;
      pn.vy -= pn.y * centerStrength;

      // Pull toward target position
      const dxTarget = pn.targetX - pn.x;
      const dyTarget = pn.targetY - pn.y;
      pn.vx += dxTarget * 0.005;
      pn.vy += dyTarget * 0.005;

      // Damping
      pn.vx *= damping;
      pn.vy *= damping;

      // Integrate
      pn.x += pn.vx * dt;
      pn.y += pn.vy * dt;

      // Ambient drift is applied at render time (not here) to keep physics clean

      // Spawn animation progress
      const spawnElapsed = (now - pn.spawnTime) / 1000;
      pn.animationProgress = Math.min(1, spawnElapsed / 0.6);
      pn.animationProgress = 1 - Math.pow(1 - pn.animationProgress, 2);

      // Selection ring spring animation
      const targetSel = pn.id === selectedRef.current ? 1 : 0;
      pn.selectionProgress += (targetSel - pn.selectionProgress) * Math.min(1, dt * 14);

      // Dim animation: unconnected nodes fade when selection is active
      const targetDim = sel && !connectedSet.has(pn.id) ? 1 : 0;
      pn.dimProgress += (targetDim - pn.dimProgress) * Math.min(1, dt * 8);
    }
  }, []);

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number, dt: number) => {
    const pNodes = physicsRef.current;
    const conns = connectionsRef.current;
    const { offsetX, offsetY, scale } = transformRef.current;
    const cx = width / 2;
    const cy = height / 2;
    const now = performance.now() / 1000; // seconds

    // Clear
    ctx.clearRect(0, 0, width, height);

    // World transform helper
    const toScreen = (wx: number, wy: number) => ({
      x: (wx * scale) + cx + offsetX,
      y: (wy * scale) + cy + offsetY,
    });

    // Ambient drift offset — disabled when ambientMotion is off
    const driftOf = (pn: PhysicsNode, idx: number) => {
      if (!ambientMotionRef.current) return { x: 0, y: 0 };
      const seed = idx * 1.7;
      const amp = pn.animationProgress;
      return {
        x: (Math.sin(now * 0.3 + seed) * 4 + Math.cos(now * 0.17 + seed * 0.6) * 2.5) * amp,
        y: (Math.cos(now * 0.25 + seed * 1.3) * 4 + Math.sin(now * 0.2 + seed * 0.4) * 2.5) * amp,
      };
    };

    // ------ Compute clusters + update collapse progress ------
    const COLLAPSE_THRESHOLD = 0.55;
    const COLLAPSE_SPEED = 3.5;
    const clusters = _computeClusterInfo(pNodes);
    const clusterCentroids = new Map<string, { x: number; y: number }>();
    for (const cl of clusters) {
      // Only collapse clusters that have enough nodes
      const target = scale < COLLAPSE_THRESHOLD && cl.nodeCount >= minCollapseRef.current ? 1 : 0;
      const prev = collapseProgressRef.current.get(cl.directory) ?? 0;
      const next = prev + (target - prev) * Math.min(1, COLLAPSE_SPEED * dt);
      collapseProgressRef.current.set(cl.directory, next);
      clusterCentroids.set(cl.directory, cl.centroid);
    }

    // ------ Pre-compute drifted + collapse-offset screen positions ------
    const nodePos = pNodes.map((pn, idx) => {
      const d = driftOf(pn, idx);
      const cp = collapseProgressRef.current.get(pn.directory) ?? 0;
      const centroid = clusterCentroids.get(pn.directory);
      let wx = pn.x + d.x;
      let wy = pn.y + d.y;
      if (cp > 0 && centroid) {
        wx = wx + (centroid.x - wx) * cp;
        wy = wy + (centroid.y - wy) * cp;
      }
      return toScreen(wx, wy);
    });

    // ------ Dot grid ------
    drawGrid(ctx, width, height, cx, cy, offsetX, offsetY, scale, gridOpacityRef.current);

    // ------ Cluster boundaries (convex hull + Catmull-Rom spline) ------
    for (const cluster of clusters) {
      if (!showClustersRef.current) break;
      const cp = collapseProgressRef.current.get(cluster.directory) ?? 0;
      const boundaryAlpha = 1 - cp;
      if (boundaryAlpha < 0.01) continue;

      // Convert hull to screen space; corner radius = (maxRadius + padding) * zoom
      const screenHull = cluster.hull.map(p => toScreen(p.x, p.y));
      if (screenHull.length === 0) continue;

      const { r: cr, g: cg, b: cb } = hexToRgb(cluster.color);

      ctx.save();
      ctx.globalAlpha = boundaryAlpha;

      // Fill
      ctx.beginPath();
      catmullRomClosed(ctx, screenHull);
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.05)`;
      ctx.fill();

      // Glow stroke
      ctx.beginPath();
      catmullRomClosed(ctx, screenHull);
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.08)`;
      ctx.lineWidth = 5 * scale;
      ctx.stroke();

      // Edge stroke — opacity driven by clusterOpacity setting
      ctx.beginPath();
      catmullRomClosed(ctx, screenHull);
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${Math.max(0.15, clusterOpacityRef.current / 100)})`;
      ctx.lineWidth = 1.5 * scale;
      ctx.stroke();

      // Label at hull centroid (Swift places label at hullCenter)
      const centroidScreen = toScreen(cluster.centroid.x, cluster.centroid.y);
      const dirName = cluster.directory.split('/').pop() || cluster.directory;
      ctx.font = `${Math.max(9, 10 * scale)}px monospace`;
      ctx.fillStyle = `rgba(255, 255, 255, 0.12)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dirName, centroidScreen.x, centroidScreen.y);

      ctx.restore();
    }

    // ------ Connections ------
    for (const conn of conns) {
      if (conn.i >= pNodes.length || conn.j >= pNodes.length) continue;
      const a = nodePos[conn.i];
      const b = nodePos[conn.j];

      // Curved connection
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ctrlX = midX - dy * 0.08;
      const ctrlY = midY + dx * 0.08;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(ctrlX, ctrlY, b.x, b.y);
      ctx.strokeStyle = conn.temporal
        ? `rgba(153, 102, 255, ${conn.opacity})`
        : `rgba(255, 255, 255, ${conn.opacity})`;
      ctx.lineWidth = Math.max(0.5, lineWidthRef.current * scale);
      ctx.stroke();
    }

    // Focus dimming is now fully handled per-node via pn.dimProgress (animated in physicsTick)

    // ------ Nodes ------
    for (let i = 0; i < pNodes.length; i++) {
      const pn = pNodes[i];
      const pos = nodePos[i];
      const r = pn.radius * scale * pn.animationProgress;
      if (r < 0.5) continue;

      const isGhost = pn.operation === 'delete';
      // Respect showDeleted setting
      if (isGhost && !showDeletedRef.current) continue;
      const { r: cr, g: cg, b: cb } = hexToRgb(pn.color);
      const collapseAlpha = 1 - (collapseProgressRef.current.get(pn.directory) ?? 0) * 0.9;
      // dimProgress: 0=full opacity, 1=fully dimmed. 0.88 = 1 - 0.12 (min visible alpha)
      const dimAlpha = 1.0 - pn.dimProgress * 0.88;

      ctx.save();
      ctx.globalAlpha = dimAlpha * (isGhost ? 0.25 : 1.0) * collapseAlpha;

      // ------ Activity pulse (expanding ring on recent file touch) ------
      const timeSinceActivity = (performance.now() - pn.activityTime) / 1000;
      if (pn.activityTime > 0 && timeSinceActivity < 2.0 && !isGhost) {
        const t = timeSinceActivity / 2.0;
        const glowCol = operationGlowColor(pn.operation);
        const { r: gr, g: gg, b: gb } = hexToRgb(glowCol);
        // Ring 1
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + t * 40 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${gr}, ${gg}, ${gb}, ${(1 - t) * 0.6})`;
        ctx.lineWidth = 2 * scale * (1 - t);
        ctx.stroke();
        // Ring 2 (offset)
        if (timeSinceActivity < 1.5) {
          const t2 = (timeSinceActivity + 0.5) / 2.0;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, r + t2 * 40 * scale, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${gr}, ${gg}, ${gb}, ${(1 - t2) * 0.4})`;
          ctx.lineWidth = 1.5 * scale * (1 - t2);
          ctx.stroke();
        }
      }

      // ------ Drift halo (pulsing red for drift status) ------
      if (pn.auditStatus === 'drift') {
        const pulse = 0.3 + 0.15 * Math.sin(now * 4.0);
        const haloR = r + 8 * scale;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, haloR + 4 * scale, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(239, 68, 68, ${pulse * 0.2})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, haloR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${pulse})`;
        ctx.lineWidth = 1.5 * scale;
        ctx.stroke();
        const pulse2 = 0.2 + 0.1 * Math.sin(now * 3.0 + 1.0);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, haloR + 4 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${pulse2 * 0.3})`;
        ctx.lineWidth = 1.0 * scale;
        ctx.stroke();
      }

      // ------ Aligned ring ------
      if (pn.auditStatus === 'aligned') {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 4 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.35)';
        ctx.lineWidth = 1.2 * scale;
        ctx.stroke();
      }

      // ------ Pending ring ------
      if (pn.auditStatus === 'pending') {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 3 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(107, 114, 128, 0.3)';
        ctx.lineWidth = 1 * scale;
        ctx.stroke();
      }

      // ------ Watch indicator (blue dashed ring + dot) ------
      if (pn.isWatched) {
        ctx.setLineDash([3 * scale, 2 * scale]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 5 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(96, 165, 250, 0.7)';
        ctx.lineWidth = 1.2 * scale;
        ctx.stroke();
        ctx.setLineDash([]);
        // Dot at top-left
        ctx.beginPath();
        ctx.arc(pos.x - r * 0.707, pos.y - r * 0.707, 2.5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(96, 165, 250, 0.9)';
        ctx.fill();
      }

      // ------ Operation-tinted outer glow ------
      const glowColor = operationGlowColor(pn.operation);
      const { r: gr, g: gg, b: gb } = hexToRgb(glowColor);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 3 * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${gr}, ${gg}, ${gb}, 0.12)`;
      ctx.fill();

      // ------ Main node: radial gradient fill ------
      const grad = ctx.createRadialGradient(pos.x, pos.y - r * 0.2, 0, pos.x, pos.y, r);
      const lightened = blendHex(pn.color, 0.3);
      grad.addColorStop(0, withAlpha(lightened, 0.9));
      grad.addColorStop(0.6, `rgba(${cr}, ${cg}, ${cb}, 0.85)`);
      grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.7)`);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // ------ Rim stroke ------
      const rimColor = blendHex(pn.color, 0.4);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(rimColor, 0.5);
      ctx.lineWidth = 1.2 * scale;
      ctx.stroke();

      // ------ Created file: dashed green rim ------
      if (pn.operation === 'create') {
        ctx.setLineDash([4 * scale, 3 * scale]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 2 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.5)';
        ctx.lineWidth = 1.5 * scale;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ------ Ghost node: dashed white rim ------
      if (isGhost) {
        ctx.setLineDash([3 * scale, 3 * scale]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.2 * scale;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ------ Selection ring (spring animated) ------
      if (pn.selectionProgress > 0.01) {
        const sp = pn.selectionProgress;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 6 * scale * sp, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * sp})`;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 9 * scale * sp, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.2 * sp})`;
        ctx.lineWidth = 1 * scale;
        ctx.stroke();
      }

      // ------ Extension label inside node ------
      if (showFileTypesRef.current && r >= 10 * scale) {
        const fontSize = Math.max(7, Math.min(10, r * 0.45));
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pn.ext || '?', pos.x, pos.y);
      }

      // ------ Filename below node ------
      const labelSize = Math.max(8, 10 * scale);
      ctx.font = `${labelSize}px monospace`;
      ctx.fillStyle = isGhost ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.45)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(pn.name, pos.x, pos.y + r + 6 * scale);

      // ------ Ghost: strikethrough on name ------
      if (isGhost) {
        const tw = ctx.measureText(pn.name).width;
        const ly = pos.x + r + 6 * scale + labelSize * 0.5;
        ctx.beginPath();
        ctx.moveTo(pos.x - tw / 2, ly);
        ctx.lineTo(pos.x + tw / 2, ly);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();
    }

    // ------ Cluster bubbles (drawn over nodes when collapsing) ------
    for (const cluster of clusters) {
      const cp = collapseProgressRef.current.get(cluster.directory) ?? 0;
      if (cp < 0.05) continue;

      const centroidScreen = toScreen(cluster.centroid.x, cluster.centroid.y);
      const bubbleR = (18 + Math.sqrt(cluster.nodeCount) * 10) * scale;
      const { r: cr, g: cg, b: cb } = hexToRgb(cluster.color);

      ctx.save();
      ctx.globalAlpha = cp;

      // Outer glow
      ctx.beginPath();
      ctx.arc(centroidScreen.x, centroidScreen.y, bubbleR + 8 * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.06)`;
      ctx.fill();

      // Glass fill
      const grad = ctx.createRadialGradient(
        centroidScreen.x, centroidScreen.y - bubbleR * 0.2, 0,
        centroidScreen.x, centroidScreen.y, bubbleR
      );
      grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.18)`);
      grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.07)`);
      ctx.beginPath();
      ctx.arc(centroidScreen.x, centroidScreen.y, bubbleR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Rim
      ctx.beginPath();
      ctx.arc(centroidScreen.x, centroidScreen.y, bubbleR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.3)`;
      ctx.lineWidth = 1.5 * scale;
      ctx.stroke();

      // Drift ring
      if (cluster.hasDrift) {
        const pulse = 0.3 + 0.15 * Math.sin(now * 4.0);
        ctx.beginPath();
        ctx.arc(centroidScreen.x, centroidScreen.y, bubbleR + 4 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239, 68, 68, ${pulse})`;
        ctx.lineWidth = 1.5 * scale;
        ctx.stroke();
      }

      // Directory name
      const dirName = cluster.directory.split('/').pop() || cluster.directory;
      ctx.font = `bold ${Math.max(9, 11 * scale)}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dirName, centroidScreen.x, centroidScreen.y - 5 * scale);

      // File count
      ctx.font = `${Math.max(8, 9 * scale)}px monospace`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillText(`${cluster.nodeCount} files`, centroidScreen.x, centroidScreen.y + 7 * scale);

      ctx.restore();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // Dot grid background
  // ------------------------------------------------------------------

  const drawGrid = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, cx: number, cy: number, ox: number, oy: number, s: number, opacityPct = 4) => {
      if (opacityPct <= 0) return;
      const spacing = 40 * s;
      if (spacing < 4) return;

      const originX = cx + ox;
      const originY = cy + oy;
      const startX = originX % spacing;
      const startY = originY % spacing;

      ctx.fillStyle = `rgba(255, 255, 255, ${opacityPct / 100})`;
      for (let x = startX; x < w; x += spacing) {
        for (let y = startY; y < h; y += spacing) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    []
  );

  // ------------------------------------------------------------------
  // Cluster boundary computation
  // ------------------------------------------------------------------

  // computeClusterInfo is defined as a module-level function below the component
  // (referenced via the module-scope function to avoid hoisting issues with useCallback)
  const _computeClusterInfo = (pNodes: PhysicsNode[]): ClusterInfo[] => {
    const dirMap = new Map<string, { indices: number[]; color: string }>();
    for (let i = 0; i < pNodes.length; i++) {
      const dir = pNodes[i].directory;
      const entry = dirMap.get(dir) || { indices: [], color: pNodes[i].color };
      entry.indices.push(i);
      dirMap.set(dir, entry);
    }

    const results: ClusterInfo[] = [];

    for (const [dir, { indices, color }] of dirMap) {
      if (indices.length < 2) continue;

      // Minkowski-sum hull: 32 circle samples per node prevents collinear degeneration
      const SAMPLES = 32;
      const BASE_PAD = 22;
      const perimPts: { x: number; y: number }[] = [];
      let cx = 0, cy = 0;
      let hasDrift = false;
      let maxRadius = 0;
      for (const idx of indices) {
        const pn = pNodes[idx];
        cx += pn.x; cy += pn.y;
        if (pn.auditStatus === 'drift') hasDrift = true;
        maxRadius = Math.max(maxRadius, pn.radius);
        const r = pn.radius + BASE_PAD;
        for (let s = 0; s < SAMPLES; s++) {
          const a = (s / SAMPLES) * Math.PI * 2;
          perimPts.push({ x: pn.x + Math.cos(a) * r, y: pn.y + Math.sin(a) * r });
        }
      }
      cx /= indices.length;
      cy /= indices.length;

      const expanded = convexHull(perimPts);

      results.push({
        directory: dir,
        hull: expanded,
        centroid: { x: cx, y: cy },
        color,
        nodeCount: indices.length,
        hasDrift,
        maxRadius,
        indices,
      });
    }

    return results;
  };


  // ------------------------------------------------------------------
  // Color with alpha helper
  // ------------------------------------------------------------------

  function withAlpha(rgb: string, alpha: number): string {
    // rgb is "rgb(r, g, b)"
    const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
    return rgb;
  }

  // ------------------------------------------------------------------
  // Hit testing
  // ------------------------------------------------------------------

  const hitTest = useCallback((screenX: number, screenY: number): { id: string; sx: number; sy: number } | null => {
    const pNodes = physicsRef.current;
    const { offsetX, offsetY, scale } = transformRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const cx = canvas.width / (2 * (window.devicePixelRatio || 1));
    const cy = canvas.height / (2 * (window.devicePixelRatio || 1));

    // Convert screen to world
    const wx = (screenX - cx - offsetX) / scale;
    const wy = (screenY - cy - offsetY) / scale;

    let closest: { id: string; sx: number; sy: number; dist: number } | null = null;
    const now = performance.now() / 1000;

    for (let i = 0; i < pNodes.length; i++) {
      const pn = pNodes[i];
      // Apply same drift as rendering so hit targets are accurate
      const seed = i * 1.7;
      const amp = pn.animationProgress;
      const driftX = (Math.sin(now * 0.3 + seed) * 4 + Math.cos(now * 0.17 + seed * 0.6) * 2.5) * amp;
      const driftY = (Math.cos(now * 0.25 + seed * 1.3) * 4 + Math.sin(now * 0.2 + seed * 0.4) * 2.5) * amp;
      const dx = (pn.x + driftX) - wx;
      const dy = (pn.y + driftY) - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = pn.radius + 5;

      if (dist < hitRadius) {
        if (!closest || dist < closest.dist) {
          const sx = (pn.x + driftX) * scale + cx + offsetX;
          const sy = (pn.y + driftY) * scale + cy + offsetY;
          closest = { id: pn.id, sx, sy, dist };
        }
      }
    }

    return closest ? { id: closest.id, sx: closest.sx, sy: closest.sy } : null;
  }, []);

  // ------------------------------------------------------------------
  // Sync effect — update physics when nodes change
  // ------------------------------------------------------------------

  useEffect(() => {
    nodesSnapshotRef.current = nodes;
    syncNodes(nodes);
  }, [nodes, syncNodes]);

  // ------------------------------------------------------------------
  // Canvas setup + animation loop + event handlers
  // ------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resize observer
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // Animation loop
    const loop = (timestamp: number) => {
      const dt = lastTimeRef.current ? Math.min((timestamp - lastTimeRef.current) / 1000, 0.05) : 0.016;
      lastTimeRef.current = timestamp;

      physicsTick(dt);

      const rect = container.getBoundingClientRect();
      draw(ctx, rect.width, rect.height, dt);

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    // ------ Mouse events ------

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = {
        dragging: true,
        lastX: e.clientX,
        lastY: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        didDrag: false,
      };
    };

    const clampOffset = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const margin = 80; // minimum pixels of content visible
      const maxX = w - margin;
      const maxY = h - margin;
      transformRef.current.offsetX = Math.max(-maxX, Math.min(maxX, transformRef.current.offsetX));
      transformRef.current.offsetY = Math.max(-maxY, Math.min(maxY, transformRef.current.offsetY));
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      transformRef.current.offsetX += dx;
      transformRef.current.offsetY += dy;
      clampOffset();
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;

      // Track total movement from start
      const totalDx = Math.abs(e.clientX - dragRef.current.startX);
      const totalDy = Math.abs(e.clientY - dragRef.current.startY);
      if (totalDx + totalDy > 4) {
        dragRef.current.didDrag = true;
      }
    };

    const handleMouseUp = () => {
      dragRef.current.dragging = false;
    };

    const handleClick = (e: MouseEvent) => {
      // Suppress click if user was dragging
      if (dragRef.current.didDrag) {
        dragRef.current.didDrag = false;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = hitTest(x, y);
      if (hit) {
        onSelectRef.current(hit.id, { x: hit.sx + rect.left, y: hit.sy + rect.top });
      } else {
        onSelectRef.current(null, { x: 0, y: 0 });
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const oldScale = transformRef.current.scale;
      const zoomFactor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const newScale = Math.max(0.35, Math.min(5, oldScale * zoomFactor));

      // Zoom toward mouse position
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const wx = mouseX - cx - transformRef.current.offsetX;
      const wy = mouseY - cy - transformRef.current.offsetY;

      transformRef.current.offsetX -= wx * (newScale / oldScale - 1);
      transformRef.current.offsetY -= wy * (newScale / oldScale - 1);
      transformRef.current.scale = newScale;
      clampOffset();
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      resizeObserver.disconnect();
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [physicsTick, draw, hitTest]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const showEmpty = nodes.length === 0 && !isLoading;

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab' }}
      />

      {/* Empty state overlay */}
      {showEmpty && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex flex-col items-center gap-5 text-center select-none">

            {/* Glass orb */}
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full" style={{
                background: 'conic-gradient(rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.03) 75%, rgba(255,255,255,0.12) 100%)',
                padding: '1px',
              }}>
                <div className="w-full h-full rounded-full backdrop-blur-xl bg-white/[0.04] flex items-center justify-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round">
                    <circle cx="5" cy="5" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/>
                    <circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>
                    <circle cx="5" cy="19" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/>
                  </svg>
                </div>
              </div>
            </div>

            {/* Text */}
            <div className="space-y-2">
              <p className="text-[17px] font-semibold text-white/80">
                {isSessionSelected ? 'No File Activity' : 'No Session Activity'}
              </p>
              <p className="text-[13px] text-white/35 leading-relaxed max-w-[240px]">
                {isSessionSelected
                  ? 'Files touched by the agent will appear as nodes here.'
                  : 'Select a session to start observing file activity.'}
              </p>
            </div>

            {/* Resume button */}
            {!isSessionSelected && hasSessions && onResumeSession && (
              <button
                onClick={onResumeSession}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-medium text-white/70 hover:text-white transition-all cursor-pointer"
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Observe Last Session
              </button>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
