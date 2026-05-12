import { getState, setState, updateState } from "./storage.js";

const LOG_PREFIX = "[AI Study BG]";
const FOCUS_MINUTE_ALARM = "focus-minute-tick";

const STUDY_KEYWORDS = [
  "python",
  "lecture",
  "course",
  "tutorial",
  "math",
  "science",
  "programming",
  "computer science",
  "mit",
  "stanford"
];

const DISTRACTION_KEYWORDS = [
  "funny",
  "meme",
  "prank",
  "drama",
  "reaction",
  "shorts",
  "try not to laugh"
];

function log(message, ...details) {
  console.log(`${LOG_PREFIX} ${message}`, ...details);
}

/*
 * AI classification hook.
 *
 * Phase 1 keeps this deterministic and local so the architecture is testable
 * without a backend. Phase 2/3 can replace the keyword scoring with a fetch()
 * call to an ML service, a local model, or an enterprise policy API. Because
 * content.js already calls the background service worker, no DOM code needs to
 * change when the model becomes real.
 */
export async function classifyVideoTitle(title) {
  const normalizedTitle = String(title || "").toLowerCase();

  if (DISTRACTION_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    log(`Title classified as distraction: ${title}`);
    return false;
  }

  if (STUDY_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    log(`Title classified as study content: ${title}`);
    return true;
  }

  log(`Title classification defaulted to distraction: ${title}`);
  return false;
}

async function initializeState() {
  const state = await getState();
  await setState(state);
  log("State initialized", state);
}

async function incrementAnalytics(metric, amount = 1) {
  const nextState = await updateState((state) => {
    state.analytics[metric] = Number(state.analytics[metric] || 0) + amount;
    return state;
  });

  log(`Analytics incremented: ${metric} +${amount}`, nextState.analytics);
  return nextState.analytics;
}

async function startFocusedSession() {
  await updateState((state) => {
    const now = Date.now();

    if (!state.analytics.focusedSessionStartedAt) {
      state.analytics.focusedSessionStartedAt = now;
      state.analytics.lastFocusedMinuteRecordedAt = now;
    }

    return state;
  });

  /*
   * Alarms survive service-worker suspension. This is the right MV3 primitive
   * for the Phase 2 Pomodoro timer as well: a future Pomodoro controller can
   * add named alarms for work/break transitions without keeping a page open.
   */
  await chrome.alarms.create(FOCUS_MINUTE_ALARM, { periodInMinutes: 1 });
  log("Focused session tracking started");
}

async function stopFocusedSession() {
  await chrome.alarms.clear(FOCUS_MINUTE_ALARM);
  await updateState((state) => {
    state.analytics.focusedSessionStartedAt = null;
    state.analytics.lastFocusedMinuteRecordedAt = null;
    return state;
  });
  log("Focused session tracking stopped");
}

async function recordFocusedMinuteIfNeeded() {
  await updateState((state) => {
    if (!state.analytics.focusedSessionStartedAt) {
      return state;
    }

    const now = Date.now();
    const lastRecordedAt = Number(state.analytics.lastFocusedMinuteRecordedAt || now);
    const elapsedMinutes = Math.floor((now - lastRecordedAt) / 60000);

    if (elapsedMinutes <= 0) {
      return state;
    }

    state.analytics.totalFocusedMinutes =
      Number(state.analytics.totalFocusedMinutes || 0) + elapsedMinutes;
    state.analytics.lastFocusedMinuteRecordedAt = lastRecordedAt + elapsedMinutes * 60000;
    return state;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  initializeState();
});

chrome.runtime.onStartup.addListener(() => {
  initializeState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FOCUS_MINUTE_ALARM) {
    return;
  }

  recordFocusedMinuteIfNeeded();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "GET_STATE") {
    getState().then(sendResponse);
    return true;
  }

  if (message.type === "SET_SETTINGS") {
    updateState((state) => {
      state.settings = {
        ...state.settings,
        ...(message.settings || {})
      };
      return state;
    }).then(sendResponse);
    return true;
  }

  if (message.type === "ANALYTICS_INCREMENT") {
    incrementAnalytics(message.metric, Number(message.amount || 1)).then(sendResponse);
    return true;
  }

  if (message.type === "FOCUS_SESSION_START") {
    startFocusedSession().then(sendResponse);
    return true;
  }

  if (message.type === "FOCUS_SESSION_STOP") {
    stopFocusedSession().then(sendResponse);
    return true;
  }

  if (message.type === "CLASSIFY_VIDEO_TITLE") {
    classifyVideoTitle(message.title).then((isEducational) => {
      sendResponse({ isEducational });
    });
    return true;
  }

  return false;
});

initializeState();
