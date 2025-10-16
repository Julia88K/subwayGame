/* Realistisk SL-version: hämtar resa & stopp från SL:s öppna API:er.
   (Journey-planner v2; ingen nyckel i integrations-miljön, men CORS kan variera i din dev-miljö.) */

// --------- Hjälp ---------
const $ = (s, r=document)=>r.querySelector(s);
const nameLayer = $("#nameLayer");
let map, routeLayer, trainMarker, slotMarkers = [];
let placed = new Set();
let draggableDivs = [];
let currentStops = [];   // [{name, lat, lon, mot}]
let currentLegs = [];    // [{coords: LatLng[], mot, isTransferAfter}]
let animating = false;

const COLORS = {
  METRO: '#e63946',   // tunnelbana
  TRAM: '#8854d0',    // tvär-/lokalbanor
  TRAIN: '#277da1',   // pendeltåg/roslagsbana som tåg
  DEFAULT: '#7a8ba1'  // gång etc
};

// --------- Init karta ----------
function initMap(){
  map = L.map('map').setView([59.31, 18.06], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  // säkerställ korrekt storlek när allt har mountats
  setTimeout(()=> map.invalidateSize(), 0);
}

// --------- SL APIer ----------
const JP_BASE = '/slapi/v2';

/** Stop-finder: returnera bästa match för namn */
async function stopLookup(name){
  const url = new URL(JP_BASE + '/stop-finder');
  url.searchParams.set('name_sf', name);
  url.searchParams.set('type_sf','any');
  url.searchParams.set('any_obj_filter_sf','2'); // endast hållplatser
  url.searchParams.set('language','sv');

  const res = await fetch(url, { headers: {'accept':'application/json'} });
  if(!res.ok) throw new Error('Stop-finder fel: ' + res.status);
  const data = await res.json();

  const loc = (data.locations || []).find(x => x.type === 'stop') || (data.locations||[])[0];
  if(!loc) throw new Error('Hittade ingen hållplats för: ' + name);

  return {
    id: String(loc.id),                               // globalt HAFAS-id
    stopId: String(loc.properties?.stopId || ''),     // lokalt stopId (extId)
    name: (loc.disassembledName || loc.name || name),
    lat: loc.coord?.[0],
    lon: loc.coord?.[1]
  };
}

/** Trips: prova flera varianter och stöd både "trips" och "journeys" */
async function getTrip(origin, dest){
  const base = JP_BASE + '/trips';
  let res, data, trip;

  // Försök A: id_origin/id_destination
  const a = new URL(base);
  a.searchParams.set('id_origin', origin.id);
  a.searchParams.set('id_destination', dest.id);
  a.searchParams.set('calc_number_of_trips','1');
  a.searchParams.set('language','sv');
  a.searchParams.set('gen_c','true');
  a.searchParams.set('route_type','leasttime');

  res = await fetch(a, { headers: { accept:'application/json' } });
  if (res.ok) {
    data = await res.json();
    trip = (data.trips || data.Trip || [])[0] || (data.journeys || [])[0];
    if (trip) return normalizeTrip(trip);
  } else {
    console.warn('[trips:A] status', res.status);
  }

  // Försök B: name_origin/name_destination (med type=any)
  const b = new URL(base);
  b.searchParams.set('type_origin','any');
  b.searchParams.set('name_origin', origin.name || origin.id);
  b.searchParams.set('type_destination','any');
  b.searchParams.set('name_destination', dest.name || dest.id);
  b.searchParams.set('calc_number_of_trips','1');
  b.searchParams.set('language','sv');
  b.searchParams.set('gen_c','true');
  b.searchParams.set('route_type','leasttime');

  res = await fetch(b, { headers: { accept:'application/json' } });
  if (res.ok) {
    data = await res.json();
    trip = (data.trips || data.Trip || [])[0] || (data.journeys || [])[0];
    if (trip) return normalizeTrip(trip);
  } else {
    console.warn('[trips:B] status', res.status);
  }

  // Försök C: extId-parametrar (lokala stopId)
  if (origin.stopId && dest.stopId) {
    const c = new URL(base);
    c.searchParams.set('originExtId', origin.stopId);
    c.searchParams.set('destExtId', dest.stopId);
    c.searchParams.set('calc_number_of_trips','1');
    c.searchParams.set('language','sv');
    c.searchParams.set('gen_c','true');
    c.searchParams.set('route_type','leasttime');

    res = await fetch(c, { headers: { accept:'application/json' } });
    if (res.ok) {
      data = await res.json();
      trip = (data.trips || data.Trip || [])[0] || (data.journeys || [])[0];
      if (trip) return normalizeTrip(trip);
    } else {
      console.warn('[trips:C] status', res.status);
    }
  }

  const text = res ? await res.text().catch(()=> '') : '';
  throw new Error('Ingen resa hittad (prövade id/name/extId). Sista svar: ' + (text || res?.status || 'ok utan innehåll'));
}

/** Normalisera svar => {stops:[...], legs:[...]}  */
function normalizeTrip(trip){
  // Hantera både struktur från "journeys" och "trips"
  const legsArr = Array.isArray(trip.legs) ? trip.legs
    : Array.isArray(trip.Legs) ? trip.Legs
      : Array.isArray(trip.legs?.Leg) ? trip.legs.Leg
        : [];

  const stops = [];
  const legs = [];

  for (let i=0; i<legsArr.length; i++){
    const leg = legsArr[i];

    // Typ-identifiering
    const categoryRaw = (leg.category || leg.type || leg.ServiceCategory || '').toString().toUpperCase();
    const prodName = (leg.transportation && (leg.transportation.product?.name || leg.transportation.product?.Name)) || '';
    const prodClass = leg.transportation?.product?.class;

    let mot = 'DEFAULT';
    if (/METRO|TUNNELBANA/.test(categoryRaw) || /TUNNELBANA/i.test(prodName) || prodClass === 2) mot = 'METRO';
    else if (/TRAM|LRT|SPÅRVÄG|LOKALBANA/i.test(categoryRaw) || /TRAM|SPÅRVÄG|LOKALBANA/i.test(prodName)) mot = 'TRAM';
    else if (/TRAIN|PENDELTÅG|COMMUTER|REGIONAL/i.test(categoryRaw) || /PENDELTÅG|REGIONAL|TÅG/i.test(prodName)) mot = 'TRAIN';

    // Origin/Destination
    const o = leg.origin || leg.Origin || {};
    const d = leg.destination || leg.Destination || {};
    const oParent = o.parent || {};
    const dParent = d.parent || {};
    const oName = (oParent.disassembledName || oParent.name || o.name || 'Start').replace(/, Stockholm$/,'');
    const dName = (dParent.disassembledName || dParent.name || d.name || 'Mål').replace(/, Stockholm$/,'');
    const oLat = +(o.coord?.[0] ?? o.lat ?? o.y ?? 0);
    const oLon = +(o.coord?.[1] ?? o.lon ?? o.x ?? 0);
    const dLat = +(d.coord?.[0] ?? d.lat ?? d.y ?? 0);
    const dLon = +(d.coord?.[1] ?? d.lon ?? d.x ?? 0);

    // Stop-sequence -> stationslista
    const seqArr = Array.isArray(leg.stopSequence) ? leg.stopSequence
      : Array.isArray(leg.Stops) ? leg.Stops
        : [];
    let seqStops = seqArr.map(s => {
      const p = s.parent || {};
      const nm = (p.disassembledName || p.name || s.name || '').replace(/, Stockholm$/,'');
      const lat = +(s.coord?.[0] ?? s.lat ?? s.y ?? 0);
      const lon = +(s.coord?.[1] ?? s.lon ?? s.x ?? 0);
      return nm ? { name: nm, lat, lon, mot } : null;
    }).filter(Boolean);

    if (seqStops.length === 0){
      seqStops = [
        {name:oName, lat:oLat, lon:oLon, mot},
        {name:dName, lat:dLat, lon:dLon, mot}
      ];
    }

    // Geometri
    let coords = [];
    if (Array.isArray(leg.coords) && leg.coords.length){
      coords = leg.coords.map(([lat,lon]) => [lat,lon]);
    } else if (leg.coord || leg.coordinates || leg.polyline){
      const c = leg.coord || leg.coordinates || [];
      const arr = Array.isArray(c) ? c : (c.points || []);
      coords = arr.map(p => Array.isArray(p) ? p : [+(p.lat||p.y), +(p.lon||p.x)]);
    } else {
      coords = [[oLat,oLon],[dLat,dLon]];
    }

    // Lägg in stops (undvik dubblering)
    if (stops.length === 0) stops.push(seqStops[0]);
    for (let k=1; k<seqStops.length; k++) stops.push(seqStops[k]);

    legs.push({
      mot,
      coords,
      from: {name:oName, lat:oLat, lon:oLon},
      to:   {name:dName, lat:dLat, lon:dLon},
      isTransferAfter: i < legsArr.length - 1
    });
  }

  // Deduplicera intilliggande namn
  const dedup = [];
  for (const s of stops){
    if (!dedup.length || dedup[dedup.length-1].name !== s.name){
      dedup.push(s);
    }
  }

  return { stops: dedup, legs };
}

// --------- UI: slots & brickor ----------
function makeSlotsAndBricks(stops){
  // Rensa
  slotMarkers.forEach(m => map.removeLayer(m));
  slotMarkers = [];
  nameLayer.innerHTML = '';
  draggableDivs = [];
  placed.clear();
  updateProgress();

  // Lägg ut Leaflet-slot per stopp
  stops.forEach((s, idx)=>{
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `<span>${idx+1}.</span> <span class="target">⬜</span> <span class="hint">(${s.mot || ''})</span>`;

    // autosize ikon så den syns
    const icon = L.divIcon({
      html: el,
      className: 'slot-icon',
      iconSize: null
    });

    const m = L.marker([s.lat, s.lon], {icon}).addTo(map);
    m._slotName = s.name;
    m._slotEl = el;

    // dropp-hantering
    el.addEventListener('dragover', e=> e.preventDefault());
    el.addEventListener('drop', e=>{
      e.preventDefault();
      if (animating) return;
      const name = e.dataTransfer.getData('text/plain');
      if (!name) return;
      if (name === m._slotName){
        el.classList.remove('bad'); el.classList.add('ok');
        el.querySelector('.target').textContent = name;
        const d = draggableDivs.find(dv=>dv.dataset.name===name);
        if (d) d.remove();
        placed.add(name);
        updateProgress();
        maybeAnimate();
      } else {
        el.classList.add('bad');
        setTimeout(()=>el.classList.remove('bad'), 600);
      }
    });

    slotMarkers.push(m);
  });

  // Skapa brickor (plus några distraktorer)
  const needNames = stops.map(s=>s.name);
  const distractors = [];
  for (let i=1;i<Math.min(needNames.length,6);i++){
    const j = needNames.length - 1 - i;
    if (j>0) distractors.push(needNames[j]);
  }
  const pool = shuffle([...new Set([...needNames, ...distractors])]);

  // Slumpa pos på overlay
  const pad = 20, W = nameLayer.clientWidth, H = nameLayer.clientHeight;
  pool.forEach(name=>{
    const d = document.createElement('div');
    d.className = 'draggable';
    d.draggable = true;
    d.textContent = name;
    d.dataset.name = name;
    d.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', name);
      d.style.opacity = '0.6';
    });
    d.addEventListener('dragend', ()=> d.style.opacity = '1');

    const x = Math.random()*(W - 160 - pad*2) + pad;
    const y = Math.random()*(H - 60 - pad*2) + pad;
    d.style.transform = `translate(${x}px, ${y}px)`;

    nameLayer.appendChild(d);
    draggableDivs.push(d);
  });
}

