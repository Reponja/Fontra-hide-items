// Fontra "Hide Items" plugin
//
// Blender-style hiding for glyph editor nodes and contours:
//   H        hide the selected nodes/contours
//   Shift+H  hide everything that is not selected
//   Alt+H    reveal everything in the current glyph
//
// Hidden state is view-only. It is stored in localStorage, keyed by project
// and glyph name, and never written into the font. Outside edit mode the full
// glyph is always drawn, because the regular non-editing layers are untouched.
// The Power Ruler also treats hidden nodes and contours as absent.

const STORAGE_KEY = "fontra.hide-items.v1";
const STORAGE_VERSION = 1;

const POINT_TYPE_MASK = 0x07;
const ON_CURVE = 0x00;
const OFF_CURVE_QUAD = 0x01;

const START_POINT_ARC_GAP_ANGLE = 0.25 * Math.PI;

const isMac = /Mac|iPhone|iPad|iPod/.test(
  navigator.platform || navigator.userAgent || ""
);
const ALT_LABEL = isMac ? "\u2325" : "Alt+";

let pluginState = null;

// ---------------------------------------------------------------------------
// Storage
//
// {
//   version: 1,
//   projects: {
//     "p:<projectIdentifier>": {
//       "g:<glyphName>": {
//         numPoints, numContours,
//         hiddenPoints: [...],
//         hiddenContours: [...]
//       }
//     }
//   }
// }
// ---------------------------------------------------------------------------

function loadStore() {
  const fresh = { version: STORAGE_VERSION, projects: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fresh;
    }
    const data = JSON.parse(raw);
    if (
      !data ||
      data.version !== STORAGE_VERSION ||
      !data.projects ||
      typeof data.projects !== "object" ||
      Array.isArray(data.projects)
    ) {
      return fresh;
    }
    return data;
  } catch (error) {
    return fresh;
  }
}

function saveStore() {
  if (!pluginState) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pluginState.store));
  } catch (error) {
    // localStorage can be unavailable in private browsing or sandboxed contexts.
  }
}

function projectStoreKey() {
  const projectIdentifier = String(pluginState?.editor?.projectIdentifier ?? "");
  return "p:" + (projectIdentifier || "default");
}

function getProjectStore(create = false) {
  if (!pluginState) {
    return null;
  }
  const projects = pluginState.store.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    pluginState.store.projects = {};
  }
  const key = projectStoreKey();
  let project = Object.prototype.hasOwnProperty.call(
    pluginState.store.projects,
    key
  )
    ? pluginState.store.projects[key]
    : undefined;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    if (!create) {
      return null;
    }
    project = {};
    pluginState.store.projects[key] = project;
  }
  return project;
}

function glyphStoreKey(glyphName) {
  return "g:" + glyphName;
}

function emptyState() {
  return { hiddenPoints: new Set(), hiddenContours: new Set() };
}

function getStateForGlyph(glyphName, path, { clearOnMismatch = true } = {}) {
  const project = getProjectStore(false);
  if (!project) {
    return null;
  }
  const key = glyphStoreKey(glyphName);
  if (!Object.prototype.hasOwnProperty.call(project, key)) {
    return null;
  }
  const entry = project[key];
  if (
    !entry ||
    entry.numPoints !== path.numPoints ||
    entry.numContours !== path.numContours
  ) {
    // The glyph's topology changed (or the entry is from an older format).
    // Point indices are no longer meaningful, so drop the stale state.
    // Background layers may legitimately have a different topology; only the
    // currently edited glyph is allowed to clear the shared state.
    if (clearOnMismatch) {
      delete project[key];
      saveStore();
    }
    return null;
  }
  const state = normalizeEntry(entry, path);
  if (!state) {
    if (clearOnMismatch) {
      delete project[key];
      saveStore();
    }
    return null;
  }
  return state;
}

function hasStoredState(glyphName) {
  const project = getProjectStore(false);
  return (
    !!project && Object.prototype.hasOwnProperty.call(project, glyphStoreKey(glyphName))
  );
}

function setStateForGlyph(glyphName, path, state) {
  const project = getProjectStore(true);
  if (!project) {
    return;
  }
  const key = glyphStoreKey(glyphName);
  const normalized = state ? normalizeState(state, path) : null;
  if (!normalized) {
    if (Object.prototype.hasOwnProperty.call(project, key)) {
      delete project[key];
      saveStore();
    }
    return;
  }
  project[key] = {
    numPoints: path.numPoints,
    numContours: path.numContours,
    hiddenPoints: [...normalized.hiddenPoints].sort((a, b) => a - b),
    hiddenContours: [...normalized.hiddenContours].sort((a, b) => a - b),
  };
  saveStore();
}

function normalizeEntry(entry, path) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const hiddenContours = new Set();
  if (Array.isArray(entry.hiddenContours)) {
    for (const contourIndex of entry.hiddenContours) {
      if (
        Number.isInteger(contourIndex) &&
        contourIndex >= 0 &&
        contourIndex < path.numContours
      ) {
        hiddenContours.add(contourIndex);
      }
    }
  }
  const hiddenPoints = new Set();
  if (Array.isArray(entry.hiddenPoints)) {
    for (const pointIndex of entry.hiddenPoints) {
      if (
        Number.isInteger(pointIndex) &&
        pointIndex >= 0 &&
        pointIndex < path.numPoints
      ) {
        const contourIndex = getContourIndexForPoint(path, pointIndex);
        if (contourIndex !== undefined && !hiddenContours.has(contourIndex)) {
          hiddenPoints.add(pointIndex);
        }
      }
    }
  }
  return normalizeState({ hiddenPoints, hiddenContours }, path);
}

function normalizeState(state, path) {
  const hiddenContours = new Set();
  for (const contourIndex of state.hiddenContours) {
    if (
      Number.isInteger(contourIndex) &&
      contourIndex >= 0 &&
      contourIndex < path.numContours
    ) {
      hiddenContours.add(contourIndex);
    }
  }
  const hiddenPoints = new Set();
  for (const pointIndex of state.hiddenPoints) {
    if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= path.numPoints) {
      continue;
    }
    const contourIndex = getContourIndexForPoint(path, pointIndex);
    if (contourIndex === undefined || hiddenContours.has(contourIndex)) {
      continue;
    }
    hiddenPoints.add(pointIndex);
  }

  // Once all on-curve points of a contour are hidden, every segment of that
  // contour is hidden too (each segment has at least one hidden on-curve
  // parent point), so store the contour instead. This keeps the state compact
  // and also hides the remaining off-curve handles. Quad blobs have no
  // on-curve points: hiding any of their points hides the whole blob, so
  // promote those as well.
  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    if (hiddenContours.has(contourIndex)) {
      continue;
    }
    const [startPoint, endPoint] = contourRange(path, contourIndex);
    if (endPoint < startPoint) {
      continue;
    }
    const onCurvePointIndices = [];
    for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
      if (isOnCurvePoint(path.pointTypes[pointIndex])) {
        onCurvePointIndices.push(pointIndex);
      }
    }
    let fullyHidden;
    if (onCurvePointIndices.length) {
      fullyHidden = onCurvePointIndices.every((pointIndex) =>
        hiddenPoints.has(pointIndex)
      );
    } else {
      fullyHidden = false;
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        if (hiddenPoints.has(pointIndex)) {
          fullyHidden = true;
          break;
        }
      }
    }
    if (fullyHidden) {
      hiddenContours.add(contourIndex);
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        hiddenPoints.delete(pointIndex);
      }
    }
  }

  if (!hiddenPoints.size && !hiddenContours.size) {
    return null;
  }
  return { hiddenPoints, hiddenContours };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function contourRange(path, contourIndex) {
  const startPoint =
    contourIndex === 0 ? 0 : path.contourInfo[contourIndex - 1].endPoint + 1;
  return [startPoint, path.contourInfo[contourIndex].endPoint];
}

