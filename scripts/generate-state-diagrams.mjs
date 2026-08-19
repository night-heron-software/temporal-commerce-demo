#!/usr/bin/env node
/**
 * State Diagram Generator (AST-based)
 *
 * Fully regenerates docs/reference/state-machine-diagrams.md from source.
 * Run: npm run docs:diagrams        (regenerate)
 *      npm run docs:diagrams -- --check (CI: fail if the committed doc is stale)
 *      npm run docs:diagrams -- --strict (fail if a non-terminal state has no outgoing edges)
 *
 * Why an AST (not regex): transition targets are frequently NOT inline `next: 'x'`
 * literals inside a state's text block. With the authoring layer they appear as:
 *   - shared entries referenced by identifier:  `cancelCheckout: cancelCheckoutEntry`
 *   - a decide that returns a helper call:       `decide: (...) => decideSetShipping(...)`
 *   - terminal('reason') calls, `next =` assignments, conditional branches.
 * A text scan misses all of these (e.g. checkout's shipping→payment edge). The TS
 * compiler API lets us resolve identifier references and follow helper-function
 * returns to collect every reachable `next` target — so the diagrams are complete.
 *
 * Output per machine:
 *   ## Domain — `REGISTRY_NAME`
 *   Source: [path](../../path)
 *   <registry JSDoc, if present>
 *   ```mermaid stateDiagram-v2 ...```  (self-loops rendered as looping arcs)
 *   ### State: `name`  (+ JSDoc, event table, timeout)
 *
 * Each edge carries:
 *   on     — event/key name (or 'signal', 'timeout', '(auto)')
 *   kind   — 'update' | 'signal' | 'timeout' | 'auto'
 *   to     — target state or '__terminal:name'
 *   prepareActivities  — await-ed calls found in the `prepare` body
 *   finalizeActivities — await-ed calls found in the `finalize` body
 *   conditions         — top-level if-conditions in the `decide` body
 *
 * The static "Persistence and Projection" appendix is the PERSISTENCE_SECTION constant.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Domain sources live under src/temporal/<domain>/ in this repo (vs packages/<domain>/src
// in the source monorepo). The framework + recorder internals mention runStateMachine but
// define no domain machines, so they are skipped in the walk.
const PACKAGES = path.join(ROOT, 'src/temporal');
const SKIP_DIRS = new Set(['framework', 'transition-recorder']);
const OUT = path.join(ROOT, 'docs/reference/state-machine-diagrams.md');
const OUT_JSON = path.join(ROOT, 'docs/reference/state-graph.json');

const ARGS = new Set(process.argv.slice(2));
const CHECK = ARGS.has('--check');
const STRICT = ARGS.has('--strict');

/** Domain name for a path relative to ROOT: src/temporal/<domain>/… */
function domainOfRel(rel) {
  return rel.split(path.sep)[2];
}

// ============================================================================
// File traversal
// ============================================================================

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'dist' || e.name === 'node_modules' || SKIP_DIRS.has(e.name)) continue;
      out.push(...sourceFiles(p));
    } else if (
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.test.ts') &&
      !e.name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

// ============================================================================
// JSDoc (textual — comments are not part of the AST shape we need)
// ============================================================================

function jsdocBefore(src, marker) {
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  const before = src.slice(0, idx).trimEnd();
  if (!before.endsWith('*/')) return null;
  const closeIdx = before.lastIndexOf('*/');
  const openIdx = before.lastIndexOf('/**', closeIdx);
  if (openIdx === -1) return null;
  return (
    before
      .slice(openIdx + 3, closeIdx)
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
      .join('\n')
      .trim() || null
  );
}

// ============================================================================
// AST extraction — core helpers
// ============================================================================

/** Build a name → declaration map for top-level consts and functions in a file. */
function topLevelDecls(sf) {
  const decls = new Map();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name))
          decls.set(d.name.text, { init: d.initializer ?? null, body: null, node: d });
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      decls.set(stmt.name.text, { init: null, body: stmt.body ?? null, node: stmt });
    }
  }
  return decls;
}

function findReturnedObjectLiteral(body) {
  if (!body) return null;
  if (ts.isObjectLiteralExpression(body)) return body;

  let found = null;
  const visit = (n) => {
    if (ts.isReturnStatement(n) && n.expression) {
      const expr = unwrap(n.expression);
      if (ts.isObjectLiteralExpression(expr)) {
        found = expr;
      }
    }
    if (!found) n.forEachChild(visit);
  };
  visit(body);
  return found;
}

function unwrap(expr) {
  while (
    expr &&
    (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr))
  ) {
    expr = expr.expression;
  }
  return expr;
}

/** Resolve an expression to a transition target string ('state' | '__terminal:reason' | '__self'), or null. */
function evalTarget(expr, decls) {
  expr = unwrap(expr);
  if (!expr) return null;
  // `next: SELF` — the framework "stay in the current state" sentinel. Surfaced as the
  // '__self' marker here and substituted for the enclosing state in edgesFromCall().
  if (ts.isIdentifier(expr) && expr.text === 'SELF') return '__self';
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'terminal'
  ) {
    const a = expr.arguments[0];
    return a && ts.isStringLiteral(a) ? `__terminal:${a.text}` : null;
  }
  if (ts.isIdentifier(expr)) {
    const d = decls.get(expr.text);
    if (d && d.init) return evalTarget(d.init, decls);
    return null;
  }
  return null;
}

/** Function body for a local callable (function decl or const arrow/function expr), or null. */
function bodyOf(decl) {
  if (!decl) return null;
  if (decl.body) return decl.body;
  const init = decl.init && unwrap(decl.init);
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
  return null;
}

/** Index local `const/let X = …` declarations within a node by name (first wins). */
function localVarsOf(node) {
  const m = new Map();
  const v = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      !m.has(n.name.text)
    ) {
      m.set(n.name.text, n.initializer);
    }
    n.forEachChild(v);
  };
  if (node) v(node);
  return m;
}

/**
 * Resolve an expression to the set of transition targets it can yield. Handles
 * string literals, `terminal('x')`, ternaries (both branches), local-variable and
 * top-level-const references, and calls to local functions whose *returns* are the
 * value (e.g. `nextForStatus(status)`).
 */
function resolveTargets(expr, decls, locals, visited = new Set()) {
  expr = unwrap(expr);
  if (!expr) return [];
  // `next: SELF` sentinel → '__self' marker (substituted for the state in edgesFromCall()).
  if (ts.isIdentifier(expr) && expr.text === 'SELF') return ['__self'];
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'terminal'
  ) {
    const a = expr.arguments[0];
    return a && ts.isStringLiteral(a) ? [`__terminal:${a.text}`] : [];
  }
  if (ts.isConditionalExpression(expr)) {
    return [
      ...resolveTargets(expr.whenTrue, decls, locals, visited),
      ...resolveTargets(expr.whenFalse, decls, locals, visited),
    ];
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (visited.has(name)) return [];
    visited.add(name);
    const body = bodyOf(decls.get(name));
    return body ? [...collectReturnTargets(body, decls, visited)] : [];
  }
  if (ts.isIdentifier(expr)) {
    if (locals && locals.has(expr.text))
      return resolveTargets(locals.get(expr.text), decls, locals, visited);
    const init = unwrap(decls.get(expr.text)?.init);
    return init ? resolveTargets(init, decls, locals, visited) : [];
  }
  return [];
}

/** Collect the *return values* of a function body as targets (for `next: fn(...)`). */
function collectReturnTargets(node, decls, visited = new Set()) {
  const out = new Set();
  if (!node) return out;
  const locals = localVarsOf(node);
  if (!ts.isBlock(node)) {
    for (const t of resolveTargets(node, decls, locals, visited)) out.add(t);
    return out;
  }
  const v = (n) => {
    if (ts.isReturnStatement(n) && n.expression) {
      for (const t of resolveTargets(n.expression, decls, locals, visited)) out.add(t);
    }
    n.forEachChild(v);
  };
  v(node);
  return out;
}

/**
 * Collect every reachable `next` target within a node. Handles:
 *  - `next:` properties, `next =` / `let next =` assignments (literal / terminal() /
 *    ternary / local var / a function call whose returns are the value)
 *  - `return helperFn(...)` where the helper returns decision objects (e.g. decideSetShipping)
 *  - handler properties referenced by identifier (e.g. `decide: processingSignal`,
 *    shared entries like `cancelOrder: cancelOrderEntry`) — resolved + recursed.
 */
