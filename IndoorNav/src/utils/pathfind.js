/* ============================================================
 * pathfind.js — BFS pathfinding on the IndoorNav room graph
 *
 * Exposes on window:
 *   - window.findPath(startId, targetId, roomIndex)
 *   - window.findPathSC(startId, targetId, building)
 *
 * Loaded as <script type="text/babel"> before React components.
 * ============================================================ */
(function () {
  'use strict';

  /**
   * Breadth-first search over the room graph defined by the
   * `neighbors` array on each room. Treats edges as unweighted and
   * undirected (we only traverse forward via the neighbors list, which
   * the data is expected to keep symmetric).
   *
   * @param {string} startId
   * @param {string} targetId
   * @param {Object} roomIndex  Map of roomId -> room object.
   * @returns {Array|null}  Array of rooms in path order, or null.
   */
  function findPath(startId, targetId, roomIndex) {
    if (!roomIndex || !roomIndex[startId] || !roomIndex[targetId]) {
      return null;
    }

    // Trivial case.
    if (startId === targetId) return [roomIndex[startId]];

    // `cameFrom` doubles as our visited set (presence = visited).
    var cameFrom = Object.create(null);
    cameFrom[startId] = null;

    var queue = [startId];
    var head = 0; // avoid O(n) shift()

    while (head < queue.length) {
      var currentId = queue[head++];
      var current = roomIndex[currentId];
      if (!current || !Array.isArray(current.neighbors)) continue;

      for (var i = 0; i < current.neighbors.length; i++) {
        var nextId = current.neighbors[i];

        // Skip unknown neighbors (e.g. filtered-out renovation rooms).
        if (!roomIndex[nextId]) continue;
        // Already visited.
        if (nextId in cameFrom) continue;

        cameFrom[nextId] = currentId;

        if (nextId === targetId) {
          // Reconstruct path from target back to start.
          var path = [];
          var cursor = targetId;
          while (cursor !== null) {
            path.push(roomIndex[cursor]);
            cursor = cameFrom[cursor];
          }
          path.reverse();
          return path;
        }

        queue.push(nextId);
      }
    }

    return null;
  }

  /**
   * Build a roomIndex from a building, drop any renovation rooms,
   * scrub their IDs from remaining neighbor lists, then run BFS.
   * Returns a {path, error} result object for the UI to consume.
   */
  function findPathSC(startId, targetId, building) {
    if (!building || !Array.isArray(building.floors)) {
      return { path: null, error: 'Building data is missing or invalid.' };
    }

    // First pass: raw index including renovation rooms so we can give
    // precise error messages ("X is under renovation" vs "X not found").
    var rawIndex = window.buildRoomIndex
      ? window.buildRoomIndex(building)
      : buildRoomIndexFallback(building);

    var rawStart = rawIndex[startId];
    var rawTarget = rawIndex[targetId];

    if (!rawStart) {
      return { path: null, error: 'Starting room not found.' };
    }
    if (!rawTarget) {
      return { path: null, error: 'Destination room not found.' };
    }
    if (rawStart.status === 'renovation') {
      return { path: null, error: 'Starting room is under renovation.' };
    }
    if (rawTarget.status === 'renovation') {
      return { path: null, error: 'Destination is under renovation.' };
    }

    // Second pass: filtered index. Drop renovation rooms entirely and
    // also strip their IDs from the neighbor lists of surviving rooms
    // so BFS cannot traverse through a closed node.
    var renovationIds = Object.create(null);
    Object.keys(rawIndex).forEach(function (id) {
      if (rawIndex[id].status === 'renovation') renovationIds[id] = true;
    });

    var filteredIndex = {};
    Object.keys(rawIndex).forEach(function (id) {
      var room = rawIndex[id];
      if (renovationIds[id]) return;

      var cleanedNeighbors = Array.isArray(room.neighbors)
        ? room.neighbors.filter(function (nid) { return !renovationIds[nid]; })
        : [];

      // Shallow copy so we don't mutate the source data.
      filteredIndex[id] = Object.assign({}, room, { neighbors: cleanedNeighbors });
    });

    var path = findPath(startId, targetId, filteredIndex);
    if (!path) {
      return { path: null, error: 'No accessible path between these rooms.' };
    }

    return { path: path, error: null };
  }

  /**
   * Inline fallback so pathfind.js remains functional even if
   * search.js hasn't been loaded yet. Mirrors buildRoomIndex().
   */
  function buildRoomIndexFallback(building) {
    var index = {};
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

  // Expose on window — no ES modules in CDN/Babel-standalone setup.
  window.findPath = findPath;
  window.findPathSC = findPathSC;
})();