function getContourIndexForPoint(path, pointIndex) {
  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    if (pointIndex <= path.contourInfo[contourIndex].endPoint) {
      return contourIndex;
    }
  }
  return undefined;
}

function isOnCurvePoint(pointType) {
  return (pointType & POINT_TYPE_MASK) === ON_CURVE;
}

function isPointHidden(state, path, pointIndex) {
  const contourIndex = getContourIndexForPoint(path, pointIndex);
  return (
    contourIndex !== undefined &&
    (state.hiddenContours.has(contourIndex) ||
      state.hiddenPoints.has(pointIndex))
  );
}

function makeHiddenInfo(path, state) {
  const pointToContour = new Array(path.numPoints);
  let contourIndex = 0;
  for (let pointIndex = 0; pointIndex < path.numPoints; pointIndex++) {
    while (
      contourIndex < path.numContours &&
      pointIndex > path.contourInfo[contourIndex].endPoint
    ) {
      contourIndex++;
    }
    pointToContour[pointIndex] = contourIndex;
  }
  return {
    isContourHidden(contourIndex) {
      return state.hiddenContours.has(contourIndex);
    },
    isPointHidden(pointIndex) {
      if (pointIndex < 0 || pointIndex >= path.numPoints) {
        return false;
      }
      const pointContourIndex = pointToContour[pointIndex];
      return (
        state.hiddenContours.has(pointContourIndex) ||
        state.hiddenPoints.has(pointIndex)
      );
    },
  };
}

function getStateForPositionedGlyph(positionedGlyph) {
  if (!positionedGlyph?.isEditing) {
    return null;
  }
  const glyphName = positionedGlyph.glyphName;
  const path = positionedGlyph.glyph?.path;
  if (glyphName === undefined || glyphName === null || !path) {
    return null;
  }
  return getStateForGlyph(glyphName, path);
}

function getStateForSceneModel(sceneModel) {
  if (!sceneModel?.selectedGlyph?.isEditing) {
    return null;
  }
  const positionedGlyph = sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph) {
    return null;
  }
  return getStateForPositionedGlyph(positionedGlyph);
}

function getStateForLayerGlyph(layerGlyph) {
  const glyphName = layerGlyph?.name;
  const path = layerGlyph?.path;
  if (glyphName === undefined || glyphName === null || !path) {
    return null;
  }
  return getStateForGlyph(glyphName, path, { clearOnMismatch: false });
}

