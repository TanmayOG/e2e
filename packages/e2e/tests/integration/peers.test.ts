/**
 * Peers: more users in one test, each with an app of its own. These run the
 * built runner end to end on fixture projects: the web cases on a real
 * Chromium through child workers, which load the config a second time for
 * a peer's engine, and the lifecycle cases on the fake engine.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { listProject, resultByTitle, runProject, runProjectWithConfigFile, workerConfigSource, type RunOutcome } from '../helpers/run-project.ts';

/** A web-like target and a second one a peer can run on, each with a fake engine that saves state. */
const TARGETS = [
  { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
  { name: 'phone', platform: 'phone', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
];
const AGENTS = { default: {}, buyer: {}, ava: { context: 'You are Ava.' } };
/** The built engine API by file URL, which a package in a fixture project can import without resolving `e2e`. */
const BUILT_ENGINE_API = pathToFileURL(path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'dist', 'engine', 'index.js')).href;

/** The only result's first attempt, with the run errors for a readable failure. */
function onlyAttempt(outcome: RunOutcome, title: string) {
  const result = resultByTitle(outcome, title);
  return { result, attempt: result.attempts[0]!, why: JSON.stringify({ errors: result.attempts.map((attempt) => attempt.error), run: outcome.report.run.errors }) };
}

describe('peers: declared and listed', () => {
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

  it('refuses, before anything starts, a run of a test whose peer is on another target, which this build cannot open yet', async () => {
    const { outcome, project } = await runProject(
      {
        'tests/pay.e2e.ts': `import { test } from 'e2e';
test('pays', { platforms: ['fake'], peers: { ava: { target: 'phone' } } }, async () => {});
`,
      },
      { config: { targets: TARGETS } },
    );
    try {
      expect(outcome.results).toEqual([]);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.message])).toEqual([
        ['UNSUPPORTED_CAPABILITY', 'collection', 'test "pays" in tests/pay.e2e.ts runs peer "ava" on target "phone"; this build runs a peer on the test\'s own target only'],
      ]);
    } finally {
      project.cleanup();
    }
  });
});

