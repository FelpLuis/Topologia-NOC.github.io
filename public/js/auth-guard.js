(async function () {
  const path = location.pathname;

  if (path === "/login.html" || path === "/change-password.html") return;

  try {
    const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
    const me = await meResponse.json();

    if (!me.authenticated) {
      location.href = "/login.html";
      return;
    }

    window.UPDOWN_AUTH = me.user;
    document.documentElement.dataset.role = me.user.role;

    const accessResponse = await fetch("/api/access", { cache: "no-store" });
    if (!accessResponse.ok) return;

    const access = await accessResponse.json();
    window.UPDOWN_ACCESS = access;

    const hasScreen = code =>
      Array.isArray(access.screens) && access.screens.some(screen => screen.code === code);

    const platform = document.getElementById("platformBtn");
    const dashboard = document.getElementById("dashboardBtn");
    const manageNetwork = document.getElementById("manageNetworkBtn");

    if (platform) {
      if (hasScreen("platform")) {
        platform.classList.remove("hidden");
        platform.onclick = () => { location.href = "/platform.html"; };
      } else {
        platform.classList.add("hidden");
      }
    }

    if (dashboard && !hasScreen("dashboard")) dashboard.classList.add("hidden");
    if (manageNetwork && !hasScreen("network")) manageNetwork.classList.add("hidden");

    if (path === "/dashboard.html" && !hasScreen("dashboard")) {
      location.href = "/";
      return;
    }

    if (path === "/platform.html" && !hasScreen("platform")) {
      location.href = "/";
    }
  } catch (error) {
    console.error("Falha ao carregar permissões:", error);
  }
})();