function pointSelectionIndex(item) {
  if (typeof item !== "string" || !item.startsWith("point/")) {
    return undefined;
  }
  const index = Number(item.slice("point/".length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function getPointIndicesFromSelection(selection) {
  const pointIndices = [];
  if (!selection || typeof selection[Symbol.iterator] !== "function") {
    return pointIndices;
  }
  for (const item of selection) {
    const index = pointSelectionIndex(item);
    if (index !== undefined) {
      pointIndices.push(index);
    }
  }
  return pointIndices;
}

function selectionParts(selection) {
  const result = { point: [], component: [], anchor: [], guideline: [] };
  if (!selection || typeof selection[Symbol.iterator] !== "function") {
    return result;
  }
  for (const item of selection) {
    if (typeof item !== "string") {
      continue;
    }
    const slashIndex = item.indexOf("/");
    if (slashIndex < 0) {
      continue;
    }
    const type = item.slice(0, slashIndex);
    if (!Object.prototype.hasOwnProperty.call(result, type)) {
      continue;
    }
    const index = Number(item.slice(slashIndex + 1));
    if (Number.isInteger(index) && index >= 0) {
      result[type].push(index);
    }
  }
  return result;
}

function filterPointSelection(selection, isHidden) {
  if (!selection || !isHidden) {
    return selection;
  }
  let changed = false;
  const result = new Set();
  for (const item of selection) {
    const index = pointSelectionIndex(item);
    if (index !== undefined && isHidden(index)) {
      changed = true;
      continue;
    }
    result.add(item);
  }
  return changed ? result : selection;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centeredRect(x, y, width, height = width) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return {
    xMin: x - halfWidth,
    yMin: y - halfHeight,
    xMax: x + halfWidth,
    yMax: y + halfHeight,
  };
}

function pointInRect(x, y, rect) {
  return rect && x >= rect.xMin && x <= rect.xMax && y >= rect.yMin && y <= rect.yMax;
}

function rectsIntersect(rectA, rectB) {
  return (
    rectA.xMin <= rectB.xMax &&
    rectA.xMax >= rectB.xMin &&
    rectA.yMin <= rectB.yMax &&
    rectA.yMax >= rectB.yMin
  );
}

function hitTestVisiblePath(pathHitTester, hiddenInfo, point, margin) {
  const targetRect = centeredRect(point.x, point.y, margin * 2);
  for (
    let contourIndex = pathHitTester.contours.length - 1;
    contourIndex >= 0;
    contourIndex--
  ) {
    if (hiddenInfo.isContourHidden(contourIndex)) {
      continue;
    }
    const contour = pathHitTester.contours[contourIndex];
    if (!contour.bounds || !rectsIntersect(targetRect, contour.bounds)) {
      continue;
    }
    pathHitTester._ensureContourIsLoaded(contourIndex, contour);
    const segments = contour.segments || [];
    for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex--) {
      const segment = segments[segmentIndex];
      if (!segment.bounds || !rectsIntersect(targetRect, segment.bounds)) {
        continue;
      }
      const parentPointIndices = segment.parentPointIndices || [];
      let visible = true;
      for (const pointIndex of parentPointIndices) {
        if (hiddenInfo.isPointHidden(pointIndex)) {
          visible = false;
          break;
        }
      }
      if (!visible) {
        continue;
      }
      const projected = segment.bezier.project(point);
      if (projected.d < margin) {
        return { contourIndex, segmentIndex, ...projected, segment };
      }
    }
  }
  return {};
}

function pointIndexNearPointFromIndices(path, point, margin, pointIndices) {
  const rect = centeredRect(point.x, point.y, margin);
  for (let i = pointIndices.length - 1; i >= 0; i--) {
    const pointIndex = pointIndices[i];
    const pt = path.getPoint(pointIndex);
    if (pt && pointInRect(pt.x, pt.y, rect)) {
      return pointIndex;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function fillNode(context, pt, cornerNodeSize, smoothNodeSize, handleNodeSize) {
  if (!pt.type && !pt.smooth) {
    context.fillRect(
      pt.x - cornerNodeSize / 2,
      pt.y - cornerNodeSize / 2,
      cornerNodeSize,
      cornerNodeSize
    );
  } else if (!pt.type) {
    context.beginPath();
    context.arc(pt.x, pt.y, smoothNodeSize / 2, 0, 2 * Math.PI, false);
    context.fill();
  } else {
    context.beginPath();
    context.arc(pt.x, pt.y, handleNodeSize / 2, 0, 2 * Math.PI, false);
    context.fill();
  }
}

function strokeNode(context, pt, cornerNodeSize, smoothNodeSize, handleNodeSize) {
  if (!pt.type && !pt.smooth) {
    context.strokeRect(
      pt.x - cornerNodeSize / 2,
      pt.y - cornerNodeSize / 2,
      cornerNodeSize,
      cornerNodeSize
    );
  } else if (!pt.type) {
    context.beginPath();
    context.arc(pt.x, pt.y, smoothNodeSize / 2, 0, 2 * Math.PI, false);
    context.stroke();
  } else {
    context.beginPath();
    context.arc(pt.x, pt.y, handleNodeSize / 2, 0, 2 * Math.PI, false);
    context.stroke();
  }
}

function strokeLine(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function strokeCircle(context, cx, cy, radius) {
  context.beginPath();
  context.arc(cx, cy, radius, 0, 2 * Math.PI, false);
  context.stroke();
}

function drawRoundRect(context, x, y, width, height, radii) {
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(x, y, width, height, radii);
  } else {
    context.rect(x, y, width, height);
  }
  context.fill();
}

function appendVisibleContour(path2d, path, contourIndex, hiddenInfo) {
  if (hiddenInfo.isContourHidden(contourIndex)) {
    return false;
  }
  const [startPoint, endPoint] = contourRange(path, contourIndex);

  let fullyVisible = true;
  for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
    if (hiddenInfo.isPointHidden(pointIndex)) {
      fullyVisible = false;
      break;
    }
  }

  if (fullyVisible) {
    // Use Fontra's own contour drawing for the common case. This preserves
    // exact curve decomposition, closing behaviour and quad blobs.
    path.drawContourToPath2d(path2d, contourIndex);
    return endPoint >= startPoint;
  }

  // Some points are hidden: draw only the decomposed segments whose parent
  // points are all visible. Consecutive visible segments share one subpath so
  // joins stay smooth; a hidden segment starts a new subpath, leaving a gap.
  let drewSomething = false;
  let lastPoint = null;
  for (const segment of path.iterContourDecomposedSegments(contourIndex)) {
    const parentPointIndices = segment.parentPointIndices || [];
    let visible = true;
    for (const pointIndex of parentPointIndices) {
      if (hiddenInfo.isPointHidden(pointIndex)) {
        visible = false;
        break;
      }
    }
    if (!visible) {
      lastPoint = null;
      continue;
    }
    const points = segment.points;
    if (!points || points.length < 2) {
      continue;
    }
    const firstPoint = points[0];
    if (
      !lastPoint ||
      lastPoint.x !== firstPoint.x ||
      lastPoint.y !== firstPoint.y
    ) {
      path2d.moveTo(firstPoint.x, firstPoint.y);
    }
    switch (segment.type) {
      case "line":
        path2d.lineTo(points[1].x, points[1].y);
        break;
      case "quad":
        if (points.length >= 3) {
          path2d.quadraticCurveTo(
            points[1].x,
            points[1].y,
            points[2].x,
            points[2].y
          );
        }
        break;
      case "cubic":
        if (points.length >= 4) {
          path2d.bezierCurveTo(
            points[1].x,
            points[1].y,
            points[2].x,
            points[2].y,
            points[3].x,
            points[3].y
          );
        }
        break;
      default:
        continue;
    }
    lastPoint = points[points.length - 1];
    drewSomething = true;
  }
  return drewSomething;
}

function appendClosedContours(path2d, path, hiddenInfo) {
  let drewSomething = false;
  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    if (!path.contourInfo[contourIndex].isClosed) {
      continue;
    }
    if (hiddenInfo) {
      if (hiddenInfo.isContourHidden(contourIndex)) {
        continue;
      }
      const [startPoint, endPoint] = contourRange(path, contourIndex);
      let fullyVisible = true;
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        if (hiddenInfo.isPointHidden(pointIndex)) {
          fullyVisible = false;
          break;
        }
      }
      if (!fullyVisible) {
        // Filling a broken contour would implicitly close the gap with a
        // straight chord. Skip the fill instead.
        continue;
      }
    }
    path.drawContourToPath2d(path2d, contourIndex);
    drewSomething = true;
  }
  return drewSomething;
}

function buildVisibleStrokePath2d(glyph, hiddenInfo) {
  const path2d = new Path2D();
  let drewSomething = false;
  const path = glyph.path;
  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    if (appendVisibleContour(path2d, path, contourIndex, hiddenInfo)) {
      drewSomething = true;
    }
  }
  // Components are not hideable; keep drawing them exactly as before.
  const componentsPath = glyph.componentsPath;
  if (componentsPath?.numContours) {
    componentsPath.drawToPath2d(path2d);
    drewSomething = true;
  }
  return drewSomething ? path2d : null;
}

function buildVisibleFillPath2d(glyph, hiddenInfo) {
  const path2d = new Path2D();
  let drewSomething = appendClosedContours(path2d, glyph.path, hiddenInfo);
  const componentsPath = glyph.componentsPath;
  if (componentsPath?.numContours) {
    if (appendClosedContours(path2d, componentsPath, null)) {
      drewSomething = true;
    }
  }
  return drewSomething ? path2d : null;
}

function* iterHandlePointIndices(path) {
  let startPoint = 0;
  for (const contour of path.contourInfo) {
    const endPoint = contour.endPoint;
    let prevIndex = contour.isClosed ? endPoint : startPoint;
    for (
      let nextIndex = startPoint + (contour.isClosed ? 0 : 1);
      nextIndex <= endPoint;
      nextIndex++
    ) {
      const prevType = path.pointTypes[prevIndex] & POINT_TYPE_MASK;
      const nextType = path.pointTypes[nextIndex] & POINT_TYPE_MASK;
      if (prevType !== nextType || nextType === OFF_CURVE_QUAD) {
        yield [prevIndex, nextIndex];
      }
      prevIndex = nextIndex;
    }
    startPoint = endPoint + 1;
  }
}

// ---------------------------------------------------------------------------
// Layer draw wrappers
// ---------------------------------------------------------------------------

function drawFilteredFill(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  const path2d = buildVisibleFillPath2d(positionedGlyph.glyph, hiddenInfo);
  if (!path2d) {
    return;
  }
  context.fillStyle = parameters.fillColor;
  context.fill(path2d);
}

function drawFilteredStroke(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  const path2d = buildVisibleStrokePath2d(positionedGlyph.glyph, hiddenInfo);
  if (!path2d) {
    return;
  }
  context.lineJoin = "round";
  context.lineWidth = parameters.strokeWidth;
  context.strokeStyle = parameters.color;
  context.stroke(path2d);
}

function drawFilteredNodes(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  const { cornerSize, smoothSize, handleSize } = parameters;
  context.fillStyle = parameters.color;
  for (let pointIndex = 0; pointIndex < path.numPoints; pointIndex++) {
    if (hiddenInfo.isPointHidden(pointIndex)) {
      continue;
    }
    const pt = path.getPoint(pointIndex);
    if (pt) {
      fillNode(context, pt, cornerSize, smoothSize, handleSize);
    }
  }
}

function drawFilteredHandles(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  context.strokeStyle = parameters.color;
  context.lineWidth = parameters.strokeWidth;
  for (const [prevIndex, nextIndex] of iterHandlePointIndices(path)) {
    if (
      hiddenInfo.isPointHidden(prevIndex) ||
      hiddenInfo.isPointHidden(nextIndex)
    ) {
      continue;
    }
    const pt1 = path.getPoint(prevIndex);
    const pt2 = path.getPoint(nextIndex);
    if (pt1 && pt2) {
      strokeLine(context, pt1.x, pt1.y, pt2.x, pt2.y);
    }
  }
}

function drawFilteredSelectedNodes(args, originalDraw) {
  const { context, positionedGlyph, parameters, model } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  const selectedPointIndices = getPointIndicesFromSelection(model.selection).filter(
    (pointIndex) => !hiddenInfo.isPointHidden(pointIndex)
  );
  const hoveredPointIndices = getPointIndicesFromSelection(
    model.hoverSelection
  ).filter((pointIndex) => !hiddenInfo.isPointHidden(pointIndex));

  const {
    cornerSize,
    smoothSize,
    handleSize,
    strokeWidth,
    hoverStrokeOffset,
    underlayOffset,
  } = parameters;

  // Under layer
  context.fillStyle = parameters.underColor;
  for (const pointIndex of selectedPointIndices) {
    const pt = path.getPoint(pointIndex);
    if (pt) {
      fillNode(
        context,
        pt,
        cornerSize + underlayOffset,
        smoothSize + underlayOffset,
        handleSize + underlayOffset
      );
    }
  }

  // Selected nodes
  context.fillStyle = parameters.selectedColor;
  for (const pointIndex of selectedPointIndices) {
    const pt = path.getPoint(pointIndex);
    if (pt) {
      fillNode(context, pt, cornerSize, smoothSize, handleSize);
    }
  }

  // Hovered nodes
  context.strokeStyle = parameters.hoveredColor;
  context.lineWidth = strokeWidth;
  for (const pointIndex of hoveredPointIndices) {
    const pt = path.getPoint(pointIndex);
    if (pt) {
      strokeNode(
        context,
        pt,
        cornerSize + hoverStrokeOffset,
        smoothSize + hoverStrokeOffset,
        handleSize + hoverStrokeOffset
      );
    }
  }
}

function drawFilteredStartPoint(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);

  context.strokeStyle = parameters.color;
  context.lineWidth = parameters.strokeWidth;
  const radius = parameters.radius;
  let startPointIndex = 0;
  for (
    let contourIndex = 0;
    contourIndex < path.numContours;
    contourIndex++
  ) {
    const contourInfo = path.contourInfo[contourIndex];
    if (
      !hiddenInfo.isContourHidden(contourIndex) &&
      !hiddenInfo.isPointHidden(startPointIndex)
    ) {
      const startPoint = path.getPoint(startPointIndex);
      if (startPoint) {
        let angle;
        if (startPointIndex < contourInfo.endPoint) {
          const nextPoint = path.getPoint(startPointIndex + 1);
          if (nextPoint) {
            const direction = {
              x: nextPoint.x - startPoint.x,
              y: nextPoint.y - startPoint.y,
            };
            angle = Math.atan2(direction.y, direction.x);
          }
        }
        let startAngle = 0;
        let endAngle = 2 * Math.PI;
        if (angle !== undefined) {
          startAngle += angle + START_POINT_ARC_GAP_ANGLE;
          endAngle += angle - START_POINT_ARC_GAP_ANGLE;
        }
        context.beginPath();
        context.arc(
          startPoint.x,
          startPoint.y,
          radius,
          startAngle,
          endAngle,
          false
        );
        context.stroke();
      }
    }
    startPointIndex = contourInfo.endPoint + 1;
  }
}

