import { describe, it, expect } from 'vitest';
import {
  decodeHistoryEvents,
  deriveEventType,
  deriveTransitions,
  diffSnapshots,
  toIso,
  type TraceEvent,
} from './history-decode';

describe('toIso', () => {
  it('passes through ISO strings and Dates', () => {
    expect(toIso('2026-06-21T00:00:00.000Z')).toBe('2026-06-21T00:00:00.000Z');
    expect(toIso(new Date('2026-06-21T00:00:00.000Z'))).toBe('2026-06-21T00:00:00.000Z');
  });

  it('converts protobuf ITimestamp {seconds, nanos}', () => {
    // 1782000000 seconds since epoch = 2026-06-21T00:00:00Z
    expect(toIso({ seconds: 1782000000, nanos: 0 })).toBe('2026-06-21T00:00:00.000Z');
  });

  it('handles seconds encoded as a string (Long)', () => {
    expect(toIso({ seconds: '1782000000', nanos: 500000000 })).toBe('2026-06-21T00:00:00.500Z');
  });

  it('returns undefined for missing/garbage input', () => {
    expect(toIso(null)).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
    expect(toIso({})).toBeUndefined();
  });
});

describe('deriveEventType', () => {
  it('turns an attributes key into a PascalCase type name', () => {
    expect(deriveEventType('activityTaskScheduledEventAttributes')).toBe('ActivityTaskScheduled');
    expect(deriveEventType('workflowExecutionStartedEventAttributes')).toBe(
      'WorkflowExecutionStarted',
    );
  });
});

describe('decodeHistoryEvents', () => {
  it('decodes eventId, type, timestamp and detail across event kinds', () => {
    const raw = [
      {
        eventId: 1,
        eventType: 1, // numeric enum from fetchHistory — must be ignored in favour of the attrs key
        eventTime: { seconds: 1782000000, nanos: 0 },
        workflowExecutionStartedEventAttributes: {},
      },
      {
        eventId: 5,
        eventTime: { seconds: 1782000001, nanos: 0 },
        activityTaskScheduledEventAttributes: { activityType: { name: 'saveOrderToDatabase' } },
      },
      {
        eventId: 9,
        eventTime: { seconds: 1782000002, nanos: 0 },
        workflowExecutionSignaledEventAttributes: { signalName: 'fulfillmentStatus' },
      },
      {
        eventId: 12,
        eventTime: { seconds: 1782000003, nanos: 0 },
        startChildWorkflowExecutionInitiatedEventAttributes: { workflowId: 'store-fulfillment-o1' },
      },
      {
        eventId: 15,
        eventTime: { seconds: 1782000004, nanos: 0 },
        activityTaskFailedEventAttributes: { failure: { message: 'boom' } },
      },
    ];

    const out = decodeHistoryEvents(raw);

    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ eventId: '1', eventType: 'WorkflowExecutionStarted' });
    expect(out[0].timestamp).toBe('2026-06-21T00:00:00.000Z');
    expect(out[1]).toMatchObject({
      eventType: 'ActivityTaskScheduled',
      detail: 'activity: saveOrderToDatabase',
    });
    expect(out[2].detail).toBe('signal: fulfillmentStatus');
    expect(out[3].detail).toBe('child: store-fulfillment-o1');
    expect(out[4].detail).toBe('failed: boom');
  });

  it('falls back to the numeric eventType when no attributes key is present', () => {
    const out = decodeHistoryEvents([{ eventId: 2, eventType: 42 }]);
    expect(out[0]).toMatchObject({ eventId: '2', eventType: '42', detail: undefined });
  });

  it('skips non-object entries and tolerates an empty list', () => {
    expect(decodeHistoryEvents([])).toEqual([]);
    expect(decodeHistoryEvents([null, undefined, 3, 'x'])).toEqual([]);
  });

  it('decodes payloads only for signal / accepted-update events via the injected decoder', () => {
    const raw = [
      {
        eventId: 1,
        activityTaskScheduledEventAttributes: {
          activityType: { name: 'x' },
          input: { payloads: [] },
        },
      },
      {
        eventId: 2,
        workflowExecutionSignaledEventAttributes: {
          signalName: 'fulfillmentStatus',
          input: { payloads: [1] },
        },
      },
      {
        eventId: 3,
        workflowExecutionUpdateAcceptedEventAttributes: {
          acceptedRequest: { input: { name: 'setShipping', args: { payloads: [1] } } },
        },
      },
    ];
    const decoder = (attrsKey: string) => ({ decodedFor: attrsKey });
    const out = decodeHistoryEvents(raw, decoder);
    expect(out[0].payload).toBeUndefined(); // activity — not a transition driver
    expect(out[1].payload).toEqual({ decodedFor: 'workflowExecutionSignaledEventAttributes' });
    expect(out[2].payload).toEqual({
      decodedFor: 'workflowExecutionUpdateAcceptedEventAttributes',
    });
  });
});

