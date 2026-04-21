"""
app.py  –  Flask backend for the Harvard Science Center indoor navigation app.

Routes:
    GET /              → serve static/index.html
    GET /api/building  → full building JSON (rooms without status field)
    GET /api/search    → room search  (?q=<query>)
    GET /api/path      → BFS path    (?from=<id>&to=<id>)
"""

from flask import Flask, jsonify, request, send_from_directory

from data import BUILDING, ROOM_INDEX, TYPE_INDEX, search_rooms, find_path

app = Flask(__name__, static_folder="static", static_url_path="")


# ---------------------------------------------------------------------------
# CORS helper
# ---------------------------------------------------------------------------

def _add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/building")
def api_building():
    """Return the full building data as JSON, omitting the status field."""
    floors_out = []
    for floor in BUILDING["floors"]:
        floor_num = floor["floorNumber"]
        button_label = "B" if floor_num == 0 else str(floor_num)

        rooms_out = []
        for room in floor["rooms"]:
            rooms_out.append({
                "id":             room["id"],
                "name":           room["name"],
                "type":           room["type"],
                "floor":          room["floor"],
                "pixelCoords":    room["pixelCoords"],
                "neighbors":      room.get("neighbors", []),
                "amenitySubtype": room.get("amenitySubtype", None),
                "verticalGroup":  room.get("verticalGroup", None),
                "description":    room.get("description", ""),
            })

        floors_out.append({
            "floorNumber": floor_num,
            "label":       floor["label"],
            "buttonLabel": button_label,
            "rooms":       rooms_out,
        })

    payload = {
        "buildingId": BUILDING["buildingId"],
        "name":       BUILDING["name"],
        "viewBox":    {"width": 1210, "height": 930},
        "floors":     floors_out,
    }
    return _add_cors(jsonify(payload))


@app.route("/api/search")
def api_search():
    """Search rooms by query string.

    Query params:
        q  (str, required)  – search term

    Returns 400 if q is missing or empty.
    """
    q = request.args.get("q", "").strip()
    if not q:
        return _add_cors(jsonify({"error": "query parameter 'q' is required"})), 400

    results = search_rooms(q, ROOM_INDEX, TYPE_INDEX)

    results_out = []
    for room in results:
        floor_num   = room["floor"]
        floor_label = "Basement" if floor_num == 0 else f"Floor {floor_num}"
        results_out.append({
            "id":         room["id"],
            "name":       room["name"],
            "type":       room["type"],
            "floor":      floor_num,
            "floorLabel": floor_label,
        })

    return _add_cors(jsonify({"query": q, "results": results_out}))


@app.route("/api/path")
def api_path():
    """Find the shortest BFS path between two rooms.

    Query params:
        from  (str, required)  – start room id
        to    (str, required)  – target room id

    Returns 400 if params missing, 404 if either room id is unknown,
    or a 400 with error message if a ValueError is raised.
    """
    from_id = request.args.get("from", "").strip()
    to_id   = request.args.get("to",   "").strip()

    if not from_id or not to_id:
        return _add_cors(
            jsonify({"error": "query parameters 'from' and 'to' are required"})
        ), 400

    if from_id not in ROOM_INDEX:
        return _add_cors(jsonify({"error": f"Unknown room id: '{from_id}'"})), 404
    if to_id not in ROOM_INDEX:
        return _add_cors(jsonify({"error": f"Unknown room id: '{to_id}'"})), 404

    try:
        path_ids = find_path(from_id, to_id, ROOM_INDEX)
    except ValueError as exc:
        return _add_cors(jsonify({"error": str(exc)})), 400

    path_out = []
    floors_seen = []
    for room_id in path_ids:
        room = ROOM_INDEX[room_id]
        floor_num = room["floor"]
        if floor_num not in floors_seen:
            floors_seen.append(floor_num)
        path_out.append({
            "id":          room["id"],
            "name":        room["name"],
            "floor":       floor_num,
            "pixelCoords": room["pixelCoords"],
        })

    return _add_cors(jsonify({
        "from":            from_id,
        "to":              to_id,
        "path":            path_out,
        "hops":            max(0, len(path_out) - 1),
        "floorsTraversed": sorted(floors_seen),
    }))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