function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function updateProgress(){
  const total = currentStops.length;
  const done = placed.size;
  $("#progressText").textContent = `${done} / ${total} stationer placerade`;
  $("#progressBar").style.width = total? `${(done/total)*100}%` : '0%';
}

// --------- Rita rutt & animation ----------
function drawRoute(legs){
  routeLayer.clearLayers();

  legs.forEach(l=>{
    const color = COLORS[l.mot] || COLORS.DEFAULT;
    L.polyline(l.coords, {color, weight:6, opacity:0.9}).addTo(routeLayer);
    if (l.isTransferAfter){
      const last = l.coords[l.coords.length-1];
      L.marker(last, {
        icon: L.divIcon({html:'<span class="transfer-label">Byte</span>', className:'', iconSize:null})
      }).addTo(routeLayer);
    }
  });

  // tåg-dot på första stoppet
  if (trainMarker) map.removeLayer(trainMarker);
  if (currentStops.length){
    trainMarker = L.marker([currentStops[0].lat, currentStops[0].lon], {
      icon: L.divIcon({html:'<div class="train-dot"></div>', className:'', iconSize:[14,14]})
    }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(currentStops.map(s=>[s.lat,s.lon])).pad(0.2));
  }
}

async function animateTrain(){
  if (animating) return; animating = true;
  for (const leg of currentLegs){
    const pts = leg.coords;
    for (let i=0;i<pts.length;i++){
      await new Promise(r=>setTimeout(r, 12));
      trainMarker.setLatLng(pts[i]);
    }
  }
  animating = false;
}

