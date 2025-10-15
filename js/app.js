/* Förare för en dag – Röda linjen (T14) – ANNOUNCEMENTS ONLY
   Utrop: "Nästa station …", "Dörrarna stängs", "Tänk på avståndet …" (extra poäng),
          "Byte till …", "Slutstation …"
   Poäng ges ENDAST vid rätt timing – annars 0 p (inga minus).
*/

// ===== Data =====
const RED_T14 = [
  { name: "Mörby centrum" },
  { name: "Danderyds sjukhus" },
  { name: "Bergshamra" },
  { name: "Universitetet" },
  { name: "Tekniska högskolan" },
  { name: "Stadion" },
  { name: "Östermalmstorg" },
  { name: "T-Centralen", interchange: ["Gröna linjen", "Blå linjen"] },
  { name: "Gamla stan", interchange: ["Gröna linjen"] },
  { name: "Slussen", interchange: ["Gröna linjen", "Saltsjöbanan", "Djurgårdslinjen"] },
  { name: "Mariatorget" },
  { name: "Zinkensdamm" },
  { name: "Hornstull" },
  { name: "Liljeholmen", interchange: ["Tvärbanan"] },
  { name: "Midsommarkransen" },
  { name: "Telefonplan" },
  { name: "Hägerstensåsen" },
  { name: "Västertorp" },
  { name: "Fruängen" },
];

// Tidsparametrar (enkla, kan bytas mot Trafiklab senare)
const SECTION_SECONDS = 28;      // kör mellan stationer
const DEFAULT_DWELL = 8;         // uppehåll (plattform)
const NEXT_STATION_WINDOW = 3;   // ± sek kring mitten av körsträckan
const CLOSING_WINDOW = 2;        // sista 2 sek av dwell
const PTS_NEXT = 10;
const PTS_CLOSING = 10;
const PTS_GAP = 15;              // extra poäng
const PTS_INTERCHANGE = 10;
const PTS_TERMINAL = 20;

// ===== State =====
let idx = 0; // stationsindex
let phase = "enroute"; // "enroute" | "arrived" | "doorsOpen" | "departing" | "finished"
let timer = SECTION_SECONDS;
let totalScore = 0;

const stats = {
  next:        { attempts: 0, hits: 0, points: 0, per: PTS_NEXT, label: "Nästa station" },
  closing:     { attempts: 0, hits: 0, points: 0, per: PTS_CLOSING, label: "Dörrarna stängs" },
  gap:         { attempts: 0, hits: 0, points: 0, per: PTS_GAP, label: "Tänk på avståndet" },
  interchange: { attempts: 0, hits: 0, points: 0, per: PTS_INTERCHANGE, label: "Byte till …" },
  terminal:    { attempts: 0, hits: 0, points: 0, per: PTS_TERMINAL, label: "Slutstation" },
};

// ===== DOM refs =====
const elCurrent = document.getElementById("currentStation");
const elInterchanges = document.getElementById("interchanges");
const elPhase = document.getElementById("phase");
const elNext = document.getElementById("nextStation");
const elTimerText = document.getElementById("timerText");
const elTimerBar = document.getElementById("timerBar");
const elTerminalFlag = document.getElementById("terminalFlag");
const elStationList = document.getElementById("stationList");
const elLog = document.getElementById("logList");
const elTotalScore = document.getElementById("totalScore");
const elScoreRows = document.getElementById("scoreRows");
const elSumAttempts = document.getElementById("sumAttempts");
const elSumHits = document.getElementById("sumHits");
const elSumPoints = document.getElementById("sumPoints");

// Buttons
document.getElementById("btnNext").addEventListener("click", sayNext);
document.getElementById("btnInterchange").addEventListener("click", sayInterchange);
document.getElementById("btnGap").addEventListener("click", sayGap);
document.getElementById("btnClosing").addEventListener("click", sayClosing);
document.getElementById("btnTerminal").addEventListener("click", sayTerminal);
document.getElementById("btnRestart").addEventListener("click", restart);

// ===== Init =====
renderStationList();
renderAll();
startTick();

// ===== Game Loop =====
let intervalId = null;
function startTick(){
  stopTick();
  intervalId = setInterval(() => {
    if (phase === "finished") return;
    timer -= 1;
    if (timer <= 0){
      if (phase === "enroute"){
        phase = "arrived";
        timer = DEFAULT_DWELL;
      } else if (phase === "arrived"){
        phase = "doorsOpen";          // autöppna
        timer = Math.max(3, DEFAULT_DWELL - 2);
      } else if (phase === "doorsOpen"){
        phase = "departing";          // stäng & avgå
        timer = 2;
      } else if (phase === "departing"){
        if (isTerminal()){
          phase = "finished";
          timer = 0;
        } else {
          idx += 1;
          phase = "enroute";
          timer = SECTION_SECONDS;
        }
      }
    }
    renderAll();
  }, 1000);
}
function stopTick(){ if (intervalId) clearInterval(intervalId); }

// ===== Announcements =====
function sayNext(){
  attempt("next");
  if (phase !== "enroute" || !getNextStation()){
    log("⚠️ ”Nästa station …” ska ropas under färd."); return;
  }
  const mid = SECTION_SECONDS / 2;
  const delta = Math.abs(timer - mid);
  if (delta <= NEXT_STATION_WINDOW){
    hit("next", `Nästa station ${getNextStation().name}.`);
  } else {
    log("”Nästa station …” för långt från mitt i sträckan (0p).");
  }
}

