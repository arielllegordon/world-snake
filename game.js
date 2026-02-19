import * as THREE from 'three';
import { geoContains } from 'd3-geo';

/* ── Constants ────────────────────────────────── */
const GLOBE_RADIUS = 5;
const BIRD_SPEED = 0.1;       // angular speed in rad/s
const BIRD_TURN_SPEED = 2.0;  // how fast bird steers toward mouse
const BIRD_SCALE = 0.5;
const BIRD_ALTITUDE = 0.1;    // hover height above globe surface
const CAMERA_DISTANCE = 13;
const CAMERA_BEHIND = 1.5;    // how far camera shifts behind the bird
const CAMERA_SMOOTH = 0.15;   // camera lerp factor

/* ── Trail Constants ─────────────────────────────── */
const TRAIL_SAMPLE_DIST = 0.02;   // min angular distance between samples
const TRAIL_WIDTH = 0.025;        // ribbon half-width
const TRAIL_ALTITUDE = 0.04;     // above globe, below bird
const TRAIL_MAX = 2000;           // max stored trail points
const COLLISION_THRESHOLD = 0.035; // angular distance to trigger death
const COLLISION_COS = Math.cos(COLLISION_THRESHOLD); // pre-computed for dot-product check
const COLLISION_SKIP = 5;         // skip newest N points (avoid self-hit at head)
const BIRD_NOSE_ANGLE = (BIRD_SCALE * 0.15) / (GLOBE_RADIUS + BIRD_ALTITUDE); // collision point under the bird's head

/* ── Milestone 3 Constants ───────────────────── */
const PICKUP_RADIUS = 0.1;          // angular distance for bottle pickup
const PICKUP_COS = Math.cos(PICKUP_RADIUS);
const BOTTLE_ALTITUDE = 0.2;        // hover height above globe
const BOTTLE_SCALE = 0.4;
const TRAIL_INITIAL_LENGTH = 20;    // starting trail capacity (points) — short!
const TRAIL_GROWTH = 15;            // trail points added per pickup (gradual!)
const COUNTRY_FLASH_DURATION = 3.0; // seconds

/* ── Renderer ─────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

/* ── Scene & Camera ───────────────────────────── */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  50, window.innerWidth / window.innerHeight, 0.1, 200
);

const texLoader = new THREE.TextureLoader();

/* ── Globe ────────────────────────────────────── */
const globeTexture = texLoader.load('land-map.jpg');
globeTexture.colorSpace = THREE.SRGBColorSpace;

const globe = new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64),
  new THREE.MeshBasicMaterial({ map: globeTexture })
);
scene.add(globe);

/* ── Stars ────────────────────────────────────── */
const STAR_COUNT = 400;
const starVerts = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const r = 40 + Math.random() * 60;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starVerts[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  starVerts[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  starVerts[i * 3 + 2] = r * Math.cos(phi);
}
const starsGeo = new THREE.BufferGeometry();
starsGeo.setAttribute('position', new THREE.BufferAttribute(starVerts, 3));
scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({
  color: 0x666666, size: 0.2
})));

/* ── Bird ─────────────────────────────────────── */
const birdTexture = texLoader.load('bird.png');
birdTexture.colorSpace = THREE.SRGBColorSpace;

const BIRD_ASPECT = 1738 / 1000;
const birdMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(BIRD_SCALE * BIRD_ASPECT, BIRD_SCALE),
  new THREE.MeshBasicMaterial({
    map: birdTexture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
// Lay flat on surface, beak faces away from camera (bird flies forward)
birdMesh.rotation.set(-Math.PI / 2, 0, 0);

const bird = new THREE.Object3D();
bird.add(birdMesh);
scene.add(bird);

/* ── Bird State ───────────────────────────────── */
const birdPos = new THREE.Vector3(0, 0, 1).normalize();
const birdFwd = new THREE.Vector3(1, 0, 0);

// Project a vector onto the tangent plane at a point on the sphere
function tangentProject(v, normal) {
  const out = v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
  return out.length() > 1e-6 ? out.normalize() : null;
}

birdFwd.copy(tangentProject(birdFwd, birdPos));

/* ── Geo Helpers ─────────────────────────────── */
function latLngToUnit(lat, lng) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );
}

function unitToLatLng(v) {
  const phi = Math.acos(Math.min(1, Math.max(-1, v.y)));
  const lat = 90 - phi * (180 / Math.PI);
  const theta = Math.atan2(v.z, -v.x);
  let lng = theta * (180 / Math.PI) - 180;
  if (lng < -180) lng += 360;
  return [lat, lng];
}

/* ── Mouse ────────────────────────────────────── */
const mouseNDC = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let mouseTarget = null;

/* ── Boost ────────────────────────────────────── */
const BOOST_MULTIPLIER = 5;
let boosting = false;

const boostHud = document.createElement('div');
boostHud.textContent = 'BOOST';
boostHud.style.cssText =
  'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
  'color:#138CF6;font:bold 24px monospace;display:none;z-index:10;' +
  'text-shadow:0 0 10px #138CF6;pointer-events:none;';
document.body.appendChild(boostHud);

/* ── Mouse (steering + boost via shiftKey) ───── */
document.addEventListener('mousemove', (e) => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  boosting = e.shiftKey;
  boostHud.style.display = boosting ? 'block' : 'none';
});

/* ── Trail Data ──────────────────────────────── */
let trailPoints = [];   // array of unit Vector3s
let lastTrailSample = birdPos.clone();

