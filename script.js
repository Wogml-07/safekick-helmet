// =====================================================
//  세이프킥 헬멧 인증 대여 시뮬레이터
// =====================================================

// ----- 1. 설정값 (여기만 바꾸면 돼요) -----

// 티처블 머신에서 [모델 업로드] 후 받은 주소를 넣으세요.
// 비워 두면 버튼으로 흉내 내는 "개발자 모드"로만 동작해요.
// 예) "https://teachablemachine.withgoogle.com/models/AbCdEf123/"
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/YsfzHJrai/";

// 티처블 머신에서 정한 클래스 이름과 글자 하나까지 똑같아야 해요.
const HELMET_CLASS = "헬멧 착용";

// [대여 전 인증]
const PASS_PROBABILITY = 0.7;   // 이 확률 이상이어야 "착용"으로 인정
const SMOOTH_SECONDS = 0.4;     // 확률을 이 시간만큼 평균 내서 판단 (순간적으로 튀는 값 무시)
const PASS_SECONDS = 3;         // 착용 상태가 이만큼 연속으로 유지되면 통과 (재시동도 같음)
const TIME_LIMIT_SECONDS = 60;  // 이 시간 안에 통과 못 하면 실패

// [주행 중 확인]
const RIDE_GRACE_SECONDS = 2;   // 헬멧이 이만큼 연속으로 안 보이면 경고 시작 (잠깐 가려진 건 무시)
const SHUTDOWN_SECONDS = 10;    // 경고 후 이 시간 안에 다시 안 쓰면 시동 꺼짐

// [화면 표시]
const DISPLAY_STEP = 10;        // 확률을 이 단위(%)로 끊어서 보여 줌
const DISPLAY_INTERVAL_MS = 500; // 확률 숫자를 바꾸는 간격 (0.5초에 한 번)

const UNLOCK_FEE = 1000;        // 잠금 해제 요금(원)
const FEE_PER_MINUTE = 150;     // 분당 요금(원)

// 화면에 보여 줄 가상의 킥보드
const KICKBOARDS = [
  { id: "TT-0412", battery: 82, distance: 120, rangeKm: 24 },
  { id: "TT-1087", battery: 54, distance: 260, rangeKm: 15 },
  { id: "TT-2231", battery: 28, distance: 410, rangeKm: 8 },
];


// ----- 2. 앱이 기억하는 상태 -----

const hasModel = MODEL_URL.trim() !== "";  // 모델 주소를 넣었는지

// 개발자 모드: 카메라·AI 대신 버튼으로 헬멧 착용 여부를 흉내 내요.
// 시작 화면의 스위치로 켜고 끌 수 있고, 모델 주소가 비어 있으면 항상 켜져 있어요.
let devMode = !hasModel;

let selectedBoard = null;  // 고른 킥보드
let model = null;          // 불러온 AI 모델 (한 번만 불러옴)
let webcam = null;         // 카메라
let camBox = null;         // 지금 카메라(또는 개발자 모드 그림)를 보여 주는 칸
let demoWearing = false;   // 개발자 모드에서 "헬멧 쓴 상태"를 골랐는지

// 대여 전 인증
let checkStartTime = 0;
let wearingSince = null;   // "착용" 상태가 시작된 시각 (끊기면 null)

// 주행
let rideStartTime = 0;
let rideTimer = null;
let rideState = "on";      // "on"(정상) / "warning"(경고) / "off"(시동 꺼짐)
let missingSince = null;   // 헬멧이 안 보이기 시작한 시각
let warningStartTime = 0;
let warningCount = 0;
let shutdownCount = 0;

const $ = (id) => document.getElementById(id);


// ----- 3. 화면 넘기기 -----

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.hidden = screen.id !== "screen-" + name;
  });
  window.scrollTo(0, 0);

  // 대여 전 화면으로 돌아가면 카메라 끄기
  if (name === "home" || name === "detail") {
    stopLoop();
    stopCamera();
  }
}

// data-go="화면이름" 이 붙은 버튼은 누르면 그 화면으로 이동
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.go));
});


// ----- 4. 카메라 + AI 판단 (인증과 주행이 함께 씀) -----

