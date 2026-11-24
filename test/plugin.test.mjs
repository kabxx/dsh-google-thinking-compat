import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, resolveInstallAnchor } from '../src/index.js';
import {
  buildGoogleThinkingStreamOptions,
  findMissingUpstreamLevels,
  installPiAiThinkingPatch,
  rewriteGoogleThinkingPayload,
  shouldInterceptGoogleThinking,
} from '../src/pi-ai-thinking.js';
import {
  SETTINGS_MODELS_PACKAGE_ID,
  installSettingsUiPatch,
  patchSettingsModelsSource,
} from '../src/settings-ui.js';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const SAMPLE_MINIFIED_SETTINGS_BUNDLE = [
  'const GEMINI_LEVELS=["minimal","low","medium","high"];',
  'const LOCALES={',
  'en:{modelReasoningLevelsOnly:"This API protocol accepts only the minimal, low, medium, and high levels."},',
  'zh:{modelReasoningLevelsOnly:"此 API 协议仅接受 minimal、low、medium 和 high 档位。"},',
  'ja:{modelReasoningLevelsOnly:"minimal、low、medium、high のみ"},',
  'es:{modelReasoningLevelsOnly:"niveles minimal, low, medium y high"},',
  'fr:{modelReasoningLevelsOnly:"niveaux minimal, low, medium et high"},',
  'de:{modelReasoningLevelsOnly:"Stufen minimal, low, medium und high"},',
  'ru:{modelReasoningLevelsOnly:"уровни minimal, low, medium и high"},',
  'pt:{modelReasoningLevelsOnly:"níveis minimal, low, medium e high"}',
  '};',
].join('\n');

test('patchSettingsModelsSource adds xhigh and max and updates all 8 locales', () => {
  const res = patchSettingsModelsSource(SAMPLE_MINIFIED_SETTINGS_BUNDLE);
  assert.equal(res.status, 'patched');
  assert.deepEqual(res.addedLevels, ['xhigh', 'max']);
  assert.equal(res.updatedLocales.length, 8);
  assert.match(res.source, /GEMINI_LEVELS=\["minimal","low","medium","high","xhigh","max"\]/);
  assert.match(res.source, /minimal, low, medium, high, xhigh, and max/);
  assert.match(res.source, /minimal、low、medium、high、xhigh 和 max/);
  assert.match(res.source, /minimal、low、medium、high、xhigh、max のみ/);

  // Applying a second time is an idempotent already-supported no-op.
  const second = patchSettingsModelsSource(res.source);
  assert.equal(second.status, 'already-supported');
  assert.equal(second.source, res.source);
});

test('patchSettingsModelsSource handles backtick-quoted rolldown/tsdown output', () => {
  const backtickSource = 'const GEMINI_LEVELS=[`minimal`,`low`,`medium`,`high`];const m=`minimal, low, medium, and high`;';
  const res = patchSettingsModelsSource(backtickSource);
  assert.equal(res.status, 'patched');
  assert.deepEqual(res.addedLevels, ['xhigh', 'max']);
  assert.match(res.source, /GEMINI_LEVELS=\[`minimal`,`low`,`medium`,`high`,`xhigh`,`max`\]/);
  assert.match(res.source, /minimal, low, medium, high, xhigh, and max/);
});