/* ── Trail Mesh (multi-strand slipstream) ────── */
const TRAIL_STRANDS = 3;
const VERTS_PER_STRAND = TRAIL_MAX * 2;
const TOTAL_TRAIL_VERTS = VERTS_PER_STRAND * TRAIL_STRANDS;
const QUADS_PER_STRAND = TRAIL_MAX - 1;

const trailGeo = new THREE.BufferGeometry();
const trailPositions = new Float32Array(TOTAL_TRAIL_VERTS * 3);
const trailAlphas = new Float32Array(TOTAL_TRAIL_VERTS);
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setAttribute('alpha', new THREE.BufferAttribute(trailAlphas, 1));

// Index buffer: interleaved so each quad position groups all 3 strands together.
// This way setDrawRange(0, N) draws the first N/18 quads from ALL strands evenly.
const trailIndices = new Uint32Array(QUADS_PER_STRAND * 6 * TRAIL_STRANDS);
for (let i = 0; i < QUADS_PER_STRAND; i++) {
  for (let s = 0; s < TRAIL_STRANDS; s++) {
    const v = s * VERTS_PER_STRAND + i * 2;
    const b = (i * TRAIL_STRANDS + s) * 6;
    trailIndices[b]     = v;
    trailIndices[b + 1] = v + 1;
    trailIndices[b + 2] = v + 2;
    trailIndices[b + 3] = v + 2;
    trailIndices[b + 4] = v + 1;
    trailIndices[b + 5] = v + 3;
  }
}
trailGeo.setIndex(new THREE.BufferAttribute(trailIndices, 1));
trailGeo.setDrawRange(0, 0);

const trailMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uColor: { value: new THREE.Color(0xffffff) },
  },
  vertexShader: `
    attribute float alpha;
    varying float vAlpha;
    void main() {
      vAlpha = alpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      gl_FragColor = vec4(uColor, vAlpha);
    }
  `,
});
const trailMesh = new THREE.Mesh(trailGeo, trailMat);
scene.add(trailMesh);

// Per-strand config: center strand is solid, side strands are wispy
const strandConfigs = [
  { offset: 0,     widthMul: 1.0, phase: 0,   alphaMax: 0.9 },
  { offset: 0.01,  widthMul: 0.5, phase: 2.1, alphaMax: 0.45 },
  { offset: -0.01, widthMul: 0.5, phase: 4.2, alphaMax: 0.45 },
];

/* ── Bottle ───────────────────────────────────── */
const bottleTexture = texLoader.load('message.png');
bottleTexture.colorSpace = THREE.SRGBColorSpace;
const bottleMat = new THREE.SpriteMaterial({ map: bottleTexture, depthWrite: false, transparent: true });
const bottle = new THREE.Sprite(bottleMat);
bottle.scale.set(BOTTLE_SCALE, BOTTLE_SCALE * (560 / 520), 1);
bottle.visible = false;
scene.add(bottle);

let bottleUnit = new THREE.Vector3(); // unit vector of bottle position on globe
let bottleSpawnTimer = 0;
let collectAnim = null; // hard mode: { time, duration, normal }

/* ── Scoring ─────────────────────────────────── */
let messagesCollected = 0;
let countriesVisited = [];
let currentCountry = null;
let trailMaxLength = TRAIL_INITIAL_LENGTH;

/* ── Country Flash ───────────────────────────── */
let activeFlashes = [];

function flashCountry(feature) {
  const type = feature.geometry.type;
  const coords = feature.geometry.coordinates;
  const allRings = type === 'Polygon' ? [coords] :
                   type === 'MultiPolygon' ? coords : [];

  const r = GLOBE_RADIUS + 0.02;
  const group = new THREE.Group();

  // 1. Fill — draw polygon onto a canvas, texture-map onto a sphere overlay.
  //    Canvas 2D fill() handles concave/complex polygons correctly,
  //    avoiding the broken 3D triangulation that mangled countries like Iran.
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';

  for (const polygon of allRings) {
    const outerRing = polygon[0];
    ctx.beginPath();
    for (let j = 0; j < outerRing.length; j++) {
      const x = (outerRing[j][0] + 180) / 360 * canvas.width;
      const y = (90 - outerRing[j][1]) / 180 * canvas.height;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  const fillMesh = new THREE.Mesh(
    new THREE.SphereGeometry(r, 64, 64),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0.9, depthWrite: false,
    })
  );
  group.add(fillMesh);

  // 2. Outline — LineLoop (traces the border on the globe surface)
  for (const polygon of allRings) {
    const outerRing = polygon[0];
    const step = Math.max(1, Math.floor(outerRing.length / 200));
    const linePts = [];
    for (let j = 0; j < outerRing.length; j += step) {
      const [lng, lat] = outerRing[j];
      linePts.push(latLngToUnit(lat, lng).multiplyScalar(r));
    }
    if (linePts.length < 3) continue;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1, depthWrite: false
    });
    group.add(new THREE.LineLoop(lineGeo, lineMat));
  }

  scene.add(group);
  activeFlashes.push({ mesh: group, timeLeft: COUNTRY_FLASH_DURATION });
}

/* ── GeoJSON + Country Data ──────────────────── */
let geoFeatures = [];
let geoReady = false;

function getCountryName(feature) {
  const p = feature.properties;
  return p.NAME || p.name || p.ADMIN || p.NAME_EN || 'Unknown';
}

/* ── Country Data Lookup (capitals + flags) ──── */
const countryDataMap = {};  // keyed by uppercase ISO_A2
let countryDataReady = false;

function getCountryData(feature) {
  const code = (feature.properties.ISO_A2 || '').toUpperCase();
  if (code && code !== '-99' && countryDataMap[code]) {
    return countryDataMap[code];
  }
  return { capital: getCountryName(feature), flagUrl: null };
}

