# Harvard Science Center — Indoor Navigation System

**CS32 Final Project · Harvard University · April 2026**

---

## What This Project Does

This project is an interactive **indoor navigation tool and floor-plan explorer** for the Science Center. Google Maps handles outdoor routes well, but does not give guidance once you step inside a building, which is the gap our project aims to solve. To do this, we use hand-drawn floor plans of the Science Center and our code to find the optimal route from A to B, based on user filters.

The system has two components:

| Component | Port | Purpose |
|-----------|------|---------|
| **Mapping server** (`app.py`) | 5000 | Interactive floor-plan viewer with room search, type filter, and turn-by-turn navigation across floors |
| **Labeling server** (`IndoorNav/serve.py`) | 3000 | React-based polygon annotation tool used to draw and tag rooms on raw floor-plan images |

### Mapping server features

- **Floor browser** — sidebar arrows and floor badges let you jump between floors 1, 2, 3, and 5 (Floor 4 omitted from raw floor plans).
- **Room search** — fuzzy matching accepts variants of the same room - for example, `322`, `Room 322`, `R322`, `Cabot`, etc.
- **Type filter** — When user selects for a specific type of room, dropdown greys out all rooms except the selected type (office, classroom, …).
- **Navigation** — When the user types any two rooms in the *From / To* fields, the server computes the shortest
  path via Dijkstra and draws an animated dashed line that follows hallway geometry. User-facing rooms are entered and exited through designated door or connection nodes; direct corridor-to-room shortcuts are ignored.
- **Multi-floor routing** — stairwells and elevators connect floors by matching the closest same-type connector coordinates on adjacent floors.  An **"I am here"** button
  appears at each floor-change point; pressing it advances the map to the target floor on the route,
  skipping in-between, or transit, floors automatically.
- **Elevator toggle** — checkbox selects elevator-only cross-floor routing when enabled and stair-only cross-floor routing when disabled.

---

## Repository Structure

```
smartcampus/
├── app.py                    # Flask mapping server (Dijkstra, graph, API)
├── templates/
│   └── index.html            # Single-page UI (SVG renderer, search, navigation all without reloading)
├── Floor Plans/
│   ├── floor1.json           # Annotated floor plan data (one file per floor, floor 4 omitted since was not received properly in plans)
│   ├── floor2.json
│   ├── floor3.json
│   └── floor5.json
├── IndoorNav/
│   ├── serve.py              # Labeling server (port 3000)
│   └── src/                  # React annotation tool source (to hand-draw maps)
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

It runs a React app directly in the browser using Babel (so there’s no build step). You can load a floor plan image, click to draw room shapes, label them (type, name, neighbors), and export everything as a JSON file that `app.py` can use.

### Running the notebook

Open `FloorPlan_Explorer.ipynb` in Jupyter or VS Code and run all cells top-to-bottom.
The notebook requires the `Floor Plans/` directory to be present at the same level.

```bash
pip install jupyter matplotlib pandas numpy
jupyter notebook FloorPlan_Explorer.ipynb
```

---

## AI Tool Usage

In some parts of the project, we made use of AI, helping us with debugging, improving efficiency and visual elements that we struggled with, and informing our understanding and helping write code on certain topics outside the class scope, e.g. the single-page UI we created using React and the .html landscape, or Dijkstra's algorithm.

### Specific parts where AI helped write code or inform our understanding

| File | AI contribution |
|------|----------------|
| `app.py` | Here, we used AI to help us with the Dijkstra's algorithm portion - in particular, we used AI or Google searches online to create TYPE_COST multipliers in our graph that weighed hallways as lower-cost relative to classrooms or offices,  to implement this into our graphing system. and implementation, and to construct the graphs mapping source to target destinations and visualizing optimal routes. |
| `templates/index.html` | AI helped us here with visual aspects - specifically, it helped us in terms of making our path right-angled v.s. straight-line, creating an animated dashed line, developing the "I am here" multi-floor button to improve UI and User Experience, and visual symbols for elevators and stairwells. |
| `FloorPlan_Explorer.ipynb` | We utilized AI to help us with creating the labeling system that we used to label our floor-plans with doors, rooms, hallways, and cross-floor connections. |




---

## External References

- **Flask** — https://flask.palletsprojects.com/
- **Matplotlib `Polygon` patch** — https://matplotlib.org/stable/api/patches_api.html
- **SVG stroke-dashoffset animation** — MDN Web Docs:
  https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/stroke-dashoffset
- **React via Babel standalone** (labeling tool) — https://babeljs.io/docs/babel-standalone

No code was copied from tutorials or Stack Overflow.  All implementations were written
from scratch (with AI assistance as mentioned in the section above) for this project.

---

## License

For educational purposes as part of CS32 at Harvard University.