function collectTargets(node, decls, locals = new Map(), visited = new Set()) {
  const out = new Set();
  if (!node) return out;
  const combinedLocals = new Map([...localVarsOf(node), ...(locals || [])]);
  const addExpr = (expr) => {
    for (const t of resolveTargets(expr, decls, combinedLocals, visited)) out.add(t);
  };
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && n.name && n.name.getText() === 'next') {
      addExpr(n.initializer);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name && n.name.getText() === 'next') {
      addExpr(n.name);
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'next' &&
      n.initializer
    ) {
      addExpr(n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === 'next'
    ) {
      addExpr(n.right);
    } else if (ts.isReturnStatement(n) && n.expression) {
      // return helperFn(...) where the helper returns decision objects → recurse its body
      const e = unwrap(n.expression);
      if (
        ts.isCallExpression(e) &&
        ts.isIdentifier(e.expression) &&
        !visited.has(e.expression.text)
      ) {
        visited.add(e.expression.text);
        const body = bodyOf(decls.get(e.expression.text));
        if (body) for (const t of collectTargets(body, decls, combinedLocals, visited)) out.add(t);
      }
    } else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
      // Expression-bodied arrow `decide: (ctx, e) => helper(...)` — the body IS the
      // return value; follow a helper call the same way as `return helper(...)`.
      // (Object-literal bodies are covered by the `next:` visitor as traversal descends.)
      const e = unwrap(n.body);
      if (
        ts.isCallExpression(e) &&
        ts.isIdentifier(e.expression) &&
        !visited.has(e.expression.text)
      ) {
        visited.add(e.expression.text);
        const body = bodyOf(decls.get(e.expression.text));
        if (body) for (const t of collectTargets(body, decls, combinedLocals, visited)) out.add(t);
      }
    } else if (
      ts.isPropertyAssignment(n) &&
      n.initializer &&
      ts.isIdentifier(unwrap(n.initializer))
    ) {
      // handler property referenced by identifier: decide: processingSignal, cancelOrder: entry
      const id = unwrap(n.initializer);
      if (!visited.has(id.text)) {
        const d = decls.get(id.text);
        const body = bodyOf(d);
        const obj = d && d.init && unwrap(d.init);
        if (body) {
          visited.add(id.text);
          for (const t of collectTargets(body, decls, combinedLocals, visited)) out.add(t);
        } else if (obj && ts.isObjectLiteralExpression(obj)) {
          visited.add(id.text);
          for (const t of collectTargets(obj, decls, combinedLocals, visited)) out.add(t);
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

const propName = (p) => (p.name ? p.name.getText() : null);

/** The value node of a map property, resolving an identifier reference to its const initializer. */
function propValueNode(p, decls) {
  if (!ts.isPropertyAssignment(p)) return null;
  const v = unwrap(p.initializer);
  if (ts.isIdentifier(v)) {
    const d = decls.get(v.text);
    return d && d.init ? unwrap(d.init) : v;
  }
  return v;
}

// ============================================================================
// Rich edge info extraction
// ============================================================================

/** Verbatim source text of a node (trimmed). */
function getNodeText(node, src) {
  return src.slice(node.getStart(), node.getEnd()).trim();
}

/**
 * Resolve a node to an ObjectLiteralExpression, following identifier references
 * one level (top-level const whose init is an object literal).
 */
function resolveToObj(node, decls) {
  node = unwrap(node);
  if (!node) return null;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isIdentifier(node)) {
    const d = decls.get(node.text);
    if (d && d.init) return resolveToObj(d.init, decls);
  }
  return null;
}

/**
 * Find the body of a named property/method in an ObjectLiteralExpression.
 * Handles: MethodDeclaration (`async prepare(...){}`), PropertyAssignment with
 * arrow/function expression, and PropertyAssignment with an identifier reference
 * to a top-level function or const.
 */
function findPropBody(obj, propKey, decls) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const p of obj.properties) {
    const key = p.name
      ? ts.isIdentifier(p.name)
        ? p.name.text
        : ts.isStringLiteral(p.name)
          ? p.name.text
          : null
      : null;
    if (key !== propKey) continue;
    if (ts.isMethodDeclaration(p)) return p.body ?? null;
    if (ts.isPropertyAssignment(p)) {
      const v = unwrap(p.initializer);
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return v.body ?? null;
      if (ts.isIdentifier(v)) return bodyOf(decls.get(v.text));
    }
  }
  return null;
}

/**
 * Collect names of top-level awaited function calls within a function body node.
 * Does not recurse into nested function/arrow expressions.
 */
function extractAwaitedCallsInBody(body) {
  if (!body) return [];
  const calls = [];
  const visit = (n) => {
    if (
      n !== body &&
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
    )
      return;
    if (ts.isAwaitExpression(n)) {
      const expr = unwrap(n.expression);
      if (ts.isCallExpression(expr)) {
        const callee = expr.expression;
        if (ts.isIdentifier(callee)) calls.push(callee.text);
        else if (ts.isPropertyAccessExpression(callee)) calls.push(callee.name.text);
      }
    }
    n.forEachChild(visit);
  };
  visit(body);
  return [...new Set(calls)];
}

/**
 * Extract the text of each top-level if-condition in a decide function body.
 * Returns short condition snippets like `!prepared.success` or `signal.kind === 'cancel'`.
 */
function extractTopLevelConditions(body, src) {
  if (!body || !ts.isBlock(body)) return [];
  const conditions = [];
  for (const stmt of body.statements) {
    if (ts.isIfStatement(stmt)) {
      conditions.push(getNodeText(stmt.expression, src));
    }
  }
  return conditions;
}

/**
 * For an `onSignal` handler decide body, look for `X.kind === 'y'` patterns
 * and return the distinct kind strings found (e.g. ['cancel', 'update']).
 */
function extractSignalKinds(body, _src) {
  if (!body) return [];
  const kinds = [];
  const visit = (n) => {
    if (ts.isIfStatement(n)) {
      const kind = kindFromCondition(n.expression);
      if (kind) kinds.push(kind);
    }
    n.forEachChild(visit);
  };
  visit(body);
  return [...new Set(kinds)];
}

function kindFromCondition(expr) {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken)
    return null;
  const [l, r] = [expr.left, expr.right];
  if (ts.isPropertyAccessExpression(l) && l.name.text === 'kind' && ts.isStringLiteral(r))
    return r.text;
  if (ts.isPropertyAccessExpression(r) && r.name.text === 'kind' && ts.isStringLiteral(l))
    return l.text;
  return null;
}

/**
 * Build rich edges from a resolved handler node (an object literal with prepare/decide/finalize,
 * or any node we can collect targets from). Each edge shares the prepare/finalize/conditions
 * derived from the handler.
 */
function handlerEdges(on, kind, handlerNode, decls, src, locals = new Map()) {
  const handlerObj = resolveToObj(handlerNode, decls);

  const prepareBody = handlerObj ? findPropBody(handlerObj, 'prepare', decls) : null;
  const finalizeBody = handlerObj ? findPropBody(handlerObj, 'finalize', decls) : null;
  const decideBody = handlerObj ? findPropBody(handlerObj, 'decide', decls) : null;

  const prepareActivities = extractAwaitedCallsInBody(prepareBody);
  const finalizeActivities = extractAwaitedCallsInBody(finalizeBody);
  const conditions = extractTopLevelConditions(decideBody, src);

  // For signal edges, detect kind discrimination.
  // Fall back to the decide function name when the handler uses a named function reference
  // rather than inline kind-switching (e.g. OMS's processingSignal / shippedSignal which
  // branch on update.status instead of signal.kind).
  let signalKinds = [];
  if (kind === 'signal' && handlerObj) {
    if (decideBody) {
      signalKinds = extractSignalKinds(decideBody, src);
    }
    if (signalKinds.length === 0) {
      // Look for `decide: <Identifier>` — use the function name as a fallback label
      for (const p of handlerObj.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = p.name && ts.isIdentifier(p.name) ? p.name.text : null;
        if (key === 'decide') {
          const v = unwrap(p.initializer);
          if (ts.isIdentifier(v)) signalKinds = [v.text];
        }
      }
    }
  }

  const targets = [...collectTargets(handlerNode, decls, locals)];
  return targets.map((to) => ({
    on,
    kind,
    to,
    prepareActivities,
    finalizeActivities,
    conditions,
    signalKinds,
  }));
}

// ============================================================================
// Decider-native surface (ADR-0024 `defineMachine`) — routing is DATA
// ============================================================================

/** True for `m.state('name', { …, route: {…} })` — the ADR-0024 surface (the legacy
 *  `.state(name, handler)` escape hatch has no `route` property). */
function isMachineStateCall(call) {
  if (!call || !ts.isCallExpression(call)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'state') return false;
  const def = call.arguments[1] && unwrap(call.arguments[1]);
  if (!def || !ts.isObjectLiteralExpression(def)) return false;
  return def.properties.some((p) => propName(p) === 'route');
}

/**
 * Extract a decider-native state's edges, accepted commands, and config from its
 * definition object. Routing is a data table (event type → target), so edges are read
 * directly — no decide-body scanning. Commands are the state's accepted inputs; each
 * carries the awaited calls of its `prepare`. `onTimeout` synthesizes a command whose
 * emitted events we cannot know statically, so it contributes timeout edges to every
 * distinct route target (like a conditional's branches). Effects attach their awaited
 * calls to the matching event's edge as finalize activities.
 */