describe('diffSnapshots', () => {
  it('reports changed, added, and removed leaves', () => {
    expect(diffSnapshots({ status: 'processing' }, { status: 'shipped' })).toEqual([
      { path: 'status', kind: 'changed', before: 'processing', after: 'shipped' },
    ]);
    expect(diffSnapshots({}, { note: 'hi' })).toEqual([
      { path: 'note', kind: 'added', after: 'hi' },
    ]);
    expect(diffSnapshots({ note: 'hi' }, {})).toEqual([
      { path: 'note', kind: 'removed', before: 'hi' },
    ]);
  });

  it('recurses into nested objects and arrays with path notation', () => {
    expect(diffSnapshots({ order: { status: 'a' } }, { order: { status: 'b' } })).toEqual([
      { path: 'order.status', kind: 'changed', before: 'a', after: 'b' },
    ]);
    expect(diffSnapshots({ items: [{ q: 1 }] }, { items: [{ q: 2 }, { q: 9 }] })).toEqual([
      { path: 'items[0].q', kind: 'changed', before: 1, after: 2 },
      { path: 'items[1]', kind: 'added', after: { q: 9 } },
    ]);
  });

  it('returns nothing for structurally equal snapshots and honors maxChanges', () => {
    expect(diffSnapshots({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toEqual([]);
    const big = diffSnapshots({}, { a: 1, b: 2, c: 3 }, 2);
    expect(big).toHaveLength(2);
  });
});

describe('deriveTransitions', () => {
  const ev = (eventType: string, timestamp: string, detail?: string): TraceEvent => ({
    eventId: '0',
    eventType,
    timestamp,
    detail,
  });

  it('extracts driver + lifecycle steps from events with clean labels', () => {
    const events = [
      ev('WorkflowExecutionStarted', '2026-06-21T00:00:00.000Z'),
      ev('ActivityTaskScheduled', '2026-06-21T00:00:01.000Z', 'activity: queryCart'), // ignored
      ev('WorkflowExecutionUpdateAccepted', '2026-06-21T00:00:02.000Z', 'update: setShipping'),
      ev('WorkflowExecutionSignaled', '2026-06-21T00:00:03.000Z', 'signal: fulfillmentStatus'),
      ev(
        'StartChildWorkflowExecutionInitiated',
        '2026-06-21T00:00:04.000Z',
        'child: store-fulfillment-o1',
      ),
      ev('WorkflowExecutionCompleted', '2026-06-21T00:00:05.000Z'),
    ];
    const out = deriveTransitions(events);
    expect(out.map((s) => [s.kind, s.label])).toEqual([
      ['start', 'Started'],
      ['update', 'setShipping'],
      ['signal', 'fulfillmentStatus'],
      ['child', 'store-fulfillment-o1'],
      ['terminal', 'Completed'],
    ]);
  });

  it('merges domain state transitions and sorts everything by time', () => {
    const events = [
      ev('WorkflowExecutionStarted', '2026-06-21T00:00:00.000Z'),
      ev('WorkflowExecutionSignaled', '2026-06-21T00:00:04.000Z', 'signal: fulfillmentStatus'),
    ];
    const stateHistory = [
      { status: 'pending_assignment', timestamp: '2026-06-21T00:00:01.000Z' },
      { status: 'shipped', timestamp: '2026-06-21T00:00:05.000Z', note: 'from fulfillment' },
    ];
    const out = deriveTransitions(events, stateHistory);
    expect(out.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'start:Started',
      'state:pending_assignment',
      'signal:fulfillmentStatus',
      'state:shipped',
    ]);
    expect(out.find((s) => s.label === 'shipped')?.note).toBe('from fulfillment');
  });

  it('attributes each state transition to its cause and describes the delta', () => {
    const events = [
      ev('WorkflowExecutionStarted', '2026-06-21T00:00:00.000Z'),
      ev('WorkflowExecutionSignaled', '2026-06-21T00:00:04.000Z', 'signal: fulfillmentStatus'),
    ];
    const stateHistory = [
      { status: 'pending_assignment', timestamp: '2026-06-21T00:00:01.000Z' },
      { status: 'shipped', timestamp: '2026-06-21T00:00:05.000Z' },
    ];
    const out = deriveTransitions(events, stateHistory);

    const pending = out.find((s) => s.label === 'pending_assignment')!;
    expect(pending.from).toBeUndefined();
    expect(pending.cause).toBe('Started');
    expect(pending.delta).toBe('∅ → pending_assignment');

    const shipped = out.find((s) => s.label === 'shipped')!;
    expect(shipped.from).toBe('pending_assignment');
    expect(shipped.cause).toBe('fulfillmentStatus');
    expect(shipped.delta).toBe('pending_assignment → shipped');
  });

  it('carries the triggering payload onto update/signal steps and the state they cause', () => {
    const events: TraceEvent[] = [
      {
        eventId: '1',
        eventType: 'WorkflowExecutionSignaled',
        timestamp: '2026-06-21T00:00:04.000Z',
        detail: 'signal: fulfillmentStatus',
        payload: { status: 'shipped' },
      },
    ];
    const out = deriveTransitions(events, [
      { status: 'shipped', timestamp: '2026-06-21T00:00:05.000Z' },
    ]);
    expect(out.find((s) => s.kind === 'signal')?.payload).toEqual({ status: 'shipped' });
    // The state step inherits its cause's payload when it has none of its own.
    expect(out.find((s) => s.kind === 'state')?.payload).toEqual({ status: 'shipped' });
  });

  it('keeps insertion order for entries without a parseable timestamp', () => {
    const out = deriveTransitions([
      ev('WorkflowExecutionStarted', ''),
      ev('WorkflowExecutionUpdateAccepted', '', 'update: cartUpdate'),
    ]);
    expect(out.map((s) => s.kind)).toEqual(['start', 'update']);
  });
});
