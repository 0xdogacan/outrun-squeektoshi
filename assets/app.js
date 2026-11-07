import {
  StepCounter, nextRoundStart, strideMeters, hamsterMeters, verdict, commentary, formatMeters,
} from "/lib/core.js";

const SQUEEK_API = "https://api.squeekchain.com";
const RACE_SECONDS = 600;
const SIM = new URLSearchParams(location.search).has("sim");
const $ = (id) => document.getElementById(id);

// Browser storage is a convenience only; everything works without it.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const deviceId = (() => {
  let id = store.get("deviceId");
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    store.set("deviceId", id);
  }
  return id;
})();

let data = null;          // /api/rounds payload
let clockOffset = 0;      // server time - local time
const serverNow = () => Date.now() + clockOffset;
const boardState = { mode: "ghost", period: "week" };

/* ------------------------------ pixel hamster ----------------------------- */
// Original 16 x 12 sprite. o = fur, d = dark fur, w = belly, p = pink, k = eye.
const SPRITE = [
  "....dd....dd....",
  "...dppd..dppd...",
  "...doooooooood..",
  "..doooooooooood.",
  "..dookooooookod.",
  ".dooooopppooooo.",
  ".doowwwwwwwwwood",
  ".dowwwwwwwwwwwod",
  ".dowwwwwwwwwwwod",
  "..dowwwwwwwwwod.",
  "...ddooooooodd..",
  "...pp.......pp..",
];
const SPRITE_COLORS = { o: "#ffb547", d: "#b8741c", w: "#ffe7bf", p: "#ff8fa3", k: "#0a0c0b" };

function drawSprite(ctx, x, y, cell) {
  SPRITE.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === ".") return;
    ctx.fillStyle = SPRITE_COLORS[ch];
    ctx.beginPath();
    ctx.arc(x + c * cell + cell / 2, y + r * cell + cell / 2, cell * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }));
}

/* --------------------------------- home ---------------------------------- */
async function loadRounds() {
  try {
    const res = await fetch("/api/rounds");
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    clockOffset = data.now - Date.now();
  } catch {
    data = null;
  }
  // The server may be refused by the Squeekchain API; the browser can read it directly.
  if (!data?.live?.available) {
    const live = await browserLive();
    if (live) data = data ? { ...data, live } : { live };
  }
  renderLive();
  renderGhosts();
}

