from flask import Flask, jsonify, render_template, request
import json, os, math, heapq

app = Flask(__name__)

FLOOR_ORDER = ['B', '1', '2', '3', '4', '5', '6', '7', '8', '9']

FLOOR_FILES = {
    'B': 'Floor Plans/floorB.json',
    '1': 'Floor Plans/floor1.json',
    '2': 'Floor Plans/floor2.json',
    '3': 'Floor Plans/floor3.json',
    '4': 'Floor Plans/floor4.json',
    '5': 'Floor Plans/floor5.json',
    '6': 'Floor Plans/floor6.json',
    '7': 'Floor Plans/floor7.json',
    '8': 'Floor Plans/floor8.json',
    '9': 'Floor Plans/floor9.json',
}

# Cost multiplier applied to the pixel distance of each edge.
# Corridors/doors are near-free so Dijkstra always prefers them.
# Rooms are prohibitively expensive so the path never cuts through them
# unless there is genuinely no corridor alternative.
TYPE_COST = {
    'corridor':        1.0,
    'entrance':        2.0,
    'door':            0.1,
    'connection':      0.1,
    'stairwell':       3.0,
    'elevator':        3.0,
    'other':           80.0,
    'library':         80.0,
    'classroom':       80.0,
    'office':          80.0,
    'lecture':         80.0,
    'restroom':        0.5,
    'water_fountain':  0.5,
    'vending_machine': 0.5,
}

FLOOR_CHANGE_COST = 600   # pixel-equivalent penalty per adjacent floor hop
DOOR_TYPES = {'door', 'connection'}
ROOM_ENTRY_TYPES = {'office', 'classroom', 'library', 'lecture', 'other'}
LOW_COST_TYPES = {'corridor', 'entrance', 'door', 'connection', 'stairwell', 'elevator'}
SNAP_TARGET_TYPES = {'corridor', 'entrance'}
HALLWAY_ACCESS_TYPES = {'door', 'connection', 'stairwell', 'elevator', 'entrance'}

AMENITY_TYPES = {'restroom', 'water_fountain', 'vending_machine'}