function drawFilteredContourIndex(args, originalDraw) {
  const { context, positionedGlyph, parameters } = args;
  const state = getStateForPositionedGlyph(positionedGlyph);
  const path = positionedGlyph.glyph?.path;
  if (!state || !path) {
    return originalDraw(args);
  }
  const hiddenInfo = makeHiddenInfo(path, state);
  const fontSize = parameters.fontSize;
  const margin = 0.5 * fontSize;
  const boxHeight = 1.68 * fontSize;
  const bottomY = 0.75 * fontSize * -1 - boxHeight + margin / 2;

  context.font = `${fontSize}px fontra-ui-regular, sans-serif`;
  context.textAlign = "center";
  context.scale(1, -1);

  let startPointIndex = 0;
  for (
    let contourIndex = 0;
    contourIndex < path.numContours;
    contourIndex++
  ) {
    const contourInfo = path.contourInfo[contourIndex];
    if (!hiddenInfo.isContourHidden(contourIndex)) {
      const startPoint = path.getPoint(startPointIndex);
      if (startPoint) {
        const strLine = `${contourIndex}`;
        const width = context.measureText(strLine).width + 2 * margin;
        context.fillStyle = parameters.boxColor;
        drawRoundRect(
          context,
          startPoint.x - width / 2,
          -startPoint.y - bottomY + margin,
          width,
          -boxHeight / 2 - 2 * margin,
          boxHeight / 4
        );
        context.fillStyle = parameters.color;
        context.fillText(strLine, startPoint.x, -startPoint.y - bottomY);
      }
    }
    startPointIndex = contourInfo.endPoint + 1;
  }
}

function layerGlyphList(value) {
  return Array.isArray(value) ? value : Object.values(value || {});
}

function drawLayerNodesAndHandles(context, layerGlyphs, parameters) {
  for (const layerGlyph of layerGlyphs) {
    const path = layerGlyph.path;
    const state = getStateForLayerGlyph(layerGlyph);
    const hiddenInfo = state ? makeHiddenInfo(path, state) : null;

    for (const [prevIndex, nextIndex] of iterHandlePointIndices(path)) {
      if (
        hiddenInfo &&
        (hiddenInfo.isPointHidden(prevIndex) ||
          hiddenInfo.isPointHidden(nextIndex))
      ) {
        continue;
      }
      const pt1 = path.getPoint(prevIndex);
      const pt2 = path.getPoint(nextIndex);
      if (pt1 && pt2) {
        strokeLine(context, pt1.x, pt1.y, pt2.x, pt2.y);
      }
    }

    for (let pointIndex = 0; pointIndex < path.numPoints; pointIndex++) {
      if (hiddenInfo?.isPointHidden(pointIndex)) {
        continue;
      }
      const pt = path.getPoint(pointIndex);
      if (pt) {
        fillNode(
          context,
          pt,
          parameters.cornerSize,
          parameters.smoothSize,
          parameters.handleSize
        );
      }
    }
  }
}

function drawFilteredBackgroundNodesAndHandles(args, originalDraw) {
  const { context, parameters, model } = args;
  const backgroundLayers = layerGlyphList(model.backgroundLayerGlyphs);
  const editingLayers = layerGlyphList(model.editingLayerGlyphs);
  const hasHiddenState = [...backgroundLayers, ...editingLayers].some(
    (layerGlyph) => getStateForLayerGlyph(layerGlyph)
  );
  if (!hasHiddenState) {
    return originalDraw(args);
  }

  context.lineWidth = parameters.strokeWidth;
  context.strokeStyle = parameters.backgroundColor;
  context.fillStyle = parameters.backgroundColor;
  drawLayerNodesAndHandles(context, backgroundLayers, parameters);

  context.strokeStyle = parameters.editColor;
  context.fillStyle = parameters.editColor;
  drawLayerNodesAndHandles(context, editingLayers, parameters);
}

