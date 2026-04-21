// map.js — SVG floor plan renderer for Harvard Science Center indoor navigation
// ES module; consumed by app.js via import { initMap, renderFloor, ... }

const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let _building = null;     // full /api/building response
let _activeFloor = null;  // integer floor number
let _currentPath = null;  // last /api/path response, or null

// ---------------------------------------------------------------------------
// Fill map by room type
// ---------------------------------------------------------------------------
const FILL_MAP = {
  lecture:   "#fde2d6",
  classroom: "#e4e7f5",
  office:    "#f3e8d2",
  lab:       "#dcead7",
  library:   "#eadcf3",
  study:     "#dcecf3",
  lobby:     "#f8f0c9",
  amenity:   "#fce4ec",
  corridor:  "#f2f2f2",
  stairwell: "#cfd8dc",
  elevator:  "#cfd8dc",
};
const FILL_DEFAULT = "#ececec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function clearLayer(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * initMap(buildingJson)
 * Store building data and inject defs (filters + pattern) into #svg-defs.
 */
export function initMap(buildingJson) {
  _building = buildingJson;

  const defs = document.getElementById("svg-defs");
  if (!defs) return;

  // ---- 1. Glow filter for route ----------------------------------------
  const routeGlow = svgEl("filter");
  routeGlow.setAttribute("id", "route-glow");
  routeGlow.setAttribute("x", "-50%");
  routeGlow.setAttribute("y", "-50%");
  routeGlow.setAttribute("width", "200%");
  routeGlow.setAttribute("height", "200%");

  const blur = svgEl("feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "3");
  blur.setAttribute("result", "blur");

  const merge = svgEl("feMerge");
  const mn1 = svgEl("feMergeNode");
  mn1.setAttribute("in", "blur");
  const mn2 = svgEl("feMergeNode");
  mn2.setAttribute("in", "SourceGraphic");
  merge.appendChild(mn1);
  merge.appendChild(mn2);

  routeGlow.appendChild(blur);
  routeGlow.appendChild(merge);
  defs.appendChild(routeGlow);

  // ---- 2. Drop-shadow filter for pins ------------------------------------
  const pinShadow = svgEl("filter");
  pinShadow.setAttribute("id", "pin-shadow");
  pinShadow.setAttribute("x", "-50%");
  pinShadow.setAttribute("y", "-50%");
  pinShadow.setAttribute("width", "200%");
  pinShadow.setAttribute("height", "200%");

  const dropShadow = svgEl("feDropShadow");
  dropShadow.setAttribute("dx", "0");
  dropShadow.setAttribute("dy", "2");
  dropShadow.setAttribute("stdDeviation", "2");
  dropShadow.setAttribute("flood-opacity", "0.3");

  pinShadow.appendChild(dropShadow);
  defs.appendChild(pinShadow);

  // ---- 3. Diagonal hatch pattern for stairwells/elevators ---------------
  const stairHatch = svgEl("pattern");
  stairHatch.setAttribute("id", "stair-hatch");
  stairHatch.setAttribute("width", "6");
  stairHatch.setAttribute("height", "6");
  stairHatch.setAttribute("patternUnits", "userSpaceOnUse");
  stairHatch.setAttribute("patternTransform", "rotate(45)");

  const hatchLine = svgEl("line");
  hatchLine.setAttribute("x1", "0");
  hatchLine.setAttribute("y1", "0");
  hatchLine.setAttribute("x2", "0");
  hatchLine.setAttribute("y2", "6");
  hatchLine.setAttribute("stroke", "#aaa");
  hatchLine.setAttribute("stroke-width", "1.5");

  stairHatch.appendChild(hatchLine);
  defs.appendChild(stairHatch);
}

/**
 * renderFloor(floorNumber)
 * Clear all layers and redraw rooms/labels for the given floor.
 */
export function renderFloor(floorNumber) {
  _activeFloor = floorNumber;

  // Clear all 5 layers
  clearLayer("layer-rooms");
  clearLayer("layer-corridors");
  clearLayer("layer-labels");
  clearLayer("layer-route");
  clearLayer("layer-pins");

  if (!_building || !_building.floors) return;

  const floor = _building.floors.find(f => f.floorNumber === floorNumber);
  if (!floor) return;

  const layerRooms     = document.getElementById("layer-rooms");
  const layerCorridors = document.getElementById("layer-corridors");
  const layerLabels    = document.getElementById("layer-labels");

  for (const room of floor.rooms) {
    const cx = room.pixelCoords.x;
    const cy = room.pixelCoords.y;

    if (room.type === "corridor") {
      // Small circle node
      const circle = svgEl("circle");
      circle.setAttribute("cx", cx);
      circle.setAttribute("cy", cy);
      circle.setAttribute("r", "5");
      circle.setAttribute("fill", "#ddd");
      circle.setAttribute("stroke", "#aaa");
      circle.setAttribute("stroke-width", "0.8");
      layerCorridors.appendChild(circle);
      // No label for corridors
      continue;
    }

    // Room rectangle
    const fill = FILL_MAP[room.type] || FILL_DEFAULT;
    const rx = cx - 35;
    const ry = cy - 25;

    const rect = svgEl("rect");
    rect.setAttribute("x", rx);
    rect.setAttribute("y", ry);
    rect.setAttribute("width", "70");
    rect.setAttribute("height", "50");
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", fill);
    rect.setAttribute("stroke", "#2c2c2c");
    rect.setAttribute("stroke-width", "1.5");
    layerRooms.appendChild(rect);

    // Hatch overlay for stairwells and elevators
    if (room.type === "stairwell" || room.type === "elevator") {
      const hatch = svgEl("rect");
      hatch.setAttribute("x", rx);
      hatch.setAttribute("y", ry);
      hatch.setAttribute("width", "70");
      hatch.setAttribute("height", "50");
      hatch.setAttribute("fill", "url(#stair-hatch)");
      hatch.setAttribute("fill-opacity", "0.4");
      hatch.setAttribute("stroke", "none");
      layerRooms.appendChild(hatch);
    }

    // Label
    const rawName = room.name || "";
    const labelText = rawName.length > 18 ? rawName.slice(0, 18) + "…" : rawName;

    const text = svgEl("text");
    text.setAttribute("x", cx);
    text.setAttribute("y", cy + 4);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "10");
    text.setAttribute("fill", "#333");
    text.setAttribute("font-family", "system-ui");
    text.textContent = labelText;
    layerLabels.appendChild(text);
  }

  // Re-draw route if one is active
  if (_currentPath !== null) {
    _drawRoute();
  }
}

