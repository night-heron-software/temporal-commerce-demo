/**
 * Pure decoding of Temporal execution-history events into a compact, display-friendly
 * shape. No I/O and no server imports, so it is safe to unit-test in isolation and to
 * reuse from the trace-assembly module.
 */

/** A single decoded Temporal execution-history event. */
export interface TraceEvent {
  eventId: string;
  /** Human-readable event type derived from the attributes key, e.g. `ActivityTaskScheduled`. */
  eventType: string;
  timestamp?: string;
  /** Short summary of the interesting payload (activity name, signal name, child id, failure…). */
  detail?: string;
  /** Decoded input payload for signal / update-accepted events (the driver of a transition). */
  payload?: unknown;
}

/**
 * Extracts and decodes the input payload for a raw history event, when it is a signal or
 * accepted update (the events that drive a state transition). Injected from the server so this
 * module stays free of the Temporal payload converter (and client bundles stay clean).
 */
export type PayloadDecoder = (attrsKey: string, attrs: Record<string, unknown>) => unknown;

/** Convert a protobuf ITimestamp / Date / string / epoch-ms into an ISO string. */
export function toIso(ts: unknown): string | undefined {
  if (ts == null) return undefined;
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (typeof ts === 'object') {
    const t = ts as { seconds?: unknown; nanos?: unknown };
    if (t.seconds != null) {
      const ms = Number(t.seconds) * 1000 + Math.floor(Number(t.nanos ?? 0) / 1e6);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return undefined;
}

/** `activityTaskScheduledEventAttributes` → `ActivityTaskScheduled`. */
export function deriveEventType(attrsKey: string): string {
  const base = attrsKey.replace(/EventAttributes$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function extractDetail(attrsKey: string, attrs: Record<string, unknown>): string | undefined {
  const get = (path: string): unknown =>
    path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], attrs);
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  switch (attrsKey) {
    case 'activityTaskScheduledEventAttributes': {
      const name = str(get('activityType.name'));
      return name ? `activity: ${name}` : undefined;
    }
    case 'activityTaskFailedEventAttributes':
    case 'workflowExecutionFailedEventAttributes':
    case 'childWorkflowExecutionFailedEventAttributes':
      return `failed: ${str(get('failure.message')) ?? 'unknown'}`;
    case 'activityTaskTimedOutEventAttributes':
      return `timeout: ${str(get('failure.message')) ?? str(get('timeoutType')) ?? 'unknown'}`;
    case 'workflowExecutionSignaledEventAttributes':
      return `signal: ${str(get('signalName')) ?? 'unknown'}`;
    case 'workflowExecutionUpdateAcceptedEventAttributes':
      return `update: ${str(get('acceptedRequest.input.name')) ?? str(get('protocolInstanceId')) ?? ''}`;
    case 'startChildWorkflowExecutionInitiatedEventAttributes':
      return `child: ${str(get('workflowId')) ?? ''}`;
    case 'childWorkflowExecutionStartedEventAttributes':
    case 'childWorkflowExecutionCompletedEventAttributes':
      return `child: ${str(get('workflowExecution.workflowId')) ?? ''}`;
    case 'workflowExecutionTerminatedEventAttributes':
      return `terminated: ${str(get('reason')) ?? ''}`;
    case 'workflowExecutionCanceledEventAttributes':
      return 'canceled';
    default:
      return undefined;
  }
}

/**
 * Decode raw Temporal history events into a compact, display-friendly list.
 * Robust to the numeric-enum `eventType` encoding used by `handle.fetchHistory()`:
 * the human-readable type is derived from the `*EventAttributes` key instead.
 */
export function decodeHistoryEvents(
  rawEvents: unknown[],
  decodePayload?: PayloadDecoder,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const raw of rawEvents ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as Record<string, unknown>;
    const attrsKey = Object.keys(ev).find((k) => k.endsWith('EventAttributes'));
    const attrs = (attrsKey ? ev[attrsKey] : undefined) as Record<string, unknown> | undefined;
    const wantsPayload =
      attrsKey === 'workflowExecutionSignaledEventAttributes' ||
      attrsKey === 'workflowExecutionUpdateAcceptedEventAttributes';
    events.push({
      eventId: ev.eventId != null ? String(ev.eventId) : '',
      eventType: attrsKey ? deriveEventType(attrsKey) : String(ev.eventType ?? 'Unknown'),
      timestamp: toIso(ev.eventTime),
      detail: attrsKey && attrs ? extractDetail(attrsKey, attrs) : undefined,
      payload:
        wantsPayload && attrsKey && attrs && decodePayload
          ? decodePayload(attrsKey, attrs)
          : undefined,
    });
  }
  return events;
}

// ============================================================================
// State-transition timeline
// ============================================================================

export type TransitionKind = 'start' | 'state' | 'update' | 'signal' | 'child' | 'terminal';

/** One step in a workflow's transition timeline. */
export interface TransitionStep {
  at?: string;
  kind: TransitionKind;
  /** Display label: a domain state name, an update/signal name, or a lifecycle marker. */
  label: string;
  note?: string;
  /** For `state` steps: the prior state name (undefined for the first). */
  from?: string;
  /** For `state` steps: the new state name (same as `label`). */
  to?: string;
  /** For `state` steps: label of the signal/update/child event that triggered the transition. */
  cause?: string;
  /** Decoded input payload — the update/signal args, or (for `state`) the triggering event's args. */
  payload?: unknown;
  /** Human summary of what changed, e.g. `pending_assignment → shipped`. */
  delta?: string;
}

/** A domain state-transition record (e.g. OMS `statusHistory`), if the workflow keeps one. */
export interface StateTransitionRecord {
  status: string;
  timestamp?: string;
  note?: string | null;
}

const stripPrefix = (detail: string | undefined, prefix: string): string =>
  (detail ?? '').replace(prefix, '').trim();

/**
 * Build a per-workflow transition timeline. The Temporal state-machine framework advances on
 * each signal/update, so those events (plus start/terminal/child markers) form the driver
 * timeline available for *every* machine. When a workflow additionally exposes real domain
 * state names (OMS `statusHistory`), those are merged in as `state` steps. The result is
 * sorted by time so triggers and resulting states interleave chronologically.
 */
export function deriveTransitions(
  events: TraceEvent[],
  stateTransitions?: StateTransitionRecord[],
): TransitionStep[] {
  const steps: TransitionStep[] = [];

  for (const ev of events ?? []) {
    switch (ev.eventType) {
      case 'WorkflowExecutionStarted':
        steps.push({ at: ev.timestamp, kind: 'start', label: 'Started' });
        break;
      case 'WorkflowExecutionUpdateAccepted':
        steps.push({ at: ev.timestamp, kind: 'update', label: stripPrefix(ev.detail, 'update:') || 'update', payload: ev.payload });
        break;
      case 'WorkflowExecutionSignaled':
        steps.push({ at: ev.timestamp, kind: 'signal', label: stripPrefix(ev.detail, 'signal:') || 'signal', payload: ev.payload });
        break;
      case 'StartChildWorkflowExecutionInitiated':
        steps.push({ at: ev.timestamp, kind: 'child', label: stripPrefix(ev.detail, 'child:') || 'child workflow' });
        break;
      case 'WorkflowExecutionCompleted':
        steps.push({ at: ev.timestamp, kind: 'terminal', label: 'Completed' });
        break;
      case 'WorkflowExecutionFailed':
        steps.push({ at: ev.timestamp, kind: 'terminal', label: ev.detail || 'Failed' });
        break;
      case 'WorkflowExecutionTerminated':
        steps.push({ at: ev.timestamp, kind: 'terminal', label: ev.detail || 'Terminated' });
        break;
      case 'WorkflowExecutionCanceled':
        steps.push({ at: ev.timestamp, kind: 'terminal', label: 'Canceled' });
        break;
      default:
        break;
    }
  }

  for (const st of stateTransitions ?? []) {
    if (!st?.status) continue;
    steps.push({ at: st.timestamp, kind: 'state', label: st.status, note: st.note ?? undefined });
  }

  // Stable sort by time; entries without a parseable timestamp keep their insertion order.
  const sorted = steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => {
      const ta = a.step.at ? Date.parse(a.step.at) : NaN;
      const tb = b.step.at ? Date.parse(b.step.at) : NaN;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return a.index - b.index;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb || a.index - b.index;
    })
    .map((x) => x.step);

  // Attribute each state transition to the driver (signal/update/child/start) that preceded it,
  // and describe the delta as `from → to`.
  let lastState: string | undefined;
  let lastDriver: TransitionStep | undefined;
  for (const step of sorted) {
    if (step.kind === 'state') {
      step.from = lastState;
      step.to = step.label;
      step.cause = lastDriver?.label;
      if (step.payload === undefined) step.payload = lastDriver?.payload;
      step.delta = lastState ? `${lastState} → ${step.label}` : `∅ → ${step.label}`;
      lastState = step.label;
    } else if (step.kind !== 'terminal') {
      lastDriver = step;
    }
  }

  return sorted;
}