function drawFilteredLayerStrokes(context, layerGlyphs, parameters) {
  for (const layerGlyph of layerGlyphs) {
    const state = getStateForLayerGlyph(layerGlyph);
    context.strokeStyle = parameters.color;
    if (state) {
      const hiddenInfo = makeHiddenInfo(layerGlyph.path, state);
      const path2d = buildVisibleStrokePath2d(layerGlyph, hiddenInfo);
      if (path2d) {
        context.stroke(path2d);
      }
    } else {
      context.stroke(layerGlyph.flattenedPath2d);
    }

    // Anchors are not hideable.
    context.strokeStyle = parameters.colorAnchor;
    for (const anchor of layerGlyph.anchors) {
      strokeCircle(context, anchor.x, anchor.y, parameters.anchorRadius);
    }
  }
}

function drawFilteredBackgroundLayers(args, originalDraw) {
  const { context, parameters, model } = args;
  const layerGlyphs = layerGlyphList(model.backgroundLayerGlyphs);
  if (!layerGlyphs.some((layerGlyph) => getStateForLayerGlyph(layerGlyph))) {
    return originalDraw(args);
  }
  context.lineJoin = "round";
  context.lineWidth = parameters.strokeWidth;
  drawFilteredLayerStrokes(context, layerGlyphs, parameters);
}

function drawFilteredEditingLayers(args, originalDraw) {
  const { context, positionedGlyph, parameters, model } = args;
  const primaryEditingInstance = positionedGlyph.glyph;
  const layerGlyphs = layerGlyphList(model.editingLayerGlyphs).filter(
    (layerGlyph) => layerGlyph !== primaryEditingInstance
  );
  if (!layerGlyphs.some((layerGlyph) => getStateForLayerGlyph(layerGlyph))) {
    return originalDraw(args);
  }
  context.lineJoin = "round";
  context.lineWidth = parameters.strokeWidth;
  drawFilteredLayerStrokes(context, layerGlyphs, parameters);
}

function patchVisualizationLayers(editor) {
  const definitions = editor.visualizationLayers?.definitions;
  if (!Array.isArray(definitions)) {
    return;
  }
  const definitionsByIdentifier = new Map(
    definitions.map((definition) => [definition.identifier, definition])
  );

  const missingLayers = [];
  const patchLayer = (identifier, wrapper) => {
    const definition = definitionsByIdentifier.get(identifier);
    if (!definition || typeof definition.draw !== "function") {
      missingLayers.push(identifier);
      return;
    }
    const originalDraw = definition.draw;
    definition.draw = (args) => wrapper(args, originalDraw);
  };

  patchLayer("fontra.edit.path.fill", drawFilteredFill);
  patchLayer("fontra.edit.path.under.stroke", drawFilteredStroke);
  patchLayer("fontra.edit.path.stroke", drawFilteredStroke);
  patchLayer("fontra.nodes", drawFilteredNodes);
  patchLayer("fontra.handles", drawFilteredHandles);
  patchLayer("fontra.selected.nodes", drawFilteredSelectedNodes);
  patchLayer("fontra.startpoint.indicator", drawFilteredStartPoint);
  patchLayer("fontra.contour.index", drawFilteredContourIndex);
  patchLayer(
    "fontra.edit.background.layers.nodes-and-handles",
    drawFilteredBackgroundNodesAndHandles
  );
  patchLayer("fontra.edit.background.layers", drawFilteredBackgroundLayers);
  patchLayer("fontra.edit.editing.layers", drawFilteredEditingLayers);

  if (missingLayers.length) {
    console.warn(
      "Hide Items: some visualization layers were not found:",
      missingLayers.join(", ")
    );
  }

  editor.visualizationLayers.requestUpdate?.();
}

// ---------------------------------------------------------------------------
// Hit testing and selection
// ---------------------------------------------------------------------------

function patchHitTesting(editor) {
  const sceneModel = editor.sceneModel;
  if (!sceneModel) {
    return;
  }

  const originalPointSelectionAtPoint = sceneModel.pointSelectionAtPoint;
  if (typeof originalPointSelectionAtPoint === "function") {
    sceneModel.pointSelectionAtPoint = function (
      point,
      size,
      parsedCurrentSelection
    ) {
      const state = getStateForSceneModel(this);
      if (!state) {
        return originalPointSelectionAtPoint.call(
          this,
          point,
          size,
          parsedCurrentSelection
        );
      }
      const positionedGlyph = this.getSelectedPositionedGlyph();
      if (!positionedGlyph) {
        return new Set();
      }
      const path = positionedGlyph.glyph.path;
      const hiddenInfo = makeHiddenInfo(path, state);
      const glyphPoint = {
        x: point.x - positionedGlyph.x,
        y: point.y - positionedGlyph.y,
      };

      let pointIndex;
      if (parsedCurrentSelection) {
        const currentPointIndices = (parsedCurrentSelection.point || []).filter(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < path.numPoints &&
            !hiddenInfo.isPointHidden(index)
        );
        pointIndex = pointIndexNearPointFromIndices(
          path,
          glyphPoint,
          size,
          currentPointIndices
        );
      } else {
        const rect = centeredRect(glyphPoint.x, glyphPoint.y, size);
        for (let index = path.numPoints - 1; index >= 0; index--) {
          if (hiddenInfo.isPointHidden(index)) {
            continue;
          }
          const pt = path.getPoint(index);
          if (pt && pointInRect(pt.x, pt.y, rect)) {
            pointIndex = index;
            break;
          }
        }
      }
      return pointIndex !== undefined
        ? new Set([`point/${pointIndex}`])
        : new Set();
    };
  }

  const originalPathHitAtPoint = sceneModel.pathHitAtPoint;
  if (typeof originalPathHitAtPoint === "function") {
    sceneModel.pathHitAtPoint = function (point, size) {
      const state = getStateForSceneModel(this);
      if (!state) {
        return originalPathHitAtPoint.call(this, point, size);
      }
      const positionedGlyph = this.getSelectedPositionedGlyph();
      if (!positionedGlyph) {
        return {};
      }
      const path = positionedGlyph.glyph.path;
      const pathHitTester = positionedGlyph.glyph.pathHitTester;
      const hiddenInfo = makeHiddenInfo(path, state);
      const glyphPoint = {
        x: point.x - positionedGlyph.x,
        y: point.y - positionedGlyph.y,
      };

      if (
        !pathHitTester?.contours ||
        typeof pathHitTester._ensureContourIsLoaded !== "function"
      ) {
        const hit = originalPathHitAtPoint.call(this, point, size);
        if (!hit?.segment) {
          return hit;
        }
        if (hiddenInfo.isContourHidden(hit.contourIndex)) {
          return {};
        }
        const parentPointIndices = hit.segment.parentPointIndices || [];
        if (parentPointIndices.some((index) => hiddenInfo.isPointHidden(index))) {
          return {};
        }
        return hit;
      }

      return hitTestVisiblePath(
        pathHitTester,
        hiddenInfo,
        glyphPoint,
        size / 2
      );
    };
  }

  const originalSelectionAtRect = sceneModel.selectionAtRect;
  if (typeof originalSelectionAtRect === "function") {
    sceneModel.selectionAtRect = function (selRect, pointFilterFunc) {
      const selection = originalSelectionAtRect.call(
        this,
        selRect,
        pointFilterFunc
      );
      const state = getStateForSceneModel(this);
      if (!state) {
        return selection;
      }
      const positionedGlyph = this.getSelectedPositionedGlyph();
      if (!positionedGlyph) {
        return selection;
      }
      const hiddenInfo = makeHiddenInfo(positionedGlyph.glyph.path, state);
      return filterPointSelection(selection, (index) =>
        hiddenInfo.isPointHidden(index)
      );
    };
  }

  const originalSelectionAtPoint = sceneModel.selectionAtPoint;
  if (typeof originalSelectionAtPoint === "function") {
    sceneModel.selectionAtPoint = function (
      point,
      size,
      currentSelection,
      currentHoverSelection,
      preferTCenter
    ) {
      const state = getStateForSceneModel(this);
      if (!state) {
        return originalSelectionAtPoint.call(
          this,
          point,
          size,
          currentSelection,
          currentHoverSelection,
          preferTCenter
        );
      }
      const positionedGlyph = this.getSelectedPositionedGlyph();
      if (!positionedGlyph) {
        return originalSelectionAtPoint.call(
          this,
          point,
          size,
          currentSelection,
          currentHoverSelection,
          preferTCenter
        );
      }
      const hiddenInfo = makeHiddenInfo(positionedGlyph.glyph.path, state);
      const filter = (selection) =>
        filterPointSelection(selection, (index) =>
          hiddenInfo.isPointHidden(index)
        );
      const result = originalSelectionAtPoint.call(
        this,
        point,
        size,
        filter(currentSelection),
        filter(currentHoverSelection),
        preferTCenter
      );
      if (result?.selection) {
        return { ...result, selection: filter(result.selection) };
      }
      return result;
    };
  }
}

