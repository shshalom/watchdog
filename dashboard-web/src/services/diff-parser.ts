import type { DiffHunk, DiffLine } from '../models/types';

let hunkCounter = 0;
let lineCounter = 0;

export function parseDiff(diffText: string): DiffHunk[] {
  const lines = diffText.split('\n');
  const hunks: DiffHunk[] = [];
  let currentLines: DiffLine[] = [];
  let oldStart = 0, oldCount = 0, newStart = 0, newCount = 0;
  let oldLine = 0, newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (inHunk && currentLines.length > 0) {
        hunks.push({
          id: `hunk-${hunkCounter++}`,
          oldStart, oldCount, newStart, newCount,
          header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
          lines: currentLines,
        });
      }
      const parsed = parseHunkHeader(line);
      if (parsed) {
        ({ oldStart, oldCount, newStart, newCount } = parsed);
        oldLine = oldStart;
        newLine = newStart;
        currentLines = [];
        inHunk = true;
      }
      continue;
    }

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      currentLines.push({ id: `dl-${lineCounter++}`, type: 'addition', content: line.slice(1), newLineNum: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      currentLines.push({ id: `dl-${lineCounter++}`, type: 'removal', content: line.slice(1), oldLineNum: oldLine });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      const content = line === '' ? '' : line.slice(1);
      currentLines.push({ id: `dl-${lineCounter++}`, type: 'context', content, oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  if (inHunk && currentLines.length > 0) {
    hunks.push({
      id: `hunk-${hunkCounter++}`,
      oldStart, oldCount, newStart, newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: currentLines,
    });
  }

  return hunks;
}

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] ? parseInt(match[4], 10) : 1,
  };
}