async function loadCountryData() {
  try {
    const resp = await fetch('countries-capitals-flags.json');
    const json = await resp.json();
    for (const entry of json) {
      const code = (entry.code || '').toUpperCase();
      if (code) {
        countryDataMap[code] = {
          capital: entry.capital || entry.name,
          flagUrl: 'https://flagcdn.com/w320/' + code.toLowerCase() + '.png',
        };
      }
    }
    countryDataReady = true;
    if (geoReady && gameRunning) spawnBottle();
  } catch (e) {
    console.error('Failed to load country data:', e);
    countryDataReady = true; // proceed with fallbacks
  }
}

function allDataReady() {
  return geoReady && countryDataReady;
}

/* ── Silhouette Renderer ─────────────────────── */
function renderSilhouette(feature) {
  const type = feature.geometry.type;
  const coords = feature.geometry.coordinates;
  const allPolygons = type === 'Polygon' ? [coords] :
                      type === 'MultiPolygon' ? coords : [];

  // Calculate bounding box
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function walkCoords(arr) {
    if (typeof arr[0] === 'number') {
      minLng = Math.min(minLng, arr[0]);
      maxLng = Math.max(maxLng, arr[0]);
      minLat = Math.min(minLat, arr[1]);
      maxLat = Math.max(maxLat, arr[1]);
      return;
    }
    for (const child of arr) walkCoords(child);
  }
  walkCoords(coords);

  const DISPLAY = 150;
  const RES = 2; // 2x resolution for sharp edges
  const SIZE = DISPLAY * RES;
  const PAD = 10 * RES;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.style.width = DISPLAY + 'px';
  canvas.style.height = DISPLAY + 'px';
  canvas.style.position = 'static';
  const ctx = canvas.getContext('2d');

  // Scale to fit with padding, maintain aspect ratio, flip Y
  const dataW = maxLng - minLng || 1;
  const dataH = maxLat - minLat || 1;
  const scale = Math.min((SIZE - PAD * 2) / dataW, (SIZE - PAD * 2) / dataH);
  const offX = (SIZE - dataW * scale) / 2;
  const offY = (SIZE - dataH * scale) / 2;

  function toX(lng) { return offX + (lng - minLng) * scale; }
  function toY(lat) { return offY + (maxLat - lat) * scale; } // flip Y

  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2 * RES;
  ctx.lineJoin = 'round';

  for (const polygon of allPolygons) {
    const outerRing = polygon[0];
    ctx.beginPath();
    for (let j = 0; j < outerRing.length; j++) {
      const x = toX(outerRing[j][0]);
      const y = toY(outerRing[j][1]);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  return canvas;
}

/* ── Hint Rendering ──────────────────────────── */
function updateHint() {
  if (!currentCountry) return;
  const name = getCountryName(currentCountry);
  const data = getCountryData(currentCountry);

  if (hintMode === 'capital') {
    hintHud.innerHTML = `Find the message in: <b>${data.capital}</b>`;
  } else if (hintMode === 'flag') {
    if (data.flagUrl) {
      hintHud.innerHTML = '';
      const img = document.createElement('img');
      img.src = data.flagUrl;
      img.style.cssText = 'height:80px;border:2px solid white;border-radius:4px;';
      img.onerror = () => { hintHud.innerHTML = `Find the message in: <b>${name}</b>`; };
      hintHud.appendChild(img);
    } else {
      hintHud.innerHTML = `Find the message in: <b>${name}</b>`;
    }
  } else if (hintMode === 'silhouette') {
    hintHud.innerHTML = '';
    silhouetteHud.innerHTML = '';
    silhouetteHud.style.display = '';
    const canvas = renderSilhouette(currentCountry);
    silhouetteHud.appendChild(canvas);
  } else {
    // 'name' mode (default)
    hintHud.innerHTML = `Find the message in: <b>${name}</b>`;
  }

  // Hide silhouette HUD when not in silhouette mode
  if (hintMode !== 'silhouette') {
    silhouetteHud.style.display = 'none';
    silhouetteHud.innerHTML = '';
  }

  skipHintHud.textContent = hintMode === 'capital' ? 'Tab: Skip capital' : 'Tab: Skip country';
}

function randomPointInCountry(feature) {
  const coords = feature.geometry.coordinates;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;

  function walkCoords(arr) {
    if (typeof arr[0] === 'number') {
      minLng = Math.min(minLng, arr[0]);
      maxLng = Math.max(maxLng, arr[0]);
      minLat = Math.min(minLat, arr[1]);
      maxLat = Math.max(maxLat, arr[1]);
      return;
    }
    for (const child of arr) walkCoords(child);
  }
  walkCoords(coords);

  // Handle countries crossing the date line (e.g. Fiji, Russia)
  // Their raw bounding box spans nearly 360° — shift to [0,360] range instead
  const crossesDateLine = (maxLng - minLng) > 180;
  if (crossesDateLine) {
    minLng = Infinity; maxLng = -Infinity;
    (function walkShifted(arr) {
      if (typeof arr[0] === 'number') {
        const lng = arr[0] < 0 ? arr[0] + 360 : arr[0];
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        return;
      }
      for (const child of arr) walkShifted(child);
    })(coords);
  }

  for (let attempt = 0; attempt < 500; attempt++) {
    let lng = minLng + Math.random() * (maxLng - minLng);
    const lat = minLat + Math.random() * (maxLat - minLat);
    if (crossesDateLine && lng > 180) lng -= 360;
    if (geoContains(feature, [lng, lat])) return [lng, lat];
  }
  let fallbackLng = (minLng + maxLng) / 2;
  if (crossesDateLine && fallbackLng > 180) fallbackLng -= 360;
  return [fallbackLng, (minLat + maxLat) / 2];
}

/* ── Shuffle bag: cycle through all countries before repeating ── */
let countryDeck = [];
let countryDeckIndex = 0;

function shuffleDeck() {
  countryDeck = geoFeatures.slice();
  for (let i = countryDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [countryDeck[i], countryDeck[j]] = [countryDeck[j], countryDeck[i]];
  }
  countryDeckIndex = 0;
}

function pickRandomCountry() {
  if (countryDeckIndex >= countryDeck.length) shuffleDeck();
  return countryDeck[countryDeckIndex++];
}

function spawnBottle() {
  if (!allDataReady()) return;
  currentCountry = pickRandomCountry();
  const [lng, lat] = randomPointInCountry(currentCountry);
  bottleUnit.copy(latLngToUnit(lat, lng));

  // If bird is already on top of the spawn point, re-roll to avoid silent instant pickup
  const angDist = Math.acos(Math.min(1, birdPos.dot(bottleUnit)));
  if (angDist < PICKUP_RADIUS * 2) {
    console.warn(`[spawn] Re-rolling: ${getCountryName(currentCountry)} spawned ${angDist.toFixed(3)} rad from bird (too close)`);
    spawnBottle();          // try again with a different country/point
    return;
  }

  bottle.position.copy(bottleUnit.clone().multiplyScalar(GLOBE_RADIUS + BOTTLE_ALTITUDE));

  // Mode-dependent bottle settings
  bottle.scale.set(BOTTLE_SCALE, BOTTLE_SCALE * (560 / 520), 1);
  bottleMat.opacity = 1;
  bottle.visible = difficulty !== 'hard';

  updateHint();
  console.log(`[spawn] ${getCountryName(currentCountry)} at ang dist ${angDist.toFixed(3)} rad from bird`);
}

function pickupBottle() {
  messagesCollected++;
  scoreText.textContent = `Messages: ${messagesCollected}`;
  countriesVisited.push({
    name: getCountryName(currentCountry),
    code: (currentCountry.properties.ISO_A2 || '').toUpperCase(),
  });
  trailMaxLength = Math.min(trailMaxLength + TRAIL_GROWTH, TRAIL_MAX - 1);
  console.log(`[pickup] #${messagesCollected} ${getCountryName(currentCountry)} | trail now ${trailMaxLength} pts`);
  flashCountry(currentCountry);

  // Flash the country name on pickup for non-name modes
  if (hintMode !== 'name') {
    flashCountryName(getCountryName(currentCountry));
  }

  if (difficulty === 'hard') {
    // Show bottle at bird's position with a pop + fade animation
    bottle.visible = true;
    bottle.position.copy(birdPos.clone().multiplyScalar(GLOBE_RADIUS + BOTTLE_ALTITUDE));
    bottle.scale.set(BOTTLE_SCALE, BOTTLE_SCALE * (560 / 520), 1);
    bottleMat.opacity = 1;
    collectAnim = { time: 0, duration: 0.4, normal: birdPos.clone() };
  } else {
    bottle.visible = false;
  }

  bottleSpawnTimer = 0.5;
}

const EXCLUDED_TERRITORIES = new Set([
  'Akrotiri Sovereign Base Area',
  'Aland',
  'Ashmore and Cartier Islands',
  'Bajo Nuevo Bank (Petrel Is.)',
  'Baykonur Cosmodrome',
  'Bir Tawil',
  'Brazilian Island',
  'British Indian Ocean Territory',
  'Clipperton Island',
  'Coral Sea Islands',
  'Cyprus No Mans Area',
  'Dhekelia Sovereign Base Area',
  'French Southern and Antarctic Lands',
  'Guernsey',
  'Hong Kong S.A.R.',
  'Indian Ocean Territories',
  'Isle of Man',
  'Jersey',
  'Montserrat',
  'New Caledonia',
  'Niue',
  'Norfolk Island',
  'Northern Mariana Islands',
  'Pitcairn Islands',
  'Saint Barthelemy',
  'Saint Helena',
  'Saint Martin',
  'Saint Pierre and Miquelon',
  'Scarborough Reef',
  'Serranilla Bank',
  'Siachen Glacier',
  'Sint Maarten',
  'Somaliland',
  'South Georgia and the Islands',
  'Southern Patagonian Ice Field',
  'Spratly Islands',
  'US Naval Base Guantanamo Bay',
  'United States Minor Outlying Islands',
  'Wallis and Futuna',
  'Western Sahara',
]);

async function loadGeoJSON() {
  try {
    const resp = await fetch('countries-outline.geojson');
    const json = await resp.json();
    geoFeatures = json.features.filter(f =>
      f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
      !EXCLUDED_TERRITORIES.has(f.properties.ADMIN)
    );
    geoReady = true;
    shuffleDeck();
    if (countryDataReady && gameRunning) spawnBottle();
  } catch (e) {
    console.error('Failed to load GeoJSON:', e);
  }
}
loadGeoJSON();
loadCountryData();

/* ── Game State ──────────────────────────────── */
let gameRunning = false;
let elapsedTime = 0;
let difficulty = 'easy';
let hintMode = 'name';

/* ── HUD: Timer ──────────────────────────────── */
const timerHud = document.createElement('div');
timerHud.textContent = '0:00';
timerHud.style.cssText =
  'position:fixed;top:20px;right:20px;color:#fff;' +
  'font:bold 24px monospace;z-index:10;pointer-events:none;display:none;';
document.body.appendChild(timerHud);

/* ── HUD: Score ──────────────────────────────── */
const scoreHud = document.createElement('div');
scoreHud.style.cssText =
  'position:fixed;top:20px;left:20px;color:#fff;' +
  'font:bold 24px monospace;z-index:10;pointer-events:none;' +
  'display:none;align-items:center;gap:8px;';
const scoreIcon = document.createElement('img');
scoreIcon.src = 'message.png';
scoreIcon.style.cssText = 'height:54px;width:auto;transform:rotate(90deg);';
const scoreText = document.createElement('span');
scoreText.textContent = 'Messages: 0';
scoreHud.appendChild(scoreIcon);
scoreHud.appendChild(scoreText);
document.body.appendChild(scoreHud);

/* ── HUD: Silhouette (top-right, under timer) ── */
const silhouetteHud = document.createElement('div');
silhouetteHud.style.cssText =
  'position:fixed;top:130px;right:20px;z-index:10;pointer-events:none;display:none;';
document.body.appendChild(silhouetteHud);

/* ── HUD: Country Hint ───────────────────────── */
const hintHud = document.createElement('div');
hintHud.style.cssText =
  'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);color:#fff;' +
  'font:bold 20px monospace;z-index:10;pointer-events:none;text-align:center;' +
  'text-shadow:0 0 8px rgba(0,0,0,0.8);display:none;';
document.body.appendChild(hintHud);

/* ── HUD: Country Name Flash (on pickup) ───── */
const nameFlashHud = document.createElement('div');
nameFlashHud.style.cssText =
  'position:fixed;color:#fff;font:bold 18px monospace;z-index:10;pointer-events:none;' +
  'text-align:center;text-shadow:0 0 8px rgba(0,0,0,0.8);display:none;' +
  'transition:opacity 0.5s ease;';
document.body.appendChild(nameFlashHud);
let nameFlashTimer = null;

function flashCountryName(countryName) {
  if (nameFlashTimer) clearTimeout(nameFlashTimer);
  nameFlashHud.textContent = `That was: ${countryName}!`;
  nameFlashHud.style.opacity = '1';
  nameFlashHud.style.display = '';

  // Position based on hint mode
  if (hintMode === 'silhouette') {
    // Below the silhouette in top-right
    nameFlashHud.style.top = '290px';
    nameFlashHud.style.right = '20px';
    nameFlashHud.style.bottom = '';
    nameFlashHud.style.left = '';
    nameFlashHud.style.transform = '';
  } else {
    // Above the hint area (flag / capital) at bottom-center
    nameFlashHud.style.top = '';
    nameFlashHud.style.right = '';
    nameFlashHud.style.bottom = hintMode === 'flag' ? '140px' : '70px';
    nameFlashHud.style.left = '50%';
    nameFlashHud.style.transform = 'translateX(-50%)';
  }

  nameFlashTimer = setTimeout(() => {
    nameFlashHud.style.opacity = '0';
    setTimeout(() => { nameFlashHud.style.display = 'none'; }, 500);
  }, 1200);
}

/* ── HUD: Skip Hint ─────────────────────────── */
const skipHintHud = document.createElement('div');
skipHintHud.textContent = 'Tab: Skip country';
skipHintHud.style.cssText =
  'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.4);' +
  'font:14px monospace;z-index:10;pointer-events:none;display:none;';
document.body.appendChild(skipHintHud);

/* ── Start Screen Overlay ───────────────────── */
const startScreen = document.createElement('div');
startScreen.style.cssText =
  'position:fixed;inset:0;background:rgba(0,0,0,0.7);' +
  'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'z-index:200;color:#fff;font-family:monospace;';

const btnStyle =
  'font-size:20px;padding:12px 40px;cursor:pointer;border:none;border-radius:6px;' +
  'font-family:monospace;font-weight:bold;color:#fff;min-width:180px;';

const hintModeLabels = {
  name: 'Country Name',
  capital: 'Capital City',
  silhouette: 'Silhouette',
  flag: 'Flag',
};

function showStartStep1() {
  startScreen.innerHTML =
    '<h1 style="font-size:56px;margin-bottom:16px;letter-spacing:4px;">World Snake</h1>' +
    '<p style="font-size:20px;margin-bottom:32px;color:rgba(255,255,255,0.7);">Choose your hint format</p>' +
    '<div style="display:flex;flex-direction:column;gap:16px;">' +
      `<button class="hint-btn" data-hint="name" style="${btnStyle}background:#2ecc71;">Country Name</button>` +
      `<button class="hint-btn" data-hint="capital" style="${btnStyle}background:#3498db;">Capital City</button>` +
      `<button class="hint-btn" data-hint="silhouette" style="${btnStyle}background:#9b59b6;">Silhouette</button>` +
      `<button class="hint-btn" data-hint="flag" style="${btnStyle}background:#e67e22;">Flag</button>` +
    '</div>';
  startScreen.querySelectorAll('.hint-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      hintMode = btn.dataset.hint;
      showStartStep2();
    });
  });
}

