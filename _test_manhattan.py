import sys; sys.path.insert(0,'/workspaces/smartcampus')
import app
app._graph_cache.clear()
nodes_elev, adj_elev = app.build_graph(use_elevator=True, use_stairs=True)
nodes_stair, adj_stair = app.build_graph(use_elevator=False, use_stairs=True)

def find_node(nodes, rid, fid):
    try:
        return next(k for k,v in nodes.items() if rid in k and v['floor']==fid)
    except StopIteration:
        return None

def check_manhattan(pts, route_label):
    diags = []
    for i in range(1, len(pts)):
        a, b = pts[i-1], pts[i]
        dx, dy = abs(b['x']-a['x']), abs(b['y']-a['y'])
        if dx > 0.5 and dy > 0.5:
            diags.append((i, a, b, dx, dy))
    if diags:
        print(f'FAIL {route_label}: {len(diags)} diagonal(s)')
        for i,a,b,dx,dy in diags:
            print(f'  seg {i}: ({a["x"]:.0f},{a["y"]:.0f})->({b["x"]:.0f},{b["y"]:.0f}) dx={dx:.1f} dy={dy:.1f}')
        return False
    else:
        print(f'PASS {route_label}: all {len(pts)-1} segments axis-aligned')
        return True

def run_route(nodes, adj, start_key, end_key, label):
    if start_key is None or end_key is None:
        print(f'SKIP {label}: missing key (start={start_key}, end={end_key})')
        return None, None
    path = app.dijkstra(nodes, adj, start_key, end_key)
    if not path:
        print(f'SKIP {label}: no path')
        return None, None
    pts = app.route_draw_points(path, nodes)
    ok = check_manhattan(pts, label)
    return path, pts

# Identify available rooms first to find one in floor 2 and 5 etc.
def list_rooms(nodes, fid, n=5):
    return [k for k,v in nodes.items() if v.get('type')=='room' and v['floor']==fid][:n]

print('Floor 2 rooms:', list_rooms(nodes_elev, 2))
print('Floor 5 rooms:', list_rooms(nodes_elev, 5))
print('Floor B rooms:', list_rooms(nodes_elev, 'B'))
print('Floor 1 rooms (sample):', list_rooms(nodes_elev, 1, 10))

routes = [
    ('sc-1-cabot-library', 1, 'sc-1-lecture-hall-a', 1, 'F1: cabot->lectureA'),
    ('sc-1-cabot-library', 1, 'sc-2-room-209', 2, 'F1->F2: cabot->209'),
    ('sc-1-cabot-library', 1, 'sc-3-room-311', 3, 'F1->F3: cabot->311'),
    ('sc-3-room-300h', 3, 'sc-3-room-311', 3, 'F3 internal: 300h->311'),
    ('sc-3-room-300h', 3, 'sc-3-restroom', 3, 'F3 internal: 300h->restroom'),
]

for rid_a, fa, rid_b, fb, label in routes:
    for tag, nodes, adj in [('elev', nodes_elev, adj_elev), ('stair', nodes_stair, adj_stair)]:
        sk = find_node(nodes, rid_a, fa)
        ek = find_node(nodes, rid_b, fb)
        run_route(nodes, adj, sk, ek, f'[{tag}] {label}')

# F2 -> F5
f2_rooms = list_rooms(nodes_elev, 2)
f5_rooms = list_rooms(nodes_elev, 5)
if f2_rooms and f5_rooms:
    for tag, nodes, adj in [('elev', nodes_elev, adj_elev), ('stair', nodes_stair, adj_stair)]:
        f2 = list_rooms(nodes, 2); f5 = list_rooms(nodes, 5)
        if f2 and f5:
            run_route(nodes, adj, f2[0], f5[0], f'[{tag}] F2->F5: {f2[0]}->{f5[0]}')

# B -> 1
fB_rooms = list_rooms(nodes_elev, 'B')
if fB_rooms:
    for tag, nodes, adj in [('elev', nodes_elev, adj_elev), ('stair', nodes_stair, adj_stair)]:
        fB = list_rooms(nodes, 'B')
        if fB:
            ek = find_node(nodes, 'sc-1-cabot-library', 1)
            run_route(nodes, adj, fB[0], ek, f'[{tag}] B->F1: {fB[0]}->cabot')

# Via route
print('\n--- Via route test ---')
if hasattr(app, 'find_best_via'):
    sk = find_node(nodes_elev, 'sc-1-cabot-library', 1)
    ek = find_node(nodes_elev, 'sc-3-room-311', 3)
    via_rid = 'sc-2-room-209'
    vk = find_node(nodes_elev, via_rid, 2)
    print(f'find_best_via signature test... start={sk} via={vk} end={ek}')
    try:
        # Try common signatures
        import inspect
        sig = inspect.signature(app.find_best_via)
        print('signature:', sig)
    except Exception as e:
        print('inspect err:', e)
else:
    print('find_best_via not available')
