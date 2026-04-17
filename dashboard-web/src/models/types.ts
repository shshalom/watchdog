// ============================================================
// All TypeScript types ported from Swift models
// ============================================================

// MARK: - Session Status
export type SessionStatus =
  | 'waiting' | 'observing' | 'drift_detected'
  | 'correcting' | 'halted' | 'completed' | 'stopped';

export const SESSION_STATUS_META: Record<SessionStatus, { display: string; color: string; active: boolean }> = {
  waiting:        { display: 'Waiting',        color: 'gray',   active: true },
  observing:      { display: 'Observing',      color: 'green',  active: true },
  drift_detected: { display: 'Drift Detected', color: 'amber',  active: true },
  correcting:     { display: 'Correcting',     color: 'blue',   active: true },
  halted:         { display: 'Halted',         color: 'red',    active: false },
  completed:      { display: 'Completed',      color: 'green',  active: false },
  stopped:        { display: 'Stopped',        color: 'gray',   active: false },
};

// MARK: - Agent State
export type AgentState = 'working' | 'modifying' | 'idle' | 'stuck';

export const AGENT_STATE_META: Record<AgentState, { color: string; label: string }> = {
  working:   { color: '#3b82f6', label: 'Working' },
  modifying: { color: '#f59e0b', label: 'Modifying' },
  idle:      { color: '#22c55e', label: 'Idle' },
  stuck:     { color: '#ef4444', label: 'Stuck' },
};

// MARK: - Audit Status
export type AuditStatus = 'pending' | 'aligned' | 'drift' | 'reverted' | 'skipped';

// MARK: - File Operation
export type FileOperation = 'create' | 'modify' | 'delete' | 'rename' | 'read' | 'bash' | 'unknown';

// MARK: - Session Summary (GET /api/sessions)
export interface SessionSummary {
  id: string;
  name: string | null;
  spec_path: string | null;
  status: SessionStatus;
  started_at: string;
  elapsed_seconds: number;
  files_touched: number;
  audit_cycles: number;
  active_drift_events: number;
  escalation_count: number;
  escalation_threshold: number;
}

// MARK: - Session Detail (GET /api/sessions/:id)
export interface SessionDetail {
  id: string;
  name: string;
  spec_path: string | null;
  status: SessionStatus;
  started_at: string;
  elapsed_seconds: number;
  batch_interval_seconds: number | null;
  next_batch_in_seconds: number | null;
  escalation_count: number | null;
  escalation_threshold: number | null;
  agent_session_id: string | null;
  files_touched: number;
  files_created: number | null;
  files_modified: number | null;
  files_deleted: number | null;
  files_reverted: number | null;
  audit_cycles_total: number | null;
  audit_cycles_aligned: number | null;
  audit_cycles_drifted: number | null;
  drift_events_total: number | null;
  drift_events_resolved: number | null;
  drift_events_unresolved: number | null;
  context_percent: number | null;
}

// MARK: - File Entry
export interface FileEntry {
  path: string;
  operation: FileOperation;
  timestamp: string;
  audit_status: AuditStatus;
  change_size: number;
  directory: string;
  drift_event_id: string | null;
  imports: string[] | null;
}

// MARK: - File Tree Node
export interface APIFileTreeNode {
  name: string;
  type: 'file' | 'directory';
  children: APIFileTreeNode[] | null;
  path: string | null;
  audit_status: AuditStatus | null;
  change_size: number | null;
}

// MARK: - Files Response
export interface FilesResponse {
  files: FileEntry[];
  tree: APIFileTreeNode[] | null;
}

// MARK: - File Diff
export interface FileDiff {
  path: string;
  operation: FileOperation;
  diff: string;
  language: string;
  lines_added: number;
  lines_removed: number;
}

// MARK: - Audit Trail
export interface AuditTrailEntry {
  timestamp: string;
  finding: string | null;
  action: string;
  source: string | null;
  rule_type: string;
  file_path: string;
  tool_name: string;
  reason: string;
  details: AuditTrailDetails | null;
  rule_quote: string | null;
  enforcement: boolean | null;
  rule_source: string | null;
}

export interface AuditTrailDetails {
  extension?: string;
  resulting_lines?: number;
  limit?: number;
  pattern?: string;
  severity?: string;
  correction?: string;
}

// MARK: - Audit Log
export interface AuditFileResult {
  path: string;
  verdict: string;
  issue: AuditIssue | null;
}

export interface AuditIssue {
  type: string;
  reason: string;
  evidence: string[];
  severity: string;
  correction: string;
}

export interface AuditBatch {
  batch_id: number;
  timestamp: string;
  files_evaluated: number;
  verdict: string;
  results: AuditFileResult[];
}