// 모델 불러오기 — 사이트가 열리자마자 미리 시작하고, 한 번만 불러와요
let modelPromise = null;
function loadModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const base = MODEL_URL.trim().endsWith("/") ? MODEL_URL.trim() : MODEL_URL.trim() + "/";
    const loaded = await tmImage.load(base + "model.json", base + "metadata.json");

    const labels = loaded.getClassLabels();
    if (!labels.includes(HELMET_CLASS)) {
      throw new Error(`모델에 "${HELMET_CLASS}" 클래스가 없어요. 모델의 클래스: ${labels.join(", ")}`);
    }

    // 예열: 첫 판단은 준비 시간이 길어서, 빈 그림으로 한 번 미리 판단해 둬요
    const blank = document.createElement("canvas");
    blank.width = 224;
    blank.height = 224;
    await loaded.predict(blank);

    model = loaded;
  })();
  modelPromise.catch(() => { modelPromise = null; }); // 실패하면 다음에 다시 시도
  return modelPromise;
}

// 카메라 켜기 — 앞 카메라, 좌우 반전(거울처럼)
// [대여하기]를 누르는 순간 미리 켜 두고, 인증·주행이 끝날 때까지 계속 써요
let cameraPromise = null;
let cameraToken = 0;
function startCamera() {
  if (cameraPromise) return cameraPromise;
  const myToken = ++cameraToken;
  cameraPromise = (async () => {
    const cam = new tmImage.Webcam(320, 320, true);
    await cam.setup({ facingMode: "user" });
    cam.webcam.setAttribute("playsinline", ""); // 아이폰에서 필요
    cam.webcam.muted = true;
    await cam.play();
    if (myToken !== cameraToken) {   // 켜지는 사이에 대여를 취소했으면 바로 끄기
      cam.stop();
      throw new Error("카메라 준비가 취소됐어요.");
    }
    webcam = cam;
  })();
  cameraPromise.catch(() => {
    if (myToken === cameraToken) cameraPromise = null; // 실패하면 다음에 다시 시도
  });
  return cameraPromise;
}

function stopCamera() {
  cameraToken++;
  cameraPromise = null;
  if (webcam) {
    webcam.stop();
    webcam = null;
  }
}

// 카메라 화면(또는 개발자 모드 그림)을 어느 칸에 보여 줄지 정하기
function showCameraIn(box) {
  camBox = box;
  box.innerHTML = "";
  if (devMode) {
    box.innerHTML = demoFace(demoWearing);
  } else if (webcam) {
    box.appendChild(webcam.canvas);
  }
}

// 지금 화면이 "헬멧 착용"일 확률 (0 ~ 1)
async function getHelmetProbability() {
  if (devMode) {
    return demoWearing ? 0.9 + Math.random() * 0.08 : 0.05 + Math.random() * 0.1;
  }
  webcam.update();
  const predictions = await model.predict(webcam.canvas);
  const helmet = predictions.find((p) => p.className === HELMET_CLASS);
  return helmet ? helmet.probability : 0;
}

