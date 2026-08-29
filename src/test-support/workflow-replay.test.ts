import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from '@temporalio/worker';
// Default import: the package is CommonJS and its named exports are not statically
// analyzable, so a named ESM import fails at runtime under Node's interop.
import proto from '@temporalio/proto';
import { describe, expect, it } from 'vitest';
import { REPLAY_REGISTRY, historiesDir } from './replay-registry';

/**
 * Replays captured histories against the current workflow code, for every registered domain
 * (ported from nightheron-mono's @nightheron/test-support).
 *
 * This is the evolvability gate. Every other test starts a *fresh* execution, so all of them
 * keep passing when workflow code changes incompatibly — the change that breaks every in-flight
 * execution is precisely the one no fresh execution can detect. Replay runs the current code
 * against histories produced by the *previous* code, which is exactly what a worker does to a
 * running workflow after a deploy.
 *
 * When this test fails and the workflow change was *intentional*, the fix is a `patched()`
 * branch (or a new worker deployment version), not a fixture refresh. Regenerate fixtures only
 * once no history produced by the old code can still be running:
 *
 *     npm run histories:capture
 *
 * The fixtures are protobufjs `toObject` output, not proto3 JSON — `History.fromObject` is the
 * only correct reader.
 */
describe('workflow replay', () => {
  for (const spec of REPLAY_REGISTRY) {
    const hDir = historiesDir(spec);

    it(`replays every captured ${spec.domain} history without a determinism violation`, async () => {
      // A registered domain without a __histories__ directory is a configuration error, not a
      // passing test.
      await access(hDir).catch(() => {
        throw new Error(
          `No __histories__/ directory found for domain "${spec.domain}" at ${hDir}. ` +
            `Run: npm run histories:capture`,
        );
      });

      const files = (await readdir(hDir)).filter((f) => f.endsWith('.json')).sort();
      // A domain with no fixtures would make this gate pass vacuously; fail loudly instead.
      expect(files.length).toBeGreaterThan(0);

      const histories = await Promise.all(
        files.map(async (file) => ({
          workflowId: `${spec.domain}/${file.replace(/\.json$/, '')}`,
          history: proto.temporal.api.history.v1.History.fromObject(
            JSON.parse(await readFile(path.join(hDir, file), 'utf8')),
          ),
        })),
      );

      // One batch call per domain: the replayer bundles the workflow code once for all of its
      // histories, where per-history calls would rebuild the bundle each time.
      const results = Worker.runReplayHistories({ workflowsPath: spec.workflowsPath }, histories);

      const failures: string[] = [];
      for await (const result of results) {
        if (result.error) failures.push(`${result.workflowId}: ${result.error.message}`);
      }

      expect(failures).toEqual([]);
    }, 120_000);
  }
});