function showStartStep2() {
  startScreen.innerHTML =
    '<h1 style="font-size:56px;margin-bottom:16px;letter-spacing:4px;">World Snake</h1>' +
    '<p style="font-size:20px;margin-bottom:24px;color:rgba(255,255,255,0.7);">Choose difficulty</p>' +
    '<div style="display:flex;flex-direction:column;gap:16px;">' +
      `<button class="diff-btn" data-diff="easy" style="${btnStyle}background:#2ecc71;">Easy</button>` +
      `<button class="diff-btn" data-diff="hard" style="${btnStyle}background:#e74c3c;">Hard</button>` +
    '</div>' +
    `<a class="back-link" href="#" style="margin-top:20px;color:rgba(255,255,255,0.5);font-size:16px;text-decoration:none;">← Back</a>`;
  startScreen.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      difficulty = btn.dataset.diff;
      startScreen.style.display = 'none';
      startGame();
    });
  });
  startScreen.querySelector('.back-link').addEventListener('click', (e) => {
    e.preventDefault();
    showStartStep1();
  });
}

showStartStep1();
document.body.appendChild(startScreen);

function startGame() {
  // Show HUD
  timerHud.style.display = '';
  scoreHud.style.display = 'flex';
  hintHud.style.display = '';
  skipHintHud.style.display = '';

  // Start game
  gameRunning = true;
  clock.getDelta(); // flush accumulated delta

  // Spawn first bottle
  bottleSpawnTimer = 0;
  if (allDataReady()) spawnBottle();
  else bottleSpawnTimer = 0.5;
}

