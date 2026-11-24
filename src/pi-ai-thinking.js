import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Google protocol identifiers supported by pi-ai's shared Google thinking helpers. */
export const SUPPORTED_GOOGLE_APIS = new Set([
  'google-generative-ai',
  'google-vertex',
]);

/** Extended thinking levels enabled beyond pi-ai's 4-level Google whitelist. */
export const EXTRA_GOOGLE_THINKING_LEVELS = Object.freeze({
  xhigh: 'XHIGH',
  max: 'MAX',
});

const PATCH_STATE_SYMBOL = Symbol.for('dsh.googleThinkingCompat.streamSimpleState');

/**
 * Walk upward from a directory looking for `node_modules/<packageName>/package.json`.
 * @param {string} startDir
 * @param {string[]} segments
 * @returns {string | undefined}
 */
function findInNodeModules(startDir, segments) {
  let dir = startDir;
  while (true) {
    const pkgDir = join(dir, 'node_modules', ...segments);
    if (existsSync(join(pkgDir, 'package.json'))) {
      return pkgDir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walk upward from an anchor path or file URL (including non-hoisted pnpm layouts via
 * `@deepseek-ai/dsh-llm-pi-ai`) to find `@earendil-works/pi-ai`.
 * @param {string | undefined} installAnchor
 * @returns {string | undefined}
 */
export function resolvePiAiPackageDir(installAnchor) {
  const candidates = [];
  if (typeof installAnchor === 'string' && installAnchor.length > 0) {
    const anchorPath = installAnchor.startsWith('file:')
      ? fileURLToPath(installAnchor)
      : resolve(installAnchor);
    candidates.push(anchorPath);
  }
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.length > 0) {
    candidates.push(resolve(process.env.DSH_INSTALL_DIR));
  }

  for (const candidate of candidates) {
    let dir = candidate;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        dir = dirname(candidate);
      }
    } catch {
      // Ignore stat errors and fall back to candidate as directory.
    }

    const direct = findInNodeModules(dir, ['@earendil-works', 'pi-ai']);
    if (direct) return direct;

    // Non-hoisted pnpm / monorepo fallback: resolve through @deepseek-ai/dsh-llm-pi-ai.
    try {
      const req = createRequire(join(dir, 'package.json'));
      const llmPiAiPkg = req.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json');
      const viaLlm = findInNodeModules(dirname(llmPiAiPkg), ['@earendil-works', 'pi-ai']);
      if (viaLlm) return viaLlm;
    } catch {
      // Continue trying remaining candidates.
    }
  }
  return undefined;
}

/**
 * Resolve a subpath export target from a package's `exports` map.
 * @param {string} pkgDir
 * @param {Record<string, unknown>} pkgJson
 * @param {string} subpath
 * @param {string} fallbackRelPath
 * @returns {string}
 */
function resolveExportFile(pkgDir, pkgJson, subpath, fallbackRelPath) {
  const exportsMap = pkgJson && typeof pkgJson.exports === 'object' && pkgJson.exports !== null
    ? pkgJson.exports
    : undefined;

  if (exportsMap) {
    const exact = exportsMap[subpath];
    const exactTarget = extractImportTarget(exact);
    if (exactTarget) return join(pkgDir, exactTarget);

    for (const [pattern, targetSpec] of Object.entries(exportsMap)) {
      const starIndex = pattern.indexOf('*');
      if (starIndex === -1) continue;
      const prefix = pattern.slice(0, starIndex);
      const suffix = pattern.slice(starIndex + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
        const target = extractImportTarget(targetSpec);
        if (target && target.includes('*')) {
          return join(pkgDir, target.replace('*', matched));
        }
      }
    }
  }

  return join(pkgDir, fallbackRelPath);
}

/**
 * @param {unknown} spec
 * @returns {string | undefined}
 */
function extractImportTarget(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object') {
    if (typeof spec.import === 'string') return spec.import;
    if (typeof spec.default === 'string') return spec.default;
  }
  return undefined;
}

/**
 * Load the exact ESM module instances of `@earendil-works/pi-ai` used by the running Host.
 * @param {string | undefined} installAnchor
 */