// MARK: - Issue Thread
export interface APIIssueThread {
  issue_id: string;
  file_path: string;
  finding: string;
  status: string;
  detected_at: string | null;
  resolved_at: string | null;
  correction_attempts: number;
  time_to_resolve_seconds: number | null;
  timeline: APITimelineEvent[];
}

export interface APITimelineEvent {
  timestamp: string;
  event_type: string;
  action: string | null;
  details: Record<string, unknown> | null;
}

// MARK: - Drift
export type DriftState = 'detected' | 'agent_notified' | 'correction_pending' | 'resolved' | 'unresolved';

export interface DriftEvent {
  id: string;
  detected_at: string;
  resolved_at: string | null;
  state: DriftState;
  file_path: string;
  issue_type: string;
  severity: string;
  reason: string;
  evidence: string[];
  correction: string;
  correction_attempts: number;
  feedback_delivered: boolean;
}

// MARK: - Spec
export interface SpecEntry {
  path: string;
  content: string;
}

export interface SpecContent {
  path: string;
  locked_at: string | null;
  content: string;
  specs: SpecEntry[] | null;
}

// MARK: - Config
export interface WatchdogConfig {
  api_port: number;
  batch_interval_seconds: number;
  escalation_threshold: number;
  auditor_model: string | null;
  auditor_enabled: boolean | null;
  enforcement_enabled: boolean | null;
  audit_mode: string | null;
  has_api_key: boolean | null;
  context_warn_percent: number | null;
  context_block_percent: number | null;
}

// MARK: - WebSocket Events
export type WebSocketEventType =
  | 'file_activity' | 'file_intent' | 'audit_complete'
  | 'drift_detected' | 'drift_resolved' | 'session_status_changed'
  | 'batch_started' | 'rule_violation' | 'watch_triggered' | 'specs_reloaded'
  | 'handoff_creating' | 'handoff_updated' | 'handoff_used';

export interface SpecLineRef {
  spec_path: string;
  line: number;
}

export interface FileActivityEvent {
  type: 'file_activity';
  timestamp: string;
  path: string;
  operation: FileOperation;
  directory: string;
  change_size: number;
}

export interface FileIntentEvent {
  type: 'file_intent';
  timestamp: string;
  path: string;
  operation: FileOperation;
  directory: string;
  tool_name: string;
}

export interface AuditCompleteEvent {
  type: 'audit_complete';
  batch_id: number;
  timestamp: string;
  verdict: string;
  files_evaluated: number;
  results: AuditFileResult[] | null;
  spec_lines: SpecLineRef[] | null;
}

export interface DriftDetectedEvent {
  type: 'drift_detected';
  drift_event_id: string;
  file_path: string;
  severity: string;
  reason: string;
  spec_lines: SpecLineRef[] | null;
}

export interface DriftResolvedEvent {
  type: 'drift_resolved';
  drift_event_id: string;
  resolved_at: string;
}

export interface SessionStatusChangedEvent {
  type: 'session_status_changed';
  status: SessionStatus;
  reason: string | null;
}

export interface BatchStartedEvent {
  type: 'batch_started';
  batch_id: number;
  timestamp: string;
  files_queued: number | null;
}

export interface RuleViolationEvent {
  type: 'rule_violation';
  timestamp: string;
  file_path: string;
  reason: string;
  tool_name: string;
  action: string;
}

export interface WatchTriggeredEvent {
  type: 'watch_triggered';
  path: string;
  operation: 'read' | 'write';
  tool_name: string;
  timestamp: string;
}

export interface SpecsReloadedEvent {
  type: 'specs_reloaded';
  spec_paths: string[];
}

export interface TerminalExitedEvent {
  type: 'terminal_exited';
  terminal_id: string;
}

export interface HandoffCreatingEvent {
  type: 'handoff_creating';
}

export interface HandoffUpdatedEvent {
  type: 'handoff_updated';
  path: string;
  session_id: string;
  is_outdated: boolean;
}

export interface HandoffUsedEvent {
  type: 'handoff_used';
  path: string;
  used_by_session_id: string;
}

export type WebSocketEvent =
  | FileActivityEvent | FileIntentEvent | AuditCompleteEvent
  | DriftDetectedEvent | DriftResolvedEvent | SessionStatusChangedEvent
  | BatchStartedEvent | RuleViolationEvent | WatchTriggeredEvent
  | SpecsReloadedEvent | TerminalExitedEvent
  | HandoffCreatingEvent | HandoffUpdatedEvent | HandoffUsedEvent;

// MARK: - View Model Types (ported from Swift @Observable classes)

export type AuditFinding = 'violation' | 'drift' | 'aligned' | 'guidance' | 'concern';
export type AuditAction = 'denied' | 'warned' | 'observed';
export type AuditSource = 'deterministic' | 'semantic';

