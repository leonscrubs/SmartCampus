/* ============================================================
 * RoomPanel.jsx — Slide-in details panel for a selected room
 *
 * Props:
 *   room           — selected room object (may be null)
 *   building       — full building JSON
 *   onSetOrigin    — (room) => void
 *   onSetDestination — (room) => void
 *   origin         — current origin room (for highlight)
 *   destination    — current destination room (for highlight)
 *   onClose        — () => void
 *
 * Exposes: window.RoomPanel
 * ============================================================ */
(function () {
  'use strict';

  // Reuse the floor-label helper exposed by search.js if available.
  function floorLabel(building, floorNumber) {
    if (typeof window.getFloorLabel === 'function') {
      return window.getFloorLabel(building, floorNumber);
    }
    return 'Floor ' + floorNumber;
  }

  function RoomPanel(props) {
    const {
      room,
      building,
      onSetOrigin,
      onSetDestination,
      origin,
      destination,
      onClose
    } = props;

    if (!room) return null;

    const isRenovation = room.status === 'renovation';
    const typeClass = `type-badge type-${room.type || 'unknown'}`;
    const statusClass = `status-badge ${isRenovation ? 'renovation' : 'active'}`;
    const statusLabel = isRenovation ? 'Renovation' : 'Active';
    const label = floorLabel(building, room.floor);

    const isOrigin = origin && origin.id === room.id;
    const isDestination = destination && destination.id === room.id;

    return (
      <div className="room-panel" role="dialog" aria-label={`Room ${room.name}`}>
        {/* Breadcrumb + close */}
        <div className="room-panel-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="room-panel-breadcrumb">
              <span>Harvard Science Center</span>
              <span className="crumb-sep">›</span>
              <span>{label}</span>
              <span className="crumb-sep">›</span>
              <span style={{ color: 'var(--text-secondary)' }}>{room.name}</span>
            </div>
            <div className="room-panel-title">{room.name}</div>
            <div className="room-panel-meta">
              <span className={typeClass}>{room.type}</span>
              <span className="result-floor" style={{ color: 'var(--text-secondary)' }}>
                {label}
              </span>
              <span className={statusClass}>
                <span className="dot" />
                {statusLabel}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="room-panel-close"
            onClick={onClose}
            aria-label="Close details"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Renovation warning */}
        {isRenovation && (
          <div className="room-panel-warning">
            <span style={{ fontSize: '14px' }}>⚠️</span>
            <span>This room is currently closed for renovation</span>
          </div>
        )}

        {/* Description */}
        {room.description && (
          <div className="room-panel-description">{room.description}</div>
        )}

        {/* Actions */}
        <div className="room-panel-actions">
          <button
            type="button"
            className={`btn btn-secondary${isOrigin ? ' active' : ''}`}
            onClick={() => onSetOrigin(room)}
            disabled={isRenovation}
            title={isRenovation ? 'Unavailable' : 'Set as start'}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <circle cx="12" cy="12" r="10" opacity="0.35" />
            </svg>
            {isOrigin ? 'Current Start' : 'Set as Start'}
          </button>
          <button
            type="button"
            className={`btn btn-primary${isDestination ? ' active' : ''}`}
            onClick={() => onSetDestination(room)}
            disabled={isRenovation}
            title={isRenovation ? 'Unavailable' : 'Set as destination'}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            {isDestination ? 'Current End' : 'Set as Destination'}
          </button>
        </div>
      </div>
    );
  }

  window.RoomPanel = RoomPanel;
})();