export async function loadPiAiModules(installAnchor) {
  const pkgDir = resolvePiAiPackageDir(installAnchor);
  if (!pkgDir) {
    throw new Error('Could not locate @earendil-works/pi-ai from Host install anchor');
  }
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  const modelsPath = resolveExportFile(pkgDir, pkgJson, './models', './dist/models.js');
  const googleSharedPath = resolveExportFile(pkgDir, pkgJson, './api/google-shared', './dist/api/google-shared.js');
  const simpleOptionsPath = resolveExportFile(pkgDir, pkgJson, './api/simple-options', './dist/api/simple-options.js');
  const transcriptPath = resolveExportFile(pkgDir, pkgJson, './utils/transcript', './dist/utils/transcript.js');

  const [models, googleShared, simpleOptions, transcript] = await Promise.all([
    import(pathToFileURL(modelsPath).href),
    import(pathToFileURL(googleSharedPath).href),
    import(pathToFileURL(simpleOptionsPath).href),
    import(pathToFileURL(transcriptPath).href),
  ]);

  return {
    version: typeof pkgJson.version === 'string' ? pkgJson.version : 'unknown',
    models,
    googleShared,
    simpleOptions,
    transcript,
  };
}

/**
 * Probe each extended level against the installed pi-ai Google helpers.
 * Returns only the levels that upstream pi-ai does NOT yet natively support.
 * @param {{ resolveGoogleThinkingLevel?: Function, toGoogleThinkingLevel?: Function, toGoogleSdkThinkingLevel?: Function }} googleShared
 * @returns {Map<string, string>}
 */
export function findMissingUpstreamLevels(googleShared) {
  const missing = new Map();
  for (const [level, wireLevel] of Object.entries(EXTRA_GOOGLE_THINKING_LEVELS)) {
    const probeModel = {
      id: 'gemini-4-neon',
      provider: 'google-thinking-compat-probe',
      api: 'google-generative-ai',
      reasoning: true,
      thinkingLevelMap: { [level]: level },
    };
    let supported = false;
    try {
      const resolved = googleShared.resolveGoogleThinkingLevel?.(probeModel, level);
      const apiLevel = googleShared.toGoogleThinkingLevel?.(resolved);
      const sdkLevel = googleShared.toGoogleSdkThinkingLevel?.(apiLevel);
      supported = typeof sdkLevel === 'string' && sdkLevel.toUpperCase() === wireLevel;
    } catch {
      supported = false;
    }
    if (!supported) {
      missing.set(level, wireLevel);
    }
  }
  return missing;
}

/**
 * Resolve the lowercase target Google thinking level name after applying `thinkingLevelMap`.
 * @param {object} model
 * @param {string} clampedLevel
 * @returns {string}
 */
function resolveTargetLevelName(model, clampedLevel) {
  const mapped = model.thinkingLevelMap?.[clampedLevel];
  return typeof mapped === 'string' ? mapped.toLowerCase() : clampedLevel;
}

/**
 * Decide whether a `streamSimple` request needs runtime interception for an extended Google level.
 * @param {object} model
 * @param {object | undefined} options
 * @param {Map<string, string>} missingLevels
 * @param {{ usesGoogleThinkingLevel: Function, clampThinkingLevel: Function }} helpers
 * @returns {{ mode: 'enabled' | 'disabled-fallback', level: string, wireLevel: string } | null}
 */
