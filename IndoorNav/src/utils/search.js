/* ============================================================
 * search.js — Fuzzy room search utility for IndoorNav
 *
 * Depends on Fuse.js loaded via CDN as `window.Fuse`.
 * Exposes three helpers on window:
 *   - window.buildRoomIndex(building)
 *   - window.searchRooms(query, building, options)
 *   - window.getFloorLabel(building, floorNumber)
 *
 * Loaded as <script type="text/babel"> before React components.
 * ============================================================ */
(function () {
  'use strict';

  // Room types that should appear in search results.
  // Corridor/stairwell/elevator are "transit" nodes — useful for
  // pathfinding but shouldn't clutter the user-facing search list.
  var SEARCHABLE_TYPES = [
    'lecture',
    'classroom',
    'office',
    'lab',
    'library',
    'study',
    'lobby',
    'amenity'
  ];

  // Max results returned for a non-empty query.
  var MAX_QUERY_RESULTS = 8;
  // Max results returned when the query is blank (show-all mode).
  var MAX_BLANK_RESULTS = 20;

  /**
   * Flatten every floor's rooms into a single {id: room} map.
   * Useful for O(1) lookups and as the input to Fuse.
   */
  function buildRoomIndex(building) {
    var index = {};
    if (!building || !Array.isArray(building.floors)) return index;

    for (var i = 0; i < building.floors.length; i++) {
      var floor = building.floors[i];
      if (!floor || !Array.isArray(floor.rooms)) continue;

      for (var j = 0; j < floor.rooms.length; j++) {
        var room = floor.rooms[j];
        if (room && room.id) index[room.id] = room;
      }
    }
    return index;
  }

  /**
   * Look up the human-readable floor label (e.g. "1st Floor") for a
   * given floor number in a building. Falls back to "Floor N".
   */
  function getFloorLabel(building, floorNumber) {
    if (!building || !Array.isArray(building.floors)) {
      return 'Floor ' + floorNumber;
    }
    for (var i = 0; i < building.floors.length; i++) {
      var floor = building.floors[i];
      if (floor && floor.floorNumber === floorNumber) {
        return floor.label || 'Floor ' + floorNumber;
      }
    }
    return 'Floor ' + floorNumber;
  }

  /**
   * Shape a raw room into the compact result object consumed by the UI.
   */
  function shapeResult(room, building) {
    return {
      id: room.id,
      name: room.name,
      type: room.type,
      floor: room.floor,
      floorLabel: getFloorLabel(building, room.floor),
      description: room.description || '',
      status: room.status || 'active'
    };
  }

  /**
   * Keep only rooms whose `type` is user-facing.
   */
  function filterSearchable(rooms) {
    var out = [];
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      if (r && SEARCHABLE_TYPES.indexOf(r.type) !== -1) out.push(r);
    }
    return out;
  }

  /**
   * Fuzzy-search rooms with Fuse.js.
   *
   * - Blank/whitespace query => top 20 rooms sorted by floor then name.
   * - Otherwise => top 8 fuzzy matches across name/id/type/description.
   *
   * `options` is reserved for future use; currently ignored.
   */
  function searchRooms(query, building, options) {
    options = options || {};

    var index = buildRoomIndex(building);
    var allRooms = Object.keys(index).map(function (k) { return index[k]; });
    var searchable = filterSearchable(allRooms);

    // Blank query — show-all mode.
    var q = (query || '').trim();
    if (q.length === 0) {
      var sorted = searchable.slice().sort(function (a, b) {
        if (a.floor !== b.floor) return a.floor - b.floor;
        return (a.name || '').localeCompare(b.name || '');
      });
      return sorted.slice(0, MAX_BLANK_RESULTS).map(function (r) {
        return shapeResult(r, building);
      });
    }

    // Guard: Fuse must be loaded via CDN before this file runs.
    if (typeof window.Fuse !== 'function') {
      console.error('[search.js] Fuse.js is not loaded on window.');
      return [];
    }

    var fuse = new window.Fuse(searchable, {
      threshold: 0.35,
      keys: ['name', 'id', 'type', 'description']
    });

    var hits = fuse.search(q).slice(0, MAX_QUERY_RESULTS);
    return hits.map(function (hit) {
      return shapeResult(hit.item, building);
    });
  }

  // Expose on window — no ES modules in CDN/Babel-standalone setup.
  window.buildRoomIndex = buildRoomIndex;
  window.getFloorLabel = getFloorLabel;
  window.searchRooms = searchRooms;
})();