// Share wheel readings so the server can calibrate the wheel's size. During a run,
// the change in run distance over the change in turns gives mm per turn.
let lastCalibrationReport = 0;
let prevReading = null;
function reportCalibration(m) {
  const now = { epoch: m.counterEpoch, d: Number(m.distanceMm), w: Number(m.cumulativeWorkUnits) };
  const prev = prevReading;
  if (now.d > 0) prevReading = !prev || prev.epoch !== now.epoch || now.d < prev.d ? now : prev;
  else prevReading = null;
  if (Date.now() - lastCalibrationReport < 30000) return;
  const body = {};
  if (prev && prev.epoch === now.epoch && now.d > prev.d && now.w - prev.w >= 20) {
    body.deltaDistanceMm = now.d - prev.d;
    body.deltaWork = now.w - prev.w;
    prevReading = now;
  }
  if (Number(m.rpmMilli) > 0) { body.speedMmPerSecond = Number(m.speedMmPerSecond); body.rpmMilli = Number(m.rpmMilli); }
  if (!Object.keys(body).length) return;
  lastCalibrationReport = Date.now();
  fetch("/api/calibrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

async function browserLive() {
  try {
    const j = await (await fetch(`${SQUEEK_API}/v1/status`, { cache: "no-store" })).json();
    const m = j.measurement;
    if (!m) return null;
    const fresh = m.freshness === "online";
    if (fresh && m.provenance === "hardware") reportCalibration(m);
    return {
      available: true, fresh, coreStatus: m.coreStatus, provenance: m.provenance,
      running: fresh && m.coreStatus === "ACTIVE" && Number(m.rpmMilli) > 0,
      rpm: Number(m.rpmMilli) / 1000, speedMmPerSecond: Number(m.speedMmPerSecond),
    };
  } catch {
    return null;
  }
}

function renderLive() {
  const strip = $("live-strip");
  const live = data?.live;
  if (!data || !live?.available) {
    strip.dataset.state = "unknown";
    $("live-text").textContent = "Wheel data unavailable right now";
  } else if (live.running) {
    strip.dataset.state = "running";
    $("live-text").textContent = `Squeektoshi is running · ${Math.round(live.rpm)} RPM`;
  } else {
    strip.dataset.state = "asleep";
    $("live-text").textContent = live.fresh ? "Squeektoshi is resting" : "Wheel is offline";
  }
  $("live-card").hidden = !(live?.running && data?.circumference?.mm);
}

function whenText(ms) {
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function ghostButton(g) {
  const b = document.createElement("button");
  b.className = "ghost";
  b.innerHTML = `<span class="when"></span><span class="dist"></span><span class="sub muted"></span><span class="diff"></span>`;
  b.querySelector(".when").textContent = `Round ${g.round} · ${whenText(g.startsAt)}`;
  b.querySelector(".dist").textContent = formatMeters(g.meters);
  b.querySelector(".sub").textContent = `${g.work} wheel turns`;
  const d = b.querySelector(".diff");
  d.textContent = g.difficulty.toUpperCase();
  d.dataset.d = g.difficulty;
  b.addEventListener("click", () => openSetup({ mode: "ghost", round: g.round, ghostMeters: g.meters, txHash: g.txHash }));
  return b;
}

function renderGhosts() {
  const list = $("ghost-list");
  const boss = $("boss");
  list.replaceChildren();
  boss.hidden = true;
  if (!data?.clock) {
    list.innerHTML = `<p class="muted">Could not reach Squeekchain. Try again in a minute.</p>`;
    return;
  }
  if (!data.circumference?.mm) {
    list.innerHTML = `<p class="muted">Calibrating the wheel. Ghosts unlock the first time Squeektoshi runs while this site is open.</p>`;
    return;
  }
  if (data.roundsError || !data.ghosts.length) {
    list.innerHTML = `<p class="muted">${data.roundsError || "No rounds with running in the last 7 days yet."}</p>`;
    return;
  }
  const best = data.ghostOfTheWeek;
  if (best) {
    boss.hidden = false;
    boss.innerHTML = `<b>GHOST OF THE WEEK</b><p></p>`;
    boss.querySelector("p").textContent =
      `His fastest round this week: ${formatMeters(best.meters)} in 10 minutes. Nobody expects you to win.`;
    boss.appendChild(ghostButton(best));
  }
  data.ghosts.filter((g) => g.round !== best?.round).slice(0, 20).forEach((g) => list.appendChild(ghostButton(g)));
}

function tickCountdown() {
  if (data?.clock) {
    const next = nextRoundStart(serverNow(), data.clock.genesisMs, data.clock.durationMs);
    $("live-countdown").textContent = clock((next.startsAt - serverNow()) / 1000);
  }
}

async function loadBoard() {
  const list = $("board");
  try {
    const res = await fetch(`/api/scores?mode=${boardState.mode}&period=${boardState.period}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    $("humans-won").textContent = `${j.humansWhoWon} ${j.humansWhoWon === 1 ? "human has" : "humans have"} beaten Squeektoshi so far.`;
    list.replaceChildren();
    if (!j.rows.length) {
      list.innerHTML = `<li class="muted">No runs yet. Be the first.</li>`;
      return;
    }
    j.rows.forEach((r, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="rank"></span><span><span class="name"></span><br><span class="muted small"></span></span><span class="m"></span>`;
      li.querySelector(".rank").textContent = i + 1;
      li.querySelector(".name").textContent = r.nickname;
      li.querySelector(".small").textContent = `${formatMeters(r.player_m)} vs ${formatMeters(r.hamster_m)} · round ${r.round}`;
      const m = li.querySelector(".m");
      m.textContent = `${r.margin_m >= 0 ? "+" : "−"}${formatMeters(Math.abs(r.margin_m))}`;
      m.classList.add(r.margin_m >= 0 ? "win" : "loss");
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = `<li class="muted">${err.message || "Leaderboard unavailable."}</li>`;
  }
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.mode) boardState.mode = b.dataset.mode;
  if (b.dataset.period) boardState.period = b.dataset.period;
  document.querySelectorAll(".tabs button").forEach((x) => {
    const on = x.dataset.mode ? x.dataset.mode === boardState.mode : x.dataset.period === boardState.period;
    x.setAttribute("aria-selected", String(on));
  });
  loadBoard();
}));

/* --------------------------------- setup --------------------------------- */
let pending = null;

function openSetup(race) {
  pending = race;
  const p = store.get("profile") || {};
  const f = $("setup-form");
  f.nickname.value = p.nickname || "";
  f.height.value = p.height || "";
  f.stride.value = p.stride || "";
  $("setup-error").hidden = true;
  $("setup-sub").textContent = race.mode === "live"
    ? "You will join the next live round. Results arrive a few minutes after it ends."
    : `Ghost: round ${race.round}, ${formatMeters(race.ghostMeters)} in 10 minutes. Starts right away.`;
  $("setup").showModal();
}

$("setup-cancel").addEventListener("click", () => $("setup").close());
$("join-live").addEventListener("click", () => openSetup({ mode: "live" }));

async function requestMotion() {
  if (SIM) return true;
  if (typeof DeviceMotionEvent === "undefined") return false;
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    try { return (await DeviceMotionEvent.requestPermission()) === "granted"; } catch { return false; }
  }
  return true;
}

