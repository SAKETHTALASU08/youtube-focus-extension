/*
 * storage.js
 *
 * Single source of truth for extension state.
 *
 * Phase 1 stores settings, analytics, and lightweight session state in
 * chrome.storage.local. Phase 2 can add Pomodoro timers, keyboard shortcut
 * preferences, per-site rules, and AI provider settings by extending
 * DEFAULT_STATE and using the same getState/updateState helpers.
 */

export const STORAGE_KEY = "aiStudyAssistantState";

export const DEFAULT_STATE = {
  settings: {
    focusModeEnabled: true,
    homepageOverrideEnabled: true
  },
  pomodoro: {
    // Reserved for Phase 2. Keeping the shape here avoids future migrations
    // when alarms start driving work/break transitions from background.js.
    mode: "idle",
    startedAt: null,
    durationMinutes: 25
  },
  analytics: {
    videosBlocked: 0,
    recommendationClicksPrevented: 0,
    totalFocusedMinutes: 0,
    focusedSessionStartedAt: null,
    lastFocusedMinuteRecordedAt: null
  }
};

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeState(defaults, stored) {
  const nextState = { ...defaults };

  for (const [key, value] of Object.entries(stored || {})) {
    if (isObject(value) && isObject(defaults[key])) {
      nextState[key] = mergeState(defaults[key], value);
    } else {
      nextState[key] = value;
    }
  }

  return nextState;
}

export async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return mergeState(DEFAULT_STATE, result[STORAGE_KEY]);
}

export async function setState(nextState) {
  const mergedState = mergeState(DEFAULT_STATE, nextState);
  await chrome.storage.local.set({ [STORAGE_KEY]: mergedState });
  return mergedState;
}

export async function updateState(updater) {
  const currentState = await getState();
  const nextState = await updater(structuredClone(currentState));
  return setState(nextState || currentState);
}

export async function resetState() {
  await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_STATE });
  return DEFAULT_STATE;
}
