/*
 * content.js
 *
 * DOM-only module for YouTube. It owns routing, page cleanup, scroll blocking,
 * and click interception. Persistent state and analytics live in background.js
 * + storage.js so this file can be safely reloaded by YouTube's SPA lifecycle.
 */

const LOG_PREFIX = "[AI Study Content]";
const STYLE_ID = "ai-study-content-style";
const HOME_OVERRIDE_ID = "ai-study-home-override";
const HIDDEN_ATTRIBUTE = "data-ai-study-hidden";
const OBSERVER_ROOT_SELECTOR = "ytd-app";

const ROUTES = {
  home: "home",
  shorts: "shorts",
  watch: "watch",
  other: "other"
};

const SELECTORS = {
  homeFeed: 'ytd-browse[page-subtype="home"]',
  richGrid: "ytd-rich-grid-renderer",
  shortsFeed: "ytd-shorts",
  shortsContainer: "ytd-reel-video-renderer",
  recommendationSidebar: "#related, ytd-watch-next-secondary-results-renderer",
  recommendationLinks:
    "#related a#thumbnail, #related a.yt-simple-endpoint, ytd-watch-next-secondary-results-renderer a#thumbnail"
};

let settings = {
  focusModeEnabled: true,
  homepageOverrideEnabled: true
};
let observer = null;
let observerRoot = null;
let currentRoute = "";
let lastUrl = location.href;
let applyScheduled = false;
let videosBlockedThisPage = new WeakSet();
let interceptedLinks = new WeakSet();
let scrollHandlersAttached = false;
let lastClassifiedTitle = "";

function log(message, ...details) {
  console.log(`${LOG_PREFIX} ${message}`, ...details);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        log(`Runtime message failed: ${chrome.runtime.lastError.message}`);
        resolve(null);
        return;
      }

      resolve(response);
    });
  });
}

function getRoute() {
  if (location.pathname === "/") {
    return ROUTES.home;
  }

  if (location.pathname.startsWith("/shorts")) {
    return ROUTES.shorts;
  }

  if (location.pathname === "/watch") {
    return ROUTES.watch;
  }

  return ROUTES.other;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${HIDDEN_ATTRIBUTE}="true"] {
      display: none !important;
    }

    html.ai-study-no-scroll,
    html.ai-study-no-scroll body {
      overflow: hidden !important;
      height: 100% !important;
    }

    #${HOME_OVERRIDE_ID} {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f1115;
      color: #f7f7f7;
      font-family: Arial, Helvetica, sans-serif;
      padding: 24px;
      box-sizing: border-box;
    }

    #${HOME_OVERRIDE_ID} form {
      width: min(640px, 100%);
    }

    #${HOME_OVERRIDE_ID} label {
      display: block;
      margin-bottom: 14px;
      font-size: 24px;
      font-weight: 700;
      line-height: 1.25;
    }

    #${HOME_OVERRIDE_ID} .search-row {
      display: flex;
      gap: 8px;
    }

    #${HOME_OVERRIDE_ID} input {
      min-width: 0;
      flex: 1;
      height: 44px;
      border: 1px solid #3a3f4b;
      border-radius: 6px;
      padding: 0 12px;
      color: #111;
      font-size: 15px;
    }

    #${HOME_OVERRIDE_ID} button {
      height: 44px;
      border: 0;
      border-radius: 6px;
      padding: 0 14px;
      color: #fff;
      background: #1f6feb;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
  `;

  (document.head || document.documentElement).appendChild(style);
  log("Injected content stylesheet");
}

function clearHiddenElements() {
  document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`).forEach((element) => {
    element.removeAttribute(HIDDEN_ATTRIBUTE);
  });
}

function hideElement(element, reason) {
  if (!element || element.getAttribute(HIDDEN_ATTRIBUTE) === "true") {
    return false;
  }

  element.setAttribute(HIDDEN_ATTRIBUTE, "true");
  log(`Hid ${reason}`, element);
  return true;
}

