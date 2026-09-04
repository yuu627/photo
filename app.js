/* =========================================================
 * バーコード連動レシート写真システム（試作） - app.js
 * PCカメラでバーコードを読み取り、対応表から写真を引いて
 * レシート印字イメージ（canvas）を生成・確認するためのロジック。
 * ========================================================= */

(() => {
  "use strict";

  /* ---------- タブ切り替え ---------- */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "mapping") renderMappingTable();
    });
  });

  /* ---------- 状態 ---------- */
  let tempMap = [];   // このセッション内で登録した一時対応（ブラウザに保存され、リロードしても残る）
  let history = [];   // 確定済みスキャン履歴
  let codeReader = null;
  let scanning = false;
  let paused = false;
  let currentMatch = null; // 直近マッチしたエントリ { barcode, photos: [...], label }
  let previewReceiptNo = null;

  const HISTORY_KEY = "receipt_photo_system_history_v1";
  const TEMPMAP_KEY = "receipt_photo_system_tempmap_v1";
  const COUNTER_KEY = "receipt_photo_system_counter_v1";

  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (saved) history = JSON.parse(saved);
  } catch (e) { /* localStorageが使えない環境は無視 */ }

  try {
    const savedTemp = localStorage.getItem(TEMPMAP_KEY);
    if (savedTemp) tempMap = JSON.parse(savedTemp);
  } catch (e) { /* 無視 */ }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      alert("履歴の保存に失敗しました（ブラウザの保存容量の上限に達した可能性があります）。写真の枚数やサイズを減らしてみてください。");
    }
  }

  function saveTempMap() {
    try {
      localStorage.setItem(TEMPMAP_KEY, JSON.stringify(tempMap));
      return true;
    } catch (e) {
      alert("写真の保存に失敗しました（ブラウザの保存容量の上限に達した可能性があります）。写真の枚数を減らすか、本番運用は mapping.js への登録をご利用ください。");
      return false;
    }
  }

  function getCounter() {
    const v = parseInt(localStorage.getItem(COUNTER_KEY) || "0", 10);
    return isNaN(v) ? 0 : v;
  }
  function bumpCounter() {
    const next = getCounter() + 1;
    try { localStorage.setItem(COUNTER_KEY, String(next)); } catch (e) {}
    return next;
  }

  /* ---------- 対応表エントリの正規化（photo単体 / photos配列のどちらにも対応） ---------- */
  function normalize(raw) {
    let photos = [];
    if (Array.isArray(raw.photos) && raw.photos.length) photos = raw.photos.slice();
    else if (raw.photo) photos = [raw.photo];
    return {
      id: raw.id || null,
      barcode: raw.barcode,
      label: raw.label || "",
      photos,
      temp: !!raw.temp,
    };
  }

  /* ---------- 対応表の検索 ---------- */
  function findMapping(barcodeText) {
    const text = (barcodeText || "").trim();
    const t = tempMap.map(normalize).find((m) => m.barcode.trim() === text);
    if (t) return t;
    const m = (window.BARCODE_MAP || []).map(normalize).find((m) => m.barcode.trim() === text);
    return m || null;
  }

  /* =========================================================
   * タブ②: 対応表の一覧表示・一時登録・削除
   * ========================================================= */
  function renderMappingTable() {
    const tbody = document.querySelector("#mappingTable tbody");
    tbody.innerHTML = "";
    const rows = [
      ...(window.BARCODE_MAP || []).map(normalize),
      ...tempMap.map(normalize),
    ];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">登録がありません</td></tr>`;
      return;
    }
    rows.forEach((m) => {
      const tr = document.createElement("tr");
      const thumbsHtml = m.photos.map((src, idx) => `
        <span class="thumb-wrap">
          <img class="thumb" src="${src}" alt="">
          ${m.temp ? `<button class="thumb-del" title="この写真を削除" data-id="${m.id}" data-idx="${idx}">×</button>` : ""}
        </span>
      `).join("");
      tr.innerHTML = `
        <td><div class="thumb-row">${thumbsHtml || "（写真なし）"}</div></td>
        <td>${escapeHtml(m.barcode)}</td>
        <td>${escapeHtml(m.label || "")}</td>
        <td>
          ${m.temp ? '<span class="tag temp">一時登録</span>' : '<span class="tag">mapping.js</span>'}
          ${m.temp ? `<button class="entry-del" data-id="${m.id}" title="この登録をまとめて削除">登録を削除</button>` : ""}
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".thumb-del").forEach((btn) => {
      btn.addEventListener("click", () => removeTempPhoto(btn.dataset.id, parseInt(btn.dataset.idx, 10)));
    });
    tbody.querySelectorAll(".entry-del").forEach((btn) => {
      btn.addEventListener("click", () => removeTempEntry(btn.dataset.id));
    });
  }

  function removeTempEntry(id) {
    if (!confirm("この一時登録を削除しますか？（写真も削除されます）")) return;
    tempMap = tempMap.filter((m) => m.id !== id);
    saveTempMap();
    renderMappingTable();
  }

  function removeTempPhoto(id, idx) {
    const entry = tempMap.find((m) => m.id === id);
    if (!entry) return;
    entry.photos.splice(idx, 1);
    if (entry.photos.length === 0) {
      tempMap = tempMap.filter((m) => m.id !== id);
    }
    saveTempMap();
    renderMappingTable();
  }

  function genId() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 画像を縮小してdataURLに変換（localStorageの容量節約のため） */
  function resizeImageFileToDataURL(file, maxDim, quality) {
    maxDim = maxDim || 1000;
    quality = quality || 0.85;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w >= h) { h = Math.round((h * maxDim) / w); w = maxDim; }
            else { w = Math.round((w * maxDim) / h); h = maxDim; }
          }
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          try {
            resolve(c.toDataURL("image/jpeg", quality));
          } catch (e) { reject(e); }
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  document.getElementById("tempAddBtn").addEventListener("click", async () => {
    const barcode = document.getElementById("tempBarcode").value.trim();
    const label = document.getElementById("tempLabel").value.trim();
    const fileInput = document.getElementById("tempPhoto");
    if (!barcode) { alert("バーコード値を入力してください。"); return; }
    if (!fileInput.files || fileInput.files.length === 0) { alert("写真ファイルを選択してください（複数選択可）。"); return; }

    const addBtn = document.getElementById("tempAddBtn");
    addBtn.disabled = true;
    addBtn.textContent = "処理中…";
    try {
      const files = Array.from(fileInput.files);
      const photos = await Promise.all(files.map((f) => resizeImageFileToDataURL(f)));
      tempMap.push({ id: genId(), barcode, label, photos, temp: true });
      const ok = saveTempMap();
      renderMappingTable();
      document.getElementById("tempBarcode").value = "";
      document.getElementById("tempLabel").value = "";
      fileInput.value = "";
      if (ok) alert(`一時登録しました（写真${photos.length}枚）。①のタブでバーコード「${barcode}」を読み取ると表示されます。`);
    } catch (e) {
      alert("写真の読み込みに失敗しました: " + e.message);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "登録する";
    }
  });

  document.getElementById("tempClearAllBtn").addEventListener("click", () => {
    if (tempMap.length === 0) return;
    if (!confirm("一時登録をすべて削除しますか？")) return;
    tempMap = [];
    saveTempMap();
    renderMappingTable();
  });

  renderMappingTable();

  /* =========================================================
   * タブ①: カメラ / バーコードスキャン
   * ========================================================= */
  const videoEl = document.getElementById("camera");
  const cameraSelect = document.getElementById("cameraSelect");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const scanStatus = document.getElementById("scanStatus");

  function setStatus(msg, kind) {
    scanStatus.textContent = msg;
    scanStatus.className = "status-line" + (kind ? " " + kind : "");
  }

  function buildCodeReader() {
    const hints = new Map();
    const F = ZXing.BarcodeFormat;
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.CODABAR, F.ITF,
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return new ZXing.BrowserMultiFormatReader(hints);
  }

  async function populateCameraList() {
    try {
      const devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
      cameraSelect.innerHTML = "";
      devices.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `カメラ ${i + 1}`;
        cameraSelect.appendChild(opt);
      });
      return devices;
    } catch (e) {
      setStatus("カメラ一覧の取得に失敗しました: " + e.message, "err");
      return [];
    }
  }

  async function startScanning() {
    startBtn.disabled = true;
    setStatus("カメラを起動しています…");
    try {
      codeReader = buildCodeReader();
      const devices = await populateCameraList();
      const deviceId = cameraSelect.value || (devices[0] && devices[0].deviceId);
      scanning = true;
      paused = false;

      const onDecode = (result, err) => {
        if (result && !paused) {
          handleDecoded(result.getText());
        }
        // NotFoundExceptionは「今のフレームでは見つからなかった」だけなので無視してよい
      };

      // 解像度を明示的に高めに指定すると、バーコードの読み取り精度が上がりやすい。
      // 対応していない環境向けに、失敗時は従来の指定なし方式にフォールバックする。
      const constraints = {
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      };
      try {
        if (typeof codeReader.decodeFromConstraints === "function") {
          await codeReader.decodeFromConstraints(constraints, videoEl, onDecode);
        } else {
          await codeReader.decodeFromVideoDevice(deviceId || undefined, videoEl, onDecode);
        }
      } catch (e2) {
        await codeReader.decodeFromVideoDevice(deviceId || undefined, videoEl, onDecode);
      }

      setStatus("読み取り中です。バーコードをカメラに向けてください。", "ok");
      stopBtn.disabled = false;
    } catch (e) {
      setStatus("カメラを起動できませんでした: " + e.message + "（ブラウザのカメラ許可設定をご確認ください）", "err");
      startBtn.disabled = false;
    }
  }

  function stopScanning() {
    if (codeReader) {
      try { codeReader.reset(); } catch (e) {}
    }
    scanning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus("カメラを停止しました。");
  }

  startBtn.addEventListener("click", startScanning);
  stopBtn.addEventListener("click", stopScanning);
  cameraSelect.addEventListener("change", () => {
    if (scanning) { stopScanning(); startScanning(); }
  });

  let lastDecodedText = null;
  let cooldownTimer = null;

  function handleDecoded(text) {
    if (text === lastDecodedText) return; // 直前と同じ検出は連続無視（confirm/retryでリセットされる）
    lastDecodedText = text;
    paused = true;

    const match = findMapping(text);
    if (!match) {
      setStatus(`未登録のバーコードです（値: "${text}"）。②の対応表タブで登録してください。`, "warn");
      // 3秒後に自動で再開して読み取りを続ける
      clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => { paused = false; lastDecodedText = null; setStatus("読み取り中です。バーコードをカメラに向けてください。", "ok"); }, 3000);
      return;
    }

    currentMatch = { barcode: text, photos: match.photos, label: match.label || "" };
    setStatus(`バーコード "${text}" を読み取りました（写真${match.photos.length}枚）。プレビューを確認してください。`, "ok");
    previewReceiptNo = getCounter() + 1;
    renderReceiptPreview(currentMatch);
  }

  /* ---------- レシート画像の生成（感熱レシート風デザイン） ---------- */
  const receiptCanvas = document.getElementById("receiptCanvas");
  const receiptWrap = document.getElementById("receiptWrap");
  const receiptEmptyHint = document.getElementById("receiptEmptyHint");

  /*
   * 相対パスの写真ファイルを、そのままcanvasに描画してtoDataURL()すると
   * Chromeの仕様で「Tainted canvases may not be exported」エラーになり、
   * PNG保存やグレースケール/白黒2値表示ができなくなることがある。
   * これを避けるため、photos-data.js（tools/build_photos_data.pyで生成）に
   * 埋め込まれたbase64データがあればそちらを優先して使う。
   * 一時登録（アップロード）の写真はもともとdataURLなのでそのまま使う。
   */
  function resolvePhotoSrc(src) {
    if (!src) return src;
    if (src.startsWith("data:")) return src;
    if (window.PHOTO_DATA && window.PHOTO_DATA[src]) return window.PHOTO_DATA[src];
    return src;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // ローカル(file://)の相対パス画像・dataURLはページと同一オリジン扱いなので
      // crossOrigin指定は不要(指定すると逆に読み込みに失敗する環境がある)
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = resolvePhotoSrc(src);
    });
  }

  function guessBarcodeFormat(value) {
    if (/^\d{13}$/.test(value)) return "EAN13";
    if (/^\d{12}$/.test(value)) return "UPC";
    if (/^\d{8}$/.test(value)) return "EAN8";
    return "CODE128";
  }

  function makeBarcodeCanvas(value) {
    const c = document.createElement("canvas");
    const fmt = guessBarcodeFormat(value);
    try {
      JsBarcode(c, value, { format: fmt, displayValue: false, margin: 0, height: 50, width: 2 });
    } catch (e) {
      try {
        JsBarcode(c, value, { format: "CODE128", displayValue: false, margin: 0, height: 50, width: 2 });
      } catch (e2) { return null; }
    }
    return c;
  }

  function applyPrintMode(ctx, w, h, mode) {
    if (mode === "color") return;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (mode === "gray") {
        d[i] = d[i + 1] = d[i + 2] = lum;
      } else if (mode === "mono") {
        const v = lum > 150 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function drawDashedLine(ctx, x1, x2, y, dash) {
    ctx.save();
    ctx.setLineDash(dash || [3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#888";
    ctx.beginPath();
    ctx.moveTo(x1, y + 0.5);
    ctx.lineTo(x2, y + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /* 上下端をギザギザ（ミシン目で切り取ったレシート風）にする */
  function cutZigzagEdge(ctx, width, height, edge, toothWidth, depth) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    const teeth = Math.ceil(width / toothWidth) + 1;
    if (edge === "top") {
      ctx.moveTo(0, 0);
      for (let i = 0; i <= teeth; i++) {
        ctx.lineTo(i * toothWidth, i % 2 === 0 ? 0 : depth);
      }
      ctx.lineTo(width, 0);
      ctx.closePath();
    } else {
      ctx.moveTo(0, height);
      for (let i = 0; i <= teeth; i++) {
        ctx.lineTo(i * toothWidth, height - (i % 2 === 0 ? 0 : depth));
      }
      ctx.lineTo(width, height);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function formatDate(d) {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function formatReceiptNo(n) {
    return "No. " + String(n).padStart(6, "0");
  }

  async function renderReceiptPreview(match) {
    const paperWidth = parseInt(document.getElementById("paperWidth").value, 10);
    const printMode = document.getElementById("printMode").value;
    const title = document.getElementById("receiptTitle").value || "PHOTO RECEIPT";

    const zz = { tooth: Math.max(10, Math.round(paperWidth * 0.035)), depth: Math.max(5, Math.round(paperWidth * 0.018)) };
    const pad = Math.round(paperWidth * 0.07);
    const innerW = paperWidth - pad * 2;

    let photoImgs;
    try {
      photoImgs = await Promise.all(match.photos.map((src) => loadImage(src)));
    } catch (e) {
      setStatus("写真の読み込みに失敗しました。", "err");
      return;
    }
    if (photoImgs.length === 0) {
      setStatus("この対応表エントリには写真が登録されていません。", "warn");
      return;
    }

    const barcodeCanvas = makeBarcodeCanvas(match.barcode);

    const titleFont = Math.round(paperWidth * 0.058);
    const subFont = Math.round(paperWidth * 0.03);
    const textFont = Math.round(paperWidth * 0.036);
    const smallFont = Math.round(paperWidth * 0.028);
    const captionFont = Math.round(paperWidth * 0.026);
    const lineGap = Math.round(paperWidth * 0.022);

    // 写真ごとのサイズを事前計算
    const maxPhotoH = (photoImgs.length > 1 ? 0.85 : 1.15) * paperWidth;
    const photoSizes = photoImgs.map((img) => {
      let w = innerW, h = (img.height / img.width) * w;
      if (h > maxPhotoH) { h = maxPhotoH; w = (img.width / img.height) * h; }
      return { w, h };
    });

    // ---- 高さを積算してキャンバスサイズを決定 ----
    let y = zz.depth + pad;
    y += titleFont + 4;                       // タイトル
    y += subFont + lineGap;                   // サブタイトル
    y += smallFont + lineGap;                 // 伝票番号・日時
    y += 4;                                   // 区切り線
    y += 8;
    photoSizes.forEach((s, i) => {
      y += s.h;
      y += captionFont + 4;                   // キャプション（枚数表示）
      if (i !== photoSizes.length - 1) y += lineGap;
    });
    y += lineGap + 6;
    if (match.label) y += textFont + 8;       // 商品ラベル
    y += smallFont + 4;                       // バーコード値
    if (barcodeCanvas) y += 42 + lineGap;      // バーコード画像
    y += 4;                                   // 区切り線
    y += pad + zz.depth;

    const canvasH = Math.round(y);
    receiptCanvas.width = paperWidth;
    receiptCanvas.height = canvasH;
    const ctx = receiptCanvas.getContext("2d");

    // 用紙背景
    ctx.fillStyle = "#fdfdf6";
    ctx.fillRect(0, 0, paperWidth, canvasH);

    ctx.textAlign = "center";
    ctx.fillStyle = "#1a1a1a";

    let cy = zz.depth + pad;

    // タイトル（モノスペース・太字）
    ctx.font = `bold ${titleFont}px "Courier New", monospace`;
    cy += titleFont;
    ctx.fillText(title.toUpperCase(), paperWidth / 2, cy);

    // サブタイトル
    ctx.font = `${subFont}px "Courier New", monospace`;
    ctx.fillStyle = "#555";
    cy += subFont + lineGap;
    ctx.fillText("PHOTO RECEIPT SYSTEM", paperWidth / 2, cy);

    // 伝票番号・日時
    const now = new Date();
    ctx.font = `${smallFont}px "Courier New", monospace`;
    ctx.fillStyle = "#333";
    cy += smallFont + lineGap;
    ctx.fillText(`${formatReceiptNo(previewReceiptNo)}   ${formatDate(now)}`, paperWidth / 2, cy);

    cy += 4;
    drawDashedLine(ctx, pad, paperWidth - pad, cy, [2, 3]);
    cy += 8;

    // 写真（複数枚は縦に並べる）
    ctx.fillStyle = "#1a1a1a";
    photoSizes.forEach((s, i) => {
      const px = (paperWidth - s.w) / 2;
      ctx.save();
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 1, cy - 1, s.w + 2, s.h + 2);
      ctx.drawImage(photoImgs[i], px, cy, s.w, s.h);
      ctx.restore();
      cy += s.h;
      ctx.font = `${captionFont}px "Courier New", monospace`;
      ctx.fillStyle = "#777";
      cy += captionFont + 4;
      const cap = photoSizes.length > 1 ? `PHOTO ${i + 1}/${photoSizes.length}` : "PHOTO";
      ctx.fillText(cap, paperWidth / 2, cy - 2);
      ctx.fillStyle = "#1a1a1a";
      if (i !== photoSizes.length - 1) cy += lineGap;
    });

    cy += lineGap + 2;
    drawDashedLine(ctx, pad, paperWidth - pad, cy, [2, 3]);
    cy += 6;

    // 商品ラベル
    if (match.label) {
      ctx.font = `bold ${textFont}px "Courier New", monospace`;
      ctx.fillStyle = "#111";
      cy += textFont + 4;
      ctx.fillText(match.label, paperWidth / 2, cy);
      cy += 4;
    }

    // バーコード値（*で挟んで印字っぽく）
    ctx.font = `${smallFont}px "Courier New", monospace`;
    ctx.fillStyle = "#333";
    cy += smallFont + 4;
    ctx.fillText(`*${match.barcode}*`, paperWidth / 2, cy);
    cy += 4;

    // バーコード画像（再生成）
    if (barcodeCanvas) {
      const bw = Math.min(innerW, barcodeCanvas.width);
      const bh = 42;
      const bx = (paperWidth - bw) / 2;
      ctx.drawImage(barcodeCanvas, bx, cy, bw, bh);
      cy += bh + lineGap;
    }

    cy += 2;
    drawDashedLine(ctx, pad, paperWidth - pad, cy, [2, 3]);

    // 印字モード（グレースケール／白黒2値）適用
    applyPrintMode(ctx, paperWidth, canvasH, printMode);

    // 上下端をレシートのミシン目風に切り取る（最後に行う）
    cutZigzagEdge(ctx, paperWidth, canvasH, "top", zz.tooth, zz.depth);
    cutZigzagEdge(ctx, paperWidth, canvasH, "bottom", zz.tooth, zz.depth);

    receiptEmptyHint.style.display = "none";
    receiptWrap.style.display = "flex";
  }

  ["paperWidth", "printMode", "receiptTitle"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      if (currentMatch) renderReceiptPreview(currentMatch);
    });
  });

  /* ---------- 確定 / やり直し / ダウンロード ---------- */
  document.getElementById("confirmBtn").addEventListener("click", () => {
    if (!currentMatch) return;
    const no = bumpCounter();
    history.unshift({
      no,
      time: formatDate(new Date()),
      barcode: currentMatch.barcode,
      label: currentMatch.label,
      photos: currentMatch.photos,
    });
    history = history.slice(0, 100);
    saveHistory();
    renderHistory();
    setStatus("履歴に記録しました。次のバーコードを読み取れます。", "ok");
    resetForNextScan();
  });

  document.getElementById("retryBtn").addEventListener("click", () => {
    setStatus("読み取り中です。バーコードをカメラに向けてください。", "ok");
    resetForNextScan();
  });

  document.getElementById("downloadBtn").addEventListener("click", () => {
    if (!currentMatch) return;
    const link = document.createElement("a");
    link.download = `receipt_${currentMatch.barcode}.png`;
    link.href = receiptCanvas.toDataURL("image/png");
    link.click();
  });

  // iPhoneのSafariなどdownload属性が効かない環境向けの保存手段。
  // 新しいタブに画像だけを表示するので、長押しして「写真に追加/画像を保存」で保存できる。
  document.getElementById("openInTabBtn").addEventListener("click", () => {
    if (!currentMatch) return;
    const dataUrl = receiptCanvas.toDataURL("image/png");
    const w = window.open("", "_blank");
    if (!w) {
      alert("新しいタブを開けませんでした。ブラウザのポップアップブロック設定をご確認ください。");
      return;
    }
    w.document.write(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>レシート画像</title></head><body style="margin:0;background:#f4f5f7;display:flex;justify-content:center;padding:16px;"><img src="${dataUrl}" style="max-width:100%;height:auto;" alt="receipt"><p style="position:fixed;bottom:10px;left:0;right:0;text-align:center;font-family:sans-serif;font-size:13px;color:#666;">画像を長押しして「写真に追加」または「画像を保存」を選んでください</p></body></html>`);
    w.document.close();
  });

  function resetForNextScan() {
    receiptWrap.style.display = "none";
    receiptEmptyHint.style.display = "block";
    currentMatch = null;
    previewReceiptNo = null;
    lastDecodedText = null;
    paused = false;
  }

  /* ---------- 履歴描画 ---------- */
  function renderHistory() {
    const tbody = document.querySelector("#historyTable tbody");
    const emptyEl = document.getElementById("historyEmpty");
    tbody.innerHTML = "";
    if (history.length === 0) { emptyEl.style.display = "block"; return; }
    emptyEl.style.display = "none";
    history.forEach((h) => {
      const tr = document.createElement("tr");
      const photos = h.photos || (h.photoUrl ? [h.photoUrl] : []);
      const badge = photos.length > 1 ? `<span class="tag" style="margin-left:4px;">+${photos.length - 1}</span>` : "";
      tr.innerHTML = `
        <td><div class="thumb-row" style="align-items:center;"><img class="thumb" src="${photos[0] || ""}" alt="">${badge}</div></td>
        <td>${h.no ? formatReceiptNo(h.no) : ""}</td>
        <td>${escapeHtml(h.time)}</td>
        <td>${escapeHtml(h.barcode)}</td>
        <td>${escapeHtml(h.label || "")}</td>
      `;
      tbody.appendChild(tr);
    });
  }
  renderHistory();

  /* =========================================================
   * タブ③: テスト用バーコード作成
   * ========================================================= */
  const genCanvas = document.getElementById("genCanvas");
  const genStatus = document.getElementById("genStatus");
  const genDownload = document.getElementById("genDownload");
  const genPrint = document.getElementById("genPrint");

  function generateTestBarcode() {
    const value = document.getElementById("genValue").value.trim();
    const format = document.getElementById("genFormat").value;
    if (!value) { alert("値を入力してください。"); return; }
    try {
      JsBarcode(genCanvas, value, { format, displayValue: true, fontSize: 18, height: 90, margin: 12 });
      genStatus.style.display = "none";
      genDownload.style.display = "inline-block";
      genPrint.style.display = "inline-block";
    } catch (e) {
      genStatus.style.display = "block";
      genStatus.className = "status-line err";
      genStatus.textContent = "バーコードを作成できませんでした。形式と入力値を確認してください（例: EAN-13は12〜13桁の数字）。";
      genDownload.style.display = "none";
      genPrint.style.display = "none";
    }
  }

  document.getElementById("genBtn").addEventListener("click", generateTestBarcode);
  document.getElementById("genSample1").addEventListener("click", () => { document.getElementById("genValue").value = "SAMPLE-0001"; document.getElementById("genFormat").value = "CODE128"; generateTestBarcode(); });
  document.getElementById("genSample2").addEventListener("click", () => { document.getElementById("genValue").value = "SAMPLE-0002"; document.getElementById("genFormat").value = "CODE128"; generateTestBarcode(); });
  document.getElementById("genSample3").addEventListener("click", () => { document.getElementById("genValue").value = "SAMPLE-0003"; document.getElementById("genFormat").value = "CODE128"; generateTestBarcode(); });

  genDownload.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "test_barcode.png";
    link.href = genCanvas.toDataURL("image/png");
    link.click();
  });

  genPrint.addEventListener("click", () => {
    const dataUrl = genCanvas.toDataURL("image/png");
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>印刷</title></head><body style="text-align:center; margin-top:40px;"><img src="${dataUrl}"><script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  });

  // 初期表示用に最初のサンプルを一度生成しておく
  generateTestBarcode();

  /* ---------- ユーティリティ ---------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
})();