test('patchSettingsModelsSource handles partial upstream bundle that already includes xhigh', () => {
  const partialSource = [
    "const GEMINI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];",
    "const msg = 'minimal, low, medium, high, and xhigh';",
    "const msgZh = 'minimal、low、medium、high 和 xhigh';",
  ].join('\n');

  const res = patchSettingsModelsSource(partialSource);
  assert.equal(res.status, 'patched');
  assert.deepEqual(res.addedLevels, ['max']);
  assert.match(res.source, /GEMINI_LEVELS = \['minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]/);
  assert.match(res.source, /minimal, low, medium, high, xhigh, and max/);
  assert.match(res.source, /minimal、low、medium、high、xhigh 和 max/);
});

test('patchSettingsModelsSource safely reports unmatched when GEMINI_LEVELS is absent', () => {
  const source = 'export const OTHER_LEVELS = ["low", "high"];';
  const res = patchSettingsModelsSource(source);
  assert.equal(res.status, 'unmatched');
  assert.equal(res.source, source);
});

test('installSettingsUiPatch enhances in memory, re-applies on reload, and cleanly restores on dispose', () => {
  const graphListeners = new Set();
  const rebuildListeners = new Set();
  const rebuiltEvents = [];
  let graphEvents = 0;
  let composeCount = 0;

  const originalBundle = Buffer.from(SAMPLE_MINIFIED_SETTINGS_BUNDLE, 'utf8');
  const originalEntry = {
    id: SETTINGS_MODELS_PACKAGE_ID,
    rev: 'orig12345678',
    url: `plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=orig12345678`,
  };

  const registry = {
    table: new Map([[SETTINGS_MODELS_PACKAGE_ID, {
      bundle: originalBundle,
      entry: { ...originalEntry },
    }]]),
    rebuildListeners,
    composed: null,
    compose() {
      composeCount += 1;
      const rec = this.table.get(SETTINGS_MODELS_PACKAGE_ID);
      return { entries: rec ? [rec.entry] : [] };
    },
    notifyGraphChanged() {
      graphEvents += 1;
      for (const fn of graphListeners) fn();
    },
    onGraphChanged(fn) {
      graphListeners.add(fn);
      return () => graphListeners.delete(fn);
    },
  };

  rebuildListeners.add((id, rev) => rebuiltEvents.push({ id, rev }));

  const handle = installSettingsUiPatch(registry, { info() {}, warn() {}, error() {} });
  assert.equal(handle.active, true);

  const patchedRecord = registry.table.get(SETTINGS_MODELS_PACKAGE_ID);
  assert.notEqual(patchedRecord.entry.rev, originalEntry.rev);
  assert.match(patchedRecord.entry.rev, /^[0-9a-f]{12}$/);
  assert.equal(
    patchedRecord.entry.url,
    `plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=${patchedRecord.entry.rev}`,
  );
  assert.match(patchedRecord.bundle.toString('utf8'), /"xhigh","max"/);
  assert.equal(composeCount, 1);
  assert.equal(graphEvents, 1);
  assert.equal(rebuiltEvents.length, 1);
  assert.equal(rebuiltEvents[0].rev, patchedRecord.entry.rev);

  // Simulate upstream reconcile replacing record with fresh unpatched disk bytes.
  registry.table.set(SETTINGS_MODELS_PACKAGE_ID, {
    bundle: Buffer.from(SAMPLE_MINIFIED_SETTINGS_BUNDLE, 'utf8'),
    entry: { ...originalEntry, rev: 'reload000001' },
  });
  registry.notifyGraphChanged();

  const reloadedRecord = registry.table.get(SETTINGS_MODELS_PACKAGE_ID);
  assert.notEqual(reloadedRecord.entry.rev, 'reload000001');
  assert.match(reloadedRecord.bundle.toString('utf8'), /"xhigh","max"/);

  // Disposing restores the reloaded record's original bytes and rev.
  handle.dispose();
  const restored = registry.table.get(SETTINGS_MODELS_PACKAGE_ID);
  assert.equal(restored.entry.rev, 'reload000001');
  assert.equal(restored.bundle.toString('utf8'), SAMPLE_MINIFIED_SETTINGS_BUNDLE);
  assert.equal(rebuiltEvents.at(-1).rev, 'reload000001');
});

test('installSettingsUiPatch handles rebuilt() atomically with zero intermediate 404 revisions and refcounts duplicate mounts', () => {
  const diskState = {
    rev: 'disk00000001',
    source: SAMPLE_MINIFIED_SETTINGS_BUNDLE,
  };

  class FakeClientModuleRegistry {
    constructor() {
      this.table = new Map([[SETTINGS_MODELS_PACKAGE_ID, {
        bundle: Buffer.from(diskState.source, 'utf8'),
        entry: {
          id: SETTINGS_MODELS_PACKAGE_ID,
          rev: diskState.rev,
          url: `plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=${diskState.rev}`,
        },
      }]]);
      this.rebuildListeners = new Set();
      this.graphListeners = new Set();
      this.responses = new Map();
      this.composeCalls = 0;
      this.composed = this.compose();
    }

    compose() {
      this.composeCalls += 1;
      const responses = new Map();
      const entries = [];
      for (const record of this.table.values()) {
        entries.push(record.entry);
        responses.set(`/${record.entry.url}`, {
          status: 200,
          body: record.bundle.toString('utf8'),
        });
      }
      this.responses = responses;
      return { entries };
    }

    rebuilt(id) {
      const record = this.table.get(id);
      if (!record) return undefined;
      const rev = diskState.rev;
      if (rev === record.entry.rev) return rev;
      record.entry = {
        id,
        rev,
        url: `plugins/??${id}/client.js&rev=${rev}`,
      };
      record.bundle = Buffer.from(diskState.source, 'utf8');
      this.composed = this.compose();
      for (const notify of this.rebuildListeners) {
        notify(id, rev);
      }
      this.notifyGraphChanged();
      return rev;
    }

    notifyGraphChanged() {
      for (const listener of this.graphListeners) listener();
    }

    onGraphChanged(fn) {
      this.graphListeners.add(fn);
      return () => this.graphListeners.delete(fn);
    }

    fetchRev(rev) {
      return this.responses.get(`/plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=${rev}`)
        ?? { status: 404, body: null };
    }
  }

  const registry = new FakeClientModuleRegistry();
  const rebuiltNotifications = [];
  const graphSnapshots = [];

  registry.rebuildListeners.add((id, rev) => {
    const res = registry.fetchRev(rev);
    rebuiltNotifications.push({ id, rev, status: res.status, body: res.body });
  });
  registry.onGraphChanged(() => {
    const entry = registry.composed.entries.find((e) => e.id === SETTINGS_MODELS_PACKAGE_ID);
    const res = entry ? registry.fetchRev(entry.rev) : { status: 404, body: null };
    graphSnapshots.push({ rev: entry?.rev, status: res.status });
  });

  const handle1 = installSettingsUiPatch(registry, { info() {}, warn() {}, error() {} });
  assert.equal(handle1.active, true);
  assert.equal(handle1.reason, 'attached');
  const initialPatchedRev = registry.table.get(SETTINGS_MODELS_PACKAGE_ID).entry.rev;
  assert.equal(rebuiltNotifications.length, 1);
  assert.equal(rebuiltNotifications[0].status, 200);
  assert.equal(rebuiltNotifications[0].rev, initialPatchedRev);
  assert.equal(graphSnapshots.length, 1);
  assert.equal(graphSnapshots[0].status, 200);

  // Second mount reuses the active wrapper without emitting redundant events.
  const handle2 = installSettingsUiPatch(registry, { info() {}, warn() {}, error() {} });
  assert.equal(handle2.active, true);
  assert.equal(handle2.reason, 'already-attached');
  assert.equal(rebuiltNotifications.length, 1);
  assert.equal(graphSnapshots.length, 1);

  // Releasing handle1 (even twice) keeps Settings UI enhancement active while handle2 lives.
  handle1.dispose();
  handle1.dispose();
  assert.equal(registry.table.get(SETTINGS_MODELS_PACKAGE_ID).entry.rev, initialPatchedRev);
  assert.equal(rebuiltNotifications.length, 1);

  // Unchanged disk rebuild short-circuits without composing or broadcasting.
  const composeBeforeNoop = registry.composeCalls;
  const noopRev = registry.rebuilt(SETTINGS_MODELS_PACKAGE_ID);
  assert.equal(noopRev, initialPatchedRev);
  assert.equal(registry.composeCalls, composeBeforeNoop);
  assert.equal(rebuiltNotifications.length, 1);
  assert.equal(graphSnapshots.length, 1);

  // Changed disk file triggers ONE rebuild notification and ONE graph update, both HTTP 200 (never 404).
  diskState.rev = 'disk00000002';
  diskState.source = `${SAMPLE_MINIFIED_SETTINGS_BUNDLE}\n/* v2 */`;
  const rebuiltRev = registry.rebuilt(SETTINGS_MODELS_PACKAGE_ID);
  assert.notEqual(rebuiltRev, 'disk00000002');
  assert.equal(rebuiltNotifications.length, 2);
  assert.equal(rebuiltNotifications[1].rev, rebuiltRev);
  assert.equal(rebuiltNotifications[1].status, 200);
  assert.match(rebuiltNotifications[1].body, /"xhigh","max"/);
  assert.match(rebuiltNotifications[1].body, /\/\* v2 \*\//);
  assert.equal(graphSnapshots.length, 2);
  assert.equal(graphSnapshots[1].rev, rebuiltRev);
  assert.equal(graphSnapshots[1].status, 200);
  assert.equal(registry.fetchRev('disk00000002').status, 404, 'raw unpatched rev was never published');

  // Reconcile/flush path (table mutated then compose() + notifyGraphChanged()) also emits one 200 update.
  registry.table.set(SETTINGS_MODELS_PACKAGE_ID, {
    bundle: Buffer.from(`${SAMPLE_MINIFIED_SETTINGS_BUNDLE}\n/* v3 */`, 'utf8'),
    entry: {
      id: SETTINGS_MODELS_PACKAGE_ID,
      rev: 'disk00000003',
      url: `plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=disk00000003`,
    },
  });
  registry.composed = registry.compose();
  registry.notifyGraphChanged();
  assert.equal(graphSnapshots.length, 3);
  assert.equal(graphSnapshots[2].status, 200);
  assert.notEqual(graphSnapshots[2].rev, 'disk00000003');
  assert.equal(rebuiltNotifications.length, 2, 'flush does not synthesize rebuild events');

  // Disposing the final active instance restores original bundle, rev, and prototype methods.
  handle2.dispose();
  assert.equal(registry.table.get(SETTINGS_MODELS_PACKAGE_ID).entry.rev, 'disk00000003');
  assert.equal(Object.prototype.hasOwnProperty.call(registry, 'compose'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(registry, 'rebuilt'), false);
  assert.equal(registry.fetchRev('disk00000003').status, 200);
  assert.equal(rebuiltNotifications.at(-1).rev, 'disk00000003');
  assert.equal(rebuiltNotifications.at(-1).status, 200);
});

test('installSettingsUiPatch degrades safely when clientModules registry shape is incompatible', () => {
  const warnings = [];
  const handle = installSettingsUiPatch({}, { warn: (msg) => warnings.push(msg) });
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'incompatible-client-modules');
  assert.equal(warnings.length, 1);
  handle.dispose();
});

test('findMissingUpstreamLevels probes xhigh and max independently', () => {
  const vanillaShared = {
    resolveGoogleThinkingLevel(_model, level) {
      if (['minimal', 'low', 'medium', 'high'].includes(level)) return level;
      throw new Error('unsupported');
    },
    toGoogleThinkingLevel(level) {
      return level.toUpperCase();
    },
    toGoogleSdkThinkingLevel(level) {
      return ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level) ? level : undefined;
    },
  };
  const missingVanilla = findMissingUpstreamLevels(vanillaShared);
  assert.deepEqual([...missingVanilla.entries()], [['xhigh', 'XHIGH'], ['max', 'MAX']]);

  const partialShared = {
    resolveGoogleThinkingLevel(_model, level) {
      if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)) return level;
      throw new Error('unsupported');
    },
    toGoogleThinkingLevel(level) {
      return level.toUpperCase();
    },
    toGoogleSdkThinkingLevel(level) {
      return ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'].includes(level) ? level : undefined;
    },
  };
  const missingPartial = findMissingUpstreamLevels(partialShared);
  assert.deepEqual([...missingPartial.entries()], [['max', 'MAX']]);

  const fullShared = {
    resolveGoogleThinkingLevel(_model, level) {
      return level;
    },
    toGoogleThinkingLevel(level) {
      return level.toUpperCase();
    },
    toGoogleSdkThinkingLevel(level) {
      return level;
    },
  };
  const missingFull = findMissingUpstreamLevels(fullShared);
  assert.equal(missingFull.size, 0);
});

