/**
 * Peers: more users in one test, each with an app of its own. These run the
 * built runner end to end on fixture projects.
 */

import { describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { listProject, runProject } from '../helpers/run-project.ts';

/** A web-like target and a second one a peer can run on, each with a fake engine that saves state. */
const TARGETS = [
  { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
  { name: 'phone', platform: 'phone', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
];
const AGENTS = { default: {}, buyer: {}, ava: { context: 'You are Ava.' } };

describe('peers', () => {
  it('lists each pair peers with the target each runs on and the agent each runs as', async () => {
    const files = {
      'tests/auth.setup.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member', 'ava'] }, async () => {});
`,
      'tests/pay.e2e.ts': `import { test } from 'e2e';
test('pays', { platforms: ['fake'], session: 'member', peers: { ava: { target: 'phone', session: 'ava', agent: 'ava' }, bob: {} }, agent: ['buyer', 'ava'] }, async () => {});
test('alone', { platforms: ['fake'] }, async () => {});
`,
    };
    const { pairs, project } = await listProject(files, { config: { targets: TARGETS, agents: AGENTS } });
    try {
      const pays = pairs.filter((pair) => pair.title === 'pays' && pair.target === 'fake');
      expect(pays.map((pair) => [pair.agent, pair.peers])).toEqual([
        ['buyer', [{ name: 'ava', target: 'phone', session: 'ava', agent: 'ava' }, { name: 'bob', target: 'fake', session: undefined, agent: 'buyer' }]],
        ['ava', [{ name: 'ava', target: 'phone', session: 'ava', agent: 'ava' }, { name: 'bob', target: 'fake', session: undefined, agent: 'ava' }]],
      ]);
      expect(pairs.find((pair) => pair.title === 'alone')).not.toHaveProperty('peers');
      // The setup that saves Ava's session runs on her target as well as the test's own.
      expect(pairs.filter((pair) => pair.kind === 'setup' && pair.disposition === 'run').map((pair) => pair.target).toSorted()).toEqual(['fake', 'phone']);
    } finally {
      project.cleanup();
    }
  });

  it('refuses, before anything starts, a run of a test with peers while this build cannot open their apps', async () => {
    const { outcome, project } = await runProject(
      {
        'tests/pay.e2e.ts': `import { test } from 'e2e';
test('pays', { peers: { ava: {} } }, async () => {});
`,
      },
      { config: { targets: TARGETS.slice(0, 1) } },
    );
    try {
      expect(outcome.results).toEqual([]);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.message])).toEqual([
        ['UNSUPPORTED_CAPABILITY', 'collection', 'test "pays" in tests/pay.e2e.ts declares peers, which this build collects but cannot run yet'],
      ]);
    } finally {
      project.cleanup();
    }
  });
});
