import "./style.css";

const demoShipments = [
  { id: "1", tracking_no: "MSCU-482910", route: "上海 → 新加坡", customer: "Orchid Retail", status: "运输中", eta: "2026-08-23", carrier: "Maersk", updated_at: "2026-08-20T08:20:00Z" },
  { id: "2", tracking_no: "SZX-880143", route: "深圳 → 吉隆坡", customer: "Northstar Labs", status: "待提货", eta: "2026-08-21", carrier: "DHL", updated_at: "2026-08-20T06:10:00Z" },
  { id: "3", tracking_no: "OOLU-223847", route: "宁波 → 洛杉矶", customer: "Mono House", status: "异常", eta: "2026-08-28", carrier: "OOCL", updated_at: "2026-08-19T23:42:00Z" },
  { id: "4", tracking_no: "SIN-105782", route: "新加坡 → 香港", customer: "Aster Studio", status: "已签收", eta: "2026-08-19", carrier: "FedEx", updated_at: "2026-08-19T10:00:00Z" }
];

const cfg = {
  url: import.meta.env.VITE_SUPABASE_URL,
  key: import.meta.env.VITE_SUPABASE_ANON_KEY
};

let shipments = [];
let filter = "全部";
let query = "";

async function loadShipments() {
  if (!cfg.url || !cfg.key || cfg.url.includes("YOUR_PROJECT")) return demoShipments;
  const response = await fetch(`${cfg.url}/rest/v1/shipments?select=*&order=updated_at.desc`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
  });
  if (!response.ok) throw new Error("无法读取 Supabase 数据");
  return response.json();
}

function daysUntil(date) {
  return Math.ceil((new Date(`${date}T23:59:59`) - new Date()) / 86400000);
}

function getView() {
  return shipments.filter((item) => {
    const matchesFilter = filter === "全部" || item.status === filter;
    const haystack = `${item.tracking_no} ${item.customer} ${item.route} ${item.carrier}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  });
}

function statusClass(status) {
  return ({ "运输中": "moving", "待提货": "waiting", "异常": "risk", "已签收": "done" })[status] || "waiting";
}

function render() {
  const list = getView();
  const active = shipments.filter((s) => s.status !== "已签收").length;
  const risks = shipments.filter((s) => s.status === "异常").length;
  const dueSoon = shipments.filter((s) => s.status !== "已签收" && daysUntil(s.eta) <= 3).length;

  document.querySelector("#app").innerHTML = `
    <header class="topbar">
      <a class="brand" href="#" aria-label="Cargo Pulse 首页"><span class="brand-mark">CP</span><span>Cargo Pulse</span></a>
      <div class="top-actions"><span class="sync"><i></i>${cfg.url ? "Supabase 已连接" : "演示数据"}</span><button class="avatar" aria-label="账户">林</button></div>
    </header>
    <main>
      <section class="hero">
        <div><p class="eyebrow">物流控制台 · 20 AUG 2026</p><h1>每一票货，<br><em>都在视线内。</em></h1><p class="intro">用一张清晰的工作台，跟进运输状态、预计到达与异常事项。</p></div>
        <button class="primary" id="addBtn"><span>＋</span> 新建物流单</button>
      </section>
      <section class="metrics" aria-label="物流概况">
        <article><span>进行中</span><strong>${active}</strong><small>票在途货物</small></article>
        <article><span>即将到达</span><strong>${dueSoon}</strong><small>未来 3 天</small></article>
        <article class="risk-card"><span>需要处理</span><strong>${risks}</strong><small>票异常事项</small></article>
        <article><span>准时率</span><strong>96<sup>%</sup></strong><small>近 30 天</small></article>
      </section>
      <section class="workspace">
        <div class="section-head"><div><p class="eyebrow">SHIPMENT BOARD</p><h2>物流看板</h2></div><label class="search"><span>⌕</span><input id="search" value="${query}" placeholder="搜索单号、客户或路线" aria-label="搜索物流单" /></label></div>
        <div class="filters">${["全部", "待提货", "运输中", "异常", "已签收"].map((x) => `<button class="${filter === x ? "active" : ""}" data-filter="${x}">${x}<b>${x === "全部" ? shipments.length : shipments.filter((s) => s.status === x).length}</b></button>`).join("")}</div>
        <div class="table-wrap"><table><thead><tr><th>物流单</th><th>路线 / 客户</th><th>状态</th><th>预计到达</th><th>承运商</th><th></th></tr></thead><tbody>
          ${list.length ? list.map((s) => `<tr><td><strong>${s.tracking_no}</strong><small>更新于 ${new Date(s.updated_at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></td><td><strong>${s.route}</strong><small>${s.customer}</small></td><td><span class="status ${statusClass(s.status)}"><i></i>${s.status}</span></td><td><strong>${new Date(s.eta).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</strong><small>${daysUntil(s.eta) >= 0 ? `${daysUntil(s.eta)} 天后` : "已到期"}</small></td><td>${s.carrier}</td><td><button class="more" aria-label="查看 ${s.tracking_no}">→</button></td></tr>`).join("") : `<tr><td colspan="6" class="empty">没有找到匹配的物流单</td></tr>`}
        </tbody></table></div>
      </section>
    </main>
    <dialog id="newShipment"><form method="dialog"><div class="dialog-head"><div><p class="eyebrow">NEW SHIPMENT</p><h2>新建物流单</h2></div><button value="cancel" class="close" aria-label="关闭">×</button></div><p class="dialog-copy">MVP 已准备好数据结构。连接 Supabase 后即可在这里提交新记录。</p><div class="dialog-actions"><button value="cancel" class="secondary">知道了</button></div></form></dialog>
  `;

  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { filter = button.dataset.filter; render(); }));
  document.querySelector("#search").addEventListener("input", (event) => { query = event.target.value; render(); document.querySelector("#search").focus(); });
  document.querySelector("#addBtn").addEventListener("click", () => document.querySelector("#newShipment").showModal());
}

loadShipments().then((data) => { shipments = data; render(); }).catch(() => { shipments = demoShipments; render(); });