/* ── HUD: Game Over Overlay ──────────────────── */
const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;background:rgba(0,0,0,0.75);' +
  'display:none;flex-direction:column;align-items:center;justify-content:center;gap:60px;' +
  'z-index:100;color:#fff;font-family:monospace;padding:40px 20px;overflow-y:auto;';
overlay.innerHTML = `
  <div style="display:flex;flex-direction:column;align-items:center;gap:32px;">
    <h1 style="font-size:64px;font-weight:500;text-align:center;letter-spacing:6px;margin:0;">Game Over</h1>
    <div style="display:flex;gap:36px;">
      <button id="go-restart" style="font-size:18px;font-weight:500;padding:16px 28px;cursor:pointer;background:#138CF6;color:#fff;border:none;border-radius:14px;font-family:monospace;">Play again</button>
      <button id="go-change-mode" style="font-size:18px;font-weight:500;padding:16px 28px;cursor:pointer;background:#666;color:#fff;border:none;border-radius:14px;font-family:monospace;">Change mode</button>
    </div>
  </div>
  <div style="display:flex;gap:20px;width:100%;max-width:660px;">
    <div style="flex:1;min-width:180px;background:rgba(247,248,248,0.15);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 16px;">
      <span id="go-time-val" style="font-size:64px;font-weight:500;">0:00</span>
      <span style="font-size:18px;font-weight:400;opacity:0.6;">Time survived</span>
    </div>
    <div style="flex:1;min-width:180px;background:rgba(247,248,248,0.12);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 16px;">
      <div style="display:flex;align-items:center;justify-content:center;">
        <span id="go-msgs-val" style="font-size:64px;font-weight:500;">0</span>
        <img src="message.png" style="height:56px;width:auto;transform:rotate(90deg);margin-left:4px;">
      </div>
      <span style="font-size:18px;font-weight:400;opacity:0.6;">Messages collected</span>
    </div>
  </div>
  <div id="go-countries-section" style="display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center;">
    <span style="font-size:18px;font-weight:500;">Countries visited:</span>
    <div id="go-countries" style="margin-top:16px;background:rgba(247,248,248,0.12);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border-radius:18px;padding:20px 32px;display:flex;gap:40px;flex-wrap:wrap;justify-content:center;"></div>
  </div>`;
