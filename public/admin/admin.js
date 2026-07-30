const tokenInput = document.querySelector("#admin-token");
const loginButton = document.querySelector("#login-button");
const loginCard = document.querySelector("#login-card");
const connectionCard = document.querySelector("#connection-card");
const calendarsCard = document.querySelector("#calendars-card");
const connectionText = document.querySelector("#connection-text");
const connectButton = document.querySelector("#connect-button");
const disconnectButton = document.querySelector("#disconnect-button");
const refreshButton = document.querySelector("#refresh-button");
const selectAllButton = document.querySelector("#select-all-button");
const selectNoneButton = document.querySelector("#select-none-button");
const saveButton = document.querySelector("#save-button");
const calendarList = document.querySelector("#calendar-list");
const statusLine = document.querySelector("#admin-status");

let adminToken = sessionStorage.getItem("availability-admin-token") || "";
if (adminToken) {
  tokenInput.value = adminToken;
  initialize();
}

loginButton.addEventListener("click", () => {
  adminToken = tokenInput.value.trim();
  if (!adminToken) return setStatus("Inserisci il token amministratore.", true);
  sessionStorage.setItem("availability-admin-token", adminToken);
  initialize();
});

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loginButton.click();
});

connectButton.addEventListener("click", async () => {
  try {
    setStatus("Preparazione del collegamento a Google…");
    const data = await api("/api/admin/google/start");
    window.location.href = data.url;
  } catch (error) {
    setStatus(error.message, true);
  }
});

disconnectButton.addEventListener("click", async () => {
  if (!window.confirm("Scollegare Google Calendar e cancellare la selezione dei calendari?")) return;
  try {
    await api("/api/admin/disconnect", { method: "DELETE" });
    calendarList.replaceChildren();
    await initialize();
    setStatus("Google Calendar scollegato.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

refreshButton.addEventListener("click", loadCalendars);
selectAllButton.addEventListener("click", () => setAllCheckboxes(true));
selectNoneButton.addEventListener("click", () => setAllCheckboxes(false));
saveButton.addEventListener("click", saveCalendars);

async function initialize() {
  try {
    setStatus("Verifica dell'accesso…");
    const config = await api("/api/admin/config");
    loginCard.hidden = true;
    connectionCard.hidden = false;
    connectionText.textContent = config.connected
      ? `Google Calendar collegato. ${config.selectedCount} calendari selezionati.`
      : "Google Calendar non è ancora collegato.";
    connectButton.hidden = config.connected;
    disconnectButton.hidden = !config.connected;
    calendarsCard.hidden = !config.connected;
    setStatus("");
    if (config.connected) await loadCalendars();
  } catch (error) {
    loginCard.hidden = false;
    connectionCard.hidden = true;
    calendarsCard.hidden = true;
    setStatus(error.message, true);
  }
}

async function loadCalendars() {
  try {
    setStatus("Caricamento dei calendari…");
    const data = await api("/api/admin/calendars");
    renderCalendars(data.calendars || []);
    setStatus(`${data.calendars.length} calendari trovati.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderCalendars(calendars) {
  calendarList.replaceChildren();
  for (const calendar of calendars) {
    const row = document.createElement("label");
    row.className = "calendar-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = calendar.id;
    checkbox.checked = calendar.selected;

    const text = document.createElement("span");
    const name = document.createElement("span");
    name.className = "calendar-name";
    name.textContent = calendar.name;
    const meta = document.createElement("span");
    meta.className = "calendar-meta";
    meta.textContent = [calendar.primary ? "Calendario principale" : "Calendario secondario", calendar.hidden ? "nascosto" : null]
      .filter(Boolean)
      .join(" · ");

    text.append(name, meta);
    row.append(checkbox, text);
    calendarList.append(row);
  }
}

async function saveCalendars() {
  const ids = [...calendarList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  try {
    setStatus("Salvataggio…");
    const data = await api("/api/admin/calendars", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    connectionText.textContent = `Google Calendar collegato. ${data.selectedCount} calendari selezionati.`;
    setStatus("Calendari salvati. Il semaforo pubblico si aggiornerà entro pochi secondi.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function setAllCheckboxes(checked) {
  for (const input of calendarList.querySelectorAll('input[type="checkbox"]')) input.checked = checked;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${adminToken}`);
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
  return data;
}

function setStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
}

const oauth = new URLSearchParams(window.location.search).get("oauth");
if (oauth === "connected") setStatus("Google Calendar collegato correttamente.");
if (oauth === "denied") setStatus("Collegamento a Google annullato.", true);