function incrementAnalytics(metric, amount = 1) {
  sendMessage({
    type: "ANALYTICS_INCREMENT",
    metric,
    amount
  });
}

function removeHomepageBody() {
  if (!document.body) {
    return;
  }

  ensureStyle();

  if (document.getElementById(HOME_OVERRIDE_ID)) {
    return;
  }

  /*
   * The home route is intentionally replaced at the body level because hiding
   * individual feed nodes lets YouTube keep creating more infinite-scroll
   * content. Phase 2 shortcuts can still be global because this content script
   * remains mounted and owns only the visible DOM shell.
   */
  document.body.replaceChildren();

  const container = document.createElement("main");
  container.id = HOME_OVERRIDE_ID;

  const form = document.createElement("form");
  const label = document.createElement("label");
  const row = document.createElement("div");
  const input = document.createElement("input");
  const button = document.createElement("button");

  label.setAttribute("for", "ai-study-search");
  label.textContent = "Search what you came to learn.";

  row.className = "search-row";
  input.id = "ai-study-search";
  input.type = "search";
  input.autocomplete = "off";
  input.placeholder = "Python recursion, linear algebra lecture, history documentary";

  button.type = "submit";
  button.textContent = "Search";

  row.append(input, button);
  form.append(label, row);
  container.append(form);
  document.body.append(container);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const query = input.value.trim();

    if (!query) {
      input.focus();
      return;
    }

    location.assign(`/results?search_query=${encodeURIComponent(query)}`);
  });

  input.focus();
  log("Homepage body cleared and study search UI injected");
}

function setScrollLock(enabled) {
  document.documentElement.classList.toggle("ai-study-no-scroll", enabled);

  if (enabled) {
    window.scrollTo(0, 0);
  }
}

function preventScroll(event) {
  if (getRoute() !== ROUTES.home && getRoute() !== ROUTES.shorts) {
    return;
  }

  event.preventDefault();
  window.scrollTo(0, 0);
}

function attachScrollGuards() {
  if (scrollHandlersAttached) {
    return;
  }

  /*
   * One set of capture listeners is attached for the lifetime of the content
   * script. The route check inside preventScroll avoids per-navigation listener
   * churn and prevents duplicate handlers during YouTube SPA transitions.
   */
  window.addEventListener("wheel", preventScroll, { capture: true, passive: false });
  window.addEventListener("touchmove", preventScroll, { capture: true, passive: false });
  window.addEventListener("scroll", () => {
    if (getRoute() === ROUTES.home || getRoute() === ROUTES.shorts) {
      window.scrollTo(0, 0);
    }
  }, { capture: true, passive: true });

  scrollHandlersAttached = true;
  log("Scroll guards attached");
}

function blockHomeAndShortsFeeds() {
  const route = getRoute();

  if (route !== ROUTES.home && route !== ROUTES.shorts) {
    setScrollLock(false);
    return;
  }

  setScrollLock(true);

  const blockedSelectors = route === ROUTES.home
    ? [SELECTORS.homeFeed, SELECTORS.richGrid]
    : [SELECTORS.shortsFeed, SELECTORS.shortsContainer];

  for (const selector of blockedSelectors) {
    document.querySelectorAll(selector).forEach((element) => {
      if (hideElement(element, route === ROUTES.home ? "home feed video container" : "shorts feed")) {
        if (!videosBlockedThisPage.has(element)) {
          videosBlockedThisPage.add(element);
          incrementAnalytics("videosBlocked");
        }
      }
    });
  }
}

function interceptRecommendationClicks() {
  if (getRoute() !== ROUTES.watch) {
    return;
  }

  document.querySelectorAll(SELECTORS.recommendationLinks).forEach((link) => {
    if (interceptedLinks.has(link)) {
      return;
    }

    interceptedLinks.add(link);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      incrementAnalytics("recommendationClicksPrevented");
      log("Prevented recommendation click", link.href);
    }, { capture: true });
  });
}