// 1초에 수십 번 판단을 반복하는 장치.
// startLoop(할일) 하면 판단 결과가 나올 때마다 "할일"을 실행해요.
let loopId = 0;
function startLoop(onResult) {
  const myId = ++loopId;
  async function tick() {
    if (myId !== loopId) return;              // 다른 반복이 시작됐거나 멈췄으면 끝
    const rawProbability = await getHelmetProbability();
    if (myId !== loopId) return;
    const now = performance.now();
    onResult(smooth(rawProbability, now), now); // 평균 낸 확률로 판단해요
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function stopLoop() {
  loopId++;
}

// 확률 평균 내기 — AI의 확률은 한 장면마다 크게 흔들려요.
// 한순간 낮게 나왔다고 처음부터 다시 세지 않도록,
// 최근 SMOOTH_SECONDS 동안의 값을 섞은 평균으로 판단해요.
let smoothProbability = 0;
let lastSmoothTime = 0;
function smooth(rawProbability, now) {
  const seconds = lastSmoothTime ? (now - lastSmoothTime) / 1000 : Infinity;
  lastSmoothTime = now;
  const weight = 1 - Math.exp(-seconds / SMOOTH_SECONDS); // 새 값을 얼마나 반영할지
  smoothProbability += (rawProbability - smoothProbability) * weight;
  return smoothProbability;
}

// 화면에 보여 줄 확률(%) — 10% 단위로 끊고, 0.5초에 한 번만 숫자를 바꿔요.
let shownPercent = 0;
let lastShownTime = 0;

function resetDisplay() {
  smoothProbability = 0;
  lastSmoothTime = 0;
  shownPercent = 0;
  lastShownTime = 0;
}

function displayPercent(probability, now) {
  if (now - lastShownTime >= DISPLAY_INTERVAL_MS) {
    shownPercent = Math.round((probability * 100) / DISPLAY_STEP) * DISPLAY_STEP;
    lastShownTime = now;
  }
  return shownPercent;
}


// ----- 5. ① 시작 화면: 킥보드 목록 -----

function renderBoardList() {
  const list = $("board-list");
  list.innerHTML = "";

  KICKBOARDS.forEach((board, index) => {
    const item = document.createElement("li");
    item.innerHTML = `
      <button class="board" type="button">
        <span class="board-num">${index + 1}</span>
        <span>
          <span class="board-name">${board.id}</span><br>
          <span class="board-meta">${board.distance}m 거리 · 배터리 ${board.battery}%</span>
        </span>
        <span class="battery ${board.battery < 30 ? "low" : ""}">
          <span style="width:${board.battery}%"></span>
        </span>
      </button>`;
    item.querySelector("button").addEventListener("click", () => openDetail(board));
    list.appendChild(item);
  });
}


// ----- 6. ② 킥보드 정보 화면 -----

function openDetail(board) {
  selectedBoard = board;
  $("detail-id").textContent = board.id;
  $("detail-battery").textContent = board.battery + "%";
  $("detail-range").textContent = board.rangeKm + "km";
  $("detail-unlock").textContent = won(UNLOCK_FEE);
  $("detail-perMin").textContent = "분당 " + won(FEE_PER_MINUTE);
  showScreen("detail");
}


// ----- 7. ④ 대여 전 헬멧 인증 -----

$("btn-start-check").addEventListener("click", startCheck);
$("btn-retry").addEventListener("click", startCheck);
$("btn-cancel-check").addEventListener("click", () => {
  stopLoop(); // 카메라는 켜 둔 채로 안내 화면으로 (다시 시작할 때 바로 켜지게)
  showScreen("guide");
});

// [대여하기]를 누르면 안내 화면을 읽는 동안 카메라를 미리 켜 둬요
document.querySelector('#screen-detail [data-go="guide"]').addEventListener("click", () => {
  if (!devMode) startCamera().catch(() => {}); // 오류는 [인증 시작] 때 화면에 보여 줘요
});

async function startCheck() {
  showScreen("check");
  $("cam-box").classList.remove("ok");
  resetDisplay();
  updateCheckScreen(0, 0, 0, 0);

  if (devMode) {
    setDemoWearing(false);
  } else {
    try {
      if (!model || !webcam) setStatus("AI 모델과 카메라를 준비하는 중이에요...");
      await Promise.all([loadModel(), startCamera()]); // 이미 준비됐으면 바로 넘어가요
    } catch (error) {
      stopCamera();
      const message = error && error.message ? error.message : String(error);
      setStatus("시작하지 못했어요: " + message, "no");
      return;
    }
  }

  showCameraIn($("cam-box"));
  wearingSince = null;
  checkStartTime = performance.now();
  startLoop(onCheckResult);
}

function onCheckResult(probability, now) {
  // 기준 확률 이상이 몇 초째 이어지고 있는지 계산
  if (probability >= PASS_PROBABILITY) {
    if (wearingSince === null) wearingSince = now;
  } else {
    wearingSince = null; // 한 번이라도 떨어지면 처음부터 다시
  }
  const heldSeconds = wearingSince === null ? 0 : (now - wearingSince) / 1000;
  const elapsedSeconds = (now - checkStartTime) / 1000;

  updateCheckScreen(probability, displayPercent(probability, now), heldSeconds, elapsedSeconds);

  if (heldSeconds >= PASS_SECONDS) {
    stopLoop(); // 카메라는 끄지 않고 주행까지 이어서 써요
    $("pass-desc").textContent = `${selectedBoard.id} 킥보드 잠금이 풀렸어요.`;
    showScreen("pass");
  } else if (elapsedSeconds >= TIME_LIMIT_SECONDS) {
    stopLoop(); // 카메라는 켜 둬서 [다시 인증] 때 바로 켜지게
    $("fail-desc").textContent =
      `${TIME_LIMIT_SECONDS}초 안에 헬멧 착용을 확인하지 못했어요. 헬멧을 쓰고 얼굴이 잘 보이게 다시 시도해 주세요.`;
    showScreen("fail");
  }
}

function updateCheckScreen(probability, percent, heldSeconds, elapsedSeconds) {
  $("prob-text").textContent = percent + "%";
  $("prob-fill").style.width = percent + "%";

  const held = Math.min(heldSeconds, PASS_SECONDS);
  $("progress-text").textContent = held.toFixed(1) + " / " + PASS_SECONDS + "초";
  $("progress-fill").style.width = (held / PASS_SECONDS) * 100 + "%";

  const left = Math.max(0, Math.ceil(TIME_LIMIT_SECONDS - elapsedSeconds));
  $("time-left").textContent = "남은 시간 " + left + "초";

  const wearing = probability >= PASS_PROBABILITY;
  $("cam-box").classList.toggle("ok", wearing);
  setStatus(
    wearing ? "헬멧이 보여요. 그대로 있어 주세요." : "헬멧을 쓰고 카메라를 정면으로 봐 주세요.",
    wearing ? "ok" : ""
  );
}

function setStatus(text, kind = "") {
  const status = $("check-status");
  status.textContent = text;
  status.className = "status " + kind;
}


// ----- 8. ⑥ 주행 중 — 계속 헬멧 확인 -----

$("btn-start-ride").addEventListener("click", () => {
  $("ride-id").textContent = selectedBoard.id;

  rideStartTime = Date.now();
  rideState = "on";
  missingSince = null;
  wearingSince = null;
  warningCount = 0;
  shutdownCount = 0;

  updateRideClock();
  rideTimer = setInterval(updateRideClock, 1000);

  showScreen("ride");
  showCameraIn($("ride-cam"));
  renderRideAlert(performance.now());
  startLoop(onRideResult);
});

function onRideResult(probability, now) {
  const wearing = probability >= PASS_PROBABILITY;
  $("ride-prob").textContent = displayPercent(probability, now) + "%";
  $("ride-cam").classList.toggle("ok", wearing);

  if (rideState === "on") {
    // 정상 주행 중: 헬멧이 RIDE_GRACE_SECONDS 동안 안 보이면 경고
    if (wearing) {
      missingSince = null;
    } else {
      if (missingSince === null) missingSince = now;
      if ((now - missingSince) / 1000 >= RIDE_GRACE_SECONDS) {
        rideState = "warning";
        warningStartTime = now;
        warningCount++;
      }
    }
  } else if (rideState === "warning") {
    // 경고 중: 다시 쓰면 정상으로, 시간이 다 되면 시동 꺼짐
    if (wearing) {
      rideState = "on";
      missingSince = null;
    } else if ((now - warningStartTime) / 1000 >= SHUTDOWN_SECONDS) {
      rideState = "off";
      shutdownCount++;
      wearingSince = null;
    }
  } else if (rideState === "off") {
    // 시동 꺼짐: 헬멧을 PASS_SECONDS 동안 쓰고 있으면 다시 시동
    if (wearing) {
      if (wearingSince === null) wearingSince = now;
      if ((now - wearingSince) / 1000 >= PASS_SECONDS) {
        rideState = "on";
        missingSince = null;
      }
    } else {
      wearingSince = null;
    }
  }

  renderRideAlert(now);
}

function renderRideAlert(now) {
  const alertBox = $("ride-alert");
  const badge = $("ride-badge");
  const bar = $("ride-alert-bar");
  const fill = $("ride-alert-fill");

  alertBox.dataset.state = rideState;
  badge.dataset.state = rideState;

  if (rideState === "on") {
    badge.textContent = "주행 중";
    $("ride-alert-title").textContent = "헬멧 착용 중";
    $("ride-alert-text").textContent = "주행 중에도 카메라로 계속 확인해요.";
    bar.hidden = true;
  } else if (rideState === "warning") {
    const elapsed = (now - warningStartTime) / 1000;
    const left = Math.max(0, Math.ceil(SHUTDOWN_SECONDS - elapsed));
    badge.textContent = "경고";
    $("ride-alert-title").textContent = "헬멧을 벗었어요!";
    $("ride-alert-text").textContent = `${left}초 뒤 시동이 꺼져요. 헬멧을 다시 써 주세요.`;
    bar.hidden = false;
    fill.style.width = Math.max(0, 1 - elapsed / SHUTDOWN_SECONDS) * 100 + "%";
  } else {
    const held = wearingSince === null ? 0 : Math.min((now - wearingSince) / 1000, PASS_SECONDS);
    badge.textContent = "시동 꺼짐";
    $("ride-alert-title").textContent = "시동이 꺼졌어요";
    $("ride-alert-text").textContent = `헬멧을 다시 쓰고 ${PASS_SECONDS}초 기다리면 시동이 켜져요.`;
    bar.hidden = false;
    fill.style.width = (held / PASS_SECONDS) * 100 + "%";
  }
}


// ----- 9. ⑦ 반납 -----

$("btn-return").addEventListener("click", () => {
  stopLoop();
  stopCamera();
  clearInterval(rideTimer);

  const seconds = rideSeconds();
  $("done-time").textContent = Math.floor(seconds / 60) + "분 " + (seconds % 60) + "초";
  $("done-fee").textContent = won(rideFee(seconds));
  $("done-warn").textContent = warningCount + "회";
  $("done-off").textContent = shutdownCount + "회";
  showScreen("done");
});

function updateRideClock() {
  const seconds = rideSeconds();
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  $("ride-time").textContent = mm + ":" + ss;
  $("ride-fee").textContent = won(rideFee(seconds));
}

function rideSeconds() {
  return Math.floor((Date.now() - rideStartTime) / 1000);
}

// 잠금 해제 요금 + 시작한 분마다 분당 요금
function rideFee(seconds) {
  return UNLOCK_FEE + Math.ceil(seconds / 60) * FEE_PER_MINUTE;
}


// ----- 10. 개발자 모드 (헬멧 없이 흐름 확인용) -----

const devToggle = $("dev-toggle");

function setDevMode(on) {
  devMode = on || !hasModel;
  devToggle.checked = devMode;
  document.querySelectorAll("[data-demo]").forEach((panel) => {
    panel.hidden = !devMode;
  });
}

devToggle.addEventListener("change", () => setDevMode(devToggle.checked));

if (!hasModel) {
  devToggle.disabled = true;
  $("dev-note").textContent = "AI 모델이 연결되지 않아 개발자 모드로만 동작해요.";
}
setDevMode(false);
document.querySelectorAll(".demo-on").forEach((b) => b.addEventListener("click", () => setDemoWearing(true)));
document.querySelectorAll(".demo-off").forEach((b) => b.addEventListener("click", () => setDemoWearing(false)));

function setDemoWearing(wearing) {
  demoWearing = wearing;
  document.querySelectorAll(".demo-on").forEach((b) => b.setAttribute("aria-pressed", String(wearing)));
  document.querySelectorAll(".demo-off").forEach((b) => b.setAttribute("aria-pressed", String(!wearing)));
  if (camBox) camBox.innerHTML = demoFace(wearing);
}

// 카메라 대신 보여 줄 얼굴 그림
function demoFace(wearing) {
  const helmet = wearing
    ? `<path d="M88 150 C88 88 232 88 232 150 L232 162 L88 162 Z" fill="#F26B1D"/>
       <rect x="80" y="156" width="160" height="12" rx="6" fill="#C9520F"/>
       <path d="M106 166 Q160 326 214 166" fill="none" stroke="#C9520F" stroke-width="4"/>`
    : `<path d="M104 140 C110 104 210 104 216 140 C200 124 120 124 104 140 Z" fill="#3A2A20"/>`;
  return `
    <svg viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" role="img"
         aria-label="${wearing ? "헬멧을 쓴 얼굴" : "헬멧을 쓰지 않은 얼굴"}">
      <rect width="320" height="320" fill="#2A3530"/>
      <path d="M70 320 C80 250 240 250 250 320 Z" fill="#4E6A60"/>
      <ellipse cx="160" cy="180" rx="56" ry="66" fill="#E9C3A0"/>
      <circle cx="140" cy="182" r="5" fill="#2A1E17"/>
      <circle cx="180" cy="182" r="5" fill="#2A1E17"/>
      <path d="M146 214 Q160 224 174 214" fill="none" stroke="#2A1E17" stroke-width="3" stroke-linecap="round"/>
      ${helmet}
    </svg>`;
}


// ----- 11. 공통 도구 -----

function won(amount) {
  return amount.toLocaleString("ko-KR") + "원";
}


// ----- 시작 -----
// 확률 막대의 기준선을 PASS_PROBABILITY 위치에 맞추기
document.querySelector(".bar-line").style.left = PASS_PROBABILITY * 100 + "%";
renderBoardList();
showScreen("home");

// 사이트가 열리자마자 AI 모델을 미리 내려받아 둬요 (킥보드를 고르는 동안 준비)
if (hasModel) loadModel().catch(() => {}); // 오류는 [인증 시작] 때 화면에 보여 줘요