describe('peers on one web target', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const run = (files: Readonly<Record<string, string>>, extra = '') =>
    runProjectWithConfigFile(files, { appUrl: app.url, configSource: workerConfigSource(1, extra) });

  it('gives each user an app of its own: what one adds on the server the other sees, and their browser state stays apart', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('pair', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/todos');
  await screen.getByLabel('New todo').fill('Oat milk');
  await screen.getByRole('button', 'Add').tap();
  await expect(screen.getByRole('status', 'Result')).toHaveText('added');
  await peers.ava.app.open('/todos');
  await expect(peers.ava.screen.getByText('Oat milk')).toBeVisible();

  await peers.ava.app.open('/storage');
  await peers.ava.screen.getByRole('button', 'Save marker').tap();
  await expect(peers.ava.screen.getByRole('status', 'Marker')).toHaveText('saved');
  await app.open('/storage');
  await expect(screen.getByRole('status', 'Marker')).toHaveText('empty');

  // Each user has its engine's own fixtures, on its own page.
  await expect(peers.ava.browser).toHaveURL('/storage');
  expect(peers.ava.platform).toBe('web');
  expect(Object.keys(peers)).toEqual(['ava']);
  let refused = '';
  try {
    void peers.bob;
  } catch (error) {
    refused = (error as Error).message;
  }
  if (!refused.startsWith('the test declares no peer "bob"; it declares "ava"')) throw new Error('an undeclared peer gave: ' + refused);
  // Probing the map as a promise does, or as an inspector does, is not asking for a peer.
  if ((await Promise.resolve(peers)) !== peers) throw new Error('awaiting the peers changed them');
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('restores each user its own saved session', async () => {
    const { outcome, project } = await run({
      'tests/auth.setup.e2e.ts': `import { test, expect } from 'e2e';
test.setup('sign in both', { sessions: ['member', 'ava'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await session.save('ava');
  await screen.getByRole('button', 'Save marker').tap();
  await expect(screen.getByRole('status', 'Marker')).toHaveText('saved');
  await session.save('member');
});
`,
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('signed in', { session: 'member', peers: { ava: { session: 'ava' }, guest: {} } }, async ({ app, screen, peers }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', 'Marker')).toHaveText('saved');
  await peers.ava.app.open('/storage');
  await expect(peers.ava.screen.getByRole('status', 'Marker')).toHaveText('empty');
  await peers.guest.app.open('/storage');
  await expect(peers.guest.screen.getByRole('status', 'Marker')).toHaveText('empty');
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'signed in');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('hands peers to beforeEach, afterEach, and test.extend fixtures, and runs both users at once', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test as base, expect } from 'e2e';
const test = base.extend<{ avaOnTodos: string }>({
  avaOnTodos: async ({ peers }, use) => {
    await peers.ava.app.open('/todos');
    await use('ready');
    await peers.ava.app.open('/storage');
  },
});
test.beforeEach(async ({ peers }) => {
  await expect(peers.ava.screen.getByRole('heading', 'Todos')).toBeVisible();
});
test.afterEach(async ({ peers }) => {
  await expect(peers.ava.screen.getByRole('heading', 'About')).toBeVisible();
});
test('together', { peers: { ava: {} } }, async ({ app, screen, peers, avaOnTodos }) => {
  expect(avaOnTodos).toBe('ready');
  await Promise.all([app.open('/storage'), peers.ava.app.open('/about')]);
  await Promise.all([
    expect(screen.getByRole('heading', 'Storage')).toBeVisible(),
    expect(peers.ava.screen.getByRole('heading', 'About')).toBeVisible(),
  ]);
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'together');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('fails the test on a failing peer check, and keeps each user evidence in its own folder', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('peer fails', { peers: { ava: {} } }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await expect(peers.ava.screen.getByRole('heading', 'Nowhere')).toBeVisible({ timeout: 500 });
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'peer fails');
      expect(result.status, why).toBe('failed');
      expect(attempt.error?.code).toBe('ASSERTION_FAILED');
      const paths = attempt.artifacts.map((artifact) => artifact.path ?? '');
      expect(paths.some((file) => file.endsWith('/screen-at-failure.txt') && !file.includes('/peers/'))).toBe(true);
      const peerScreen = paths.find((file) => file.endsWith('/peers/ava/screen-at-failure.txt'));
      expect(peerScreen, JSON.stringify(paths)).toBeDefined();
      expect(readFileSync(path.join(project.dir, '.e2e', 'results', ...peerScreen!.split('/')), 'utf8')).toContain('About');
    } finally {
      project.cleanup();
    }
  });

  it('records a video for each user, in each user folder', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test } from 'e2e';
test('filmed', { peers: { ava: {} }, video: 'on' }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'filmed');
      expect(result.status, why).toBe('passed');
      const videos = attempt.artifacts.filter((artifact) => artifact.kind === 'video').map((artifact) => artifact.path ?? '');
      expect(videos.filter((file) => !file.includes('/peers/')), JSON.stringify(videos)).toHaveLength(1);
      expect(videos.filter((file) => file.includes('/peers/ava/video/')), JSON.stringify(videos)).toHaveLength(1);
      for (const file of videos) expect(existsSync(path.join(project.dir, '.e2e', 'results', ...file.split('/')))).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('runs each user agent steps as its own agent, with its own context and memory, on its own screen', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { writeFileSync } from 'node:fs';
test('agents', { agentContext: 'Test user context.', peers: { ava: { agent: 'ava', agentContext: 'Peer context.' }, bob: {} } }, async ({ app, agent, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await peers.bob.app.open('/todos');
  const read = async (who: typeof agent) => JSON.parse((await who.act('report')).summary);
  const seen = { mine: await read(agent), hers: await read(peers.ava.agent), hersAgain: await read(peers.ava.agent), bobs: await read(peers.bob.agent) };
  writeFileSync(new URL('../agents.json', import.meta.url), JSON.stringify(seen));
});
`,
      },
      {
        appUrl: app.url,
        configSource: `import type { E2EConfig, StepExecutor } from 'e2e';
import { web } from '@e2e-dev/web';

// Reports what the step met: the agent's context, a count kept in its memory, and the pages its screen shows.
const report: StepExecutor = {
  name: 'report',
  version: '1',
  cache: 'off',
  async runStep(ctx) {
    const count = ((ctx.attempt.memory.get('count') as number | undefined) ?? 0) + 1;
    ctx.attempt.memory.set('count', count);
    const screen = await ctx.observe();
    const sees = ['Storage', 'About', 'Todos'].filter((page) => screen.text.includes(page));
    return { status: 'passed', summary: JSON.stringify({ context: ctx.agentContext, count, sees }) };
  },
};

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  agents: { default: { executor: report, context: 'Default agent.' }, ava: { executor: report, context: 'Ava agent.' } },
} satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'agents');
      expect(result.status, why).toBe('passed');
      const seen = JSON.parse(readFileSync(path.join(project.dir, 'agents.json'), 'utf8'));
      expect(seen.mine).toEqual({ context: 'Default agent.\nTest user context.', count: 1, sees: ['Storage'] });
      expect(seen.hers).toEqual({ context: 'Ava agent.\nPeer context.', count: 1, sees: ['About'] });
      expect(seen.hersAgain.count).toBe(2);
      expect(seen.bobs).toEqual({ context: 'Default agent.', count: 1, sees: ['Todos'] });
    } finally {
      project.cleanup();
    }
  });

  it('redacts a secret one user typed from what the other user reads of the screen', async () => {
    const TOKEN = 'synthetic-peer-token-2718';
    const { outcome, project } = await run(
      {
        'tests/pair.e2e.ts': `import { test, expect, secrets } from 'e2e';
test('shares a token', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/todos');
  await screen.getByLabel('New todo').fill(secrets.get('token'));
  await screen.getByRole('button', 'Add').tap();
  await expect(screen.getByRole('status', 'Result')).toHaveText('added');
  await peers.ava.app.open('/todos');
  // Ava's page shows the token, but what her agent reads of it never does.
  await expect(peers.ava.screen.getByRole('list', 'Todos')).toContainText('2718');
  const tree = await peers.ava.screen.tree();
  if (tree.includes('${TOKEN}')) throw new Error('the token reached the peer screen read');
});
`,
      },
      `\n  secrets: { token: () => '${TOKEN}' },`,
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'shares a token');
      expect(result.status, why).toBe('passed');
      expect(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')).not.toContain(TOKEN);
    } finally {
      project.cleanup();
    }
  });
});

/**
 * A worker-path config on the fake engine whose every load numbers itself:
 * the runner's and the worker's own loads come first, so a peer's engine is
 * a later number. Each engine logs its lifecycle to `events.log`.
 */
function lifecycleConfig(behavior: string): string {
  return `import type { E2EConfig } from 'e2e';
import { appendFileSync } from 'node:fs';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const g = globalThis as { __peerLoads?: number };
const id = (g.__peerLoads = (g.__peerLoads ?? 0) + 1);
const log = (event: string) => appendFileSync(new URL('./events.log', import.meta.url), process.pid + ':' + id + ' ' + event + '\\n');
const engine = createFakeEngine({
  onInit: () => { log('init'); ${behavior.includes('boot') ? "if (id > 1) throw new Error('the peer engine would not boot');" : ''} },
  onStartAttempt: () => { log('start'); ${behavior.includes('start') ? "if (id > 1) throw new Error('the peer app would not open');" : ''} },
  onEndAttempt: () => { log('end'); ${behavior.includes('end') ? "if (id > 1) throw new Error('the peer app would not close');" : ''} },
  ${behavior.includes('settle') ? "onSettleAttempt: () => { if (id > 1) throw new Error('the peer app failed after its last step'); }," : ''}
  onDispose: () => { log('dispose'); ${behavior.includes('dispose') ? "if (id > 1) throw new Error('the peer engine would not shut down');" : ''} },
}).engine;

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
} satisfies E2EConfig;
`;
}

/** The lifecycle lines of the worker that ran the tests, with its first engine as `test` and later ones as `peer`. */
function workerEvents(projectDir: string): string[] {
  const lines = readFileSync(path.join(projectDir, 'events.log'), 'utf8').trim().split('\n');
  const worker = lines.find((line) => line.endsWith(' start'))?.split(':')[0];
  const own = lines.filter((line) => line.startsWith(`${worker}:`)).map((line) => line.slice(line.indexOf(':') + 1));
  const first = Math.min(...own.map((line) => Number(line.split(' ')[0])));
  return own.map((line) => {
    const [id, event] = line.split(' ');
    return `${Number(id) === first ? 'test' : 'peer'} ${event}`;
  });
}

describe('peers: engines and lifecycle', () => {
  it('runs a peer on an engine of its own, opened before the body and closed with the test, then disposed with the worker', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('unused peer', { peers: { ava: {} } }, async () => {});
test('second', { peers: { ava: {} } }, async () => {});
`,
      },
      { configSource: lifecycleConfig('') },
    );
    try {
      expect(onlyAttempt(outcome, 'unused peer').result.status).toBe('passed');
      expect(workerEvents(project.dir)).toEqual([
        'test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end',
        'test start', 'peer start', 'peer end', 'test end',
        'peer dispose', 'test dispose',
      ]);
    } finally {
      project.cleanup();
    }
  });

  it('fails the launch when a peer app cannot open, and closes the test app too', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('start') },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'ENGINE_FAILURE', phase: 'launch' });
      expect(attempt.error?.message).toContain('the peer app would not open');
      expect(workerEvents(project.dir)).toEqual(['test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end', 'peer dispose', 'test dispose']);
    } finally {
      project.cleanup();
    }
  });

  it('keeps a peer engine boot failure for every later test on the worker, as for the test own engine', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('first', { peers: { ava: {} } }, async () => {});
test('second', { peers: { ava: {} } }, async () => {});
`,
      },
      { configSource: lifecycleConfig('boot') },
    );
    try {
      for (const title of ['first', 'second']) {
        const { result, attempt, why } = onlyAttempt(outcome, title);
        expect(result.status, why).toBe('failed');
        expect(attempt.error?.message).toContain('the peer engine would not boot');
      }
      expect(workerEvents(project.dir).filter((event) => event === 'peer init')).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });

  it('fails the test with a failure a peer app reports after its last step', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('settle') },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error?.message).toContain('the peer app failed after its last step');
    } finally {
      project.cleanup();
    }
  });

  it('gives a peer its own instance of an engine made in a project file the config imports', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'engines.ts': `import { createFakeEngine } from '../../helpers/fake-engine.ts';\nexport const engine = createFakeEngine().engine;\n`,
        'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { FAKE_APP } from '../../helpers/fake-engine.ts';
import { engine } from './engines.ts';
export default { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }], workers: 1 } satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('marks the attempt cleanup failed when a peer app cannot close', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('end') },
    );
    try {
      const { attempt, why } = onlyAttempt(outcome, 'pair');
      expect(attempt.cleanup, why).toBe('failed');
      expect(attempt.secondaryErrors.map((error) => error.message).join('\n')).toContain('the peer app would not close');
    } finally {
      project.cleanup();
    }
  });

  it('reports a peer engine that cannot shut down as a run error', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('dispose') },
    );
    try {
      expect(onlyAttempt(outcome, 'pair').result.status).toBe('passed');
      expect(outcome.report.run.errors.map((error) => error.message).join('\n')).toContain('the peer engine would not shut down');
    } finally {
      project.cleanup();
    }
  });

  it('opens fresh apps for both users on every retry', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { existsSync, writeFileSync } from 'node:fs';
const flag = new URL('../first-try', import.meta.url);
test('flaky', { peers: { ava: {} }, retries: 1 }, async () => {
  if (!existsSync(flag)) {
    writeFileSync(flag, '');
    throw new Error('first try fails');
  }
});
`,
      },
      { configSource: lifecycleConfig('') },
    );
    try {
      const result = resultByTitle(outcome, 'flaky');
      expect(result.status).toBe('flaky');
      expect(workerEvents(project.dir).filter((event) => event.endsWith(' start'))).toEqual(['test start', 'peer start', 'test start', 'peer start']);
    } finally {
      project.cleanup();
    }
  });

  it('refuses a peer whose target engine comes from a package, the one instance every load shares', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'node_modules/shared-engine/package.json': JSON.stringify({ name: 'shared-engine', type: 'module', exports: './index.js' }),
        'node_modules/shared-engine/index.js': `import { defineEngine } from '${BUILT_ENGINE_API}';
export const engine = defineEngine({ name: 'shared', version: '1.0.0', spiVersion: 1 });
`,
        'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { engine } from 'shared-engine';
export default { targets: [{ name: 'shared', platform: 'shared', engine, app: { url: 'http://127.0.0.1:4599' } }], workers: 1 } satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'INVALID_CONFIG', phase: 'launch' });
      expect(attempt.error?.message).toContain('whose engine is the same instance in every load of the config');
    } finally {
      project.cleanup();
    }
  });

  it('refuses peers in a run that loaded no config file, which has nowhere to load a second engine from', async () => {
    const { outcome, project } = await runProject(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { config: { targets: TARGETS.slice(0, 1) } },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', phase: 'launch' });
      expect(attempt.error?.message).toContain('declares peers, which need a run from a config file');
    } finally {
      project.cleanup();
    }
  });
});