AMENITY_KIND_ALIASES = {
    'restroom':       ['restroom', 'bathroom', 'toilet', 'wc', 'washroom'],
    'water_fountain': ['water_fountain', 'water', 'fountain', 'drinking'],
    'vending_machine': ['vending_machine', 'vending', 'snack', 'machine'],
}


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
                'connectsFloors': ['B' if str(x) == '0' else str(x) for x in room.get('connectsFloors', [])],
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
        edges = adj.get(key, [])
        if nodes[key]['type'] in ROOM_ENTRY_TYPES:
            # Rooms normally reach the network through their door neighbors.
            # Only snap if the room is fully orphaned (e.g. floor JSON lists
            # no neighbors at all), otherwise leave doors as the gateway.
            return not edges
        if nodes[key]['type'] in DOOR_TYPES:
            return False
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
    floor_order_set = set(FLOOR_ORDER)
    connectors = [
        (key, node)
        for key, node in nodes.items()
        if node['type'] in ('stairwell', 'elevator')
        # Must list at least two real floors to be a cross-floor connector
        and sum(1 for f in node['connectsFloors'] if f in floor_order_set) >= 2
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

    def poly_area(pts):
        n = len(pts)
        a = sum(pts[i][0]*pts[(i+1)%n][1] - pts[(i+1)%n][0]*pts[i][1] for i in range(n))
        return abs(a) / 2

    AREA_RATIO_MAX = 2.5  # stairwell polygons must be within 150% in area

    # Track which connectors have already been paired per adjacent floor,
    # so one connector cannot link to multiple partners on the same floor.
    paired_on_floor = {}  # key_a -> set of adj_floors already linked

    for key_a, na in connectors:
        area_a = poly_area(na['polygon']) if na['type'] == 'stairwell' else None
        for adj_floor in FLOOR_ORDER:
            if (na['floor'], adj_floor) not in adjacent_pairs:
                continue
            if adj_floor in paired_on_floor.get(key_a, set()):
                continue
            candidates = []
            for key_b, nb in connectors_by_floor_type.get((adj_floor, na['type']), []):
                # Both connectors must explicitly include BOTH endpoint floors.
                # A stairwell on floor A can only link to floor B if it lists B in
                # connectsFloors; likewise the floor-B stairwell must list floor A.
                cf_a = set(na['connectsFloors'])
                cf_b = set(nb['connectsFloors'])
                if adj_floor not in cf_a or na['floor'] not in cf_b:
                    continue
                # For stairwells, reject pairs whose polygon areas differ by more than 50%
                if area_a is not None:
                    area_b = poly_area(nb['polygon'])
                    ratio = max(area_a, area_b) / max(min(area_a, area_b), 1)
                    if ratio > AREA_RATIO_MAX:
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
            paired_on_floor.setdefault(key_a, set()).add(adj_floor)
            paired_on_floor.setdefault(key_b, set()).add(na['floor'])
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


def dijkstra_all(nodes, adj, start):
    dist = {start: 0.0}
    prev = {}
    pq = [(0.0, start)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, math.inf):
            continue
        for v, w in adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def find_nearest_amenity(nodes, adj, start_key, kind):
    dist, _ = dijkstra_all(nodes, adj, start_key)
    best_key, best_cost = None, math.inf
    for k, n in nodes.items():
        if n['type'] == kind and k in dist and dist[k] < best_cost:
            best_key, best_cost = k, dist[k]
    return best_key


def find_best_via(nodes, adj, start_key, goal_key, kind):
    d_from, _ = dijkstra_all(nodes, adj, start_key)
    d_to,   _ = dijkstra_all(nodes, adj, goal_key)
    best_key, best_cost = None, math.inf
    for k, n in nodes.items():
        if n['type'] != kind:
            continue
        if k not in d_from or k not in d_to:
            continue
        c = d_from[k] + d_to[k]
        if c < best_cost:
            best_key, best_cost = k, c
    return best_key


def truncate_indirect_path(path_keys, nodes, adj):
    if len(path_keys) < 2:
        return path_keys, [], None
    goal_type = nodes.get(path_keys[-1], {}).get('type', '')
    if goal_type not in ROOM_ENTRY_TYPES:
        return path_keys, [], None

    intermediates = []
    cut_idx = None

    for i in range(len(path_keys) - 2, -1, -1):
        n = nodes[path_keys[i]]
        t = n['type']
        if t == 'corridor' or t == 'entrance':
            # The node right after this (i+1) is the gateway door into the room chain
            cut_idx = i + 1
            break
        if t in ROOM_ENTRY_TYPES:
            intermediates.insert(0, {'id': n['id'], 'name': n['name'], 'floor': n['floor']})

    if not intermediates or cut_idx is None:
        return path_keys, [], None

    truncated = path_keys[:cut_idx + 1]  # include gateway door as final node
    stop = nodes[truncated[-1]]
    stop_info = {
        'id':    stop['id'],
        'x':     round(stop['cx'], 1),
        'y':     round(stop['cy'], 1),
        'floor': stop['floor'],
    }
    return truncated, intermediates, stop_info


def normalize_amenity_kind(text):
    t = text.lower().replace('-', '_').replace(' ', '_')
    for kind, aliases in AMENITY_KIND_ALIASES.items():
        if t in aliases or t == kind:
            return kind
    return None


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
    # Only take the direct path if it is already axis-aligned (pure horizontal or
    # vertical). A diagonal segment that happens to lie inside the polygon still
    # looks wrong on screen — force a Manhattan bend in that case.
    already_straight = abs(a['x'] - b['x']) < 0.5 or abs(a['y'] - b['y']) < 0.5
    if already_straight and segment_inside_polygon(a, b, polygon):
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
        # No path inside the polygon — force a Manhattan L-path rather than a diagonal.
        bend = {'x': a['x'], 'y': b['y']}
        return [a, bend, b]

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
        # Intermediate room pass-through: door → room → door
        # The room is not start or end — skip its centroid and connect the doors directly.
        if (a['type'] in DOOR_TYPES and b['type'] in ROOM_ENTRY_TYPES
                and i + 2 < len(path_keys)
                and path_keys[i + 1] != path_keys[-1]):
            c = nodes[path_keys[i + 2]]
            if c['type'] in DOOR_TYPES and c['floor'] == b['floor']:
                add_point(points, a_pt)
                i += 2
                continue

        # corridor → corridor → door/connection/amenity:
        # Route entirely inside the second corridor — find where corridor_a "enters"
        # corridor_b and where the exit door exits corridor_b, then Manhattan inside b.
        if a['type'] == 'corridor' and b['type'] == 'corridor' and i + 2 < len(path_keys):
            c = nodes[path_keys[i + 2]]
            if c['floor'] == b['floor'] and (c['type'] in HALLWAY_ACCESS_TYPES or c['type'] in AMENITY_TYPES):
                entry_from_a = corridor_entry_point(a, b)  # where corridor_a meets corridor_b
                entry_from_c = corridor_entry_point(c, b)  # where exit node meets corridor_b
                for point in [a_pt, *corridor_manhattan_points(entry_from_a, entry_from_c, b), as_point(c)]:
                    add_point(points, point)
                i += 2
                continue

        if a['type'] in HALLWAY_ACCESS_TYPES and b['type'] == 'corridor' and i + 2 < len(path_keys):
            c = nodes[path_keys[i + 2]]
            if c['floor'] == b['floor'] and (c['type'] in HALLWAY_ACCESS_TYPES or c['type'] in AMENITY_TYPES):
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
        elif a['type'] == 'corridor' and b['type'] in AMENITY_TYPES:
            # Amenity sits just outside the corridor: find the wall entry point,
            # then draw a short straight line into the amenity.
            entry = corridor_entry_point(b, a)
            edge_points = [entry, b_pt]
        elif a['type'] in AMENITY_TYPES and b['type'] == 'corridor':
            entry = corridor_entry_point(a, b)
            edge_points = [a_pt, entry]
        elif a['type'] == 'corridor' and b['type'] == 'corridor':
            edge_points = corridor_manhattan_points(a_pt, b_pt, a)

        for point in edge_points:
            add_point(points, point)
        i += 1
    return _ensure_manhattan(points)


def _ensure_manhattan(points):
    if len(points) < 2:
        return points
    result = [points[0]]
    for i in range(1, len(points)):
        a = result[-1]
        b = points[i]
        if abs(b['x'] - a['x']) > 0.5 and abs(b['y'] - a['y']) > 0.5:
            result.append({'x': a['x'], 'y': b['y']})
        result.append(b)
    return result


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
    to_amenity  = body.get('to_amenity')
    via_amenity = body.get('via_amenity')
    via_floor   = str(body.get('via_floor', ''))
    via_id      = body.get('via_id', '')

    try:
        nodes, adj = build_graph(use_elevator=use_elev, use_stairs=use_stairs)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    start_key = f"{from_floor}:{from_id}"

    if start_key not in nodes:
        return jsonify({'error': f'Start not in graph: {start_key}'}), 400

    # ── Feature B: resolve amenity destination ────────────────────────────────
    resolved_amenity = None
    if to_amenity:
        kind = normalize_amenity_kind(to_amenity)
        if not kind:
            return jsonify({'error': f'Unknown amenity type: {to_amenity}'}), 400
        goal_key = find_nearest_amenity(nodes, adj, start_key, kind)
        if not goal_key:
            return jsonify({'error': f'No {kind} found or reachable from start'}), 404
        gn = nodes[goal_key]
        to_floor = gn['floor']
        to_id    = gn['id']
        resolved_amenity = {
            'kind': kind, 'floor': gn['floor'],
            'id': gn['id'], 'name': gn['name'],
        }
    else:
        # Existing lookup
        goal_key = f"{to_floor}:{to_id}"
        if goal_key not in nodes:
            return jsonify({'error': f'Goal not in graph: {goal_key}'}), 400

    path_keys = dijkstra(nodes, adj, start_key, goal_key)

    # ── Feature C: via stop (amenity or specific room) ───────────────────────
    via_stop = None
    if via_amenity:
        via_kind = normalize_amenity_kind(via_amenity)
        if not via_kind:
            return jsonify({'error': f'Unknown via amenity: {via_amenity}'}), 400
        via_key = find_best_via(nodes, adj, start_key, goal_key, via_kind)
        if not via_key:
            return jsonify({'error': f'No {via_kind} reachable for via stop'}), 404
        p1 = dijkstra(nodes, adj, start_key, via_key)
        p2 = dijkstra(nodes, adj, via_key, goal_key)
        if p1 and p2:
            path_keys = p1 + p2[1:]
            vn = nodes[via_key]
            via_stop = {
                'kind':  via_kind,
                'floor': vn['floor'],
                'id':    vn['id'],
                'name':  vn['name'],
                'x':     round(vn['cx'], 1),
                'y':     round(vn['cy'], 1),
                'waypoint_index': len(p1) - 1,
            }
    elif via_floor and via_id:
        via_key = f"{via_floor}:{via_id}"
        if via_key not in nodes:
            return jsonify({'error': f'Via room not in graph: {via_key}'}), 400
        p1 = dijkstra(nodes, adj, start_key, via_key)
        p2 = dijkstra(nodes, adj, via_key, goal_key)
        if p1 and p2:
            path_keys = p1 + p2[1:]
            vn = nodes[via_key]
            via_stop = {
                'kind':  vn['type'],
                'floor': vn['floor'],
                'id':    vn['id'],
                'name':  vn['name'],
                'x':     round(vn['cx'], 1),
                'y':     round(vn['cy'], 1),
                'waypoint_index': len(p1) - 1,
            }

    if not path_keys:
        return jsonify({'error': 'No path found'}), 404

    # ── Feature A: indirect room access ──────────────────────────────────────
    indirect_access = None
    trunc, inters, stop_info = truncate_indirect_path(path_keys, nodes, adj)
    if inters:
        goal_n = nodes[path_keys[-1]]
        indirect_access = {
            'destination': {
                'id':    goal_n['id'],
                'name':  goal_n['name'],
                'floor': goal_n['floor'],
            },
            'intermediate_rooms': inters,
            'stop_at': stop_info,
        }
        path_keys = trunc

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
        # new
        'indirect_access':        indirect_access,   # None if not applicable
        'resolved_amenity':       resolved_amenity,  # None if not applicable
        'via_stop':               via_stop,          # None if not applicable
    })