async function classifyCurrentVideo() {
  if (getRoute() !== ROUTES.watch) {
    return;
  }

  const titleElement = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string");
  const title = titleElement?.textContent?.trim();

  if (!title || title === lastClassifiedTitle) {
    return;
  }

  lastClassifiedTitle = title;
  const response = await sendMessage({
    type: "CLASSIFY_VIDEO_TITLE",
    title
  });

  log(`Classification result for "${title}": ${response?.isEducational ? "study" : "distraction"}`);
}

function applyRouteRules(trigger) {
  applyScheduled = false;

  const route = getRoute();

  if (route !== currentRoute) {
    log(`Route changed: ${currentRoute || "initial"} -> ${route}`);
    currentRoute = route;
    videosBlockedThisPage = new WeakSet();
    lastClassifiedTitle = "";
    clearHiddenElements();
  }

  log(`Applying Phase 1 rules: ${trigger}`);

  if (!settings.focusModeEnabled) {
    setScrollLock(false);
    clearHiddenElements();
    sendMessage({ type: "FOCUS_SESSION_STOP" });
    return;
  }

  if (route === ROUTES.home && settings.homepageOverrideEnabled) {
    removeHomepageBody();
  }

  blockHomeAndShortsFeeds();
  interceptRecommendationClicks();
  classifyCurrentVideo();

  if (route === ROUTES.watch) {
    sendMessage({ type: "FOCUS_SESSION_START" });
  } else {
    sendMessage({ type: "FOCUS_SESSION_STOP" });
  }
}

function scheduleApply(trigger) {
  if (applyScheduled) {
    log(`Apply already scheduled; duplicate ignored: ${trigger}`);
    return;
  }

  applyScheduled = true;
  requestAnimationFrame(() => applyRouteRules(trigger));
}

function mutationTouchesRelevantSurface(mutations) {
  const targetSelector = [
    SELECTORS.homeFeed,
    SELECTORS.richGrid,
    SELECTORS.shortsFeed,
    SELECTORS.shortsContainer,
    SELECTORS.recommendationSidebar,
    "h1.ytd-watch-metadata",
    "h1.title"
  ].join(",");

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      if (node.matches(targetSelector) || node.querySelector(targetSelector)) {
        return true;
      }
    }
  }

  return false;
}

function getObserverRoot() {
  return document.querySelector(OBSERVER_ROOT_SELECTOR) || document.body;
}

function startObserver() {
  const root = getObserverRoot();

  if (!root) {
    return;
  }

  if (observer && observerRoot === root) {
    return;
  }

  if (observer) {
    observer.disconnect();
    log("Disconnected observer before reconnecting to new root");
  }

  observerRoot = root;
  observer = new MutationObserver((mutations) => {
    if (mutationTouchesRelevantSurface(mutations)) {
      scheduleApply("relevant DOM mutation");
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true
  });

  log(`MutationObserver started on ${root.tagName.toLowerCase()}`);
}

function handleNavigateFinish() {
  const previousUrl = lastUrl;
  lastUrl = location.href;

  log(`yt-navigate-finish detected: ${previousUrl} -> ${lastUrl}`);
  startObserver();
  scheduleApply("yt-navigate-finish");
  window.setTimeout(() => scheduleApply("post-navigation settle"), 300);
}

async function loadState() {
  const state = await sendMessage({ type: "GET_STATE" });

  if (state?.settings) {
    settings = state.settings;
  }

  log("Loaded settings", settings);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const nextState = changes.aiStudyAssistantState?.newValue;

  if (!nextState?.settings) {
    return;
  }

  settings = nextState.settings;
  log("Settings changed", settings);
  scheduleApply("settings changed");
});

async function initialize() {
  ensureStyle();
  attachScrollGuards();
  await loadState();
  startObserver();
  window.addEventListener("yt-navigate-finish", handleNavigateFinish);
  log("Listening for yt-navigate-finish");
  scheduleApply("initial load");
}

function initializeWhenBodyExists() {
  if (!document.body) {
    requestAnimationFrame(initializeWhenBodyExists);
    return;
  }

  initialize();
}

initializeWhenBodyExists();
