import { createHash } from 'node:crypto';
import vm from 'node:vm';

export const SETTINGS_MODELS_PACKAGE_ID = '@deepseek-ai/dsh-client-ui-settings-models';

const REQUIRED_BASE_GEMINI_LEVELS = ['minimal', 'low', 'medium', 'high'];
export const EXTRA_GEMINI_LEVELS = ['xhigh', 'max'];

const GEMINI_LEVELS_DECL_RE = /((?:const|let|var)\s+GEMINI_LEVELS\s*=\s*\[)([^\]]*)(\])/;
const QUOTED_STRING_RE = /(['"`])([^'"`]+)\1/g;

/**
 * Localized `modelReasoningLevelsOnly` copy updates covering both vanilla 4-level
 * and partial 5-level (`+ xhigh`) upstream wording across all 8 UI locales.
 */
const LOCALE_COPY_REPLACEMENTS = [
  {
    locale: 'en',
    patterns: [
      'minimal, low, medium, and high',
      'minimal, low, medium, high, and xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh, and max',
  },
  {
    locale: 'zh',
    patterns: [
      'minimal、low、medium 和 high',
      'minimal、low、medium、high 和 xhigh',
    ],
    replacement: 'minimal、low、medium、high、xhigh 和 max',
  },
  {
    locale: 'ja',
    patterns: [
      'minimal、low、medium、high のみ',
      'minimal、low、medium、high、xhigh のみ',
    ],
    replacement: 'minimal、low、medium、high、xhigh、max のみ',
  },
  {
    locale: 'es',
    patterns: [
      'minimal, low, medium y high',
      'minimal, low, medium, high y xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh y max',
  },
  {
    locale: 'fr',
    patterns: [
      'minimal, low, medium et high',
      'minimal, low, medium, high et xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh et max',
  },
  {
    locale: 'de',
    patterns: [
      'minimal, low, medium und high',
      'minimal, low, medium, high und xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh und max',
  },
  {
    locale: 'ru',
    patterns: [
      'minimal, low, medium и high',
      'minimal, low, medium, high и xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh и max',
  },
  {
    locale: 'pt',
    patterns: [
      'minimal, low, medium e high',
      'minimal, low, medium, high e xhigh',
    ],
    replacement: 'minimal, low, medium, high, xhigh e max',
  },
];

/**
 * Compute a deterministic 12-hex revision matching `dsh-client-modules` revision format.
 * @param {string} originalRev
 * @param {Buffer} patchedBuffer
 * @returns {string}
 */
export function computePatchedRevision(originalRev, patchedBuffer) {
  return createHash('sha1')
    .update('dsh-google-thinking-compat\0')
    .update(String(originalRev))
    .update('\0')
    .update(patchedBuffer)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Pure, syntax-checked in-memory transform of `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`.
 * Appends any missing levels from `['xhigh', 'max']` to `GEMINI_LEVELS` and updates
 * the localized validation messages without modifying any file on disk.
 * @param {string} source
 * @returns {{ status: 'patched' | 'already-supported' | 'unmatched', source: string, addedLevels: string[], updatedLocales: string[], detail: string }}
 */
export function patchSettingsModelsSource(source) {
  const match = GEMINI_LEVELS_DECL_RE.exec(source);
  if (!match) {
    return {
      status: 'unmatched',
      source,
      addedLevels: [],
      updatedLocales: [],
      detail: 'GEMINI_LEVELS array declaration not found in ui-settings-models bundle',
    };
  }

  const [fullMatch, prefix, body, suffix] = match;
  const parsed = [...body.matchAll(QUOTED_STRING_RE)];
  const existingLevels = parsed.map((entry) => entry[2]);
  const quote = parsed[0]?.[1] ?? '"';

  const hasAllBase = REQUIRED_BASE_GEMINI_LEVELS.every((level) => existingLevels.includes(level));
  if (!hasAllBase) {
    return {
      status: 'unmatched',
      source,
      addedLevels: [],
      updatedLocales: [],
      detail: `Unexpected GEMINI_LEVELS contents: [${existingLevels.join(', ')}]`,
    };
  }

  const missingLevels = EXTRA_GEMINI_LEVELS.filter((level) => !existingLevels.includes(level));
  if (missingLevels.length === 0) {
    return {
      status: 'already-supported',
      source,
      addedLevels: [],
      updatedLocales: [],
      detail: 'GEMINI_LEVELS already includes xhigh and max',
    };
  }

  const separator = /,\s+/.test(body) ? ', ' : ',';
  const trimmedBody = body.trimEnd();
  const hasTrailingComma = trimmedBody.endsWith(',');
  const additions = missingLevels.map((level) => `${quote}${level}${quote}`).join(separator);
  const nextBody = hasTrailingComma
    ? `${trimmedBody}${separator === ', ' ? ' ' : ''}${additions},`
    : `${trimmedBody}${separator}${additions}`;

  let nextSource = source.slice(0, match.index)
    + `${prefix}${nextBody}${suffix}`
    + source.slice(match.index + fullMatch.length);

  const updatedLocales = [];
  for (const item of LOCALE_COPY_REPLACEMENTS) {
    if (nextSource.includes(item.replacement)) continue;
    for (const pattern of item.patterns) {
      if (nextSource.includes(pattern)) {
        nextSource = nextSource.replaceAll(pattern, item.replacement);
        updatedLocales.push(item.locale);
        break;
      }
    }
  }

  try {
    new vm.Script(nextSource, { filename: `${SETTINGS_MODELS_PACKAGE_ID}/lib/client.js` });
  } catch (error) {
    return {
      status: 'unmatched',
      source,
      addedLevels: [],
      updatedLocales: [],
      detail: `Syntax check failed after in-memory transform: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    status: 'patched',
    source: nextSource,
    addedLevels: missingLevels,
    updatedLocales,
    detail: `Added ${missingLevels.join(', ')} to GEMINI_LEVELS (updated ${updatedLocales.length} locale strings)`,
  };
}

const SETTINGS_UI_STATE_SYMBOL = Symbol.for('dsh.googleThinkingCompat.settingsUiState');

/**
 * Restore a property on `target` to its exact pre-patch descriptor (own vs prototype-inherited).
 * @param {object} target
 * @param {string} key
 * @param {PropertyDescriptor | undefined} ownDescriptor
 */
function restoreProperty(target, key, ownDescriptor) {
  if (ownDescriptor) {
    Object.defineProperty(target, key, ownDescriptor);
  } else {
    delete target[key];
  }
}

/**
 * Wrap `clientModules.rebuildListeners` during `rebuilt(SETTINGS_MODELS_PACKAGE_ID)` so
 * listeners receive the live patched revision instead of the evicted unpatched disk revision.
 * @param {Set<Function>} originalListeners
 * @param {any} clientModules
 */
function createRemappedRebuildListeners(originalListeners, clientModules) {
  return {
    [Symbol.iterator]() {
      const inner = originalListeners[Symbol.iterator]();
      return {
        next() {
          const step = inner.next();
          if (step.done) return step;
          const listener = step.value;
          return {
            done: false,
            value: (rebuiltId, emittedRev) => {
              const live = clientModules.table.get(rebuiltId);
              const effectiveRev = rebuiltId === SETTINGS_MODELS_PACKAGE_ID && live?.entry?.rev
                ? live.entry.rev
                : emittedRev;
              return listener(rebuiltId, effectiveRev);
            },
          };
        },
      };
    },
    add: (...args) => originalListeners.add(...args),
    delete: (...args) => originalListeners.delete(...args),
    has: (...args) => originalListeners.has(...args),
    get size() {
      return originalListeners.size;
    },
  };
}

/**
 * Ensure `table.get(SETTINGS_MODELS_PACKAGE_ID)` is patched in memory before `compose()`
 * builds HTTP/combo responses. Does NOT call `compose()` or notify any listeners.
 * @param {any} state
 * @returns {'patched' | 'unchanged' | 'skipped'}
 */
function ensureRecordPatched(state) {
  if (state.owners.size === 0 || state.restoring) return 'unchanged';

  const record = state.clientModules.table.get(SETTINGS_MODELS_PACKAGE_ID);
  if (!record || !Buffer.isBuffer(record.bundle) || !record.entry) {
    state.snapshot = null;
    return 'unchanged';
  }

  if (
    state.snapshot
    && state.snapshot.record === record
    && record.entry.rev === state.snapshot.patchedRev
  ) {
    return 'unchanged';
  }

  const result = patchSettingsModelsSource(record.bundle.toString('utf8'));
  if (result.status === 'already-supported') {
    state.snapshot = null;
    const skipKey = `already:${record.entry.rev}`;
    if (state.loggedSkipKey !== skipKey) {
      state.loggedSkipKey = skipKey;
      state.logger?.info?.(`google-thinking-compat: ${result.detail}; Settings UI enhancement skipped.`);
    }
    return 'skipped';
  }

  if (result.status !== 'patched') {
    state.snapshot = null;
    const skipKey = `unmatched:${record.entry.rev}:${result.detail}`;
    if (state.loggedSkipKey !== skipKey) {
      state.loggedSkipKey = skipKey;
      state.logger?.warn?.(`google-thinking-compat: ${result.detail}; Settings UI enhancement skipped.`);
    }
    return 'skipped';
  }

  const originalBundle = record.bundle;
  const originalEntry = { ...record.entry };
  const patchedBundle = Buffer.from(result.source, 'utf8');
  const patchedRev = computePatchedRevision(originalEntry.rev, patchedBundle);
  const patchedEntry = {
    ...originalEntry,
    rev: patchedRev,
    url: `plugins/??${SETTINGS_MODELS_PACKAGE_ID}/client.js&rev=${patchedRev}`,
  };

  record.bundle = patchedBundle;
  record.entry = patchedEntry;

  state.snapshot = {
    record,
    originalBundle,
    originalEntry,
    patchedBundle,
    patchedEntry,
    patchedRev,
  };
  state.loggedSkipKey = null;
  state.logger?.info?.(
    `google-thinking-compat: Settings UI enhanced in memory (${result.detail}, rev ${originalEntry.rev} -> ${patchedRev}).`,
  );
  return 'patched';
}

/**
 * Patch the current record in memory, compose responses once, and broadcast notifications.
 * Rolls back on compose failure.
 * @param {any} state
 * @param {boolean} notifyRebuilt
 */
function patchAndPublish(state, notifyRebuilt) {
  const prevSnapshot = state.snapshot;
  const recordBefore = state.clientModules.table.get(SETTINGS_MODELS_PACKAGE_ID);
  const bundleBefore = recordBefore?.bundle;
  const entryBefore = recordBefore?.entry;
  const previousComposed = state.clientModules.composed;

  const outcome = ensureRecordPatched(state);
  if (outcome !== 'patched') return outcome;

  try {
    state.clientModules.composed = state.originalCompose.call(state.clientModules);
    if (notifyRebuilt && state.clientModules.rebuildListeners instanceof Set) {
      for (const notify of state.clientModules.rebuildListeners) {
        try {
          notify(SETTINGS_MODELS_PACKAGE_ID, state.snapshot.patchedRev);
        } catch (error) {
          state.logger?.error?.(error);
        }
      }
    }
    state.clientModules.notifyGraphChanged();
    return 'patched';
  } catch (error) {
    if (recordBefore) {
      recordBefore.bundle = bundleBefore;
      recordBefore.entry = entryBefore;
    }
    state.clientModules.composed = previousComposed;
    state.snapshot = prevSnapshot;
    state.logger?.warn?.('google-thinking-compat: failed to publish in-memory Settings UI enhancement:', error);
    return 'failed';
  }
}

/**
 * Detach one mounted instance; restore original registry methods and bundle only when
 * the last active instance disposes.
 * @param {any} state
 * @param {symbol} ownerToken
 * @param {any} logger
 */
function detachSettingsUiOwner(state, ownerToken, logger) {
  state.owners.delete(ownerToken);
  if (state.owners.size > 0) {
    logger?.info?.(
      `google-thinking-compat: released duplicate Settings UI hook instance (remaining: ${state.owners.size}).`,
    );
    return;
  }

  state.restoring = true;
  const { clientModules } = state;
  try {
    state.unsubscribeGraph?.();

    if (clientModules.compose === state.wrappedCompose) {
      restoreProperty(clientModules, 'compose', state.ownComposeDesc);
    }
    if (state.wrappedRebuilt && clientModules.rebuilt === state.wrappedRebuilt) {
      restoreProperty(clientModules, 'rebuilt', state.ownRebuiltDesc);
    }
    if (clientModules[SETTINGS_UI_STATE_SYMBOL] === state) {
      delete clientModules[SETTINGS_UI_STATE_SYMBOL];
    }

    const current = state.snapshot;
    state.snapshot = null;
    if (!current) return;

    const liveRecord = clientModules.table.get(SETTINGS_MODELS_PACKAGE_ID);
    if (liveRecord !== current.record || liveRecord.entry?.rev !== current.patchedRev) {
      return;
    }

    const previousComposed = clientModules.composed;
    try {
      liveRecord.bundle = current.originalBundle;
      liveRecord.entry = current.originalEntry;
      clientModules.composed = state.originalCompose.call(clientModules);
      if (clientModules.rebuildListeners instanceof Set) {
        for (const notify of clientModules.rebuildListeners) {
          try {
            notify(SETTINGS_MODELS_PACKAGE_ID, current.originalEntry.rev);
          } catch (error) {
            logger?.error?.(error);
          }
        }
      }
      clientModules.notifyGraphChanged();
      logger?.info?.(`google-thinking-compat: restored original Settings UI bundle (rev ${current.originalEntry.rev}).`);
    } catch (error) {
      clientModules.composed = previousComposed;
      logger?.warn?.('google-thinking-compat: failed to restore original Settings UI bundle:', error);
    }
  } finally {
    state.restoring = false;
  }
}

/**
 * Apply the reversible in-memory enhancement to DSH's `clientModules` registry.
 * Hooks `compose()` and `rebuilt()` so rebuilds and reconciliations publish only the
 * final patched revision (never an evicted intermediate 404 revision), supports refcounted
 * duplicate mounts, and restores the exact pre-enable bundle and revision when the last
 * active instance disposes.
 * @param {any} clientModules
 * @param {{ info?: Function, warn?: Function, error?: Function } | undefined} logger
 * @returns {{ active: boolean, reason: string, dispose: () => void }}
 */
export function installSettingsUiPatch(clientModules, logger) {
  const compatible = clientModules
    && clientModules.table instanceof Map
    && typeof clientModules.compose === 'function'
    && typeof clientModules.notifyGraphChanged === 'function'
    && typeof clientModules.onGraphChanged === 'function';

  if (!compatible) {
    logger?.warn?.('google-thinking-compat: clientModules registry shape is incompatible; Settings UI enhancement skipped.');
    return {
      active: false,
      reason: 'incompatible-client-modules',
      dispose() {},
    };
  }

  const existingState = clientModules[SETTINGS_UI_STATE_SYMBOL];
  if (existingState && existingState.owners instanceof Set) {
    const ownerToken = Symbol('google-thinking-compat-ui-owner');
    existingState.owners.add(ownerToken);
    let disposed = false;
    logger?.info?.(
      `google-thinking-compat: reusing active Settings UI enhancement (active instances: ${existingState.owners.size}).`,
    );
    return {
      active: true,
      reason: 'already-attached',
      dispose() {
        if (disposed) return;
        disposed = true;
        detachSettingsUiOwner(existingState, ownerToken, logger);
      },
    };
  }

  const ownComposeDesc = Object.getOwnPropertyDescriptor(clientModules, 'compose');
  const ownRebuiltDesc = Object.getOwnPropertyDescriptor(clientModules, 'rebuilt');
  const originalCompose = clientModules.compose;
  const originalRebuilt = typeof clientModules.rebuilt === 'function' ? clientModules.rebuilt : undefined;
  const ownerToken = Symbol('google-thinking-compat-ui-owner');

  const state = {
    clientModules,
    logger,
    owners: new Set([ownerToken]),
    restoring: false,
    applyingFallback: false,
    loggedSkipKey: null,
    snapshot: null,
    ownComposeDesc,
    ownRebuiltDesc,
    originalCompose,
    originalRebuilt,
    wrappedCompose: null,
    wrappedRebuilt: null,
    unsubscribeGraph: null,
  };

  function wrappedCompose() {
    if (state.owners.size === 0 || state.restoring) {
      return state.originalCompose.call(this);
    }
    const prevSnapshot = state.snapshot;
    const recordBefore = this.table.get(SETTINGS_MODELS_PACKAGE_ID);
    const bundleBefore = recordBefore?.bundle;
    const entryBefore = recordBefore?.entry;

    const patchOutcome = ensureRecordPatched(state);
    try {
      return state.originalCompose.call(this);
    } catch (error) {
      if (patchOutcome === 'patched' && recordBefore) {
        recordBefore.bundle = bundleBefore;
        recordBefore.entry = entryBefore;
        state.snapshot = prevSnapshot;
      }
      throw error;
    }
  }

  state.wrappedCompose = wrappedCompose;
  clientModules.compose = wrappedCompose;

  if (originalRebuilt) {
    function wrappedRebuilt(id) {
      if (id !== SETTINGS_MODELS_PACKAGE_ID || state.owners.size === 0 || state.restoring) {
        return state.originalRebuilt.call(this, id);
      }

      const record = this.table.get(SETTINGS_MODELS_PACKAGE_ID);
      if (!record) {
        return state.originalRebuilt.call(this, id);
      }

      // Temporarily expose the pre-patch disk entry so originalRebuilt's unchanged-baseline check
      // short-circuits when the file on disk has not changed, preventing spurious reloads.
      const priorSnapshot = (
        state.snapshot
        && state.snapshot.record === record
        && record.entry?.rev === state.snapshot.patchedRev
      ) ? state.snapshot : null;

      if (priorSnapshot) {
        record.entry = priorSnapshot.originalEntry;
        record.bundle = priorSnapshot.originalBundle;
      }

      const originalListeners = this.rebuildListeners;
      const ownListenersDesc = Object.getOwnPropertyDescriptor(this, 'rebuildListeners');
      const wrapListeners = originalListeners instanceof Set;

      let returnedRev;
      let failed = false;
      try {
        if (wrapListeners) {
          this.rebuildListeners = createRemappedRebuildListeners(originalListeners, this);
        }
        returnedRev = state.originalRebuilt.call(this, id);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (wrapListeners) {
          restoreProperty(this, 'rebuildListeners', ownListenersDesc);
        }

        // If originalRebuilt short-circuited (unchanged artifact) or threw before replacing record.entry,
        // put our patched entry & bundle back onto the record.
        const liveRecord = this.table.get(SETTINGS_MODELS_PACKAGE_ID);
        if (
          priorSnapshot
          && liveRecord === priorSnapshot.record
          && liveRecord.entry === priorSnapshot.originalEntry
        ) {
          liveRecord.entry = priorSnapshot.patchedEntry;
          liveRecord.bundle = priorSnapshot.patchedBundle;
          state.snapshot = priorSnapshot;
        }
      }

      if (failed) return returnedRev;
      const finalRecord = this.table.get(SETTINGS_MODELS_PACKAGE_ID);
      return finalRecord?.entry?.rev ?? returnedRev;
    }

    state.wrappedRebuilt = wrappedRebuilt;
    clientModules.rebuilt = wrappedRebuilt;
  }

  Object.defineProperty(clientModules, SETTINGS_UI_STATE_SYMBOL, {
    value: state,
    configurable: true,
    enumerable: false,
  });

  // Fallback for registries/mocks that mutate `table` and call `notifyGraphChanged()` without `compose()`.
  // Under real DSH (`flush()` / `rebuilt()`), `wrappedCompose()` has already patched `record`, so this is a no-op.
  state.unsubscribeGraph = clientModules.onGraphChanged(() => {
    if (state.owners.size === 0 || state.restoring || state.applyingFallback) return;
    state.applyingFallback = true;
    try {
      patchAndPublish(state, true);
    } finally {
      state.applyingFallback = false;
    }
  });

  state.applyingFallback = true;
  try {
    patchAndPublish(state, true);
  } finally {
    state.applyingFallback = false;
  }

  let disposed = false;

  return {
    active: true,
    reason: 'attached',
    dispose() {
      if (disposed) return;
      disposed = true;
      detachSettingsUiOwner(state, ownerToken, logger);
    },
  };
}