export function shouldInterceptGoogleThinking(model, options, missingLevels, helpers) {
  if (!model || typeof model !== 'object' || !SUPPORTED_GOOGLE_APIS.has(model.api)) {
    return null;
  }

  const usesThinkingLevel = Boolean(helpers.usesGoogleThinkingLevel(model));

  // Disabled thinking only hits resolveGoogleThinkingLevel when usesGoogleThinkingLevel(model) is true;
  // budget-based models return { thinkingBudget: 0 } directly without consulting thinking levels.
  const checkDisabledFallback = () => {
    if (!usesThinkingLevel || missingLevels.size === 0) return null;
    const fallback = helpers.clampThinkingLevel(model, 'off');
    if (fallback === 'off') return null;
    const resolved = resolveTargetLevelName(model, fallback);
    const wireLevel = missingLevels.get(resolved);
    if (!wireLevel) return null;
    return { mode: 'disabled-fallback', level: resolved, wireLevel };
  };

  if (!options?.reasoning) {
    return checkDisabledFallback();
  }

  const clamped = helpers.clampThinkingLevel(model, options.reasoning);
  if (clamped === 'off') {
    return checkDisabledFallback();
  }

  const resolved = resolveTargetLevelName(model, clamped);

  if (usesThinkingLevel) {
    // For thinkingLevel models (Gemini 3+/4+, Gemma 4, etc.), step aside whenever upstream
    // google-shared.js already supports the requested level natively.
    const wireLevel = missingLevels.get(resolved);
    if (!wireLevel) {
      return null;
    }
    return { mode: 'enabled', level: resolved, wireLevel };
  }

  // For non-usesGoogleThinkingLevel models (e.g. Gemini 2.5 Flash/Pro, custom proxy aliases, or older pi-ai):
  // - When google-shared.js lacks xhigh/max, pi-ai throws locally before sending HTTP.
  // - Even when google-shared.js accepts xhigh/max (e.g. patched WSL pi-ai or a future upstream release),
  //   pi-ai's getGoogleBudget() returns undefined for xhigh/max on Gemini 2.5 models (or -1 for unknown IDs),
  //   which silently drops the level into `{ includeThoughts: true }`.
  // Forward explicitly selected extended levels as thinkingLevel unless the caller set an explicit
  // thinkingBudgets entry for a level google-shared.js already accepts.
  const extraWireLevel = EXTRA_GOOGLE_THINKING_LEVELS[resolved];
  if (!extraWireLevel) {
    return null;
  }
  const hasCustomBudget = options?.thinkingBudgets?.[resolved] !== undefined;
  if (hasCustomBudget && !missingLevels.has(resolved)) {
    return null;
  }
  return { mode: 'enabled', level: resolved, wireLevel: extraWireLevel };
}

/**
 * Rewrite `params.config.thinkingConfig.thinkingLevel` to the extended Google wire string.
 * @param {unknown} params
 * @param {{ mode: 'enabled' | 'disabled-fallback', wireLevel: string }} decision
 * @returns {unknown}
 */
export function rewriteGoogleThinkingPayload(params, decision) {
  if (!params || typeof params !== 'object') return params;
  const config = params.config;
  if (!config || typeof config !== 'object') return params;
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== 'object') return params;

  const nextThinkingConfig = decision.mode === 'disabled-fallback'
    ? { thinkingLevel: decision.wireLevel }
    : { ...thinkingConfig, thinkingLevel: decision.wireLevel };

  return {
    ...params,
    config: {
      ...config,
      thinkingConfig: nextThinkingConfig,
    },
  };
}

/**
 * Build options for `ModelsImpl.prototype.stream(...)` that match `provider.streamSimple(...)`
 * while bypassing `resolveGoogleThinkingLevel` and injecting the extended `thinkingLevel` wire value.
 * @param {object} model
 * @param {object} transcript
 * @param {object | undefined} options
 * @param {{ mode: 'enabled' | 'disabled-fallback', level: string, wireLevel: string }} decision
 * @param {{ resolveSamplingParams: Function, clampMaxTokensToContext: Function }} helpers
 * @returns {object}
 */
export function buildGoogleThinkingStreamOptions(model, transcript, options, decision, helpers) {
  const reasoningForSampling = decision.mode === 'enabled' ? (options?.reasoning ?? 'off') : 'off';
  const samplingParams = helpers.resolveSamplingParams(model, reasoningForSampling, options?.samplingParams);
  const maxTokens = helpers.clampMaxTokensToContext(model, transcript, options?.maxTokens ?? model.maxTokens);

  const {
    reasoning: _reasoning,
    thinkingBudgets: _thinkingBudgets,
    onPayload: userOnPayload,
    ...rest
  } = options ?? {};

  return {
    ...rest,
    samplingParams,
    maxTokens,
    thinking: {
      enabled: true,
      level: 'HIGH',
    },
    onPayload: async (params, reqModel) => {
      const rewritten = rewriteGoogleThinkingPayload(params, decision);
      if (typeof userOnPayload === 'function') {
        const userResult = await userOnPayload(rewritten, reqModel);
        return userResult !== undefined ? userResult : rewritten;
      }
      return rewritten;
    },
  };
}

/**
 * Install the reversible runtime wrapper on `ModelsImpl.prototype.streamSimple`.
 * @param {{ version?: string, models: any, googleShared: any, simpleOptions: any, transcript: any }} modules
 * @param {{ info?: Function, warn?: Function } | undefined} logger
 * @returns {{ active: boolean, reason: string, interceptedLevels: string[], dispose: () => void }}
 */
