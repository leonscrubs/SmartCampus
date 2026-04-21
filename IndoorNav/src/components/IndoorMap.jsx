/* ============================================================
 * IndoorMap.jsx — Apple Maps-style SVG floor plan renderer
 *
 * Self-constructed SVG floor plans (no PNG backgrounds).
 * Rooms are drawn as styled rectangles with type-based tints,
 * accent bars, and zoom-aware labels.
 *
 * Props:
 *   building     — full building JSON (window.__SCIENCE_CENTER__)
 *   floorNumber  — currently displayed floor (integer, 0 = basement)
 *   path         — BFS path array of room objects, or null
 *   selectedRoom — currently selected room object, or null
 *   onRoomClick  — (room) => void
 *   highlightIds — Set<string> of room IDs to highlight (search results)
 *
 * Exposes: window.IndoorMap
 * ============================================================ */
(function () {
  'use strict';

  const { useState, useEffect, useRef, useMemo, useCallback } = React;

  /* ── Per-floor initial viewBox (tight wrap of building footprint + ~80px padding) ── */
  const FLOOR_VIEWBOX = {
    0: { x:  60, y: 170, w: 780, h: 380 },
    1: { x: 200, y: 130, w: 700, h: 360 },
    2: { x: 150, y: 170, w: 720, h: 320 },
    3: { x: 140, y: 120, w:1050, h: 680 },
    4: { x: 200, y: 120, w: 970, h: 640 },
    5: { x: 260, y: 150, w: 610, h: 620 },
    6: { x: 720, y: 480, w: 340, h: 140 },
    7: { x: 720, y: 480, w: 280, h: 120 },
    8: { x: 720, y: 480, w: 220, h: 110 },
    9: { x: 290, y: 180, w: 120, h: 160 },
  };

  /* ── Per-floor building footprint SVG path (white area = inside building) ── */
  const FLOOR_FOOTPRINT = {
    0: 'M 60,430 A 60,100 0 0 1 160,340 L 160,240 L 830,240 L 830,400 L 720,400 L 720,480 L 350,480 L 350,540 L 70,540 Z',
    1: 'M 230,200 L 560,200 L 560,150 L 620,150 L 620,200 L 840,200 L 840,420 L 770,420 L 770,470 L 280,470 L 280,420 L 230,420 Z',
    2: 'M 180,230 L 550,230 L 550,175 L 710,175 L 710,230 L 840,230 L 840,460 L 700,460 L 700,440 L 180,440 Z',
    3: 'M 170,140 L 1150,140 L 1150,260 L 1020,260 L 1020,310 L 1150,310 L 1150,660 L 910,660 L 910,460 L 770,460 L 770,780 L 540,780 L 540,360 L 170,360 Z',
    4: 'M 220,140 L 1130,140 L 1130,290 L 1040,290 L 1040,340 L 1130,340 L 1130,660 L 910,660 L 910,460 L 770,460 L 770,740 L 540,740 L 540,360 L 220,360 Z',
    5: 'M 280,210 L 860,210 L 860,340 L 740,340 L 740,360 L 720,360 L 720,620 L 560,620 L 560,360 L 280,360 Z',
    6: 'M 740,490 L 1060,490 L 1060,600 L 740,600 Z',
    7: 'M 740,490 L 1000,490 L 1000,590 L 740,590 Z',
    8: 'M 740,490 L 940,490 L 940,585 L 740,585 Z',
    9: 'M 310,200 L 390,200 L 390,320 L 310,320 Z',
  };

  /* ── Room cell dimensions by type (coordinate space units) ── */
  const ROOM_DIMS = {
    lecture:   { w: 100, h: 80 },
    classroom: { w:  60, h: 50 },
    lab:       { w:  60, h: 50 },
    library:   { w:  80, h: 60 },
    study:     { w:  45, h: 40 },
    office:    { w:  35, h: 30 },
    amenity:   { w:  60, h: 40 },
    lobby:     { w:  90, h: 60 },
    stairwell: { w:  28, h: 28 },
    elevator:  { w:  28, h: 28 },
  };
  const DEFAULT_DIMS = { w: 34, h: 28 };

  /* ── Light background tint for each room type ── */
  const TYPE_TINT = {
    lecture:   '#fde2e7',
    classroom: '#dbeafe',
    office:    '#f4f4f6',
    lab:       '#d1fae5',
    library:   '#fef3c7',
    study:     '#cffafe',
    lobby:     '#fce7f3',
    amenity:   '#ccfbf1',
    stairwell: '#e2e8f0',
    elevator:  '#e2e8f0',
  };

  /* ── Accent colors (left border + selected fill) ── */
  const TYPE_ACCENT = {
    lecture:   '#e94560',
    classroom: '#3b82f6',
    office:    '#8b5cf6',
    lab:       '#10b981',
    library:   '#f59e0b',
    study:     '#06b6d4',
    lobby:     '#ec4899',
    amenity:   '#14b8a6',
    stairwell: '#64748b',
    elevator:  '#64748b',
  };
  const FALLBACK_ACCENT = '#64748b';
  const FALLBACK_TINT   = '#f4f4f6';

  const TRANSIT_TYPES = new Set(['corridor', 'elevator', 'stairwell']);

  /* ── Zoom tier based on viewBox width ── */
  function getZoomTier(vbW) {
    if (vbW > 900) return 'far';
    if (vbW > 400) return 'mid';
    return 'near';
  }

  /* ── Abbreviated room label ── */
  function shortLabel(name) {
    if (!name) return '';
    const m = name.match(/\b\d{3,}[A-Za-z]?\b/);
    if (m) return m[0];
    const tokens = name.trim().split(/\s+/);
    return tokens[tokens.length - 1].slice(0, 6);
  }

  /* ── Extract rooms for one floor ── */
  function extractFloorRooms(building, floorNumber) {
    if (!building || !Array.isArray(building.floors)) return [];
    const floor = building.floors.find((f) => f.floorNumber === floorNumber);
    return floor && Array.isArray(floor.rooms) ? floor.rooms : [];
  }

  /* ── Catmull-Rom to cubic bezier path ── */
  function catmullRomPath(pts, tension) {
    if (tension === undefined) tension = 0.5;
    if (!pts || pts.length < 2) return '';
    if (pts.length === 2) {
      return `M ${pts[0].x},${pts[0].y} L ${pts[1].x},${pts[1].y}`;
    }
    const n = pts.length;
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) * tension / 3;
      const cp1y = p1.y + (p2.y - p0.y) * tension / 3;
      const cp2x = p2.x - (p3.x - p1.x) * tension / 3;
      const cp2y = p2.y - (p3.y - p1.y) * tension / 3;
      d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x},${p2.y}`;
    }
    return d;
  }

  /* ── Lecture hall fan shape component ── */
  function LectureFan({ room, ix, iy, isSelected, isOnPath, isReno, uid, handleRoomClick, handleEnter, handleMove, setHovered }) {
    const scale = room.id === 'sc-b-hall-a' ? 1.6 : 1.0;
    const accent = TYPE_ACCENT.lecture;
    const tint = TYPE_TINT.lecture;
    const fill = isReno ? '#fef2f2' : isSelected ? accent : isOnPath ? '#fef9c3' : tint;
    const halfW = 50 * scale;
    const halfH = 40 * scale;
    const rectD = `M ${-halfW},${-halfH * 0.5} L ${halfW},${-halfH * 0.5} L ${halfW},${halfH * 0.4} Q ${halfW},${halfH} 0,${halfH} Q ${-halfW},${halfH} ${-halfW},${halfH * 0.4} Z`;
    return React.createElement('g', {
      transform: `translate(${ix} ${iy})`,
      style: { cursor: 'pointer' },
      onClick: (e) => handleRoomClick(room, e),
      onMouseEnter: (e) => handleEnter(room, e),
      onMouseMove: (e) => handleMove(room, e),
      onMouseLeave: () => setHovered(null),
    },
      React.createElement('path', {
        d: rectD,
        fill: fill,
        stroke: isSelected ? accent : 'rgba(0,0,0,0.12)',
        strokeWidth: 1,
      }),
      /* left accent bar */
      !isSelected && !isOnPath && !isReno && React.createElement('rect', {
        x: -halfW,
        y: -halfH * 0.5,
        width: 3,
        height: halfH * 0.9 + halfH * 0.4,
        rx: 1.5,
        fill: accent,
      }),
      /* tier lines */
      ...([-0.2, 0.15, 0.5].map((t, i) =>
        React.createElement('path', {
          key: i,
          d: `M ${-halfW * (0.9 - t * 0.4)},${halfH * t} Q 0,${halfH * (t + 0.12)} ${halfW * (0.9 - t * 0.4)},${halfH * t}`,
          fill: 'none',
          stroke: 'rgba(0,0,0,0.08)',
          strokeWidth: 0.8,
        })
      ))
    );
  }

  /* ── CSS keyframes ── */
  function makeCss(id) {
    return `
      .${id}-floor {
        animation: ${id}floorIn 260ms ease-out both;
      }
      @keyframes ${id}floorIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .${id}-cell-enter {
        animation: ${id}cellIn 220ms ease-out both;
        transform-box: fill-box;
        transform-origin: center;
      }
      @keyframes ${id}cellIn {
        from { opacity: 0; transform: scale(0.82); }
        to   { opacity: 1; transform: scale(1); }
      }

      .${id}-flow {
        animation: ${id}flow 2.2s linear infinite;
      }
      @keyframes ${id}flow { to { stroke-dashoffset: -40; } }

      .${id}-hallway-dash {
        animation: ${id}hdrift 22s linear infinite;
      }
      @keyframes ${id}hdrift { to { stroke-dashoffset: -64; } }

      .${id}-pulse {
        animation: ${id}pulse 2.2s ease-in-out infinite;
      }
      @keyframes ${id}pulse {
        0%, 100% { opacity: 0.15; }
        50%       { opacity: 0.55; }
      }

      .${id}-hlring {
        animation: ${id}hl 1.5s ease-in-out infinite;
      }
      @keyframes ${id}hl {
        0%, 100% { opacity: 0.35; }
        50%       { opacity: 0.85; }
      }
    `;
  }

  /* ── Inline styles ── */
  const S = {
    container: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#f2f2f4',
      overflow: 'hidden',
      borderRadius: 8,
      fontFamily: 'Inter, -apple-system, sans-serif',
    },
    svg: {
      display: 'block',
      width: '100%',
      height: '100%',
    },
    controls: {
      position: 'absolute',
      top: 12,
      right: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      zIndex: 20,
    },
    btn: {
      width: 36,
      height: 36,
      borderRadius: 8,
      border: '1px solid rgba(0,0,0,0.13)',
      background: 'rgba(255,255,255,0.97)',
      color: '#1a1a2e',
      fontSize: 20,
      fontWeight: 700,
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      lineHeight: 1,
    },
    tooltip: {
      position: 'absolute',
      pointerEvents: 'none',
      background: 'rgba(15,23,42,0.95)',
      color: '#f8fafc',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 10,
      padding: '8px 13px',
      fontSize: 13,
      lineHeight: 1.45,
      boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
      whiteSpace: 'nowrap',
      maxWidth: 260,
      transform: 'translate(-50%, calc(-100% - 14px))',
      zIndex: 30,
      backdropFilter: 'blur(10px)',
    },
    ttName: { fontWeight: 700, color: '#ffffff', marginBottom: 3 },
    ttMeta: { fontSize: 11, color: '#94a3b8' },
    ttWarn: { fontSize: 11, color: '#fca5a5', marginTop: 4, fontWeight: 600 },
  };

  /* ================================================================
   * IndoorMap component
   * ============================================================== */
  function IndoorMap({ building, floorNumber, path, selectedRoom, onRoomClick, highlightIds }) {
    const containerRef = useRef(null);
    const svgRef       = useRef(null);
    const draggedRef   = useRef(false);
    const panStateRef  = useRef(null);

    /* Unique ID prefix for CSS animations and SVG filter IDs */
    const uid = useMemo(() => 'im' + Math.random().toString(36).slice(2, 8), []);

    /* ViewBox — reset when floor changes */
    const [viewBox, setViewBox] = useState(() => {
      const fv = FLOOR_VIEWBOX[floorNumber] || FLOOR_VIEWBOX[1];
      return { x: fv.x, y: fv.y, w: fv.w, h: fv.h };
    });

    useEffect(() => {
      const fv = FLOOR_VIEWBOX[floorNumber] || FLOOR_VIEWBOX[1];
      setViewBox({ x: fv.x, y: fv.y, w: fv.w, h: fv.h });
    }, [floorNumber]);

    const [isPanning, setIsPanning] = useState(false);
    const [hovered,   setHovered]   = useState(null); // {room, x, y}

    /* ── Derived data ── */
    const rooms = useMemo(
      () => extractFloorRooms(building, floorNumber),
      [building, floorNumber]
    );

    /* Rooms with pixelCoords — use native coordinate space directly */
    const roomsWithPos = useMemo(() =>
      rooms
        .filter((r) => r && r.pixelCoords)
        .map((r) => ({
          ...r,
          ix: r.pixelCoords.x,
          iy: r.pixelCoords.y,
        })),
      [rooms]
    );

    /* Path nodes on this floor */
    const pathNodes = useMemo(() => {
      if (!Array.isArray(path)) return [];
      return path
        .filter((r) => r && r.pixelCoords && r.floor === floorNumber)
        .map((r) => ({
          id: r.id,
          x: r.pixelCoords.x,
          y: r.pixelCoords.y,
        }));
    }, [path, floorNumber]);

    const pathNodeIds = useMemo(() => new Set(pathNodes.map((n) => n.id)), [pathNodes]);
    const firstPathId = path && path.length > 0 ? path[0].id : null;
    const lastPathId  = path && path.length > 0 ? path[path.length - 1].id : null;

    const highlightSet = useMemo(
      () => (highlightIds instanceof Set ? highlightIds : new Set(highlightIds || [])),
      [highlightIds]
    );

    /* ── Corridor layer (spine = corridor↔transit, stubs = corridor↔room) ── */
    const corridorLayer = useMemo(() => {
      const roomMap = new Map(roomsWithPos.map((r) => [r.id, r]));
      const spine = [];
      const stubs = [];
      const seen = new Set();
      roomsWithPos.forEach((r) => {
        if (r.type !== 'corridor') return;
        (r.neighbors || []).forEach((n) => {
          const nid = typeof n === 'string' ? n : n.id;
          const nb = roomMap.get(nid);
          if (!nb || !nb.pixelCoords) return;
          const key = [r.id, nb.id].sort().join('|');
          if (seen.has(key)) return;
          seen.add(key);
          const seg = { key, x1: r.ix, y1: r.iy, x2: nb.ix, y2: nb.iy };
          if (TRANSIT_TYPES.has(nb.type)) spine.push(seg);
          else stubs.push(seg);
        });
      });
      return { spine, stubs };
    }, [roomsWithPos]);

    /* ── Catmull-Rom path string ── */
    const pathD = useMemo(() => catmullRomPath(pathNodes), [pathNodes]);

    /* ── pgrad coordinates ── */
    const pgradCoords = useMemo(() => {
      if (pathNodes.length < 2) return { x1: 0, y1: 0, x2: 0, y2: 0 };
      return {
        x1: pathNodes[0].x,
        y1: pathNodes[0].y,
        x2: pathNodes[pathNodes.length - 1].x,
        y2: pathNodes[pathNodes.length - 1].y,
      };
    }, [pathNodes]);

    /* ── Zoom via mouse wheel ── */
    const handleWheel = useCallback((e) => {
      e.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;

      setViewBox((vb) => {
        const zoom = Math.exp(e.deltaY * 0.001);
        const nw = Math.max(50, Math.min(vb.w * 8, vb.w * zoom));
        const nh = Math.max(50, Math.min(vb.h * 8, vb.h * zoom));
        const px = vb.x + relX * vb.w;
        const py = vb.y + relY * vb.h;
        return { x: px - relX * nw, y: py - relY * nh, w: nw, h: nh };
      });
    }, []);

    useEffect(() => {
      const svg = svgRef.current;
      if (!svg) return;
      svg.addEventListener('wheel', handleWheel, { passive: false });
      return () => svg.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    /* ── Drag-to-pan ── */
    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      draggedRef.current = false;
      panStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startVB: { ...viewBox },
        rect: svgRef.current.getBoundingClientRect(),
      };
      setIsPanning(true);
    };

    const handleMouseMove = (e) => {
      if (!panStateRef.current) return;
      const { startX, startY, startVB, rect } = panStateRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) draggedRef.current = true;
      setViewBox({
        x: startVB.x - (dx / rect.width)  * startVB.w,
        y: startVB.y - (dy / rect.height) * startVB.h,
        w: startVB.w,
        h: startVB.h,
      });
    };

    const endPan = useCallback(() => {
      panStateRef.current = null;
      setIsPanning(false);
    }, []);

    useEffect(() => {
      if (!isPanning) return;
      window.addEventListener('mouseup', endPan);
      return () => window.removeEventListener('mouseup', endPan);
    }, [isPanning, endPan]);

    /* ── Button zoom ── */
    const zoomBy = (factor) => {
      setViewBox((vb) => {
        const cx = vb.x + vb.w / 2;
        const cy = vb.y + vb.h / 2;
        const nw = Math.max(50, Math.min(vb.w * 8, vb.w * factor));
        const nh = Math.max(50, Math.min(vb.h * 8, vb.h * factor));
        return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
      });
    };

    const resetView = () => {
      const fv = FLOOR_VIEWBOX[floorNumber] || FLOOR_VIEWBOX[1];
      setViewBox({ x: fv.x, y: fv.y, w: fv.w, h: fv.h });
    };

    /* Center on selected room */
    const centerOnSelection = () => {
      if (
        selectedRoom &&
        selectedRoom.floor === floorNumber &&
        selectedRoom.pixelCoords
      ) {
        const ix = selectedRoom.pixelCoords.x;
        const iy = selectedRoom.pixelCoords.y;
        const fv = FLOOR_VIEWBOX[floorNumber] || FLOOR_VIEWBOX[1];
        const nw = fv.w / 3;
        const nh = fv.h / 3;
        setViewBox({ x: ix - nw / 2, y: iy - nh / 2, w: nw, h: nh });
      }
    };

    /* ── Room interaction ── */
    const handleRoomClick = (room, e) => {
      e.stopPropagation();
      if (draggedRef.current) return;
      if (typeof onRoomClick === 'function') onRoomClick(room);
    };

    const containerRect = () =>
      containerRef.current ? containerRef.current.getBoundingClientRect() : { left: 0, top: 0 };

    const handleEnter = (room, e) => {
      const r = containerRect();
      setHovered({ room, x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const handleMove = (room, e) => {
      if (!hovered || hovered.room.id !== room.id) return;
      const r = containerRect();
      setHovered({ room, x: e.clientX - r.left, y: e.clientY - r.top });
    };

    /* ── Render ── */
    const vbStr = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`;
    const zoomTier = getZoomTier(viewBox.w);

    /* Current floor's default viewBox for watermark positioning */
    const fvDefault = FLOOR_VIEWBOX[floorNumber] || FLOOR_VIEWBOX[1];

    return React.createElement('div', { ref: containerRef, style: S.container },

      /* Keyframe CSS injected once */
      React.createElement('style', { dangerouslySetInnerHTML: { __html: makeCss(uid) } }),

      /* ── Zoom Controls ── */
      React.createElement('div', { style: S.controls },
        React.createElement('button', { style: S.btn, onClick: () => zoomBy(0.65), title: 'Zoom in' }, '+'),
        React.createElement('button', { style: S.btn, onClick: () => zoomBy(1.5), title: 'Zoom out' }, '−'),
        React.createElement('button', { style: { ...S.btn, fontSize: 13 }, onClick: resetView, title: 'Reset' }, '⟲'),
        React.createElement('button', { style: { ...S.btn, fontSize: 15 }, onClick: centerOnSelection, title: 'Center on selection' }, '⊙')
      ),

      /* ── SVG Canvas ── */
      React.createElement('svg', {
        ref: svgRef,
        viewBox: vbStr,
        preserveAspectRatio: 'xMidYMid meet',
        style: { ...S.svg, cursor: isPanning ? 'grabbing' : 'grab' },
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: endPan,
      },

        /* ── Defs ── */
        React.createElement('defs', null,
          /* Building drop shadow */
          React.createElement('filter', {
            id: `${uid}-bshadow`,
            x: '-10%', y: '-10%', width: '120%', height: '120%',
          },
            React.createElement('feDropShadow', {
              dx: '0', dy: '2', stdDeviation: '3',
              floodColor: '#000', floodOpacity: '0.08',
            })
          ),
          /* Path glow */
          React.createElement('filter', {
            id: `${uid}-pglow`,
            x: '-30%', y: '-30%', width: '160%', height: '160%',
          },
            React.createElement('feGaussianBlur', { stdDeviation: '3', result: 'blur' }),
            React.createElement('feMerge', null,
              React.createElement('feMergeNode', { in: 'blur' }),
              React.createElement('feMergeNode', { in: 'SourceGraphic' })
            )
          ),
          /* Path gradient green→amber→red */
          React.createElement('linearGradient', {
            id: `${uid}-pgrad`,
            gradientUnits: 'userSpaceOnUse',
            x1: pgradCoords.x1, y1: pgradCoords.y1,
            x2: pgradCoords.x2, y2: pgradCoords.y2,
          },
            React.createElement('stop', { offset: '0%',   stopColor: '#22c55e' }),
            React.createElement('stop', { offset: '55%',  stopColor: '#fbbf24' }),
            React.createElement('stop', { offset: '100%', stopColor: '#ef4444' })
          ),
          /* Arrow marker */
          React.createElement('marker', {
            id: `${uid}-arrow`,
            viewBox: '0 0 10 10',
            refX: '8', refY: '5',
            markerWidth: '6', markerHeight: '6',
            orient: 'auto-start-reverse',
          },
            React.createElement('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#ef4444' })
          )
        ),

        /* ── Floor group (key triggers fade-in animation on floor change) ── */
        React.createElement('g', { key: floorNumber, className: `${uid}-floor` },

          /* 1. Page background — oversized to cover panned areas */
          React.createElement('rect', {
            x: viewBox.x - viewBox.w,
            y: viewBox.y - viewBox.h,
            width: viewBox.w * 3,
            height: viewBox.h * 3,
            fill: '#f2f2f4',
            pointerEvents: 'none',
          }),

          /* 2. Building footprint */
          React.createElement('path', {
            d: FLOOR_FOOTPRINT[floorNumber] || '',
            fill: '#ffffff',
            stroke: '#d8dce2',
            strokeWidth: 1.5,
            filter: `url(#${uid}-bshadow)`,
          }),

          /* 3. Corridor spine (corridor ↔ transit wide band) */
          React.createElement('g', null,
            ...corridorLayer.spine.map((s) =>
              React.createElement('line', {
                key: `sp-${s.key}`,
                x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
                stroke: '#e8ecf2',
                strokeWidth: 32,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              })
            )
          ),

          /* 4. Corridor stubs (corridor → room) */
          React.createElement('g', null,
            ...corridorLayer.stubs.map((s) =>
              React.createElement('line', {
                key: `st-${s.key}`,
                x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
                stroke: '#eef1f6',
                strokeWidth: 14,
                strokeLinecap: 'round',
              })
            )
          ),

          /* 5. Room cells */
          React.createElement('g', {
            style: { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.10))' },
          },
            ...roomsWithPos.map((room, idx) => {
              const isSelected    = selectedRoom && selectedRoom.id === room.id;
              const isOnPath      = pathNodeIds.has(room.id);
              const isReno        = room.status === 'renovation';

              /* Corridor rooms: invisible hit area only */
              if (room.type === 'corridor') {
                return React.createElement('rect', {
                  key: room.id,
                  x: room.ix - 14,
                  y: room.iy - 14,
                  width: 28,
                  height: 28,
                  fill: 'transparent',
                  style: { pointerEvents: 'all', cursor: 'pointer' },
                  onClick:      (e) => handleRoomClick(room, e),
                  onMouseEnter: (e) => handleEnter(room, e),
                  onMouseMove:  (e) => handleMove(room, e),
                  onMouseLeave: () => setHovered(null),
                });
              }

              /* Lecture halls use fan shape */
              if (room.type === 'lecture') {
                return React.createElement(LectureFan, {
                  key: room.id,
                  room,
                  ix: room.ix,
                  iy: room.iy,
                  isSelected,
                  isOnPath,
                  isReno,
                  uid,
                  handleRoomClick,
                  handleEnter,
                  handleMove,
                  setHovered,
                });
              }

              /* Regular room cell */
              const dims = ROOM_DIMS[room.type] || DEFAULT_DIMS;
              const { w, h } = dims;
              const tint   = TYPE_TINT[room.type]   || FALLBACK_TINT;
              const accent = TYPE_ACCENT[room.type] || FALLBACK_ACCENT;
              const fillColor   = isReno ? '#fef2f2' : isSelected ? accent : isOnPath ? '#fef9c3' : tint;
              const borderColor = isReno ? '#ef4444' : isOnPath ? '#3b82f6' : isSelected ? accent : 'rgba(0,0,0,0.10)';
              const borderWidth = (isOnPath || isSelected) ? 1.5 : 1;

              const label = zoomTier === 'near'
                ? (room.name || room.id)
                : zoomTier === 'mid'
                  ? shortLabel(room.name || room.id)
                  : '';

              return React.createElement('g', {
                key: room.id,
                transform: `translate(${room.ix - w / 2} ${room.iy - h / 2})`,
                style: {
                  cursor: 'pointer',
                  animationDelay: `${Math.min(idx * 8, 400)}ms`,
                },
                className: `${uid}-cell-enter`,
                onClick:      (e) => handleRoomClick(room, e),
                onMouseEnter: (e) => handleEnter(room, e),
                onMouseMove:  (e) => handleMove(room, e),
                onMouseLeave: () => setHovered(null),
              },
                /* Main rect */
                React.createElement('rect', {
                  width: w, height: h, rx: 3,
                  fill: fillColor,
                  stroke: borderColor,
                  strokeWidth: borderWidth,
                }),
                /* Left accent bar (skip if selected, on-path, or reno) */
                !isSelected && !isOnPath && !isReno && React.createElement('rect', {
                  x: 0, y: 0,
                  width: 3, height: h, rx: 1.5,
                  fill: accent,
                }),
                /* Stairwell / elevator icon */
                (room.type === 'stairwell' || room.type === 'elevator') &&
                  React.createElement('text', {
                    x: w / 2, y: h / 2 + 1,
                    textAnchor: 'middle', dominantBaseline: 'middle',
                    fontSize: 10, fill: '#475569',
                    style: { pointerEvents: 'none', userSelect: 'none' },
                  }, room.type === 'elevator' ? '\u21C5' : '\u2261'),
                /* Label (only when stairwell/elevator icon is not shown OR zoom allows) */
                label && !(room.type === 'stairwell' || room.type === 'elevator') &&
                  React.createElement('text', {
                    x: w / 2, y: h / 2 + 1,
                    textAnchor: 'middle', dominantBaseline: 'middle',
                    fontSize: zoomTier === 'near' ? 9 : 8,
                    fontWeight: 600,
                    fill: isSelected ? '#ffffff' : '#1f2937',
                    style: { pointerEvents: 'none', userSelect: 'none' },
                  }, label)
              );
            })
          ),

          /* 6. Navigation path line (3 layers, after room cells, before rings) */
          pathNodes.length >= 2 && React.createElement('g', null,
            /* Layer 1: wide glow shadow */
            React.createElement('path', {
              d: pathD,
              fill: 'none',
              stroke: '#ef4444',
              strokeWidth: 14,
              opacity: 0.22,
              filter: `url(#${uid}-pglow)`,
            }),
            /* Layer 2: gradient line with arrow */
            React.createElement('path', {
              d: pathD,
              fill: 'none',
              stroke: `url(#${uid}-pgrad)`,
              strokeWidth: 5,
              strokeLinecap: 'round',
              markerEnd: `url(#${uid}-arrow)`,
            }),
            /* Layer 3: animated white dash overlay */
            React.createElement('path', {
              d: pathD,
              fill: 'none',
              stroke: '#ffffff',
              strokeWidth: 2,
              strokeDasharray: '6 14',
              opacity: 0.85,
              className: `${uid}-flow`,
            })
          ),

          /* 7. Selection / highlight decoration rings (above room cells) */
          ...roomsWithPos
            .filter((r) => {
              const isSelected    = selectedRoom && selectedRoom.id === r.id;
              const isHighlighted = highlightSet.has(r.id);
              const isOnPath      = pathNodeIds.has(r.id);
              return isSelected || isHighlighted || isOnPath;
            })
            .map((room) => {
              const isSelected    = selectedRoom && selectedRoom.id === room.id;
              const isHighlighted = highlightSet.has(room.id);
              const isOnPath      = pathNodeIds.has(room.id);
              const accent        = TYPE_ACCENT[room.type] || FALLBACK_ACCENT;
              const ix = room.ix;
              const iy = room.iy;

              return React.createElement('g', { key: `ring-${room.id}`, pointerEvents: 'none' },
                isSelected && React.createElement('circle', {
                  cx: ix, cy: iy, r: 22,
                  fill: accent, opacity: 0.18,
                  className: `${uid}-pulse`,
                }),
                isSelected && React.createElement('circle', {
                  cx: ix, cy: iy, r: 16,
                  fill: 'none', stroke: '#ffffff', strokeWidth: 2,
                }),
                isHighlighted && !isSelected && React.createElement('circle', {
                  cx: ix, cy: iy, r: 15,
                  fill: 'none', stroke: '#fbbf24', strokeWidth: 2.5,
                  className: `${uid}-hlring`,
                }),
                isOnPath && !isSelected && !isHighlighted && React.createElement('circle', {
                  cx: ix, cy: iy, r: 13,
                  fill: 'none', stroke: '#ffffff', strokeWidth: 2, opacity: 0.9,
                })
              );
            }),

          /* 8. A/B badges */
          ...roomsWithPos
            .filter((r) => pathNodeIds.has(r.id) && (r.id === firstPathId || r.id === lastPathId))
            .map((room) => {
              const ix = room.ix;
              const iy = room.iy;
              const isStart = room.id === firstPathId;
              const isEnd   = room.id === lastPathId && room.id !== firstPathId;
              if (!isStart && !isEnd) return null;
              const bgColor = isStart ? '#22c55e' : '#ef4444';
              const label   = isStart ? 'A' : 'B';
              return React.createElement('g', { key: `badge-${room.id}`, pointerEvents: 'none' },
                React.createElement('circle', { cx: ix, cy: iy, r: 18, fill: bgColor, opacity: 0.18 }),
                React.createElement('circle', { cx: ix, cy: iy, r: 11, fill: bgColor, stroke: '#fff', strokeWidth: 2.5 }),
                React.createElement('text', {
                  x: ix, y: iy + 1,
                  textAnchor: 'middle', dominantBaseline: 'middle',
                  fill: '#fff', fontSize: 10, fontWeight: 800,
                  style: { pointerEvents: 'none', userSelect: 'none' },
                }, label)
              );
            }).filter(Boolean),

          /* 9. Floating label pills for selected / highlighted rooms */
          ...roomsWithPos
            .filter((r) => {
              const isSelected    = selectedRoom && selectedRoom.id === r.id;
              const isHighlighted = highlightSet.has(r.id);
              return (isSelected || isHighlighted) && !TRANSIT_TYPES.has(r.type);
            })
            .map((room) => {
              const txt = room.name || room.id;
              const pillW = txt.length * 7.2 + 16;
              const dims  = ROOM_DIMS[room.type] || DEFAULT_DIMS;
              const dy    = -(dims.h / 2 + 14);
              return React.createElement('g', {
                key: `pill-${room.id}`,
                transform: `translate(${room.ix}, ${room.iy})`,
                pointerEvents: 'none',
              },
                React.createElement('rect', {
                  x: -pillW / 2, y: dy - 11, width: pillW, height: 18, rx: 9,
                  fill: 'rgba(15,20,35,0.92)',
                  stroke: 'rgba(255,255,255,0.14)', strokeWidth: 0.6,
                }),
                React.createElement('text', {
                  x: 0, y: dy + 1,
                  textAnchor: 'middle', dominantBaseline: 'middle',
                  fill: '#f8fafc', fontSize: 11.5, fontWeight: 600,
                  style: { userSelect: 'none' },
                }, txt)
              );
            }),

          /* 10. Floor watermark */
          React.createElement('text', {
            x: fvDefault.x + fvDefault.w - 20,
            y: fvDefault.y + 70,
            textAnchor: 'end',
            fill: 'rgba(30,41,59,0.08)',
            fontSize: 72,
            fontWeight: 800,
            style: { letterSpacing: '-0.04em', pointerEvents: 'none' },
          }, floorNumber === 0 ? 'B' : String(floorNumber))

        ) /* end floor group */

      ), /* end SVG */

      /* ── Hover tooltip ── */
      hovered && React.createElement('div', {
        style: { ...S.tooltip, left: hovered.x, top: hovered.y },
      },
        React.createElement('div', { style: S.ttName },
          hovered.room.name || hovered.room.id
        ),
        React.createElement('div', { style: S.ttMeta },
          hovered.room.type,
          hovered.room.description
            ? ` \u00b7 ${hovered.room.description.slice(0, 50)}`
            : ''
        ),
        hovered.room.status === 'renovation' && React.createElement('div', { style: S.ttWarn },
          '\u26A0 Under renovation'
        )
      )

    ); /* end container div */
  }

  window.IndoorMap = IndoorMap;
})();