function sensorAlive(ms = 2500) {
  if (SIM) return Promise.resolve(true);
  return new Promise((resolve) => {
    const on = (e) => {
      const a = e.accelerationIncludingGravity;
      if (a && Number.isFinite(a.x)) { window.removeEventListener("devicemotion", on); resolve(true); }
    };
    window.addEventListener("devicemotion", on);
    setTimeout(() => { window.removeEventListener("devicemotion", on); resolve(false); }, ms);
  });
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $("setup-error");
  const nickname = f.nickname.value.trim();
  const height = Number(f.height.value) || 0;
  const stride = Number(f.stride.value) || 0;
  if (nickname.length < 2) { err.textContent = "Pick a nickname (2–20 characters)."; err.hidden = false; return; }
  if (!height && !stride) { err.textContent = "Enter your height or your stride."; err.hidden = false; return; }
  store.set("profile", { nickname, height, stride });

  $("setup-go").disabled = true;
  const granted = await requestMotion();
  const alive = granted && await sensorAlive();
  $("setup-go").disabled = false;
  if (!alive) {
    err.textContent = granted
      ? "No motion sensor found. Open this page on your phone."
      : "Motion access is needed to count your steps. Allow it and try again.";
    err.hidden = false;
    return;
  }
  $("setup").close();
  startRace({ ...pending, nickname, height, stride });
});

/* --------------------------------- race ---------------------------------- */
let race = null;

function clock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function show(id) {
  ["home", "race", "result"].forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo(0, 0);
}

function onMotion(e) {
  if (!race || race.done) return;
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const t = serverNow();
  if (t < race.startAt) return;
  race.counter.push(t, a.x, a.y, a.z);
}

function startSim() {
  // Practice mode for testing without a phone: a steady 2.7 steps/s jog.
  const id = setInterval(() => {
    if (!race || race.done) return clearInterval(id);
    const t = serverNow();
    if (t < race.startAt) return;
    const z = 9.81 + 6 * Math.sin(2 * Math.PI * 2.7 * (t / 1000));
    race.counter.push(t, 0.2, 0.1, z);
  }, 1000 / 60);
}

