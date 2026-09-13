/**
 * ClaimCheck India — frontend controller
 * Manages: intake tabs (GTIN / scan / OFF link / photos+OCR / manual),
 * a shared in-memory "evidence" object, claim selection, and rendering
 * the verdict ledger returned by POST /api/verify.
 */

(() => {
  "use strict";

  // ---------------- Shared state ----------------
  const state = {
    rulesMeta: null,
    claims: [],
    selectedClaimId: null,
    evidence: {           // the product evidence object sent to /api/verify
      physicalState: "solid"
    },
    referenceEvidence: {},
    evidenceImages: [],   // [{fieldname, url, filename}]
    productDisplay: null  // { productName, brand, imageUrl, gtin, source }
  };

  const NUMERIC_FIELD_LABELS = {
    energy_kcal_100g: "Energy (kcal/100g)",
    protein_100g: "Protein (g/100g)",
    fat_100g: "Fat (g/100g)",
    saturatedFat_100g: "Saturated fat (g/100g)",
    transFat_100g: "Trans fat (g/100g)",
    sugar_100g: "Sugar (g/100g)",
    fiber_100g: "Fiber (g/100g)",
    sodium_100g: "Sodium (mg/100g)",
    cholesterol_100g: "Cholesterol (mg/100g)",
    reference_protein_100g: "Reference protein (g/100g)",
    reference_sodium_100g: "Reference sodium (mg/100g)"
  };

  // ---------------- DOM helpers ----------------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function setStatus(el, message, kind) {
    el.textContent = message;
    el.className = "status-line show" + (kind ? ` status-line--${kind}` : "");
  }

  function clearStatus(el) {
    el.className = "status-line";
    el.textContent = "";
  }

  // ---------------- Tabs ----------------
  function initTabs() {
    $$(".tab").forEach(tabBtn => {
      tabBtn.addEventListener("click", () => {
        $$(".tab").forEach(t => t.setAttribute("aria-selected", "false"));
        $$(".tab-panel").forEach(p => p.classList.remove("active"));
        tabBtn.setAttribute("aria-selected", "true");
        $(`[data-tab-panel="${tabBtn.dataset.tab}"]`).classList.add("active");
      });
    });
  }

  // ---------------- Evidence bookkeeping ----------------
  function mergeEvidence(fields) {
    Object.assign(state.evidence, fields);
    refreshEvidenceCount();
    refreshRunButton();
  }

  function refreshEvidenceCount() {
    const filled = Object.entries(state.evidence).filter(([k, v]) => v !== "" && v !== undefined && v !== null).length;
    $("#evidence-count").textContent = `${filled} field${filled === 1 ? "" : "s"} captured`;
  }

  function refreshRunButton() {
    $("#run-check-btn").disabled = !state.selectedClaimId;
  }

  function syncManualFormFromEvidence() {
    const e = state.evidence;
    $("#m-physicalState").value = e.physicalState || "solid";
    $("#m-energy").value = e.energy_kcal_100g ?? "";
    $("#m-protein").value = e.protein_100g ?? "";
    $("#m-fat").value = e.fat_100g ?? "";
    $("#m-satfat").value = e.saturatedFat_100g ?? "";
    $("#m-transfat").value = e.transFat_100g ?? "";
    $("#m-sugar").value = e.sugar_100g ?? "";
    $("#m-fiber").value = e.fiber_100g ?? "";
    $("#m-sodium").value = e.sodium_100g ?? "";
    $("#m-cholesterol").value = e.cholesterol_100g ?? "";
    $("#m-name").value = e.productName ?? "";
    $("#m-ingredients").value = e.ingredientsText ?? "";
  }

  function renderProductSummary() {
    const holder = $("#product-summary");
    const p = state.productDisplay;
    if (!p) { holder.innerHTML = ""; return; }
    holder.innerHTML = `
      <div class="product-card">
        <img src="${p.imageUrl || ''}" onerror="this.style.visibility='hidden'" alt="" />
        <div>
          <div class="product-card__name">${escapeHtml(p.productName || "Unnamed product")}</div>
          <div class="product-card__meta">${escapeHtml(p.brand || "")}${p.brand ? " · " : ""}GTIN ${escapeHtml(p.gtin || "—")} · via ${escapeHtml(p.source || "manual entry")}</div>
        </div>
      </div>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[s]));
  }

  // ---------------- GTIN lookup ----------------
  function initGtinTab() {
    $("#gtin-lookup-btn").addEventListener("click", async () => {
      const gtin = $("#gtin-input").value.trim();
      const statusEl = $("#gtin-status");
      if (!gtin) { setStatus(statusEl, "Enter a GTIN first.", "err"); return; }
      await lookupGtin(gtin, statusEl);
    });
    $("#gtin-demo-btn").addEventListener("click", () => {
      $("#gtin-input").value = "8901234567890";
    });
  }

  async function lookupGtin(gtin, statusEl) {
    setStatus(statusEl, "Looking up product on Open Food Facts…", "info");
    try {
      const res = await fetch(`/api/product/gtin/${encodeURIComponent(gtin)}`);
      const data = await res.json();
      if (!res.ok) {
        setStatus(statusEl, data.error || "Product not found. You can still use the Manual entry tab.", "err");
        return;
      }
      applyProductToEvidence(data.product);
      setStatus(statusEl, `Found: ${data.product.productName}. Evidence pre-filled — review in Manual entry tab.`, "ok");
    } catch (err) {
      setStatus(statusEl, "Network error reaching the lookup service.", "err");
    }
  }

  function applyProductToEvidence(product) {
    state.productDisplay = {
      productName: product.productName,
      brand: product.brand,
      imageUrl: product.imageUrl,
      gtin: product.gtin,
      source: product.source
    };
    mergeEvidence({
      physicalState: product.physicalState || "solid",
      energy_kcal_100g: product.energy_kcal_100g,
      protein_100g: product.protein_100g,
      fat_100g: product.fat_100g,
      saturatedFat_100g: product.saturatedFat_100g,
      transFat_100g: product.transFat_100g,
      sugar_100g: product.sugar_100g,
      fiber_100g: product.fiber_100g,
      sodium_100g: product.sodium_100g,
      cholesterol_100g: product.cholesterol_100g,
      ingredientsText: product.ingredientsText,
      productName: product.productName
    });
    syncManualFormFromEvidence();
    renderProductSummary();
  }

  // ---------------- OFF link lookup ----------------
  function initLinkTab() {
    $("#link-lookup-btn").addEventListener("click", async () => {
      const url = $("#link-input").value.trim();
      const statusEl = $("#link-status");
      if (!url) { setStatus(statusEl, "Paste an Open Food Facts product link first.", "err"); return; }
      setStatus(statusEl, "Fetching product…", "info");
      try {
        const res = await fetch("/api/product/off-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) {
          setStatus(statusEl, data.error || "Could not resolve that link.", "err");
          return;
        }
        applyProductToEvidence(data.product);
        setStatus(statusEl, `Found: ${data.product.productName}. Evidence pre-filled.`, "ok");
      } catch (err) {
        setStatus(statusEl, "Network error reaching the lookup service.", "err");
      }
    });
  }

  // ---------------- Barcode camera scan (Quagga2) ----------------
  let scanning = false;

  function initScanTab() {
    $("#scan-start-btn").addEventListener("click", startScan);
    $("#scan-stop-btn").addEventListener("click", stopScan);
  }

  function startScan() {
    const statusEl = $("#scan-status");
    if (typeof Quagga === "undefined") {
      setStatus(statusEl, "Barcode scanning library failed to load (check your internet connection).", "err");
      return;
    }
    setStatus(statusEl, "Requesting camera access…", "info");
    Quagga.init({
      inputStream: {
        type: "LiveStream",
        target: document.querySelector("#scan-viewport"),
        constraints: { facingMode: "environment" }
      },
      decoder: {
        readers: ["ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader"]
      },
      locate: true
    }, err => {
      if (err) {
        setStatus(statusEl, "Could not start camera: " + err.message, "err");
        return;
      }
      Quagga.start();
      scanning = true;
      $("#scan-start-btn").classList.add("hidden");
      $("#scan-stop-btn").classList.remove("hidden");
      setStatus(statusEl, "Scanning — point the camera at the barcode.", "info");
    });

    Quagga.onDetected(async result => {
      if (!scanning) return;
      const code = result?.codeResult?.code;
      if (!code) return;
      stopScan();
      setStatus(statusEl, `Detected code ${code}. Looking up…`, "info");
      $("#gtin-input").value = code;
      await lookupGtin(code, statusEl);
    });
  }

  function stopScan() {
    if (typeof Quagga !== "undefined" && scanning) {
      Quagga.offDetected();
      Quagga.stop();
    }
    scanning = false;
    $("#scan-start-btn").classList.remove("hidden");
    $("#scan-stop-btn").classList.add("hidden");
  }

  // ---------------- Label photos + OCR ----------------
  const photoFiles = { front: null, ingredients: null, nutrition: null };

  function initPhotosTab() {
    ["front", "ingredients", "nutrition"].forEach(key => {
      const input = $(`#file-${key}`);
      input.addEventListener("change", () => {
        const file = input.files[0];
        if (!file) return;
        photoFiles[key] = file;
        const thumb = $(`#thumb-${key}`);
        thumb.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
      });
    });

    $("#ocr-run-btn").addEventListener("click", runUploadAndOcr);
  }

  async function runUploadAndOcr() {
    const statusEl = $("#ocr-status");
    const anyFile = Object.values(photoFiles).some(Boolean);
    if (!anyFile) { setStatus(statusEl, "Choose at least one photo first.", "err"); return; }

    // 1. Upload images to server as evidence records
    setStatus(statusEl, "Uploading label images…", "info");
    try {
      const form = new FormData();
      Object.entries(photoFiles).forEach(([key, file]) => { if (file) form.append("images", file, `${key}-${file.name}`); });
      const res = await fetch("/api/upload-labels", { method: "POST", body: form });
      const data = await res.json();
      if (res.ok) {
        state.evidenceImages = state.evidenceImages.concat(data.files.map(f => f.url));
      }
    } catch (e) {
      // Non-fatal: OCR can still proceed even if upload storage fails
    }

    // 2. Run client-side OCR on ingredients + nutrition photos
    if (typeof Tesseract === "undefined") {
      setStatus(statusEl, "OCR library failed to load (check your internet connection). You can still fill fields manually.", "err");
      return;
    }

    let combinedText = "";
    for (const key of ["nutrition", "ingredients", "front"]) {
      const file = photoFiles[key];
      if (!file) continue;
      setStatus(statusEl, `Running OCR on ${key} photo…`, "info");
      try {
        const { data } = await Tesseract.recognize(file, "eng");
        combinedText += `\n----- ${key.toUpperCase()} -----\n${data.text}\n`;
      } catch (e) {
        combinedText += `\n----- ${key.toUpperCase()} (OCR failed) -----\n`;
      }
    }
    $("#ocr-raw-text").value = combinedText.trim();

    // 3. Best-effort extraction of numeric nutrients from OCR text (still user-reviewable)
    const extracted = extractNutrientsFromText(combinedText);
    if (Object.keys(extracted).length > 0) {
      mergeEvidence(extracted);
      syncManualFormFromEvidence();
    }
    if (photoFiles.ingredients) {
      const ingredientsSection = combinedText.split("----- INGREDIENTS -----")[1] || "";
      const cleaned = ingredientsSection.split("-----")[0].trim();
      if (cleaned) {
        mergeEvidence({ ingredientsText: (state.evidence.ingredientsText ? state.evidence.ingredientsText + "\n" : "") + cleaned });
        syncManualFormFromEvidence();
      }
    }

    setStatus(statusEl, "OCR complete. Review the extracted text and the auto-filled fields on the Manual entry tab before running a check.", "ok");
  }

  /** Very small heuristic parser: looks for "<nutrient> ... <number> g|mg|kcal" patterns in OCR text. */
  function extractNutrientsFromText(text) {
    const t = text.toLowerCase();
    const patterns = {
      energy_kcal_100g: /energy[^0-9]{0,15}([\d.]+)\s*k?cal/,
      protein_100g: /protein[^0-9]{0,10}([\d.]+)\s*g/,
      fat_100g: /(?<!saturated |trans )\bfat\b[^0-9]{0,10}([\d.]+)\s*g/,
      saturatedFat_100g: /saturated[^0-9]{0,15}([\d.]+)\s*g/,
      transFat_100g: /trans[^0-9]{0,15}([\d.]+)\s*g/,
      sugar_100g: /sugar[^0-9]{0,10}([\d.]+)\s*g/,
      fiber_100g: /fib(?:re|er)[^0-9]{0,10}([\d.]+)\s*g/,
      sodium_100g: /sodium[^0-9]{0,10}([\d.]+)\s*mg/,
      cholesterol_100g: /cholesterol[^0-9]{0,10}([\d.]+)\s*mg/
    };
    const found = {};
    for (const [field, regex] of Object.entries(patterns)) {
      const m = t.match(regex);
      if (m) found[field] = parseFloat(m[1]);
    }
    return found;
  }

  // ---------------- Manual entry ----------------
  function initManualTab() {
    $("#manual-apply-btn").addEventListener("click", () => {
      const fields = {
        physicalState: $("#m-physicalState").value,
        energy_kcal_100g: numOrEmpty($("#m-energy").value),
        protein_100g: numOrEmpty($("#m-protein").value),
        fat_100g: numOrEmpty($("#m-fat").value),
        saturatedFat_100g: numOrEmpty($("#m-satfat").value),
        transFat_100g: numOrEmpty($("#m-transfat").value),
        sugar_100g: numOrEmpty($("#m-sugar").value),
        fiber_100g: numOrEmpty($("#m-fiber").value),
        sodium_100g: numOrEmpty($("#m-sodium").value),
        cholesterol_100g: numOrEmpty($("#m-cholesterol").value),
        productName: $("#m-name").value,
        ingredientsText: $("#m-ingredients").value
      };
      mergeEvidence(fields);
      if (!state.productDisplay || state.productDisplay.source === "manual entry") {
        state.productDisplay = {
          productName: fields.productName || "Manually entered product",
          brand: "",
          imageUrl: "",
          gtin: "",
          source: "manual entry"
        };
      }
      renderProductSummary();
      setStatus($("#manual-status"), "Evidence applied.", "ok");
    });
  }

  function numOrEmpty(v) {
    if (v === "" || v === null || v === undefined) return "";
    const n = parseFloat(v);
    return isNaN(n) ? "" : n;
  }

  // ---------------- Claims + rules ----------------
  async function loadRules() {
    const res = await fetch("/api/rules");
    const data = await res.json();
    state.rulesMeta = data.meta;
    state.claims = data.claims;
    renderClaimGrid();
    $("#claim-count").textContent = `${state.claims.length} claims loaded`;
  }

  function renderClaimGrid() {
    const grid = $("#claim-grid");
    grid.innerHTML = "";
    state.claims.forEach(claim => {
      const btn = document.createElement("button");
      btn.className = "claim-chip";
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = `<span class="claim-chip__label">${escapeHtml(claim.label)}</span><span class="claim-chip__cat">${escapeHtml(claim.category.replace(/_/g, " "))}</span>`;
      btn.addEventListener("click", () => selectClaim(claim.id));
      grid.appendChild(btn);
    });
  }

  function selectClaim(claimId) {
    state.selectedClaimId = claimId;
    $$(".claim-chip").forEach((chip, i) => {
      chip.setAttribute("aria-pressed", String(state.claims[i].id === claimId));
    });
    renderReferenceBoxIfNeeded();
    refreshRunButton();
  }

  function renderReferenceBoxIfNeeded() {
    const claim = state.claims.find(c => c.id === state.selectedClaimId);
    const holder = $("#reference-box-holder");
    if (!claim || claim.category !== "comparative") {
      holder.innerHTML = "";
      return;
    }
    const isProtein = claim.id === "protein_30_more";
    const fieldLabel = isProtein ? "Reference protein (g/100g)" : "Reference sodium (mg/100g)";
    const fieldKey = isProtein ? "reference_protein_100g" : "reference_sodium_100g";
    holder.innerHTML = `
      <div class="reference-box">
        <h4>Comparator / reference product</h4>
        <label for="ref-value">${fieldLabel}</label>
        <input type="number" id="ref-value" step="0.1" value="${state.referenceEvidence[fieldKey] ?? ''}" />
        <p class="helper-text">Comparative claims require a named reference product's value (e.g. "the standard variant") to calculate the percentage difference.</p>
      </div>`;
    $("#ref-value").addEventListener("input", e => {
      state.referenceEvidence[fieldKey] = numOrEmpty(e.target.value);
    });
  }

  // ---------------- Run check ----------------
  function initRunCheck() {
    $("#run-check-btn").addEventListener("click", runCheck);
  }

  async function runCheck() {
    const statusEl = $("#verify-status");
    if (!state.selectedClaimId) return;
    setStatus(statusEl, "Evaluating against the rules engine…", "info");
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimId: state.selectedClaimId,
          product: state.evidence,
          referenceProduct: {
            protein_100g: state.referenceEvidence.reference_protein_100g,
            sodium_100g: state.referenceEvidence.reference_sodium_100g
          },
          evidenceImages: state.evidenceImages
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(statusEl, data.error || "Could not run the check.", "err");
        return;
      }
      clearStatus(statusEl);
      renderVerdict(data);
    } catch (err) {
      setStatus(statusEl, "Network error running the check.", "err");
    }
  }

  function renderVerdict(result) {
    const out = $("#verdict-output");
    const stampClass = "stamp--" + result.verdict.replace(/\s+/g, "-");

    const evidenceRows = Object.entries(result.evidenceUsed)
      .filter(([k]) => NUMERIC_FIELD_LABELS[k] || k === "physicalState")
      .map(([k, v]) => {
        const label = k === "physicalState" ? "Physical state" : (NUMERIC_FIELD_LABELS[k] || k);
        return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(v === "" || v === undefined ? "—" : v)}</td></tr>`;
      }).join("");

    const calcLines = result.calculation.map(line => {
      const cls = /^FAIL/.test(line) ? "fail" : /^PASS/.test(line) ? "pass" : "";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    }).join("\n");

    const imagesHtml = (result.evidenceImages || []).length
      ? `<div class="evidence-images">${result.evidenceImages.map(u => `<img src="${u}" alt="uploaded label" />`).join("")}</div>`
      : `<p class="helper-text">No label images were uploaded for this check.</p>`;

    out.innerHTML = `
      <div class="stamp-wrap"><div class="stamp ${stampClass}">${escapeHtml(result.verdict)}</div></div>

      <div class="ledger-section">
        <h3>Claim checked</h3>
        <p style="margin:0;"><strong>${escapeHtml(result.claim.label)}</strong><br/>
        <span class="helper-text" style="margin-top:2px;">${escapeHtml(result.claim.description)}</span></p>
      </div>

      <div class="ledger-section">
        <h3>Evidence used</h3>
        <table class="evidence-table">${evidenceRows || "<tr><td colspan='2'>No evidence supplied.</td></tr>"}</table>
      </div>

      <div class="ledger-section">
        <h3>Calculation</h3>
        <div class="calc-trace">${calcLines || "—"}</div>
      </div>

      <div class="ledger-section">
        <h3>Rule applied &amp; FSSAI reference</h3>
        <div class="rule-ref">
          <div>${escapeHtml(result.ruleReference.source)}</div>
          <div><a href="${result.ruleReference.reference_url}" target="_blank" rel="noopener">Regulations index</a> ·
               <a href="${result.ruleReference.compendium_url}" target="_blank" rel="noopener">Advertising &amp; Claims compendium (PDF)</a></div>
          <div class="disclaimer">${escapeHtml(result.ruleReference.disclaimer)}</div>
        </div>
      </div>

      <div class="ledger-section">
        <h3>Uploaded label images</h3>
        ${imagesHtml}
      </div>
    `;
  }

  // ---------------- Init ----------------
  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initGtinTab();
    initLinkTab();
    initScanTab();
    initPhotosTab();
    initManualTab();
    initRunCheck();
    loadRules();
    refreshEvidenceCount();
  });
})();
