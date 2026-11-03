// =====================================================
//  세이프킥 헬멧 인증 대여 시뮬레이터
// =====================================================

// ----- 1. 설정값 (여기만 바꾸면 돼요) -----

// 티처블 머신에서 [모델 업로드] 후 받은 주소를 넣으세요.
// 비워 두면 버튼으로 흉내 내는 "시연 모드"로 동작해요.
// 예) "https://teachablemachine.withgoogle.com/models/AbCdEf123/"
const MODEL_URL = "";

// 티처블 머신에서 정한 클래스 이름과 글자 하나까지 똑같아야 해요.
const HELMET_CLASS = "헬멧 착용";

// [대여 전 인증]
const PASS_PROBABILITY = 0.8;   // 이 확률 이상이어야 "착용"으로 인정
const PASS_SECONDS = 3;         // 착용 상태가 이만큼 연속으로 유지되면 통과 (재시동도 같음)
const TIME_LIMIT_SECONDS = 20;  // 이 시간 안에 통과 못 하면 실패

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

const isDemo = MODEL_URL.trim() === "";

let selectedBoard = null;  // 고른 킥보드
let model = null;          // 불러온 AI 모델 (한 번만 불러옴)
let webcam = null;         // 카메라
let camBox = null;         // 지금 카메라(또는 시연 그림)를 보여 주는 칸
let demoWearing = false;   // 시연 모드에서 "헬멧 쓴 상태"를 골랐는지

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
}

// data-go="화면이름" 이 붙은 버튼은 누르면 그 화면으로 이동
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.go));
});


// ----- 4. 카메라 + AI 판단 (인증과 주행이 함께 씀) -----

// 모델 불러오기 — 처음 한 번만
async function loadModel() {
  if (model) return;
  const base = MODEL_URL.endsWith("/") ? MODEL_URL : MODEL_URL + "/";
  model = await tmImage.load(base + "model.json", base + "metadata.json");

  const labels = model.getClassLabels();
  if (!labels.includes(HELMET_CLASS)) {
    model = null;
    throw new Error(`모델에 "${HELMET_CLASS}" 클래스가 없어요. 모델의 클래스: ${labels.join(", ")}`);
  }
}

// 카메라 켜기 — 앞 카메라, 좌우 반전(거울처럼)
async function startCamera() {
  if (webcam) return;
  webcam = new tmImage.Webcam(320, 320, true);
  await webcam.setup({ facingMode: "user" });
  webcam.webcam.setAttribute("playsinline", ""); // 아이폰에서 필요
  webcam.webcam.muted = true;
  await webcam.play();
}

function stopCamera() {
  if (webcam) {
    webcam.stop();
    webcam = null;
  }
}

// 카메라 화면(또는 시연 그림)을 어느 칸에 보여 줄지 정하기
function showCameraIn(box) {
  camBox = box;
  box.innerHTML = "";
  if (isDemo) {
    box.innerHTML = demoFace(demoWearing);
  } else if (webcam) {
    box.appendChild(webcam.canvas);
  }
}

// 지금 화면이 "헬멧 착용"일 확률 (0 ~ 1)
async function getHelmetProbability() {
  if (isDemo) {
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
    const probability = await getHelmetProbability();
    if (myId !== loopId) return;
    onResult(probability, performance.now());
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function stopLoop() {
  loopId++;
}

// 화면에 보여 줄 확률(%) — 덜 흔들리게 다듬기
// 1) 최근 값들을 섞어 평균처럼 부드럽게 만들고
// 2) 10% 단위로 끊고
// 3) 0.5초에 한 번만 숫자를 바꿔요.
// (통과·경고 판단에는 원래 확률을 그대로 써요)
let smoothProbability = 0;
let shownPercent = 0;
let lastShownTime = 0;

function resetDisplay() {
  smoothProbability = 0;
  shownPercent = 0;
  lastShownTime = 0;
}

function displayPercent(probability, now) {
  smoothProbability = smoothProbability * 0.8 + probability * 0.2;
  if (now - lastShownTime >= DISPLAY_INTERVAL_MS) {
    shownPercent = Math.round((smoothProbability * 100) / DISPLAY_STEP) * DISPLAY_STEP;
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
  stopLoop();
  stopCamera();
  showScreen("guide");
});

async function startCheck() {
  showScreen("check");
  $("cam-box").classList.remove("ok");
  resetDisplay();
  updateCheckScreen(0, 0, 0, 0);

  if (isDemo) {
    setDemoWearing(false);
  } else {
    try {
      setStatus("AI 모델을 불러오는 중이에요...");
      await loadModel();
      setStatus("카메라를 켜는 중이에요...");
      await startCamera();
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
  // 80% 이상이 몇 초째 이어지고 있는지 계산
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
    stopLoop();
    stopCamera();
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


// ----- 10. 시연 모드 (모델 연결 전 흐름 확인용) -----

document.querySelectorAll("[data-demo]").forEach((panel) => {
  panel.hidden = !isDemo;
});
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
renderBoardList();
showScreen("home");