/**
 * Resolve a named property's initializer inside an object literal to an object literal —
 * following an identifier (`routes: sharedRoutes`) or a member access on a block
 * (`routes: updateStatusBlock.routes`), the ADR-0026 handler-override shape.
 * (Ported from mono #253.)
 */
function propObjectLiteral(obj, propKey, decls) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  let found = null;
  for (const p of obj.properties) {
    // Look THROUGH a spread (`{ ...updateStatusBlock, enrich }`) — ported from mono #270.
    // Without it, a handler that overrides one phase of a block reported no `evolve`, and a
    // command that can force many statuses rendered as "(no events — idempotent no-op)" — the
    // diagram stating the exact opposite of the truth. Precedence is JS's: later wins, and an
    // OWN assignment replaces what a preceding spread contributed even when it is unresolvable
    // (returning null then, rather than falling back to the spread — a handler that
    // deliberately overrides `evolve` must not be reported as the block's).
    if (ts.isSpreadAssignment(p)) {
      const spreadObj = resolveToObj(unwrap(p.expression), decls);
      if (spreadObj) {
        const fromSpread = propObjectLiteral(spreadObj, propKey, decls);
        if (fromSpread) found = fromSpread;
      }
      continue;
    }
    if (propName(p) !== propKey || !ts.isPropertyAssignment(p)) continue;
    const v = unwrap(p.initializer);
    const direct = resolveToObj(v, decls);
    if (direct) {
      found = direct;
      continue;
    }
    found = null;
    if (ts.isPropertyAccessExpression(v) && ts.isIdentifier(v.expression)) {
      const owner = resolveToObj(v.expression, decls);
      if (owner) found = propObjectLiteral(owner, v.name.text, decls);
    }
  }
  return found;
}

/**
 * Does this handler object carry `propKey`, directly or via a spread? (Mono #270.)
 *
 * Separate from `propObjectLiteral` because `guard` is a FUNCTION, not an object literal —
 * only its presence is rendered (the `*(guarded)*` marker). A spread-form handler has no
 * literal `guard` property of its own, so a presence test that only scanned own properties
 * silently dropped the marker.
 */
function hasHandlerProp(obj, propKey, decls) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return false;
  let found = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const spreadObj = resolveToObj(unwrap(p.expression), decls);
      if (spreadObj && hasHandlerProp(spreadObj, propKey, decls)) found = true;
      continue;
    }
    if (propName(p) === propKey) found = true;
  }
  return found;
}

function machineStateFromDef(defObj, decls, _src) {
  const edges = [];
  const commands = [];
  let timeout = null;
  let transitional = false;
  let routeObj = null;
  let deriveCall = null;
  let commandsObj = null;
  let effectsObj = null;
  let onTimeoutNode = null;

  for (const p of defObj.properties) {
    const key = propName(p);
    if (!key || !ts.isPropertyAssignment(p)) continue;
    const v = unwrap(p.initializer);
    if (key === 'route') {
      routeObj = resolveToObj(v, decls);
      // ADR-0026 (ported from mono #253): `route: deriveRoutes(commands, extras?)` — the table
      // is derived from the blocks' `routes` declarations. Read those declarations directly;
      // they are object literals, exactly as statically visible as the old hand-written table.
      if (
        !routeObj &&
        ts.isCallExpression(v) &&
        ts.isIdentifier(v.expression) &&
        v.expression.text === 'deriveRoutes'
      ) {
        deriveCall = v;
      }
    } else if (key === 'commands') commandsObj = resolveToObj(v, decls);
    else if (key === 'effects') effectsObj = resolveToObj(v, decls);
    else if (key === 'onTimeout') onTimeoutNode = v;
    else if (key === 'timeout' && ts.isStringLiteral(v)) timeout = v.text;
    else if (key === 'transitional' && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
      transitional = true;
  }

  // If the route is derived, the state's commands are deriveRoutes' first argument —
  // resolve from there when the def's own `commands:` was not already resolvable.
  if (deriveCall && !commandsObj) commandsObj = resolveToObj(deriveCall.arguments[0], decls);

  // Shared handler groups arrive as spreads (`...lifecycleCommands`) — resolve them.
  // (Needed before route derivation: derived tables are built FROM the handlers.)
  const commandProps = [];
  if (commandsObj) {
    for (const p of commandsObj.properties) {
      if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
        const spreadObj = resolveToObj(p.expression, decls);
        if (spreadObj) commandProps.push(...spreadObj.properties);
        continue;
      }
      commandProps.push(p);
    }
  }

  const pushRouteEdge = (rawName, target) => {
    if (!target) return;
    // String-literal keys (the `'*'` fallback) keep their quotes in propName — strip.
    const on = rawName.replace(/^'(.*)'$/, '$1');
    const existing = edges.find((e) => e.on === on && e.kind === 'event');
    if (existing) {
      existing.to = target; // literal/derived merge: last write wins (deriveRoutes forbids conflicts)
      return;
    }
    edges.push({
      on,
      kind: 'event',
      to: target,
      prepareActivities: [],
      finalizeActivities: [],
      conditions: [],
      signalKinds: [],
    });
  };

  if (routeObj) {
    for (const p of routeObj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      pushRouteEdge(propName(p), evalTarget(p.initializer, decls));
    }
  } else if (deriveCall) {
    // Mirror deriveRoutes: union of each handler's `routes` declarations…
    for (const p of commandProps) {
      const handlerObj = resolveToObj(propValueNode(p, decls), decls);
      const routesObj = handlerObj ? propObjectLiteral(handlerObj, 'routes', decls) : null;
      if (!routesObj) continue;
      for (const rp of routesObj.properties) {
        if (!ts.isPropertyAssignment(rp)) continue;
        pushRouteEdge(propName(rp), evalTarget(rp.initializer, decls));
      }
    }
    // …then the extras literal (wildcard / weaken-to-SELF), same reading as a route table.
    const extrasObj = deriveCall.arguments[1] ? resolveToObj(deriveCall.arguments[1], decls) : null;
    if (extrasObj) {
      for (const rp of extrasObj.properties) {
        if (!ts.isPropertyAssignment(rp)) continue;
        pushRouteEdge(propName(rp), evalTarget(rp.initializer, decls));
      }
    }
  }

  for (const p of commandProps) {
    const name = propName(p);
    if (!name) continue;
    const handlerObj = resolveToObj(propValueNode(p, decls), decls);
    const prepareBody = handlerObj ? findPropBody(handlerObj, 'prepare', decls) : null;
    const guarded = hasHandlerProp(handlerObj, 'guard', decls);
    const prepareActivities = extractAwaitedCallsInBody(prepareBody);

    // Per-command journey (ported from mono #253): the events this command can emit are its
    // block's evolve-map KEYS (the CommandBlock convention: the block is the whole story),
    // each joined against this state's route table — explicit entry, wildcard fall-through,
    // or unrouted (both of the latter mean "stays"). `declared` records the block's own
    // `routes` target where present, so drift between a declaration and a hand-written
    // table is visible data (and CI-checkable).
    const evolveObj = handlerObj ? propObjectLiteral(handlerObj, 'evolve', decls) : null;
    const routesObj = handlerObj ? propObjectLiteral(handlerObj, 'routes', decls) : null;
    const declaredTargets = {};
    if (routesObj) {
      for (const rp of routesObj.properties) {
        if (!ts.isPropertyAssignment(rp)) continue;
        const t = evalTarget(rp.initializer, decls);
        if (t) declaredTargets[propName(rp).replace(/^'(.*)'$/, '$1')] = t;
      }
    }
    const emits = [];
    if (evolveObj) {
      for (const ep of evolveObj.properties) {
        const ev = propName(ep);
        if (!ev) continue;
        const explicit = edges.find((e) => e.on === ev && e.kind === 'event');
        const wildcard = edges.find((e) => e.on === '*' && e.kind === 'event');
        const via = explicit ? 'explicit' : wildcard ? 'wildcard' : 'unrouted';
        const to = explicit ? explicit.to : wildcard ? wildcard.to : '__self';
        emits.push({
          event: ev,
          to,
          via,
          ...(declaredTargets[ev] !== undefined ? { declared: declaredTargets[ev] } : {}),
        });
      }
    }

    commands.push({
      name,
      ...(guarded ? { guarded: true } : {}),
      ...(prepareActivities.length ? { prepareActivities } : {}),
      ...(emits.length ? { emits } : {}),
    });
  }
  if (effectsObj) {
    for (const p of effectsObj.properties) {
      const ev = propName(p);
      if (!ev) continue;
      const calls = extractAwaitedCallsInBody(findPropBody(effectsObj, ev, decls));
      if (!calls.length) continue;
      const edge = edges.find((e) => e.on === ev);
      if (edge) edge.finalizeActivities = calls;
    }
  }
  if (onTimeoutNode) {
    // Label with the synthesized command's literal type when derivable.
    let cmdName = 'timeout';
    const body =
      ts.isArrowFunction(onTimeoutNode) || ts.isFunctionExpression(onTimeoutNode)
        ? unwrap(onTimeoutNode.body) // expression-body arrows parenthesize the object literal
        : null;
    const ret = body ? findReturnedObjectLiteral(body) : null;
    if (ret) {
      for (const rp of ret.properties) {
        if (
          propName(rp) === 'type' &&
          ts.isPropertyAssignment(rp) &&
          ts.isStringLiteral(unwrap(rp.initializer))
        ) {
          cmdName = unwrap(rp.initializer).text;
        }
      }
    }
    for (const to of new Set(edges.map((e) => e.to))) {
      edges.push({
        on: cmdName,
        kind: 'timeout',
        to,
        prepareActivities: [],
        finalizeActivities: [],
        conditions: [],
        signalKinds: [],
      });
    }
  }

  return { edges, commands, timeout, transitional };
}

