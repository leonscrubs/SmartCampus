import { initMap, renderFloor, renderPath, clearPath, setActiveFloor } from "/map.js";

// ── State ──────────────────────────────────────────────────────────────────

let buildingData = null;
let activeFloor = null;

// ── DOM refs ───────────────────────────────────────────────────────────────

const floorSelector  = document.getElementById("floor-selector");
const statusBanner   = document.getElementById("status-banner");
const infoPanel      = document.getElementById("info-panel");
const infoContent    = document.getElementById("info-content");
const infoClose      = document.getElementById("info-close");
const goBtn          = document.getElementById("go-btn");
const searchFrom     = document.getElementById("search-from");
const searchTo       = document.getElementById("search-to");
const suggestionsFrom = document.getElementById("suggestions-from");
const suggestionsTo   = document.getElementById("suggestions-to");

// ── Utility ────────────────────────────────────────────────────────────────

function showBanner(msg, durationMs = 3000) {
  statusBanner.textContent = msg;
  statusBanner.hidden = false;
  clearTimeout(showBanner._timer);
  showBanner._timer = setTimeout(() => {
    statusBanner.hidden = true;
  }, durationMs);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ── Floor buttons ──────────────────────────────────────────────────────────

function buildFloorSelector(floors) {
  floorSelector.innerHTML = "";
  // Sort descending so highest floor is at the top (like an elevator panel)
  const sorted = [...floors].sort((a, b) => b - a);
  sorted.forEach(floor => {
    const btn = document.createElement("button");
    btn.className = "floor-btn";
    btn.dataset.floor = floor;
    btn.textContent = floor;
    btn.setAttribute("aria-label", `Floor ${floor}`);
    btn.addEventListener("click", () => handleFloorSelect(floor));
    floorSelector.appendChild(btn);
  });
}

function handleFloorSelect(floorNum) {
  activeFloor = floorNum;
  updateFloorButtons();
  setActiveFloor(floorNum);
}

function updateFloorButtons() {
  floorSelector.querySelectorAll(".floor-btn").forEach(btn => {
    const isActive = parseInt(btn.dataset.floor, 10) === activeFloor;
    btn.classList.toggle("floor-btn--active", isActive);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  let data;
  try {
    const res = await fetch("/api/building");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    showBanner("Could not load building data.", 6000);
    console.error("Failed to fetch /api/building:", err);
    return;
  }

  buildingData = data;
  initMap(data);

  // Collect unique floor numbers
  const floors = Array.from(
    new Set((data.rooms || []).map(r => r.floor).filter(f => f != null))
  ).sort((a, b) => a - b);

  buildFloorSelector(floors);

  // Default to floor 1, fallback to first available
  const defaultFloor = floors.includes(1) ? 1 : (floors[0] ?? 0);
  activeFloor = defaultFloor;
  updateFloorButtons();
  setActiveFloor(defaultFloor);
}

// ── Search / suggestions ───────────────────────────────────────────────────

async function fetchSuggestions(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  return await res.json();
}

function buildSuggestionItem(room) {
  const el = document.createElement("div");
  el.className = "suggestion-item";
  el.dataset.roomId   = room.id;
  el.dataset.roomName = room.name;

  const nameSpan = document.createElement("span");
  nameSpan.className = "suggestion-item-name";
  nameSpan.textContent = room.name;

  const floorSpan = document.createElement("span");
  floorSpan.className = "suggestion-floor";
  floorSpan.textContent =
    room.floor != null ? `Floor ${room.floor}` : "";

  el.appendChild(nameSpan);
  el.appendChild(floorSpan);
  return el;
}

function populateSuggestions(container, input, rooms) {
  container.innerHTML = "";
  if (!rooms || rooms.length === 0) {
    container.hidden = true;
    return;
  }
  rooms.forEach(room => {
    const item = buildSuggestionItem(room);
    item.addEventListener("mousedown", e => {
      // Use mousedown so it fires before the blur event hides the list
      e.preventDefault();
      input.value = room.name;
      input.dataset.roomId = room.id;
      container.hidden = true;
    });
    container.appendChild(item);
  });
  container.hidden = false;
}

function makeSearchHandler(input, suggestionsDiv) {
  return debounce(async () => {
    const q = input.value.trim();
    // Clear stored roomId whenever the user edits
    delete input.dataset.roomId;

    if (q.length < 1) {
      suggestionsDiv.hidden = true;
      return;
    }
    try {
      const results = await fetchSuggestions(q);
      populateSuggestions(suggestionsDiv, input, results);
    } catch {
      suggestionsDiv.hidden = true;
    }
  }, 150);
}

searchFrom.addEventListener("input", makeSearchHandler(searchFrom, suggestionsFrom));
searchTo.addEventListener("input",   makeSearchHandler(searchTo,   suggestionsTo));

// Hide suggestions on blur (small delay so mousedown on item fires first)
searchFrom.addEventListener("blur", () => setTimeout(() => { suggestionsFrom.hidden = true; }, 150));
searchTo.addEventListener("blur",   () => setTimeout(() => { suggestionsTo.hidden = true;   }, 150));

// ── Navigate ───────────────────────────────────────────────────────────────

goBtn.addEventListener("click", async () => {
  const fromId = searchFrom.dataset.roomId;
  const toId   = searchTo.dataset.roomId;

  if (!fromId || !toId) {
    showBanner("Please select a start and destination from the suggestions.");
    return;
  }

  clearPath();
  infoPanel.hidden = true;

  let pathData;
  try {
    const res = await fetch(`/api/path?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pathData = await res.json();
  } catch (err) {
    showBanner("Could not fetch route. Please try again.");
    console.error("Failed to fetch /api/path:", err);
    return;
  }

  const path = pathData.path || [];
  if (path.length === 0) {
    showBanner("No route found.");
    return;
  }

  renderPath(pathData);

  // Jump to the first floor of the route
  const startFloor = path[0].floor;
  activeFloor = startFloor;
  updateFloorButtons();
  setActiveFloor(startFloor);

  // Build trip summary
  const uniqueFloors = [...new Set(path.map(p => p.floor).filter(f => f != null))];
  const stepCount = path.length;

  infoContent.innerHTML = "";

  const title = document.createElement("div");
  title.className = "info-content-title";
  title.textContent = "Route found";

  const detail = document.createElement("div");
  detail.className = "info-content-detail";
  detail.textContent = `${stepCount} step${stepCount !== 1 ? "s" : ""} across floor${uniqueFloors.length !== 1 ? "s" : ""} `;

  const floorChips = document.createElement("div");
  floorChips.className = "info-content-floors";
  uniqueFloors.sort((a, b) => a - b).forEach(f => {
    const chip = document.createElement("span");
    chip.className = "floor-chip";
    chip.textContent = `Floor ${f}`;
    floorChips.appendChild(chip);
  });

  infoContent.appendChild(title);
  infoContent.appendChild(detail);
  infoContent.appendChild(floorChips);

  infoPanel.hidden = false;
});

// ── Info panel close ───────────────────────────────────────────────────────

infoClose.addEventListener("click", () => {
  infoPanel.hidden = true;
  clearPath();
});

// ── Hide suggestions when clicking outside ─────────────────────────────────

document.addEventListener("click", e => {
  if (!e.target.closest(".search-field")) {
    suggestionsFrom.hidden = true;
    suggestionsTo.hidden   = true;
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