// ---------------------------------------------------------------------------
// Power Ruler
//
// The Power Ruler measures against `glyphController.flattenedPathHitTester`.
// Build a filtered view of that hit tester so hidden contours and segments are
// absent from both nearest-point searches and ray intersections. Component
// contours follow the glyph's own contours in the flattened path and are never
// hideable, so they are passed through unchanged.
// ---------------------------------------------------------------------------

const FILTERED_HIT_TESTER = Symbol("fontra.hideItems.filteredHitTester");

function getStateForGlyphController(glyphController) {
  const glyphName = glyphController?.name;
  const path = glyphController?.instance?.path;
  if (glyphName === undefined || glyphName === null || !path) {
    return null;
  }
  return getStateForGlyph(glyphName, path);
}

function makeFilteredFlattenedPathHitTester(glyphController, state) {
  const hitTester = glyphController?.flattenedPathHitTester;
  const ownPath = glyphController?.instance?.path;
  if (
    !hitTester ||
    !Array.isArray(hitTester.contours) ||
    !ownPath ||
    typeof hitTester._ensureAllContoursAreLoaded !== "function" ||
    typeof hitTester.findNearest !== "function" ||
    typeof hitTester.rayIntersections !== "function"
  ) {
    return null;
  }

  // Loading all contours up front makes the filtered copies self-contained:
  // the original tester will not try to reload segments while we swap its
  // contour list.
  hitTester._ensureAllContoursAreLoaded();

  const hiddenInfo = makeHiddenInfo(ownPath, state);
  const filteredContours = [];
  for (
    let contourIndex = 0;
    contourIndex < hitTester.contours.length;
    contourIndex++
  ) {
    const contour = hitTester.contours[contourIndex];

    // Component contours follow the glyph's own contours and are not hideable.
    if (contourIndex >= ownPath.numContours) {
      filteredContours.push(contour);
      continue;
    }

    if (hiddenInfo.isContourHidden(contourIndex)) {
      continue;
    }

    const [startPoint, endPoint] = contourRange(ownPath, contourIndex);
    let hasHiddenPoint = false;
    for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
      if (hiddenInfo.isPointHidden(pointIndex)) {
        hasHiddenPoint = true;
        break;
      }
    }
    if (!hasHiddenPoint) {
      filteredContours.push(contour);
      continue;
    }

    const visibleSegments = [];
    for (const segment of contour.segments || []) {
      const parentPointIndices = segment.parentPointIndices || [];
      let visible = true;
      for (const pointIndex of parentPointIndices) {
        if (hiddenInfo.isPointHidden(pointIndex)) {
          visible = false;
          break;
        }
      }
      if (visible) {
        visibleSegments.push(segment);
      }
    }

    // A contour with a gap is open, so its intersections must not contribute
    // inside/outside winding to the ruler's measurements.
    filteredContours.push({
      ...contour,
      isClosed: false,
      segments: visibleSegments,
    });
  }

  const withFilteredContours = (callback) => {
    const originalContours = hitTester.contours;
    hitTester.contours = filteredContours;
    try {
      return callback();
    } finally {
      hitTester.contours = originalContours;
    }
  };

  return {
    [FILTERED_HIT_TESTER]: true,
    findNearest(point, extraLines) {
      return withFilteredContours(() =>
        hitTester.findNearest(point, extraLines)
      );
    },
    rayIntersections(point, direction, extraLines) {
      return withFilteredContours(() =>
        hitTester.rayIntersections(point, direction, extraLines)
      );
    },
    lineIntersections(p1, p2, direction, extraLines) {
      return withFilteredContours(() =>
        hitTester.lineIntersections(p1, p2, direction, extraLines)
      );
    },
    hitTest(point, margin) {
      return withFilteredContours(() => hitTester.hitTest(point, margin));
    },
  };
}

function withFlattenedPathHitTester(glyphController, hitTester, callback) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    glyphController,
    "flattenedPathHitTester"
  );
  Object.defineProperty(glyphController, "flattenedPathHitTester", {
    configurable: true,
    enumerable: false,
    value: hitTester,
  });
  try {
    return callback();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(
        glyphController,
        "flattenedPathHitTester",
        originalDescriptor
      );
    } else {
      delete glyphController.flattenedPathHitTester;
    }
  }
}

function patchPowerRuler(editor) {
  const tool = editor?.tools?.["power-ruler-tool"];
  if (!tool) {
    console.warn(
      "Hide Items: the Power Ruler tool was not found; ruler filtering is inactive."
    );
    return false;
  }

  for (const methodName of ["recalcRulerFromPoint", "recalcRulerFromLine"]) {
    const originalMethod = tool[methodName];
    if (typeof originalMethod !== "function") {
      continue;
    }
    tool[methodName] = function (glyphController, ...args) {
      // recalcRulerFromPoint calls recalcRulerFromLine with the same
      // controller. The inner call sees the already-filtered tester and must
      // not filter it a second time.
      if (
        !glyphController ||
        glyphController.flattenedPathHitTester?.[FILTERED_HIT_TESTER]
      ) {
        return originalMethod.call(this, glyphController, ...args);
      }

      let filteredHitTester = null;
      try {
        const state = getStateForGlyphController(glyphController);
        if (state) {
          filteredHitTester = makeFilteredFlattenedPathHitTester(
            glyphController,
            state
          );
        }
      } catch (error) {
        console.warn(
          "Hide Items: could not filter the Power Ruler.",
          error
        );
        return originalMethod.call(this, glyphController, ...args);
      }

      const ownDescriptor = Object.getOwnPropertyDescriptor(
        glyphController,
        "flattenedPathHitTester"
      );
      if (
        !filteredHitTester ||
        !Object.isExtensible(glyphController) ||
        (ownDescriptor && !ownDescriptor.configurable)
      ) {
        return originalMethod.call(this, glyphController, ...args);
      }
      return withFlattenedPathHitTester(
        glyphController,
        filteredHitTester,
        () => originalMethod.call(this, glyphController, ...args)
      );
    };
  }

  console.info(
    "Hide Items: loaded; the Power Ruler ignores hidden geometry."
  );
  return true;
}