document.body.appendChild(overlay);

document.getElementById('go-restart').addEventListener('click', () => {
  restart();
  startGame();
});

document.getElementById('go-change-mode').addEventListener('click', () => {
  restart();
  shuffleDeck();
  timerHud.style.display = 'none';
  scoreHud.style.display = 'none';
  hintHud.style.display = 'none';
  silhouetteHud.style.display = 'none';
  skipHintHud.style.display = 'none';
  showStartStep1();
  startScreen.style.display = 'flex';
});

function formatTime(t) {
  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function codeToFlagEmoji(code) {
  if (!code || code === '-99' || code.length !== 2) return '';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

function gameOver() {
  gameRunning = false;
  document.getElementById('go-time-val').textContent = formatTime(elapsedTime);
  document.getElementById('go-msgs-val').textContent = messagesCollected;
  const countriesDiv = document.getElementById('go-countries');
  const countriesSection = document.getElementById('go-countries-section');
  if (countriesVisited.length > 0) {
    countriesSection.style.display = '';
    // Split countries into columns of 4
    const PER_COL = 4;
    const columns = [];
    for (let i = 0; i < countriesVisited.length; i += PER_COL) {
      columns.push(countriesVisited.slice(i, i + PER_COL));
    }
    let html = '';
    for (const col of columns) {
      html += '<div style="display:flex;flex-direction:column;gap:14px;">';
      for (const entry of col) {
        const flagUrl = entry.code && entry.code !== '-99'
          ? 'https://flagcdn.com/w80/' + entry.code.toLowerCase() + '.png'
          : null;
        const flagImg = flagUrl
          ? `<img src="${flagUrl}" style="width:48px;height:32px;object-fit:cover;border-radius:3px;flex-shrink:0;" onerror="this.style.display='none'">`
          : '';
        html += `<div style="display:flex;align-items:center;gap:14px;">` +
          `<div style="width:48px;height:32px;flex-shrink:0;">${flagImg}</div>` +
          `<span style="font-size:16px;white-space:nowrap;">${entry.name}</span></div>`;
      }
      html += '</div>';
    }
    countriesDiv.innerHTML = html;
  } else {
    countriesSection.style.display = 'none';
  }
  overlay.style.display = 'flex';
}

function restart() {
  // Reset bird
  birdPos.set(0, 0, 1).normalize();
  birdFwd.set(1, 0, 0);
  birdFwd.copy(tangentProject(birdFwd, birdPos));

  // Reset trail
  trailPoints = [];
  lastTrailSample.copy(birdPos);
  trailGeo.setDrawRange(0, 0);

  // Reset scoring
  messagesCollected = 0;
  countriesVisited = [];
  trailMaxLength = TRAIL_INITIAL_LENGTH;
  scoreText.textContent = 'Messages: 0';

  // Clear flashes
  for (const f of activeFlashes) {
    f.mesh.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    scene.remove(f.mesh);
  }
  activeFlashes = [];

  // Clear name flash
  if (nameFlashTimer) { clearTimeout(nameFlashTimer); nameFlashTimer = null; }
  nameFlashHud.style.display = 'none';

  // Reset bottle + country deck
  bottle.visible = false;
  bottleSpawnTimer = 0.5;
  bottleMat.opacity = 1;
  collectAnim = null;
  hintHud.textContent = '';
  silhouetteHud.innerHTML = '';
  silhouetteHud.style.display = 'none';

  // Reset camera
  camera.position.copy(birdPos.clone().multiplyScalar(CAMERA_DISTANCE));
  camera.lookAt(0, 0, 0);

  // Reset timer & state
  elapsedTime = 0;
  timerHud.textContent = '0:00';
  clock.getDelta(); // flush accumulated delta
  gameRunning = false;
  overlay.style.display = 'none';
}

/* ── Init Camera ──────────────────────────────── */
camera.position.copy(birdPos.clone().multiplyScalar(CAMERA_DISTANCE));
camera.lookAt(0, 0, 0);

/* ── Game Loop ────────────────────────────────── */
const clock = new THREE.Clock();

function rebuildTrailGeometry() {
  const posAttr = trailGeo.getAttribute('position');
  const alphaAttr = trailGeo.getAttribute('alpha');
  const posArr = posAttr.array;
  const alphaArr = alphaAttr.array;
  const trailR = GLOBE_RADIUS + TRAIL_ALTITUDE;
  const _normal = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _prevSide = new THREE.Vector3();
  const _base = new THREE.Vector3();
  const _offset = new THREE.Vector3();
  const time = elapsedTime;

  // Render points = trailPoints + current birdPos (live head, no gap)
  const renderLen = trailPoints.length + 1;

  for (let s = 0; s < TRAIL_STRANDS; s++) {
    const cfg = strandConfigs[s];
    const vertBase = s * VERTS_PER_STRAND;
    _prevSide.set(0, 0, 0);

    for (let i = 0; i < renderLen; i++) {
      // Last point is always the live bird position
      const p = i < trailPoints.length ? trailPoints[i] : birdPos;

      _normal.copy(p);

      // Forward direction: use neighbors, bird's known forward for the head
      if (i === renderLen - 1) {
        _fwd.copy(birdFwd);
      } else {
        const next = (i + 1 < trailPoints.length) ? trailPoints[i + 1] : birdPos;
        _fwd.subVectors(next, p);
      }

      _side.crossVectors(_normal, _fwd);
      const sideLen = _side.length();
      if (sideLen > 1e-6) {
        _side.divideScalar(sideLen);
        if (_prevSide.lengthSq() > 0.5 && _side.dot(_prevSide) < 0) _side.negate();
        _prevSide.copy(_side);
      } else if (_prevSide.lengthSq() > 0.5) {
        _side.copy(_prevSide);
      } else {
        _side.set(1, 0, 0);
      }

      // t: 0 = oldest (tail), 1 = newest (head)
      const t = renderLen > 1 ? i / (renderLen - 1) : 1;

      // Alpha: mostly solid, fade only at tail end
      const alpha = Math.min(t * 5, 1) * cfg.alphaMax;

      // Width: slight taper at tail
      const width = TRAIL_WIDTH * cfg.widthMul * (0.6 + 0.4 * t);

      // Lateral wobble: sinusoidal turbulence, stronger at tail
      const wobble = Math.sin(i * 0.35 + time * 3.0 + cfg.phase) * 0.008 * (1.0 - t * 0.7);

      // Altitude wobble: slight vertical undulation
      const altWobble = Math.sin(i * 0.5 + time * 1.8 + cfg.phase * 0.7) * 0.005;

      _base.copy(p).multiplyScalar(trailR + altWobble);
      _offset.copy(_side).multiplyScalar(width + cfg.offset + wobble);

      const idx = (vertBase + i * 2) * 3;
      posArr[idx]     = _base.x + _offset.x;
      posArr[idx + 1] = _base.y + _offset.y;
      posArr[idx + 2] = _base.z + _offset.z;
      posArr[idx + 3] = _base.x - _offset.x;
      posArr[idx + 4] = _base.y - _offset.y;
      posArr[idx + 5] = _base.z - _offset.z;

      const ai = vertBase + i * 2;
      alphaArr[ai]     = alpha;
      alphaArr[ai + 1] = alpha;
    }
  }

  posAttr.needsUpdate = true;
  alphaAttr.needsUpdate = true;
  const quads = Math.max(0, renderLen - 1);
  trailGeo.setDrawRange(0, quads * 6 * TRAIL_STRANDS);
}

function update() {
  requestAnimationFrame(update);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (gameRunning) {
    // Update timer
    elapsedTime += dt;
    timerHud.textContent = formatTime(elapsedTime);

    // 1. Raycast mouse onto globe
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObject(globe);
    if (hits.length > 0) {
      mouseTarget = hits[0].point.clone().normalize();
    }

    // 2. Steer toward mouse target
    if (mouseTarget) {
      const desired = tangentProject(mouseTarget, birdPos);
      if (desired) {
        const t = Math.min(BIRD_TURN_SPEED * dt, 1);
        birdFwd.lerp(desired, t);
        const reprojected = tangentProject(birdFwd, birdPos);
        if (reprojected) birdFwd.copy(reprojected);
      }
    }

    // 3. Move bird forward along great circle (slow down when turning)
    let turnAmount = 0;
    if (mouseTarget) {
      const desired = tangentProject(mouseTarget, birdPos);
      if (desired) turnAmount = 1 - Math.abs(birdFwd.dot(desired));
    }
    const speedMult = 1 - turnAmount * 0.5; // slow to 50% during sharp turns
    const boostMult = boosting ? BOOST_MULTIPLIER : 1;
    const angle = BIRD_SPEED * speedMult * boostMult * dt;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    birdPos.set(
      birdPos.x * cosA + birdFwd.x * sinA,
      birdPos.y * cosA + birdFwd.y * sinA,
      birdPos.z * cosA + birdFwd.z * sinA,
    ).normalize();

    // 4. Parallel-transport forward direction to new position
    const transported = tangentProject(birdFwd, birdPos);
    if (transported) birdFwd.copy(transported);

    // 5. Pickup detection
    if (difficulty === 'hard' && currentCountry && bottleSpawnTimer <= 0) {
      const [lat, lng] = unitToLatLng(birdPos);
      if (geoContains(currentCountry, [lng, lat])) {
        pickupBottle();
      }
    }
    if (difficulty !== 'hard' && bottle.visible && birdPos.dot(bottleUnit) > PICKUP_COS) {
      pickupBottle();
    }

    // 5b. Bottle spawn timer
    if (bottleSpawnTimer > 0) {
      bottleSpawnTimer -= dt;
      if (bottleSpawnTimer <= 0 && allDataReady()) spawnBottle();
    }

    // 5c. Bottle bob animation
    if (bottle.visible && !collectAnim) {
      const bob = Math.sin(elapsedTime * 3) * 0.05;
      bottle.position.copy(
        bottleUnit.clone().multiplyScalar(GLOBE_RADIUS + BOTTLE_ALTITUDE + bob)
      );
      bottle.material.rotation += dt * 0.5;
    }

    // 5d. Collection animation (hard mode)
    if (collectAnim) {
      collectAnim.time += dt;
      const t = collectAnim.time / collectAnim.duration;
      if (t >= 1) {
        bottle.visible = false;
        bottleMat.opacity = 1;
        collectAnim = null;
      } else {
        const s = BOTTLE_SCALE * (1 + t * 0.6);
        bottle.scale.set(s, s * (560 / 520), 1);
        bottle.position.copy(collectAnim.normal.clone().multiplyScalar(GLOBE_RADIUS + BOTTLE_ALTITUDE + t * 0.5));
        bottleMat.opacity = 1 - t;
      }
    }

    // 6. Sample trail point
    if (birdPos.angleTo(lastTrailSample) >= TRAIL_SAMPLE_DIST) {
      trailPoints.push(birdPos.clone());
      lastTrailSample.copy(birdPos);
      // Trim to current max length (grows with pickups)
      if (trailPoints.length > trailMaxLength) {
        trailPoints.splice(0, trailPoints.length - trailMaxLength);
      }
    }

    // 7. Collision detection — only the bird's nose triggers death
    const cosN = Math.cos(BIRD_NOSE_ANGLE);
    const sinN = Math.sin(BIRD_NOSE_ANGLE);
    const noseX = birdPos.x * cosN + birdFwd.x * sinN;
    const noseY = birdPos.y * cosN + birdFwd.y * sinN;
    const noseZ = birdPos.z * cosN + birdFwd.z * sinN;
    const checkEnd = trailPoints.length - COLLISION_SKIP;
    for (let i = 0; i < checkEnd; i++) {
      const tp = trailPoints[i];
      if (noseX * tp.x + noseY * tp.y + noseZ * tp.z > COLLISION_COS) {
        gameOver();
        break;
      }
    }

    // 8. Rebuild trail ribbon geometry
    if (trailPoints.length >= 1) {
      rebuildTrailGeometry();
    }

    // 9. Update country flashes
    for (let i = activeFlashes.length - 1; i >= 0; i--) {
      const f = activeFlashes[i];
      f.timeLeft -= dt;
      const progress = f.timeLeft / COUNTRY_FLASH_DURATION;
      if (f.timeLeft <= 0) {
        f.mesh.traverse(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
          }
        });
        scene.remove(f.mesh);
        activeFlashes.splice(i, 1);
      } else {
        f.mesh.traverse(child => {
          if (child.material) {
            // Outline starts at 1, fill starts at 0.9
            const baseOpacity = child.isLine ? 1 : 0.9;
            child.material.opacity = baseOpacity * progress;
          }
        });
      }
    }

    // 10. Update bird Object3D
    const surfacePoint = birdPos.clone().multiplyScalar(GLOBE_RADIUS + BIRD_ALTITUDE);
    bird.position.copy(surfacePoint);
    bird.up.copy(birdPos);
    bird.lookAt(surfacePoint.clone().add(birdFwd));

    // 11. Smooth camera follow — globe centered, always upright
    const idealCam = birdPos.clone().multiplyScalar(CAMERA_DISTANCE);
    camera.position.lerp(idealCam, CAMERA_SMOOTH);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
  }

  renderer.render(scene, camera);
}

update();

/* ── Tab: Skip Country ────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && gameRunning && currentCountry && bottleSpawnTimer <= 0) {
    e.preventDefault();
    bottle.visible = false;
    spawnBottle();
  }
});

/* ── Resize ───────────────────────────────────── */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
