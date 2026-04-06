const ALG_C_DEFAULT_OPTIONS = {
  clusterEpsMeters: 10000,
  clusterMinSamples: 10,
  alpha: 0.1,
  boundaryThresholdDegrees: 0.03,
  coastMinDistanceMeters: 4000,
  minBoundaryPoints: 6,
  minSemiMajorMeters: 450,
  minSemiMinorMeters: 250,
  majorPaddingMeters: 350,
  minorPaddingMeters: 250,
  minMinorRatio: 0.32,
};

const ALPHA_SHAPE_MODULE_URL = 'https://esm.sh/alpha-shape@1.0.0?target=es2022';
const OPENCV_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js';
const COASTLINE_PATH = '/israel_mediterranean_coast_0.5km.csv';

let orefPointsPromise = null;
let coastlinePromise = null;
let alphaShapePromise = null;
let cvPromise = null;
let debugLayer = null;

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function normalizeAngle(angle) {
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return angle;
}

function normalizeAxes(candidate) {
  let semiMajor = candidate.semiMajor;
  let semiMinor = candidate.semiMinor;
  let angle = candidate.angle;

  if (semiMajor < semiMinor) {
    const swap = semiMajor;
    semiMajor = semiMinor;
    semiMinor = swap;
    angle += Math.PI / 2;
  }

  if (semiMinor <= 1) semiMinor = 1;
  if (semiMajor <= semiMinor) semiMajor = semiMinor + 1;

  return {
    centerX: candidate.centerX,
    centerY: candidate.centerY,
    semiMajor,
    semiMinor,
    angle: normalizeAngle(angle),
  };
}

