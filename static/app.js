const nameInput = document.getElementById("checked-by");
const startButton = document.getElementById("start");
const startPanel = document.getElementById("start-panel");
const auditPanel = document.getElementById("audit-panel");
const auditInfo = document.getElementById("audit-info");
const progressText = document.getElementById("progress-text");
const progressTrack = document.getElementById("progress-track");
const progressBar = document.getElementById("progress-bar");
const checklist = document.getElementById("checklist");
const submitButton = document.getElementById("submit");
const submitLabel = document.getElementById("submit-label");
const message = document.getElementById("message");
const historyFilter = document.getElementById("history-filter");
const historyList = document.getElementById("history");
const historyEmpty = document.getElementById("history-empty");

let audit = null;
let rows = new Map();
let latestSave = {};
let savesInFlight = 0;
let todaysAudits = [];

// localStorage can throw (e.g. Safari private mode), and the app must still work.
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function forget(key) {
  try { localStorage.removeItem(key); } catch {}
}

// Always sets textContent (never innerHTML), so typed names can't inject HTML.
function el(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

const ICONS = {
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  skipped: "M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  error: "M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z",
  sync: "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z",
  chevron: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z",
};

function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon ${className}`.trim());
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

const formatTemp = (t) => `${t.toFixed(1)} °C`;
const formatRange = (slot) => `${slot.min_temp} to ${slot.max_temp} °C`;
const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function groupByDepartment(slots) {
  const groups = new Map();
  for (const slot of slots) {
    if (!groups.has(slot.department)) groups.set(slot.department, []);
    groups.get(slot.department).push(slot);
  }
  return groups;
}

class ApiError extends Error {
  constructor(text, status, detail) {
    super(text);
    this.status = status;
    this.detail = detail;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    throw new ApiError(describeError(body, response.status), response.status, body?.detail);
  }
  return body;
}

function describeError(body, status) {
  const detail = body?.detail;
  if (Array.isArray(detail)) {
    return detail.map((e) => e.msg.replace(/^Value error, /, "")).join("; ");
  }
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  return `Server error ${status}`;
}

// kind: "ok" / "bad" for audit results (status colours), "error" for app problems.
function showMessage(kind, title, text = "") {
  message.className = `message ${kind}`;
  const body = el("div");
  body.append(el("strong", "", title), text);
  message.replaceChildren(icon({ ok: "check", bad: "warning", error: "error" }[kind]), body);
  message.hidden = false;
}

function parseTemperature(text) {
  // Some phone keypads type a comma as the decimal point.
  const cleaned = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

// ----- Current audit -----

function showAudit(data) {
  audit = data;
  rows = new Map();
  latestSave = {};
  remember("auditId", audit.id);

  auditInfo.textContent = `${audit.checked_by} · started ${formatTime(audit.started_at)}`;
  checklist.replaceChildren();
  for (const [department, slots] of groupByDepartment(audit.readings)) {
    const list = el("ul", "checklist");
    for (const slot of slots) list.append(buildRow(slot));
    const card = el("div", "card");
    card.append(list);
    const section = el("section", "department");
    section.append(el("h2", "section-label", department), card);
    checklist.append(section);
  }

  startPanel.hidden = true;
  auditPanel.hidden = false;
  auditInfo.hidden = false;
  progressText.hidden = false;
  progressTrack.hidden = false;
  updateProgress();
}

function closeAudit() {
  audit = null;
  forget("auditId");
  checklist.replaceChildren();
  auditPanel.hidden = true;
  auditInfo.hidden = true;
  progressText.hidden = true;
  progressTrack.hidden = true;
  startPanel.hidden = false;
}

function buildRow(slot) {
  const row = el("li", "row");

  const range = el("span", "range", "Safe ");
  range.append(el("span", "mono", formatRange(slot)));
  const state = el("span", "row-state");
  const info = el("div", "row-info");
  info.append(el("strong", "", slot.location), range, state);

  const flip = el("button", "flip-sign", "±");
  flip.type = "button";
  flip.setAttribute("aria-label", `Make ${slot.location} negative or positive`);
  const input = el("input", "temp");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `${slot.location} temperature in °C`);
  const skip = el("button", "skip-toggle", "Not checked");
  skip.type = "button";
  const entry = el("div", "entry");
  entry.append(flip, input);
  const main = el("div", "row-main");
  main.append(info, entry);
  const actions = el("div", "row-actions");
  actions.append(skip);

  // Decorative: the same information is in the row's status text.
  const gauge = el("div", "gauge");
  gauge.setAttribute("aria-hidden", "true");
  gauge.append(el("div", "gauge-zone"), el("div", "gauge-marker"));

  const reason = el("input");
  reason.type = "text";
  reason.autocomplete = "off";
  reason.id = `reason-${slot.location.replace(/\W+/g, "-")}`;
  const reasonLabel = el("label", "", "Reason not checked");
  reasonLabel.htmlFor = reason.id;
  const reasonBox = el("div", "reason-box");
  reasonBox.append(reasonLabel, reason);

  const error = el("p", "row-error");
  error.hidden = true;
  row.append(main, actions, gauge, reasonBox, error);

  const parts = { row, state, input, flip, skip, reasonBox, reason, error, gauge };
  rows.set(slot.location, parts);

  if (slot.temperature !== null) input.value = String(slot.temperature);
  reason.value = slot.skip_reason || "";
  setSkipMode(parts, slot.status === "skipped");
  paintRow(parts, slot);

  const save = () => saveRow(slot.location);
  input.addEventListener("blur", save);
  reason.addEventListener("blur", save);
  for (const field of [input, reason]) {
    // Phone keyboards' Enter/Go key: finish the field, which triggers the save.
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") field.blur();
    });
  }

  // Stops the tap from taking focus off the input, so the phone keypad stays open.
  flip.addEventListener("mousedown", (event) => event.preventDefault());
  flip.addEventListener("click", () => {
    const value = input.value.trim();
    input.value = value.startsWith("-") ? value.slice(1) : `-${value}`;
    // If the input still has focus, its blur will save; otherwise save now.
    if (document.activeElement !== input) save();
  });

  skip.addEventListener("click", () => {
    error.hidden = true;
    const turningOn = skip.getAttribute("aria-pressed") !== "true";
    setSkipMode(parts, turningOn);
    if (turningOn) reason.focus();
    else save();
  });

  return row;
}

function setSkipMode(parts, on) {
  parts.skip.setAttribute("aria-pressed", String(on));
  parts.reasonBox.hidden = !on;
  parts.input.disabled = on;
  parts.flip.disabled = on;
}

function setState(parts, iconName, text) {
  parts.state.replaceChildren(...(iconName ? [icon(iconName)] : []), text);
}

function paintRow(parts, slot) {
  parts.row.className = `row ${slot.status}`;
  const [iconName, text] = {
    pending: [null, ""],
    in_range: ["check", "Saved · In range"],
    out_of_range: ["warning", "Saved · Out of range"],
    skipped: ["skipped", "Saved · Not checked"],
  }[slot.status];
  setState(parts, iconName, text);
  if (slot.status === "skipped") parts.input.value = "";
  paintGauge(parts.gauge, slot);
}

// Scale = the safe range plus the same width again on each side (at least 4 °C),
// so the safe zone sits in the middle and near-misses are visibly near.
function paintGauge(gauge, slot) {
  gauge.hidden = slot.temperature === null;
  if (gauge.hidden) return;
  const pad = Math.max(slot.max_temp - slot.min_temp, 4);
  const low = slot.min_temp - pad;
  const high = slot.max_temp + pad;
  const percent = (t) => Math.min(100, Math.max(0, ((t - low) / (high - low)) * 100));
  const [zone, marker] = gauge.children;
  zone.style.left = `${percent(slot.min_temp)}%`;
  zone.style.width = `${percent(slot.max_temp) - percent(slot.min_temp)}%`;
  marker.style.left = `${percent(slot.temperature)}%`;
}

function showRowError(parts, text) {
  parts.error.replaceChildren(icon("error"), text);
  parts.error.hidden = false;
}

// Returns the request body, or null if there's nothing (valid) to save.
function rowBody(parts, slot) {
  parts.error.hidden = true;

  if (parts.skip.getAttribute("aria-pressed") === "true") {
    const reason = parts.reason.value.trim();
    if (!reason) {
      showRowError(parts, "Add a reason why it wasn't checked.");
      return null;
    }
    if (slot.status === "skipped" && slot.skip_reason === reason) return null;
    return { skip_reason: reason };
  }

  const text = parts.input.value.trim();
  if (text === "" || text === "-") {
    return slot.status === "pending" ? null : {};
  }
  const temperature = parseTemperature(text);
  if (temperature === null) {
    showRowError(parts, "Enter a number, e.g. 3.5 or -18.");
    return null;
  }
  if (slot.temperature === temperature) return null;
  return { temperature };
}

async function saveRow(location) {
  if (!audit) return;
  const parts = rows.get(location);
  const slot = audit.readings.find((s) => s.location === location);
  const body = rowBody(parts, slot);
  if (body === null) return;

  // Only the newest save for a row may update it; older replies can arrive later.
  const requestNumber = (latestSave[location] || 0) + 1;
  latestSave[location] = requestNumber;
  const auditId = audit.id;

  savesInFlight++;
  updateProgress();
  setState(parts, "sync", "Saving…");

  try {
    const updated = await api(
      `/audits/${auditId}/readings/${encodeURIComponent(location)}`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    if (audit?.id !== auditId || latestSave[location] !== requestNumber) return;
    const newSlot = updated.readings.find((s) => s.location === location);
    audit.readings = audit.readings.map((s) => (s.location === location ? newSlot : s));
    paintRow(parts, newSlot);
  } catch (error) {
    if (audit?.id !== auditId || latestSave[location] !== requestNumber) return;
    setState(parts, "error", "Not saved");
    showRowError(parts, error.message);
  } finally {
    savesInFlight--;
    updateProgress();
  }
}

function updateProgress() {
  if (!audit) return;
  const total = audit.readings.length;
  const done = audit.readings.filter((s) => s.status !== "pending").length;
  const out = audit.readings.filter((s) => s.status === "out_of_range").length;
  progressText.replaceChildren(
    el("span", "count", `${done} / ${total}`),
    // Screen readers join the two lines; without this they'd hear "4 / 41 out of range".
    el("span", "visually-hidden", ", "),
    el("span", out ? "out" : "", `${out} out of range`)
  );
  progressBar.style.width = `${(done / total) * 100}%`;
  progressTrack.setAttribute("aria-valuemax", String(total));
  progressTrack.setAttribute("aria-valuenow", String(done));
  submitButton.disabled = done < total || savesInFlight > 0;
}

async function startAudit() {
  const name = nameInput.value.trim();
  if (!name) {
    showMessage("error", "Enter your name first");
    nameInput.focus();
    return;
  }
  startButton.disabled = true;
  try {
    const created = await api("/audits", {
      method: "POST",
      body: JSON.stringify({ checked_by: name }),
    });
    message.hidden = true;
    showAudit(created);
    loadHistory();
  } catch (error) {
    showMessage("error", "Couldn't start the audit", error.message);
  } finally {
    startButton.disabled = false;
  }
}

async function submitAudit() {
  submitButton.disabled = true;
  submitLabel.textContent = "Submitting…";
  try {
    const submitted = await api(`/audits/${audit.id}/submit`, { method: "POST" });
    const out = submitted.readings.filter((s) => s.status === "out_of_range").length;
    const skipped = submitted.readings.filter((s) => s.status === "skipped").length;
    closeAudit();
    showMessage(
      out ? "bad" : "ok",
      "Audit submitted",
      `${out} out of range, ${skipped} not checked.`
    );
    window.scrollTo({ top: 0 });
    loadHistory();
  } catch (error) {
    showMessage("error", "Not submitted", error.message);
    for (const location of error.detail?.missing || []) {
      const parts = rows.get(location);
      if (parts) showRowError(parts, "Still to do.");
    }
  } finally {
    submitLabel.textContent = "Submit audit";
    updateProgress();
  }
}

async function resumeAudit() {
  const id = recall("auditId");
  if (!id) return;
  try {
    const saved = await api(`/audits/${encodeURIComponent(id)}`);
    if (saved.status === "in_progress") showAudit(saved);
    else forget("auditId");
  } catch (error) {
    if (error.status === 404) forget("auditId");
    else showMessage("error", "Couldn't load your audit", error.message);
  }
}

// ----- Today's audits -----

async function loadHistory() {
  try {
    todaysAudits = await api("/audits");
    renderHistory();
  } catch (error) {
    showMessage("error", "Couldn't load today's audits", error.message);
  }
}

function renderHistory() {
  const department = historyFilter.querySelector("input:checked").value;
  historyList.replaceChildren(...todaysAudits.map((a) => buildHistoryItem(a, department)));
  historyEmpty.hidden = todaysAudits.length > 0;
}

function buildHistoryItem(item, department) {
  const slots = department
    ? item.readings.filter((s) => s.department === department)
    : item.readings;
  const out = slots.filter((s) => s.status === "out_of_range").length;

  const summary = el("summary");
  summary.append(el("span", "time", formatTime(item.started_at)), el("span", "who", item.checked_by));
  const badges = el("span", "badges");
  if (item.status === "in_progress") badges.append(el("span", "badge pending", "In progress"));
  badges.append(el("span", `badge ${out ? "bad" : "ok"}`, `${out} out of range`));
  summary.append(badges, icon("chevron", "chevron"));

  const detail = el("div", "history-detail");
  for (const [name, group] of groupByDepartment(slots)) {
    const list = el("ul");
    for (const slot of group) {
      const line = el("li", slot.status);
      const value = el("strong", slot.temperature === null ? "" : "mono");
      const iconName = { in_range: "check", out_of_range: "warning", skipped: "skipped" }[
        slot.status
      ];
      if (iconName) value.append(icon(iconName));
      value.append(describeSlot(slot));
      line.append(el("span", "", slot.location), value);
      list.append(line);
    }
    detail.append(el("h3", "", name), list);
  }

  const details = el("details");
  details.append(summary, detail);
  const li = el("li");
  li.append(details);
  return li;
}

function describeSlot(slot) {
  if (slot.status === "pending") return "—";
  if (slot.status === "skipped") return `Not checked: ${slot.skip_reason}`;
  if (slot.status === "out_of_range") {
    return `${formatTemp(slot.temperature)} (safe ${formatRange(slot)})`;
  }
  return formatTemp(slot.temperature);
}

async function loadDepartments() {
  try {
    const locations = await api("/locations");
    for (const department of new Set(locations.map((l) => l.department))) {
      const radio = el("input");
      radio.type = "radio";
      radio.name = "history-department";
      radio.value = department;
      const chip = el("label", "chip");
      chip.append(radio, el("span", "", department));
      historyFilter.append(chip);
    }
  } catch {
    // The filter just stays on "All".
  }
}

nameInput.value = recall("checkedBy") || "";
nameInput.addEventListener("input", () => remember("checkedBy", nameInput.value.trim()));
startButton.addEventListener("click", startAudit);
submitButton.addEventListener("click", submitAudit);
historyFilter.addEventListener("change", renderHistory);

// ----- Theme -----
// The <head> script already applied the starting theme; this keeps it in sync.

const themeToggle = document.getElementById("theme-toggle");
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const next = theme === "dark" ? "light" : "dark";
  themeToggle.setAttribute("aria-label", `Switch to ${next} mode`);
}

applyTheme(document.documentElement.getAttribute("data-theme") || "light");

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  remember("theme", next);
  applyTheme(next);
});

// Follow the device setting live, until the user picks a theme themselves.
darkQuery.addEventListener("change", (event) => {
  if (!recall("theme")) applyTheme(event.matches ? "dark" : "light");
});

loadDepartments();
resumeAudit();
loadHistory();