@app.route('/api/amenities')
def api_amenities():
    kind       = request.args.get('kind', '')
    from_floor = request.args.get('from_floor', '')
    from_id    = request.args.get('from_id', '')
    use_elev   = request.args.get('use_elevator', 'true').lower() == 'true'

    try:
        nodes, adj = build_graph(use_elevator=use_elev, use_stairs=not use_elev)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    start_key = f"{from_floor}:{from_id}" if from_floor and from_id else None
    d_from = {}
    if start_key and start_key in nodes:
        d_from, _ = dijkstra_all(nodes, adj, start_key)

    items = []
    for k, n in nodes.items():
        if n['type'] == kind:
            items.append({
                'floor': n['floor'],
                'id':    n['id'],
                'name':  n['name'],
                'x':     round(n['cx'], 1),
                'y':     round(n['cy'], 1),
                'cost':  d_from.get(k),
            })
    items.sort(key=lambda i: (math.inf if i['cost'] is None else i['cost']))
    return jsonify({'amenities': items, 'nearest': items[0] if items else None})


if __name__ == '__main__':
    # Pre-warm the graph cache
    print('Building navigation graph…')
    build_graph(use_elevator=True)
    build_graph(use_elevator=False)
    print('Ready.')
    app.run(debug=True, port=5000)