function findPropertyDescriptor(object, propertyName) {
  let prototype = Object.getPrototypeOf(object);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
    if (descriptor) {
      return descriptor;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function filterSelectionForEditor(editor, selection) {
  if (!selection) {
    return selection;
  }
  const positionedGlyph = editor.sceneModel?.getSelectedPositionedGlyph();
  if (!positionedGlyph) {
    return selection;
  }
  const state = getStateForPositionedGlyph(positionedGlyph);
  if (!state) {
    return selection;
  }
  const hiddenInfo = makeHiddenInfo(positionedGlyph.glyph.path, state);
  return filterPointSelection(selection, (index) =>
    hiddenInfo.isPointHidden(index)
  );
}

function patchSelection(editor) {
  const sceneModel = editor.sceneModel;
  if (!sceneModel) {
    return;
  }
  for (const propertyName of ["selection", "hoverSelection"]) {
    const descriptor = findPropertyDescriptor(sceneModel, propertyName);
    if (!descriptor?.get || !descriptor?.set) {
      continue;
    }
    Object.defineProperty(sceneModel, propertyName, {
      configurable: true,
      enumerable: false,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        descriptor.set.call(this, filterSelectionForEditor(editor, value));
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Select all
// ---------------------------------------------------------------------------

function doSelectAllVisible(editor, state) {
  const positionedGlyph = editor.sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph || !editor.sceneSettings.selectedGlyph?.isEditing) {
    return;
  }

  const glyph = positionedGlyph.glyph;
  const instance = glyph.instance;
  const path = glyph.path;
  const {
    point: pointIndices,
    component: componentIndices,
    anchor: anchorIndices,
    guideline: guidelineIndices,
  } = selectionParts(editor.sceneController.selection);

  const visibleOnCurvePointIndices = [];
  for (let pointIndex = 0; pointIndex < path.numPoints; pointIndex++) {
    if (
      isOnCurvePoint(path.pointTypes[pointIndex]) &&
      !isPointHidden(state, path, pointIndex)
    ) {
      visibleOnCurvePointIndices.push(pointIndex);
    }
  }

  const pointSelectionSet = new Set(pointIndices);
  const allOnCurvePointsSelected = visibleOnCurvePointIndices.every((pointIndex) =>
    pointSelectionSet.has(pointIndex)
  );
  const allComponentsSelected =
    componentIndices.length === instance.components.length;
  const hasObjects =
    instance.components.length > 0 || instance.path.pointTypes.length > 0;
  const hasAnchors = instance.anchors.length > 0;
  const hasGuidelines = instance.guidelines.length > 0;

  let selectObjects = false;
  let selectAnchors = false;
  let selectGuidelines = false;

  if (
    (!allOnCurvePointsSelected || !allComponentsSelected) &&
    !anchorIndices.length &&
    !guidelineIndices.length
  ) {
    if (hasObjects) {
      selectObjects = true;
    } else if (hasAnchors) {
      selectAnchors = true;
    } else if (hasGuidelines) {
      selectGuidelines = true;
    }
  }

  if (
    allOnCurvePointsSelected &&
    allComponentsSelected &&
    !anchorIndices.length &&
    !guidelineIndices.length
  ) {
    if (hasAnchors) {
      selectObjects = true;
      selectAnchors = true;
    } else if (hasGuidelines) {
      selectGuidelines = true;
    }
  }

  if (
    (pointIndices.length || componentIndices.length) &&
    anchorIndices.length &&
    !guidelineIndices.length
  ) {
    if (hasAnchors) {
      selectAnchors = true;
    }
  }

  if (
    !pointIndices.length &&
    !componentIndices.length &&
    anchorIndices.length &&
    !guidelineIndices.length
  ) {
    if (hasGuidelines) {
      selectGuidelines = true;
    }
  }

  const newSelection = new Set();

  if (selectObjects) {
    for (const pointIndex of visibleOnCurvePointIndices) {
      newSelection.add(`point/${pointIndex}`);
    }
    for (let componentIndex = 0; componentIndex < glyph.components.length; componentIndex++) {
      newSelection.add(`component/${componentIndex}`);
    }
    if (
      !editor.sceneSettings.backgroundImagesAreLocked &&
      editor.visualizationLayersSettings.model["fontra.background-image"]
    ) {
      if (glyph.backgroundImage) {
        newSelection.add("backgroundImage/0");
      }
    }
  }

  if (selectAnchors) {
    for (let anchorIndex = 0; anchorIndex < instance.anchors.length; anchorIndex++) {
      newSelection.add(`anchor/${anchorIndex}`);
    }
  }

  if (
    selectGuidelines &&
    editor.visualizationLayersSettings.model["fontra.guidelines"]
  ) {
    for (
      let guidelineIndex = 0;
      guidelineIndex < instance.guidelines.length;
      guidelineIndex++
    ) {
      if (!instance.guidelines[guidelineIndex].locked) {
        newSelection.add(`guideline/${guidelineIndex}`);
      }
    }
  }

  editor.sceneController.selection = newSelection;
}

function patchSelectAll(editor) {
  const originalDoSelectAllNone = editor.doSelectAllNone;
  if (typeof originalDoSelectAllNone !== "function") {
    return;
  }
  const boundOriginal = originalDoSelectAllNone.bind(editor);
  editor.doSelectAllNone = (selectNone) => {
    if (selectNone) {
      return boundOriginal(selectNone);
    }
    const state = getStateForSceneModel(editor.sceneModel);
    if (!state) {
      return boundOriginal(selectNone);
    }
    return doSelectAllVisible(editor, state);
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function hideSelection(editor) {
  const positionedGlyph = editor.sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph || !editor.sceneSettings.selectedGlyph?.isEditing) {
    return false;
  }
  const path = positionedGlyph.glyph.path;
  const glyphName = positionedGlyph.glyphName;
  const selection = editor.sceneController.selection || new Set();

  const selectedPointIndices = [];
  for (const item of selection) {
    const pointIndex = pointSelectionIndex(item);
    if (pointIndex !== undefined && pointIndex < path.numPoints) {
      selectedPointIndices.push(pointIndex);
    }
  }
  if (!selectedPointIndices.length) {
    return false;
  }

  const selectedPointSet = new Set(selectedPointIndices);
  const state = getStateForGlyph(glyphName, path) || emptyState();

  // A contour counts as fully selected when all of its on-curve points are
  // selected. This makes H after Ctrl+A hide whole contours cleanly, without
  // requiring the off-curve handles to be selected too.
  const contoursToHide = new Set();
  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    const [startPoint, endPoint] = contourRange(path, contourIndex);
    if (endPoint < startPoint) {
      continue;
    }
    const onCurvePointIndices = [];
    for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
      if (isOnCurvePoint(path.pointTypes[pointIndex])) {
        onCurvePointIndices.push(pointIndex);
      }
    }
    let fullySelected;
    if (onCurvePointIndices.length) {
      fullySelected = onCurvePointIndices.every((pointIndex) =>
        selectedPointSet.has(pointIndex)
      );
    } else {
      // Quad blob: there are no on-curve points, so require every point.
      fullySelected = true;
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        if (!selectedPointSet.has(pointIndex)) {
          fullySelected = false;
          break;
        }
      }
    }
    if (fullySelected) {
      contoursToHide.add(contourIndex);
    }
  }

  for (const contourIndex of contoursToHide) {
    state.hiddenContours.add(contourIndex);
    const [startPoint, endPoint] = contourRange(path, contourIndex);
    for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
      state.hiddenPoints.delete(pointIndex);
    }
  }

  for (const pointIndex of selectedPointIndices) {
    const contourIndex = getContourIndexForPoint(path, pointIndex);
    if (contourIndex === undefined || !contoursToHide.has(contourIndex)) {
      state.hiddenPoints.add(pointIndex);
    }
  }

  const normalized = normalizeState(state, path);
  setStateForGlyph(glyphName, path, normalized);

  const hiddenInfo = normalized ? makeHiddenInfo(path, normalized) : null;
  const newSelection = filterPointSelection(selection, hiddenInfo
    ? (index) => hiddenInfo.isPointHidden(index)
    : null);
  editor.sceneController.selection = newSelection;
  editor.sceneController.hoverSelection = new Set();
  requestUpdate(editor);
  return true;
}

function hideUnselected(editor) {
  const positionedGlyph = editor.sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph || !editor.sceneSettings.selectedGlyph?.isEditing) {
    return false;
  }
  const path = positionedGlyph.glyph.path;
  const glyphName = positionedGlyph.glyphName;
  if (path.numPoints === 0) {
    return false;
  }

  const selection = editor.sceneController.selection || new Set();
  const selectedPointSet = new Set();
  for (const item of selection) {
    const pointIndex = pointSelectionIndex(item);
    if (pointIndex !== undefined && pointIndex < path.numPoints) {
      selectedPointSet.add(pointIndex);
    }
  }

  const state = getStateForGlyph(glyphName, path) || emptyState();
  const hiddenInfo = makeHiddenInfo(path, state);

  let anyVisiblePoint = false;
  for (let pointIndex = 0; pointIndex < path.numPoints; pointIndex++) {
    if (!hiddenInfo.isPointHidden(pointIndex)) {
      anyVisiblePoint = true;
      break;
    }
  }
  if (!anyVisiblePoint) {
    return false;
  }

  for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
    const [startPoint, endPoint] = contourRange(path, contourIndex);
    if (endPoint < startPoint) {
      continue;
    }
    let anySelectedPoint = false;
    for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
      if (selectedPointSet.has(pointIndex)) {
        anySelectedPoint = true;
        break;
      }
    }
    if (!anySelectedPoint) {
      state.hiddenContours.add(contourIndex);
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        state.hiddenPoints.delete(pointIndex);
      }
    } else {
      for (let pointIndex = startPoint; pointIndex <= endPoint; pointIndex++) {
        if (
          !selectedPointSet.has(pointIndex) &&
          !hiddenInfo.isPointHidden(pointIndex)
        ) {
          state.hiddenPoints.add(pointIndex);
        }
      }
    }
  }

  const normalized = normalizeState(state, path);
  setStateForGlyph(glyphName, path, normalized);

  const newHiddenInfo = normalized ? makeHiddenInfo(path, normalized) : null;
  const newSelection = filterPointSelection(selection, newHiddenInfo
    ? (index) => newHiddenInfo.isPointHidden(index)
    : null);
  editor.sceneController.selection = newSelection;
  editor.sceneController.hoverSelection = new Set();
  requestUpdate(editor);
  return true;
}

