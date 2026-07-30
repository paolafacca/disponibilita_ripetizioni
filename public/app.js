const title = document.querySelector("#status-title");
const trafficLight = document.querySelector("#traffic-light");
const line = document.querySelector("#status-line");
const label = document.querySelector("#status-label");
const time = document.querySelector("#status-time");
const relative = document.querySelector("#status-relative");
const updatedAt = document.querySelector("#updated-at");
const shell = document.querySelector(".status-shell");

const stateImages = {
  green: "/img/semaforo-verde.svg",
  yellow: "/img/semaforo-giallo.svg",
  red: "/img/semaforo-rosso.svg",
  error: "/img/semaforo-spento.svg",
};

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok && !data.state) throw new Error(data.error || "Servizio non disponibile");
    renderStatus(data);
  } catch (error) {
    renderStatus({
      state: "error",
      title: "STATO NON DISPONIBILE",
      label: "",
      time: "",
      relative: "Riprovo automaticamente tra pochi secondi.",
      updatedAt: new Date().toISOString(),
    });
    console.error(error);
  }
}

function renderStatus(data) {
  const state = ["green", "yellow", "red"].includes(data.state) ? data.state : "error";
  document.body.className = `status-page state-${state}`;
  title.textContent = data.title || "STATO NON DISPONIBILE";
  trafficLight.src = stateImages[state];
  trafficLight.alt = altTextForState(state);

  if (data.label && data.time) {
    label.textContent = data.label;
    time.textContent = data.time;
    line.hidden = false;
  } else {
    label.textContent = "";
    time.textContent = "";
    line.hidden = true;
  }

  relative.textContent = data.relative || "";
  updatedAt.textContent = data.updatedAt
    ? `Aggiornato alle ${new Intl.DateTimeFormat("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(data.updatedAt))}`
    : "";
  shell.setAttribute("aria-busy", "false");
}

function altTextForState(state) {
  if (state === "green") return "Semaforo con luce verde accesa";
  if (state === "yellow") return "Semaforo con luce gialla accesa";
  if (state === "red") return "Semaforo con luce rossa accesa";
  return "Semaforo spento";
}

refreshStatus();
setInterval(refreshStatus, 30_000);