function buildProjection(points) {
  let latSum = 0;
  let lngSum = 0;

  for (const point of points) {
    latSum += point.lat;
    lngSum += point.lng;
  }

  const lat0 = latSum / points.length;
  const lng0 = lngSum / points.length;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(toRad(lat0));

  return {
    lat0,
    lng0,
    metersPerDegLat,
    metersPerDegLng,
    project(latlng) {
      return {
        x: (latlng.lng - lng0) * metersPerDegLng,
        y: (latlng.lat - lat0) * metersPerDegLat,
      };
    },
    unproject(projected) {
      return {
        lat: lat0 + projected.y / metersPerDegLat,
        lng: lng0 + projected.x / metersPerDegLng,
      };
    },
  };
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx) + (dy * dy);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cross(o, a, b) {
  return ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-12) return Math.sqrt(squaredDistance(point, start));

  const t = clamp((((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared, 0, 1);
  const projected = {
    x: start.x + (t * dx),
    y: start.y + (t * dy),
  };
  return Math.sqrt(squaredDistance(point, projected));
}

function buildConvexHull(points) {
  if (points.length <= 1) return points.slice();

  const sorted = points.slice().sort((a, b) => (
    Math.abs(a.x - b.x) > 1e-9 ? a.x - b.x : a.y - b.y
  ));

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function detectMainCluster(projectedPoints, options) {
  if (projectedPoints.length < options.clusterMinSamples) return projectedPoints.slice();

  const epsSquared = options.clusterEpsMeters * options.clusterEpsMeters;
  const neighbors = projectedPoints.map(() => []);

  for (let i = 0; i < projectedPoints.length; i += 1) {
    for (let j = i; j < projectedPoints.length; j += 1) {
      if (squaredDistance(projectedPoints[i], projectedPoints[j]) <= epsSquared) {
        neighbors[i].push(j);
        if (i !== j) neighbors[j].push(i);
      }
    }
  }

  const isCore = neighbors.map((list) => list.length >= options.clusterMinSamples);
  if (!isCore.some(Boolean)) return projectedPoints.slice();

  const visited = new Array(projectedPoints.length).fill(false);
  let bestCluster = [];

  for (let start = 0; start < projectedPoints.length; start += 1) {
    if (!isCore[start] || visited[start]) continue;

    const queue = [start];
    const cluster = new Set();
    visited[start] = true;

    while (queue.length) {
      const current = queue.shift();
      cluster.add(current);

      for (const neighborIndex of neighbors[current]) {
        cluster.add(neighborIndex);
        if (isCore[neighborIndex] && !visited[neighborIndex]) {
          visited[neighborIndex] = true;
          queue.push(neighborIndex);
        }
      }
    }

    if (cluster.size > bestCluster.length) {
      bestCluster = Array.from(cluster);
    }
  }

  if (!bestCluster.length) return projectedPoints.slice();
  return bestCluster.map((index) => projectedPoints[index]);
}

async function ensureOrefPoints() {
  if (!orefPointsPromise) {
    orefPointsPromise = fetch('/oref_points.json')
      .then((resp) => {
        if (!resp.ok) throw new Error('Failed to load /oref_points.json: HTTP ' + resp.status);
        return resp.json();
      });
  }
  return orefPointsPromise;
}

async function ensureCoastline() {
  if (!coastlinePromise) {
    coastlinePromise = (async function() {
      try {
        const resp = await fetch(COASTLINE_PATH);
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        const text = (await resp.text()).trim();
        const lines = text.split(/\r?\n/).slice(1);
        const points = lines
          .map((line) => line.split(','))
          .map(([lat, lng]) => ({ lat: Number(lat), lng: Number(lng) }))
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
        if (points.length) return points;
      } catch (error) {
        console.warn('calcEllipseAlgC: coastline fetch failed for', COASTLINE_PATH, error);
      }

      console.warn('calcEllipseAlgC: coastline data unavailable; skipping coastline filter');
      return [];
    })();
  }
  return coastlinePromise;
}

async function ensureAlphaShape() {
  if (!alphaShapePromise) {
    alphaShapePromise = import(ALPHA_SHAPE_MODULE_URL).then((mod) => mod.default || mod);
  }
  return alphaShapePromise;
}

function resolveCvModuleShape(cvModule) {
  if (cvModule && typeof cvModule.fitEllipse === 'function' && typeof cvModule.Mat === 'function') {
    return Promise.resolve(cvModule);
  }
  if (cvModule instanceof Promise) {
    return cvModule.then((resolved) => resolveCvModuleShape(resolved));
  }
  if (cvModule && typeof cvModule.then === 'function') {
    return new Promise((resolve, reject) => {
      cvModule.then(
        (resolved) => resolve(resolveCvModuleShape(resolved)),
        reject,
      );
    });
  }
  if (cvModule && typeof cvModule === 'object') {
    return new Promise((resolve) => {
      const previous = cvModule.onRuntimeInitialized;
      cvModule.onRuntimeInitialized = () => {
        if (typeof previous === 'function') previous();
        resolve(cvModule);
      };
    });
  }
  return Promise.reject(new Error('Unsupported OpenCV module shape'));
}

function loadScriptOnce(url, markerAttr) {
  const selector = `script[${markerAttr}="true"]`;
  let script = document.querySelector(selector);

  if (!script) {
    script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute(markerAttr, 'true');
    document.head.appendChild(script);
  }

  return new Promise((resolve, reject) => {
    if (script.dataset.loaded === 'true') {
      resolve();
      return;
    }
    if (script.dataset.failed === 'true') {
      reject(new Error('Failed to load script: ' + url));
      return;
    }

    const cleanup = () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      script.dataset.loaded = 'true';
      cleanup();
      resolve();
    };
    const handleError = () => {
      script.dataset.failed = 'true';
      cleanup();
      reject(new Error('Failed to load script: ' + url));
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
  });
}

async function ensureCv() {
  if (!cvPromise) {
    cvPromise = (async function() {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('OpenCV browser loader requires window and document');
      }

      if (!window.cv) {
        await loadScriptOnce(OPENCV_SCRIPT_URL, 'data-opencv-js-loader');
      }

      return resolveCvModuleShape(window.cv);
    })().catch((error) => {
      cvPromise = null;
      throw error;
    });
  }
  return cvPromise;
}

function buildAlphaShapeBoundaryPoints(projectedPoints, edges, options) {
  if (projectedPoints.length <= options.minBoundaryPoints) return projectedPoints.slice();
  if (!edges.length) return buildConvexHull(projectedPoints);

  const alphaInputPoints = projectedPoints.map((point) => [point.source.lng, point.source.lat]);
  const boundary = [];

  for (const point of projectedPoints) {
    const rawPoint = { x: point.source.lng, y: point.source.lat };
    let minDistance = Infinity;

    for (const [startIndex, endIndex] of edges) {
      const start = alphaInputPoints[startIndex];
      const end = alphaInputPoints[endIndex];
      if (!start || !end) continue;

      const distance = pointToSegmentDistance(
        rawPoint,
        { x: start[0], y: start[1] },
        { x: end[0], y: end[1] },
      );
      if (distance < minDistance) minDistance = distance;
    }

    if (minDistance < options.boundaryThresholdDegrees) {
      boundary.push(point);
    }
  }

  return boundary.length ? boundary : buildConvexHull(projectedPoints);
}

function filterPointsAwayFromCoast(projectedPoints, coastlinePoints, projection, options) {
  if (!coastlinePoints.length) {
    return {
      filtered: projectedPoints.slice(),
      minDistances: projectedPoints.map(() => null),
    };
  }

  const coastlineProjected = coastlinePoints.map((point) => projection.project(point));
  const filtered = [];
  const minDistances = [];

  for (const point of projectedPoints) {
    let minDistanceSquared = Infinity;
    for (const coastPoint of coastlineProjected) {
      const distanceSquared = squaredDistance(point, coastPoint);
      if (distanceSquared < minDistanceSquared) minDistanceSquared = distanceSquared;
    }
    const minDistance = Math.sqrt(minDistanceSquared);
    minDistances.push(minDistance);
    if (minDistance > options.coastMinDistanceMeters) filtered.push(point);
  }

  return { filtered, minDistances };
}

function fitProjectedEllipseFromBoundaryApprox(projectedPoints, options) {
  let centerX = 0;
  let centerY = 0;
  for (const point of projectedPoints) {
    centerX += point.x;
    centerY += point.y;
  }
  centerX /= projectedPoints.length;
  centerY /= projectedPoints.length;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (const point of projectedPoints) {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    covXX += dx * dx;
    covXY += dx * dy;
    covYY += dy * dy;
  }

  const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const point of projectedPoints) {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const offsetU = (minU + maxU) / 2;
  const offsetV = (minV + maxV) / 2;
  let semiMajor = Math.max((maxU - minU) / 2, options.minSemiMajorMeters);
  let semiMinor = Math.max((maxV - minV) / 2, options.minSemiMinorMeters);
  semiMajor += options.majorPaddingMeters;
  semiMinor = Math.max(semiMinor + options.minorPaddingMeters, semiMajor * options.minMinorRatio);

  return normalizeAxes({
    centerX: centerX + (offsetU * cos) - (offsetV * sin),
    centerY: centerY + (offsetU * sin) + (offsetV * cos),
    semiMajor,
    semiMinor,
    angle,
  });
}

async function fitOpenCvEllipseFromBoundary(projectedPoints, options) {
  if (projectedPoints.length < 5 || projectedPoints.some((point) => !point.source)) {
    const approx = fitProjectedEllipseFromBoundaryApprox(projectedPoints, options);
    return {
      fitSource: 'approx',
      coordinateSpace: 'projected',
      centerX: approx.centerX,
      centerY: approx.centerY,
      semiMajor: approx.semiMajor,
      semiMinor: approx.semiMinor,
      angle: approx.angle,
    };
  }

  try {
    const cv = await ensureCv();
    const rawPoints = projectedPoints.map((point) => [point.source.lng, point.source.lat]);
    const data = new Float32Array(rawPoints.length * 2);
    for (let i = 0; i < rawPoints.length; i += 1) {
      data[i * 2] = rawPoints[i][0];
      data[(i * 2) + 1] = rawPoints[i][1];
    }

    const mat = cv.matFromArray(rawPoints.length, 1, cv.CV_32FC2, data);
    const ellipse = cv.fitEllipse(mat);
    mat.delete();

    return {
      fitSource: 'opencv',
      coordinateSpace: 'raw-degrees',
      centerLng: ellipse.center.x,
      centerLat: ellipse.center.y,
      widthDegrees: ellipse.size.width,
      heightDegrees: ellipse.size.height,
      angleDegrees: ellipse.angle,
      angle: degToRad(ellipse.angle),
    };
  } catch (error) {
    console.warn('calcEllipseAlgC: OpenCV fit failed; using approximation fallback', error);
    const approx = fitProjectedEllipseFromBoundaryApprox(projectedPoints, options);
    return {
      fitSource: 'approx-fallback',
      coordinateSpace: 'projected',
      centerX: approx.centerX,
      centerY: approx.centerY,
      semiMajor: approx.semiMajor,
      semiMinor: approx.semiMinor,
      angle: approx.angle,
    };
  }
}

function buildEllipseCandidateLatLngs(candidate, projection, sampleCount = 180) {
  const points = [];
  const cos = Math.cos(candidate.angle);
  const sin = Math.sin(candidate.angle);

  for (let index = 0; index < sampleCount; index += 1) {
    const theta = (Math.PI * 2 * index) / sampleCount;
    const u = Math.cos(theta) * candidate.semiMajor;
    const v = Math.sin(theta) * candidate.semiMinor;
    const x = candidate.centerX + u * cos - v * sin;
    const y = candidate.centerY + u * sin + v * cos;
    points.push(projection.unproject({ x, y }));
  }

  return points;
}

function buildRawDegreeEllipseLatLngs(candidate, sampleCount = 180) {
  const points = [];
  const angleRad = candidate.angleDegrees * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const semiX = candidate.widthDegrees / 2;
  const semiY = candidate.heightDegrees / 2;

  for (let index = 0; index < sampleCount; index += 1) {
    const theta = (Math.PI * 2 * index) / sampleCount;
    const u = Math.cos(theta) * semiX;
    const v = Math.sin(theta) * semiY;
    const lng = candidate.centerLng + u * cos - v * sin;
    const lat = candidate.centerLat + u * sin + v * cos;
    points.push({ lat, lng });
  }

  return points;
}

function measureRawDegreeEllipseAxesMeters(candidate) {
  const center = { lat: candidate.centerLat, lng: candidate.centerLng };
  const projection = buildProjection([center]);
  const angleRad = candidate.angleDegrees * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const semiX = candidate.widthDegrees / 2;
  const semiY = candidate.heightDegrees / 2;
  const majorEnd = projection.project({
    lng: candidate.centerLng + semiX * cos,
    lat: candidate.centerLat + semiX * sin,
  });
  const minorEnd = projection.project({
    lng: candidate.centerLng - semiY * sin,
    lat: candidate.centerLat + semiY * cos,
  });
  const centerProjected = projection.project(center);

  const widthSemiMeters = Math.hypot(majorEnd.x - centerProjected.x, majorEnd.y - centerProjected.y);
  const heightSemiMeters = Math.hypot(minorEnd.x - centerProjected.x, minorEnd.y - centerProjected.y);

  if (widthSemiMeters >= heightSemiMeters) {
    return {
      semiMajorMeters: widthSemiMeters,
      semiMinorMeters: heightSemiMeters,
      angleDeg: (candidate.angleDegrees + 360) % 360,
    };
  }

  return {
    semiMajorMeters: heightSemiMeters,
    semiMinorMeters: widthSemiMeters,
    angleDeg: (candidate.angleDegrees + 90 + 360) % 360,
  };
}

async function fitAlgC(alertedPoints, options) {
  const projection = buildProjection(alertedPoints);
  const projectedPoints = alertedPoints.map((point) => ({
    ...projection.project(point),
    source: point,
  }));

  const clusteredPoints = detectMainCluster(projectedPoints, options);
  if (clusteredPoints.length < options.minBoundaryPoints) {
    return {
      projection,
      clusteredPoints,
      boundaryPoints: clusteredPoints,
      filteredBoundaryPoints: clusteredPoints,
      candidate: await fitOpenCvEllipseFromBoundary(clusteredPoints, options),
      metrics: {
        clusteredCount: clusteredPoints.length,
        boundaryCount: clusteredPoints.length,
        filteredBoundaryCount: clusteredPoints.length,
        coastRejectedCount: 0,
        minCoastDistanceMeters: null,
      },
    };
  }

  let boundaryPoints = buildConvexHull(clusteredPoints);
  try {
    const alphaShape = await ensureAlphaShape();
    const alphaInputPoints = clusteredPoints.map((point) => [point.source.lng, point.source.lat]);
    const edges = alphaShape(options.alpha, alphaInputPoints)
      .filter((edge) => Array.isArray(edge) && edge.length === 2);
    boundaryPoints = buildAlphaShapeBoundaryPoints(clusteredPoints, edges, options);
  } catch (error) {
    console.warn('calcEllipseAlgC: alpha-shape load failed; using convex hull boundary', error);
  }

  const coastline = await ensureCoastline();
  const coastFilter = filterPointsAwayFromCoast(boundaryPoints, coastline, projection, options);
  const filteredBoundaryPoints = coastFilter.filtered.length >= options.minBoundaryPoints
    ? coastFilter.filtered
    : boundaryPoints;
  const candidate = await fitOpenCvEllipseFromBoundary(filteredBoundaryPoints, options);
  const usableDistances = coastFilter.minDistances.filter(Number.isFinite);

  return {
    projection,
    clusteredPoints,
    boundaryPoints,
    filteredBoundaryPoints,
    candidate,
    metrics: {
      clusteredCount: clusteredPoints.length,
      boundaryCount: boundaryPoints.length,
      filteredBoundaryCount: filteredBoundaryPoints.length,
      coastRejectedCount: Math.max(boundaryPoints.length - filteredBoundaryPoints.length, 0),
      minCoastDistanceMeters: usableDistances.length ? Math.min(...usableDistances) : null,
    },
  };
}

function buildRenderableGeometry(result) {
  if (result.candidate.coordinateSpace === 'raw-degrees') {
    const axisMetrics = measureRawDegreeEllipseAxesMeters(result.candidate);
    return {
      type: 'ellipse',
      center: {
        lat: result.candidate.centerLat,
        lng: result.candidate.centerLng,
      },
      semiMajorMeters: axisMetrics.semiMajorMeters,
      semiMinorMeters: axisMetrics.semiMinorMeters,
      majorAxisLengthMeters: axisMetrics.semiMajorMeters * 2,
      minorAxisLengthMeters: axisMetrics.semiMinorMeters * 2,
      angleDeg: axisMetrics.angleDeg,
      latlngs: buildRawDegreeEllipseLatLngs(result.candidate, 180),
    };
  }

  return {
    type: 'ellipse',
    center: result.projection.unproject({
      x: result.candidate.centerX,
      y: result.candidate.centerY,
    }),
    semiMajorMeters: result.candidate.semiMajor,
    semiMinorMeters: result.candidate.semiMinor,
    majorAxisLengthMeters: result.candidate.semiMajor * 2,
    minorAxisLengthMeters: result.candidate.semiMinor * 2,
    angleDeg: (radToDeg(result.candidate.angle) + 360) % 360,
    latlngs: buildEllipseCandidateLatLngs(result.candidate, result.projection, 180),
  };
}

function getDisplayedRedAlertNames() {
  const appState = window.AppState;
  if (!appState || !appState.locationStates) return [];

  return Object.keys(appState.locationStates)
    .filter((name) => appState.locationStates[name] && appState.locationStates[name].state === 'red')
    .sort((a, b) => a.localeCompare(b, 'he'));
}

function resolveAlertedPoints(names, pointsMap) {
  const missing = [];
  const points = [];

  for (const name of names) {
    const coords = pointsMap[name];
    if (!coords || !Array.isArray(coords) || coords.length < 2) {
      missing.push(name);
      continue;
    }
    points.push({ name, lat: coords[0], lng: coords[1] });
  }

  if (!points.length) {
    throw new Error('calcEllipseAlgC: no usable coordinates found');
  }

  return { points, missing };
}

function clearAlgCOverlay() {
  if (debugLayer && window.AppState && window.AppState.map) {
    window.AppState.map.removeLayer(debugLayer);
  }
  debugLayer = null;
}

function drawDebugOverlay(renderable, result, alertedPoints, options) {
  const appState = window.AppState;
  if (!appState || !appState.map || !window.L) return null;

  clearAlgCOverlay();

  const map = appState.map;
  const layerGroup = L.layerGroup();
  const color = options.color || '#8a3ffc';

  L.polygon(renderable.latlngs, {
    color,
    weight: 3,
    opacity: 0.95,
    fillColor: color,
    fillOpacity: 0.06,
  }).addTo(layerGroup).bindPopup(
    [
      'Alg-C',
      'fit=' + (result.candidate.fitSource || 'unknown'),
      'major=' + Math.round(renderable.majorAxisLengthMeters) + 'm',
      'minor=' + Math.round(renderable.minorAxisLengthMeters) + 'm',
      'angle=' + renderable.angleDeg.toFixed(1) + ' deg',
      'clustered=' + result.metrics.clusteredCount,
      'boundary=' + result.metrics.boundaryCount,
      'coastRejected=' + result.metrics.coastRejectedCount,
    ].join('<br>')
  );

  L.circleMarker([renderable.center.lat, renderable.center.lng], {
    radius: 5,
    color,
    weight: 2,
    fillColor: '#ffffff',
    fillOpacity: 1,
  }).addTo(layerGroup);

  if (options.showPoints) {
    for (const point of alertedPoints) {
      L.circleMarker([point.lat, point.lng], {
        radius: 3,
        color: '#111827',
        weight: 1,
        fillColor: '#111827',
        fillOpacity: 0.75,
      }).addTo(layerGroup).bindPopup(point.name || '');
    }
  }

  if (options.showBoundary) {
    for (const point of result.filteredBoundaryPoints) {
      L.circleMarker([point.source.lat, point.source.lng], {
        radius: 4,
        color: '#f97316',
        weight: 1,
        fillColor: '#f97316',
        fillOpacity: 0.85,
      }).addTo(layerGroup);
    }
  }

  layerGroup.addTo(map);
  debugLayer = layerGroup;

  if (options.fitBounds !== false) {
    map.fitBounds(L.latLngBounds(renderable.latlngs).pad(0.08));
  }

  return layerGroup;
}

export async function calcEllipseAlgC(options = {}) {
  const mergedOptions = {
    ...ALG_C_DEFAULT_OPTIONS,
    ...(options.algCOptions || {}),
  };

  const locationNames = Array.isArray(options.locations) && options.locations.length
    ? options.locations.map((value) => String(value))
    : getDisplayedRedAlertNames();

  if (!locationNames.length) {
    throw new Error('calcEllipseAlgC: no red alert locations are currently active');
  }

  const pointsMap = await ensureOrefPoints();
  const resolved = resolveAlertedPoints(locationNames, pointsMap);
  const result = await fitAlgC(resolved.points, mergedOptions);
  const renderable = buildRenderableGeometry(result);

  if (options.draw !== false) {
    drawDebugOverlay(renderable, result, resolved.points, options);
  }

  const payload = {
    inputLocations: locationNames,
    missingLocations: resolved.missing,
    alertedPointCount: resolved.points.length,
    candidate: result.candidate,
    metrics: result.metrics,
    renderable,
  };

  if (options.log !== false) {
    console.log('calcEllipseAlgC result', payload);
  }

  return payload;
}

export { clearAlgCOverlay };