function revealAll(editor) {
  const positionedGlyph = editor.sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph || !editor.sceneSettings.selectedGlyph?.isEditing) {
    return false;
  }
  const glyphName = positionedGlyph.glyphName;
  const project = getProjectStore(false);
  if (!project) {
    return false;
  }
  const key = glyphStoreKey(glyphName);
  if (!Object.prototype.hasOwnProperty.call(project, key)) {
    return false;
  }
  delete project[key];
  saveStore();
  editor.sceneController.hoverSelection = new Set();
  requestUpdate(editor);
  return true;
}

function canRevealAll(editor) {
  const positionedGlyph = editor.sceneModel.getSelectedPositionedGlyph();
  if (!positionedGlyph || !editor.sceneSettings.selectedGlyph?.isEditing) {
    return false;
  }
  return hasStoredState(positionedGlyph.glyphName);
}

function refreshPowerRuler(editor) {
  const tool = editor?.tools?.["power-ruler-tool"];
  if (!tool || typeof tool.recalc !== "function") {
    return;
  }
  try {
    const result = tool.recalc();
    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        console.warn("Hide Items: could not refresh the Power Ruler.", error);
      });
    }
  } catch (error) {
    console.warn("Hide Items: could not refresh the Power Ruler.", error);
  }
}

function requestUpdate(editor) {
  editor.visualizationLayers?.requestUpdate?.();
  editor.canvasController?.requestUpdate?.();
  editor.sceneController?.canvasController?.requestUpdate?.();
  // Existing rulers must be recalculated against the new hidden state.
  refreshPowerRuler(editor);
}

// ---------------------------------------------------------------------------
// Menu and shortcuts
// ---------------------------------------------------------------------------

function installMenu(editor) {
  const menuItems = editor.basicContextMenuItems;
  if (!Array.isArray(menuItems)) {
    return;
  }
  // The only visible UI addition is "Reveal All". Hiding is done with the
  // keyboard shortcuts; this menu item is the fallback for Alt+H, which some
  // browsers or window managers may intercept.
  menuItems.push(
    { title: "-" },
    {
      title: `Reveal All (${ALT_LABEL}H)`,
      enabled: () => canRevealAll(editor),
      callback: () => revealAll(editor),
    }
  );
}

function isTypeableElement(element) {
  if (!element) {
    return false;
  }
  const tagName = element.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return !!element.isContentEditable;
}

function installShortcuts(editor) {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }
      if (!editor.sceneSettings.selectedGlyph?.isEditing) {
        return;
      }
      if (
        isTypeableElement(event.target) ||
        isTypeableElement(document.activeElement) ||
        window.getSelection()?.toString()
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        return;
      }
      const isHKey =
        event.code === "KeyH" || event.key?.toLowerCase() === "h";
      if (!isHKey) {
        return;
      }

      let action;
      if (event.altKey && !event.shiftKey) {
        action = revealAll;
      } else if (event.shiftKey && !event.altKey) {
        action = hideUnselected;
      } else if (!event.shiftKey && !event.altKey) {
        action = hideSelection;
      } else {
        return;
      }

      // Prevent the browser/OS from handling Alt+H (menu access) and keep
      // Fontra's own key handling from seeing the key.
      event.preventDefault();
      event.stopImmediatePropagation();
      action(editor);
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export function start(editor, _pluginPath) {
  if (window.__fontraHideItemsPlugin) {
    return;
  }
  window.__fontraHideItemsPlugin = true;

  if (
    !editor?.sceneModel ||
    !editor?.sceneController ||
    !editor?.visualizationLayers
  ) {
    console.warn("Hide Items: this editor does not expose the required APIs.");
    return;
  }

  pluginState = {
    editor,
    store: loadStore(),
  };

  patchVisualizationLayers(editor);
  patchHitTesting(editor);
  try {
    patchPowerRuler(editor);
  } catch (error) {
    console.warn("Hide Items: could not patch the Power Ruler.", error);
  }
  patchSelection(editor);
  patchSelectAll(editor);
  installMenu(editor);
  installShortcuts(editor);
}