export function installPiAiThinkingPatch(modules, logger) {
  const missingLevels = findMissingUpstreamLevels(modules.googleShared);

  const probe = modules.models.createModels();
  const proto = Object.getPrototypeOf(probe);
  if (!proto || typeof proto.streamSimple !== 'function' || typeof proto.stream !== 'function') {
    logger?.warn?.('google-thinking-compat: ModelsImpl.prototype.streamSimple not found; backend hook skipped.');
    return {
      active: false,
      reason: 'incompatible-pi-ai',
      interceptedLevels: [],
      dispose() {},
    };
  }

  const existingState = proto.streamSimple[PATCH_STATE_SYMBOL];
  if (existingState && existingState.owners instanceof Set) {
    const ownerToken = Symbol('google-thinking-compat-owner');
    existingState.owners.add(ownerToken);
    let disposed = false;
    logger?.info?.(
      `google-thinking-compat: reusing active runtime hook on @earendil-works/pi-ai@${modules.version ?? 'unknown'} (active instances: ${existingState.owners.size}).`,
    );
    return {
      active: true,
      reason: 'already-patched',
      interceptedLevels: [...existingState.interceptedLevels],
      dispose() {
        if (disposed) return;
        disposed = true;
        existingState.owners.delete(ownerToken);
        if (existingState.owners.size > 0) {
          logger?.info?.(
            `google-thinking-compat: released duplicate runtime hook instance (remaining: ${existingState.owners.size}).`,
          );
          return;
        }
        if (proto.streamSimple === existingState.patchedStreamSimple) {
          proto.streamSimple = existingState.originalStreamSimple;
        }
        logger?.info?.('google-thinking-compat: restored original ModelsImpl.prototype.streamSimple.');
      },
    };
  }

  const originalStreamSimple = proto.streamSimple;
  const helpers = {
    usesGoogleThinkingLevel: modules.googleShared.usesGoogleThinkingLevel,
    clampThinkingLevel: modules.models.clampThinkingLevel,
    resolveSamplingParams: modules.simpleOptions.resolveSamplingParams,
    clampMaxTokensToContext: modules.simpleOptions.clampMaxTokensToContext,
  };

  const interceptedLevels = [...missingLevels.keys()];
  const ownerToken = Symbol('google-thinking-compat-owner');
  const state = {
    owners: new Set([ownerToken]),
    originalStreamSimple,
    patchedStreamSimple: null,
    interceptedLevels,
  };

  function patchedStreamSimple(model, context, options) {
    if (state.owners.size === 0) {
      return originalStreamSimple.call(this, model, context, options);
    }
    const decision = shouldInterceptGoogleThinking(model, options, missingLevels, helpers);
    if (!decision) {
      return originalStreamSimple.call(this, model, context, options);
    }
    const transcript = modules.transcript.normalizeContext(context);
    const streamOptions = buildGoogleThinkingStreamOptions(model, transcript, options, decision, helpers);
    return this.stream(model, transcript, streamOptions);
  }

  state.patchedStreamSimple = patchedStreamSimple;

  Object.defineProperty(patchedStreamSimple, PATCH_STATE_SYMBOL, {
    value: state,
    enumerable: false,
  });

  proto.streamSimple = patchedStreamSimple;

  const reason = interceptedLevels.length > 0 ? 'patched' : 'patched-non-level-only';
  if (interceptedLevels.length > 0) {
    logger?.info?.(
      `google-thinking-compat: enabled runtime hook on @earendil-works/pi-ai@${modules.version ?? 'unknown'} for levels: ${interceptedLevels.join(', ')}`,
    );
  } else {
    logger?.info?.(
      `google-thinking-compat: upstream @earendil-works/pi-ai@${modules.version ?? 'unknown'} supports xhigh/max for thinkingLevel models; keeping non-thinkingLevel passthrough active.`,
    );
  }

  let disposed = false;

  return {
    active: true,
    reason,
    interceptedLevels,
    dispose() {
      if (disposed) return;
      disposed = true;
      state.owners.delete(ownerToken);
      if (state.owners.size > 0) {
        logger?.info?.(
          `google-thinking-compat: released runtime hook instance while ${state.owners.size} instance(s) remain active.`,
        );
        return;
      }
      if (proto.streamSimple === patchedStreamSimple) {
        proto.streamSimple = originalStreamSimple;
      }
      logger?.info?.('google-thinking-compat: restored original ModelsImpl.prototype.streamSimple.');
    },
  };
}
