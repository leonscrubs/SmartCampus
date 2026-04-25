from flask import Flask, jsonify, render_template, request
import json, os, math, heapq

app = Flask(__name__)

FLOOR_ORDER = ['1', '2', '3', '5']

FLOOR_FILES = {
    '1': 'Floor Plans/floor1.json',
    '2': 'Floor Plans/floor2.json',
    '3': 'Floor Plans/floor3.json',
    '5': 'Floor Plans/floor5.json',
}

# Cost multiplier applied to the pixel distance of each edge.
# Corridors/doors are near-free so Dijkstra always prefers them.
# Rooms are prohibitively expensive so the path never cuts through them
# unless there is genuinely no corridor alternative.
TYPE_COST = {
    'corridor':   1.0,
    'entrance':   2.0,
    'door':       0.1,
    'connection': 0.1,
    'stairwell':  3.0,
    'elevator':   3.0,
    'other':      80.0,
    'library':    80.0,
    'classroom':  80.0,
    'office':     80.0,
    'lecture':    80.0,
}

FLOOR_CHANGE_COST = 600   # pixel-equivalent penalty per adjacent floor hop
DOOR_TYPES = {'door', 'connection'}
ROOM_ENTRY_TYPES = {'office', 'classroom', 'library', 'lecture', 'other'}
LOW_COST_TYPES = {'corridor', 'entrance', 'door', 'connection', 'stairwell', 'elevator'}
SNAP_TARGET_TYPES = {'corridor', 'entrance'}
HALLWAY_ACCESS_TYPES = {'door', 'connection', 'stairwell', 'elevator', 'entrance'}

# Index position of each floor — used to compute inter-floor distance cost
FLOOR_IDX = {f: i for i, f in enumerate(FLOOR_ORDER)}


def centroid(polygon):
    n = len(polygon)
    return (sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n)


