# Hide Items for Fontra

A small Fontra plugin that adds Blender-style hiding to the glyph editor. Hide
individual nodes or whole contours to get them out of the way while editing.
Hiding is view-only: nothing is written into the font, and the full glyph is
always shown when you leave edit mode.

## Features

- Hide selected nodes and contours with `H`.
- Hide everything that is not selected with `Shift+H`.
- Reveal everything in the current glyph with `Alt+H` (or **Edit > Reveal All**
  as a fallback).
- Hiding a node also hides its adjacent segments, leaving a visible gap in the
  outline.
- Hidden nodes are excluded from clicking, marquee selection, Select All,
  hovering and path hit-testing.
- Hidden state is remembered per glyph across page reloads.
- Hidden state is shared by all sources/layers of the same glyph.
- Works with open and closed contours, quadratic and cubic curves, and
  components (components themselves are not hideable).
- Self-contained: no dependencies and no changes to Fontra's files.

## Install

### From GitHub

1. Put `plugin.json` and `start.js` in the root of a public GitHub repository.
2. In Fontra, open **Fontra > Plugin Manager**, click **Add**, and enter the
   repository as `user/repo`.
3. Reload the editor.

Fontra fetches GitHub plugins through jsDelivr, so a fresh commit may take a
short while to appear.

### From a local folder

Fontra loads plugins from a URL, so the server must allow cross-origin requests.
This folder includes a small development server that sends the needed CORS
headers:

```sh
python serve.py
```

Then open **Fontra > Plugin Manager**, add `http://localhost:8002`, and reload
the editor. Use a different port with `python serve.py --port 8003` if needed.

To work on the plugin, edit `start.js`, then reload the editor. The development
server disables caching.

## Usage

Open a glyph in edit mode and select some nodes or contours.

| Shortcut    | Action                                              |
| ----------- | --------------------------------------------------- |
| `H`         | Hide the selected nodes/contours                     |
| `Shift+H`   | Hide everything that is not selected                 |
| `Alt+H`     | Reveal everything in the current glyph               |

A contour is treated as fully selected when all of its on-curve points are
selected. This means `Ctrl+A` followed by `H` hides whole contours without also
requiring the off-curve handles to be selected.

**Edit > Reveal All** is also available in the menu. It is mainly a fallback for
`Alt+H`, which some browsers or window managers use for their own menus.

Hidden state is stored in `localStorage` under `fontra.hide-items.v1`, keyed by
the Fontra project identifier and glyph name. Remove the plugin from the Plugin
Manager to uninstall it.

## Notes and limitations

- Hiding is per glyph and per browser, not saved in the font file.
- If all on-curve points of a contour are hidden, the whole contour is treated
  as hidden, including any remaining off-curve handles.
- When the currently edited glyph's number of points or contours changes, the
  stored indices are no longer meaningful and the plugin clears that glyph's
  hidden state automatically.
- Different sources of the same glyph normally share the same topology, so the
  same hidden indices apply to every source/layer. If a background or editing
  layer has a different number of points or contours, that layer is drawn
  unfiltered rather than applying the indices to the wrong nodes.
- Components, anchors and guidelines are not hideable; only the glyph's own
  nodes and contours are.
- Filling is skipped for a contour that has a hidden node, because filling the
  remaining open path would close the gap with an artificial straight edge.
- The plugin relies on Fontra's visualization layers and scene-model internals.
  It is tested with Fontra 2026.10.0; a future Fontra version may require
  updates.
