export const RECONCILIATION_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AlphaBasket Reconciliation</title>
  <link rel="stylesheet" href="/ops/reconciliation/dashboard.css">
</head>
<body>
  <main>
    <header><p class="eyebrow">AlphaBasket operations</p><h1>Reconciliation</h1><p id="summary">Loading authenticated data…</p></header>
    <section id="runs" aria-live="polite"></section>
  </main>
  <script src="/ops/reconciliation/dashboard.js" defer></script>
</body>
</html>`;

export const RECONCILIATION_DASHBOARD_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090d12;color:#e7edf4}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#172231 0,transparent 40%),#090d12}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:64px 0}header{margin-bottom:32px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:#7dd3fc;font-size:12px;font-weight:700}h1{font-size:clamp(36px,6vw,72px);letter-spacing:-.04em;margin:8px 0}#summary{color:#9ca9b8}.run{border:1px solid #263241;background:#101720d9;border-radius:16px;padding:20px;margin:16px 0}.run-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.status{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;padding:7px 10px;border-radius:999px}.healthy{background:#123c2e;color:#86efac}.degraded{background:#463512;color:#fde68a}.critical{background:#4a1d25;color:#fda4af}.finding{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:12px 0;border-top:1px solid #263241}.finding code{color:#c4b5fd}.muted{color:#8795a5}.empty{border:1px dashed #334155;border-radius:16px;padding:32px;color:#9ca9b8}@media(max-width:640px){main{padding:32px 0}.finding{grid-template-columns:1fr}.run-head{align-items:flex-start;flex-direction:column}}`;

export const RECONCILIATION_DASHBOARD_JS = `"use strict";
const root=document.getElementById("runs");const summary=document.getElementById("summary");
const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node};
const token=sessionStorage.getItem("alphabasketOpsToken")||window.prompt("Operations bearer token");
if(token)sessionStorage.setItem("alphabasketOpsToken",token);
const render=(payload)=>{root.replaceChildren();summary.textContent=payload.runs.length+" recent run(s) for "+payload.scope;if(payload.runs.length===0){root.append(text("div","No reconciliation runs have been recorded.","empty"));return}for(const run of payload.runs){const card=document.createElement("article");card.className="run";const head=document.createElement("div");head.className="run-head";const title=document.createElement("div");title.append(text("h2",new Date(run.observedAt).toLocaleString()));title.append(text("p",run.findings.length+" finding(s) across "+run.observations.length+" basket(s)","muted"));head.append(title);head.append(text("span",run.status,"status "+run.status));card.append(head);for(const finding of run.findings){const row=document.createElement("div");row.className="finding";row.append(text("strong",finding.severity));const detail=document.createElement("div");detail.append(text("code",finding.code));detail.append(text("p","Basket "+finding.basketId+(finding.actualValue===null?"":" · actual "+finding.actualValue)+(finding.expectedValue===null?"":" · expected "+finding.expectedValue),"muted"));row.append(detail);card.append(row)}root.append(card)}};
if(!token){summary.textContent="Authentication token is required.";root.append(text("div","Reload to enter an operations token.","empty"))}else{fetch("/ops/reconciliation?limit=20",{headers:{authorization:"Bearer "+token}}).then(async response=>{if(!response.ok)throw new Error("HTTP "+response.status);return response.json()}).then(render).catch(error=>{summary.textContent="Unable to load reconciliation data.";root.replaceChildren(text("div",error.message,"empty"))})}`;