/** Extract edges [{on, kind, to, prepareActivities, finalizeActivities, conditions, signalKinds}] from a domain authoring call. */
function edgesFromCall(call, decls, src) {
  const edges = [];
  if (!call || !ts.isCallExpression(call)) return edges;
  const callee = call.expression;
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  const args = call.arguments;

  // The state's own name is the first arg of transitions/route/state — used to
  // substitute any `SELF` ('__self') self-loop target collected below.
  const selfState = args[0] ? evalTarget(args[0], decls) : null;

  if (method === 'transitions') {
    // Both args may be identifiers referencing top-level consts (e.g. a shared
    // `activeTransitions` map or a `timeoutCancels` inputs object) — dereference them.
    const map = args[1] && resolveToObj(args[1], decls);
    const inputs = args[2] && resolveToObj(args[2], decls);
    if (map && ts.isObjectLiteralExpression(map)) {
      for (const p of map.properties) {
        if (ts.isSpreadAssignment(p)) {
          const expr = unwrap(p.expression);
          if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
            const funcName = expr.expression.text;
            const decl = decls.get(funcName);
            if (decl) {
              let funcNode = decl.node;
              let params = [];
              let body = decl.body;
              if (funcNode) {
                if (ts.isFunctionDeclaration(funcNode)) {
                  params = funcNode.parameters;
                } else if (ts.isVariableDeclaration(funcNode) && decl.init) {
                  const init = unwrap(decl.init);
                  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                    params = init.parameters;
                    body = init.body;
                  }
                }
              }
              const locals = new Map();
              if (params && params.length > 0) {
                params.forEach((param, i) => {
                  if (ts.isIdentifier(param.name) && expr.arguments[i]) {
                    locals.set(param.name.text, expr.arguments[i]);
                  }
                });
              }
              const retObj = findReturnedObjectLiteral(body);
              if (retObj) {
                for (const subP of retObj.properties) {
                  const ev = propName(subP);
                  if (ev) {
                    const valNode = propValueNode(subP, decls);
                    edges.push(...handlerEdges(ev, 'update', valNode, decls, src, locals));
                  }
                }
              }
            }
          }
        } else {
          const ev = propName(p);
          if (ev) edges.push(...handlerEdges(ev, 'update', propValueNode(p, decls), decls, src));
        }
      }
    }
    if (inputs && ts.isObjectLiteralExpression(inputs)) {
      for (const p of inputs.properties) {
        const key = propName(p);
        if (!key) continue;
        // onSignals is a per-kind MAP, not a single handler: each property is a signal kind
        // whose value is its own { prepare?, decide, finalize? } handler. Emit one signal edge
        // group per kind, labelled with that kind name (the property key).
        if (key === 'onSignals') {
          const mapObj = resolveToObj(propValueNode(p, decls), decls);
          if (mapObj) {
            for (const kp of mapObj.properties) {
              const sigKind = propName(kp);
              if (!sigKind) continue;
              for (const e of handlerEdges(
                'signal',
                'signal',
                propValueNode(kp, decls),
                decls,
                src,
              )) {
                e.signalKinds = [sigKind];
                edges.push(e);
              }
            }
          }
          continue;
        }
        const edgeKind = key === 'onTimeout' ? 'timeout' : key === 'onSignal' ? 'signal' : 'auto';
        const on = key === 'onTimeout' ? 'timeout' : key === 'onSignal' ? 'signal' : key;
        edges.push(...handlerEdges(on, edgeKind, propValueNode(p, decls), decls, src));
      }
    }
  } else if (method === 'route') {
    const table = args[1] && resolveToObj(args[1], decls);
    const opts = args[2] && resolveToObj(args[2], decls);
    if (table && ts.isObjectLiteralExpression(table)) {
      for (const p of table.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const t = evalTarget(p.initializer, decls);
        if (t)
          edges.push({
            on: propName(p),
            kind: 'update',
            to: t,
            prepareActivities: [],
            finalizeActivities: [],
            conditions: [],
            signalKinds: [],
          });
      }
    }
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = propName(p);
        const edgeKind = key === 'signal' ? 'signal' : key === 'timeout' ? 'timeout' : 'auto';
        const t = evalTarget(p.initializer, decls);
        if (t)
          edges.push({
            on: key,
            kind: edgeKind,
            to: t,
            prepareActivities: [],
            finalizeActivities: [],
            conditions: [],
            signalKinds: [],
          });
      }
    }
  } else if (method === 'state' && isMachineStateCall(call)) {
    // Decider-native surface: routing is data; SELF resolution happens below.
    edges.push(...machineStateFromDef(unwrap(args[1]), decls, src).edges);
  } else if (method === 'state') {
    const node =
      args[1] && unwrap(args[1]).kind === ts.SyntaxKind.Identifier
        ? decls.get(unwrap(args[1]).text)?.init && unwrap(decls.get(unwrap(args[1]).text).init)
        : args[1] && unwrap(args[1]);
    for (const to of collectTargets(node, decls)) {
      edges.push({
        on: '(auto)',
        kind: 'auto',
        to,
        prepareActivities: [],
        finalizeActivities: [],
        conditions: [],
        signalKinds: [],
      });
    }
  }
  // Resolve the SELF sentinel to this state's own name (a self-loop).
  if (selfState && selfState !== '__self') {
    for (const e of edges) if (e.to === '__self') e.to = selfState;
  }
  return edges;
}

const autoEdges = (node, decls) =>
  [...collectTargets(node, decls)].map((to) => ({
    on: '(auto)',
    kind: 'auto',
    to,
    prepareActivities: [],
    finalizeActivities: [],
    conditions: [],
    signalKinds: [],
  }));

/** Extract edges + the state's binding name from a registry entry's value object. */
function edgesForEntry(entryObj, decls, src) {
  if (!entryObj || !ts.isObjectLiteralExpression(entryObj)) return { edges: [], bindingName: null };
  for (const p of entryObj.properties) {
    // `{ ...shipping, timeout: ... }` — resolve the spread identifier to its authoring call
    if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
      const init = unwrap(decls.get(p.expression.text)?.init);
      if (init && ts.isCallExpression(init)) {
        return { edges: edgesFromCall(init, decls, src), bindingName: p.expression.text };
      }
      if (init && ts.isObjectLiteralExpression(init)) {
        return { edges: autoEdges(init, decls), bindingName: p.expression.text };
      }
    }
    // `{ fn: ... }` — inline arrow / definePureState(handler) / domain call / identifier
    if (ts.isPropertyAssignment(p) && propName(p) === 'fn') {
      const v = unwrap(p.initializer);
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) {
        return { edges: autoEdges(v.body, decls), bindingName: null };
      }
      if (ts.isCallExpression(v)) {
        let edges = edgesFromCall(v, decls, src);
        if (
          edges.length === 0 &&
          ts.isIdentifier(v.expression) &&
          v.expression.text === 'definePureState'
        ) {
          const handler = v.arguments[0] && unwrap(v.arguments[0]);
          const hNode =
            handler && ts.isIdentifier(handler) ? unwrap(decls.get(handler.text)?.init) : handler;
          edges = autoEdges(hNode, decls);
        }
        return { edges, bindingName: null };
      }
      if (ts.isIdentifier(v)) {
        const init = unwrap(decls.get(v.text)?.init);
        if (init && ts.isCallExpression(init))
          return { edges: edgesFromCall(init, decls, src), bindingName: v.text };
        if (init && ts.isObjectLiteralExpression(init))
          return { edges: autoEdges(init, decls), bindingName: v.text };
      }
    }
  }
  return { edges: [], bindingName: null };
}