export const FINDING_META: Record<AuditFinding, { color: string; icon: string; label: string }> = {
  violation: { color: '#ef4444', icon: 'ban',                    label: 'VIOLATION' },
  drift:     { color: '#ef4444', icon: 'git-branch',             label: 'DRIFT' },
  concern:   { color: '#eab308', icon: 'alert-triangle',         label: 'CONCERN' },
  guidance:  { color: '#3b82f6', icon: 'lightbulb',              label: 'GUIDANCE' },
  aligned:   { color: '#22c55e', icon: 'check-circle',           label: 'ALIGNED' },
};

export const SOURCE_META: Record<AuditSource, { label: string; icon: string; color: string }> = {
  deterministic: { label: 'YAML', icon: 'zap',   color: '#f59e0b' },
  semantic:      { label: 'LLM',  icon: 'brain', color: '#a855f7' },
};

export type IssueEventType = 'detected' | 'requested' | 'responded' | 'resolved' | 'escalated';

export const ISSUE_EVENT_META: Record<IssueEventType, { label: string; color: string }> = {
  detected:  { label: 'Detected',         color: '#ef4444' },
  requested: { label: 'Change Requested', color: '#f59e0b' },
  responded: { label: 'Agent Responded',  color: '#3b82f6' },
  resolved:  { label: 'Resolved',         color: '#22c55e' },
  escalated: { label: 'Escalated',        color: '#ef4444' },
};

// MARK: - Graph Node (view model)
export interface GraphNodeVM {
  id: string;
  path: string;
  name: string;
  ext: string;
  directory: string;
  color: string;
  operation: FileOperation;
  changeSize: number;
  auditStatus: AuditStatus;
  imports: string[];
  timestamp: string;
  driftEventId?: string;
}

// MARK: - Audit Entry (view model)
export interface AuditEntryVM {
  id: string;
  timestamp: string;
  finding: AuditFinding;
  action: AuditAction;
  source: AuditSource;
  ruleType: string;
  filePath: string;
  toolName: string;
  reason: string;
  ruleQuote?: string;
  linesChanged?: number;
  lineLimit?: number;
}

// MARK: - Issue Thread (view model)
export interface IssueThreadVM {
  id: string;
  filePath: string;
  finding: AuditFinding;
  isResolved: boolean;
  attempts: number;
  resolveTime?: string;
  events: TimelineEventVM[];
}

export interface TimelineEventVM {
  id: string;
  type: IssueEventType;
  label: string;
  detail: string;
  relativeTime: string;
}

// MARK: - Spec (view model)
export interface SpecVM {
  id: string;
  path: string;
  name: string;
  ext: string;
  content: string;
  hitLines: Set<number>;
}

// MARK: - Diff types (view model)
export type DiffLineType = 'addition' | 'removal' | 'context';

export interface DiffLine {
  id: string;
  type: DiffLineType;
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export interface FileChangeVM {
  id: string;
  path: string;
  name: string;
  ext: string;
  directory: string;
  operation: FileOperation;
  hunks: DiffHunk[];
  additions: number;
  removals: number;
}

// MARK: - Filesystem types (from Rust /api/fs endpoints)
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_locked: boolean;
  is_watched: boolean;
}

export interface LockWatchState {
  locks: string[];
  watches: string[];
}

// MARK: - Discovery types (from Rust /api/project endpoints)
export interface ProjectInfo {
  name: string;
  path: string;
  sessions_dir: string;
}

export interface DiscoveredSession {
  id: string;
  label: string | null;
  label_source: string | null;
  transcript_path: string;
  last_modified: string;
  is_active: boolean;
  usage: DiscoveredSessionUsage | null;
}

export interface DiscoveredSessionUsage {
  cost: number;
  model: string | null;
  context_pct: number;
  context_window: number;
  lines_added: number;
  lines_removed: number;
  duration_ms: number;
}

// MARK: - Helpers
export function fileName(path: string): string {
  return path.split('/').pop() || path;
}

export function fileExt(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '';
}

export function fileDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

export function extensionColor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'rs': return '#f97316';
    case 'swift': return '#3b82f6';
    case 'ts': case 'tsx': case 'js': case 'jsx': return '#eab308';
    case 'py': return '#22c55e';
    case 'md': case 'txt': return '#a855f7';
    case 'yml': case 'yaml': case 'toml': case 'json': return '#06b6d4';
    case 'html': case 'css': return '#ec4899';
    default: return '#6b7280';
  }
}

export function operationColor(op: FileOperation): string {
  switch (op) {
    case 'create': return '#22c55e';
    case 'modify': return '#3b82f6';
    case 'delete': return '#ef4444';
    case 'rename': return '#a855f7';
    default: return '#6b7280';
  }
}

export function relativeTime(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
