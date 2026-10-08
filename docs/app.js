// Sales Price Site: decrypts data.enc.json in the browser.
// The password is typed once; the phone keeps only a locked key (never the password).
"use strict";

const MAX_SHOW = 200;
const DB_NAME = "price-list";
const STORE = "kv";
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

let blob = null;      // encrypted file as published
let rows = [];        // decrypted parts
let updatedText = "";

// ---------- small IndexedDB store (works without it, just forgets) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(mode, fn) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    return undefined;
  }
}
const kvGet = (k) => kv("readonly", (s) => s.get(k));
const kvSet = (k, v) => kv("readwrite", (s) => s.put(v, k));
const kvDel = (k) => kv("readwrite", (s) => s.delete(k));

// ---------- crypto ----------
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, b) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(b.salt), iterations: b.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function openBlob(key, b) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(b.iv) }, key, fromB64(b.ct));
  return JSON.parse(dec.decode(plain));
}

// ---------- screens ----------
function show(id) {
  for (const s of ["lock", "message", "app"]) $(s).hidden = s !== id;
}
function message(title, text) {
  $("message-title").textContent = title;
  $("message-text").textContent = text;
  show("message");
}

// ---------- load ----------
async function loadBlob() {
  try {
    const r = await fetch("data.enc.json", { cache: "no-store" });
    if (r.status === 404) return { blob: null, offline: false, missing: true };
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    await kvSet("blob", text);
    return { blob: JSON.parse(text), offline: false };
  } catch (e) {
    const saved = await kvGet("blob");
    return saved ? { blob: JSON.parse(saved), offline: true } : { blob: null, offline: true };
  }
}

async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const res = await loadBlob();
  if (!res.blob) {
    return res.missing
      ? message("No prices yet", "The price list has not been published yet. Please check again later.")
      : message("You are offline", "Connect to the internet once to download the price list.");
  }
  blob = res.blob;
  $("offline").hidden = !res.offline;
  const key = await kvGet("key:" + blob.salt);
  if (key) {
    try { return showList(await openBlob(key, blob)); } catch (e) { await kvDel("key:" + blob.salt); }
  }
  show("lock");
  $("pw").focus();
}

async function unlock(ev) {
  ev.preventDefault();
  const pw = $("pw").value.trim();
  if (!pw) return;
  $("unlock").disabled = true;
  $("unlock").textContent = "Unlocking…";
  $("lock-msg").textContent = "";
  try {
    const key = await deriveKey(pw, blob);
    const data = await openBlob(key, blob);
    await kvSet("key:" + blob.salt, key);
    $("pw").value = "";
    showList(data);
  } catch (e) {
    $("lock-msg").textContent = "Wrong password. Please try again.";
  } finally {
    $("unlock").disabled = false;
    $("unlock").textContent = "Unlock";
  }
}

async function lockPhone() {
  if (blob) await kvDel("key:" + blob.salt);
  rows = [];
  $("list").innerHTML = "";
  show("lock");
}

// ---------- list ----------
function showList(data) {
  rows = data.rows || [];
  const d = new Date(data.updated);
  updatedText = isNaN(d) ? "" : d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  $("updated").textContent = updatedText ? "Prices updated " + updatedText : "";
  const brands = [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort();
  $("brand").innerHTML = '<option value="">All brands</option>' +
    brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  for (const r of rows) {
    r._hay = [r.description, r.part_no, r.brand, r.model].join(" ").toLowerCase();
    r._compact = r._hay.replace(/[^a-z0-9]/g, "");
  }
  show("app");
  render();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function matches(r, words, brand) {
  if (brand && r.brand !== brand) return false;
  return words.every((w) => r._hay.includes(w) || (w.replace(/[^a-z0-9]/g, "") && r._compact.includes(w.replace(/[^a-z0-9]/g, ""))));
}

function shareLink(r) {
  const lines = [
    `*${r.description}*`,
    `Part No: ${r.part_no || "-"}`,
    `Brand: ${r.brand}${r.model ? " | Model: " + r.model : ""}`,
    `Price: ${r.selling_inr != null ? money.format(r.selling_inr) : "On request"}`,
  ];
  if (updatedText) lines.push(`_Price as of ${updatedText}_`);
  return "https://wa.me/?text=" + encodeURIComponent(lines.join("\n"));
}

function render() {
  const words = $("q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const brand = $("brand").value;
  const found = rows.filter((r) => matches(r, words, brand));
  const shown = found.slice(0, MAX_SHOW);
  $("count").textContent = words.length || brand
    ? `${found.length} of ${rows.length} parts`
    : `${rows.length} parts`;
  $("list").innerHTML = shown.map((r) => `
    <li class="item">
      <span class="desc">${esc(r.description || "-")}</span>
      <span class="price${r.selling_inr != null ? "" : " request"}">${r.selling_inr != null ? money.format(r.selling_inr) : "Price on request"}</span>
      <span class="meta"><span class="part">${esc(r.part_no || "No part no.")}</span>${r.brand ? `<span>${esc(r.brand)}</span>` : ""}${r.model ? `<span class="chip">${esc(r.model)}</span>` : ""}</span>
      <a class="share" href="${shareLink(r)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.7-.1l.9-1.1c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z"/></svg>
        Share
      </a>
    </li>`).join("");
  $("more").hidden = found.length <= MAX_SHOW;
  $("more").textContent = `Showing ${MAX_SHOW} of ${found.length}. Type more to narrow the search.`;
}

let pending = 0;
function scheduleRender() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(render);
}

document.addEventListener("DOMContentLoaded", () => {
  $("lock-form").addEventListener("submit", unlock);
  $("lock-btn").addEventListener("click", lockPhone);
  $("q").addEventListener("input", scheduleRender);
  $("brand").addEventListener("change", render);
  start();
});