/** Parse a `states` object-literal (exported registry or inline config) into a machine model. */
function parseStatesObject(obj, registryName, src, decls) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;

  const states = [];
  for (const p of obj.properties) {
    // Decider-native registries commonly use shorthand entries (`{ active, checkout }`)
    // because `m.state()` already carries timeout/transitional — resolve the binding.
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = ts.isShorthandPropertyAssignment(p) ? p.name.text : propName(p);
    let entryObj = ts.isShorthandPropertyAssignment(p) ? p.name : unwrap(p.initializer);
    // A registry entry may be a binding to an authoring call: resolve it.
    if (entryObj && ts.isIdentifier(entryObj)) {
      const init = unwrap(decls.get(entryObj.text)?.init);
      if (init && ts.isCallExpression(init) && isMachineStateCall(init)) entryObj = init;
    }
    // Decider-native entry: `name: m.state('name', { commands, route, … })` —
    // timeout/transitional live in the def, edges come from the route table.
    if (entryObj && ts.isCallExpression(entryObj) && isMachineStateCall(entryObj)) {
      const selfState = entryObj.arguments[0] ? evalTarget(entryObj.arguments[0], decls) : name;
      const m = machineStateFromDef(unwrap(entryObj.arguments[1]), decls, src);
      for (const e of m.edges) if (e.to === '__self') e.to = selfState ?? name;
      const seenKeys = new Set();
      const dedupedEdges = m.edges.filter((e) => {
        const key = `${e.on}->${e.to}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      const doc = jsdocBefore(src, `${name}:`) || null;
      states.push({
        name,
        timeout: m.timeout,
        transitional: m.transitional,
        edges: dedupedEdges,
        doc,
        commands: m.commands,
      });
      continue;
    }
    let timeout = null;
    let transitional = false;
    if (entryObj && ts.isObjectLiteralExpression(entryObj)) {
      for (const ep of entryObj.properties) {
        if (!ts.isPropertyAssignment(ep)) continue;
        const k = propName(ep);
        if (k === 'timeout') {
          const v = unwrap(ep.initializer);
          if (ts.isStringLiteral(v)) timeout = v.text;
        } else if (k === 'transitional' && ep.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          transitional = true;
        }
      }
    }
    const { edges: rawEdges, bindingName } = edgesForEntry(entryObj, decls, src);
    // Dedupe (on,to)
    const seen = new Set();
    const edges = [];
    for (const e of rawEdges) {
      const key = `${e.on}->${e.to}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
    const doc =
      (bindingName && jsdocBefore(src, `const ${bindingName} `)) ||
      jsdocBefore(src, `${name}:`) ||
      null;
    states.push({ name, timeout, transitional, edges, doc });
  }
  return { registry: registryName, states };
}

/** Parse one `export const X_STATES = {...}` registry into a structured machine model. */
function parseRegistry(sf, src, registryName, decls) {
  return parseStatesObject(unwrap(decls.get(registryName)?.init), registryName, src, decls);
}

/** Nearest enclosing function/const-function name, for labelling an inline registry. */
function enclosingName(node) {
  let p = node.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      const init = p.initializer && unwrap(p.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return p.name.text;
    }
    p = p.parent;
  }
  return null;
}

/**
 * Find inline state machines — object literals with both a `states` object-literal and an
 * `initialState` string (the shape passed to `runStateMachine`), e.g. the fulfiller order
 * machine whose registry is not an exported `*_STATES` const.
 */
function findInlineMachines(sf) {
  const found = [];
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      let statesObj = null;
      let initialState = null;
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = propName(p);
        const v = unwrap(p.initializer);
        if (key === 'states' && ts.isObjectLiteralExpression(v)) statesObj = v;
        else if (key === 'initialState' && ts.isStringLiteral(v)) initialState = v.text;
      }
      if (statesObj && initialState) {
        found.push({ statesObj, initialState, label: enclosingName(n) || 'stateMachine' });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

function findRegistries(src) {
  const names = [];
  const re = /export const ([A-Z0-9_]+_STATES)\b/g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Short trigger token for an aggregated Mermaid edge label. Bare names only — no
 * ':' (Mermaid stateDiagram-v2 splits target from label on the first colon, and a
 * second colon breaks some renderers including Obsidian). Auto edges contribute none.
 */
function triggerToken(edge) {
  const { on, kind } = edge;
  if (on === '(auto)' || on === '') return null;
  if (kind === 'timeout') return 'timeout';
  if (kind === 'signal') {
    return edge.signalKinds && edge.signalKinds.length > 0
      ? edge.signalKinds.join(' / ')
      : 'signal';
  }
  return on;
}

function mermaid(machine, initialState) {
  const lines = ['```mermaid', 'stateDiagram-v2'];
  for (const s of machine.states) lines.push(`  ${s.name}`);
  if (initialState) lines.push(`  [*] --> ${initialState}`);

  const notes = [];
  for (const s of machine.states) {
    // Aggregate parallel edges — same source, destination node, and terminal reason —
    // into ONE arc with a combined label. Mermaid stateDiagram-v2 stacks multiple edges
    // between the same pair of nodes on top of each other (notably self-loops), so all
    // but one render invisibly. One arc per group keeps every trigger visible; per-trigger
    // detail (prepare/finalize/conditions) lives in the table below.
    const groups = new Map();
    for (const edge of s.edges) {
      const { to } = edge;
      const dest = to.startsWith('__terminal:') ? '[*]' : to;
      const termName = to.startsWith('__terminal:') ? to.replace('__terminal:', '') : null;
      const key = `${dest} ${termName ?? ''}`;
      if (!groups.has(key)) groups.set(key, { dest, termName, tokens: [] });
      const tok = triggerToken(edge);
      const g = groups.get(key);
      if (tok && !g.tokens.includes(tok)) g.tokens.push(tok);
    }
    for (const { dest, termName, tokens } of groups.values()) {
      const triggers = tokens.join(' / ');
      const fullLbl = termName ? (triggers ? `${triggers} → ${termName}` : termName) : triggers;
      lines.push(`  ${s.name} --> ${dest}${fullLbl ? `: ${fullLbl}` : ''}`);
    }
    if (s.timeout) notes.push(`  note right of ${s.name}: timeout ${s.timeout}`);
  }
  lines.push(...notes);
  lines.push('```');
  return lines.join('\n');
}

/** Format the Notes cell for a table row. */
function formatNotes(edge) {
  const parts = [];
  if (edge.prepareActivities && edge.prepareActivities.length > 0) {
    parts.push(`prepare: \`${edge.prepareActivities.join('`, `')}\``);
  }
  if (edge.conditions && edge.conditions.length > 0) {
    parts.push(`if: \`${edge.conditions.join('`; `')}\``);
  }
  if (edge.finalizeActivities && edge.finalizeActivities.length > 0) {
    parts.push(`finalize: \`${edge.finalizeActivities.join('`, `')}\``);
  }
  if (edge.signalKinds && edge.signalKinds.length > 0) {
    parts.push(`signal kinds: \`${edge.signalKinds.join('`, `')}\``);
  }
  return parts.join(' · ');
}

/** Human-readable trigger label for the table's first column. */
function triggerLabel(edge) {
  const { on, kind } = edge;
  if (on === '(auto)' || on === '') return '*(auto)*';
  if (kind === 'timeout') return on === 'timeout' ? '`timeout`' : `\`timeout → ${on}\``;
  if (kind === 'signal') return '`signal`';
  // 'event' (ADR-0024): the machine routed on an emitted event, whatever transport
  // carried the command that produced it.
  if (kind === 'event') return `\`event: ${on}\``;
  return `\`update: ${on}\``;
}

function stateSection(s) {
  const lines = [`### State: \`${s.name}\``];
  if (s.doc) {
    lines.push('');
    lines.push(s.doc);
  }
  if (s.commands && s.commands.length > 0) {
    lines.push('');
    lines.push('**Accepts** (each command → the events it can emit ⇒ where each leads):');
    lines.push('');
    for (const c of s.commands) {
      const marks = [
        c.guarded ? 'guarded' : null,
        c.prepareActivities?.length ? `prepare: ${c.prepareActivities.join(', ')}` : null,
      ].filter(Boolean);
      const head = `\`${c.name}\`${marks.length ? ` *(${marks.join('; ')})*` : ''}`;
      const journey = (c.emits ?? [])
        .map((em) => {
          // `__self` is this graph's stay sentinel (the demo does not substitute SELF with
          // the state name the way the mono's parser does — the raw sentinel IS the demo's
          // graph convention, and changing it would break the port's edge-triple invariant).
          const dest = em.to.startsWith('__terminal:')
            ? `**${em.to.replace('__terminal:', '')}** (terminal)`
            : em.to === s.name || em.to === '__self'
              ? '*stays*'
              : `\`${em.to}\``;
          return `\`${em.event}\` ⇒ ${dest}`;
        })
        .join(' · ');
      lines.push(`- ${head}${journey ? ` → ${journey}` : ' → *(no events — idempotent no-op)*'}`);
    }
    lines.push('');
    lines.push('Any other command is rejected.');
  }
  if (s.edges.length > 0) {
    lines.push('');
    lines.push('| Trigger | Next | Notes |');
    lines.push('|---------|------|-------|');
    const seen = new Set();
    for (const edge of s.edges) {
      const { to } = edge;
      const key = `${edge.on}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dest = to.startsWith('__terminal:')
        ? `⇒ ${to.replace('__terminal:', '')}`
        : `\`${to}\``;
      const trigger = triggerLabel(edge);
      let notes = formatNotes(edge);
      if (edge.on === '*' && s.commands?.length) {
        // Make the wildcard's cargo visible: the emitted events that actually fall
        // through it in this state (they have no explicit route entry).
        const fallers = [
          ...new Set(
            s.commands.flatMap((c) =>
              (c.emits ?? []).filter((em) => em.via === 'wildcard').map((em) => em.event),
            ),
          ),
        ];
        if (fallers.length) {
          const label = `falls through: ${fallers.map((f) => `\`${f}\``).join(', ')}`;
          notes = notes ? `${notes}; ${label}` : label;
        }
      }
      lines.push(`| ${trigger} | ${dest} | ${notes} |`);
    }
  }
  if (s.timeout) {
    lines.push('');
    lines.push(`**Timeout:** ${s.timeout}`);
  }
  return lines.join('\n');
}

function domainHeading(domain, registry) {
  const title =
    domain.length <= 3 ? domain.toUpperCase() : domain.charAt(0).toUpperCase() + domain.slice(1);
  return `${title} — \`${registry}\``;
}

function generateSection(machine, src, rel, initialState) {
  const domain = domainOfRel(rel);
  const registryDoc = jsdocBefore(src, `export const ${machine.registry}`);
  const parts = [
    `## ${domainHeading(domain, machine.registry)}`,
    '',
    `Source: [${rel}](../../${rel})`,
  ];
  if (registryDoc) {
    parts.push('');
    parts.push(registryDoc);
  }
  parts.push('');
  parts.push(mermaid(machine, initialState));
  for (const s of machine.states) {
    parts.push('');
    parts.push(stateSection(s));
  }
  return parts.join('\n');
}

// ============================================================================
// Machine collection
// ============================================================================

function collectMachines() {
  const files = sourceFiles(PACKAGES).filter((f) =>
    /_STATES\b|runStateMachine/.test(fs.readFileSync(f, 'utf-8')),
  );
  const machines = [];
  const seenRegistries = new Set();
  const seenStateSets = new Set();
  const stateSetKey = (m) =>
    m.states
      .map((s) => s.name)
      .sort()
      .join(',');
  for (const file of files.sort()) {
    const src = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(ROOT, file);
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const decls = topLevelDecls(sf);

    // --- Exported `const X_STATES = {...}` registries ---
    for (const registry of findRegistries(src)) {
      if (seenRegistries.has(registry)) continue;
      const machine = parseRegistry(sf, src, registry, decls);
      if (!machine || machine.states.length === 0) continue;
      seenRegistries.add(registry);

      let initialState = null;
      const dir = path.dirname(file);
      for (const wf of fs.readdirSync(dir)) {
        if (!/workflow/.test(wf) || !wf.endsWith('.ts')) continue;
        const im = fs
          .readFileSync(path.join(dir, wf), 'utf-8')
          .match(/initialState\s*:\s*'([^']+)'/);
        if (im && machine.states.some((s) => s.name === im[1])) {
          initialState = im[1];
          break;
        }
      }
      if (!initialState) initialState = machine.states[0].name;
      seenStateSets.add(stateSetKey(machine));
      machines.push({ machine, src, rel, initialState });
    }

    // --- Inline `{ states: {...}, initialState }` machines (e.g. fulfiller order) ---
    for (const { statesObj, initialState, label } of findInlineMachines(sf)) {
      if (seenRegistries.has(label)) continue;
      const machine = parseStatesObject(statesObj, label, src, decls);
      if (!machine || machine.states.length === 0) continue;
      // Skip an inline machine that duplicates an exported registry (same state set) —
      // e.g. a per-execution copy of an exported `*_STATES` const.
      if (seenStateSets.has(stateSetKey(machine))) continue;
      seenRegistries.add(label);
      seenStateSets.add(stateSetKey(machine));
      machines.push({ machine, src, rel, initialState });
    }
  }
  return machines;
}

// ============================================================================
// Cross-domain orchestration graph (gen-2 Phase 1)
//
// Invariant #1 forces all cross-domain coordination through STRING-based
// `startChild('<name>Workflow', …)` and `getExternalWorkflowHandle(id).signal('name', …)`,
// so every choreography edge is statically resolvable. We resolve each edge's target
// domain three ways, in order: the registered workflow-name → domain map (startChild),
// the `buildWorkflowId(store, '<segment>', …)` segment of the handle's id, or the id
// variable's name. Intra-domain edges (same package) are dropped — this graph is the
// cross-domain picture; per-machine internals live in the sections above.
// ============================================================================

// '<segment>' in buildWorkflowId() → owning domain. Segment usually equals the
// domain directory name; OMS workflow IDs use the 'order' segment, and the fulfiller
// child workflows use 'fulfiller-order' but live in the fulfillment domain.
const SEGMENT_TO_DOMAIN = { order: 'oms', 'fulfiller-order': 'fulfillment' };
const segmentDomain = (seg) => SEGMENT_TO_DOMAIN[seg] || seg;

/** Best-effort domain from an id/workflow variable or name (fallback resolver). */
function domainFromName(name) {
  if (!name) return null;
  const l = name.toLowerCase();
  if (l.includes('checkout')) return 'checkout';
  if (l.includes('cart')) return 'cart';
  if (l.includes('fulfill') || l.includes('supplier')) return 'fulfillment';
  if (l.includes('oms') || l.includes('order')) return 'oms';
  if (l.includes('inventory')) return 'inventory';
  if (l.includes('identity') || l.includes('shopper') || l.includes('user')) return 'identity';
  return null;
}

/** Bare identifier/property name of a workflow-id expression. */
function idExprName(expr) {
  expr = unwrap(expr);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Find a local `const <name> = buildWorkflowId(store, '<seg>', …)` and return '<seg>'. */
function buildWorkflowIdSegment(sf, name) {
  let seg = null;
  const visit = (n) => {
    if (
      !seg &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isCallExpression(unwrap(n.initializer))
    ) {
      const call = unwrap(n.initializer);
      const callee = call.expression;
      const fn = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      if (fn === 'buildWorkflowId' && call.arguments[1]) {
        const a = unwrap(call.arguments[1]);
        if (ts.isStringLiteral(a)) seg = a.text;
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return seg;
}

/** Resolve the target domain a `getExternalWorkflowHandle(idExpr)` points at. */
function handleTargetDomain(idExpr, sf) {
  const name = idExprName(idExpr);
  if (!name) return null;
  const seg = ts.isIdentifier(unwrap(idExpr)) ? buildWorkflowIdSegment(sf, name) : null;
  return (seg && segmentDomain(seg)) || domainFromName(name);
}

/** Wire name for a signal argument: string literal, defineSignal const, or the identifier text. */
function signalName(arg, signalDefs) {
  arg = unwrap(arg);
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isIdentifier(arg)) return signalDefs.get(arg.text) || arg.text;
  return 'signal';
}

const calleeName = (call) => {
  const c = call.expression;
  return ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : '';
};

/** Map `const X = [wf.]defineSignal('wire')` identifiers → wire name, across all files. */
function buildSignalDefs(files) {
  const defs = new Map();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    if (!src.includes('defineSignal')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isCallExpression(unwrap(n.initializer)) &&
        calleeName(unwrap(n.initializer)) === 'defineSignal'
      ) {
        const a = unwrap(n.initializer).arguments[0];
        if (a && ts.isStringLiteral(a)) defs.set(n.name.text, a.text);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return defs;
}

/** Map registered workflow function name → owning domain, across all files. */
function buildWorkflowNameDomain(files) {
  const map = new Map();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    if (!/function\s+\w+Workflow\b/.test(src)) continue;
    const domain = domainOfRel(path.relative(ROOT, file));
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && /Workflow$/.test(n.name.text)) {
        if (!map.has(n.name.text)) map.set(n.name.text, domain);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return map;
}

/** Collect cross-domain choreography edges from every package source file. */
function collectCrossDomainEdges() {
  const files = sourceFiles(PACKAGES).filter((f) => {
    const src = fs.readFileSync(f, 'utf-8');
    return (
      src.includes('startChild') ||
      src.includes('getExternalWorkflowHandle') ||
      /\.workflow\.(start|execute|signalWithStart)\b/.test(src)
    );
  });
  const all = sourceFiles(PACKAGES);
  const signalDefs = buildSignalDefs(all);
  const workflowNameDomain = buildWorkflowNameDomain(all);
  const edges = [];
  const unresolved = [];

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    const from = domainOfRel(path.relative(ROOT, file));
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // handle-var → its getExternalWorkflowHandle(id) id-expression, file-wide.
    const handleVars = new Map();
    const collectHandles = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isCallExpression(unwrap(n.initializer)) &&
        calleeName(unwrap(n.initializer)) === 'getExternalWorkflowHandle'
      ) {
        handleVars.set(n.name.text, unwrap(n.initializer).arguments[0]);
      }
      n.forEachChild(collectHandles);
    };
    collectHandles(sf);

    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const fn = calleeName(n);
        // startChild('<name>Workflow' | fnRef, …) → parent/child edge
        if ((fn === 'startChild' || fn === 'executeChild') && n.arguments[0]) {
          const a = unwrap(n.arguments[0]);
          const name = ts.isStringLiteral(a) ? a.text : ts.isIdentifier(a) ? a.text : null;
          const to = name ? workflowNameDomain.get(name) || domainFromName(name) : null;
          if (to && to !== from) edges.push({ from, to, kind: 'startChild', label: name });
          else if (ts.isStringLiteral(a) && !to)
            unresolved.push(`${from}: startChild('${a.text}') → no known domain`);
        }
        // client.workflow.start|execute|signalWithStart('<name>Workflow', …) — an activity
        // launching another domain's workflow (e.g. checkout's submitOrder starts the OMS order).
        if (
          (fn === 'start' ||
            fn === 'execute' ||
            fn === 'signalWithStart' ||
            fn === 'executeWorkflow') &&
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isPropertyAccessExpression(n.expression.expression) &&
          n.expression.expression.name.text === 'workflow' &&
          n.arguments[0]
        ) {
          const a = unwrap(n.arguments[0]);
          const name = ts.isStringLiteral(a) ? a.text : ts.isIdentifier(a) ? a.text : null;
          const to = name ? workflowNameDomain.get(name) || domainFromName(name) : null;
          if (to && to !== from) edges.push({ from, to, kind: 'start', label: name });
        }
        // <handle>.signal(name, …) where <handle> = getExternalWorkflowHandle(id)
        if (fn === 'signal' && ts.isPropertyAccessExpression(n.expression)) {
          const recv = unwrap(n.expression.expression);
          let idExpr = null;
          if (ts.isIdentifier(recv) && handleVars.has(recv.text))
            idExpr = handleVars.get(recv.text);
          else if (ts.isCallExpression(recv) && calleeName(recv) === 'getExternalWorkflowHandle')
            idExpr = recv.arguments[0];
          if (idExpr) {
            const to = handleTargetDomain(idExpr, sf);
            if (to && to !== from)
              edges.push({
                from,
                to,
                kind: 'signal',
                label: signalName(n.arguments[0], signalDefs),
              });
            else if (!to)
              unresolved.push(
                `${from}: signal via getExternalWorkflowHandle(${idExprName(idExpr) ?? '?'}) → no known domain`,
              );
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return { edges, unresolved: [...new Set(unresolved)] };
}

/** Render the cross-domain choreography as a Mermaid flowchart. */
function crossDomainSection(edges) {
  if (edges.length === 0) return '';
  // Aggregate by (from, to, kind); join unique labels.
  const groups = new Map();
  for (const e of edges) {
    const key = `${e.from} ${e.to} ${e.kind}`;
    if (!groups.has(key)) groups.set(key, { ...e, labels: new Set() });
    groups.get(key).labels.add(e.label);
  }
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  const lines = ['```mermaid', 'flowchart LR'];
  for (const d of nodes) lines.push(`  ${d}[${d}]`);
  const rendered = [...groups.values()].sort((a, b) =>
    `${a.from}${a.to}${a.kind}`.localeCompare(`${b.from}${b.to}${b.kind}`),
  );
  for (const g of rendered) {
    const arrow = g.kind === 'signal' ? '-.->' : '-->';
    const prefix = g.kind === 'startChild' ? 'child' : g.kind === 'start' ? 'start' : 'signal';
    const label = `${prefix}: ${[...g.labels].sort().join(', ')}`;
    lines.push(`  ${g.from} ${arrow}|${label}| ${g.to}`);
  }
  lines.push('```');
  return (
    `## Cross-Domain Orchestration\n\n` +
    `How domains coordinate at runtime. Per invariant #1 there are **no** cross-domain workflow ` +
    `imports — domains start each other's workflows by string name (\`startChild\`, solid arrows) and ` +
    `signal each other through \`getExternalWorkflowHandle\` (dashed arrows). Generated from source; ` +
    `edge labels are the registered workflow names and signal wire-names.\n\n` +
    lines.join('\n')
  );
}

// ============================================================================
// Static appendix — update here when the accounting model / projections change
// ============================================================================

const PERSISTENCE_SECTION = `---

## Persistence and Projection

State-machine writes propagate to two stores: **Cassandra** (durable write store) and **Elasticsearch** (read/search projections). Both are driven exclusively from activities called in \`prepare\`/\`finalize\` phases or driver hooks (\`onTransition\`/\`onTerminal\`) — never from \`decide\`.

\`\`\`mermaid
flowchart LR
  WF["Temporal Workflow\\n(state machine)"]
  CA["Cassandra\\n(write store)"]
  ES["Elasticsearch\\n(read/search)"]
  WF -->|activities| CA
  WF -->|activities| ES
\`\`\`

### Key Projections

| Domain | Store | Trigger |
|--------|-------|---------|
| **Cart** | ES \`carts\` | Every transition — \`indexCart\` from the \`onTransition\` hook |
| **Checkout** | Cassandra \`orders\` + ES \`orders\` | \`submitOrder\` pipeline — \`createOrder\`, then OMS startup indexes |
| **OMS** | Cassandra \`orders\`, \`order_status_history\` | Startup pipeline + every status change (\`updateOrderInDatabase\`, \`insertStatusHistoryEntry\`) |
| **OMS** | ES \`orders\`, \`fulfiller_orders\`, \`customers\` | \`onStart\` + every transition (\`indexOrder\`, \`indexFulfillerOrder\`, \`indexCustomer\`) |
| **Fulfillment** | ES \`fulfillments\`, \`shipments\` | \`onTransition\`/finalize — \`indexFulfillment\`, \`indexShipment\` |
| **Inventory** | Cassandra read tables + ES \`inventory\` | Signal-driven targeted projections in \`inventoryServiceWorkflow\` (CQRS) |
| **Communications** | Cassandra \`customer_communications\` + ES \`communications\` | Every \`sendEmail()\` call — best-effort write-through from the send choke point |

### State-Transition Audit (ADR-0010)

Independently of the domain projections above, the framework records **every state-machine transition** to the Cassandra \`workflow_state_transitions\` table — from/to state, trigger + payload, a full context snapshot, and the captured \`prepare\`/\`finalize\` activity calls — via an async in-workflow recorder (off the hot path, 90-day TTL). The [order-trace dev tool](http://localhost:3000/dev/order-trace) reads this to show per-transition state diffs across a whole order journey. Alongside it, projections are **lifecycle-stamped**: workflow-owned ES docs gain \`workflowStatus\`/\`workflowOutcome\`/\`workflowClosedAt\` when their workflow closes, and \`fulfiller_orders\` docs are stamped at terminal fulfiller-order status — powering the admin Explorer's live/completed filter.

> Cassandra UUIDs must always be passed as \`types.Uuid.fromString(id)\` — raw strings cause silent zero-row returns.
`;

// ============================================================================
// Main
// ============================================================================

function buildDocument() {
  const machines = collectMachines();
  const header =
    `<!-- AUTO-GENERATED by scripts/generate-state-diagrams.mjs\n` +
    `     Run \`npm run docs:diagrams\` to regenerate. Do not edit manually.\n` +
    `     Prose descriptions are extracted from JSDoc comments in the source files.\n` +
    `     The "Persistence and Projection" section is maintained in the generator script. -->\n\n` +
    `# State Machine Reference\n\n` +
    `Reference for every domain state machine in \`temporal-commerce-demo\`. ` +
    `Regenerated from source by \`npm run docs:diagrams\`.\n\n` +
    `> **Trigger kinds** — \`update:\` (Temporal Update, synchronous), \`signal\` (fire-and-forget Signal), \`timeout\` (wall-clock deadline), *(auto)* (transitional state, no input). ` +
    `Self-loops (event processed but state stays the same) are shown as looping arcs on the state. ` +
    `The auto-vs-timeout distinction is recorded, not just displayed: transitional advancement is persisted to \`workflow_state_transitions\` as trigger kind \`automatic\` (PR #45). ` +
    `Notes show \`prepare:\` activities (I/O), \`if:\` conditions tested in \`decide\`, and \`finalize:\` activities (side-effects).\n\n`;
  const { edges: crossEdges, unresolved: crossUnresolved } = collectCrossDomainEdges();
  const crossDomain = crossDomainSection(crossEdges);
  const sections = machines.map((m) => generateSection(m.machine, m.src, m.rel, m.initialState));
  const doc =
    header +
    (crossDomain ? crossDomain + '\n\n---\n\n' : '') +
    sections.join('\n\n---\n\n') +
    '\n\n' +
    PERSISTENCE_SECTION;
  return { doc, machines, crossEdges, crossUnresolved };
}

/**
 * Machine-readable companion to the Markdown (gen-2 Phase 2). Same data, as a
 * versioned, stable-ordered JSON graph that tooling, tests, drift-checks, and agents
 * can consume — "no orphan states", "this `next` target exists", "every state is tested"
 * become queryable instead of eyeballed. Regenerated and `--check`-gated like the doc.
 */
function buildGraph(machines, crossEdges) {
  return {
    // v2 (ADR-0024): machines gain a unique `id` (the registry name — `domain` names the
    // owning package and is NOT unique when a package owns two machines), states may carry
    // `commands` (the decider-native surface's accepted inputs, with guard/prepare info),
    // and transition `kind` may be 'event' (routed on an emitted event, not a transport).
    schemaVersion: 3,
    generator: 'scripts/generate-state-diagrams.mjs',
    machines: machines.map(({ machine, rel, initialState }) => {
      const terminals = new Set();
      const states = machine.states.map((s) => {
        const seen = new Set();
        const transitions = [];
        for (const e of s.edges) {
          if (e.to.startsWith('__terminal:')) terminals.add(e.to.slice('__terminal:'.length));
          const key = `${e.on}->${e.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          transitions.push({
            on: e.on,
            kind: e.kind,
            to: e.to,
            ...(e.conditions && e.conditions.length ? { conditions: e.conditions } : {}),
            ...(e.prepareActivities && e.prepareActivities.length
              ? { prepareActivities: e.prepareActivities }
              : {}),
            ...(e.finalizeActivities && e.finalizeActivities.length
              ? { finalizeActivities: e.finalizeActivities }
              : {}),
            ...(e.signalKinds && e.signalKinds.length ? { signalKinds: e.signalKinds } : {}),
          });
        }
        return {
          name: s.name,
          ...(s.doc ? { doc: s.doc } : {}),
          ...(s.timeout ? { timeout: s.timeout } : {}),
          ...(s.commands && s.commands.length ? { commands: s.commands } : {}),
          transitional: !!s.transitional,
          hasPrepare: s.edges.some((e) => e.prepareActivities && e.prepareActivities.length > 0),
          hasFinalize: s.edges.some((e) => e.finalizeActivities && e.finalizeActivities.length > 0),
          transitions,
        };
      });
      return {
        id: machine.registry,
        domain: domainOfRel(rel),
        registry: machine.registry,
        source: rel,
        initialState,
        terminals: [...terminals].sort(),
        states,
      };
    }),
    crossDomain: [
      ...new Map(
        crossEdges.map((e) => [
          `${e.from}|${e.to}|${e.kind}|${e.label}`,
          { from: e.from, to: e.to, kind: e.kind, label: e.label },
        ]),
      ).values(),
    ].sort((a, b) =>
      `${a.from}|${a.to}|${a.kind}|${a.label}`.localeCompare(
        `${b.from}|${b.to}|${b.kind}|${b.label}`,
      ),
    ),
  };
}

function strictCheck(machines) {
  const problems = [];
  for (const { machine } of machines) {
    for (const s of machine.states) {
      const outgoing = s.edges.filter((e) => e.to !== s.name);
      if (!s.transitional && outgoing.length === 0) {
        problems.push(`${machine.registry}.${s.name} has no outgoing transitions`);
      }
    }
  }
  return problems;
}

// ============================================================================
// Phantom-edge detection (gen-2 Phase 4.5)
//
// Flags the bug class the SELF sentinel was introduced to prevent: a decide-helper
// that UNCONDITIONALLY returns a single literal (non-terminal) state name, is shared
// by 2+ states with differing self, AND whose hardcoded target equals the self of one
// of those callers — so from the OTHER caller(s) the generator emits a transition that
// cannot happen. The fix is always `next: SELF`. Correctly NOT flagged: data-driven
// mappers with multiple returns (e.g. nextForStatus), helpers returning a terminal
// (cancelDecision), and shared transitions to a common peer that is not a caller's self.
// ============================================================================

/** All local-function names invoked anywhere within a node's subtree. */
function calledLocalFns(node, decls, out = new Set()) {
  if (!node) return out;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && decls.has(n.expression.text)) {
      out.add(n.expression.text);
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

/**
 * Local helpers reachable from a state's handlers — directly, and one level through a
 * spread factory (`...itemEditEntries()`) or an identifier-referenced handler const.
 */
function helpersForStateCall(call, decls) {
  const out = new Set();
  for (let i = 1; i < call.arguments.length; i++) {
    const arg = unwrap(call.arguments[i]);
    if (!arg) continue;
    calledLocalFns(arg, decls, out);
    if (ts.isObjectLiteralExpression(arg)) {
      for (const p of arg.properties) {
        if (ts.isSpreadAssignment(p)) {
          const e = unwrap(p.expression);
          const fnName =
            ts.isCallExpression(e) && ts.isIdentifier(e.expression)
              ? e.expression.text
              : ts.isIdentifier(e)
                ? e.text
                : null;
          if (fnName) {
            const body = bodyOf(decls.get(fnName));
            if (body) calledLocalFns(body, decls, out);
            const init = unwrap(decls.get(fnName)?.init);
            if (init) calledLocalFns(init, decls, out);
          }
        } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(unwrap(p.initializer))) {
          const init = unwrap(decls.get(unwrap(p.initializer).text)?.init);
          if (init) calledLocalFns(init, decls, out);
        }
      }
    }
  }
  return out;
}

/**
 * If a function unconditionally returns a single object literal whose `next` is a
 * string-literal non-terminal state, return that state name; else null. Handles block
 * bodies (exactly one return statement) and arrow expression bodies.
 */
function unconditionalLiteralNext(decl, decls) {
  const body = bodyOf(decl);
  if (!body) return null;
  let retExpr = null;
  if (ts.isBlock(body)) {
    const returns = [];
    const visit = (n) => {
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
      if (
        n !== body &&
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
      )
        return;
      n.forEachChild(visit);
    };
    visit(body);
    if (returns.length !== 1) return null;
    retExpr = returns[0];
  } else {
    retExpr = body;
  }
  const obj = resolveToObj(retExpr, decls);
  if (!obj) return null;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === 'next') {
      const v = unwrap(p.initializer);
      if (ts.isStringLiteral(v) && !v.text.startsWith('__terminal:')) return v.text;
    }
  }
  return null;
}

/** Detect phantom-prone shared "stay" helpers across all machine source files. */
function phantomEdgeProblems() {
  const problems = [];
  const files = sourceFiles(PACKAGES).filter((f) =>
    /_STATES\b|runStateMachine/.test(fs.readFileSync(f, 'utf-8')),
  );
  for (const file of files.sort()) {
    const src = fs.readFileSync(file, 'utf-8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const decls = topLevelDecls(sf);
    const usage = new Map(); // helperName -> Set<self state>
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if (
          (method === 'transitions' || method === 'route' || method === 'state') &&
          n.arguments[0]
        ) {
          const self = evalTarget(n.arguments[0], decls);
          if (self && !self.startsWith('__terminal:')) {
            for (const h of helpersForStateCall(n, decls)) {
              if (!usage.has(h)) usage.set(h, new Set());
              usage.get(h).add(self);
            }
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
    for (const [helper, selfs] of usage) {
      if (selfs.size < 2) continue;
      const s = unconditionalLiteralNext(decls.get(helper), decls);
      if (s && selfs.has(s)) {
        problems.push(
          `${path.relative(ROOT, file)}: shared decide-helper '${helper}' (used by states ` +
            `{${[...selfs].sort().join(', ')}}) unconditionally returns literal next: '${s}' — a self-loop ` +
            `in '${s}' but a phantom edge from the other state(s). Return SELF instead of naming the state.`,
        );
      }
    }
  }
  return problems;
}

function run() {
  const { doc, machines, crossEdges, crossUnresolved } = buildDocument();
  const json = JSON.stringify(buildGraph(machines, crossEdges), null, 2) + '\n';

  if (STRICT) {
    const problems = strictCheck(machines);
    if (problems.length > 0) {
      console.error(
        '✗ --strict: states with no extracted transitions:\n  ' + problems.join('\n  '),
      );
      process.exit(1);
    }
    if (crossUnresolved && crossUnresolved.length > 0) {
      console.error(
        '✗ --strict: cross-domain targets that resolve to no known domain:\n  ' +
          crossUnresolved.join('\n  '),
      );
      process.exit(1);
    }
    const phantom = phantomEdgeProblems();
    if (phantom.length > 0) {
      console.error(
        '✗ --strict: phantom-prone shared decide-helpers (hardcode a peer state instead of SELF):\n  ' +
          phantom.join('\n  '),
      );
      process.exit(1);
    }
  }

  if (CHECK) {
    const stale = [];
    if ((fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '') !== doc)
      stale.push('state-machine-diagrams.md');
    if ((fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf-8') : '') !== json)
      stale.push('state-graph.json');
    if (stale.length > 0) {
      console.error(
        `✗ --check: ${stale.join(' and ')} out of date. Run \`npm run docs:diagrams\`.`,
      );
      process.exit(1);
    }
    console.log('✓ --check: diagrams and state-graph.json are up to date.');
    return;
  }

  fs.writeFileSync(OUT, doc);
  fs.writeFileSync(OUT_JSON, json);
  console.log(
    `✓ Generated ${machines.length} state machine section(s) → ${path.relative(ROOT, OUT)}` +
      ` + ${path.relative(ROOT, OUT_JSON)}`,
  );
}

run();
