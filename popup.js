import { STORAGE_KEY, getState, updateState } from "./storage.js";

const focusModeInput = document.getElementById("focusModeEnabled");
const homepageOverrideInput = document.getElementById("homepageOverrideEnabled");
const videosBlockedElement = document.getElementById("videosBlocked");
const recommendationClicksElement = document.getElementById("recommendationClicksPrevented");
const focusedMinutesElement = document.getElementById("totalFocusedMinutes");
const statusElement = document.getElementById("status");
const chartCanvas = document.getElementById("analyticsChart");

let analyticsChart = null;

function setStatus(message) {
  statusElement.textContent = message || "";
}

function renderStats(analytics) {
  videosBlockedElement.textContent = String(analytics.videosBlocked || 0);
  recommendationClicksElement.textContent = String(analytics.recommendationClicksPrevented || 0);
  focusedMinutesElement.textContent = String(analytics.totalFocusedMinutes || 0);
}

function renderSettings(settings) {
  focusModeInput.checked = Boolean(settings.focusModeEnabled);
  homepageOverrideInput.checked = Boolean(settings.homepageOverrideEnabled);
}

function getChartData(analytics) {
  return {
    labels: [
      "Videos Blocked",
      "Clicks Prevented",
      "Focused Minutes"
    ],
    datasets: [
      {
        label: "Phase 1 Analytics",
        data: [
          Number(analytics.videosBlocked || 0),
          Number(analytics.recommendationClicksPrevented || 0),
          Number(analytics.totalFocusedMinutes || 0)
        ],
        backgroundColor: ["#1f6feb", "#d1242f", "#2da44e"],
        borderWidth: 0
      }
    ]
  };
}

function renderChart(analytics) {
  /*
   * Chart.js is intentionally optional at runtime. Enterprise MV3 packages
   * should vendor third-party scripts locally and pin versions. If the local
   * vendor file is not present yet, the dashboard still exposes the same state
   * through stat cards while Phase 2 features are developed.
   */
  if (!window.Chart) {
    setStatus("Chart.js vendor file not found; showing stat cards only.");
    return;
  }

  const chartData = getChartData(analytics);

  if (analyticsChart) {
    analyticsChart.data = chartData;
    analyticsChart.update();
    return;
  }

  analyticsChart = new window.Chart(chartCanvas, {
    type: "bar",
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0
          }
        }
      }
    }
  });

  setStatus("");
}

function renderState(state) {
  renderSettings(state.settings);
  renderStats(state.analytics);
  renderChart(state.analytics);
}

async function saveSettings(patch) {
  const nextState = await updateState((state) => {
    state.settings = {
      ...state.settings,
      ...patch
    };
    return state;
  });

  renderState(nextState);
}

focusModeInput.addEventListener("change", () => {
  saveSettings({ focusModeEnabled: focusModeInput.checked });
});

homepageOverrideInput.addEventListener("change", () => {
  saveSettings({ homepageOverrideEnabled: homepageOverrideInput.checked });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const nextState = changes[STORAGE_KEY]?.newValue;

  if (nextState) {
    renderState(nextState);
  }
});

getState().then(renderState);