function sayInterchange(){
  attempt("interchange");
  const st = getCurrent();
  if (!st.interchange || st.interchange.length === 0){
    log("Ingen byte-information på denna station (0p)."); return;
  }
  if (phase === "arrived" || phase === "doorsOpen"){
    hit("interchange", `Byte till ${st.interchange.join(", ")}.`);
  } else {
    log("”Byte till …” ska ropas under uppehåll vid plattform (0p).");
  }
}

function sayGap(){
  attempt("gap");
  if (phase === "arrived" || phase === "doorsOpen"){
    hit("gap", "Tänk på avståndet mellan vagn och plattformen när du stiger av.");
  } else {
    log("”Tänk på avståndet …” görs vid plattform (0p).");
  }
}

function sayClosing(){
  attempt("closing");
  if (phase !== "doorsOpen"){
    log("”Dörrarna stängs” ska annonseras precis före avgång (0p)."); return;
  }
  if (timer <= CLOSING_WINDOW){
    hit("closing", "Dörrarna stängs.");
  } else {
    log("För tidigt för ”Dörrarna stängs” (0p).");
  }
}

function sayTerminal(){
  attempt("terminal");
  if (!isTerminal()){
    log("”Slutstation …” endast på slutstation (0p)."); return;
  }
  if (phase === "arrived" || phase === "doorsOpen"){
    hit("terminal", "Slutstation, avstigning för samtliga.");
  } else {
    log("Gör slutstations-utrop vid plattform (0p).");
  }
}

// ===== Helpers (state) =====
function getCurrent(){ return RED_T14[idx]; }
function getNextStation(){ return RED_T14[idx+1]; }
function isTerminal(){ return idx === RED_T14.length - 1; }

// ===== Scoring =====
function attempt(key){
  stats[key].attempts += 1;
  renderScore();
}
function hit(key, message){
  stats[key].hits += 1;
  stats[key].points += stats[key].per;
  totalScore += stats[key].per;
  log(`${message} (+${stats[key].per})`);
  renderScore();
  renderHeaderScore();
}

// ===== Render =====
function renderAll(){
  // Station & chips
  elCurrent.textContent = getCurrent().name;
  const ints = getCurrent().interchange;
  elInterchanges.textContent = ints && ints.length ? `Byte: ${ints.join(", ")}` : "Ingen byte";
  elPhase.textContent = `Fas: ${labelPhase(phase)}`;
  const ns = getNextStation();
  elNext.textContent = ns ? `Nästa: ${ns.name}` : "Nästa: —";

  // Terminalbadge
  if (isTerminal()){
    elTerminalFlag.hidden = false;
  } else {
    elTerminalFlag.hidden = true;
  }

  // Timer
  elTimerText.textContent = Math.max(0, timer);
  const denom = (phase === "enroute") ? SECTION_SECONDS : DEFAULT_DWELL;
  const pct = Math.max(0, Math.min(100, (timer / denom) * 100));
  elTimerBar.style.width = pct + "%";

  // Stationslista markering
  updateStationList();
}

function renderHeaderScore(){
  elTotalScore.textContent = totalScore;
}

function renderScore(){
  // Töm och bygg rader
  elScoreRows.innerHTML = "";
  const keys = ["next","closing","gap","interchange","terminal"];
  let sumA=0,sumH=0,sumP=0;
  keys.forEach(k=>{
    const s = stats[k];
    sumA += s.attempts; sumH += s.hits; sumP += s.points;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.label}</td>
      <td>${s.attempts}</td>
      <td>${s.hits}</td>
      <td>${s.per}</td>
      <td>${s.points}</td>
    `;
    elScoreRows.appendChild(tr);
  });
  elSumAttempts.textContent = sumA;
  elSumHits.textContent = sumH;
  elSumPoints.textContent = sumP;
  renderHeaderScore();
}

function renderStationList(){
  // Första init
  elStationList.innerHTML = "";
  RED_T14.forEach((s, i)=>{
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot dot-next";
    const name = document.createElement("span");
    name.textContent = s.name;
    li.appendChild(dot); li.appendChild(name);
    elStationList.appendChild(li);
  });
  updateStationList();
}

function updateStationList(){
  const items = Array.from(elStationList.children);
  items.forEach((li, i)=>{
    const dot = li.querySelector(".dot");
    dot.className = "dot " + (i < idx ? "dot-done" : i === idx ? "dot-now" : "dot-next");
    li.style.fontWeight = (i === idx) ? "700" : "400";
  });
}

function labelPhase(p){
  switch(p){
    case "enroute": return "Under färd";
    case "arrived": return "Inrullning / vid plattform";
    case "doorsOpen": return "Uppehåll (dörrar öppna)";
    case "departing": return "Avgång";
    case "finished": return "Kört klart";
    default: return p;
  }
}

function log(msg){
  const li = document.createElement("li");
  li.textContent = time() + " " + msg;
  elLog.prepend(li);
  // begränsa logglängd
  while (elLog.children.length > 16) elLog.removeChild(elLog.lastChild);
}

function time(){
  return new Date().toLocaleTimeString();
}

function restart(){
  idx = 0; phase = "enroute"; timer = SECTION_SECONDS; totalScore = 0;
  for (const k of Object.keys(stats)){
    stats[k].attempts = 0; stats[k].hits = 0; stats[k].points = 0;
  }
  elLog.innerHTML = "";
  renderAll(); renderScore(); renderHeaderScore();
  startTick();
}