async function keepAwake() {
  try { race.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
}

async function startRace(opts) {
  const now = serverNow();
  let startAt = now + 3000;
  let round = opts.round;
  if (opts.mode === "live") {
    let next = nextRoundStart(now, data.clock.genesisMs, data.clock.durationMs);
    if (next.startsAt - now < 15000) next = { round: next.round + 1, startsAt: next.startsAt + data.clock.durationMs };
    startAt = next.startsAt;
    round = next.round;
  }
  race = {
    ...opts, round, startAt, endAt: startAt + RACE_SECONDS * 1000, done: false,
    counter: new StepCounter({ heightCm: opts.height, customStrideCm: opts.stride }),
    circumference: data.circumference.mm, liveBase: null, liveMeters: null, liveNote: "",
  };
  $("race-mode").textContent = opts.mode === "live" ? "LIVE" : "GHOST";
  $("race-mode").className = opts.mode === "live" ? "tag tag-live" : "tag";
  $("race-round").textContent = `Round ${round}`;
  $("you-m").textContent = "0 m";
  $("ham-m").textContent = "0 m";
  show("race");
  window.addEventListener("devicemotion", onMotion);
  if (SIM) startSim();
  keepAwake();
  race.timer = setInterval(tick, 250);
  if (opts.mode === "live") race.poller = setInterval(pollLive, 5000);
  tick();
}

async function pollLive() {
  if (!race || race.done || serverNow() < race.startAt - 6000) return;
  try {
    const j = await (await fetch(`${SQUEEK_API}/v1/status`, { cache: "no-store" })).json();
    const m = j.measurement;
    if (!m || m.freshness !== "online") throw new Error("stale");
    const cum = Number(m.cumulativeWorkUnits);
    if (!race.liveBase || race.liveBase.epoch !== m.counterEpoch) race.liveBase = { epoch: m.counterEpoch, cum };
    race.liveMeters = serverNow() >= race.startAt ? hamsterMeters(cum - race.liveBase.cum, race.circumference) : 0;
    if (m.provenance === "hardware" && m.coreStatus === "ACTIVE") reportCalibration(m);
    race.liveNote = m.coreStatus === "ACTIVE" ? `Running · ${Math.round(m.rpmMilli / 1000)} RPM · provisional` : "Resting · provisional";
  } catch {
    race.liveMeters = null;
    race.liveNote = "Live wheel unavailable. Official result after settlement.";
  }
}

function tick() {
  if (!race || race.done) return;
  const now = serverNow();
  const waiting = now < race.startAt;
  $("race-wait").hidden = !waiting || race.mode !== "live";
  $("race-run").hidden = waiting && race.mode === "live";
  if (waiting) {
    $("wait-clock").textContent = clock((race.startAt - now) / 1000);
    $("race-clock").textContent = clock((race.startAt - now) / 1000);
    $("gap-line").textContent = "Get ready…";
    return;
  }
  const elapsed = Math.min(RACE_SECONDS, (now - race.startAt) / 1000);
  const c = race.counter;
  const you = c.meters;
  const ham = race.mode === "ghost" ? race.ghostMeters * (elapsed / RACE_SECONDS) : race.liveMeters;
  const scale = Math.max(you, ham || 0, race.mode === "ghost" ? race.ghostMeters : 0, 50);
  $("race-clock").textContent = clock(RACE_SECONDS - elapsed);
  $("you-m").textContent = formatMeters(you);
  $("ham-m").textContent = ham === null ? "—" : formatMeters(ham);
  $("you-bar").style.width = `${(you / scale) * 100}%`;
  $("ham-bar").style.width = `${((ham || 0) / scale) * 100}%`;
  $("ham-note").textContent = race.mode === "ghost"
    ? `Ghost of round ${race.round} · his average pace` : race.liveNote;
  $("steps").textContent = c.steps;
  $("cadence").textContent = `${c.cadence(now).toFixed(1)}/s`;
  $("stride").textContent = `${Math.round(strideMeters({ heightCm: race.height, customStrideCm: race.stride, cadence: c.cadence(now) }) * 100)} cm`;
  if (ham !== null && you > 0) {
    const d = you - ham;
    $("gap-line").textContent = Math.abs(d) < 1 ? "Neck and neck!" : d > 0 ? `You lead by ${formatMeters(d)}` : `${formatMeters(-d)} behind a hamster`;
  }
  if (now >= race.endAt) finish();
}

function stopRace() {
  if (!race) return;
  race.done = true;
  clearInterval(race.timer);
  clearInterval(race.poller);
  window.removeEventListener("devicemotion", onMotion);
  race.wakeLock?.release?.().catch(() => {});
}

$("race-quit").addEventListener("click", () => {
  if (!confirm("Quit this race? It will not count.")) return;
  stopRace();
  race = null;
  show("home");
});

document.addEventListener("visibilitychange", () => {
  if (race && !race.done && document.visibilityState === "visible") keepAwake();
});

/* -------------------------------- result --------------------------------- */
async function finish() {
  stopRace();
  const c = race.counter;
  const lastGap = c.lastSampleAt === null ? Infinity : race.endAt - c.lastSampleAt;
  const result = {
    mode: race.mode, round: race.round, nickname: race.nickname,
    meters: c.meters, steps: c.steps, durationSec: RACE_SECONDS,
    incomplete: c.incomplete() || lastGap > 30000, sim: SIM,
  };
  $("result-mode").textContent = race.mode === "live" ? "LIVE" : "GHOST";
  $("result-mode").className = race.mode === "live" ? "tag tag-live" : "tag";
  $("result-round").textContent = `Round ${race.round}`;
  show("result");

  if (race.mode === "ghost") {
    showFinal(result, race.ghostMeters, race.txHash);
    return;
  }
  $("result-final").hidden = true;
  $("result-wait").hidden = false;
  $("wait-you").textContent = formatMeters(result.meters);
  const started = Date.now();
  const poll = async () => {
    try {
      const j = await (await fetch(`/api/round?r=${result.round}`)).json();
      if (j.state === "settled" && Number.isFinite(j.meters)) return showFinal(result, j.meters, j.txHash);
      $("wait-detail").textContent = "Still settling. This page will update by itself.";
    } catch {
      $("wait-detail").textContent = "Could not reach Squeekchain. Retrying…";
    }
    if (Date.now() - started < 2 * 3600e3) setTimeout(poll, 20000);
    else $("wait-detail").textContent = "Settlement is taking unusually long. Your result is pending; check back later.";
  };
  setTimeout(poll, 15000);
}

async function showFinal(result, hamM, txHash) {
  $("result-wait").hidden = true;
  $("result-final").hidden = false;
  const v = verdict(result.meters, hamM);
  const title = v.kind === "asleep" ? "You beat a sleeping hamster"
    : v.kind === "tie" ? "Dead heat"
    : v.winner === "player" ? `You outran Squeektoshi by ${formatMeters(v.margin)}`
    : `Squeektoshi wins by ${formatMeters(-v.margin)}`;
  $("verdict").textContent = title;
  $("quip").textContent = commentary(v, result.round + Math.round(result.meters));

  const proof = $("proof");
  proof.replaceChildren(`Hamster: ${formatMeters(hamM)} in round ${result.round}`);
  if (txHash) {
    const a = document.createElement("a");
    a.href = `https://sepolia.etherscan.io/tx/${txHash}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "settlement transaction";
    proof.append(" · ", a);
  }

  await drawCard(result, hamM, title);
  const text = v.winner === "player"
    ? `I outran Squeektoshi the hamster by ${formatMeters(v.margin)} 🐹🏃 Round ${result.round}, settled on Ethereum.`
    : `A hamster beat me by ${formatMeters(Math.abs(v.margin))} 🐹 Squeektoshi, round ${result.round}. Can you outrun him?`;
  $("share-x").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin)}`;

  const status = $("submit-status");
  if (result.sim) { status.textContent = "Practice run (simulated). Not sent to the leaderboard."; return; }
  if (result.incomplete) { status.textContent = "The sensor paused during the run, so it is not ranked."; return; }
  status.textContent = "Saving to the leaderboard…";
  try {
    const res = await fetch("/api/scores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...result, deviceId }),
    });
    const j = await res.json();
    status.textContent = res.ok
      ? (j.flagged ? "Saved, but hidden from the leaderboard as implausible." : "Saved to the leaderboard.")
      : j.error || "Could not save this run.";
    loadBoard();
  } catch {
    status.textContent = "Could not reach the leaderboard.";
  }
}

async function drawCard(result, hamM, title) {
  await document.fonts?.ready;
  const cv = $("card");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.fillStyle = "#0a0c0b";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1a201d";
  for (let x = 7; x < W; x += 14) for (let y = 7; y < H; y += 14) { ctx.beginPath(); ctx.arc(x, y, 1.3, 0, 7); ctx.fill(); }

  ctx.fillStyle = "#ffb547";
  ctx.font = "700 30px 'Space Mono', monospace";
  ctx.fillText("HAMSTER RACE", 64, 92);
  ctx.fillStyle = "#eef3ef";
  ctx.font = "700 60px 'Space Grotesk', sans-serif";
  wrap(ctx, title, 64, 178, 760, 68);

  const max = Math.max(result.meters, hamM, 1);
  const bar = (y, label, m, color) => {
    ctx.fillStyle = "#8b968f";
    ctx.font = "500 28px 'Space Grotesk', sans-serif";
    ctx.fillText(label, 64, y);
    ctx.fillStyle = color;
    ctx.font = "700 40px 'Space Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(formatMeters(m), 1136, y);
    ctx.textAlign = "left";
    ctx.fillStyle = "#121614";
    roundRect(ctx, 64, y + 18, 1072, 26, 13);
    ctx.fillStyle = color;
    roundRect(ctx, 64, y + 18, Math.max(26, (m / max) * 1072), 26, 13);
  };
  bar(380, result.nickname || "You", result.meters, "#5ef0a8");
  bar(480, "Squeektoshi", hamM, "#ffb547");

  ctx.fillStyle = "#8b968f";
  ctx.font = "400 24px 'Space Mono', monospace";
  ctx.fillText(`${result.mode === "live" ? "Live" : "Ghost"} race · round ${result.round} · settled on Ethereum Sepolia`, 64, 610);
  ctx.fillText(location.host, 64, 645);
  drawSprite(ctx, 900, 40, 13);
}

function wrap(ctx, text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, y); line = w; y += lh; }
    else line = test;
  }
  ctx.fillText(line, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}

$("save-card").addEventListener("click", () => {
  $("card").toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hamster-race.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
});

$("again").addEventListener("click", () => { race = null; show("home"); loadRounds(); });

/* --------------------------------- boot ---------------------------------- */
drawSprite($("hero-hamster").getContext("2d"), 16, 16, 8);
$("site-host").textContent = location.host;
$("desktop-note").hidden = SIM || "ontouchstart" in window || navigator.maxTouchPoints > 0;
loadRounds();
loadBoard();
setInterval(tickCountdown, 1000);
setInterval(() => { if (!race) loadRounds(); }, 60000);
// While the wheel is not calibrated yet, check it more often so a short run is not missed.
setInterval(async () => {
  if (race || data?.circumference?.mm) return;
  const live = await browserLive(); // also feeds calibration readings
  if (live && data) { data.live = live; renderLive(); }
  // Pick up the calibration once the server has it.
  if (Date.now() - lastCalibrationReport < 20000) setTimeout(() => { if (!race) loadRounds(); }, 5000);
}, 10000);
