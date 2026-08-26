// Minimal hash router for the workstation shell.
// Routes: #/ (landing), #/chat, #/research, #/code, #/reports
//
// Each app registers { id, mount(container), unmount?() }. Mounting is lazy on
// first visit; the active view's container is unhidden and previous apps are
// unmounted so they can pause work (timers, streams).

const routes = new Map(); // id -> { title, container, app, mounted }
let active = null;

export const DEFAULT_ROUTE = "chat";

export function registerRoute(id, { title, container, app }) {
  routes.set(id, { title, container, app, mounted: false });
}

export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return h || "";
}

export function navigate(id, { replace = false } = {}) {
  const target = `#/${id}`;
  if (location.hash === target) return activate(id);
  if (replace) {
    // replaceState does NOT fire hashchange — activate directly
    history.replaceState(null, "", target);
    activate(id);
  } else {
    location.hash = target; // hashchange handler activates
  }
}

function activate(id) {
  if (!routes.has(id)) id = DEFAULT_ROUTE;
  if (active === id) { document.dispatchEvent(new CustomEvent("ws:route", { detail: { id } })); return; }
  if (active && routes.get(active)?.app?.unmount) {
    try { routes.get(active).app.unmount(); } catch (e) { console.error(e); }
  }
  active = id;
  const route = routes.get(id);
  for (const [rid, r] of routes) r.container.hidden = rid !== id;
  if (!route.mounted) {
    route.app.mount(route.container);
    route.mounted = true;
  }
  document.title = route.title ? `${route.title} · Gemma 4 Workstation` : "Gemma 4 Workstation";
  document.dispatchEvent(new CustomEvent("ws:route", { detail: { id } }));
}

export function startRouter() {
  window.addEventListener("hashchange", () => {
    const r = currentRoute();
    // empty hash (# or #/) → back to the landing page
    if (!r) { active = null; document.dispatchEvent(new CustomEvent("ws:route", { detail: { id: "" } })); return; }
    activate(r);
  });
  const initial = currentRoute();
  if (initial) activate(initial);
  else document.dispatchEvent(new CustomEvent("ws:route", { detail: { id: "" } }));
}