def euclid(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def point_in_polygon(point, polygon):
    x, y = point['x'], point['y']
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        intersects = (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi
        if intersects:
            inside = not inside
        j = i
    return inside


def segment_inside_polygon(a, b, polygon, samples=8):
    for i in range(samples + 1):
        t = i / samples
        p = {
            'x': a['x'] + (b['x'] - a['x']) * t,
            'y': a['y'] + (b['y'] - a['y']) * t,
        }
        if not point_in_polygon(p, polygon):
            return False
    return True


def can_connect(a, b):
    """Rooms may only connect through designated door/connection nodes."""
    a_is_room = a['type'] in ROOM_ENTRY_TYPES
    b_is_room = b['type'] in ROOM_ENTRY_TYPES
    if a_is_room or b_is_room:
        return a['type'] in DOOR_TYPES or b['type'] in DOOR_TYPES
    return True


def add_weighted_edge(adj, src_key, dst_key, nodes):
    src = nodes[src_key]
    dst = nodes[dst_key]
    if not can_connect(src, dst):
        return False
    px_dist = euclid((src['cx'], src['cy']), (dst['cx'], dst['cy']))
    cost = px_dist * TYPE_COST.get(dst['type'], 20.0)
    adj[src_key].append((dst_key, cost))
    return True


def load_floors():
    data = {}
    for fid, path in FLOOR_FILES.items():
        with open(path) as f:
            data[fid] = json.load(f)
    return data


# Graph cache keyed by (use_elevator, use_stairs)
_graph_cache = {}


def build_graph(use_elevator=True, use_stairs=True):
    cache_key = (use_elevator, use_stairs)
    if cache_key in _graph_cache:
        return _graph_cache[cache_key]

    floors_data = load_floors()

    nodes = {}   # node_key -> dict
    adj   = {}   # node_key -> [(neighbor_key, weight)]

    # ── Intra-floor nodes & edges ─────────────────────────────────────────────
    for fid, data in floors_data.items():
        rooms  = data['rooms']
        by_id  = {r['id']: r for r in rooms}
        id_to_keys = {}
        room_keys = []
        seen_ids = {}

        for room in rooms:
            rid = room['id']
            t   = room.get('type', 'other')
            pts = room.get('polygon', [])
            if not pts:
                room_keys.append(None)
                continue
            if t == 'elevator' and not use_elevator:
                room_keys.append(None)
                continue
            if t == 'stairwell' and not use_stairs:
                room_keys.append(None)
                continue

            cx, cy = centroid(pts)
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            w = max(xs) - min(xs); h = max(ys) - min(ys)

            occurrence = seen_ids.get(rid, 0)
            seen_ids[rid] = occurrence + 1
            key = f"{fid}:{rid}" if occurrence == 0 else f"{fid}:{rid}#{occurrence + 1}"
            room_keys.append(key)
            id_to_keys.setdefault(rid, []).append(key)
            nodes[key] = {
                'type': t, 'cx': cx, 'cy': cy, 'floor': fid,
                'id': rid, 'name': room.get('name', rid),
                'polygon': pts,
                'orientation': 'h' if w >= h else 'v',
                'connectsFloors': [str(x) for x in room.get('connectsFloors', [])],
            }
            adj.setdefault(key, [])

        # Build logical neighbor pairs as undirected pairs. Many door polygons
        # list the room/corridor they connect, while the room does not list the
        # door back. Adding both directions ensures a route can leave a room via
        # its door as well as enter it.
        neighbor_pairs = set()
        for idx, room in enumerate(rooms):
            src_key = room_keys[idx]
            if src_key not in nodes:
                continue
            for nbr_id in room.get('neighbors', []):
                if not nbr_id or nbr_id == 'outside':
                    continue
                dst_keys = id_to_keys.get(nbr_id, [])
                if not dst_keys:
                    continue
                src = nodes[src_key]
                dst_key = min(
                    dst_keys,
                    key=lambda k: euclid((src['cx'], src['cy']), (nodes[k]['cx'], nodes[k]['cy']))
                )
                neighbor_pairs.add(tuple(sorted((src_key, dst_key))))

        for key_a, key_b in neighbor_pairs:
            # Cost = pixel distance × type multiplier of destination.
            # Direct corridor/room or room/room edges are intentionally skipped:
            # a user-facing room can only be entered or exited through a
            # designated door/connection node.
            add_weighted_edge(adj, key_a, key_b, nodes)
            add_weighted_edge(adj, key_b, key_a, nodes)

    # ── Auto-connect orphaned nodes to nearest reachable rooms ────────────────
    # Nodes with no neighbors OR whose only neighbors are high-cost room types
    # (making them effectively isolated) get snapped to the 2 closest nodes
    # within SNAP_RADIUS on the same floor.
    SNAP_RADIUS = 600
    def needs_snap(key):
        if nodes[key]['type'] in ROOM_ENTRY_TYPES:
            return False
        if nodes[key]['type'] in DOOR_TYPES:
            return False
        edges = adj.get(key, [])
        if not edges:
            return True
        # Snap if no neighbor is a low-cost navigable type
        return not any(nodes[nbr]['type'] in LOW_COST_TYPES for nbr, _ in edges if nbr in nodes)

    for key, node in list(nodes.items()):
        if not needs_snap(key):
            continue
        fid    = node['floor']
        my_pos = (node['cx'], node['cy'])
        cands  = sorted(
            ((euclid(my_pos, (n['cx'], n['cy'])), k)
             for k, n in nodes.items()
             if n['floor'] == fid
             and k != key
             and k not in {nbr for nbr, _ in adj.get(key, [])}
             and n['type'] in SNAP_TARGET_TYPES)
        )
        connected = 0
        for d, other_key in cands:
            if connected >= 2 or d > SNAP_RADIUS:
                break
            cost = d * TYPE_COST.get(node['type'], 5.0)
            adj[key].append((other_key, cost))
            adj[other_key].append((key, cost))
            connected += 1

    # ── Cross-floor edges (stairwells & elevators) ────────────────────────────
    connectors = [
        (key, node)
        for key, node in nodes.items()
        if node['type'] in ('stairwell', 'elevator') and node['connectsFloors']
    ]

    # Only bridge connectors between floors that are ADJACENT in FLOOR_ORDER
    # (consecutive indices). This prevents sky-jumping from floor 4 to floor 7.
    # Two connectors qualify when their connectsFloors lists share any floor
    # (handles the missing floor-2 gap between our floor-1 and floor-3 data).
    adjacent_pairs = set()
    for i in range(len(FLOOR_ORDER) - 1):
        adjacent_pairs.add((FLOOR_ORDER[i], FLOOR_ORDER[i + 1]))
        adjacent_pairs.add((FLOOR_ORDER[i + 1], FLOOR_ORDER[i]))

    # Match each connector to the physically corresponding connector on the
    # next/previous floor. Earlier versions connected every stairwell on one
    # floor to every stairwell on the adjacent floor, which allowed impossible
    # "teleporting" between stair shafts. Coordinate proximity identifies the
    # same shaft/elevator stack across floors.
    used_pairs = set()
    connectors_by_floor_type = {}
    for key, node in connectors:
        connectors_by_floor_type.setdefault((node['floor'], node['type']), []).append((key, node))

    for key_a, na in connectors:
        candidates = []
        for adj_floor in FLOOR_ORDER:
            if (na['floor'], adj_floor) not in adjacent_pairs:
                continue
            for key_b, nb in connectors_by_floor_type.get((adj_floor, na['type']), []):
                if not (set(na['connectsFloors']) & set(nb['connectsFloors'])):
                    continue
                coord_dist = euclid((na['cx'], na['cy']), (nb['cx'], nb['cy']))
                candidates.append((coord_dist, key_b, nb))

        if not candidates:
            continue
        coord_dist, key_b, nb = min(candidates, key=lambda item: item[0])
        pair = tuple(sorted([key_a, key_b]))
        if pair in used_pairs:
            continue
        used_pairs.add(pair)
        cost = FLOOR_CHANGE_COST + coord_dist * 0.25
        adj[key_a].append((key_b, cost))
        adj[key_b].append((key_a, cost))

    _graph_cache[cache_key] = (nodes, adj)
    return nodes, adj


def dijkstra(nodes, adj, start, goal):
    dist = {start: 0.0}
    prev = {}
    pq   = [(0.0, start)]

    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, math.inf):
            continue
        if u == goal:
            break
        for v, w in adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if goal not in dist:
        return None

    path = []
    cur  = goal
    while cur in prev:
        path.append(cur); cur = prev[cur]
    path.append(cur)
    path.reverse()
    return path if path[0] == start else None


def as_point(node):
    return {'x': round(node['cx'], 1), 'y': round(node['cy'], 1)}


def add_point(points, point):
    if not points or abs(points[-1]['x'] - point['x']) > 0.5 or abs(points[-1]['y'] - point['y']) > 0.5:
        points.append({'x': round(point['x'], 1), 'y': round(point['y'], 1)})


def corridor_entry_point(door_node, corridor_node):
    """Return a point just inside the corridor polygon from a doorway."""
    door = as_point(door_node)
    polygon = corridor_node.get('polygon', [])
    if not polygon:
        return as_point(corridor_node)

    vx = corridor_node['cx'] - door_node['cx']
    vy = corridor_node['cy'] - door_node['cy']
    directions = [(0, 1), (0, -1), (1, 0), (-1, 0)]
    directions.sort(key=lambda d: -(d[0] * vx + d[1] * vy))

    for offset in (18, 28, 40, 60, 90):
        for dx, dy in directions:
            candidate = {'x': door['x'] + dx * offset, 'y': door['y'] + dy * offset}
            if point_in_polygon(candidate, polygon):
                return candidate
    return as_point(corridor_node)


def corridor_manhattan_points(a, b, corridor_node):
    """Connect two points with hallway-confined axis-aligned legs when possible."""
    polygon = corridor_node.get('polygon', [])
    if not polygon:
        return [a, b]
    if segment_inside_polygon(a, b, polygon):
        return [a, b]

    candidates = [
        {'x': a['x'], 'y': b['y']},
        {'x': b['x'], 'y': a['y']},
    ]
    for bend in candidates:
        if (
            point_in_polygon(bend, polygon)
            and segment_inside_polygon(a, bend, polygon)
            and segment_inside_polygon(bend, b, polygon)
        ):
            return [a, bend, b]

    return corridor_rectilinear_path(a, b, polygon)


def corridor_rectilinear_path(a, b, polygon):
    """Find a Manhattan path whose segments stay inside a corridor polygon."""
    def uniq(values):
        out = []
        for value in sorted(values):
            if not out or abs(value - out[-1]) > 0.5:
                out.append(value)
        return out

    xs = uniq([p[0] for p in polygon] + [a['x'], b['x']])
    ys = uniq([p[1] for p in polygon] + [a['y'], b['y']])
    mids_x = [(xs[i] + xs[i + 1]) / 2 for i in range(len(xs) - 1)]
    mids_y = [(ys[i] + ys[i + 1]) / 2 for i in range(len(ys) - 1)]
    xs = uniq(xs + mids_x + [a['x'], b['x']])
    ys = uniq(ys + mids_y + [a['y'], b['y']])

    start = (round(a['x'], 1), round(a['y'], 1))
    goal = (round(b['x'], 1), round(b['y'], 1))
    nodes_grid = {start, goal}
    for x in xs:
        for y in ys:
            p = {'x': x, 'y': y}
            if point_in_polygon(p, polygon):
                nodes_grid.add((round(x, 1), round(y, 1)))

    rows = {}
    cols = {}
    for x, y in nodes_grid:
        rows.setdefault(y, []).append(x)
        cols.setdefault(x, []).append(y)

    graph = {node: [] for node in nodes_grid}
    for y, row_xs in rows.items():
        row_xs = sorted(row_xs)
        for i, x1 in enumerate(row_xs):
            p1 = {'x': x1, 'y': y}
            for x2 in row_xs[i + 1:]:
                p2 = {'x': x2, 'y': y}
                if segment_inside_polygon(p1, p2, polygon):
                    w = abs(x2 - x1)
                    graph[(x1, y)].append(((x2, y), w))
                    graph[(x2, y)].append(((x1, y), w))
    for x, col_ys in cols.items():
        col_ys = sorted(col_ys)
        for i, y1 in enumerate(col_ys):
            p1 = {'x': x, 'y': y1}
            for y2 in col_ys[i + 1:]:
                p2 = {'x': x, 'y': y2}
                if segment_inside_polygon(p1, p2, polygon):
                    w = abs(y2 - y1)
                    graph[(x, y1)].append(((x, y2), w))
                    graph[(x, y2)].append(((x, y1), w))

    dist = {start: 0}
    prev = {}
    pq = [(0, start)]
    while pq:
        d, cur = heapq.heappop(pq)
        if cur == goal:
            break
        if d > dist.get(cur, math.inf):
            continue
        for nxt, w in graph.get(cur, []):
            nd = d + w
            if nd < dist.get(nxt, math.inf):
                dist[nxt] = nd
                prev[nxt] = cur
                heapq.heappush(pq, (nd, nxt))

    if goal not in dist:
        return [a, b]

    path = []
    cur = goal
    while cur in prev:
        path.append(cur)
        cur = prev[cur]
    path.append(start)
    path.reverse()
    return [{'x': x, 'y': y} for x, y in path]


def route_draw_points(path_keys, nodes):
    """Build drawable points that stay in corridor polygons between room doors."""
    points = []
    i = 0
    while i < len(path_keys) - 1:
        a = nodes[path_keys[i]]
        b = nodes[path_keys[i + 1]]
        if a['floor'] != b['floor']:
            i += 1
            continue

        a_pt = as_point(a)
        b_pt = as_point(b)

        # Common hallway case:
        # room -> door -> corridor -> door -> room
        #
        # Draw this as:
        #   doorway -> point inside hallway -> Manhattan hallway legs
        #   -> point inside hallway at target door -> doorway
        #
        # Do not connect doorways directly. The middle leg is routed inside the
        # corridor polygon so the line follows the hallway instead of cutting
        # across rooms or walls.
        if a['type'] in HALLWAY_ACCESS_TYPES and b['type'] == 'corridor' and i + 2 < len(path_keys):
            c = nodes[path_keys[i + 2]]
            if c['floor'] == b['floor'] and c['type'] in HALLWAY_ACCESS_TYPES:
                start_lane = corridor_entry_point(a, b)
                end_lane = corridor_entry_point(c, b)
                for point in [a_pt, *corridor_manhattan_points(start_lane, end_lane, b), as_point(c)]:
                    add_point(points, point)
                i += 2
                continue

        edge_points = [a_pt, b_pt]

        if a['type'] in HALLWAY_ACCESS_TYPES and b['type'] == 'corridor':
            edge_points = [a_pt, corridor_entry_point(a, b)]
        elif a['type'] == 'corridor' and b['type'] in HALLWAY_ACCESS_TYPES:
            edge_points = [corridor_entry_point(b, a), b_pt]
        elif a['type'] == 'corridor' and b['type'] == 'corridor':
            edge_points = corridor_manhattan_points(a_pt, b_pt, a)

        for point in edge_points:
            add_point(points, point)
        i += 1
    return points


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/floors')
def api_floors():
    return jsonify({'floors': FLOOR_ORDER})


@app.route('/api/floor/<floor_id>')
def api_floor(floor_id):
    if floor_id not in FLOOR_FILES:
        return jsonify({'error': 'Floor not found'}), 404
    path = FLOOR_FILES[floor_id]
    if not os.path.exists(path):
        return jsonify({'error': f'Missing: {path}'}), 404
    with open(path) as f:
        return jsonify(json.load(f))


@app.route('/api/navigate', methods=['POST'])
def api_navigate():
    body       = request.json or {}
    from_floor = str(body.get('from_floor', ''))
    from_id    = body.get('from_id', '')
    to_floor   = str(body.get('to_floor', ''))
    to_id      = body.get('to_id', '')
    use_elev   = body.get('use_elevator', True)
    use_stairs = not use_elev

    try:
        nodes, adj = build_graph(use_elevator=use_elev, use_stairs=use_stairs)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    start_key = f"{from_floor}:{from_id}"
    goal_key  = f"{to_floor}:{to_id}"

    if start_key not in nodes:
        return jsonify({'error': f'Start not in graph: {start_key}'}), 400
    if goal_key not in nodes:
        return jsonify({'error': f'Goal not in graph: {goal_key}'}), 400

    path_keys = dijkstra(nodes, adj, start_key, goal_key)
    if not path_keys:
        return jsonify({'error': 'No path found'}), 404

    prev_floor = None
    waypoints  = []
    for key in path_keys:
        n = nodes[key]
        waypoints.append({
            'floor':        n['floor'],
            'id':           n['id'],
            'x':            round(n['cx'], 1),
            'y':            round(n['cy'], 1),
            'type':         n['type'],
            'name':         n['name'],
            'orientation':  n['orientation'],
            'floor_change': prev_floor is not None and n['floor'] != prev_floor,
        })
        prev_floor = n['floor']

    # Pixel length on-floor only
    total_px = sum(
        euclid((waypoints[i-1]['x'], waypoints[i-1]['y']),
               (waypoints[i]['x'],   waypoints[i]['y']))
        for i in range(1, len(waypoints))
        if not waypoints[i]['floor_change']
    )

    floors_visited = list(dict.fromkeys(w['floor'] for w in waypoints))
    route_points_by_floor = {}
    for fid in floors_visited:
        floor_keys = [key for key in path_keys if nodes[key]['floor'] == fid]
        route_points_by_floor[fid] = route_draw_points(floor_keys, nodes) if len(floor_keys) >= 2 else []

    return jsonify({
        'waypoints':              waypoints,
        'route_points_by_floor':  route_points_by_floor,
        'total_px':               round(total_px),
        'floors_visited':         floors_visited,
    })


if __name__ == '__main__':
    # Pre-warm the graph cache
    print('Building navigation graph…')
    build_graph(use_elevator=True)
    build_graph(use_elevator=False)
    print('Ready.')
    app.run(debug=True, port=5000)