/**
 * setActiveFloor(floorNumber)
 * Render the floor and update floor-button active class.
 */
export function setActiveFloor(floorNumber) {
  renderFloor(floorNumber);

  // Update floor button active states
  const buttons = document.querySelectorAll(".floor-btn");
  buttons.forEach(btn => {
    btn.classList.remove("floor-btn--active");
    // data-floor may be stored as a string; compare loosely
    if (String(btn.dataset.floor) === String(floorNumber)) {
      btn.classList.add("floor-btn--active");
    }
  });
}

/**
 * renderPath(pathJson)
 * Store path and draw the route on the active floor.
 */
export function renderPath(pathJson) {
  _currentPath = pathJson;
  _drawRoute();
}

/**
 * clearPath()
 * Remove path data and clear route/pin layers.
 */
export function clearPath() {
  _currentPath = null;
  clearLayer("layer-route");
  clearLayer("layer-pins");
}

/**
 * getActiveFloor()
 * Return current active floor number.
 */
export function getActiveFloor() {
  return _activeFloor;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * _drawPin(layerEl, cx, cy, color, letter)
 * Draw a Google-Maps-style pin (circle head + triangle pointer).
 */
function _drawPin(layerEl, cx, cy, color, letter) {
  const g = svgEl("g");
  g.setAttribute("transform", `translate(${cx},${cy})`);

  // Circle head
  const circle = svgEl("circle");
  circle.setAttribute("cx", "0");
  circle.setAttribute("cy", "-20");
  circle.setAttribute("r", "14");
  circle.setAttribute("fill", color);
  circle.setAttribute("filter", "url(#pin-shadow)");

  // Pointer triangle (points downward)
  const triangle = svgEl("polygon");
  triangle.setAttribute("points", "0,0 -8,-14 8,-14");
  triangle.setAttribute("fill", color);

  // Letter label
  const text = svgEl("text");
  text.setAttribute("x", "0");
  text.setAttribute("y", "-16");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", "11");
  text.setAttribute("font-weight", "bold");
  text.setAttribute("fill", "white");
  text.textContent = letter;

  g.appendChild(circle);
  g.appendChild(triangle);
  g.appendChild(text);
  layerEl.appendChild(g);
}

/**
 * _drawRoute()
 * Internal: render polyline and pins for _currentPath on _activeFloor.
 */
function _drawRoute() {
  clearLayer("layer-route");
  clearLayer("layer-pins");

  if (!_currentPath || !_currentPath.path || _currentPath.path.length === 0) {
    return;
  }

  const path = _currentPath.path;

  // Nodes on the active floor
  const floorNodes = path.filter(n => n.floor === _activeFloor);

  if (floorNodes.length >= 2) {
    const points = floorNodes
      .map(n => `${n.pixelCoords.x},${n.pixelCoords.y}`)
      .join(" ");

    const polyline = svgEl("polyline");
    polyline.setAttribute("class", "route-line");
    polyline.setAttribute("filter", "url(#route-glow)");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "#4285f4");
    polyline.setAttribute("stroke-width", "5");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");

    document.getElementById("layer-route").appendChild(polyline);
  }

  const layerPins = document.getElementById("layer-pins");

  // Start pin (green) — only if the first node is on this floor
  const firstNode = path[0];
  if (firstNode.floor === _activeFloor) {
    _drawPin(layerPins, firstNode.pixelCoords.x, firstNode.pixelCoords.y, "#34a853", "A");
  }

  // End pin (red) — only if the last node is on this floor
  const lastNode = path[path.length - 1];
  if (lastNode.floor === _activeFloor) {
    _drawPin(layerPins, lastNode.pixelCoords.x, lastNode.pixelCoords.y, "#ea4335", "B");
  }
}
