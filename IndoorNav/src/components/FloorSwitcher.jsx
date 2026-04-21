/* ============================================================
 * FloorSwitcher.jsx — Vertical floor picker on the map
 *
 * Props:
 *   building      — full building JSON
 *   currentFloor  — currently displayed floor number
 *   onFloorChange — (floorNumber) => void
 *   path          — current path (array of room objs) or null
 *
 * Exposes: window.FloorSwitcher
 * ============================================================ */
(function () {
  'use strict';

  const { useMemo } = React;

  // Abbreviate a floor label for the compact pill button.
  function abbreviateFloor(floor) {
    if (!floor) return '?';
    if (floor.floorNumber === 0) return 'B';
    return String(floor.floorNumber);
  }

  function FloorSwitcher(props) {
    const { building, currentFloor, onFloorChange, path } = props;

    // Which floors does the current path touch? Used to draw a dot
    // indicator on each affected floor button.
    const pathFloors = useMemo(() => {
      const set = new Set();
      if (Array.isArray(path)) {
        path.forEach((room) => {
          if (room && typeof room.floor === 'number') set.add(room.floor);
        });
      }
      return set;
    }, [path]);

    if (!building || !Array.isArray(building.floors)) return null;

    // Display top-to-bottom with the highest floor first (9 at top, B at bottom).
    const floors = building.floors.slice().sort((a, b) => b.floorNumber - a.floorNumber);

    return (
      <div className="floor-switcher" role="toolbar" aria-label="Floor selector">
        {floors.map((floor) => {
          const isActive = floor.floorNumber === currentFloor;
          const hasPath = pathFloors.has(floor.floorNumber);
          return (
            <button
              key={floor.floorNumber}
              type="button"
              className={`floor-btn${isActive ? ' active' : ''}`}
              title={floor.label}
              aria-label={floor.label}
              aria-pressed={isActive}
              onClick={() => onFloorChange(floor.floorNumber)}
            >
              {abbreviateFloor(floor)}
              {hasPath && <span className="floor-btn-dot" />}
            </button>
          );
        })}
      </div>
    );
  }

  window.FloorSwitcher = FloorSwitcher;
})();
