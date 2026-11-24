import { installPiAiThinkingPatch, loadPiAiModules } from './pi-ai-thinking.js';
import { installSettingsUiPatch } from './settings-ui.js';

export const name = 'google-thinking-compat';
export const reusable = false;

/**
 * Resolve the DSH Host installation anchor from Cordis context without triggering
 * Cordis's strict property-access error when `profileContext` is not registered.
 * @param {any} ctx
 * @returns {string | undefined}
 */
export function resolveInstallAnchor(ctx) {
  let profileContext;
  if (typeof ctx?.get === 'function') {
    try {
      profileContext = ctx.get('profileContext');
    } catch {
      profileContext = undefined;
    }
  } else {
    profileContext = ctx?.profileContext;
  }
  const fromProfile = profileContext?.installAnchor;
  if (typeof fromProfile === 'string' && fromProfile.length > 0) {
    return fromProfile;
  }
  return process.env.DSH_INSTALL_DIR;
}

/**
 * Host entry for `@kabxx/dsh-google-thinking-compat`.
 *
 * 1. Loads and hooks `@earendil-works/pi-ai` (`ModelsImpl.prototype.streamSimple`) first so
 *    `google-generative-ai` and `google-vertex` requests can transmit `thinkingLevel`
 *    values `"XHIGH"` and `"MAX"` without modifying any file in the DSH installation.
 *    If `@earendil-works/pi-ai` cannot be loaded or is incompatible, startup fails loudly
 *    rather than leaving the UI accepting levels that requests cannot send.
 * 2. When `clientModules` is available, enhances `@deepseek-ai/dsh-client-ui-settings-models`
 *    in memory to add `xhigh` and `max` to Google Gemini reasoning-level choices.
 *
 * Both hooks self-probe upstream support and automatically step aside once DSH/pi-ai natively
 * supports these levels; disabling or removing the plugin restores the original runtime state.
 *
 * @param {any} ctx
 */
export async function apply(ctx) {
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
  }, 'google-thinking-compat: lifecycle');

  // 1. Backend pi-ai runtime hook first so UI is never patched without a working backend.
  const modules = await loadPiAiModules(resolveInstallAnchor(ctx));
  if (disposed) return;

  const piAiHandle = installPiAiThinkingPatch(modules, ctx.logger);
  if (piAiHandle.reason === 'incompatible-pi-ai') {
    throw new Error('google-thinking-compat: incompatible @earendil-works/pi-ai runtime (ModelsImpl.prototype.streamSimple unavailable)');
  }

  ctx.effect(() => () => {
    piAiHandle.dispose();
  }, 'google-thinking-compat: pi-ai');

  // 2. Optional Web/Desktop Settings UI in-memory enhancement (skips gracefully in headless mode).
  ctx.inject(['clientModules'], (uiCtx) => {
    uiCtx.effect(() => {
      const handle = installSettingsUiPatch(uiCtx.clientModules, uiCtx.logger);
      return () => handle.dispose();
    }, 'google-thinking-compat: settings-ui');
  });
}