// ============================================================================
// Snapshot diffing (persisted transitions, ADR-0010)
// ============================================================================

export interface SnapshotChange {
  /** Dotted/indexed path to the changed value, e.g. `order.status` or `items[1].quantity`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compute the field-level difference between two full context snapshots (the real before→after
 * delta enabled by ADR-0010's persisted snapshots). Recurses through objects and arrays; a
 * type mismatch or primitive change is reported as a single `changed` leaf. Bounded by
 * `maxChanges` so a huge divergence can't blow up the UI.
 */
export function diffSnapshots(prev: unknown, next: unknown, maxChanges = 200): SnapshotChange[] {
  const changes: SnapshotChange[] = [];

  const walk = (path: string, a: unknown, b: unknown): void => {
    if (changes.length >= maxChanges || a === b) return;

    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (changes.length >= maxChanges) return;
        const p = path ? `${path}.${key}` : key;
        if (!(key in a)) changes.push({ path: p, kind: 'added', after: b[key] });
        else if (!(key in b)) changes.push({ path: p, kind: 'removed', before: a[key] });
        else walk(p, a[key], b[key]);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (changes.length >= maxChanges) return;
        const p = `${path}[${i}]`;
        if (i >= a.length) changes.push({ path: p, kind: 'added', after: b[i] });
        else if (i >= b.length) changes.push({ path: p, kind: 'removed', before: a[i] });
        else walk(p, a[i], b[i]);
      }
      return;
    }

    changes.push({ path: path || '(root)', kind: 'changed', before: a, after: b });
  };

  walk('', prev, next);
  return changes;
}
