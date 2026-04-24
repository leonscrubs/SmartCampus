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

# Index position of each floor — used to compute inter-floor distance cost
FLOOR_IDX = {f: i for i, f in enumerate(FLOOR_ORDER)}


def centroid(polygon):
    n = len(polygon)
    return (sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n)


def euclid(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


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

        for room in rooms:
            rid = room['id']
            t   = room.get('type', 'other')
            pts = room.get('polygon', [])
            if not pts:
                continue
            if t == 'elevator' and not use_elevator:
                continue
            if t == 'stairwell' and not use_stairs:
                continue

            cx, cy = centroid(pts)
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            w = max(xs) - min(xs); h = max(ys) - min(ys)

            key = f"{fid}:{rid}"
            nodes[key] = {
                'type': t, 'cx': cx, 'cy': cy, 'floor': fid,
                'id': rid, 'name': room.get('name', rid),
                'orientation': 'h' if w >= h else 'v',
                'connectsFloors': [str(x) for x in room.get('connectsFloors', [])],
            }
            adj.setdefault(key, [])

        for room in rooms:
            rid = room['id']
            t   = room.get('type', 'other')
            if t == 'elevator' and not use_elevator:
                continue
            if t == 'stairwell' and not use_stairs:
                continue

            src_key = f"{fid}:{rid}"
            if src_key not in nodes:
                continue
            src = nodes[src_key]

            for nbr_id in room.get('neighbors', []):
                if not nbr_id or nbr_id == 'outside':
                    continue
                dst_key = f"{fid}:{nbr_id}"
                if dst_key not in nodes:
                    continue
                dst = nodes[dst_key]

                px_dist = euclid((src['cx'], src['cy']), (dst['cx'], dst['cy']))
                # Cost = pixel distance × type multiplier of destination
                # Rooms penalised heavily so Dijkstra prefers hallways
                cost = px_dist * TYPE_COST.get(dst['type'], 20.0)

                adj[src_key].append((dst_key, cost))

    # ── Auto-connect orphaned nodes to nearest reachable rooms ────────────────
    # Nodes with no neighbors OR whose only neighbors are high-cost room types
    # (making them effectively isolated) get snapped to the 2 closest nodes
    # within SNAP_RADIUS on the same floor.
    SNAP_RADIUS = 600
    LOW_COST_TYPES = {'corridor', 'entrance', 'door', 'connection', 'stairwell', 'elevator'}

    def needs_snap(key):
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
             if n['floor'] == fid and k != key and k not in {nbr for nbr, _ in adj.get(key, [])})
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

    used_pairs = set()
    for key_a, na in connectors:
        for key_b, nb in connectors:
            if nb['floor'] == na['floor']:
                continue
            if nb['type'] != na['type']:
                continue
            if (na['floor'], nb['floor']) not in adjacent_pairs:
                continue
            # Must share at least one floor in their connectsFloors
            if not (set(na['connectsFloors']) & set(nb['connectsFloors'])):
                continue
            pair = tuple(sorted([key_a, key_b]))
            if pair in used_pairs:
                continue
            used_pairs.add(pair)
            adj[key_a].append((key_b, FLOOR_CHANGE_COST))
            adj[key_b].append((key_a, FLOOR_CHANGE_COST))

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

    try:
        nodes, adj = build_graph(use_elevator=use_elev)
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

    return jsonify({
        'waypoints':      waypoints,
        'total_px':       round(total_px),
        'floors_visited': floors_visited,
    })


if __name__ == '__main__':
    # Pre-warm the graph cache
    print('Building navigation graph…')
    build_graph(use_elevator=True)
    build_graph(use_elevator=False)
    print('Ready.')
    app.run(debug=True, port=5000)
