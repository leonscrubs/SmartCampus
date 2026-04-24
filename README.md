# Harvard Science Center — Indoor Navigation System

**CS32 Final Project · Harvard University · April 2026**

---

## What This Project Does

This project is an interactive **indoor navigation and floor-plan explorer** for the
Harvard Science Center.  It solves the problem that Google Maps handles outdoor routing
well but gives no guidance once you step inside a building.

The system has two components:

| Component | Port | Purpose |
|-----------|------|---------|
| **Mapping server** (`app.py`) | 5000 | Interactive floor-plan viewer with room search, type filter, and turn-by-turn navigation across floors |
| **Labeling server** (`IndoorNav/serve.py`) | 3000 | React-based polygon annotation tool used to draw and tag rooms on raw floor-plan images |

### Mapping server features

- **Floor browser** — sidebar arrows and floor badges let you jump between floors 1, 2, 3, and 5.
- **Room search** — fuzzy matching accepts `322`, `Room 322`, `R322`, `Cabot`, etc.
- **Type filter** — dropdown greys out all rooms except the selected type (office, classroom, …).
- **Navigation** — type any two rooms in the *From / To* fields; the server computes the shortest
  path via Dijkstra and draws an animated dashed line that follows hallways.  Rooms cost 80× more
  to traverse than corridors, so the route always prefers hallways.
- **Multi-floor routing** — stairwells and elevators connect floors.  An **"I am here"** button
  appears at each floor-change point; pressing it advances the map to the next floor on the route,
  skipping pure transit floors automatically.
- **Elevator toggle** — checkbox forces stairs-only routing.

---

## Repository Structure

```
smartcampus/
├── app.py                    # Flask mapping server (Dijkstra, graph, API)
├── templates/
│   └── index.html            # Single-page UI (SVG renderer, search, navigation)
├── Floor Plans/
│   ├── floor1.json           # Annotated floor plan data (one file per floor)
│   ├── floor2.json
│   ├── floor3.json
│   └── floor5.json
├── IndoorNav/
│   ├── serve.py              # Labeling server (port 3000)
│   └── src/                  # React annotation tool source
├── FloorPlan_Explorer.ipynb  # ← submission notebook
└── README.md                 # ← this file
```

---

## Setup and Running

### Requirements

```bash
pip install flask matplotlib pandas numpy
```

No API keys are required.  All data is stored locally as JSON files.

### Running the mapping server

```bash
cd /path/to/smartcampus
python3 app.py
# Server starts on http://localhost:5000
# The navigation graph is pre-warmed automatically at startup.
```

Open `http://localhost:5000` in your browser.  In VS Code or GitHub Codespaces, go to the
**Ports** tab and click the globe icon next to port 5000.

### Running the labeling server

The labeling tool is only needed if you want to annotate a new floor plan image.

```bash
python3 IndoorNav/serve.py
# Opens http://localhost:3000
```

It serves a React app via Babel standalone — no build step is needed.  Load a floor-plan
PNG as the background, draw room polygons by clicking vertices, assign type / name / neighbors,
and export the result as a JSON file for `app.py` to consume.

### Running the notebook

Open `FloorPlan_Explorer.ipynb` in Jupyter or VS Code and run all cells top-to-bottom.
The notebook requires the `Floor Plans/` directory to be present at the same level.

```bash
pip install jupyter matplotlib pandas numpy
jupyter notebook FloorPlan_Explorer.ipynb
```

---

## External References

- **Dijkstra's algorithm** — standard algorithm; implementation follows the min-heap variant
  from CLRS *Introduction to Algorithms*.  No code was copied.
- **Flask** — https://flask.palletsprojects.com/
- **Matplotlib `Polygon` patch** — https://matplotlib.org/stable/api/patches_api.html
- **SVG stroke-dashoffset animation** — MDN Web Docs:
  https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/stroke-dashoffset
- **React via Babel standalone** (labeling tool) — https://babeljs.io/docs/babel-standalone

---

## License

For educational purposes as part of CS32 at Harvard University.
