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
  } else
