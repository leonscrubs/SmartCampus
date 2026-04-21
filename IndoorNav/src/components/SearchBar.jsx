/* ============================================================
 * SearchBar.jsx — Search input + results list
 *
 * Props:
 *   query          — current search string
 *   onQueryChange  — (str) => void
 *   results        — array of shaped room results
 *   onResultClick  — (room) => void
 *   selectedRoom   — currently selected room obj (for highlight)
 *   mode           — 'browse' | 'navigate'
 *
 * Exposes: window.SearchBar
 * ============================================================ */
(function () {
  'use strict';

  const { useRef } = React;

  // Truncate a description to a fixed character budget.
  function truncate(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    return str.slice(0, max - 1).trimEnd() + '…';
  }

  function SearchBar(props) {
    const {
      query,
      onQueryChange,
      results,
      onResultClick,
      selectedRoom,
      mode
    } = props;

    const inputRef = useRef(null);

    const hasQuery = (query || '').trim().length > 0;
    const showEmpty = hasQuery && (!results || results.length === 0);

    function handleClear() {
      onQueryChange('');
      if (inputRef.current) inputRef.current.focus();
    }

    return (
      <div className="search-wrapper">
        {/* Input */}
        <div className="search-input-wrapper">
          <svg
            className="search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search rooms, labs, offices…"
            value={query || ''}
            onChange={(e) => onQueryChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {hasQuery && (
            <button
              type="button"
              className="search-clear"
              onClick={handleClear}
              aria-label="Clear search"
              title="Clear"
            >
              ✕
            </button>
          )}
        </div>

        {/* Navigate-mode helper text */}
        {mode === 'navigate' && (
          <div className="search-helper">
            Click a room on the map or in results to set start/end
          </div>
        )}

        {/* Results list */}
        <div className="results-list">
          {showEmpty && (
            <div className="result-empty">
              No rooms found
              {hasQuery && (
                <>
                  {' '}
                  for "<span style={{ color: 'var(--text-secondary)' }}>{query}</span>"
                </>
              )}
            </div>
          )}

          {!showEmpty && results && results.map((room) => {
            const isSelected = selectedRoom && selectedRoom.id === room.id;
            const typeClass = `type-badge type-${room.type || 'unknown'}`;
            const itemStyle = {
              ['--type-color']: `var(--type-${room.type}, var(--crimson))`
            };

            return (
              <div
                key={room.id}
                className={`result-item${isSelected ? ' selected' : ''}`}
                style={itemStyle}
                onClick={() => onResultClick(room)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onResultClick(room);
                  }
                }}
              >
                <div className="result-row">
                  <span className="result-name" title={room.name}>
                    {room.name}
                  </span>
                  <span className="result-floor">{room.floorLabel}</span>
                </div>
                <div className="result-row" style={{ marginTop: 2 }}>
                  <span className={typeClass}>{room.type}</span>
                  <span
                    className="result-description"
                    title={room.description || ''}
                    style={{ flex: 1 }}
                  >
                    {truncate(room.description, 60)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  window.SearchBar = SearchBar;
})();
