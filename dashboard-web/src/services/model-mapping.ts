import type {
  AuditTrailEntry, APIIssueThread, APITimelineEvent,
  FileEntry, SpecEntry, AuditEntryVM, IssueThreadVM, TimelineEventVM,
  GraphNodeVM, SpecVM, AuditFinding, AuditAction, AuditSource, IssueEventType,
} from '../models/types';
import { extensionColor, fileName, fileExt, fileDir } from '../models/types';

// GraphNode from FileEntry
export function mapFileToGraphNode(entry: FileEntry): GraphNodeVM {
  return {
    id: entry.path,
    path: entry.path,
    name: fileName(entry.path),
    ext: fileExt(entry.path),
    directory: fileDir(entry.path),
    color: extensionColor(entry.path),
    operation: entry.operation,
    changeSize: entry.change_size,
    auditStatus: entry.audit_status,
    imports: entry.imports ?? [],
    timestamp: entry.timestamp,
    driftEventId: entry.drift_event_id ?? undefined,
  };
}

// AuditEntry from AuditTrailEntry
export function mapAuditEntry(entry: AuditTrailEntry): AuditEntryVM {
  const displayFinding = entry.finding || (entry.action === 'blocked' ? 'violation' : entry.action === 'allowed' ? 'aligned' : 'unknown');
  const displayAction = entry.action === 'blocked' ? 'denied' : entry.action === 'allowed' ? 'observed' : entry.action;
  const displaySource = entry.source ?? entry.rule_source ?? 'unknown';

  return {
    id: `audit-${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp,
    finding: mapFinding(displayFinding, displayAction),
    action: mapAction(displayAction),
    source: mapSource(displaySource),
    ruleType: entry.rule_type,
    filePath: entry.file_path,
    toolName: entry.tool_name,
    reason: entry.reason,
    ruleQuote: entry.rule_quote ?? undefined,
    linesChanged: entry.details?.resulting_lines ?? undefined,
    lineLimit: entry.details?.limit ?? undefined,
  };
}

function mapFinding(finding: string, action: string): AuditFinding {
  switch (finding.toLowerCase()) {
    case 'violation': case 'enforcement': return 'violation';
    case 'drift': return 'drift';
    case 'aligned': return 'aligned';
    case 'concern': return 'concern';
    case 'guidance': return 'guidance';
    default:
      if (action === 'denied' || action === 'blocked') return 'violation';
      if (action === 'warned') return 'concern';
      return 'aligned';
  }
}

function mapAction(action: string): AuditAction {
  switch (action.toLowerCase()) {
    case 'denied': case 'blocked': return 'denied';
    case 'warned': return 'warned';
    default: return 'observed';
  }
}

function mapSource(source: string): AuditSource {
  switch (source.toLowerCase()) {
    case 'deterministic': case 'yaml': return 'deterministic';
    case 'semantic': case 'llm': return 'semantic';
    default: return 'deterministic';
  }
}

// IssueThread from API
export function mapIssueThread(api: APIIssueThread): IssueThreadVM {
  const finding: AuditFinding = (() => {
    switch (api.finding.toLowerCase()) {
      case 'violation': return 'violation';
      case 'drift': return 'drift';
      case 'concern': return 'concern';
      default: return 'violation';
    }
  })();

  const resolveTime: string | undefined = (() => {
    if (api.time_to_resolve_seconds == null) return undefined;
    const s = api.time_to_resolve_seconds;
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  })();

  return {
    id: api.issue_id,
    filePath: api.file_path,
    finding,
    isResolved: api.status === 'resolved',
    attempts: api.correction_attempts,
    resolveTime,
    events: api.timeline.map(mapTimelineEvent),
  };
}

function mapTimelineEvent(api: APITimelineEvent): TimelineEventVM {
  const eventType: IssueEventType = (() => {
    switch (api.event_type.toLowerCase()) {
      case 'issue_detected': return 'detected';
      case 'change_requested': return 'requested';
      case 'agent_responded': case 're_evaluated': return 'responded';
      case 'issue_resolved': return 'resolved';
      case 'escalated': return 'escalated';
      default: return 'detected';
    }
  })();

  const displayLabel = (() => {
    switch (api.event_type) {
      case 'issue_detected': return 'Issue Detected';
      case 'change_requested': return 'Change Requested';
      case 'agent_responded': return 'Agent Responded';
      case 're_evaluated': return 'Re-evaluated';
      case 'issue_resolved': return 'Resolved';
      case 'escalated': return 'Escalated';
      default: return api.event_type.replace(/_/g, ' ');
    }
  })();

  const displayTime = (() => {
    try {
      return new Date(api.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } catch { return api.timestamp; }
  })();

  return {
    id: `${api.timestamp}-${api.event_type}`,
    type: eventType,
    label: displayLabel,
    detail: api.action ?? '',
    relativeTime: displayTime,
  };
}

// Spec from SpecEntry
export function mapSpec(entry: SpecEntry): SpecVM {
  return {
    id: entry.path,
    path: entry.path,
    name: fileName(entry.path),
    ext: fileExt(entry.path),
    content: entry.content,
    hitLines: new Set(),
  };
}
