import type { Queryable } from './pool.js';
import type { TaskEvent, TaskEventType } from '../domain/types.js';
import { PRUNABLE_EVENT_TYPES } from '../domain/types.js';

interface EventRow {
  id: string;
  task_id: string;
  seq: number;
  type: TaskEventType;
  message: string;
  detail: unknown | null;
  created_at: Date;
}

function mapRow(r: EventRow): TaskEvent {
  return {
    id: String(r.id),
    taskId: r.task_id,
    seq: r.seq,
    type: r.type,
    message: r.message,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

/** Truncate a string to a byte budget without splitting surrogate pairs badly. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '')}… [truncated]`;
}

function boundDetail(detail: unknown, maxBytes: number): unknown {
  if (detail === undefined || detail === null) return null;
  const json = JSON.stringify(detail);
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return detail;
  return { truncated: true, preview: truncateUtf8(json, Math.max(0, maxBytes - 64)) };
}

export interface RecordEventOptions {
  maxEventsPerTask: number;
  maxDetailBytes: number;
}

/**
 * Append a durable event to a task's ordered event log. Progress-class events
 * are capped per task (oldest prunable events are dropped first); lifecycle
 * events are always retained.
 */
export async function recordTaskEvent(
  q: Queryable,
  taskId: string,
  type: TaskEventType,
  message: string,
  detail: unknown,
  opts: RecordEventOptions,
): Promise<void> {
  const boundedMessage = truncateUtf8(message, 2000);
  const boundedDetail = boundDetail(detail, opts.maxDetailBytes);

  const { rows: countRows } = await q.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM claude_task_events WHERE task_id = $1`,
    [taskId],
  );
  const count = Number(countRows[0]?.count ?? 0);
  if (count >= opts.maxEventsPerTask) {
    // At capacity: make room by dropping the oldest prunable event. If nothing
    // is prunable, only lifecycle events may still be appended.
    const { rowCount } = await q.query(
      `DELETE FROM claude_task_events WHERE id = (
         SELECT id FROM claude_task_events
         WHERE task_id = $1 AND type = ANY($2)
         ORDER BY seq LIMIT 1
       )`,
      [taskId, [...PRUNABLE_EVENT_TYPES]],
    );
    const isPrunable = (PRUNABLE_EVENT_TYPES as readonly string[]).includes(type);
    if ((rowCount ?? 0) === 0 && isPrunable) return;
  }

  await q.query(
    `WITH bumped AS (
       UPDATE claude_tasks SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq
     )
     INSERT INTO claude_task_events (task_id, seq, type, message, detail)
     SELECT $1, bumped.event_seq, $2, $3, $4 FROM bumped`,
    [taskId, type, boundedMessage, boundedDetail === null ? null : JSON.stringify(boundedDetail)],
  );
}

export async function listTaskEvents(
  q: Queryable,
  taskId: string,
  opts: { limit: number; beforeSeq?: number },
): Promise<TaskEvent[]> {
  const params: unknown[] = [taskId, opts.limit];
  let where = 'task_id = $1';
  if (opts.beforeSeq !== undefined) {
    params.push(opts.beforeSeq);
    where += ` AND seq < $${params.length}`;
  }
  const { rows } = await q.query<EventRow>(
    `SELECT id, task_id, seq, type, message, detail, created_at
     FROM claude_task_events
     WHERE ${where}
     ORDER BY seq DESC
     LIMIT $2`,
    params,
  );
  return rows.map(mapRow).reverse();
}

export async function latestTaskEvent(q: Queryable, taskId: string): Promise<TaskEvent | null> {
  const { rows } = await q.query<EventRow>(
    `SELECT id, task_id, seq, type, message, detail, created_at
     FROM claude_task_events WHERE task_id = $1
     ORDER BY seq DESC LIMIT 1`,
    [taskId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