test('shouldInterceptGoogleThinking forwards missing levels on all Google routes and keeps native budget/disabled paths', () => {
  const missingLevels = new Map([['xhigh', 'XHIGH'], ['max', 'MAX']]);
  const helpers = {
    usesGoogleThinkingLevel(model) {
      return /gemini-4/.test(model.id);
    },
    clampThinkingLevel(model, requested) {
      const map = model.thinkingLevelMap ?? {};
      const supported = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((lvl) => {
        if (map[lvl] === null) return false;
        if (lvl === 'xhigh' || lvl === 'max') return map[lvl] !== undefined;
        return true;
      });
      if (supported.includes(requested)) return requested;
      return supported[0] ?? 'off';
    },
  };

  const neon = {
    id: 'gemini-4-neon',
    provider: 'newapi-google',
    api: 'google-generative-ai',
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  };
  const vertexNeon = { ...neon, api: 'google-vertex' };
  const gemini25Flash = { ...neon, id: 'gemini-2.5-flash' };
  const vertex25Flash = { ...gemini25Flash, api: 'google-vertex' };
  const customAlias = { ...neon, id: 'my-proxy-gemini-next' };
  const openai = { ...neon, api: 'openai-responses' };
  const xhighOnlyMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' };
  const xhighOnly = { ...neon, thinkingLevelMap: xhighOnlyMap };
  const gemini25XhighOnly = { ...gemini25Flash, thinkingLevelMap: xhighOnlyMap };

  assert.deepEqual(shouldInterceptGoogleThinking(neon, { reasoning: 'xhigh' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(vertexNeon, { reasoning: 'max' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'max',
    wireLevel: 'MAX',
  });
  assert.equal(shouldInterceptGoogleThinking(neon, { reasoning: 'high' }, missingLevels, helpers), null);
  assert.equal(shouldInterceptGoogleThinking(neon, { reasoning: 'off' }, missingLevels, helpers), null);

  // Non-usesGoogleThinkingLevel models (budget-based like Gemini 2.5 Flash, custom aliases, or older pi-ai regexes)
  // still forward explicit xhigh/max to upstream, while leaving standard levels & disabled thinking on native paths.
  assert.deepEqual(shouldInterceptGoogleThinking(gemini25Flash, { reasoning: 'xhigh' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(vertex25Flash, { reasoning: 'max' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'max',
    wireLevel: 'MAX',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(customAlias, { reasoning: 'xhigh' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  assert.equal(shouldInterceptGoogleThinking(gemini25Flash, { reasoning: 'high' }, missingLevels, helpers), null);
  assert.equal(shouldInterceptGoogleThinking(vertex25Flash, { reasoning: 'low' }, missingLevels, helpers), null);
  assert.equal(shouldInterceptGoogleThinking(gemini25Flash, {}, missingLevels, helpers), null);
  assert.equal(shouldInterceptGoogleThinking(gemini25Flash, { reasoning: 'off' }, missingLevels, helpers), null);
  // Omitted reasoning on budget models goes straight to { thinkingBudget: 0 } without resolveGoogleThinkingLevel.
  assert.equal(shouldInterceptGoogleThinking(gemini25XhighOnly, {}, missingLevels, helpers), null);
  // When off is disallowed and clamps up to xhigh, pi-ai calls resolveGoogleThinkingLevel('xhigh'), so we intercept.
  assert.deepEqual(shouldInterceptGoogleThinking(gemini25XhighOnly, { reasoning: 'off' }, missingLevels, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });

  assert.equal(shouldInterceptGoogleThinking(openai, { reasoning: 'max' }, missingLevels, helpers), null);
  assert.deepEqual(shouldInterceptGoogleThinking(xhighOnly, {}, missingLevels, helpers), {
    mode: 'disabled-fallback',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });

  // When google-shared.js already supports xhigh (e.g. patched WSL pi-ai or future upstream),
  // thinkingLevel models step aside on xhigh, while non-usesGoogleThinkingLevel models MUST still
  // forward xhigh/max so pi-ai's getGoogleBudget() doesn't silently drop them to `{ includeThoughts: true }`.
  const partialMissing = new Map([['max', 'MAX']]);
  assert.equal(shouldInterceptGoogleThinking(neon, { reasoning: 'xhigh' }, partialMissing, helpers), null);
  assert.deepEqual(shouldInterceptGoogleThinking(neon, { reasoning: 'max' }, partialMissing, helpers), {
    mode: 'enabled',
    level: 'max',
    wireLevel: 'MAX',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(gemini25Flash, { reasoning: 'xhigh' }, partialMissing, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(vertex25Flash, { reasoning: 'xhigh' }, partialMissing, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  // Explicit custom thinkingBudgets for an upstream-accepted level is preserved.
  assert.equal(
    shouldInterceptGoogleThinking(
      gemini25Flash,
      { reasoning: 'xhigh', thinkingBudgets: { xhigh: 32768 } },
      partialMissing,
      helpers,
    ),
    null,
  );
  // Even when both xhigh and max are supported in google-shared.js, budget models still forward explicit xhigh/max.
  const noneMissing = new Map();
  assert.equal(shouldInterceptGoogleThinking(neon, { reasoning: 'max' }, noneMissing, helpers), null);
  assert.deepEqual(shouldInterceptGoogleThinking(gemini25Flash, { reasoning: 'xhigh' }, noneMissing, helpers), {
    mode: 'enabled',
    level: 'xhigh',
    wireLevel: 'XHIGH',
  });
  assert.deepEqual(shouldInterceptGoogleThinking(vertex25Flash, { reasoning: 'max' }, noneMissing, helpers), {
    mode: 'enabled',
    level: 'max',
    wireLevel: 'MAX',
  });
});

test('rewriteGoogleThinkingPayload and buildGoogleThinkingStreamOptions preserve user hooks and rewrite level', async () => {
  const userPayloads = [];
  const options = buildGoogleThinkingStreamOptions(
    { id: 'gemini-4-neon', maxTokens: 65536, contextWindow: 1000000 },
    { messages: [] },
    {
      reasoning: 'max',
      apiKey: 'secret',
      headers: { 'x-test': '1' },
      transformHeaders: (h) => h,
      toolChoice: 'auto',
      onPayload: async (params) => {
        userPayloads.push(structuredClone(params));
        return { ...params, customFlag: true };
      },
    },
    { mode: 'enabled', level: 'max', wireLevel: 'MAX' },
    {
      resolveSamplingParams: () => ({ temperature: 0.7 }),
      clampMaxTokensToContext: () => 32768,
    },
  );

  assert.equal('reasoning' in options, false);
  assert.equal(options.apiKey, 'secret');
  assert.equal(options.toolChoice, 'auto');
  assert.equal(typeof options.transformHeaders, 'function');
  assert.deepEqual(options.thinking, { enabled: true, level: 'HIGH' });
  assert.equal(options.maxTokens, 32768);
  assert.deepEqual(options.samplingParams, { temperature: 0.7 });

  const finalPayload = await options.onPayload(
    { config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } } },
    { id: 'gemini-4-neon' },
  );
  assert.deepEqual(finalPayload, {
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'MAX' } },
    customFlag: true,
  });
  assert.equal(userPayloads[0].config.thinkingConfig.thinkingLevel, 'MAX');

  const disabledPayload = rewriteGoogleThinkingPayload(
    { config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } } },
    { mode: 'disabled-fallback', wireLevel: 'XHIGH' },
  );
  assert.deepEqual(disabledPayload, {
    config: { thinkingConfig: { thinkingLevel: 'XHIGH' } },
  });
});

test('installPiAiThinkingPatch wraps streamSimple, delegates extended levels to stream, and restores on dispose', async () => {
  const calls = [];
  class FakeModelsImpl {
    stream(model, context, options) {
      calls.push({ method: 'stream', model, context, options });
      return 'stream-result';
    }
    streamSimple(model, context, options) {
      calls.push({ method: 'streamSimple', model, context, options });
      return 'simple-result';
    }
  }

  const modules = {
    version: '1.6.0-test',
    models: {
      createModels: () => new FakeModelsImpl(),
      clampThinkingLevel: (_m, lvl) => lvl,
    },
    googleShared: {
      usesGoogleThinkingLevel: (m) => /gemini-4/.test(m.id),
      resolveGoogleThinkingLevel: (_m, lvl) => {
        if (['minimal', 'low', 'medium', 'high'].includes(lvl)) return lvl;
        throw new Error('unsupported');
      },
      toGoogleThinkingLevel: (lvl) => lvl.toUpperCase(),
      toGoogleSdkThinkingLevel: (lvl) => (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(lvl) ? lvl : undefined),
    },
    simpleOptions: {
      resolveSamplingParams: () => undefined,
      clampMaxTokensToContext: (_m, _ctx, max) => max,
    },
    transcript: {
      normalizeContext: (ctx) => ({ normalized: true, ...ctx }),
    },
  };

  const original = FakeModelsImpl.prototype.streamSimple;
  const handle = installPiAiThinkingPatch(modules, { info() {}, warn() {} });
  assert.equal(handle.active, true);
  assert.deepEqual(handle.interceptedLevels, ['xhigh', 'max']);

  const instance = modules.models.createModels();
  const model = {
    id: 'gemini-4-neon',
    api: 'google-generative-ai',
    maxTokens: 8192,
    thinkingLevelMap: { low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
  };

  // Standard level passes through to original streamSimple.
  assert.equal(instance.streamSimple(model, { messages: [] }, { reasoning: 'high' }), 'simple-result');
  assert.equal(calls.at(-1).method, 'streamSimple');

  // Extended level routes through stream with rewritten onPayload.
  assert.equal(instance.streamSimple(model, { messages: [] }, { reasoning: 'xhigh' }), 'stream-result');
  assert.equal(calls.at(-1).method, 'stream');
  const rewritten = await calls.at(-1).options.onPayload({
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
  }, model);
  assert.equal(rewritten.config.thinkingConfig.thinkingLevel, 'XHIGH');

  // Non-usesGoogleThinkingLevel models (e.g. Gemini 2.5 Flash or older pi-ai regexes) also forward xhigh/max,
  // while standard levels continue using the model's native streamSimple path.
  const budgetModel = {
    id: 'gemini-2.5-flash',
    api: 'google-vertex',
    reasoning: true,
    maxTokens: 8192,
    thinkingLevelMap: { low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
  };
  assert.equal(instance.streamSimple(budgetModel, { messages: [] }, { reasoning: 'high' }), 'simple-result');
  assert.equal(calls.at(-1).method, 'streamSimple');
  assert.equal(instance.streamSimple(budgetModel, { messages: [] }, { reasoning: 'max' }), 'stream-result');
  assert.equal(calls.at(-1).method, 'stream');
  const rewrittenBudget = await calls.at(-1).options.onPayload({
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
  }, budgetModel);
  assert.equal(rewrittenBudget.config.thinkingConfig.thinkingLevel, 'MAX');

  // Dispose restores exact original method.
  handle.dispose();
  assert.equal(FakeModelsImpl.prototype.streamSimple, original);
  assert.equal(instance.streamSimple(model, { messages: [] }, { reasoning: 'xhigh' }), 'simple-result');
  assert.equal(calls.at(-1).method, 'streamSimple');
});

test('installPiAiThinkingPatch refcounts duplicate mounts so disposing first instance keeps patch active', async () => {
  const calls = [];
  class FakeModelsImpl {
    stream(model, context, options) {
      calls.push({ method: 'stream', model, context, options });
      return 'stream-result';
    }
    streamSimple(model, context, options) {
      calls.push({ method: 'streamSimple', model, context, options });
      return 'simple-result';
    }
  }

  const modules = {
    version: '1.3.0-dup-test',
    models: {
      createModels: () => new FakeModelsImpl(),
      clampThinkingLevel: (_m, lvl) => lvl,
    },
    googleShared: {
      usesGoogleThinkingLevel: () => false,
      resolveGoogleThinkingLevel: (_m, lvl) => {
        if (['minimal', 'low', 'medium', 'high'].includes(lvl)) return lvl;
        throw new Error('Unsupported Google thinking level mapping');
      },
      toGoogleThinkingLevel: (lvl) => lvl.toUpperCase(),
      toGoogleSdkThinkingLevel: (lvl) => (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(lvl) ? lvl : undefined),
    },
    simpleOptions: {
      resolveSamplingParams: () => undefined,
      clampMaxTokensToContext: (_m, _ctx, max) => max,
    },
    transcript: {
      normalizeContext: (ctx) => ctx,
    },
  };

  const original = FakeModelsImpl.prototype.streamSimple;
  const flash25 = {
    id: 'gemini-2.5-flash',
    api: 'google-generative-ai',
    reasoning: true,
    maxTokens: 8192,
    thinkingLevelMap: { low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
  };

  const handle1 = installPiAiThinkingPatch(modules, { info() {}, warn() {} });
  const handle2 = installPiAiThinkingPatch(modules, { info() {}, warn() {} });
  assert.equal(handle1.reason, 'patched');
  assert.equal(handle2.reason, 'already-patched');

  // Disposing the first instance (even repeatedly) MUST keep the wrapper active for handle2.
  handle1.dispose();
  handle1.dispose();
  assert.notEqual(FakeModelsImpl.prototype.streamSimple, original);

  const instance = modules.models.createModels();
  assert.equal(instance.streamSimple(flash25, { messages: [] }, { reasoning: 'max' }), 'stream-result');
  assert.equal(calls.at(-1).method, 'stream');
  const payload = await calls.at(-1).options.onPayload({
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
  }, flash25);
  assert.equal(payload.config.thinkingConfig.thinkingLevel, 'MAX');

  // Disposing the second (last) instance restores original streamSimple.
  handle2.dispose();
  assert.equal(FakeModelsImpl.prototype.streamSimple, original);
  assert.equal(instance.streamSimple(flash25, { messages: [] }, { reasoning: 'max' }), 'simple-result');
  assert.equal(calls.at(-1).method, 'streamSimple');

  // Re-mounting after full disposal works cleanly.
  const handle3 = installPiAiThinkingPatch(modules, { info() {}, warn() {} });
  assert.equal(handle3.reason, 'patched');
  assert.equal(instance.streamSimple(flash25, { messages: [] }, { reasoning: 'xhigh' }), 'stream-result');
  handle3.dispose();
  assert.equal(FakeModelsImpl.prototype.streamSimple, original);
});

test('installPiAiThinkingPatch keeps non-thinkingLevel passthrough active when google-shared supports xhigh/max', async () => {
  const calls = [];
  class FakeModelsImpl {
    stream(model, context, options) {
      calls.push({ method: 'stream', model, context, options });
      return 'stream-result';
    }
    streamSimple(model, context, options) {
      calls.push({ method: 'streamSimple', model, context, options });
      return 'simple-result';
    }
  }

  const modules = {
    version: '1.7.0-future',
    models: {
      createModels: () => new FakeModelsImpl(),
      clampThinkingLevel: (_m, lvl) => lvl,
    },
    googleShared: {
      usesGoogleThinkingLevel: (m) => /gemini-4/.test(m.id),
      resolveGoogleThinkingLevel: (_m, lvl) => lvl,
      toGoogleThinkingLevel: (lvl) => lvl.toUpperCase(),
      toGoogleSdkThinkingLevel: (lvl) => lvl,
    },
    simpleOptions: {
      resolveSamplingParams: () => undefined,
      clampMaxTokensToContext: (_m, _ctx, max) => max,
    },
    transcript: {
      normalizeContext: (ctx) => ctx,
    },
  };

  const handle = installPiAiThinkingPatch(modules, { info() {}, warn() {} });
  assert.equal(handle.active, true);
  assert.equal(handle.reason, 'patched-non-level-only');
  assert.deepEqual(handle.interceptedLevels, []);

  const instance = modules.models.createModels();
  const neon = { id: 'gemini-4-neon', api: 'google-generative-ai', reasoning: true, maxTokens: 8192 };
  const flash25 = { id: 'gemini-2.5-flash', api: 'google-generative-ai', reasoning: true, maxTokens: 8192 };

  // thinkingLevel model uses native streamSimple.
  assert.equal(instance.streamSimple(neon, { messages: [] }, { reasoning: 'xhigh' }), 'simple-result');
  assert.equal(calls.at(-1).method, 'streamSimple');

  // Budget-based model still forwards explicit xhigh through stream instead of dropping in getGoogleBudget.
  assert.equal(instance.streamSimple(flash25, { messages: [] }, { reasoning: 'xhigh' }), 'stream-result');
  assert.equal(calls.at(-1).method, 'stream');
  const rewritten = await calls.at(-1).options.onPayload({
    config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
  }, flash25);
  assert.equal(rewritten.config.thinkingConfig.thinkingLevel, 'XHIGH');

  handle.dispose();
});

test('resolveInstallAnchor falls back to DSH_INSTALL_DIR when Cordis context lacks profileContext', () => {
  const prevInstallDir = process.env.DSH_INSTALL_DIR;
  try {
    process.env.DSH_INSTALL_DIR = '/fallback/dsh-install-dir';
    const strictCordisCtx = {
      get(key) {
        assert.equal(key, 'profileContext');
        return undefined;
      },
      get profileContext() {
        throw new Error('cannot get property "profileContext" without inject');
      },
    };
    assert.equal(resolveInstallAnchor(strictCordisCtx), '/fallback/dsh-install-dir');

    const withProfileCtx = {
      get(key) {
        return key === 'profileContext' ? { installAnchor: '/host/install/package.json' } : undefined;
      },
      get profileContext() {
        throw new Error('should not access property when .get() is present');
      },
    };
    assert.equal(resolveInstallAnchor(withProfileCtx), '/host/install/package.json');
  } finally {
    if (prevInstallDir === undefined) delete process.env.DSH_INSTALL_DIR;
    else process.env.DSH_INSTALL_DIR = prevInstallDir;
  }
});

test('apply fails loudly without patching Settings UI when pi-ai cannot be resolved', async () => {
  const prevInstallDir = process.env.DSH_INSTALL_DIR;
  let injectedUi = false;
  try {
    delete process.env.DSH_INSTALL_DIR;
    await assert.rejects(
      () => apply({
        profileContext: { installAnchor: '/nonexistent-dsh-anchor/package.json' },
        logger: { info() {}, warn() {}, error() {} },
        effect() {},
        inject() { injectedUi = true; },
      }),
      /Could not locate @earendil-works\/pi-ai/,
    );
    assert.equal(injectedUi, false, 'Settings UI hook must not attach if backend pi-ai hook failed');
  } finally {
    if (prevInstallDir !== undefined) process.env.DSH_INSTALL_DIR = prevInstallDir;
  }
});

test('plugin manifest, locales, cordis.patch.yml, and icon.svg satisfy DSH bundle constraints', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@kabxx/dsh-google-thinking-compat');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.engines?.dsh, '0.2.2-rc.5');
  assert.equal(pkg.exports['.'], './src/index.js');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

  const patchYml = readFileSync(join(ROOT_DIR, 'cordis.patch.yml'), 'utf8');
  assert.match(patchYml, /id:\s*google-thinking-compat/);
  assert.match(patchYml, /name:\s*'@kabxx\/dsh-google-thinking-compat'/);

  for (const localeFile of ['locale/en.json', 'locale/zh.json']) {
    const data = JSON.parse(readFileSync(join(ROOT_DIR, localeFile), 'utf8'));
    assert.equal(typeof data.meta?.title, 'string');
    assert.ok(data.meta.title.length > 0);
    assert.equal(typeof data.meta?.description, 'string');
    assert.ok(data.meta.description.length > 20);
    assert.equal(data.meta.detail, undefined);
  }

  const svg = readFileSync(join(ROOT_DIR, 'icon.svg'), 'utf8');
  assert.match(svg, /width="36"\s+height="36"\s+viewBox="0 0 36 36"/);
  assert.doesNotMatch(svg, /<(text|style|script|image|foreignObject)\b/i);
});
