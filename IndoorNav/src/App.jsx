/* ============================================================
 * App.jsx — Root IndoorNav component
 *
 * Wires together SearchBar, FloorSwitcher, RoomPanel, and
 * IndoorMap. Handles search, pathfinding, and mode switching.
 *
 * Exposes: window.App
 * ============================================================ */
(function () {
  'use strict';

  const { useState, useEffect, useCallback, useMemo } = React;

  // ----- small helpers -----
  function floorLabel(building, n) {
    if (typeof window.getFloorLabel === 'function') {
      return window.getFloorLabel(building, n);
    }
    return 'Floor ' + n;
  }

  function App() {
    // ---------- State ----------
    const [building, setBuilding] = useState(null);
    const [currentFloor, setCurrentFloor] = useState(1);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [selectedRoom, setSelectedRoom] = useState(null);
    const [origin, setOrigin] = useState(null);
    const [destination, setDestination] = useState(null);
    const [path, setPath] = useState(null);
    const [pathError, setPathError] = useState(null);
    const [mode, setMode] = useState('browse');
    const [highlightIds, setHighlightIds] = useState(new Set());

    // ---------- Load building ----------
    useEffect(() => {
      if (window.__SCIENCE_CENTER__) {
        setBuilding(window.__SCIENCE_CENTER__);
      } else {
        // In case data loads slightly later, poll briefly.
        const id = setInterval(() => {
          if (window.__SCIENCE_CENTER__) {
            setBuilding(window.__SCIENCE_CENTER__);
            clearInterval(id);
          }
        }, 50);
        return () => clearInterval(id);
      }
    }, []);

    // ---------- Search ----------
    useEffect(() => {
      if (!building || typeof window.searchRooms !== 'function') {
        setSearchResults([]);
        setHighlightIds(new Set());
        return;
      }
      const results = window.searchRooms(searchQuery, building) || [];
      setSearchResults(results);
      // Highlight every matching room on the current floor.
      setHighlightIds(new Set(results.map((r) => r.id)));
    }, [searchQuery, building]);

    // ---------- Pathfinding ----------
    useEffect(() => {
      if (mode !== 'navigate' || !origin || !destination || !building) {
        setPath(null);
        setPathError(null);
        return;
      }
      if (typeof window.findPathSC !== 'function') {
        setPath(null);
        setPathError('Pathfinding unavailable.');
        return;
      }
      const result = window.findPathSC(origin.id, destination.id, building);
      setPath(result.path);
      setPathError(result.error);
    }, [origin, destination, mode, building]);

    // ---------- Handlers ----------
    const handleRoomClick = useCallback((room) => {
      if (!room) return;
      setSelectedRoom(room);
      if (typeof room.floor === 'number') setCurrentFloor(room.floor);

      if (mode === 'navigate') {
        // Cycle through: no origin -> origin -> destination -> reset
        if (!origin) {
          setOrigin(room);
        } else if (!destination) {
          if (room.id === origin.id) {
            // Clicking the origin again clears it.
            setOrigin(null);
          } else {
            setDestination(room);
          }
        } else {
          // Both set: start a new route with this as the origin.
          setOrigin(room);
          setDestination(null);
        }
      }
    }, [mode, origin, destination]);

    const handleResultClick = useCallback((room) => {
      if (!room) return;
      setSelectedRoom(room);
      if (typeof room.floor === 'number') setCurrentFloor(room.floor);

      if (mode === 'navigate') {
        if (!origin) {
          setOrigin(room);
        } else if (!destination) {
          if (room.id === origin.id) {
            setOrigin(null);
          } else {
            setDestination(room);
          }
        } else {
          setOrigin(room);
          setDestination(null);
        }
      }
    }, [mode, origin, destination]);

    const handleSetOrigin = useCallback((room) => {
      setMode('navigate');
      setOrigin(room);
    }, []);

    const handleSetDestination = useCallback((room) => {
      setMode('navigate');
      setDestination(room);
    }, []);

    const handleModeChange = useCallback((next) => {
      setMode(next);
      if (next === 'browse') {
        // Clear navigation state when leaving navigate mode.
        setPath(null);
        setPathError(null);
      }
    }, []);

    const handleSwapEndpoints = useCallback(() => {
      setOrigin(destination);
      setDestination(origin);
    }, [origin, destination]);

    // ---------- Derived ----------
    const pathSummary = useMemo(() => {
      if (!Array.isArray(path) || path.length === 0) return null;
      const floorsCrossed = new Set();
      path.forEach((r) => {
        if (r && typeof r.floor === 'number') floorsCrossed.add(r.floor);
      });
      return {
        hops: path.length - 1,
        floors: floorsCrossed.size
      };
    }, [path]);

    // ---------- Loading state ----------
    if (!building) {
      return (
        <div className="loader">
          <div className="spinner" />
          <div className="loader-text">Loading Harvard Science Center…</div>
        </div>
      );
    }

    const IndoorMap = window.IndoorMap;
    const SearchBar = window.SearchBar;
    const FloorSwitcher = window.FloorSwitcher;
    const RoomPanel = window.RoomPanel;

    return (
      <div className="app">
        {/* ========== Header ========== */}
        <header className="header">
          <div className="header-left">
            <div className="header-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11" />
              </svg>
            </div>
            <div className="header-title">
              <h1>IndoorNav</h1>
              <span>{building.name}</span>
            </div>
          </div>
          <div className="header-right">
            <span className="header-badge">Live</span>
          </div>
        </header>

        {/* ========== Sidebar ========== */}
        <aside className="sidebar">
          {/* Mode toggle */}
          <div className={`mode-toggle ${mode}`} role="tablist">
            <span className="mode-toggle-slider" />
            <button
              type="button"
              role="tab"
              className={mode === 'browse' ? 'active' : ''}
              onClick={() => handleModeChange('browse')}
              aria-selected={mode === 'browse'}
            >
              <span>🔍</span> Browse
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'navigate' ? 'active' : ''}
              onClick={() => handleModeChange('navigate')}
              aria-selected={mode === 'navigate'}
            >
              <span>🗺️</span> Navigate
            </button>
          </div>

          {/* Search */}
          {SearchBar && (
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <span>Search</span>
                {searchResults.length > 0 && (
                  <span className="count">{searchResults.length} results</span>
                )}
              </div>
              <SearchBar
                query={searchQuery}
                onQueryChange={setSearchQuery}
                results={searchResults}
                onResultClick={handleResultClick}
                selectedRoom={selectedRoom}
                mode={mode}
              />
            </div>
          )}

          {/* Navigate-mode: Origin/Destination + Path */}
          {mode === 'navigate' && (
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <span>Route</span>
                {origin && destination && (
                  <button
                    type="button"
                    className="count"
                    style={{ cursor: 'pointer', color: 'var(--crimson-bright)', background: 'none', border: 'none' }}
                    onClick={handleSwapEndpoints}
                    title="Swap start and destination"
                  >
                    ⇅ Swap
                  </button>
                )}
              </div>
              <div className="path-panel">
                <div className="path-endpoints">
                  {/* Origin */}
                  <div className={`endpoint-card ${origin ? 'origin' : 'empty'}`}>
                    <div className="endpoint-icon">A</div>
                    <div className="endpoint-info">
                      <div className="endpoint-label">Start</div>
                      <div className="endpoint-name">
                        {origin ? origin.name : 'Select a starting room'}
                      </div>
                      {origin && (
                        <div className="endpoint-floor">
                          {floorLabel(building, origin.floor)}
                        </div>
                      )}
                    </div>
                    {origin && (
                      <button
                        type="button"
                        className="endpoint-clear"
                        onClick={() => setOrigin(null)}
                        title="Clear start"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Destination */}
                  <div className={`endpoint-card ${destination ? 'destination' : 'empty'}`}>
                    <div className="endpoint-icon">B</div>
                    <div className="endpoint-info">
                      <div className="endpoint-label">Destination</div>
                      <div className="endpoint-name">
                        {destination ? destination.name : 'Select a destination'}
                      </div>
                      {destination && (
                        <div className="endpoint-floor">
                          {floorLabel(building, destination.floor)}
                        </div>
                      )}
                    </div>
                    {destination && (
                      <button
                        type="button"
                        className="endpoint-clear"
                        onClick={() => setDestination(null)}
                        title="Clear destination"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* Path error */}
                {pathError && (
                  <div className="path-error">
                    <span>⚠️</span>
                    <span>{pathError}</span>
                  </div>
                )}

                {/* Path summary */}
                {pathSummary && !pathError && (
                  <div className="path-summary">
                    <span>
                      <strong>{pathSummary.hops}</strong> hop{pathSummary.hops !== 1 ? 's' : ''}
                    </span>
                    <span>
                      <strong>{pathSummary.floors}</strong> floor{pathSummary.floors !== 1 ? 's' : ''} crossed
                    </span>
                  </div>
                )}

                {/* Path steps */}
                {Array.isArray(path) && path.length > 0 && (
                  <div className="path-steps">
                    {path.map((step, i) => {
                      const prev = i > 0 ? path[i - 1] : null;
                      const floorChange = prev && prev.floor !== step.floor;
                      const goingUp = prev && step.floor > prev.floor;
                      const isFirst = i === 0;
                      const isLast = i === path.length - 1;
                      const stepClass =
                        'path-step' +
                        (isFirst ? ' first' : '') +
                        (isLast ? ' last' : '');

                      return (
                        <div
                          key={step.id + '-' + i}
                          className={stepClass}
                          style={{ animationDelay: (i * 30) + 'ms' }}
                          onClick={() => {
                            setSelectedRoom(step);
                            setCurrentFloor(step.floor);
                          }}
                        >
                          <div className="path-step-index">{i + 1}</div>
                          <div className="path-step-body">
                            <span className="path-step-name">{step.name}</span>
                            <span className="path-step-meta">
                              {floorLabel(building, step.floor)} · {step.type}
                            </span>
                          </div>
                          {floorChange ? (
                            <span className="path-step-floor-change">
                              {goingUp ? '🔼' : '🔽'} F{step.floor}
                            </span>
                          ) : (
                            <span className="path-step-chevron">›</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* ========== Map ========== */}
        <main className="map-area">
          <div className="map-inner map-light-mode">
            {/* Floor label pill */}
            <div className="map-floor-label">
              <span className="dot" />
              {floorLabel(building, currentFloor)}
            </div>

            {/* SVG map */}
            <div className="map-svg-host">
              {IndoorMap ? (
                <IndoorMap
                  building={building}
                  floorNumber={currentFloor}
                  path={path}
                  selectedRoom={selectedRoom}
                  onRoomClick={handleRoomClick}
                  highlightIds={highlightIds}
                />
              ) : (
                <div className="loader-text" style={{ color: 'var(--text-muted)' }}>
                  Map component not loaded.
                </div>
              )}
            </div>

            {/* Floor switcher */}
            {FloorSwitcher && (
              <FloorSwitcher
                building={building}
                currentFloor={currentFloor}
                onFloorChange={setCurrentFloor}
                path={path}
              />
            )}

            {/* Room detail panel */}
            {selectedRoom && RoomPanel && (
              <RoomPanel
                room={selectedRoom}
                building={building}
                onSetOrigin={handleSetOrigin}
                onSetDestination={handleSetDestination}
                origin={origin}
                destination={destination}
                onClose={() => setSelectedRoom(null)}
              />
            )}
          </div>
        </main>
      </div>
    );
  }

  window.App = App;
})();