function maybeAnimate(){
  if (placed.size === currentStops.length){
    animateTrain();
  }
}

// --------- Planera resa (UI) ----------
async function planTrip(fromStr, toStr){
  $("#fromName").textContent = fromStr;
  $("#toName").textContent = toStr;
  $("#tripMeta").textContent = 'Planerar...';

  const from = await stopLookup(fromStr);
  const to   = await stopLookup(toStr);
  console.log('[stopLookup]', from, to);

  const {stops, legs} = await getTrip(from, to);
  console.log('[getTrip] stops=', stops, 'legs=', legs);

  currentStops = stops;
  currentLegs = legs;

  const nByten = Math.max(0, legs.length - 1);
  $("#tripMeta").textContent = `Antal stopp: ${stops.length}. Byten: ${nByten}.`;

  drawRoute(legs);
  makeSlotsAndBricks(stops);
  updateProgress();
}

// --------- Event hooks ----------
window.addEventListener('load', async ()=>{
  initMap();

  $("#planBtn").addEventListener('click', ()=>{
    planTrip($("#fromInput").value.trim(), $("#toInput").value.trim()).catch(err=>{
      console.error(err);
      $("#tripMeta").textContent = 'Fel: ' + err.message;
      alert('Kunde inte planera resan: ' + err.message);
    });
  });

  $("#resetBtn").addEventListener('click', ()=>{
    placed.clear();
    makeSlotsAndBricks(currentStops);
  });

  // Start med standarduppdrag, med fallback om CORS spökar
  try {
    await planTrip('Liljeholmen', 'T-Centralen');
  } catch (e){
    console.error('[PlanTrip fail]', e);
    $("#tripMeta").textContent = 'Kunde inte hämta resa (troligen CORS). Visar demo-rutt.';

    // --- Fallback/demo så UI:t funkar även utan API ---
    currentStops = [
      { name: 'Liljeholmen', lat:59.3109, lon:18.0227, mot:'METRO'},
      { name: 'Hornstull',   lat:59.3147, lon:18.0336, mot:'METRO'},
      { name: 'Zinkensdamm', lat:59.3178, lon:18.0445, mot:'METRO'},
      { name: 'Mariatorget', lat:59.3189, lon:18.0640, mot:'METRO'},
      { name: 'Slussen',     lat:59.3199, lon:18.0738, mot:'METRO'},
      { name: 'Gamla stan',  lat:59.3230, lon:18.0670, mot:'METRO'},
      { name: 'T-Centralen', lat:59.3334, lon:18.0591, mot:'METRO'}
    ];
    currentLegs = [{
      mot:'METRO',
      coords: currentStops.map(s=>[s.lat, s.lon]),
      from: currentStops[0], to: currentStops[currentStops.length-1],
      isTransferAfter:false
    }];
    drawRoute(currentLegs);
    makeSlotsAndBricks(currentStops);
    updateProgress();
  }
});

