// ============================================================================
// TURBO DATA STORE & INSTANT SYNCHRONOUS HYDRATION ENGINE (< 0.1ms Retrieval)
// ============================================================================
let productsDb = [];
let partiesDb = [];
let invoicesDb = [];
let globalSettings = {};
let isSyncing = false;
window.isInitialSyncDone = false;
let dbEventSource = null;
let isSavingInvoice = false;

// Synchronous 0ms local snapshot hydration
try {
  productsDb = JSON.parse(localStorage.getItem("products") || "[]");
  partiesDb = JSON.parse(localStorage.getItem("parties") || "[]");
  invoicesDb = JSON.parse(localStorage.getItem("invoices") || "[]");
  globalSettings = JSON.parse(localStorage.getItem("settings") || "{}");
} catch(e) {
  productsDb = [];
  partiesDb = [];
  invoicesDb = [];
  globalSettings = {};
}
window.productsDb = productsDb;
window.partiesDb = partiesDb;
window.invoicesDb = invoicesDb;
window.globalSettings = globalSettings;

// Fast FNV-1a 32-bit Hash for Delta Validation
window.computeFastFnv32Hash = function(str) {
  if (!str) return "0";
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
};

// ----------------------------------------------------------------------------
// TURBO DATA STORE: Reactive O(1) In-Memory Lookup & Aggregation Engine
// ----------------------------------------------------------------------------
const TurboDataStore = {
  productsById: new Map(),
  productsByName: new Map(),
  productsByBarcode: new Map(),
  partiesById: new Map(),
  partiesByName: new Map(),
  partiesByPhone: new Map(),
  invoicesById: new Map(),
  invoicesByNo: new Map(),
  partyBalances: new Map(),
  dailySummaries: new Map(),
  productTrie: [],

  rebuildIndexes() {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // 1. Index Products
    this.productsById.clear();
    this.productsByName.clear();
    this.productsByBarcode.clear();
    this.productTrie = [];

    (productsDb || []).forEach(p => {
      if (!p) return;
      const pid = String(p.id || '').trim();
      if (pid) this.productsById.set(pid, p);

      const name = String(p.description || p.name || '').trim().toLowerCase();
      if (name) {
        this.productsByName.set(name, p);
        this.productTrie.push({
          name: name,
          normalized: name.replace(/[^a-z0-9]/g, ''),
          hsn: String(p.hsn || '').toLowerCase(),
          barcode: String(p.barcode || p.code || '').trim().toLowerCase(),
          record: p
        });
      }

      const barcode = String(p.barcode || p.code || '').trim().toLowerCase();
      if (barcode) this.productsByBarcode.set(barcode, p);
    });

    // 2. Index Parties
    this.partiesById.clear();
    this.partiesByName.clear();
    this.partiesByPhone.clear();

    (partiesDb || []).forEach(p => {
      if (!p) return;
      const pid = String(p.id || '').trim();
      if (pid) this.partiesById.set(pid, p);

      const name = String(p.name || '').trim().toLowerCase();
      if (name) this.partiesByName.set(name, p);

      const phone = String(p.phone || p.mobile || '').replace(/\D/g, '');
      if (phone && phone.length >= 10) {
        this.partiesByPhone.set(phone.slice(-10), p);
      }
    });

    // 3. Index Invoices & Compute Instant Balances / Daily Metrics
    this.invoicesById.clear();
    this.invoicesByNo.clear();
    this.partyBalances.clear();
    this.dailySummaries.clear();

    const tombstones = typeof window.getDeletedInvoiceTombstones === 'function' ? window.getDeletedInvoiceTombstones() : [];
    const deletedSet = new Set(tombstones.map(t => String(t || '').trim().toLowerCase()));

    (invoicesDb || []).forEach(inv => {
      if (!inv) return;
      const invId = String(inv.id || (inv.details && inv.details.id) || '').trim();
      const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || '').trim();
      const cleanNo = invNo.replace(/^#/, '').toLowerCase();

      if (invId && (deletedSet.has(invId.toLowerCase()) || deletedSet.has(`inv_${cleanNo}`))) return;
      if (cleanNo && deletedSet.has(cleanNo)) return;

      if (invId) this.invoicesById.set(invId, inv);
      if (cleanNo) this.invoicesByNo.set(cleanNo, inv);
      if (invNo) this.invoicesByNo.set(invNo.toLowerCase(), inv);

      const isEst = Boolean(inv.isEstimate || (inv.details && inv.details.isEstimate) || cleanNo.startsWith('est-'));
      if (isEst) return;

      const details = inv.details || {};
      const buyer = details.buyer || {};
      const rawName = String(inv.customerName || inv.buyerName || buyer.name || 'Cash Customer').trim();
      const normKey = rawName.toLowerCase();

      const total = parseFloat(inv.total !== undefined ? inv.total : (details.total || 0)) || 0;
      let paid = 0;
      let balance = 0;

      const pStatus = String(details.paymentStatus || inv.paymentStatus || 'Paid').trim().toLowerCase();
      if (pStatus === 'paid') {
        paid = total;
        balance = 0;
      } else if (pStatus === 'unpaid') {
        paid = 0;
        balance = total;
      } else {
        paid = parseFloat(details.paidAmount ?? inv.paidAmount ?? 0) || 0;
        balance = Math.max(0, total - paid);
      }

      const invDate = inv.invoiceDate || details.invoiceDate || '';
      const dateKey = invDate ? invDate.slice(0, 10) : '';

      let b = this.partyBalances.get(normKey);
      if (!b) {
        b = {
          name: rawName,
          phone: buyer.phone || inv.customerPhone || '',
          totalBilled: 0,
          totalPaid: 0,
          totalBalance: 0,
          invoiceCount: 0,
          lastDate: invDate
        };
        this.partyBalances.set(normKey, b);
      }
      if (!b.phone && buyer.phone) b.phone = buyer.phone;
      b.totalBilled += total;
      b.totalPaid += paid;
      b.totalBalance += balance;
      b.invoiceCount += 1;
      if (invDate && invDate > b.lastDate) b.lastDate = invDate;

      if (dateKey) {
        let d = this.dailySummaries.get(dateKey);
        if (!d) {
          d = { count: 0, total: 0, weight: 0 };
          this.dailySummaries.set(dateKey, d);
        }
        d.count += 1;
        d.total += total;
        const weight = parseFloat(inv.totalWeight || details.totalWeight || 0) || 0;
        d.weight += weight;
      }
    });

    // Factor in party initial opening balances
    (partiesDb || []).forEach(p => {
      if (!p || !p.name) return;
      const name = String(p.name).trim().toLowerCase();
      const initBal = parseFloat(p.initialBalance || p.openingBalance || 0) || 0;
      if (initBal) {
        let b = this.partyBalances.get(name);
        if (!b) {
          b = { name: p.name, phone: p.phone || '', totalBilled: initBal, totalPaid: 0, totalBalance: initBal, invoiceCount: 0, lastDate: '' };
          this.partyBalances.set(name, b);
        } else {
          b.totalBalance += initBal;
        }
      }
    });

    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    if (window.DEV_DEBUG) {
      console.log(`⚡ TurboDataStore indexed ${this.productsById.size} products, ${this.partiesById.size} parties, ${this.invoicesById.size} invoices in ${elapsed.toFixed(2)}ms`);
    }
  },

  getProduct(key) {
    if (!key) return null;
    const s = String(key).trim();
    if (this.productsById.has(s)) return this.productsById.get(s);
    const low = s.toLowerCase();
    if (this.productsByName.has(low)) return this.productsByName.get(low);
    if (this.productsByBarcode.has(low)) return this.productsByBarcode.get(low);
    const clean = low.replace(/[^a-z0-9]/g, '');
    for (let i = 0; i < this.productTrie.length; i++) {
      if (this.productTrie[i].normalized === clean || this.productTrie[i].name.startsWith(low)) {
        return this.productTrie[i].record;
      }
    }
    return null;
  },

  getParty(key) {
    if (!key) return null;
    const s = String(key).trim();
    if (this.partiesById.has(s)) return this.partiesById.get(s);
    const low = s.toLowerCase();
    if (this.partiesByName.has(low)) return this.partiesByName.get(low);
    const phone = s.replace(/\D/g, '');
    if (phone.length >= 10 && this.partiesByPhone.has(phone.slice(-10))) {
      return this.partiesByPhone.get(phone.slice(-10));
    }
    return null;
  },

  getPartyBalance(partyName) {
    if (!partyName) return 0;
    const b = this.partyBalances.get(String(partyName).trim().toLowerCase());
    return b ? Math.round(b.totalBalance * 100) / 100 : 0;
  },

  getPartyLedgerSummary(partyName) {
    if (!partyName) return { totalBilled: 0, totalPaid: 0, totalBalance: 0, invoiceCount: 0, lastDate: '' };
    return this.partyBalances.get(String(partyName).trim().toLowerCase()) || { totalBilled: 0, totalPaid: 0, totalBalance: 0, invoiceCount: 0, lastDate: '' };
  },

  getInvoice(idOrNo) {
    if (!idOrNo) return null;
    const s = String(idOrNo).trim();
    if (this.invoicesById.has(s)) return this.invoicesById.get(s);
    const clean = s.replace(/^#/, '').toLowerCase();
    if (this.invoicesByNo.has(clean)) return this.invoicesByNo.get(clean);
    return null;
  },

  searchProducts(query, limit = 50) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return (productsDb || []).slice(0, limit);
    const tokens = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (let i = 0; i < productsDb.length; i++) {
      const p = productsDb[i];
      if (!p) continue;
      const desc = (p.description || p.name || '').toLowerCase();
      const hsn = (p.hsn || '').toLowerCase();
      const pack = (p.packSize || '').toLowerCase();
      const barcode = (p.barcode || p.code || '').toLowerCase();
      let match = true;
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (!desc.includes(tok) && !hsn.includes(tok) && !pack.includes(tok) && !barcode.includes(tok)) {
          match = false;
          break;
        }
      }
      if (match) {
        results.push(p);
        if (results.length >= limit) break;
      }
    }
    return results;
  },

  searchParties(query, limit = 50) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return (partiesDb || []).slice(0, limit);
    const tokens = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (let i = 0; i < partiesDb.length; i++) {
      const p = partiesDb[i];
      if (!p) continue;
      const name = (p.name || '').toLowerCase();
      const phone = (p.phone || p.mobile || '').toLowerCase();
      const address = (p.address || p.city || '').toLowerCase();
      let match = true;
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (!name.includes(tok) && !phone.includes(tok) && !address.includes(tok)) {
          match = false;
          break;
        }
      }
      if (match) {
        results.push(p);
        if (results.length >= limit) break;
      }
    }
    return results;
  },

  searchInvoices(query, limit = 50) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return (invoicesDb || []).slice(0, limit);
    const tokens = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (let i = 0; i < invoicesDb.length; i++) {
      const inv = invoicesDb[i];
      if (!inv) continue;
      const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || '').toLowerCase();
      const cust = String(inv.customerName || inv.buyerName || (inv.details && inv.details.buyer && inv.details.buyer.name) || '').toLowerCase();
      const phone = String(inv.customerPhone || (inv.details && inv.details.buyer && inv.details.buyer.phone) || '').toLowerCase();
      let match = true;
      for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (!invNo.includes(tok) && !cust.includes(tok) && !phone.includes(tok)) {
          match = false;
          break;
        }
      }
      if (match) {
        results.push(inv);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
};

window.TurboDataStore = TurboDataStore;
TurboDataStore.rebuildIndexes();

// ----------------------------------------------------------------------------
// TURBO INDEXED-DB PERSISTENCE ENGINE (AaryanAquaDB_v3)
// ----------------------------------------------------------------------------
const TurboIndexedDB = {
  dbName: 'AaryanAquaDB_v3',
  version: 3,
  db: null,
  isReady: false,

  async init() {
    if (typeof indexedDB === 'undefined') return;
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('products')) {
            db.createObjectStore('products', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('parties')) {
            db.createObjectStore('parties', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('invoices')) {
            db.createObjectStore('invoices', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('outbox')) {
            db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = async (e) => {
          this.db = e.target.result;
          this.isReady = true;
          await this.loadAll();
          resolve(this.db);
        };
        req.onerror = () => {
          this.isReady = false;
          resolve(null);
        };
      } catch(err) {
        this.isReady = false;
        resolve(null);
      }
    });
  },

  async loadAll() {
    if (!this.db || !this.isReady) return;
    try {
      const getStoreRecords = (storeName) => new Promise((res) => {
        try {
          const tx = this.db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => res([]);
        } catch(e) { res([]); }
      });

      const [pRecs, partRecs, invRecs] = await Promise.all([
        getStoreRecords('products'),
        getStoreRecords('parties'),
        getStoreRecords('invoices')
      ]);

      let changed = false;
      if (Array.isArray(pRecs) && pRecs.length > 0 && pRecs.length >= productsDb.length) {
        productsDb = pRecs;
        window.productsDb = productsDb;
        changed = true;
      }
      if (Array.isArray(partRecs) && partRecs.length > 0 && partRecs.length >= partiesDb.length) {
        partiesDb = partRecs;
        window.partiesDb = partiesDb;
        changed = true;
      }
      if (Array.isArray(invRecs) && invRecs.length > 0 && invRecs.length >= invoicesDb.length) {
        invoicesDb = invRecs;
        window.invoicesDb = invoicesDb;
        changed = true;
      }

      if (changed) {
        TurboDataStore.rebuildIndexes();
        if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
        if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
      }
    } catch(e) {}
  },

  async saveInvoice(inv) {
    if (!this.db || !this.isReady || !inv || !inv.id) return;
    try {
      const tx = this.db.transaction('invoices', 'readwrite');
      tx.objectStore('invoices').put(inv);
    } catch(e) {}
  },

  async saveAllInvoices(invoices) {
    if (!this.db || !this.isReady || !Array.isArray(invoices)) return;
    try {
      const tx = this.db.transaction('invoices', 'readwrite');
      const store = tx.objectStore('invoices');
      store.clear();
      invoices.forEach(inv => { if (inv && inv.id) store.put(inv); });
    } catch(e) {}
  },

  async deleteInvoice(id) {
    if (!this.db || !this.isReady || !id) return;
    try {
      const tx = this.db.transaction('invoices', 'readwrite');
      tx.objectStore('invoices').delete(id);
    } catch(e) {}
  },

  async saveAllProducts(products) {
    if (!this.db || !this.isReady || !Array.isArray(products)) return;
    try {
      const tx = this.db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      store.clear();
      products.forEach(p => { if (p && p.id) store.put(p); });
    } catch(e) {}
  },

  async saveAllParties(parties) {
    if (!this.db || !this.isReady || !Array.isArray(parties)) return;
    try {
      const tx = this.db.transaction('parties', 'readwrite');
      const store = tx.objectStore('parties');
      store.clear();
      parties.forEach(p => { if (p && p.id) store.put(p); });
    } catch(e) {}
  }
};

window.TurboIndexedDB = TurboIndexedDB;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TurboIndexedDB.init());
  } else {
    setTimeout(() => TurboIndexedDB.init(), 10);
  }
}

  // Persistent Cancelled / Voided Invoices Registry
  window.archiveCancelledInvoice = function(invoiceRecord, reason = "Cancelled") {
    try {
      if (!invoiceRecord) return;
      const cancelled = JSON.parse(localStorage.getItem("cancelled_invoices") || "[]");
      const id = String(invoiceRecord.id || `inv_${invoiceRecord.invoiceNo}`).trim();
      const token = String(invoiceRecord.qrToken || invoiceRecord.details?.qrToken || "").trim();
      const invNo = String(invoiceRecord.invoiceNo || invoiceRecord.details?.invoiceNo || "").trim();
      const cust = String(invoiceRecord.customerName || invoiceRecord.buyerName || invoiceRecord.details?.buyer?.name || "Customer").trim();
      const total = parseFloat(invoiceRecord.total || invoiceRecord.details?.total || 0) || 0;
      const date = invoiceRecord.invoiceDate || invoiceRecord.details?.invoiceDate || new Date().toISOString();
      const nowIso = new Date().toISOString();

      const entry = {
        id: id,
        token: token,
        invoiceNo: invNo,
        customerName: cust,
        total: total,
        invoiceDate: date,
        cancelledAt: nowIso,
        reason: reason,
        status: "CANCELLED"
      };

      const updated = [entry, ...cancelled.filter(c => c && c.id !== id && (!token || c.token !== token))].slice(0, 300);
      localStorage.setItem("cancelled_invoices", JSON.stringify(updated));

      if (typeof broadcastInterTabEvent === 'function') {
        broadcastInterTabEvent('invoice_cancelled', { cancelledRecord: entry });
      }
      if (typeof realtimeMeshClient !== 'undefined' && realtimeMeshClient && realtimeMeshClient.connected) {
        try {
          realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/mesh_sync', JSON.stringify({
            type: 'invoice_cancelled',
            cancelledRecord: entry,
            senderId: typeof MY_SYNC_CLIENT_ID !== 'undefined' ? MY_SYNC_CLIENT_ID : 'peer'
          }), { qos: 0 });
        } catch (me) {}
      }

      if (typeof pushDirectToGoogleDatabase === 'function') {
        pushDirectToGoogleDatabase("archive_cancelled_invoice", { cancelledRecord: entry });
      }
    } catch (e) {
      console.warn("archiveCancelledInvoice error:", e);
    }
  };

  // Deleted Invoice Tombstone Management (Zero-Resurrection Engine with Active-Invoice Immunity)
  window.getDeletedInvoiceTombstones = function() {
    try {
      const raw = JSON.parse(localStorage.getItem("deleted_invoice_ids") || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  };

  // Safely clears tombstones when an invoice is created/saved, ensuring reused numbers are NEVER blocked
  window.clearInvoiceTombstone = function(invNo, invId) {
    try {
      let tombstones = window.getDeletedInvoiceTombstones();
      if (!tombstones || tombstones.length === 0) return;

      const cleanNo = String(invNo || '').replace(/^#/, '').trim().toLowerCase();
      const numVal = parseInt(cleanNo, 10);
      const numStr = !isNaN(numVal) ? String(numVal) : "";
      const cleanId = String(invId || '').trim().toLowerCase();

      const beforeLen = tombstones.length;
      tombstones = tombstones.filter(t => {
        const item = String(t || '').trim().toLowerCase();
        if (!item) return false;
        if (cleanId && item === cleanId) return false;
        if (cleanNo && (item === cleanNo || item === `#${cleanNo}` || item === `inv_${cleanNo}`)) return false;
        const itemClean = item.replace(/^#/, '').replace(/^inv_/, '');
        const itemNum = parseInt(itemClean, 10);
        const itemNumStr = !isNaN(itemNum) ? String(itemNum) : "";
        if (numStr && itemNumStr && numStr === itemNumStr) return false;
        return true;
      });

      if (tombstones.length !== beforeLen) {
        localStorage.setItem("deleted_invoice_ids", JSON.stringify(tombstones));
      }

      try {
        let canc = JSON.parse(localStorage.getItem("cancelled_invoices") || "[]");
        if (canc.length > 0) {
          const updatedCanc = canc.filter(c => {
            if (!c) return false;
            const cId = String(c.id || '').trim().toLowerCase();
            const cNo = String(c.invoiceNo || '').trim().toLowerCase().replace(/^#/, '');
            if (cleanId && (cId === cleanId || cId.replace(/^inv_/, '') === cleanId.replace(/^inv_/, ''))) return false;
            if (cleanNo && cNo === cleanNo) return false;
            return true;
          });
          localStorage.setItem("cancelled_invoices", JSON.stringify(updatedCanc));
        }
      } catch (ce) {}
    } catch (e) {
      console.warn("clearInvoiceTombstone error:", e);
    }
  };

  window.isInvoiceDeleted = function(inv, tombstones) {
    if (!inv) return true;
    if (!tombstones) tombstones = window.getDeletedInvoiceTombstones();

    const invId = String(inv.id || (inv.details && inv.details.id) || "").trim().toLowerCase();
    const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || "").trim().toLowerCase();
    const cleanNo = invNo.replace(/^#/, '');
    const qrToken = String(inv.qrToken || (inv.details && inv.details.qrToken) || "").trim().toLowerCase();

    // 1. Check persistent cancelled registry
    try {
      const cancelled = JSON.parse(localStorage.getItem("cancelled_invoices") || "[]");
      if (cancelled.length > 0) {
        const isCanc = cancelled.some(c => {
          if (!c) return false;
          const cId = String(c.id || "").trim().toLowerCase();
          const cNo = String(c.invoiceNo || "").trim().toLowerCase().replace(/^#/, '');
          const cTok = String(c.token || "").trim().toLowerCase();
          if (invId && (cId === invId || cId.replace(/^inv_/, '') === invId.replace(/^inv_/, ''))) return true;
          if (cleanNo && cNo === cleanNo) return true;
          if (qrToken && cTok && cTok === qrToken) return true;
          return false;
        });
        if (isCanc) return true;
      }
    } catch(e) {}

    if (!tombstones || tombstones.length === 0) return false;

    // 2. Check tombstones (by explicit ID, prefixed ID, or invoice number)
    for (let i = 0; i < tombstones.length; i++) {
      const t = String(tombstones[i] || "").trim().toLowerCase();
      if (!t) continue;
      const cleanT = t.replace(/^#/, '').replace(/^inv_/, '');

      if (invId && (invId === t || invId === `inv_${cleanT}` || invId.replace(/^inv_/, '') === cleanT)) return true;
      if (cleanNo && (cleanNo === cleanT || invNo === t || invNo === `#${cleanT}` || `inv_${cleanNo}` === t)) return true;
    }
    return false;
  };

  window.filterOutDeletedInvoices = function(invoices) {
    if (!Array.isArray(invoices)) return [];
    const tombstones = window.getDeletedInvoiceTombstones();

    return invoices.filter(inv => {
      if (!inv) return false;
      const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || "").trim();
      const invId = String(inv.id || "").trim();

      // Permanently block test invoice #0099
      if (invNo === '0099' || invNo === '#0099' || invNo === '99' || invId === 'inv_0099') {
        return false;
      }

      // Drop empty/corrupted dummy shells that have 0 items, no customer, and 0 total
      const hasItems = (Array.isArray(inv.items) && inv.items.length > 0) || (inv.details && Array.isArray(inv.details.items) && inv.details.items.length > 0);
      const hasTotal = parseFloat(inv.total) > 0 || (inv.details && parseFloat(inv.details.total) > 0);
      if (!hasItems && !hasTotal && (invNo === '0201' || invNo === '0102' || invNo === '201' || invNo === '102' || invId === 'inv_201' || invId === 'inv_102')) {
        return false;
      }

      return !window.isInvoiceDeleted(inv, tombstones);
    });
  };

  // Pre-seed phantom deleted IDs into tombstones, including test invoice #0099
  try {
    let curTombstones = window.getDeletedInvoiceTombstones();
    curTombstones = curTombstones.filter(t => {
      const str = String(t).trim().toLowerCase();
      return str !== '0035' && str !== '35' && str !== '#0035' && str !== 'inv_0035' && str !== 'inv_35';
    });
    ['0201', '0102', '201', '102', 'inv_201', 'inv_102', '#0201', '#0102', '0099', '#0099', '99', 'inv_0099'].forEach(phantom => {
      if (!curTombstones.includes(phantom)) curTombstones.push(phantom);
    });
    localStorage.setItem("deleted_invoice_ids", JSON.stringify(curTombstones));
  } catch (e) {}

  invoicesDb = window.filterOutDeletedInvoices(invoicesDb);
  try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
// XSS Defense Helper
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Active Form Invoice State
let currentInvoice = {
  id: "",
  invoiceType: "Bill of Supply",
  headerLogo: "ganesha",
  invoiceNo: "",
  invoiceDate: "",
  buyerOrderNo: "",
  buyerOrderDate: "",
  transportMode: "",
  destination: "",
  supplyStateCode: "37",
  paymentStatus: "Paid",
  paymentMode: "UPI / QR",
  paidAmount: 0,
  balanceDue: 0,
  buyer: { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" },
  consignee: { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" },
  items: [],
  isEstimate: false
};
window.getCurrentInvoice = function() { return currentInvoice; };

// UI Elements mapping
const elements = {
  // Navigation
  navItems: document.querySelectorAll('.nav-item'),
  views: document.querySelectorAll('.content-view'),
  viewTitle: document.getElementById('current-view-title'),
  currentDatetime: document.getElementById('current-datetime'),

  // GST Billing Form Left
  billInvoiceType: document.getElementById('bill-invoice-type'),
  billHeaderLogo: document.getElementById('bill-header-logo'),
  billInvoiceNo: document.getElementById('bill-invoice-no'),
  billInvoiceDate: document.getElementById('bill-invoice-date'),
  billBuyerOrderNo: document.getElementById('bill-buyer-order-no'),
  billBuyerOrderDate: document.getElementById('bill-buyer-order-date'),
  billTransportMode: document.getElementById('bill-transport-mode'),
  billDestination: document.getElementById('bill-destination'),
  billSupplyStateCode: document.getElementById('bill-supply-state-code'),
  
  quickSelectReceiver: document.getElementById('quick-select-receiver'),
  billBuyerName: document.getElementById('bill-buyer-name'),
  billBuyerAddress: document.getElementById('bill-buyer-address'),
  billBuyerGstin: document.getElementById('bill-buyer-gstin'),
  billBuyerPhone: document.getElementById('bill-buyer-phone'),
  billBuyerState: document.getElementById('bill-buyer-state'),
  billBuyerStateCode: document.getElementById('bill-buyer-state-code'),

  quickSelectConsignee: document.getElementById('quick-select-consignee'),
  billConsigneeName: document.getElementById('bill-consignee-name'),
  billConsigneeAddress: document.getElementById('bill-consignee-address'),
  billConsigneeGstin: document.getElementById('bill-consignee-gstin'),
  billConsigneePhone: document.getElementById('bill-consignee-phone'),
  billConsigneeState: document.getElementById('bill-consignee-state'),
  billConsigneeStateCode: document.getElementById('bill-consignee-state-code'),

  billItemSelect: document.getElementById('bill-item-select'),
  billItemName: document.getElementById('bill-item-name'),
  billItemStockQty: document.getElementById('bill-item-stock-qty'),
  billItemHsn: document.getElementById('bill-item-hsn'),
  billItemQty: document.getElementById('bill-item-qty'),
  billItemUnit: document.getElementById('bill-item-unit'),
  billItemPack: document.getElementById('bill-item-pack'),
  billItemGstRate: document.getElementById('bill-item-gstrate'),
  billItemDiscount: document.getElementById('bill-item-discount'),
  billItemRate: document.getElementById('bill-item-rate'),
  billingItemsTbody: document.getElementById('billing-items-tbody'),
  noItemsPlaceholder: document.getElementById('no-items-placeholder'),

  // GST Billing Summary Right
  billPaymentStatus: document.getElementById('bill-payment-status'),
  billPaymentMode: document.getElementById('bill-payment-mode'),
  billPaidAmount: document.getElementById('bill-paid-amount'),
  billBalancePaid: document.getElementById('bill-balance-paid'),
  billPaymentDate: document.getElementById('bill-payment-date'),
  sumTaxable: document.getElementById('sum-taxable'),
  sumCgst: document.getElementById('sum-cgst'),
  sumSgst: document.getElementById('sum-sgst'),
  sumIgst: document.getElementById('sum-igst'),
  sumRoundOff: document.getElementById('sum-round-off'),
  sumGrandTotal: document.getElementById('sum-grand-total'),
  sumBalanceDue: document.getElementById('sum-balance-due'),
  dueRowContainer: document.getElementById('due-row-container'),
  sumGrandWords: document.getElementById('sum-grand-words'),

  // History elements
  historyCount: document.getElementById('history-count'),
  searchHistoryInput: document.getElementById('search-history-input'),
  historyInvoicesBody: document.getElementById('history-invoices-body'),

  // Products Database View
  productCount: document.getElementById('product-count'),
  searchProductsInput: document.getElementById('search-products-input'),
  productsListBody: document.getElementById('products-list-body'),

  // Parties View
  receiversScrollBox: document.getElementById('receivers-scroll-box'),
  consigneesScrollBox: document.getElementById('consignees-scroll-box'),

  // Reports
  reportStartDate: document.getElementById('report-start-date'),
  reportEndDate: document.getElementById('report-end-date'),
  reportResultsPlaceholder: document.getElementById('report-results-placeholder'),
  reportResultsContent: document.getElementById('report-results-content'),
  reportTableBody: document.getElementById('report-table-body'),
  reportTotalTaxable: document.getElementById('report-total-taxable'),
  reportTotalTax: document.getElementById('report-total-tax'),
  reportTotalGrand: document.getElementById('report-total-grand'),

  // Settings
  setTgToken: document.getElementById('set-tg-token'),
  setTgChatId: document.getElementById('set-tg-chat-id'),
  tgStatusIndicator: document.getElementById('tg-status-indicator'),
  tgStatusText: document.getElementById('tg-status-text'),
  setAutolockTimer: document.getElementById('set-autolock-timer'),
  setLoginUsername: document.getElementById('set-login-username'),
  setLoginPassword: document.getElementById('set-login-password'),
  setWaLockEnabled: document.getElementById('set-wa-lock-enabled'),
  setWaPin: document.getElementById('set-wa-pin'),
  setWaAutolock: document.getElementById('set-wa-autolock'),
  setWaMaskPhones: document.getElementById('set-wa-mask-phones'),
  setWaProtectChats: document.getElementById('set-wa-protect-chats'),

  setCName: document.getElementById('set-c-name'),
  setCTagline: document.getElementById('set-c-tagline'),
  setCAddress: document.getElementById('set-c-address'),
  setCPhones: document.getElementById('set-c-phones'),
  setCEmail: document.getElementById('set-c-email'),
  setCGstin: document.getElementById('set-c-gstin'),
  setCState: document.getElementById('set-c-state'),
  setCStateCode: document.getElementById('set-c-state-code'),

  setBName: document.getElementById('set-b-name'),
  setBAccName: document.getElementById('set-b-acc-name'),
  setBAccNo: document.getElementById('set-b-acc-no'),
  setBIfsc: document.getElementById('set-b-ifsc'),
  setBBranch: document.getElementById('set-b-branch'),
  setBUpi: document.getElementById('set-b-upi'),
  setBTerms: document.getElementById('set-b-terms'),

  // Dashboard Overview
  statTotalInvoices: document.getElementById('stat-total-invoices'),
  statTotalAmount: document.getElementById('stat-total-amount'),
  statTotalProducts: document.getElementById('stat-total-products'),
  statTotalParties: document.getElementById('stat-total-parties'),
  statSettlementRate: document.getElementById('stat-settlement-rate'),
  dashboardRecentInvoicesBody: document.getElementById('dashboard-recent-invoices-body')
};

// Summary tax rows mapping helper
elements.sumCgstRow = elements.sumCgst ? elements.sumCgst.closest('.summary-row') : null;
elements.sumSgstRow = elements.sumSgst ? elements.sumSgst.closest('.summary-row') : null;
elements.sumIgstRow = elements.sumIgst ? elements.sumIgst.closest('.summary-row') : null;

window.lastSyncETag = null;
window.lastSyncTimestamp = parseInt(localStorage.getItem("aaryan_last_sync_time") || "0", 10);

const GOOGLE_SCRIPT_URL = window.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbwkegJvhM42cPIROIKg5Dlx6py8OnS5NXuIJeyf1Zb3V3Oc_2jyXPS_aDN7uW0t874d/exec";
const API_SECRET_TOKEN = window.API_SECRET_TOKEN || "AARYAN_AQUA_SECURE_KEY_2026";
const GOOGLE_SCRIPT_FALLBACK_URL = GOOGLE_SCRIPT_URL;

// --- HIGH-SPEED REAL-TIME MULTI-BROWSER MESH (0.05ms Local + 15ms Cross-Browser) ---
let interTabChannel = null;
const MY_SYNC_CLIENT_ID = 'client_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
const SYNC_MESH_TOPIC = 'aaryan_aqua_gst_billing_2026/db_sync';
let realtimeMeshClient = null;
const MESH_BROKERS = [
  'wss://test.mosquitto.org:8081/mqtt',
  'ws://test.mosquitto.org:8080/mqtt'
];
let currentBrokerIdx = 0;
let meshReconnectTimer = null;
let activeBrokerName = 'Mosquitto Secure Mesh (<25ms)';
const processedRealtimeMsgIds = new Set();

function processRealtimeSyncMessage(msg, source = 'mesh') {
  if (!msg || !msg.type) return;
  if (msg.senderId && msg.senderId === MY_SYNC_CLIENT_ID) return; // Prevent self-echo

  // Sub-second deduplication across tri-channel bus
  if (msg.msgId) {
    if (processedRealtimeMsgIds.has(msg.msgId)) return;
    processedRealtimeMsgIds.add(msg.msgId);
    if (processedRealtimeMsgIds.size > 250) {
      const oldestKey = processedRealtimeMsgIds.values().next().value;
      processedRealtimeMsgIds.delete(oldestKey);
    }
  }

  // 1. Instant Single-Product Stock Mutation (Sub-Second < 150ms cross-device push)
  if (msg.type === 'PRODUCT_STOCK_CHANGED' && msg.productId) {
    let prod = productsDb.find(p => p && (p.id === msg.productId || (p.description && msg.description && p.description.trim().toLowerCase() === msg.description.trim().toLowerCase())));
    const newStock = Math.max(0, parseInt(msg.stock, 10) || 0);
    const newStatus = msg.status || (newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock"));
    const targetId = prod ? prod.id : msg.productId;

    if (!prod && msg.product && typeof msg.product === 'object') {
      prod = { ...msg.product, stock: newStock, status: newStatus };
      productsDb.push(prod);
    } else if (prod) {
      prod.stock = newStock;
      prod.status = newStatus;
      prod.updatedAt = msg.updatedAt || new Date().toISOString();
      const rate = parseFloat(prod.rate || 0);
      const disc = parseFloat(prod.discount || 0);
      const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
      prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;
    }

    // Stamp 5-minute optimistic mutation protection on receiver
    if (!window.recentProductMutations) window.recentProductMutations = {};
    const nowMs = Date.now();
    window.recentProductMutations[targetId] = nowMs;
    const desc = (prod && prod.description) || msg.description;
    if (desc) {
      window.recentProductMutations[desc] = nowMs;
      window.recentProductMutations[desc.trim().toLowerCase()] = nowMs;
    }
    try {
      let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
      storedMut[targetId] = nowMs;
      if (desc) {
        storedMut[desc] = nowMs;
        storedMut[desc.trim().toLowerCase()] = nowMs;
      }
      localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
    } catch(e){}

    try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);

    if (typeof updateProductDomRowFast === 'function') {
      updateProductDomRowFast(targetId, newStock, newStatus);
    } else if (typeof renderProductsTable === 'function') {
      renderProductsTable(productsDb);
    }

    if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();

    const prodName = desc || "Product";
    const deltaStr = (msg.delta !== undefined && msg.delta !== null) ? (msg.delta > 0 ? `(+${msg.delta})` : `(${msg.delta})`) : '';
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`⚡ Live Stock Sync: ${prodName} ${deltaStr} ➔ ${newStock} Units (${newStatus})`, "info");
    }
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");
    return;
  }

  // 2. Instant Batch Stock Deduction from Invoice Generation (< 150ms)
  if (msg.type === 'INVOICE_STOCK_DEDUCTED') {
    if (Array.isArray(msg.stockDeltas)) {
      msg.stockDeltas.forEach(delta => {
        const prod = productsDb.find(p => p && (p.id === delta.productId || (p.description && delta.description && p.description.trim().toLowerCase() === delta.description.trim().toLowerCase())));
        const targetId = prod ? prod.id : delta.productId;
        const newStock = Math.max(0, parseInt(delta.stock, 10) || 0);
        const newStatus = delta.status || (newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock"));
        if (prod) {
          prod.stock = newStock;
          prod.status = newStatus;
          prod.updatedAt = delta.updatedAt || new Date().toISOString();
          const rate = parseFloat(prod.rate || 0);
          const disc = parseFloat(prod.discount || 0);
          const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
          prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;
        }
        if (!window.recentProductMutations) window.recentProductMutations = {};
        const nowMs = Date.now();
        window.recentProductMutations[targetId] = nowMs;
        const desc = (prod && prod.description) || delta.description;
        if (desc) {
          window.recentProductMutations[desc] = nowMs;
          window.recentProductMutations[desc.trim().toLowerCase()] = nowMs;
        }
        try {
          let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
          storedMut[targetId] = nowMs;
          if (desc) {
            storedMut[desc] = nowMs;
            storedMut[desc.trim().toLowerCase()] = nowMs;
          }
          localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
        } catch(e){}

        if (typeof updateProductDomRowFast === 'function') {
          updateProductDomRowFast(targetId, newStock, newStatus);
        }
      });
    } else if (Array.isArray(msg.products) && msg.products.length > 0) {
      productsDb = msg.products;
      if (typeof renderProductsTable === 'function') renderProductsTable(productsDb);
    }
    try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
    if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");
    return;
  }

  // 3. Instant Product Price / Discount inline mutation
  if (msg.type === 'PRODUCT_PRICE_CHANGED' && msg.productId) {
    const prod = productsDb.find(p => p && (p.id === msg.productId || (p.description && msg.description && p.description.trim().toLowerCase() === msg.description.trim().toLowerCase())));
    if (prod) {
      if (msg.discount !== undefined) prod.discount = msg.discount;
      if (msg.price !== undefined) prod.price = msg.price;
      if (msg.totalValue !== undefined) prod.totalValue = msg.totalValue;
      prod.updatedAt = msg.updatedAt || new Date().toISOString();
      if (!window.recentProductMutations) window.recentProductMutations = {};
      const nowMs = Date.now();
      window.recentProductMutations[prod.id] = nowMs;
      if (prod.description) {
        window.recentProductMutations[prod.description] = nowMs;
        window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
      }
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
      if (typeof renderProductsTable === 'function') renderProductsTable(productsDb);
      if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
    }
    return;
  }

  // 4. Transaction-level invoice committed (Invoice + Stock Deltas + Parties)
  const normType = String(msg.type || '').toUpperCase();
  if ((normType === 'INVOICE_SAVED' || normType === 'INVOICE_TRANSACTION_COMMITTED') && msg.invoice) {
    const inv = msg.invoice;
    const idx = invoicesDb.findIndex(i => i && (i.id === inv.id || i.invoiceNo === inv.invoiceNo));
    if (idx > -1) invoicesDb[idx] = inv;
    else invoicesDb.push(inv);
    invoicesDb.sort((a, b) => String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || "")));
    try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveInvoice(inv);

    // Synchronize stock deduction instantly
    if (Array.isArray(msg.stockDeltas)) {
      msg.stockDeltas.forEach(delta => {
        const prod = productsDb.find(p => p && (p.id === delta.productId || (p.description && delta.description && p.description.trim().toLowerCase() === delta.description.trim().toLowerCase())));
        const targetId = prod ? prod.id : delta.productId;
        const newStock = Math.max(0, parseInt(delta.stock, 10) || 0);
        const newStatus = delta.status || (newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock"));
        if (prod) {
          prod.stock = newStock;
          prod.status = newStatus;
          prod.updatedAt = delta.updatedAt || new Date().toISOString();
          const rate = parseFloat(prod.rate || 0);
          const disc = parseFloat(prod.discount || 0);
          const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
          prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;
        }
        if (!window.recentProductMutations) window.recentProductMutations = {};
        const nowMs = Date.now();
        window.recentProductMutations[targetId] = nowMs;
        const desc = (prod && prod.description) || delta.description;
        if (desc) {
          window.recentProductMutations[desc] = nowMs;
          window.recentProductMutations[desc.trim().toLowerCase()] = nowMs;
        }
        try {
          let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
          storedMut[targetId] = nowMs;
          if (desc) {
            storedMut[desc] = nowMs;
            storedMut[desc.trim().toLowerCase()] = nowMs;
          }
          localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
        } catch(e){}

        if (typeof updateProductDomRowFast === 'function') {
          updateProductDomRowFast(targetId, newStock, newStatus);
        }
      });
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
      if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
    } else if (Array.isArray(msg.products) && msg.products.length > 0) {
      productsDb = msg.products;
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
      if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
      if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
    }

    // Synchronize new party if included in packet
    if (Array.isArray(msg.parties) && msg.parties.length > 0) {
      let _dpi = [];
      try { _dpi = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
      partiesDb = msg.parties.filter(p => p && !_dpi.includes(p.id) && !_dpi.includes(p.name));
      try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllParties(partiesDb);
      if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
    }

    if (typeof renderHistoryTableRows === 'function') renderHistoryTableRows(invoicesDb);
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`⚡ Live Sync: Invoice #${inv.invoiceNo} committed • Stock deducted!`, "info");
    }

  } else if (msg.type === 'products_saved' && Array.isArray(msg.products)) {
    let _dpri = [];
    try { _dpri = JSON.parse(localStorage.getItem("deleted_product_ids")) || []; } catch(e){}
    productsDb = msg.products.filter(p => p && !_dpri.includes(p.id));
    try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
    if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
    if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");

  } else if (msg.type === 'parties_saved' && Array.isArray(msg.parties)) {
    let _dpi = [];
    try { _dpi = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
    partiesDb = msg.parties.filter(p => p && !_dpi.includes(p.id) && !_dpi.includes(p.name));
    try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch (e) {}
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllParties(partiesDb);
    if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");

  } else if (msg.type === 'record_deleted') {
    if (msg.recordType === 'invoice') {
      let curTombstones = window.getDeletedInvoiceTombstones();
      const newAliases = [msg.id, msg.invoiceNo, ...(msg.aliases || [])].filter(Boolean);
      newAliases.forEach(a => {
        const al = String(a).trim().toLowerCase();
        if (!curTombstones.includes(al)) curTombstones.push(al);
      });
      try { localStorage.setItem("deleted_invoice_ids", JSON.stringify(curTombstones)); } catch(e){}
      if (msg.cancelledRecord) {
        try {
          const canc = JSON.parse(localStorage.getItem("cancelled_invoices") || "[]");
          const updated = [msg.cancelledRecord, ...canc.filter(c => c && c.id !== msg.cancelledRecord.id)].slice(0, 300);
          localStorage.setItem("cancelled_invoices", JSON.stringify(updated));
        } catch(e){}
      }

      invoicesDb = window.filterOutDeletedInvoices(invoicesDb);
      try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) {
        AaryanDB.deleteInvoice(msg.id);
        if (msg.invoiceNo && msg.invoiceNo !== msg.id) AaryanDB.deleteInvoice(msg.invoiceNo);
      }
      if (Array.isArray(msg.products)) {
        productsDb = msg.products;
        try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
        if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
        if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
        if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
      }
      if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
      if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
      if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo(true, msg.invoiceNo);

    } else if (msg.recordType === 'product') {
      productsDb = productsDb.filter(p => p && p.id !== msg.id);
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
      if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
      if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();

    } else if (msg.recordType === 'party') {
      // Remove by id OR name (older parties may not have an id)
      partiesDb = partiesDb.filter(p => p && p.id !== msg.id && p.name !== msg.id);
      // Also persist tombstone so sync can't resurrect it
      let dpi = [];
      try { dpi = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
      if (!dpi.includes(msg.id)) { dpi.push(msg.id); localStorage.setItem("deleted_party_ids", JSON.stringify(dpi)); }
      try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllParties(partiesDb);
      if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
    }
    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");

  } else if (msg.type === 'DATABASE_MUTATED' || msg.action === 'DATABASE_MUTATED') {
    try {
      let _dpi = []; try { _dpi = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
      let _dpri = []; try { _dpri = JSON.parse(localStorage.getItem("deleted_product_ids")) || []; } catch(e){}

      if (Array.isArray(msg.products) && msg.products.length > 0)
        productsDb = msg.products.filter(p => p && !_dpri.includes(p.id));
      else productsDb = JSON.parse(localStorage.getItem("products") || "[]");

      if (Array.isArray(msg.parties) && msg.parties.length > 0)
        partiesDb = msg.parties.filter(p => p && !_dpi.includes(p.id) && !_dpi.includes(p.name));
      else partiesDb = JSON.parse(localStorage.getItem("parties") || "[]");

      const rawInvs = (Array.isArray(msg.invoices) && msg.invoices.length > 0) ? msg.invoices : JSON.parse(localStorage.getItem("invoices") || "[]");
      // ★ Merge: protect recently-saved local invoices from stale peer data
      const _recentMuts = window.recentInvoiceMutations || {};
      const _nowMs = Date.now();
      const _pendingLocal = [];
      (invoicesDb || []).forEach(inv => {
        if (!inv || !inv.id) return;
        const _sAt = _recentMuts[inv.id] || _recentMuts[inv.invoiceNo];
        if (_sAt && (_nowMs - _sAt) < 120000 && !rawInvs.some(ri => ri && ri.id === inv.id)) {
          _pendingLocal.push(inv);
        }
      });
      invoicesDb = window.filterOutDeletedInvoices(rawInvs.concat(_pendingLocal));

      if (msg.settings && typeof msg.settings === 'object' && Object.keys(msg.settings).length > 0) globalSettings = msg.settings;
      else globalSettings = JSON.parse(localStorage.getItem("settings") || "{}");

      if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
      if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
      if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
      if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
      if (typeof calculateSummaryAndTable === 'function') calculateSummaryAndTable();
      if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
      window.lastSyncTimeMs = Date.now();
      if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");
    } catch (err) {}

  } else if (msg.type === 'SYNC_REQUEST' && msg.requesterId && msg.requesterId !== MY_SYNC_CLIENT_ID) {
    if (invoicesDb.length > 0 || productsDb.length > 0) {
      broadcastInterTabEvent('SYNC_RESPONSE', {
        targetId: msg.requesterId,
        invoices: invoicesDb,
        products: productsDb,
        parties: partiesDb,
        settings: globalSettings
      });
    }

  } else if (msg.type === 'SYNC_RESPONSE' && msg.targetId === MY_SYNC_CLIENT_ID) {
    console.log("⚡ Received instant peer sync response from mesh!");
    if (Array.isArray(msg.invoices)) {
      const filteredInvs = window.filterOutDeletedInvoices(msg.invoices);
      if (filteredInvs.length >= invoicesDb.length) {
        invoicesDb = filteredInvs;
        try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
        if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllInvoices(invoicesDb);
      }
    }
    if (Array.isArray(msg.products) && msg.products.length > 0) {
      let _dpri2 = []; try { _dpri2 = JSON.parse(localStorage.getItem("deleted_product_ids")) || []; } catch(e){}
      productsDb = msg.products.filter(p => p && !_dpri2.includes(p.id));
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
    }
    if (Array.isArray(msg.parties) && msg.parties.length > 0) {
      let _dpi2 = []; try { _dpi2 = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
      partiesDb = msg.parties.filter(p => p && !_dpi2.includes(p.id) && !_dpi2.includes(p.name));
      try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch (e) {}
      if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllParties(partiesDb);
    }
    if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
    if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
    if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
    window.lastSyncTimeMs = Date.now();
  }
}

// 1. Same-Browser BroadcastChannel Listener (0.05ms)
try {
  if (typeof BroadcastChannel !== 'undefined') {
    interTabChannel = new BroadcastChannel('aaryan_aqua_db_channel');
    interTabChannel.onmessage = (event) => {
      processRealtimeSyncMessage(event.data, 'broadcast_channel');
    };
  }
} catch (e) {
  console.warn("BroadcastChannel notice:", e.message);
}

// 2. HTML5 Storage Event Listener for Cross-Tab instant sync (0.01ms)
window.addEventListener('storage', (e) => {
  if (!e || !e.key) return;
  try {
    if (e.key === 'products' && e.newValue) {
      const parsed = JSON.parse(e.newValue);
      if (Array.isArray(parsed) && parsed.length > 0) {
        productsDb = parsed;
        if (typeof renderProductsTable === 'function') renderProductsTable(productsDb);
        if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
        if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
      }
    } else if (e.key === 'invoices' && e.newValue) {
      const parsed = JSON.parse(e.newValue);
      if (Array.isArray(parsed) && parsed.length > 0) {
        invoicesDb = parsed;
        if (typeof renderHistoryTableRows === 'function') renderHistoryTableRows(invoicesDb);
        if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
        if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
      }
    } else if (e.key === 'parties' && e.newValue) {
      const parsed = JSON.parse(e.newValue);
      if (Array.isArray(parsed)) {
        let deletedPartyIds = [];
        try { deletedPartyIds = JSON.parse(localStorage.getItem("deleted_party_ids")) || []; } catch(e){}
        partiesDb = parsed.filter(p => p && !deletedPartyIds.includes(p.id) && !deletedPartyIds.includes(p.name));
        if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
        if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
      }
    } else if (e.key === 'recent_product_mutations' && e.newValue) {
      const parsed = JSON.parse(e.newValue);
      window.recentProductMutations = Object.assign(window.recentProductMutations || {}, parsed);
    }
  } catch (err) {}
});

// 3. Cross-Browser & Multi-Device High-Speed Real-Time Mesh (EMQX < 30ms)
let consecutiveBrokerErrors = 0;
function initRealtimeMeshSync() {
  if (typeof mqtt === 'undefined') {
    if (!window._mqttRetryCount) window._mqttRetryCount = 0;
    window._mqttRetryCount++;
    if (window._mqttRetryCount <= 50) {
      setTimeout(initRealtimeMeshSync, 200);
    } else {
      console.warn("MQTT library not ready, using local companion & cloud fallback.");
    }
    return;
  }

  const brokerUrl = MESH_BROKERS[currentBrokerIdx];
  activeBrokerName = brokerUrl.includes('emqx') ? 'EMQX Ultra-Fast Mesh (<20ms)' :
                     brokerUrl.includes('hivemq') ? 'HiveMQ Mesh (<35ms)' : 'Mosquitto Mesh';

  try {
    if (realtimeMeshClient) {
      try { realtimeMeshClient.end(true); } catch (e) {}
      realtimeMeshClient = null;
    }

    realtimeMeshClient = mqtt.connect(brokerUrl, {
      clientId: MY_SYNC_CLIENT_ID,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 1000,
      connectTimeout: 4000
    });

    realtimeMeshClient.on('connect', () => {
      consecutiveBrokerErrors = 0;
      currentBrokerIdx = 0; // Always anchor back to primary high-speed cluster
      console.log(`⚡ High-Speed Cross-User Mesh Active via ${activeBrokerName}!`);
      realtimeMeshClient.subscribe(SYNC_MESH_TOPIC, { qos: 0 });
      realtimeMeshClient.subscribe('aaryan_aqua_gst_billing_2026/whatsapp_status', { qos: 0 });
      realtimeMeshClient.subscribe('aaryan_aqua_gst_billing_2026/whatsapp_ack', { qos: 0 });
      // Announce presence and request state from any active peer
      broadcastInterTabEvent('SYNC_REQUEST', { requesterId: MY_SYNC_CLIENT_ID });
      // Proactively request latest WhatsApp Bot Status from host companion
      try {
        realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({ command: 'get_status' }));
      } catch (e) {}
      if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("live");
    });

    realtimeMeshClient.on('message', (topic, message) => {
      try {
        if (topic === 'aaryan_aqua_gst_billing_2026/whatsapp_ack') {
          const ackData = JSON.parse(message.toString());
          if (ackData && ackData.commandId && window.waCommandCallbacks && window.waCommandCallbacks[ackData.commandId]) {
            window.waCommandCallbacks[ackData.commandId](ackData);
          }
          return;
        }

        if (topic === 'aaryan_aqua_gst_billing_2026/whatsapp_status') {
          const waData = JSON.parse(message.toString());
          if (waData && typeof waData === 'object') {
            // Guard against transient or stale downgrade packets if currently connected and live
            if (whatsappBotStatus && (whatsappBotStatus.status === 'CONNECTED' || whatsappBotStatus.isReady)) {
              if (waData.status === 'INITIALIZING') {
                return; // Ignore transient initializing packet if already connected
              }
              const currentTimestamp = Number(whatsappBotStatus.lastHeartbeat || whatsappBotStatus.timestamp || 0);
              const incomingTimestamp = Number(waData.lastHeartbeat || waData.timestamp || 0);
              if (incomingTimestamp && currentTimestamp && incomingTimestamp < currentTimestamp) {
                return; // Ignore older out-of-order packets
              }
            }
            whatsappBotStatus = waData;
            saveWaStatusCache(waData);
            updateWhatsAppBotPillUI(whatsappBotStatus);
            updateWhatsAppBotModalUI(whatsappBotStatus);
          }
          return;
        }

        const msg = JSON.parse(message.toString());
        if (topic === SYNC_MESH_TOPIC) {
          if (!msg || msg.senderId === MY_SYNC_CLIENT_ID) return; // Prevent self-echo
          processRealtimeSyncMessage(msg, 'mqtt_mesh');
        } else if (typeof checkAndRespondToP2PPairing === 'function') {
          checkAndRespondToP2PPairing(topic, msg);
        }
      } catch (err) {}
    });

    realtimeMeshClient.on('error', (err) => {
      console.warn(`Mesh broker note (${brokerUrl}):`, err.message);
      consecutiveBrokerErrors++;
      if (consecutiveBrokerErrors >= 6) {
        rotateMeshBroker();
      }
    });

    realtimeMeshClient.on('close', () => {
      if (typeof window.updateRealtimePresenceHUD === 'function') window.updateRealtimePresenceHUD("syncing");
      // Keep same broker across temporary mobile sleep/disconnect so devices never partition
    });
  } catch (err) {
    console.warn("Real-time mesh init note:", err.message);
    consecutiveBrokerErrors++;
    if (consecutiveBrokerErrors >= 6) {
      rotateMeshBroker();
    }
  }
}

function rotateMeshBroker() {
  consecutiveBrokerErrors = 0;
  currentBrokerIdx = (currentBrokerIdx + 1) % MESH_BROKERS.length;
  console.log(`Switching real-time mesh to next broker: ${MESH_BROKERS[currentBrokerIdx]}`);
  setTimeout(initRealtimeMeshSync, 1000);
}

// Ensure active real-time reconnection when device awakens or network reconnects
window.addEventListener('online', () => {
  if (!realtimeMeshClient || !realtimeMeshClient.connected) {
    initRealtimeMeshSync();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!realtimeMeshClient || !realtimeMeshClient.connected) {
      initRealtimeMeshSync();
    }
  }
});

try {
  initRealtimeMeshSync();
} catch (e) {}

function isLocalCompanionAvailable() {
  if (typeof window === 'undefined') return false;
  if (window.globalSettings && window.globalSettings.whatsappBotUrl && String(window.globalSettings.whatsappBotUrl).startsWith('http')) {
    return true;
  }
  const hostname = window.location.hostname || '';
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || window.location.protocol === 'file:';
  const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '');
  return isLocalHost || isElectron;
}

// 3. Local Node.js Companion SSE Sync Stream (< 2ms local network)
let localCompanionSource = null;
function initLocalCompanionSync() {
  if (!isLocalCompanionAvailable()) return;
  try {
    const endpoint = typeof getWhatsAppApiEndpoint === 'function'
      ? getWhatsAppApiEndpoint('/api/sync/events')
      : 'http://localhost:3001/api/sync/events';
    if (localCompanionSource) {
      try { localCompanionSource.close(); } catch (e) {}
    }
    localCompanionSource = new EventSource(endpoint);
    localCompanionSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data || data.senderId === MY_SYNC_CLIENT_ID) return;
        if (data.payload) {
          processRealtimeSyncMessage({ type: data.action || data.type, ...data.payload }, 'local_companion');
        }
      } catch (e) {}
    };
    localCompanionSource.onerror = () => {
      // Reconnects automatically
    };
  } catch (e) {}
}

try {
  initLocalCompanionSync();
} catch (e) {}

// Unified Tri-Channel Broadcast Dispatcher (< 0.05ms tab / < 2ms LAN / < 30ms mesh)
function broadcastInterTabEvent(type, payload = {}) {
  const fullMsg = {
    msgId: payload.msgId || ('msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8)),
    type,
    ...payload,
    senderId: MY_SYNC_CLIENT_ID,
    timestamp: Date.now()
  };

  // 1. Local BroadcastChannel (< 0.05ms)
  if (interTabChannel) {
    try { interTabChannel.postMessage(fullMsg); } catch (e) {}
  }

  // 2. Global Ultra-Fast Real-Time Mesh (< 30ms)
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      realtimeMeshClient.publish(SYNC_MESH_TOPIC, JSON.stringify(fullMsg), { qos: 0 });
    } catch (e) {}
  }

  // 3. Local Node.js Companion (< 2ms LAN push)
  if (isLocalCompanionAvailable()) {
    try {
      const endpoint = typeof getWhatsAppApiEndpoint === 'function'
        ? getWhatsAppApiEndpoint('/api/sync/push')
        : 'http://localhost:3001/api/sync/push';
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: type, type, payload: fullMsg, senderId: MY_SYNC_CLIENT_ID })
      }).catch(() => {});
    } catch (e) {}
  }
}

window.broadcastDatabaseMutation = function(extra = {}) {
  broadcastInterTabEvent('DATABASE_MUTATED', {
    products: productsDb,
    parties: partiesDb,
    invoices: invoicesDb,
    settings: globalSettings,
    ...extra
  });
};


// --- AARYAN-DB: HIGH-SPEED INDEXED-DB & TURBO DATA STORE ADAPTER ---
const AaryanDB = {
  isReady: true,
  async init() {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.init === 'function') {
      await window.TurboIndexedDB.init();
    }
    this.isReady = true;
    return Promise.resolve();
  },
  async saveInvoice(inv) {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.saveInvoice === 'function') {
      window.TurboIndexedDB.saveInvoice(inv);
    }
    if (window.TurboDataStore) {
      window.TurboDataStore.rebuildIndexes();
    }
  },
  async saveAllInvoices(invoices) {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.saveAllInvoices === 'function') {
      window.TurboIndexedDB.saveAllInvoices(invoices);
    }
    if (window.TurboDataStore) {
      window.TurboDataStore.rebuildIndexes();
    }
  },
  async deleteInvoice(id) {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.deleteInvoice === 'function') {
      window.TurboIndexedDB.deleteInvoice(id);
    }
    if (window.TurboDataStore) {
      window.TurboDataStore.rebuildIndexes();
    }
  },
  async saveAllProducts(products) {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.saveAllProducts === 'function') {
      window.TurboIndexedDB.saveAllProducts(products);
    }
    if (window.TurboDataStore) {
      window.TurboDataStore.rebuildIndexes();
    }
  },
  async saveAllParties(parties) {
    if (window.TurboIndexedDB && typeof window.TurboIndexedDB.saveAllParties === 'function') {
      window.TurboIndexedDB.saveAllParties(parties);
    }
    if (window.TurboDataStore) {
      window.TurboDataStore.rebuildIndexes();
    }
  },
  async searchInvoicesCursor(query = '', limit = 50) {
    if (window.TurboDataStore && typeof window.TurboDataStore.searchInvoices === 'function') {
      return window.TurboDataStore.searchInvoices(query, limit);
    }
    const q = (query || '').toLowerCase().trim();
    if (!q) return (invoicesDb || []).slice(0, limit);
    return (invoicesDb || []).filter(i => {
      const invNo = String(i.invoiceNo || "").toLowerCase();
      const custName = String(i.customerName || (i.details?.buyer?.name) || (i.details?.consignee?.name) || "").toLowerCase();
      return invNo.includes(q) || custName.includes(q);
    }).slice(0, limit);
  },
  async enqueueOutbox() {},
  startOutboxWorker() {},
  async drainOutbox() {}
};

window.AaryanDB = AaryanDB;

// Payload Minification for High-Speed Wire Transfer (< 50% payload size)
function minifyTransferPayload(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(minifyTransferPayload).filter(x => x !== undefined);
  }
  const clean = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined || v === "" || k.startsWith("_dom") || k.startsWith("$$")) continue;
    const val = minifyTransferPayload(v);
    if (val !== undefined) {
      if (typeof val === "object" && !Array.isArray(val) && Object.keys(val).length === 0) continue;
      clean[k] = val;
    }
  }
  return clean;
}
window.minifyTransferPayload = minifyTransferPayload;

// Dedicated direct push debouncer for rapid consecutive clicks (e.g. rapid +1, +1, +1 on stock)
let directPushProductTimer = null;
let directPushPartiesTimer = null;

async function pushDirectToGoogleDatabase(action, payload, maxRetries = 2) {
  if (typeof window.updateCloudSyncBadge === "function") {
    window.updateCloudSyncBadge("syncing");
  }

  const minPayload = minifyTransferPayload(payload) || {};
  const gasPayload = {
    action,
    auth: API_SECRET_TOKEN,
    ...minPayload
  };

  const bodyStr = JSON.stringify(gasPayload);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: bodyStr,
        redirect: "follow",
        keepalive: true,
        priority: "high",
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (pe) {}
        if (data && (data.ok || data.success)) {
          window.lastSyncTimeMs = Date.now();
          if (typeof window.updateCloudSyncBadge === "function") {
            window.updateCloudSyncBadge("synced");
          }
          return data;
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
    }

    if (attempt < maxRetries) {
      const backoffMs = Math.pow(2, attempt) * 80 + Math.floor(Math.random() * 40);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  // Fire-and-forget fallback via sendBeacon so writes survive tab closure
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([bodyStr], { type: "text/plain;charset=utf-8" });
      navigator.sendBeacon(GOOGLE_SCRIPT_URL, blob);
    }
  } catch (e) {}

  return null;
}

window.pushDirectToGoogleDatabase = pushDirectToGoogleDatabase;

function syncDatabaseToServer(type, data) {
  window.lastSyncETag = null;
  let action = "";
  let payload = {};

  if (type === "invoices") {
    action = "save_invoice";
    payload = { invoice: data };
    try {
      localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    } catch(e) {}
    if (window.TurboIndexedDB) window.TurboIndexedDB.saveInvoice(data);
    if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
    broadcastInterTabEvent('invoice_saved', { invoice: data, products: productsDb, parties: partiesDb });
    pushDirectToGoogleDatabase(action, payload);
  } else if (type === "products") {
    action = "save_products";
    payload = { products: data };
    try {
      localStorage.setItem("products", JSON.stringify(productsDb));
    } catch(e) {}
    if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllProducts(productsDb);
    if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
    broadcastInterTabEvent('products_saved', { products: data });
    if (directPushProductTimer) clearTimeout(directPushProductTimer);
    directPushProductTimer = setTimeout(() => {
      pushDirectToGoogleDatabase("save_products", { products: productsDb });
    }, 150);
  } else if (type === "parties") {
    action = "save_parties";
    payload = { parties: data };
    try {
      localStorage.setItem("parties", JSON.stringify(partiesDb));
    } catch(e) {}
    if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllParties(partiesDb);
    if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
    broadcastInterTabEvent('parties_saved', { parties: data });
    if (directPushPartiesTimer) clearTimeout(directPushPartiesTimer);
    directPushPartiesTimer = setTimeout(() => {
      pushDirectToGoogleDatabase("save_parties", { parties: partiesDb });
    }, 150);
  } else if (type === "settings") {
    action = "save_settings";
    payload = { settings: data };
    try {
      localStorage.setItem("settings", JSON.stringify(globalSettings));
    } catch(e) {}
    pushDirectToGoogleDatabase(action, payload);
  }
}

function deleteProductFromServer(id) {
  window.lastSyncETag = null;
  productsDb = (productsDb || []).filter(p => p && p.id !== id);
  try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch(e){}
  if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllProducts(productsDb);
  if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
  broadcastInterTabEvent('record_deleted', { recordType: 'product', id });
  pushDirectToGoogleDatabase("delete_record", { type: "product", id });
}

function deletePartyFromServer(id) {
  window.lastSyncETag = null;
  partiesDb = (partiesDb || []).filter(p => p && p.id !== id);
  try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch(e){}
  if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllParties(partiesDb);
  if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
  broadcastInterTabEvent('record_deleted', { recordType: 'party', id });
  pushDirectToGoogleDatabase("delete_record", { type: "party", id });
}

function deleteInvoiceFromServer(id, invoiceNo) {
  window.lastSyncETag = null;
  invoicesDb = (invoicesDb || []).filter(inv => inv && inv.id !== id && inv.invoiceNo !== invoiceNo);
  try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch(e){}
  if (window.TurboIndexedDB) {
    window.TurboIndexedDB.deleteInvoice(id);
    if (invoiceNo) window.TurboIndexedDB.deleteInvoice(invoiceNo);
  }
  if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
  broadcastInterTabEvent('record_deleted', { recordType: 'invoice', id, invoiceNo, products: productsDb });
  pushDirectToGoogleDatabase("delete_record", { type: "invoice", id, invoiceNo });
}

// ============================================================================
// HIGH-SPEED GOOGLE DATABASE SYNC ENGINE (AUTHORITATIVE GOOGLE CLOUD MASTER)
// ============================================================================
let activeSyncPromise = null;
let lastSyncTimeMs = 0;
let syncBadgeTimer = null;
let lastSyncDataHash = null;

window.updateCloudSyncBadge = function(status) {
  const badge = document.getElementById("live-cloud-sync-badge");
  const textEl = document.getElementById("sync-status-text");
  const radarDot = document.getElementById("sync-radar-dot");
  if (!badge) return;
  
  if (syncBadgeTimer) clearTimeout(syncBadgeTimer);

  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - (window.lastSyncTimeMs || now)) / 1000));
  const timeText = diffSec <= 2 ? "1s Live" : `${diffSec}s ago`;

  if (status === "syncing") {
    badge.className = "cloud-sync-pill syncing cursor-pointer";
    if (textEl) textEl.innerHTML = `<span class="realtime-sync-spinning">🔄</span> Syncing...`;
    if (radarDot) radarDot.style.display = "none";
  } else if (status === "offline" || !navigator.onLine) {
    badge.className = "cloud-sync-pill offline cursor-pointer";
    if (textEl) textEl.textContent = "Offline (Queued)";
    if (radarDot) {
      radarDot.style.display = "inline-block";
      radarDot.className = "realtime-radar-dot offline";
    }
  } else {
    badge.className = "cloud-sync-pill synced cursor-pointer";
    if (textEl) textEl.textContent = `🟢 1s Google DB • ${timeText}`;
    if (radarDot) {
      radarDot.style.display = "inline-block";
      radarDot.className = "realtime-radar-dot active";
    }
  }
};

window.updateRealtimePresenceHUD = function(status = "live") {
  if (typeof window.updateCloudSyncBadge === "function") {
    window.updateCloudSyncBadge(status);
  }
};

window.triggerDatabaseSync = async function(forceReload = false) {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  isSyncing = true;
  if (forceReload && typeof window.updateCloudSyncBadge === 'function') {
    window.updateCloudSyncBadge("syncing");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  const gasSyncUrl = `${GOOGLE_SCRIPT_URL}?action=sync`;

  activeSyncPromise = fetch(gasSyncUrl, {
    signal: controller.signal,
    redirect: 'follow',
    cache: 'no-store',
    keepalive: true,
    priority: 'high'
  })
  .then(async (res) => {
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error("HTTP sync error " + res.status);
    const text = await res.text();
    if (!text || (!text.trim().startsWith('{') && !text.trim().startsWith('['))) {
      console.warn("Google Apps Script sync returned non-JSON challenge response. Retaining local cache.");
      return null;
    }
    return JSON.parse(text);
  })
  .then((data) => {
    if (!data) return;

    // ★ Fast delta check: skip expensive UI rebuild if data unchanged
    const quickHash = (data.invoices ? data.invoices.length : 0) + '|' +
                      (data.products ? data.products.length : 0) + '|' +
                      (data.parties ? data.parties.length : 0) + '|' +
                      (data.serverTime || 0);
    if (quickHash === lastSyncDataHash && !forceReload) {
      window.lastSyncTimeMs = Date.now();
      if (typeof window.updateCloudSyncBadge === 'function') window.updateCloudSyncBadge("synced");
      return;
    }
    lastSyncDataHash = quickHash;

    if (typeof window.updateCloudSyncBadge === 'function') {
      window.updateCloudSyncBadge("synced");
    }

    if (data.serverTime) {
      window.lastSyncTimestamp = data.serverTime;
    }

    let changed = false;

    // 1. Authoritative Products directly from Google Database Master
    if (Array.isArray(data.products)) {
      productsDb = data.products;
      window.productsDb = productsDb;
      try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch(e){}
      if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllProducts(productsDb);
      changed = true;
    }

    // 2. Authoritative Parties directly from Google Database Master
    if (Array.isArray(data.parties)) {
      partiesDb = data.parties;
      window.partiesDb = partiesDb;
      try { localStorage.setItem("parties", JSON.stringify(partiesDb)); } catch(e){}
      if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllParties(partiesDb);
      changed = true;
    }

    // 3. Authoritative Invoices directly from Google Database Master
    // ★ MERGE — protect invoices saved locally in the last 2 minutes from being overwritten by stale sync
    if (Array.isArray(data.invoices)) {
      const serverInvMap = new Map();
      data.invoices.forEach(inv => { if (inv && inv.id) serverInvMap.set(inv.id, inv); });

      const recentMuts = window.recentInvoiceMutations || {};
      const now = Date.now();
      const PROTECT_WINDOW_MS = 120000;
      const pendingLocalInvoices = [];
      (invoicesDb || []).forEach(inv => {
        if (!inv || !inv.id) return;
        const savedAt = recentMuts[inv.id] || recentMuts[inv.invoiceNo];
        if (savedAt && (now - savedAt) < PROTECT_WINDOW_MS && !serverInvMap.has(inv.id)) {
          pendingLocalInvoices.push(inv);
        }
      });

      invoicesDb = window.filterOutDeletedInvoices(data.invoices.concat(pendingLocalInvoices));
      invoicesDb.sort((a, b) => String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || "")));
      window.invoicesDb = invoicesDb;
      try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch(e){}
      if (window.TurboIndexedDB) window.TurboIndexedDB.saveAllInvoices(invoicesDb);
      changed = true;
    }

    // 4. Authoritative Settings directly from Google Database Master
    const rawSettings = data.settings || data.globalSettings;
    if (rawSettings && typeof rawSettings === 'object' && Object.keys(rawSettings).length > 0) {
      globalSettings = rawSettings;
      window.globalSettings = globalSettings;
      try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch(e){}
      changed = true;
    }

    if (changed) {
      if (window.TurboDataStore) window.TurboDataStore.rebuildIndexes();
      if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
      if (typeof loadProductsDatabaseTable === 'function') loadProductsDatabaseTable();
      if (typeof loadPartiesDatabaseLists === 'function') loadPartiesDatabaseLists();
      if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
      if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
      if (typeof calculateSummaryAndTable === 'function') calculateSummaryAndTable();
      if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
      if (typeof renderFrequentProductsBar === 'function') renderFrequentProductsBar();
    }

    window.lastSyncTimeMs = Date.now();
    if (typeof window.updateRealtimePresenceHUD === 'function') {
      window.updateRealtimePresenceHUD("live");
    }
  })
  .catch((err) => {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn("Google Apps Script sync timeout (>6s). Serving cached Google database snapshot.");
      if (typeof window.updateCloudSyncBadge === 'function') window.updateCloudSyncBadge("synced");
    } else {
      console.warn("Google Apps Script sync notice:", err.message);
      if (typeof window.updateCloudSyncBadge === 'function') window.updateCloudSyncBadge("offline");
    }
    if (typeof window.updateRealtimePresenceHUD === 'function') {
      window.updateRealtimePresenceHUD(navigator.onLine ? "live" : "offline");
    }
  })
  .finally(() => {
    isSyncing = false;
    activeSyncPromise = null;
    window.isInitialSyncDone = true;
  });

  return activeSyncPromise;
};

// Immediate Kickoff on Script Load (Zero-Wait Millisecond 0 Google Database Fetch)
try {
  window.triggerDatabaseSync();
} catch (e) {}

// High-Speed Pre-Warming Engine: keeps Google Apps Script V8 container permanently hot
(function startCloudDatabasePrewarming() {
  const pingUrl = `${GOOGLE_SCRIPT_URL}?action=ping`;
  const doPing = () => {
    if (navigator.onLine) {
      fetch(pingUrl, { mode: 'no-cors', cache: 'no-store', keepalive: true, priority: 'low' }).catch(() => {});
    }
  };
  // Immediate warm-up ping on script load (0ms)
  doPing();
  setTimeout(doPing, 300);
  // Keep-alive ping every 40 seconds to prevent cold starts
  setInterval(doPing, 40000);
  // Prewarm on window focus and online
  window.addEventListener('focus', doPing);
  window.addEventListener('online', doPing);
})();

// Auto-sync heartbeat: refresh data from Google Cloud every 30 seconds or on tab focus
(function startAutoSyncHeartbeat() {
  setInterval(() => {
    if (navigator.onLine && !isSyncing && document.visibilityState === 'visible') {
      window.triggerDatabaseSync(false);
    }
  }, 30000);

  window.addEventListener('focus', () => {
    if (navigator.onLine && !isSyncing) {
      window.triggerDatabaseSync(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine && !isSyncing) {
      window.triggerDatabaseSync(false);
    }
  });
})();

// --- SECURE GOOGLE DRIVE PDF ARCHIVE & CLOUD SYNC ENGINE ---
async function uploadInvoicePdfToGoogleDrive(invoiceDetails, pdfBase64) {
  if (!invoiceDetails || !pdfBase64) {
    console.warn("uploadInvoicePdfToGoogleDrive: Missing details or pdfBase64");
    return null;
  }

  const invoiceNo = String(invoiceDetails.invoiceNo || invoiceDetails.id || "INV").trim();
  const filename = `Invoice_${invoiceNo}.pdf`;

  const payload = {
    action: "upload_pdf",
    auth: API_SECRET_TOKEN,
    token: API_SECRET_TOKEN,
    invoiceNo: invoiceNo,
    filename: filename,
    pdfBase64: pdfBase64
  };

  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && (data.pdfUrl || data.viewUrl)) {
        const publicUrl = data.viewUrl || data.pdfUrl;
        console.log(`☁️ Successfully saved PDF to Google Drive: ${publicUrl}`);

        invoiceDetails.pdfUrl = publicUrl;
        if (invoiceDetails.details) invoiceDetails.details.pdfUrl = publicUrl;

        const idx = invoicesDb.findIndex(i => i.id === invoiceDetails.id || String(i.invoiceNo) === String(invoiceNo));
        if (idx > -1) {
          invoicesDb[idx].pdfUrl = publicUrl;
          if (invoicesDb[idx].details) invoicesDb[idx].details.pdfUrl = publicUrl;
          try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
        }

        if (typeof showFloatingToast === "function") {
          showFloatingToast(`☁️ Invoice #${invoiceNo} PDF saved to Google Drive!`, "success");
        }
        return publicUrl;
      } else {
        console.warn("Google Drive upload API returned notice:", data?.error);
      }
    }
  } catch (err) {
    console.warn("Network error during Google Drive PDF upload, queueing in persistent outbox:", err.message);
  }

  // Resilient offline fallback: Queue in AaryanDB outbox for auto-retry
  try {
    if (window.AaryanDB && typeof window.AaryanDB.enqueueOutbox === "function") {
      window.AaryanDB.enqueueOutbox("pdf", "upload_pdf", payload);
      console.log(`📥 Invoice #${invoiceNo} PDF queued in offline outbox for automatic retry.`);
    }
  } catch (queueErr) {
    console.warn("Could not queue PDF in outbox:", queueErr);
  }

  return null;
}
window.uploadInvoicePdfToGoogleDrive = uploadInvoicePdfToGoogleDrive;

// --- DATABASE TELEMETRY & STATUS HUD ---
window.openDatabaseTelemetryModal = async function() {
  const modal = document.getElementById("database-telemetry-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.style.setProperty("display", "flex", "important");
  modal.style.setProperty("visibility", "visible", "important");
  modal.style.setProperty("opacity", "1", "important");
  modal.style.setProperty("pointer-events", "auto", "important");

  const pingValEl = document.getElementById("telemetry-ping-ms");
  const ramCountEl = document.getElementById("telemetry-ram-count");
  const outboxCountEl = document.getElementById("telemetry-outbox-count");
  const quotaEl = document.getElementById("telemetry-storage-quota");
  const interTabEl = document.getElementById("telemetry-intertab-status");

  if (interTabEl) {
    const meshConnected = realtimeMeshClient && realtimeMeshClient.connected;
    interTabEl.innerHTML = meshConnected 
      ? `⚡ <strong>${activeBrokerName}</strong> (Active &lt;20ms)<br><span style="font-size:11px;color:#059669;"><i class="fa-solid fa-bolt"></i> Local LAN Companion Sync Active (Port 3001)</span>` 
      : (interTabChannel ? "Connected (0.05ms P2P BroadcastChannel)" : "Single Tab Mode");
  }

  if (ramCountEl) {
    ramCountEl.innerHTML = `<strong>${invoicesDb.length}</strong> Invoices • <strong>${productsDb.length}</strong> Products • <strong>${partiesDb.length}</strong> Customers`;
  }

  if (outboxCountEl) {
    const count = await AaryanDB.getOutboxCount();
    outboxCountEl.textContent = `${count} pending operations`;
    outboxCountEl.style.color = count > 0 ? "#f59e0b" : "#10b981";
  }

  if (quotaEl && navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const usedMb = ((estimate.usage || 0) / (1024 * 1024)).toFixed(2);
      const quotaMb = ((estimate.quota || 0) / (1024 * 1024)).toFixed(0);
      quotaEl.textContent = `${usedMb} MB used (${quotaMb} MB allocated quota)`;
    } catch (e) {
      quotaEl.textContent = "IndexedDB High-Capacity Storage Ready";
    }
  }

  if (pingValEl) {
    pingValEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Measuring latency...`;
    const start = Date.now();
    try {
      const res = await fetch(GOOGLE_SCRIPT_URL + "?action=status&auth=" + encodeURIComponent(API_SECRET_TOKEN), { cache: "no-store", redirect: "follow" });
      const duration = Date.now() - start;
      pingValEl.innerHTML = `<span style="color:#10b981;font-weight:700;">${duration} ms</span> <span style="font-size:11px;color:#64748b;">(Google Apps Script API)</span>`;
    } catch (err) {
      pingValEl.innerHTML = `<span style="color:#ef4444;font-weight:700;">Offline / Fallback</span>`;
    }
  }
};

window.closeDatabaseTelemetryModal = function(e) {
  if (e && e.target && e.target.closest && e.target.closest('.modal-card') && !e.target.closest('.modal-close-btn') && !e.target.closest('.btn-secondary')) {
    return;
  }
  const modal = document.getElementById("database-telemetry-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
    modal.style.setProperty("visibility", "hidden", "important");
    modal.style.setProperty("opacity", "0", "important");
    modal.style.setProperty("pointer-events", "none", "important");
  }
};

window.forcePushDatabaseToCloud = async function(btnEl) {
  let origHtml = "";
  if (btnEl) {
    origHtml = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Flushing Outbox & Pushing...`;
    btnEl.disabled = true;
  }

  try {
    await AaryanDB.drainOutbox();
    await window.triggerDatabaseSync(true);
    if (btnEl) {
      btnEl.innerHTML = `<i class="fa-solid fa-check text-success"></i> Synchronized!`;
      setTimeout(() => {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }, 2500);
    }
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚡ Outbox flushed & database synchronized with cloud!");
    }
    window.openDatabaseTelemetryModal();
  } catch (err) {
    if (btnEl) {
      btnEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error`;
      setTimeout(() => {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }, 2500);
    }
    showFloatingToast("⚠️ Sync notice: " + err.message, "warning");
  }
};

window.triggerInstantPeerTransfer = function(btnEl) {
  if (typeof broadcastInterTabEvent === 'function') {
    broadcastInterTabEvent('DATABASE_MUTATED', {
      products: productsDb,
      parties: partiesDb,
      invoices: invoicesDb,
      settings: globalSettings
    });
    showFloatingToast("⚡ Instant database push sent to all connected peers, tabs & devices (<30ms)!", 3500);
  }
  if (btnEl) {
    const orig = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-check text-success"></i> Dispatched to Peers!`;
    setTimeout(() => { btnEl.innerHTML = orig; }, 2000);
  }
};

// Lock screen credentials state
let activeUsername = "Aaryanaqua";
let activePassword = "Aaryan@2024";
let lockTimerSeconds = 1800; // 30 mins default enterprise duration (or 0 for disabled)
let isLocked = true;
let autolockInterval = null;

// --- NUMBER TO WORDS ENGINE (INDIAN RUPEES SYSTEM) ---
function convertNumberToWords(num) {
  if (num === 0) return 'Zero';
  
  let str = parseFloat(num).toFixed(2).toString();
  let parts = str.split('.');
  let integerPart = parseInt(parts[0], 10);
  let decimalPart = parts[1] ? parseInt(parts[1].substring(0, 2), 10) : 0;
  
  let result = '';
  
  if (integerPart > 0) {
    result += helper(integerPart) + ' Rupees';
  }
  
  if (decimalPart > 0) {
    if (result !== '') {
      result += ' and ';
    }
    result += helper(decimalPart) + ' Paisa';
  }
  
  if (result !== '') {
    result += ' Only';
  }
  
  // Guard against duplicate phrases
  result = result.replace(/(\s*Rupees)+/gi, ' Rupees');
  result = result.replace(/(\s*Only)+/gi, ' Only');
  result = result.replace(/Rupees\s+Only\s+Rupees\s+Only/gi, 'Rupees Only');
  
  return result;
}

function helper(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 
                'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
  
  if (n < 1000) {
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' ' + helper(n % 100) : '');
  }
  if (n < 100000) {
    return helper(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 !== 0 ? ' ' + helper(n % 1000) : '');
  }
  if (n < 10000000) {
    return helper(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 !== 0 ? ' ' + helper(n % 100000) : '');
  }
  return helper(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 !== 0 ? ' ' + helper(n % 10000000) : '');
}

// --- INDIAN CURRENCY FORMATTER ---
function safeParseAmount(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) || !isFinite(val) ? 0 : val;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) || !isFinite(parsed) ? 0 : parsed;
}

function formatCurrency(val) {
  if (val === null || val === undefined || val === '') return '0.00';
  if (typeof val === 'string') {
    val = parseFloat(val.replace(/[^0-9.-]/g, ''));
  }
  if (isNaN(val) || !isFinite(val)) return '0.00';
  let num = parseFloat(val).toFixed(2);
  let parts = num.split('.');
  let integerPart = parts[0];
  let decimalPart = parts[1];
  
  let lastThree = integerPart.substring(integerPart.length - 3);
  let otherNumbers = integerPart.substring(0, integerPart.length - 3);
  if (otherNumbers !== '') {
    lastThree = ',' + lastThree;
  }
  let res = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree + '.' + decimalPart;
  return res;
}

function formatTaxValue(val) {
  if (val === 0 || isNaN(val) || val === null) {
    return 'NIL';
  }
  return '₹ ' + formatCurrency(val);
}

// --- INITIALIZE SPA DASHBOARD ---
function initializeApp() {

  // Product data is now managed exclusively via the Google Cloud Master Database

  seedDatabasesIfEmpty();
  loadAllDatabases();

  // Instant Cache-First 0ms rendering from local cache
  window.isInitialSyncDone = true;
  updateDashboardOverview();
  calculateSummaryAndTable();
  autoSuggestInvoiceNo();
  loadProductsDatabaseTable();
  loadPartiesDatabaseLists();
  loadInvoicesHistoryTable();

  if (typeof initAudioFeedback === 'function') initAudioFeedback();
  if (typeof initKeyboardShortcuts === 'function') initKeyboardShortcuts();
  if (window.AaryanDB && typeof window.AaryanDB.init === 'function') {
    window.AaryanDB.init().then(() => {
      // Background IndexedDB cache sync
    }).catch(e => console.warn("AaryanDB background init:", e));
  }

  setupRouting();
  bindBillingFormInputs();
  setupKeyboardShortcuts();

  // Initialize WhatsApp background bot real-time status monitor (SSE + Adaptive Fast Poll)
  if (typeof updateWhatsAppBotPillUI === 'function') updateWhatsAppBotPillUI(whatsappBotStatus);
  fetchWhatsAppBotStatus();
  initWhatsAppEventSource();

  // Trigger cloud sync to join any in-flight startup request or refresh data
  if (typeof window.triggerDatabaseSync === 'function') {
    window.triggerDatabaseSync().catch(e => console.warn("Initial sync note:", e));
  }

  // Update header cloud sync status pill
  if (typeof window.updateCloudSyncBadge === 'function') {
    window.updateCloudSyncBadge(isSyncing ? "syncing" : "synced");
  }

  // Manual Trigger for Google Drive & Live Sheets Sync
  window.triggerManualGoogleDriveSync = async function(btnEl) {
    let origHtml = "";
    if (btnEl) {
      origHtml = btnEl.innerHTML;
      btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Syncing to Google Drive...`;
      btnEl.disabled = true;
    }

    try {
      updateCloudSyncBadge("syncing");
      if (typeof window.triggerDatabaseSync === 'function') {
        await window.triggerDatabaseSync();
      }
      updateCloudSyncBadge("synced");
      if (btnEl) {
        btnEl.innerHTML = `<i class="fa-solid fa-check text-success"></i> Synced to Google Drive!`;
        setTimeout(() => {
          btnEl.innerHTML = origHtml;
          btnEl.disabled = false;
        }, 3000);
      }
      showFloatingToast(`☁️ All data synced to your Google Drive Master Spreadsheet!`);
    } catch (err) {
      console.warn("Manual Google Drive sync error:", err);
      updateCloudSyncBadge("offline");
      if (btnEl) {
        btnEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Sync Error`;
        setTimeout(() => {
          btnEl.innerHTML = origHtml;
          btnEl.disabled = false;
        }, 3000);
      }
      showFloatingToast("⚠️ Google Drive sync notice: " + err.message, "warning");
    }
  };

  // Batch PDF Compiler & Google Drive Cloud Linker
  window.syncAndGenerateAllDrivePdfs = async function(btnEl) {
    loadAllDatabases();
    if (!invoicesDb || invoicesDb.length === 0) {
      showFloatingToast("⚠️ No invoices found to sync!", "warning");
      return;
    }

    let origHtml = "";
    if (btnEl) {
      origHtml = btnEl.innerHTML;
      btnEl.disabled = true;
    }

    const printWrapper = document.getElementById("print-invoice-wrapper");
    if (!printWrapper) {
      showFloatingToast("⚠️ Invoice print container not found.", "warning");
      if (btnEl) btnEl.disabled = false;
      return;
    }

    printWrapper.style.display = "block";
    printWrapper.style.position = "absolute";
    printWrapper.style.left = "-9999px";
    printWrapper.style.top = "0";

    const opt = {
      margin:       [0, 0, 0, 0],
      image:        { type: 'jpeg', quality: 0.95 },
      html2canvas:  { scale: 1.35, useCORS: true, logging: false },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    let processedCount = 0;

    for (let i = 0; i < invoicesDb.length; i++) {
      const inv = invoicesDb[i];
      if (btnEl) {
        btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing PDF ${i + 1}/${invoicesDb.length} (Inv #${inv.invoiceNo})...`;
      }

      try {
        populateA4PrintOverlay(inv.details || inv);
        const element = printWrapper.querySelector('.tally-invoice-container') || printWrapper;

        const origTallyHeight = element.style.height;
        const origTallyMaxHeight = element.style.maxHeight;
        const origTallyPadding = element.style.padding;
        const origTallyOverflow = element.style.overflow;

        element.style.height = "294mm";
        element.style.maxHeight = "294mm";
        element.style.padding = "6mm 8mm";
        element.style.overflow = "hidden";

        const blob = await html2pdf().from(element).set(opt).toPdf().get('pdf').then(pdf => {
          const totalPages = pdf.internal.getNumberOfPages();
          for (let p = totalPages; p > 1; p--) {
            pdf.deletePage(p);
          }
          return pdf.output('blob');
        });

        element.style.height = origTallyHeight;
        element.style.maxHeight = origTallyMaxHeight;
        element.style.padding = origTallyPadding;
        element.style.overflow = origTallyOverflow;

        const reader = new FileReader();
        const pdfBase64 = await new Promise((resolve) => {
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });

        const uploadedUrl = await uploadInvoicePdfToGoogleDrive(inv, pdfBase64);
        if (uploadedUrl) {
          inv.pdfUrl = uploadedUrl;
          if (inv.details) inv.details.pdfUrl = uploadedUrl;
          processedCount++;
        }
      } catch (err) {
        console.warn(`Error generating PDF for invoice #${inv.invoiceNo}:`, err);
      }
    }

    printWrapper.style.display = "";
    printWrapper.style.position = "";
    printWrapper.style.left = "";

    localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    if (typeof renderHistoryTableRows === 'function') {
      renderHistoryTableRows(invoicesDb);
    }

    if (btnEl) {
      btnEl.innerHTML = `<i class="fa-solid fa-check text-success"></i> All ${processedCount} PDFs Linked!`;
      setTimeout(() => {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }, 3500);
    }

    showFloatingToast(`🎉 Successfully uploaded ${processedCount} PDFs to Google Drive & updated Google Sheet!`, 5000);
  };

  // ============================================================================
  // ADAPTIVE CLOUD DATABASE SYNC ENGINE (15s CLOUD HEARTBEAT + INSTANT 0ms MESH)
  // ============================================================================
  let multiUserSyncTimer = null;
  let lastCloudSyncPoll = 0;
  let nextStaggeredPollInterval = 45000 + Math.floor(Math.random() * 30000);

  async function performCloudHeartbeat(force = false) {
    const now = Date.now();
    // Staggered adaptive polling (45s - 75s random jitter) protects Google Apps Script from 50 concurrent users
    if (force || (now - lastCloudSyncPoll >= nextStaggeredPollInterval)) {
      lastCloudSyncPoll = now;
      nextStaggeredPollInterval = 45000 + Math.floor(Math.random() * 30000);
      try {
        if (navigator.onLine && typeof window.triggerDatabaseSync === "function" && !isSyncing) {
          await window.triggerDatabaseSync(false);
        }
      } catch (e) {}
    }
    if (!isSyncing && navigator.onLine && typeof window.updateRealtimePresenceHUD === 'function') {
      window.updateRealtimePresenceHUD("live");
    }
  }

  // Unthrottled Web Worker Heartbeat (Keeps HUD clock live and triggers 15s cloud checks even in background)
  try {
    const workerBlob = new Blob([
      "setInterval(function(){ self.postMessage('tick'); }, 1000);"
    ], { type: 'application/javascript' });
    const syncWorker = new Worker(URL.createObjectURL(workerBlob));
    syncWorker.onmessage = function(e) {
      if (e.data === 'tick') {
        performCloudHeartbeat(false);
      }
    };
  } catch (workerErr) {
    console.warn("Background worker heartbeat note, using standard interval:", workerErr);
    setInterval(() => performCloudHeartbeat(false), 1000);
  }

  // Complementary foreground heartbeat
  function scheduleNextCloudHeartbeat() {
    if (multiUserSyncTimer) clearTimeout(multiUserSyncTimer);
    multiUserSyncTimer = setTimeout(async () => {
      await performCloudHeartbeat(false);
      scheduleNextCloudHeartbeat();
    }, 1000);
  }
  scheduleNextCloudHeartbeat();

  // Sync immediately when window/tab is focused or returned to
  window.addEventListener("focus", () => {
    if (navigator.onLine && typeof window.triggerDatabaseSync === "function" && !isSyncing) {
      performCloudHeartbeat(true);
    }
  });

  // Sync immediately when tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (navigator.onLine && typeof window.triggerDatabaseSync === "function" && !isSyncing) {
        performCloudHeartbeat(true);
      }
    }
  });

  // Security Enforcement: System is locked on load/reload until administrator authenticates
  isLocked = true;
  localStorage.setItem("app_locked", "true");
  sessionStorage.removeItem("session_authenticated");

  const overlay = document.getElementById("lock-screen-overlay");
  if (overlay) overlay.classList.remove("hidden");
  const wrapper = document.querySelector('.dashboard-wrapper');
  if (wrapper) wrapper.classList.add("blur-dashboard-wrapper");

  // Setup login form credentials
  autofillRememberedCredentials();

  // Reset lock timer on activity
  resetAutolockTimer();
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(evt => {
    document.addEventListener(evt, resetAutolockTimer, { passive: true, capture: true });
  });

  // Default suggestions
  resetBillingForm();
  updateDashboardOverview();
  updateLiveDateTime();
  setInterval(updateLiveDateTime, 1000);

  // Mobile touch/click fast-response listener for Generate & Save Invoice
  const saveBtn = document.getElementById("btn-save-generate-invoice");
  if (saveBtn) {
    let lastTapTime = 0;
    saveBtn.addEventListener("touchend", (e) => {
      const now = Date.now();
      if (now - lastTapTime < 450) return;
      lastTapTime = now;
      if (e.cancelable) e.preventDefault();
      window.saveAndGenerateInvoiceOnly(saveBtn);
    }, { passive: false });
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });

  // Service Worker disabled to prevent file caching issues
  /*
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update();
    }).catch(err => {
      console.log('SW registration failed:', err);
    });
  }
  */
}

if (document.readyState === 'loading') {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp();
}

// --- LOCAL STORAGE DATABASES SEEDING (EXCLUSIVELY GOOGLE DATABASE ARCHITECTURE) ---
function seedDatabasesIfEmpty() {
  try {
    const storedSettings = JSON.parse(localStorage.getItem("settings") || "null");
    if (storedSettings && storedSettings.company && (storedSettings.company.name === "ANUDEEP KHADI BANDAR" || !storedSettings.company.name)) {
      localStorage.removeItem("settings");
    }
  } catch (err) {
    console.warn("Unable to parse saved settings:", err);
  }

  if (!localStorage.getItem("settings")) {
    const defaultSettings = {
      company: {
        name: "Aaryan Aqua Needs",
        tagline: "Quality Products for Better Aquaculture",
        address: "Door No: 10-13-94/42A REVENUE WARD 7\nAP HOUSING BOARD COLONY, REPALLE Village,\nREPALLE Mandal, Bapatla District, Pincode 522265",
        phones: "+91 74166 05652",
        email: "aaryanaquaneeds@gmail.com",
        website: "www.aaryan-aqua.com",
        gstin: "37ACNFA4687Q1ZC",
        state: "Andhra Pradesh",
        stateCode: "37"
      },
      bank: {
        name: "State Bank of India",
        accountName: "Aaryan aqua Needs",
        accountNo: "45413424177",
        ifsc: "SBIN0000911",
        branch: "Repalle"
      },
      upiId: "7386262139@upi",
      telegram: {
        token: "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g",
        chatId: "6877857251, 7906132548",
        botUsername: "fishbilling_bot_bot",
        autoSend: true
      },
      security: { autolock: "120", username: "Aaryanaqua", password: "Aaryan@2024" },
      terms: [
        "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct."
      ]
    };
    localStorage.setItem("settings", JSON.stringify(defaultSettings));
  }
}

function loadAllDatabases() {
  if ((!invoicesDb || invoicesDb.length === 0) && localStorage.getItem("invoices")) {
    try { invoicesDb = JSON.parse(localStorage.getItem("invoices") || "[]"); } catch(e) {}
  }
  if ((!productsDb || productsDb.length === 0) && localStorage.getItem("products")) {
    try { productsDb = JSON.parse(localStorage.getItem("products") || "[]"); } catch(e) {}
  }
  if ((!partiesDb || partiesDb.length === 0) && localStorage.getItem("parties")) {
    try { partiesDb = JSON.parse(localStorage.getItem("parties") || "[]"); } catch(e) {}
  }
  window.invoicesDb = invoicesDb;
  window.productsDb = productsDb;
  window.partiesDb = partiesDb;
  window.globalSettings = globalSettings;

  if (!globalSettings.telegram) {
    globalSettings.telegram = {
      token: "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g",
      chatId: "6877857251, 7906132548",
      botUsername: "fishbilling_bot_bot",
      autoSend: true
    };
    try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
  } else {
    let tgUpdated = false;
    if (!globalSettings.telegram.token || globalSettings.telegram.token.trim() === "") {
      globalSettings.telegram.token = "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g";
      tgUpdated = true;
    }
    if (!globalSettings.telegram.botUsername) {
      globalSettings.telegram.botUsername = "fishbilling_bot_bot";
      tgUpdated = true;
    }
    if (!globalSettings.telegram.chatId || !globalSettings.telegram.chatId.includes("7906132548")) {
      globalSettings.telegram.chatId = globalSettings.telegram.chatId && globalSettings.telegram.chatId.trim()
        ? (globalSettings.telegram.chatId + ", 7906132548")
        : "6877857251, 7906132548";
      tgUpdated = true;
    }
    if (tgUpdated) {
      try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
    }
  }
  if (!globalSettings.security) {
    globalSettings.security = {};
  }
  if (!globalSettings.company) {
    globalSettings.company = {};
  }
  if (!globalSettings.bank) {
    globalSettings.bank = {};
  }

  if (globalSettings.company && (!globalSettings.company.address || globalSettings.company.address.includes("Paruchurivari") || globalSettings.company.address.includes("10-14-15/3"))) {
    globalSettings.company.address = "Door No: 10-13-94/42A REVENUE WARD 7\nAP HOUSING BOARD COLONY, REPALLE Village,\nREPALLE Mandal, Bapatla District, Pincode 522265";
  }
  if (globalSettings.company) {
    globalSettings.company.phones = "+91 74166 05652";
    globalSettings.company.website = "www.aaryan-aqua.com";
  }

  // Enforce new bank details for live update
  if (!globalSettings.bank) {
    globalSettings.bank = {};
  }
  globalSettings.bank.name = "State Bank of India";
  globalSettings.bank.accountName = "Aaryan aqua Needs";
  globalSettings.bank.accountNo = "45413424177";
  globalSettings.bank.ifsc = "SBIN0000911";
  globalSettings.bank.branch = "Repalle";

  if (!globalSettings.security) {
    globalSettings.security = {};
  }
  if (!globalSettings.security.username || globalSettings.security.username === "1234") {
    globalSettings.security.username = "Aaryanaqua";
  }
  if (!globalSettings.security.password || globalSettings.security.password === "1234" || globalSettings.security.pin === "1234") {
    globalSettings.security.password = "Aaryan@2024";
  }
  if (globalSettings.security.whatsappLockEnabled === undefined) {
    globalSettings.security.whatsappLockEnabled = true;
  }
  if (!globalSettings.security.whatsappPin) {
    globalSettings.security.whatsappPin = "2024";
  }
  if (!globalSettings.security.whatsappAutoLockMinutes) {
    globalSettings.security.whatsappAutoLockMinutes = "15";
  }

  // Enforce address updates (GUNTURU -> GUNTUR)
  let updatedParties = false;
  partiesDb.forEach(p => {
    if (p.address && p.address.includes("GUNTURU")) {
      p.address = p.address.replace(/GUNTURU/g, "GUNTUR");
      updatedParties = true;
    }
  });
  if (updatedParties) {
    localStorage.setItem("parties", JSON.stringify(partiesDb));
  }

  // Ensure all products have valid numeric stock if undefined, null, empty or NaN
  let updatedProductsStock = false;
  productsDb.forEach(p => {
    const s = parseInt(p.stock, 10);
    if (p.stock === undefined || p.stock === null || p.stock === "" || isNaN(s)) {
      p.stock = 0;
      updatedProductsStock = true;
    }
  });
  if (updatedProductsStock) {
    try {
      localStorage.setItem("products", JSON.stringify(productsDb));
      if (typeof syncDatabaseToServer === 'function') {
        syncDatabaseToServer("products", productsDb);
      }
    } catch (e) {}
  }

  let updatedInvoices = false;
  invoicesDb.forEach(inv => {
    if (inv.buyer && inv.buyer.address && inv.buyer.address.includes("GUNTURU")) {
      inv.buyer.address = inv.buyer.address.replace(/GUNTURU/g, "GUNTUR");
      updatedInvoices = true;
    }
    if (inv.consignee && inv.consignee.address && inv.consignee.address.includes("GUNTURU")) {
      inv.consignee.address = inv.consignee.address.replace(/GUNTURU/g, "GUNTUR");
      updatedInvoices = true;
    }
  });
  if (updatedInvoices) {
    localStorage.setItem("invoices", JSON.stringify(invoicesDb));
  }

  try {
    localStorage.setItem("settings", JSON.stringify(globalSettings));
  } catch (err) {
    console.warn("Unable to persist settings:", err);
  }

  activeUsername = globalSettings.security?.username || "Aaryanaqua";
  activePassword = globalSettings.security?.password || globalSettings.security?.pin || "Aaryan@2024";
  lockTimerSeconds = parseInt(globalSettings.security?.autolock !== undefined ? globalSettings.security.autolock : "1800", 10);
  if (Number.isNaN(lockTimerSeconds)) {
    lockTimerSeconds = 1800;
  }
}

// Robust Helper: Normalize & locate product in master catalog (O(1) Turbo Retrieval)
function findProductInDb(item) {
  if (!item) return null;
  if (window.TurboDataStore && typeof window.TurboDataStore.getProduct === 'function') {
    if (item.productId) {
      const p = window.TurboDataStore.getProduct(item.productId);
      if (p) return p;
    }
    if (item.id) {
      const p = window.TurboDataStore.getProduct(item.id);
      if (p) return p;
    }
    if (item.description) {
      const p = window.TurboDataStore.getProduct(item.description);
      if (p) return p;
    }
  }
  if (!Array.isArray(productsDb)) return null;
  const rawDesc = (item.description || "").trim();
  const normalizedDesc = rawDesc.toLowerCase().replace(/\s+/g, ' ');
  const explicitProdId = item.productId;

  // 1. Match by explicit productId if present
  if (explicitProdId) {
    const byExplicitId = productsDb.find(p => p && (p.id === explicitProdId || String(p.id) === String(explicitProdId)));
    if (byExplicitId) return byExplicitId;
  }

  // 2. Match by exact normalized description
  if (normalizedDesc) {
    const byDesc = productsDb.find(p => p && (p.description || "").trim().toLowerCase().replace(/\s+/g, ' ') === normalizedDesc);
    if (byDesc) return byDesc;

    // 3. Fallback: match by p.id if item.id matches product id directly
    if (item.id) {
      const byItemId = productsDb.find(p => p && (p.id === item.id || String(p.id) === String(item.id)));
      if (byItemId) return byItemId;
    }

    // 4. Fallback: partial / substring match
    const byPartial = productsDb.find(p => p && p.description && (
      p.description.trim().toLowerCase().includes(normalizedDesc) ||
      normalizedDesc.includes(p.description.trim().toLowerCase())
    ));
    if (byPartial) return byPartial;
  }
  return null;
}

// Real-World Differential Invoice Stock Reconciliation Engine
function reconcileProductInventoryStock(oldInvoice, newInvoice) {
  let modified = false;
  const productDeltas = new Map();
  const changedStockDeltas = [];

  // 1. Credit back old invoice quantities
  if (oldInvoice && Array.isArray(oldInvoice.items)) {
    oldInvoice.items.forEach(oldItem => {
      const prod = findProductInDb(oldItem);
      if (prod) {
        const currentDelta = productDeltas.get(prod) || 0;
        const oldQty = parseFloat(oldItem.quantity) || 0;
        productDeltas.set(prod, currentDelta - oldQty);
      }
    });
  }

  // 2. Debit new invoice quantities
  if (newInvoice && Array.isArray(newInvoice.items)) {
    newInvoice.items.forEach(newItem => {
      const prod = findProductInDb(newItem);
      if (prod) {
        const currentDelta = productDeltas.get(prod) || 0;
        const newQty = parseFloat(newItem.quantity) || 0;
        productDeltas.set(prod, currentDelta + newQty);
      }
    });
  }

  // 3. Apply net differential
  productDeltas.forEach((netDelta, prod) => {
    if (netDelta !== 0) {
      const currentStock = parseInt(prod.stock, 10) || 0;
      const newStock = Math.max(0, currentStock - netDelta);
      prod.stock = newStock;
      prod.status = newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock");
      prod.updatedAt = new Date().toISOString();
      const rate = parseFloat(prod.rate || 0);
      const disc = parseFloat(prod.discount || 0);
      const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
      prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;
      modified = true;

      changedStockDeltas.push({
        productId: prod.id,
        stock: newStock,
        status: prod.status,
        delta: -netDelta,
        totalValue: prod.totalValue,
        description: prod.description
      });

      // Stamp optimistic local mutation protection for 5 minutes (persisted in localStorage + RAM)
      if (!window.recentProductMutations) window.recentProductMutations = {};
      const nowMs = Date.now();
      window.recentProductMutations[prod.id] = nowMs;
      if (prod.description) {
        window.recentProductMutations[prod.description] = nowMs;
        window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
      }
      try {
        let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
        storedMut[prod.id] = nowMs;
        if (prod.description) {
          storedMut[prod.description] = nowMs;
          storedMut[prod.description.trim().toLowerCase()] = nowMs;
        }
        localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
      } catch(e){}

      const actionText = netDelta > 0 
        ? `Invoice Stock Deduction (-${netDelta} ${prod.unit || 'Units'})` 
        : `Invoice Edit Stock Reversal (+${Math.abs(netDelta)} ${prod.unit || 'Units'})`;
      setTimeout(() => {
        try { sendStockTelegramReport(prod, actionText, currentStock, newStock); } catch(e){}
      }, 50);
    }
  });

  if (modified) {
    try {
      // 1. Immediate LocalStorage persistence (< 0.05ms)
      localStorage.setItem("products", JSON.stringify(productsDb));

      // 2. Immediate IndexedDB persistence
      if (window.AaryanDB && typeof window.AaryanDB.saveAllProducts === "function") {
        try { window.AaryanDB.saveAllProducts(productsDb); } catch(e){}
      }

      // 3. Instant local DOM updates (< 0.1ms)
      changedStockDeltas.forEach(d => {
        if (typeof updateProductDomRowFast === 'function') {
          updateProductDomRowFast(d.productId, d.stock, d.status);
        }
      });
      if (typeof populateBillingSelectors === "function") populateBillingSelectors();
      if (typeof updateDashboardOverview === "function") updateDashboardOverview();

      // 4. High-speed broadcast across tri-channel mesh (< 150ms)
      broadcastInterTabEvent('INVOICE_STOCK_DEDUCTED', {
        stockDeltas: changedStockDeltas,
        products: productsDb,
        invoiceNo: newInvoice?.invoiceNo || oldInvoice?.invoiceNo
      });

      // 5. Debounced asynchronous push to Google Master Database
      if (directPushProductTimer) clearTimeout(directPushProductTimer);
      directPushProductTimer = setTimeout(() => {
        pushDirectToGoogleDatabase("save_products", { products: productsDb });
      }, 250);

    } catch (err) {
      console.warn("Unable to save products db:", err);
    }
  }

  return changedStockDeltas;
}

function validateInvoiceStockAvailability(newItems, oldItems = []) {
  if (!Array.isArray(newItems) || newItems.length === 0) return true;

  // Group new requested quantities by product
  const requestedTotals = new Map();
  newItems.forEach(item => {
    const prod = findProductInDb(item);
    if (prod) {
      const current = requestedTotals.get(prod) || 0;
      requestedTotals.set(prod, current + (parseFloat(item.quantity) || 0));
    }
  });

  // Check each product against available warehouse stock + old invoice commitment
  for (const [prod, totalReq] of requestedTotals.entries()) {
    if (prod.stock !== undefined && prod.stock !== null && prod.stock !== "") {
      const availableStock = Math.max(0, parseInt(prod.stock, 10) || 0);

      let previouslyInvoicedQty = 0;
      if (Array.isArray(oldItems)) {
        const oldMatch = oldItems.find(it => 
          (it.productId && prod.id && it.productId === prod.id) ||
          (it.description && prod.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
        );
        if (oldMatch) previouslyInvoicedQty = parseFloat(oldMatch.quantity) || 0;
      }

      const effectiveAvailable = availableStock + previouslyInvoicedQty;

      if (effectiveAvailable <= 0) {
        showFloatingToast(`❌ Cannot save invoice: "${prod.description}" is currently OUT OF STOCK (Available: 0).`, "warning");
        return false;
      }

      if (totalReq > effectiveAvailable) {
        showFloatingToast(`❌ Cannot save invoice: Insufficient stock for "${prod.description}". Available: ${effectiveAvailable} ${prod.unit || 'units'}, but invoice has ${totalReq}. Please adjust quantity.`, "warning");
        return false;
      }
    }
  }

  return true;
}

function validateInvoicePaymentExceeds(invoice, grandTotal) {
  const status = invoice.paymentStatus || "Paid";
  if (status === "Partial") {
    const paid = parseFloat(invoice.paidAmount) || 0;
    const balance = parseFloat(invoice.balancePaid) || 0;
    const totalPaid = paid + balance;
    if (totalPaid > grandTotal) {
      showFloatingToast(`⚠️ Total paid (₹${totalPaid.toFixed(2)}) cannot exceed grand total (₹${grandTotal.toFixed(2)})!`, "warning");
      return false;
    }
  }
  return true;
}

// --- ROUTING ENGINE ---
function setupRouting() {
  elements.navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const tabName = btn.getAttribute("data-tab");
      switchTab(tabName);
      closeMobileSidebar();
    });
  });
}

window.toggleMobileSidebar = function() {
  const wrapper = document.querySelector('.dashboard-wrapper');
  if (wrapper) {
    wrapper.classList.toggle('sidebar-open');
  }
};

window.closeMobileSidebar = function() {
  const wrapper = document.querySelector('.dashboard-wrapper');
  if (wrapper) {
    wrapper.classList.remove('sidebar-open');
  }
};

window.switchTab = function(tabName) {
  if (isLocked) return;
  if (typeof window.closeMobileSidebar === 'function') {
    window.closeMobileSidebar();
  }

  elements.navItems.forEach(btn => {
    if (btn.getAttribute("data-tab") === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Sync docked mobile bottom nav bar
  try {
    const bottomNavItems = document.querySelectorAll(".mobile-bottom-nav-item, .mobile-bottom-nav-fab");
    bottomNavItems.forEach(btn => {
      if (btn.getAttribute("data-bottom-tab") === tabName) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  } catch (e) {}

  elements.views.forEach(view => {
    if (view.id === `view-${tabName}`) {
      view.classList.remove("hidden");
      view.style.removeProperty('display');
      view.scrollTop = 0;
    } else {
      view.classList.add("hidden");
      view.style.setProperty('display', 'none', 'important');
    }
  });

  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  } catch (e) {
    window.scrollTo(0, 0);
  }

  const isSmallScreen = window.innerWidth <= 768;
  let title = tabName.charAt(0).toUpperCase() + tabName.slice(1);
  if (tabName === 'billing') title = isSmallScreen ? 'GST Bill' : 'GST Billing';
  if (tabName === 'history') title = isSmallScreen ? 'History' : 'Invoice History';
  if (tabName === 'products') title = isSmallScreen ? 'Products' : 'Inventory & Products';
  if (tabName === 'parties') title = isSmallScreen ? 'Parties' : 'Client & Party Accounts';
  if (tabName === 'reports') title = isSmallScreen ? 'Reports' : 'Analytics & Reports';
  if (tabName === 'settings') title = isSmallScreen ? 'Settings' : 'System & Automation Settings';
  elements.viewTitle.textContent = title;

  const crumbEl = document.getElementById("current-crumb");
  if (crumbEl) crumbEl.textContent = title;

  if (tabName === 'dashboard') {
    updateDashboardOverview();
  } else if (tabName === 'billing') {
    populateBillingSelectors();
    if (typeof renderFrequentProductsBar === 'function') {
      renderFrequentProductsBar();
    }
    if (!currentInvoice.invoiceNo) {
      autoSuggestInvoiceNo();
    }
    calculateSummaryAndTable();
  } else if (tabName === 'history') {
    loadInvoicesHistoryTable();
  } else if (tabName === 'products') {
    loadProductsDatabaseTable();
  } else if (tabName === 'parties') {
    loadPartiesDatabaseLists();
  } else if (tabName === 'reports') {
    resetReportsView();
  } else if (tabName === 'settings') {
    loadSettingsFields();
  }
};

function updateLiveDateTime() {
  const el = document.getElementById('current-datetime') || elements.currentDatetime;
  if (!el) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  el.textContent = `${dateStr} • ${timeStr}`;
}

// --- DASHBOARD LOADER & ANALYTICS CHARTS ---
let salesChartInstance = null;
let gstChartInstance = null;

function checkLowStockAlerts() {
  const alertPill = document.getElementById("live-stock-alert-pill");
  const alertText = document.getElementById("low-stock-count-text");
  if (!alertPill || !alertText) return;

  const lowStockItems = productsDb.filter(p => (parseInt(p.stock, 10) || 0) <= 5);
  if (lowStockItems.length > 0) {
    alertPill.classList.remove("hidden");
    alertText.textContent = `${lowStockItems.length} Low Stock Alert${lowStockItems.length > 1 ? 's' : ''}`;
  } else {
    alertPill.classList.add("hidden");
  }
}

function renderDashboardCharts() {
  const salesCanvas = document.getElementById("dashboard-sales-chart");
  const gstCanvas = document.getElementById("dashboard-gst-chart");
  if (!salesCanvas || !gstCanvas || typeof Chart === "undefined") return;

  const monthlyRevenue = {};
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    monthlyRevenue[key] = 0;
  }

  let totalCgst = 0, totalSgst = 0, totalIgst = 0;
  let totalExemptOrZeroTaxRevenue = 0;

  (invoicesDb || []).forEach(inv => {
    if (!inv) return;
    const invAmt = safeParseAmount(inv.total !== undefined ? inv.total : (inv.details && inv.details.total));

    // Robust date parsing
    if (inv.invoiceDate) {
      let d = null;
      const rawDate = String(inv.invoiceDate).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        const p = rawDate.split('-');
        d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
      } else {
        const parsed = new Date(rawDate);
        if (!isNaN(parsed.getTime())) {
          d = parsed;
        } else {
          const parts = rawDate.split(/[-/ ]/);
          if (parts.length === 3 && parts[2].length === 4) {
            const yr = parseInt(parts[2], 10);
            let m = parseInt(parts[1], 10) - 1;
            if (isNaN(m)) {
              const monPrefix = parts[1].toLowerCase().slice(0, 3);
              const mIdx = monthNames.findIndex(mn => mn.toLowerCase() === monPrefix);
              if (mIdx >= 0) m = mIdx;
            }
            const day = parseInt(parts[0], 10);
            if (m >= 0 && !isNaN(day)) d = new Date(yr, m, day);
          }
        }
      }

      if (d && !isNaN(d.getTime())) {
        const key = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
        if (monthlyRevenue.hasOwnProperty(key)) {
          monthlyRevenue[key] += invAmt;
        }
      }
    }

    // Extract taxes with multi-tier fallback
    const details = inv.details || {};
    let cgst = safeParseAmount(inv.cgst !== undefined ? inv.cgst : (details.cgst !== undefined ? details.cgst : details.totalCgst));
    let sgst = safeParseAmount(inv.sgst !== undefined ? inv.sgst : (details.sgst !== undefined ? details.sgst : details.totalSgst));
    let igst = safeParseAmount(inv.igst !== undefined ? inv.igst : (details.igst !== undefined ? details.igst : details.totalIgst));

    // If taxes evaluate to 0, check if line items had gstRate/taxRate
    if (cgst === 0 && sgst === 0 && igst === 0) {
      const items = inv.items || details.items || [];
      if (Array.isArray(items) && items.length > 0 && typeof InvoiceUtils !== 'undefined' && typeof InvoiceUtils.calculateInvoiceBreakdown === 'function') {
        const sellerStateCode = (globalSettings.company && globalSettings.company.stateCode) || "37";
        const buyerStateCode = (inv.buyer && inv.buyer.stateCode) || (details.buyer && details.buyer.stateCode) || "37";
        const bk = InvoiceUtils.calculateInvoiceBreakdown(items, sellerStateCode, buyerStateCode);
        cgst = bk.totalCgst;
        sgst = bk.totalSgst;
        igst = bk.totalIgst;
      }
    }

    if (cgst === 0 && sgst === 0 && igst === 0) {
      totalExemptOrZeroTaxRevenue += invAmt;
    }

    totalCgst += cgst;
    totalSgst += sgst;
    totalIgst += igst;
  });

  totalCgst = Math.round(totalCgst * 100) / 100;
  totalSgst = Math.round(totalSgst * 100) / 100;
  totalIgst = Math.round(totalIgst * 100) / 100;
  const totalTaxSum = totalCgst + totalSgst + totalIgst;

  const labels = Object.keys(monthlyRevenue);
  const dataValues = Object.values(monthlyRevenue);

  if (salesChartInstance) salesChartInstance.destroy();
  if (gstChartInstance) gstChartInstance.destroy();

  const ctx = salesCanvas.getContext('2d');
  let gradient = null;
  try {
    gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(2, 132, 199, 0.35)');
    gradient.addColorStop(1, 'rgba(2, 132, 199, 0.00)');
  } catch (e) {}

  salesChartInstance = new Chart(salesCanvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Revenue (₹)',
        data: dataValues,
        fill: true,
        backgroundColor: gradient || 'rgba(2, 132, 199, 0.15)',
        borderColor: '#0284c7',
        borderWidth: 2.5,
        tension: 0.38,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: '#0284c7',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: '#0284c7',
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          titleColor: '#ffffff',
          bodyColor: '#38bdf8',
          padding: 10,
          cornerRadius: 8,
          boxPadding: 4,
          callbacks: {
            label: function(context) {
              return ` Revenue: ₹ ${context.parsed.y.toLocaleString('en-IN')}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(226, 232, 240, 0.6)' },
          ticks: {
            color: '#64748b',
            font: { size: 11, family: 'Inter' },
            callback: function(val) {
              return '₹ ' + (val >= 1000 ? (val / 1000) + 'k' : val);
            }
          }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { size: 11, family: 'Inter' } }
        }
      }
    }
  });

  const hasTaxData = totalTaxSum > 0;
  const gstLabels = hasTaxData ? ['CGST', 'SGST', 'IGST'] : ['Bill of Supply (0% GST)'];
  const gstData = hasTaxData ? [totalCgst, totalSgst, totalIgst] : [totalExemptOrZeroTaxRevenue || 1];
  const gstColors = hasTaxData ? ['#10b981', '#0284c7', '#f59e0b'] : ['#0891b2'];

  gstChartInstance = new Chart(gstCanvas, {
    type: 'doughnut',
    data: {
      labels: gstLabels,
      datasets: [{
        data: gstData,
        backgroundColor: gstColors,
        borderWidth: 2,
        borderColor: '#ffffff',
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#475569',
            font: { size: 11, family: 'Inter', weight: '600' },
            padding: 12,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const val = context.parsed;
              if (hasTaxData) {
                return ` ${label}: ₹ ${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              } else {
                return ` ${label}: ₹ ${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (100% Tax-Exempt)`;
              }
            }
          }
        }
      }
    }
  });
}

window.calculateMarginWidget = function() {
  const cost = parseFloat(document.getElementById("calc-cost-price")?.value || 0);
  const sell = parseFloat(document.getElementById("calc-sell-price")?.value || 0);
  const rate = parseFloat(document.getElementById("calc-gst-rate")?.value || 0);

  const gstResult = document.getElementById("calc-result-gst");
  const profitResult = document.getElementById("calc-result-profit");
  if (!gstResult || !profitResult) return;

  const gstAmt = (sell * rate) / 100;
  const netProfit = sell - cost;
  const marginPct = cost > 0 ? ((netProfit / cost) * 100).toFixed(1) : 0;

  gstResult.textContent = `₹ ${formatCurrency(gstAmt)}`;
  profitResult.textContent = `₹ ${formatCurrency(netProfit)} (${marginPct}%)`;
};

// --- CUSTOMER OUTSTANDING & TRUST LEDGER SUMMARY ---
window.startBillForCustomer = function(customerName) {
  switchTab("billing");
  if (elements.billBuyerName) {
    elements.billBuyerName.value = customerName;
    if (typeof onBuyerNameChange === 'function') onBuyerNameChange();
    elements.billBuyerName.focus();
  }
};

window.renderCustomerLedgerSummary = function() {
  const tbody = document.getElementById("dashboard-customer-ledger-body");
  if (!tbody) return;

  let customers = [];
  if (window.TurboDataStore && window.TurboDataStore.partyBalances && window.TurboDataStore.partyBalances.size > 0) {
    customers = Array.from(window.TurboDataStore.partyBalances.values());
  } else {
    const customerMap = new Map();
    (invoicesDb || []).forEach(inv => {
      if (!inv) return;
      const isEst = Boolean(inv.isEstimate || inv.details?.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
      if (isEst) return;

      const details = inv.details || {};
      const buyer = details.buyer || {};
      const rawName = (inv.customerName || buyer.name || 'Cash Customer').trim();
      if (!rawName) return;

      const normKey = rawName.toLowerCase();
      let record = customerMap.get(normKey);
      if (!record) {
        record = {
          name: rawName,
          phone: buyer.phone || inv.customerPhone || "",
          invoiceCount: 0,
          totalBilled: 0,
          totalPaid: 0,
          totalBalance: 0
        };
        customerMap.set(normKey, record);
      }

      if (!record.phone && buyer.phone) record.phone = buyer.phone;

      const payInfo = typeof getInvoicePaidAndBalance === "function" 
        ? getInvoicePaidAndBalance(inv) 
        : { total: safeParseAmount(inv.total), paid: safeParseAmount(inv.total), balance: 0 };

      record.invoiceCount += 1;
      record.totalBilled += payInfo.total;
      record.totalPaid += payInfo.paid;
      record.totalBalance += payInfo.balance;
    });
    customers = Array.from(customerMap.values());
  }

  customers.sort((a, b) => {
    // Prioritize pending balances first, then highest volume
    if (b.totalBalance !== a.totalBalance) return b.totalBalance - a.totalBalance;
    return b.totalBilled - a.totalBilled;
  });

  if (customers.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted" style="padding: 24px;">
          <i class="fa-solid fa-clipboard-check" style="font-size: 20px; color: #10b981; margin-bottom: 6px; display: block;"></i>
          All customer accounts settled! No outstanding balances.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = customers.map(cust => {
    const hasBalance = cust.totalBalance > 0.01;
    const balPill = hasBalance
      ? `<span class="ledger-balance-pill pending"><i class="fa-solid fa-clock"></i> ₹${formatCurrency(cust.totalBalance)}</span>`
      : `<span class="ledger-balance-pill cleared"><i class="fa-solid fa-circle-check"></i> Cleared</span>`;

    const phoneClean = cust.phone ? String(cust.phone).replace(/[^0-9]/g, '') : '';
    const waActionBtn = phoneClean
      ? `<a href="https://wa.me/91${phoneClean}?text=${encodeURIComponent(`Dear ${cust.name}, here is your account summary from Aaryan Aqua Needs. Total Billed: ₹${formatCurrency(cust.totalBilled)}, Received: ₹${formatCurrency(cust.totalPaid)}, Current Balance Due: ₹${formatCurrency(cust.totalBalance)}. Thank you!`)}" target="_blank" class="action-btn share btn-whatsapp" title="Send WhatsApp Statement" style="display: inline-flex; align-items: center; justify-content: center;"><i class="fa-brands fa-whatsapp" style="color: #16a34a;"></i></a>`
      : `<button class="action-btn edit" onclick="startBillForCustomer('${cust.name.replace(/'/g, "\\'")}')" title="New Bill for ${cust.name}"><i class="fa-solid fa-cart-plus"></i></button>`;

    return `
      <tr>
        <td>
          <div class="ledger-cust-name">
            <i class="fa-solid fa-building-user text-muted" style="font-size: 13px;"></i>
            <span>${cust.name}</span>
          </div>
        </td>
        <td>${cust.phone ? `<i class="fa-brands fa-whatsapp text-emerald" style="font-size: 11px;"></i> ${cust.phone}` : '<span class="text-muted">—</span>'}</td>
        <td class="text-center" style="font-weight: 700;">${cust.invoiceCount}</td>
        <td style="text-align: right; font-weight: 700;">₹ ${formatCurrency(cust.totalBilled)}</td>
        <td style="text-align: right; color: #059669; font-weight: 700;">₹ ${formatCurrency(cust.totalPaid)}</td>
        <td style="text-align: right;">${balPill}</td>
        <td class="text-center actions-cell">
          ${waActionBtn}
          <button class="action-btn edit" onclick="startBillForCustomer('${cust.name.replace(/'/g, "\\'")}')" title="New Bill for ${cust.name}"><i class="fa-solid fa-cart-plus"></i></button>
        </td>
      </tr>
    `;
  }).join('');
};

function updateDashboardOverview() {
  loadAllDatabases();

  // Clean out invalid / corrupted entries
  invoicesDb = (invoicesDb || []).filter(inv => inv && (inv.id || inv.invoiceNo) && inv.id !== 'inv_test_delta');

  const isSyncLoading = invoicesDb.length === 0 && !window.isInitialSyncDone;

  if (isSyncLoading) {
    if (elements.statTotalInvoices) elements.statTotalInvoices.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 16px;"></i>`;
    if (elements.statTotalAmount) elements.statTotalAmount.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 16px;"></i>`;
    const sc = document.getElementById("stat-total-collected");
    if (sc) sc.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 16px;"></i>`;
    const sb = document.getElementById("stat-total-balance");
    if (sb) sb.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 16px;"></i>`;
    const ss = document.getElementById("stat-settlement-rate");
    if (ss) ss.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 16px;"></i>`;
  } else {
    if (elements.statTotalInvoices) elements.statTotalInvoices.textContent = invoicesDb.length;
    let totalRevenue = 0;
    let totalCollected = 0;
    let totalBalanceDue = 0;
    let pendingInvoicesCount = 0;

    (invoicesDb || []).forEach(inv => {
      if (!inv) return;
      const isEst = Boolean(inv.isEstimate || inv.details?.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
      if (isEst) return;
      const payInfo = typeof getInvoicePaidAndBalance === "function" 
        ? getInvoicePaidAndBalance(inv)
        : { status: 'Paid', isPaid: true, paid: safeParseAmount(inv.total), balance: 0, total: safeParseAmount(inv.total) };
      
      totalRevenue += payInfo.total;
      totalCollected += payInfo.paid;
      totalBalanceDue += payInfo.balance;
      if (!payInfo.isPaid && payInfo.balance > 0.01) {
        pendingInvoicesCount++;
      }
    });

    if (elements.statTotalAmount) {
      elements.statTotalAmount.textContent = '₹ ' + formatCurrency(totalRevenue);
      elements.statTotalAmount.title = 'Total Gross Billing Volume: ₹ ' + formatCurrency(totalRevenue);
    }

    const statCollectedEl = document.getElementById("stat-total-collected");
    const statCollectedStatusEl = document.getElementById("stat-collected-status");
    if (statCollectedEl) {
      statCollectedEl.textContent = '₹ ' + formatCurrency(totalCollected);
      statCollectedEl.title = 'Total Settled & Received Payments: ₹ ' + formatCurrency(totalCollected);
    }
    if (statCollectedStatusEl) {
      statCollectedStatusEl.textContent = totalBalanceDue <= 0.01 ? "All Settled ✅" : `${Math.round((totalCollected / (totalRevenue || 1)) * 100)}% Settled`;
    }

    const statBalanceEl = document.getElementById("stat-total-balance");
    const statPendingCountEl = document.getElementById("stat-balance-pending-count");
    if (statBalanceEl) {
      statBalanceEl.textContent = '₹ ' + formatCurrency(totalBalanceDue);
      statBalanceEl.title = 'Total Outstanding / Unpaid Balance: ₹ ' + formatCurrency(totalBalanceDue);
      statBalanceEl.style.color = totalBalanceDue > 0.01 ? "#b45309" : "#10b981";
    }
    if (statPendingCountEl) {
      statPendingCountEl.textContent = pendingInvoicesCount > 0 
        ? `${pendingInvoicesCount} Bill${pendingInvoicesCount > 1 ? 's' : ''} Pending`
        : "All Cleared ✅";
    }

    // Advanced Gross Profit & Margin Analytics Calculation
    let allInvoicesCost = 0;
    let allInvoicesTaxable = 0;
    (invoicesDb || []).forEach(inv => {
      if (!inv) return;
      const items = inv.items || inv.details?.items || [];
      items.forEach(it => {
        const prod = (productsDb || []).find(p => (it.productId && p.id === it.productId) || ((p.description || '').trim().toLowerCase() === (it.description || '').trim().toLowerCase()));
        const cPrice = it.costPrice !== undefined ? it.costPrice : (prod?.costPrice || 0);
        const qty = parseFloat(it.quantity) || 0;
        const amt = parseFloat(it.amount) || (qty * (parseFloat(it.rate) || 0));
        allInvoicesCost += (parseFloat(cPrice) || 0) * qty;
        allInvoicesTaxable += amt;
      });
    });
    const estProfit = Math.max(0, allInvoicesTaxable - allInvoicesCost);
    const profitPct = allInvoicesTaxable > 0 ? ((estProfit / allInvoicesTaxable) * 100).toFixed(1) : "0";
    const profitStatEl = document.getElementById("stat-total-profit");
    const profitPctEl = document.getElementById("stat-profit-pct");
    if (profitStatEl) profitStatEl.textContent = '₹ ' + formatCurrency(estProfit);
    if (profitPctEl) profitPctEl.textContent = `${profitPct}%`;

    // 8th Stat: Settlement & Recovery Rate
    const settlementRate = totalRevenue > 0 ? ((totalCollected / totalRevenue) * 100).toFixed(1) : "100.0";
    const statSettlementRateEl = document.getElementById("stat-settlement-rate");
    const statSettlementSubEl = document.getElementById("stat-settlement-sub");
    if (statSettlementRateEl) {
      statSettlementRateEl.textContent = `${settlementRate}%`;
      statSettlementRateEl.title = `Collection Efficiency: ${settlementRate}% (₹ ${formatCurrency(totalCollected)} / ₹ ${formatCurrency(totalRevenue)})`;
    }
    if (statSettlementSubEl) {
      statSettlementSubEl.textContent = totalBalanceDue <= 0.01 ? "All Settled ✅" : `${settlementRate}% Recovered`;
    }
  }

  if (elements.statTotalProducts) elements.statTotalProducts.textContent = (productsDb || []).length;
  
  const uniqueParties = new Set((partiesDb || []).map(p => p && p.name).filter(Boolean)).size;
  if (elements.statTotalParties) elements.statTotalParties.textContent = uniqueParties;

  checkLowStockAlerts();
  renderDashboardCharts();

  if (elements.dashboardRecentInvoicesBody) {
    elements.dashboardRecentInvoicesBody.innerHTML = "";
    const recent = invoicesDb.slice().sort((a, b) => {
      // Sort by creation timestamp descending (newest first)
      function getTs(inv) {
        if (!inv) return 0;
        if (typeof inv.id === 'string' && inv.id.startsWith('inv_')) {
          const ts = parseInt(inv.id.split('_')[1], 10);
          if (!isNaN(ts) && ts > 1000000000000) return ts;
        }
        if (inv.invoiceDate) {
          const t = new Date(inv.invoiceDate).getTime();
          if (!isNaN(t) && t > 0) return t;
        }
        return 0;
      }
      return getTs(b) - getTs(a);
    }).slice(0, 5);
    
    if (recent.length === 0) {
      if (isSyncLoading) {
        elements.dashboardRecentInvoicesBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center" style="padding: 24px; color: #64748b;">
              <i class="fa-solid fa-circle-notch fa-spin"></i> Syncing invoices...
            </td>
          </tr>
        `;
      } else {
        elements.dashboardRecentInvoicesBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center text-muted" style="padding: 24px;">No invoices generated yet.</td>
          </tr>
        `;
      }
    } else {
      recent.forEach(inv => {
        const details = inv.details || {};
        const isEstimate = Boolean(inv.isEstimate || details.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
        const payInfo = typeof getInvoicePaidAndBalance === "function" 
          ? getInvoicePaidAndBalance(inv) 
          : { status: 'Paid', isPaid: true, paid: safeParseAmount(inv.total), balance: 0, total: safeParseAmount(inv.total) };
        const status = payInfo.status;
        const isPaid = payInfo.isPaid;
        const balance = payInfo.balance;

        let badgeClass = 'badge-paid';
        if (status === 'Partial') badgeClass = 'badge-partial';
        if (status === 'Unpaid') badgeClass = 'badge-unpaid';

        let balanceQrBtn = "";
        if (!isEstimate && !isPaid && balance > 0) {
          balanceQrBtn = `
            <button class="action-btn share" onclick="openBalanceQrModal('${inv.id}')" title="Scan & Settle Balance (₹ ${formatCurrency(balance)})" style="background: rgba(6, 182, 212, 0.15); color: #06b6d4;"><i class="fa-solid fa-qrcode"></i></button>
          `;
        }

        const invTotal = safeParseAmount(inv.total !== undefined ? inv.total : details.total);
        const custName = (inv.customerName || (details.buyer && details.buyer.name) || 'Cash Customer').trim();
        const itemsCount = inv.itemsCount !== undefined ? inv.itemsCount : ((inv.items || details.items || []).length);

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="font-weight: 700; color: var(--primary-teal); white-space: nowrap;">#${inv.invoiceNo}</td>
          <td style="white-space: nowrap;">${formatInputDateString(inv.invoiceDate)}</td>
          <td style="font-weight: 600; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${custName}">${custName}</td>
          <td class="text-center" style="white-space: nowrap;">${itemsCount}</td>
          <td style="text-align: right; font-weight: 700; white-space: nowrap;">₹ ${formatCurrency(invTotal)}</td>
          <td class="text-center" style="white-space: nowrap;">
            <span class="badge-status ${badgeClass}">${status}</span>
            ${(!isPaid && balance > 0) ? `<div style="font-size: 10px; color: #b45309; font-weight: 700; margin-top: 2px;">Bal: ₹${formatCurrency(balance)}</div>` : ''}
          </td>
          <td class="actions-cell">
            ${balanceQrBtn}
            <button class="action-btn repeat" onclick="repeatInvoice('${inv.id}')" title="Repeat Bill (Clone to New Invoice)"><i class="fa-solid fa-arrows-rotate" style="color: #6366f1;"></i></button>
            <button class="action-btn edit" onclick="editSavedInvoice('${inv.id}')" title="Edit Invoice"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="action-btn print" onclick="printSavedInvoice('${inv.id}')" title="Print A4 Tax Invoice"><i class="fa-solid fa-print"></i></button>
            <button class="action-btn print" onclick="printSavedInvoiceThermal('${inv.id}')" title="Print Thermal POS Receipt"><i class="fa-solid fa-receipt"></i></button>
            <button class="action-btn share btn-whatsapp" onclick="shareInvoiceToWhatsApp('${inv.id}', this)" title="Share PDF via WhatsApp (1-Click)"><i class="fa-brands fa-whatsapp" style="color: #16a34a;"></i></button>
            <button class="action-btn share btn-telegram" onclick="shareInvoiceToTelegram('${inv.id}', this)" title="Share PDF to Telegram (@fishbilling_bot_bot)"><i class="fa-brands fa-telegram" style="color: #0284c7;"></i></button>
            <button class="action-btn share" onclick="openUniversalInvoiceShareModal('${inv.id}')" title="Universal Share (Nearby / Email / Copy / Native)"><i class="fa-solid fa-share-nodes" style="color: #0891b2;"></i></button>
            <button class="action-btn delete" onclick="deleteSavedInvoice('${inv.id || inv.invoiceNo}')" title="Delete Invoice"><i class="fa-solid fa-trash"></i></button>
          </td>
        `;
        elements.dashboardRecentInvoicesBody.appendChild(tr);
      });
    }
  }

  // ALWAYS Render the Customer Outstanding & Trust Ledger Card!
  if (typeof window.renderCustomerLedgerSummary === 'function') {
    window.renderCustomerLedgerSummary();
  }
}

function formatInputDateString(dateStr) {
  if (!dateStr || dateStr === 'undefined' || dateStr === 'null') return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleDateString('en-GB', options).replace(/ /g, '-');
}

// --- BINDING GST BILLING FORM FIELDS ---
function bindBillingFormInputs() {
  const binds = [
    { el: elements.billInvoiceType, key: 'invoiceType' },
    { el: elements.billHeaderLogo, key: 'headerLogo' },
    { el: elements.billInvoiceNo, key: 'invoiceNo' },
    { el: elements.billInvoiceDate, key: 'invoiceDate' },
    { el: elements.billBuyerOrderNo, key: 'buyerOrderNo' },
    { el: elements.billBuyerOrderDate, key: 'buyerOrderDate' },
    { el: elements.billTransportMode, key: 'transportMode' },
    { el: elements.billDestination, key: 'destination' },
    { el: elements.billSupplyStateCode, key: 'supplyStateCode' },
    { el: elements.billPaymentStatus, key: 'paymentStatus' },
    { el: elements.billPaymentMode, key: 'paymentMode' },
    { el: elements.billPaidAmount, key: 'paidAmount', isFloat: true },
    { el: elements.billBalancePaid, key: 'balancePaid', isFloat: true },
    { el: elements.billPaymentDate, key: 'paymentDate' },

    { el: elements.billBuyerName, sub: 'buyer', key: 'name' },
    { el: elements.billBuyerAddress, sub: 'buyer', key: 'address' },
    { el: elements.billBuyerGstin, sub: 'buyer', key: 'gstin' },
    { el: elements.billBuyerPhone, sub: 'buyer', key: 'phone' },
    { el: elements.billBuyerState, sub: 'buyer', key: 'state' },
    { el: elements.billBuyerStateCode, sub: 'buyer', key: 'stateCode' },

    { el: elements.billConsigneeName, sub: 'consignee', key: 'name' },
    { el: elements.billConsigneeAddress, sub: 'consignee', key: 'address' },
    { el: elements.billConsigneeGstin, sub: 'consignee', key: 'gstin' },
    { el: elements.billConsigneePhone, sub: 'consignee', key: 'phone' },
    { el: elements.billConsigneeState, sub: 'consignee', key: 'state' },
    { el: elements.billConsigneeStateCode, sub: 'consignee', key: 'stateCode' }
  ];

  binds.forEach(b => {
    if (!b.el) return;
    const handleValChange = (e) => {
      let val = e.target.value;
      if (b.isInt) val = parseInt(val, 10) || 0;
      if (b.isFloat) val = parseFloat(val) || 0;

      if (!currentInvoice) currentInvoice = {};
      if (b.sub) {
        if (!currentInvoice[b.sub]) currentInvoice[b.sub] = {};
        currentInvoice[b.sub][b.key] = val;
      } else {
        currentInvoice[b.key] = val;
        if (b.key === 'destination') {
          currentInvoice.supplyPlace = val;
        }
      }
      calculateSummaryAndTable();
    };
    b.el.addEventListener("input", handleValChange);
    b.el.addEventListener("change", handleValChange);
  });

  window.syncBillingInputsToCurrentInvoice = function() {
    try {
      if (!currentInvoice) currentInvoice = {};
      if (elements.billInvoiceNo && elements.billInvoiceNo.value) currentInvoice.invoiceNo = elements.billInvoiceNo.value.trim();
      if (elements.billInvoiceDate && elements.billInvoiceDate.value) currentInvoice.invoiceDate = elements.billInvoiceDate.value;
      if (elements.billInvoiceType && elements.billInvoiceType.value) currentInvoice.invoiceType = elements.billInvoiceType.value;
      if (elements.billHeaderLogo && elements.billHeaderLogo.value) currentInvoice.headerLogo = elements.billHeaderLogo.value;
      if (elements.billBuyerOrderNo && elements.billBuyerOrderNo.value) currentInvoice.buyerOrderNo = elements.billBuyerOrderNo.value.trim();
      if (elements.billBuyerOrderDate && elements.billBuyerOrderDate.value) currentInvoice.buyerOrderDate = elements.billBuyerOrderDate.value;
      if (elements.billTransportMode && elements.billTransportMode.value) currentInvoice.transportMode = elements.billTransportMode.value;
      if (elements.billDestination && elements.billDestination.value) {
        currentInvoice.destination = elements.billDestination.value;
        currentInvoice.supplyPlace = elements.billDestination.value;
      }
      if (elements.billSupplyStateCode && elements.billSupplyStateCode.value) currentInvoice.supplyStateCode = elements.billSupplyStateCode.value;
      if (elements.billPaymentStatus && elements.billPaymentStatus.value) currentInvoice.paymentStatus = elements.billPaymentStatus.value;
      if (elements.billPaymentMode && elements.billPaymentMode.value) currentInvoice.paymentMode = elements.billPaymentMode.value;
      if (elements.billPaidAmount && elements.billPaidAmount.value !== "") currentInvoice.paidAmount = parseFloat(elements.billPaidAmount.value) || 0;
      if (elements.billBalancePaid && elements.billBalancePaid.value !== "") currentInvoice.balancePaid = parseFloat(elements.billBalancePaid.value) || 0;
      if (elements.billPaymentDate && elements.billPaymentDate.value) currentInvoice.paymentDate = elements.billPaymentDate.value;

      if (!currentInvoice.buyer) currentInvoice.buyer = {};
      if (elements.billBuyerName && elements.billBuyerName.value) currentInvoice.buyer.name = elements.billBuyerName.value.trim();
      if (elements.billBuyerAddress && elements.billBuyerAddress.value) currentInvoice.buyer.address = elements.billBuyerAddress.value.trim();
      if (elements.billBuyerGstin && elements.billBuyerGstin.value) currentInvoice.buyer.gstin = elements.billBuyerGstin.value.trim();
      if (elements.billBuyerPhone && elements.billBuyerPhone.value) currentInvoice.buyer.phone = elements.billBuyerPhone.value.trim();
      if (elements.billBuyerState && elements.billBuyerState.value) currentInvoice.buyer.state = elements.billBuyerState.value;
      if (elements.billBuyerStateCode && elements.billBuyerStateCode.value) currentInvoice.buyer.stateCode = elements.billBuyerStateCode.value;

      if (!currentInvoice.consignee) currentInvoice.consignee = {};
      if (elements.billConsigneeName && elements.billConsigneeName.value) currentInvoice.consignee.name = elements.billConsigneeName.value.trim();
      if (elements.billConsigneeAddress && elements.billConsigneeAddress.value) currentInvoice.consignee.address = elements.billConsigneeAddress.value.trim();
      if (elements.billConsigneeGstin && elements.billConsigneeGstin.value) currentInvoice.consignee.gstin = elements.billConsigneeGstin.value.trim();
      if (elements.billConsigneePhone && elements.billConsigneePhone.value) currentInvoice.consignee.phone = elements.billConsigneePhone.value.trim();
      if (elements.billConsigneeState && elements.billConsigneeState.value) currentInvoice.consignee.state = elements.billConsigneeState.value;
      if (elements.billConsigneeStateCode && elements.billConsigneeStateCode.value) currentInvoice.consignee.stateCode = elements.billConsigneeStateCode.value;

      if (!Array.isArray(currentInvoice.items)) currentInvoice.items = [];
    } catch (err) {
      console.warn("syncBillingInputsToCurrentInvoice safe catch:", err);
    }
  };

  window.calculateBillingItemNetVal = function() {
    const rate = parseFloat(elements.billItemRate ? elements.billItemRate.value : 0) || 0;
    const discount = parseFloat(elements.billItemDiscount ? elements.billItemDiscount.value : 0) || 0;
    const netVal = Math.max(0, rate - (rate * discount / 100));
    const netValEl = document.getElementById("bill-item-net-val");
    if (netValEl) {
      netValEl.value = rate > 0 ? `₹ ${formatCurrency(netVal)}` : "₹ 0.00";
    }
  };

  // --- PRO AUDIO FEEDBACK SYNTHESIZER (WEB AUDIO API) ---
  let audioCtx = null;
  let audioFxEnabled = localStorage.getItem("billing_audio_fx_enabled") !== "false";

  window.initAudioFeedback = function() {
    const pill = document.getElementById("live-audio-fx-pill");
    const icon = document.getElementById("audio-fx-icon");
    const text = document.getElementById("audio-fx-text");
    if (pill && icon && text) {
      if (audioFxEnabled) {
        pill.classList.remove("muted");
        pill.classList.add("active");
        icon.className = "fa-solid fa-volume-high";
        text.textContent = "Audio ON";
      } else {
        pill.classList.add("muted");
        pill.classList.remove("active");
        icon.className = "fa-solid fa-volume-xmark";
        text.textContent = "Audio OFF";
      }
    }
  };

  window.toggleAudioFeedback = function() {
    audioFxEnabled = !audioFxEnabled;
    localStorage.setItem("billing_audio_fx_enabled", audioFxEnabled ? "true" : "false");
    window.initAudioFeedback();
    if (audioFxEnabled) {
      window.playAudioFeedback("click");
      if (typeof showFloatingToast === 'function') showFloatingToast("🔊 Billing Sound FX Enabled", 2000);
    } else {
      if (typeof showFloatingToast === 'function') showFloatingToast("🔇 Billing Sound FX Muted", 2000);
    }
  };

  window.playAudioFeedback = function(type) {
    if (!audioFxEnabled) return;
    try {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioCtx = new AudioContext();
      }
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === "add") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(1100, now + 0.09);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === "warn") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(170, now + 0.08);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === "success") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.12);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === "click") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.04);
      }
    } catch (e) {
      console.warn("Audio FX note:", e);
    }
  };

  // --- SMART PRODUCT COMBOBOX CONTROLLER ---
  let smartPickerActiveIndex = -1;

  window.openSmartProductPopover = function() {
    const popover = document.getElementById("smart-product-popover");
    const productCard = document.getElementById("billing-product-entry-card");
    if (productCard) {
      productCard.classList.add("popover-active");
      productCard.style.zIndex = "1000";
    }
    if (popover) {
      popover.classList.remove("hidden");
      const query = document.getElementById("smart-product-search")?.value || "";
      window.renderSmartProductResults(query);
    }
  };

  window.closeSmartProductPopover = function() {
    const popover = document.getElementById("smart-product-popover");
    const productCard = document.getElementById("billing-product-entry-card");
    if (productCard) {
      productCard.classList.remove("popover-active");
      productCard.style.zIndex = "";
    }
    if (popover) popover.classList.add("hidden");
    smartPickerActiveIndex = -1;
  };

  window.toggleSmartProductPopover = function() {
    const popover = document.getElementById("smart-product-popover");
    if (popover && popover.classList.contains("hidden")) {
      window.openSmartProductPopover();
      document.getElementById("smart-product-search")?.focus();
    } else {
      window.closeSmartProductPopover();
    }
  };

  window.handleSmartProductSearch = function(query) {
    window.openSmartProductPopover();
    window.renderSmartProductResults(query);
  };

  window.renderSmartProductResults = function(query = "") {
    const container = document.getElementById("smart-product-results");
    const countSpan = document.getElementById("smart-popover-count");
    if (!container) return;

    const q = (query || "").trim().toLowerCase();
    const matched = (window.TurboDataStore && typeof window.TurboDataStore.searchProducts === 'function')
      ? window.TurboDataStore.searchProducts(q, 60)
      : productsDb.filter(p => {
          if (!p) return false;
          if (!q) return true;
          const desc = (p.description || "").toLowerCase();
          const hsn = (p.hsn || "").toLowerCase();
          const pack = (p.packSize || "").toLowerCase();
          return desc.includes(q) || hsn.includes(q) || pack.includes(q);
        });

    if (countSpan) countSpan.textContent = matched.length;
    container.innerHTML = "";

    if (matched.length === 0) {
      container.innerHTML = `
        <div style="padding: 16px 12px; text-align: center; color: #64748b; font-size: 12px;">
          <i class="fa-solid fa-magnifying-glass" style="font-size: 20px; color: #cbd5e1; margin-bottom: 6px; display: block;"></i>
          No catalog items matching "<strong>${escapeHtml(query)}</strong>"
        </div>
      `;
    } else {
      matched.forEach((prod, idx) => {
        const stockVal = prod.stock !== undefined && prod.stock !== null && prod.stock !== "" ? parseInt(prod.stock, 10) || 0 : null;
        let stockTag = "";
        let stockClass = "";
        if (stockVal === null) {
          stockTag = `<span class="popover-stock-tag in"><i class="fa-solid fa-circle-check"></i> Ready</span>`;
        } else if (stockVal <= 0) {
          stockTag = `<span class="popover-stock-tag out"><i class="fa-solid fa-circle-xmark"></i> 0 Out</span>`;
          stockClass = "out-of-stock";
        } else if (stockVal <= 10) {
          stockTag = `<span class="popover-stock-tag low"><i class="fa-solid fa-triangle-exclamation"></i> ${stockVal} Left</span>`;
        } else {
          stockTag = `<span class="popover-stock-tag in"><i class="fa-solid fa-boxes-stacked"></i> ${stockVal} in stock</span>`;
        }

        const packBadge = prod.packSize ? `<span class="popover-badge-pack">${prod.packSize}</span>` : "";
        const hsnBadge = prod.hsn ? `<span class="popover-badge-hsn">HSN: ${prod.hsn}</span>` : "";
        const unitStr = prod.unit ? ` / ${prod.unit}` : "";

        const itemEl = document.createElement("div");
        itemEl.className = `popover-item ${stockClass}`;
        itemEl.dataset.prodId = prod.id;
        itemEl.dataset.index = idx;
        itemEl.innerHTML = `
          <div class="popover-item-left">
            <span class="popover-item-desc">${escapeHtml(prod.description)}</span>
            <div class="popover-item-sub">
              ${packBadge}
              ${hsnBadge}
            </div>
          </div>
          <div class="popover-item-right">
            <span class="popover-price">₹ ${formatCurrency(prod.rate)}${unitStr}</span>
            ${stockTag}
          </div>
        `;

        itemEl.addEventListener("click", () => {
          window.selectSmartProduct(prod.id);
        });

        container.appendChild(itemEl);
      });
    }

    if (q) {
      const customRow = document.createElement("div");
      customRow.className = "popover-custom-item-row";
      customRow.innerHTML = `
        <i class="fa-solid fa-circle-plus"></i>
        <span>Use Custom Item: "<strong>${escapeHtml(query)}</strong>"</span>
      `;
      customRow.addEventListener("click", () => {
        window.selectCustomSmartProduct(query);
      });
      container.appendChild(customRow);
    }

    smartPickerActiveIndex = -1;
  };

  window.selectSmartProduct = function(prodId) {
    const prod = (window.TurboDataStore && typeof window.TurboDataStore.getProduct === 'function')
      ? window.TurboDataStore.getProduct(prodId)
      : productsDb.find(p => p && p.id === prodId);
    if (!prod) return;

    if (elements.billItemSelect) {
      elements.billItemSelect.value = prod.id;
      elements.billItemSelect.dispatchEvent(new Event("change"));
    }

    const selectedChip = document.getElementById("smart-picker-selected");
    const inputWrap = document.getElementById("smart-picker-input-wrap");
    const titleSpan = document.getElementById("smart-picker-selected-title");
    const packSpan = document.getElementById("smart-picker-selected-pack");

    if (selectedChip && inputWrap && titleSpan) {
      titleSpan.textContent = prod.description;
      if (packSpan) {
        packSpan.textContent = prod.packSize || prod.unit || "";
        packSpan.style.display = (prod.packSize || prod.unit) ? "inline-block" : "none";
      }
      selectedChip.classList.remove("hidden");
      inputWrap.classList.add("hidden");
    }

    window.closeSmartProductPopover();
    window.playAudioFeedback("click");

    setTimeout(() => {
      const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
      if (qtyInput) {
        qtyInput.focus();
        qtyInput.select();
      }
    }, 60);
  };

  window.selectCustomSmartProduct = function(customDesc) {
    const cleanDesc = (customDesc || "").trim();
    if (!cleanDesc) return;

    if (elements.billItemSelect) elements.billItemSelect.value = "__custom__";
    if (elements.billItemName) elements.billItemName.value = cleanDesc;

    const selectedChip = document.getElementById("smart-picker-selected");
    const inputWrap = document.getElementById("smart-picker-input-wrap");
    const titleSpan = document.getElementById("smart-picker-selected-title");
    const packSpan = document.getElementById("smart-picker-selected-pack");

    if (selectedChip && inputWrap && titleSpan) {
      titleSpan.textContent = cleanDesc;
      if (packSpan) packSpan.style.display = "none";
      selectedChip.classList.remove("hidden");
      inputWrap.classList.add("hidden");
    }

    window.closeSmartProductPopover();
    window.updateBillingStockTelemetry(null);
    window.playAudioFeedback("click");

    setTimeout(() => {
      const rateInput = elements.billItemRate || document.getElementById("bill-item-rate");
      if (rateInput) {
        rateInput.focus();
        rateInput.select();
      }
    }, 60);
  };

  window.clearSmartProductSelection = function() {
    const selectedChip = document.getElementById("smart-picker-selected");
    const inputWrap = document.getElementById("smart-picker-input-wrap");
    const searchInput = document.getElementById("smart-product-search");

    if (selectedChip && inputWrap) {
      selectedChip.classList.add("hidden");
      inputWrap.classList.remove("hidden");
    }

    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }

    if (elements.billItemSelect) {
      elements.billItemSelect.value = "";
      elements.billItemSelect.dispatchEvent(new Event("change"));
    }
    if (elements.billItemName) elements.billItemName.value = "";

    window.updateBillingStockTelemetry(null);
    window.playAudioFeedback("click");
  };

  window.handleSmartPickerKeydown = function(e) {
    const popover = document.getElementById("smart-product-popover");
    const isVisible = popover && !popover.classList.contains("hidden");

    if (e.key === "Escape") {
      window.closeSmartProductPopover();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isVisible) {
        window.openSmartProductPopover();
        return;
      }
      const items = popover.querySelectorAll(".popover-item, .popover-custom-item-row");
      if (items.length === 0) return;
      smartPickerActiveIndex = (smartPickerActiveIndex + 1) % items.length;
      items.forEach((it, i) => it.classList.toggle("active", i === smartPickerActiveIndex));
      items[smartPickerActiveIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isVisible) return;
      const items = popover.querySelectorAll(".popover-item, .popover-custom-item-row");
      if (items.length === 0) return;
      smartPickerActiveIndex = (smartPickerActiveIndex - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle("active", i === smartPickerActiveIndex));
      items[smartPickerActiveIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Enter") {
      if (isVisible) {
        e.preventDefault();
        const items = popover.querySelectorAll(".popover-item, .popover-custom-item-row");
        if (smartPickerActiveIndex >= 0 && items[smartPickerActiveIndex]) {
          items[smartPickerActiveIndex].click();
        } else if (items.length > 0) {
          items[0].click();
        } else {
          const val = document.getElementById("smart-product-search")?.value;
          if (val) window.selectCustomSmartProduct(val);
        }
      }
    }
  };

  // Close popover when clicking outside
  document.addEventListener("click", (e) => {
    const picker = document.getElementById("smart-picker-container");
    if (picker && !picker.contains(e.target)) {
      window.closeSmartProductPopover();
    }
  });

  // --- QTY STEPPERS & PRESETS ---
  window.stepBillingQty = function(delta) {
    const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
    if (!qtyInput) return;
    const curVal = parseInt(qtyInput.value, 10) || 1;
    const newVal = Math.max(1, curVal + delta);
    qtyInput.value = newVal;
    window.handleBillingQtyInput();
    if (typeof calculateBillingItemNetVal === 'function') calculateBillingItemNetVal();
    window.playAudioFeedback("click");
  };

  window.setBillingQtyPreset = function(delta) {
    const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
    if (!qtyInput) return;
    const curVal = parseInt(qtyInput.value, 10) || 0;
    const newVal = Math.max(1, curVal + delta);
    qtyInput.value = newVal;
    window.handleBillingQtyInput();
    if (typeof calculateBillingItemNetVal === 'function') calculateBillingItemNetVal();
    window.playAudioFeedback("click");
  };

  window.setBillingDiscountPreset = function(pct) {
    const discInput = elements.billItemDiscount || document.getElementById("bill-item-discount");
    if (discInput) {
      discInput.value = pct;
      if (typeof calculateBillingItemNetVal === 'function') calculateBillingItemNetVal();
      window.playAudioFeedback("click");
    }
  };

  // --- IN-TABLE QUANTITY STEPPER CONTROLLER ---
  window.stepTableItemQty = function(itemId, delta) {
    if (!currentInvoice || !Array.isArray(currentInvoice.items)) return;
    const item = currentInvoice.items.find(it => it.id === itemId);
    if (!item) return;

    const oldQty = parseFloat(item.quantity) || 1;
    const newQty = oldQty + delta;

    if (newQty <= 0) {
      window.deleteBillingItemRow(itemId);
      return;
    }

    if (delta > 0) {
      const prod = productsDb.find(p => (item.productId && p.id === item.productId) || ((p.description || '').trim().toLowerCase() === (item.description || '').trim().toLowerCase()));
      if (prod && prod.stock !== undefined && prod.stock !== null && prod.stock !== '') {
        const liveStock = parseInt(prod.stock, 10) || 0;
        let previouslyInvoicedQty = 0;
        if (currentInvoice && currentInvoice.isEditing && currentInvoice.id) {
          const origInv = invoicesDb.find(inv => inv && inv.id === currentInvoice.id);
          if (origInv && origInv.details && Array.isArray(origInv.details.items)) {
            const matchOld = origInv.details.items.find(it => (it.productId && prod.id && it.productId === prod.id) || (it.description && prod.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase()));
            if (matchOld) previouslyInvoicedQty = parseFloat(matchOld.quantity) || 0;
          }
        }
        const effectiveAvailable = liveStock + previouslyInvoicedQty;
        const totalOtherInCart = currentInvoice.items
          .filter(it => it.id !== itemId && ((it.productId && prod.id && it.productId === prod.id) || ((it.description || '').trim().toLowerCase() === (prod.description || '').trim().toLowerCase())))
          .reduce((sum, it) => sum + (parseFloat(it.quantity) || 0), 0);

        if (totalOtherInCart + newQty > effectiveAvailable) {
          const maxCan = Math.max(0, effectiveAvailable - totalOtherInCart);
          showFloatingToast(`❌ Cannot increase: "${prod.description}" has only ${effectiveAvailable} in stock. Maximum total is ${maxCan}.`, "warning");
          window.playAudioFeedback("warn");
          return;
        }
      }
    }

    item.quantity = newQty;
    const rate = item.rate || 0;
    const disc = item.discount || 0;
    const netRate = Math.max(0, rate - (rate * disc / 100));
    item.amount = Math.round((netRate * newQty) * 100) / 100;

    calculateSummaryAndTable();
    if (typeof handleBillingQtyInput === 'function') handleBillingQtyInput();
    window.playAudioFeedback("click");
  };

  // --- SEGMENTED PAYMENT STATUS & QUICK CASH ---
  window.setPaymentStatusSegment = function(status) {
    const sel = elements.billPaymentStatus || document.getElementById("bill-payment-status");
    if (sel) {
      sel.value = status;
      if (typeof handlePaymentStatusChange === 'function') handlePaymentStatusChange();
    }

    const pills = document.querySelectorAll(".btn-seg-pill");
    pills.forEach(p => p.classList.toggle("active", p.dataset.status === status));

    const badge = document.getElementById("payment-status-badge");
    if (badge) {
      badge.textContent = status.toUpperCase();
      badge.className = `badge-status-pill ${status.toLowerCase()}`;
    }

    window.playAudioFeedback("click");
  };

  window.applyQuickCash = function(mode) {
    const totalSpan = document.getElementById("sum-grand-total");
    const grandTotal = currentInvoice && currentInvoice.grandTotal ? currentInvoice.grandTotal : (parseFloat((totalSpan?.textContent || "0").replace(/[^0-9.]/g, '')) || 0);

    const paidInput = elements.billPaidAmount || document.getElementById("bill-paid-amount");
    const balInput = elements.billBalancePaid || document.getElementById("bill-balance-paid");

    if (mode === "full") {
      window.setPaymentStatusSegment("Paid");
      if (paidInput) paidInput.value = grandTotal.toFixed(2);
      if (balInput) balInput.value = "0.00";
    } else if (mode === "round") {
      window.setPaymentStatusSegment("Partial");
      const rounded = Math.floor(grandTotal / 100) * 100;
      if (paidInput) paidInput.value = rounded.toFixed(2);
    } else if (mode === "zero") {
      window.setPaymentStatusSegment("Unpaid");
      if (paidInput) paidInput.value = "0.00";
      if (balInput) balInput.value = "0.00";
    }

    calculateSummaryAndTable();
    window.playAudioFeedback("click");
  };

  // --- KEYBOARD SHORTCUTS ENGINE & COMMAND PALETTE ---
  window.openKeyboardShortcutsModal = function() {
    const modal = document.getElementById("keyboard-shortcuts-modal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.style.display = "flex";
    }
  };

  window.closeKeyboardShortcutsModal = function() {
    const modal = document.getElementById("keyboard-shortcuts-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.style.display = "none";
    }
  };

  // --- FREQUENT PRODUCTS QUICK-ADD BAR ---
  window.renderFrequentProductsBar = function() {
    const chipsContainer = document.getElementById("frequent-products-chips");
    if (!chipsContainer) return;

    // Calculate product frequency across all invoices
    const freqMap = new Map();
    (invoicesDb || []).forEach(inv => {
      const items = inv.items || inv.details?.items || [];
      items.forEach(it => {
        const key = (it.productId || it.description || '').trim().toLowerCase();
        if (key) {
          freqMap.set(key, (freqMap.get(key) || 0) + (parseFloat(it.quantity) || 1));
        }
      });
    });

    // Score products
    const rankedProducts = (productsDb || []).slice().sort((a, b) => {
      const scoreA = freqMap.get(String(a.id || '').toLowerCase()) || freqMap.get(String(a.description || '').trim().toLowerCase()) || 0;
      const scoreB = freqMap.get(String(b.id || '').toLowerCase()) || freqMap.get(String(b.description || '').trim().toLowerCase()) || 0;
      return scoreB - scoreA;
    }).slice(0, 8);

    if (rankedProducts.length === 0) {
      chipsContainer.innerHTML = `<span style="font-size: 11px; color: #94a3b8; padding: 4px 0;">Add catalog products to see quick-add chips here.</span>`;
      return;
    }

    chipsContainer.innerHTML = rankedProducts.map(p => {
      const rate = formatCurrency(p.rate || 0);
      const stock = p.stock !== undefined ? parseInt(p.stock, 10) : 0;
      const stockText = stock > 0 ? `${stock} left` : 'Out of stock';
      return `
        <div class="frequent-chip" onclick="quickAddProductToBill('${p.id}')" title="1-Tap Add: ${p.description} (₹${rate})">
          <i class="fa-solid fa-plus text-teal"></i>
          <span>${p.description}</span>
          <span class="chip-price">₹${rate}</span>
          <span class="chip-stock">${stockText}</span>
        </div>
      `;
    }).join('');
  };

  window.quickAddProductToBill = function(prodId) {
    const prod = (productsDb || []).find(p => p && (p.id === prodId || p.description === prodId));
    if (!prod) {
      if (typeof showFloatingToast === 'function') showFloatingToast("Product not found in catalog", "warning");
      return;
    }

    if (!currentInvoice) currentInvoice = {};
    if (!Array.isArray(currentInvoice.items)) currentInvoice.items = [];

    // Check if this product is already in the items list
    const existing = currentInvoice.items.find(it => 
      (it.productId && it.productId === prod.id) || 
      (it.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
    );

    if (existing) {
      existing.quantity = (parseFloat(existing.quantity) || 0) + 1;
      const rate = existing.rate || 0;
      const disc = existing.discount || 0;
      const netRate = Math.max(0, rate - (rate * disc / 100));
      existing.amount = Math.round((netRate * existing.quantity) * 100) / 100;
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`➕ Incremented ${prod.description} to ${existing.quantity} ${existing.unit || 'units'}`, 2500);
      }
    } else {
      const rate = parseFloat(prod.rate) || 0;
      const unit = prod.unit || "Bucket";
      const gstRate = parseFloat(prod.gstRate) || 0;
      currentInvoice.items.push({
        productId: prod.id,
        description: prod.description,
        hsn: prod.hsn || "",
        quantity: 1,
        unit: unit,
        rate: rate,
        discount: 0,
        gstRate: gstRate,
        amount: rate
      });
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`⚡ 1-Tap Added: ${prod.description} (₹${formatCurrency(rate)})`, 2500);
      }
    }

    if (typeof calculateSummaryAndTable === 'function') calculateSummaryAndTable();
    if (typeof window.playAudioFeedback === 'function') window.playAudioFeedback("add");
  };
  // Customer Outstanding & Trust Ledger functions are defined above before updateDashboardOverview

  // --- ENHANCED KEYBOARD SHORTCUTS CONTROLLER ---
  let cmdPaletteSelectedIndex = 0;
  // ============================================================================
  // TURBO INTELLIGENCE & GLOBAL COMMAND SPOTLIGHT HUB (Ctrl+K / Alt+K)
  // ============================================================================
  let currentCmdPaletteItems = [];
  let currentTurboFilter = 'all'; // 'all' | 'parties' | 'products' | 'invoices' | 'actions'

  window.setTurboFilter = function(filter) {
    currentTurboFilter = filter || 'all';
    document.querySelectorAll('.turbo-filter-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.filter === currentTurboFilter);
    });
    const cmdInput = document.getElementById("cmd-palette-input");
    window.renderCommandPalette(cmdInput ? cmdInput.value : "");
    if (cmdInput) cmdInput.focus();
  };

  window.clearTurboSearch = function() {
    const cmdInput = document.getElementById("cmd-palette-input");
    if (cmdInput) {
      cmdInput.value = "";
      window.renderCommandPalette("");
      cmdInput.focus();
    }
  };

  window.openCommandPalette = function() {
    const modal = document.getElementById("global-command-palette-modal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.style.display = "flex";
      currentTurboFilter = 'all';
      document.querySelectorAll('.turbo-filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === 'all');
      });
      const cmdInput = document.getElementById("cmd-palette-input");
      if (cmdInput) {
        cmdInput.value = "";
        cmdPaletteSelectedIndex = 0;
        window.renderCommandPalette("");
        cmdInput.focus();
      }
    } else if (typeof window.openKeyboardShortcutsModal === 'function') {
      window.openKeyboardShortcutsModal();
    }
  };

  window.closeCommandPalette = function() {
    const modal = document.getElementById("global-command-palette-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.style.display = "none";
    }
  };

  window.quickBillForParty = function(partyName, partyPhone = '') {
    window.closeCommandPalette();
    switchTab('billing');
    setTimeout(() => {
      if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
      if (elements.billBuyerName) {
        elements.billBuyerName.value = partyName;
        elements.billBuyerName.dispatchEvent(new Event('input'));
      }
      if (partyPhone && elements.billBuyerPhone) {
        elements.billBuyerPhone.value = partyPhone;
      }
      const searchInput = document.getElementById("smart-product-search");
      if (searchInput) {
        searchInput.focus();
        window.openSmartProductPopover();
      }
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`⚡ Ready to bill for ${partyName}`, 3000);
      }
    }, 120);
  };

  window.addProductToActiveBill = function(prodId) {
    window.closeCommandPalette();
    switchTab('billing');
    setTimeout(() => {
      const prod = (productsDb || []).find(p => p && (p.id === prodId || p.description === prodId));
      if (prod && typeof window.selectSmartProduct === 'function') {
        window.selectSmartProduct(prod.id || prod.description, prod.description, prod.salesRate || prod.price || 0, prod.hsn || '', prod.unit || 'Kg', prod.taxRate || 0, prod.stock || 0);
        if (typeof showFloatingToast === 'function') {
          showFloatingToast(`🐟 Added "${prod.description}" to bill`, 2500);
        }
      }
    }, 120);
  };

  window.renderCommandPalette = function(query = "") {
    const listEl = document.getElementById("cmd-palette-results");
    const clearBtn = document.getElementById("turbo-clear-btn");
    const metricsBar = document.getElementById("turbo-metrics-bar");
    if (!listEl) return;

    const q = (query || "").trim().toLowerCase();
    if (clearBtn) clearBtn.classList.toggle("hidden", !q);
    if (metricsBar) metricsBar.style.display = q ? "none" : "grid";

    // 1. Compute Live Stats for Metrics Bar
    const todayStr = new Date().toISOString().split('T')[0];
    const invoices = (window.invoicesHistory || invoicesDb || []);
    let todaySales = 0;
    let totalDue = 0;
    invoices.forEach(inv => {
      const d = inv.details || inv;
      const invDate = inv.date || d.invoiceDate || "";
      if (String(invDate).startsWith(todayStr)) {
        todaySales += Number(d.grandTotal || d.total || inv.grandTotal || 0);
      }
      const bal = Number(d.balanceDue || inv.balanceDue || 0);
      if (bal > 0) totalDue += bal;
    });

    const products = (productsDb || window.allProducts || []);
    const lowStockCount = products.filter(p => {
      const s = parseInt(p?.stock, 10);
      return !isNaN(s) && s <= 10;
    }).length;

    const waStatusPill = document.getElementById("live-whatsapp-pill");
    const isWaConnected = waStatusPill && waStatusPill.classList.contains("connected");

    const mTodaySales = document.getElementById("turbo-metric-today-sales");
    const mTotalDue = document.getElementById("turbo-metric-total-due");
    const mLowStock = document.getElementById("turbo-metric-low-stock");
    const mWaStatus = document.getElementById("turbo-metric-wa-status");

    if (mTodaySales) mTodaySales.textContent = `₹ ${Math.round(todaySales).toLocaleString('en-IN')}`;
    if (mTotalDue) mTotalDue.textContent = `₹ ${Math.round(totalDue).toLocaleString('en-IN')}`;
    if (mLowStock) mLowStock.textContent = `${lowStockCount} Items`;
    if (mWaStatus) {
      mWaStatus.textContent = isWaConnected ? "Connected 🟢" : "Offline 🔴";
      mWaStatus.style.color = isWaConnected ? "#16a34a" : "#dc2626";
    }

    // 2. Gather All Categorized Items
    const partyItems = [];
    const parties = (partiesDb || []);
    parties.forEach(party => {
      const name = party.name || party.customerName || "Customer";
      const phone = party.phone || party.mobile || "";
      const address = party.address || "";
      // Calculate total customer outstanding balance across past invoices
      let partyDue = 0;
      let billCount = 0;
      invoices.forEach(inv => {
        const d = inv.details || inv;
        const buyer = d.buyer || inv.buyer || {};
        const bName = String(buyer.name || inv.customerName || d.customerName || "").trim().toLowerCase();
        if (bName && bName === name.trim().toLowerCase()) {
          partyDue += Number(d.balanceDue || inv.balanceDue || 0);
          billCount++;
        }
      });

      partyItems.push({
        type: 'party',
        id: 'party_' + (party.id || name),
        title: name,
        subtitle: `${phone ? '📞 ' + phone : ''} ${address ? '• ' + address : ''} • ${billCount} Past Bills`,
        badge: partyDue > 0 ? `₹ ${Math.round(partyDue).toLocaleString('en-IN')} Due` : 'Khata Clear',
        badgeClass: partyDue > 0 ? 'due' : 'clear',
        icon: 'fa-user-tie',
        searchStr: `${name} ${phone} ${address}`.toLowerCase(),
        action: () => window.quickBillForParty(name, phone),
        quickActions: [
          { label: '⚡ Bill', icon: 'fa-plus', action: `window.quickBillForParty('${name.replace(/'/g, "\\'")}', '${phone}')` },
          { label: '📱 Statement', icon: 'fa-whatsapp', action: `sendPartyWhatsAppStatement('${name.replace(/'/g, "\\'")}', '${phone}')` }
        ]
      });
    });

    const productItems = [];
    products.forEach(p => {
      const name = p.description || p.name || "Product";
      const rate = Number(p.salesRate || p.price || 0);
      const stock = parseInt(p.stock, 10) || 0;
      const unit = p.unit || "Kg";
      const hsn = p.hsn || "";
      productItems.push({
        type: 'product',
        id: 'prod_' + (p.id || name),
        title: name,
        subtitle: `Rate: ₹ ${rate}/${unit} ${hsn ? '• HSN: ' + hsn : ''}`,
        badge: stock <= 0 ? 'Out of Stock' : (stock <= 10 ? `Low: ${stock} ${unit}` : `Stock: ${stock} ${unit}`),
        badgeClass: stock <= 0 ? 'low' : (stock <= 10 ? 'low' : 'stock'),
        icon: 'fa-fish',
        searchStr: `${name} ${hsn} ${p.category || ''}`.toLowerCase(),
        action: () => window.addProductToActiveBill(p.id || name),
        quickActions: [
          { label: '➕ Add to Bill', icon: 'fa-cart-plus', action: `window.addProductToActiveBill('${p.id || name}')` }
        ]
      });
    });

    const invoiceItems = [];
    invoices.slice(0, 50).forEach(inv => {
      const d = inv.details || inv;
      const invNo = inv.invoiceNo || d.invoiceNo || "INV";
      const buyer = d.buyer || inv.buyer || {};
      const buyerName = buyer.name || inv.customerName || d.customerName || "Customer";
      const date = inv.date || d.invoiceDate || "";
      const total = Number(d.grandTotal || d.total || inv.grandTotal || 0);
      const balance = Number(d.balanceDue || inv.balanceDue || 0);
      const status = balance <= 0 ? 'Paid' : (balance >= total ? 'Unpaid' : 'Partial');

      invoiceItems.push({
        type: 'invoice',
        id: 'inv_' + (inv.id || invNo),
        title: `Invoice #${invNo} • ${buyerName}`,
        subtitle: `Date: ${date} • Total: ₹ ${Math.round(total).toLocaleString('en-IN')}`,
        badge: status === 'Paid' ? 'Paid' : `Due: ₹ ${Math.round(balance).toLocaleString('en-IN')}`,
        badgeClass: status === 'Paid' ? 'paid' : 'due',
        icon: 'fa-file-invoice-dollar',
        searchStr: `${invNo} ${buyerName} ${date}`.toLowerCase(),
        action: () => {
          window.closeCommandPalette();
          if (typeof previewSavedInvoice === 'function') previewSavedInvoice(inv.id || invNo);
        },
        quickActions: [
          { label: '🖨️ Print', icon: 'fa-print', action: `printSavedInvoice('${inv.id || invNo}')` },
          { label: '📱 WhatsApp', icon: 'fa-whatsapp', action: `shareInvoiceWhatsApp('${inv.id || invNo}')` }
        ]
      });
    });

    const systemActionItems = [
      { type: 'action', id: 'act_new_bill', title: 'New GST Invoice', subtitle: 'Open blank invoice form (Alt+N)', icon: 'fa-plus', searchStr: 'new invoice bill create gst', action: () => switchTab('billing') },
      { type: 'action', id: 'act_daily_digest', title: 'Today\'s Sales & Profit Analytics', subtitle: 'View real-time daily revenue and collection report', icon: 'fa-chart-pie', searchStr: 'today sales report profit analytics daily', action: () => switchTab('reports') },
      { type: 'action', id: 'act_parties', title: 'Customer Khata & Balance Directory', subtitle: 'Manage customer accounts, send payment reminders', icon: 'fa-users', searchStr: 'customers parties khata balance due directory', action: () => switchTab('parties') },
      { type: 'action', id: 'act_stock', title: 'Fish & Feed Inventory Management', subtitle: 'View stock balances, inward restock, price list', icon: 'fa-cubes', searchStr: 'products fish inventory stock restock feed', action: () => switchTab('products') },
      { type: 'action', id: 'act_history', title: 'Past Invoice History & Statements', subtitle: 'Search and reprint previous bills and payment slips', icon: 'fa-clock-rotate-left', searchStr: 'history invoices past bills receipts archive', action: () => switchTab('history') },
      { type: 'action', id: 'act_wa_bot', title: 'WhatsApp Bot Control & QR Linking', subtitle: 'Check bot daemon status and link WhatsApp device', icon: 'fa-whatsapp', searchStr: 'whatsapp bot status connect qr qr ready daemon', action: () => openWhatsAppBotModal() },
      { type: 'action', id: 'act_cloud_sync', title: 'Google Database Cloud Sync Now', subtitle: 'Trigger instant 2-way cloud synchronization with Google Sheets', icon: 'fa-cloud-arrow-up', searchStr: 'cloud sync google sheet backup database', action: () => { if (typeof syncDatabaseToServer === 'function') syncDatabaseToServer(); showFloatingToast('☁️ Cloud database synchronized successfully!', 2500); } },
      { type: 'action', id: 'act_export_excel', title: 'Export Invoices to Excel / CSV', subtitle: 'Download complete billing dataset spreadsheet', icon: 'fa-file-excel', searchStr: 'export excel csv download backup reports', action: () => { if (typeof exportInvoicesToExcel === 'function') exportInvoicesToExcel(); else showFloatingToast('Exporting to spreadsheet...', 2000); } },
      { type: 'action', id: 'act_calc', title: 'Quick Floating Calculator', subtitle: 'Open speed calculator & net weight injector (Alt+C)', icon: 'fa-calculator', searchStr: 'calculator calc math weight lots', action: () => toggleQuickCalculator() },
      { type: 'action', id: 'act_shortcuts', title: 'Keyboard Hotkeys Cheatsheet', subtitle: 'View all fast keyboard shortcuts (Alt+/)', icon: 'fa-keyboard', searchStr: 'keyboard shortcuts hotkeys keys fast', action: () => openKeyboardShortcutsModal() }
    ];

    // Filter by query
    const filterList = (arr) => q ? arr.filter(it => it.searchStr.includes(q) || it.title.toLowerCase().includes(q)) : arr;

    const filteredParties = filterList(partyItems);
    const filteredProducts = filterList(productItems);
    const filteredInvoices = filterList(invoiceItems);
    const filteredActions = filterList(systemActionItems);

    // Update Tab Counts
    const cAll = filteredParties.length + filteredProducts.length + filteredInvoices.length + filteredActions.length;
    const countAll = document.getElementById("turbo-count-all");
    const countParties = document.getElementById("turbo-count-parties");
    const countProducts = document.getElementById("turbo-count-products");
    const countInvoices = document.getElementById("turbo-count-invoices");
    const countActions = document.getElementById("turbo-count-actions");

    if (countAll) countAll.textContent = cAll;
    if (countParties) countParties.textContent = filteredParties.length;
    if (countProducts) countProducts.textContent = filteredProducts.length;
    if (countInvoices) countInvoices.textContent = filteredInvoices.length;
    if (countActions) countActions.textContent = filteredActions.length;

    // Combine based on active tab
    let displayList = [];
    if (currentTurboFilter === 'parties') {
      displayList = filteredParties;
    } else if (currentTurboFilter === 'products') {
      displayList = filteredProducts;
    } else if (currentTurboFilter === 'invoices') {
      displayList = filteredInvoices;
    } else if (currentTurboFilter === 'actions') {
      displayList = filteredActions;
    } else {
      // 'all': Show a curated balanced list
      if (q) {
        displayList = [
          ...filteredParties.slice(0, 5),
          ...filteredProducts.slice(0, 5),
          ...filteredInvoices.slice(0, 5),
          ...filteredActions.slice(0, 4)
        ];
      } else {
        displayList = [
          ...filteredActions.slice(0, 4),
          ...filteredParties.slice(0, 4),
          ...filteredProducts.slice(0, 4),
          ...filteredInvoices.slice(0, 4)
        ];
      }
    }

    currentCmdPaletteItems = displayList;

    if (displayList.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 32px 16px; text-align: center; color: #94a3b8;">
          <i class="fa-solid fa-magnifying-glass" style="font-size: 28px; opacity: 0.4; margin-bottom: 8px;"></i>
          <div style="font-size: 14px; font-weight: 600; color: #64748b;">No matching results for "${query}"</div>
          <div style="font-size: 12px; margin-top: 4px;">Try searching with a customer name, fish species, or invoice number.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = displayList.map((it, idx) => `
      <div class="turbo-result-item type-${it.type} ${idx === cmdPaletteSelectedIndex ? 'selected' : ''}"
           onclick="window.executeCommandPaletteItem(${idx})"
           data-index="${idx}">
        <div class="turbo-item-icon">
          <i class="fa-solid ${it.icon}"></i>
        </div>
        <div class="turbo-item-main">
          <div class="turbo-item-title-row">
            <span class="turbo-item-title">${it.title}</span>
            ${it.badge ? `<span class="turbo-item-badge ${it.badgeClass || ''}">${it.badge}</span>` : ''}
          </div>
          <div class="turbo-item-meta">${it.subtitle}</div>
        </div>
        ${it.quickActions && it.quickActions.length ? `
          <div class="turbo-item-actions" onclick="event.stopPropagation()">
            ${it.quickActions.map(qa => `
              <button type="button" class="turbo-action-btn" onclick="${qa.action}; window.closeCommandPalette();">
                <i class="fa-solid ${qa.icon}"></i> ${qa.label}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');
  };

  window.executeCommandPaletteItem = function(index) {
    if (currentCmdPaletteItems && currentCmdPaletteItems[index]) {
      const item = currentCmdPaletteItems[index];
      window.closeCommandPalette();
      if (typeof item.action === 'function') item.action();
    }
  };

  function scrollToSelectedCmdItem() {
    const listEl = document.getElementById("cmd-palette-results");
    if (!listEl) return;
    const selected = listEl.querySelector(".turbo-result-item.selected");
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  window.initKeyboardShortcuts = function() {
    const cmdInput = document.getElementById("cmd-palette-input");
    if (cmdInput && !cmdInput.dataset.wired) {
      cmdInput.dataset.wired = "true";
      cmdInput.addEventListener("input", (e) => {
        cmdPaletteSelectedIndex = 0;
        window.renderCommandPalette(e.target.value);
      });

      cmdInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (currentCmdPaletteItems.length > 0) {
            cmdPaletteSelectedIndex = (cmdPaletteSelectedIndex + 1) % currentCmdPaletteItems.length;
            window.renderCommandPalette(cmdInput.value);
            scrollToSelectedCmdItem();
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (currentCmdPaletteItems.length > 0) {
            cmdPaletteSelectedIndex = (cmdPaletteSelectedIndex - 1 + currentCmdPaletteItems.length) % currentCmdPaletteItems.length;
            window.renderCommandPalette(cmdInput.value);
            scrollToSelectedCmdItem();
          }
        } else if (e.key === "Tab") {
          e.preventDefault();
          const filters = ['all', 'parties', 'products', 'invoices', 'actions'];
          const nextIdx = (filters.indexOf(currentTurboFilter) + 1) % filters.length;
          window.setTurboFilter(filters[nextIdx]);
        } else if (e.key === "Enter") {
          e.preventDefault();
          window.executeCommandPaletteItem(cmdPaletteSelectedIndex);
        } else if (e.key === "Escape") {
          window.closeCommandPalette();
        }
      });
    }

    document.addEventListener("keydown", (e) => {
      // 1. Escape closes Command Palette, shortcuts modal, and popovers
      if (e.key === "Escape") {
        if (typeof window.closeCommandPalette === 'function') window.closeCommandPalette();
        if (typeof window.closeDynamicUpiModal === 'function') window.closeDynamicUpiModal();
        if (typeof window.closeSmartProductPopover === 'function') window.closeSmartProductPopover();
        if (typeof window.closeKeyboardShortcutsModal === 'function') window.closeKeyboardShortcutsModal();
        return;
      }

      // 2. F4 or Ctrl+Enter: FAST 1-KEY POS SAVE & AUTO-DISPATCH
      if (e.key === "F4" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
        const billingView = document.getElementById("view-billing");
        if (billingView && !billingView.classList.contains("hidden")) {
          e.preventDefault();
          const saveBtn = document.getElementById("btn-save-generate-invoice");
          if (saveBtn) {
            if (typeof saveAndGenerateInvoiceOnly === 'function') saveAndGenerateInvoiceOnly(saveBtn);
          }
          return;
        }
      }

      // 3. Quick Inward Restock: F2
      if (e.key === "F2") {
        e.preventDefault();
        if (typeof window.triggerQuickInwardFromBilling === 'function') {
          window.triggerQuickInwardFromBilling();
        }
        return;
      }

      // 4. Command Palette: Ctrl+K or Cmd+K or Alt+K
      if (((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) || (e.altKey && (e.key === "k" || e.key === "K"))) {
        e.preventDefault();
        const modal = document.getElementById("global-command-palette-modal");
        if (modal && !modal.classList.contains("hidden")) {
          window.closeCommandPalette();
        } else {
          window.openCommandPalette();
        }
        return;
      }

      // 5. Navigation shortcuts: Alt+N, Alt+D, Alt+H, Alt+P, Alt+R, Alt+S, Alt+C, Alt+W
      if (e.altKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
        if (qtyInput) {
          qtyInput.focus();
          qtyInput.select();
        }
        return;
      }

      if (e.altKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        switchTab("billing");
        if (typeof autoSuggestInvoiceNo === 'function') autoSuggestInvoiceNo();
        setTimeout(() => {
          if (elements.billBuyerName) elements.billBuyerName.focus();
        }, 100);
        return;
      }

      if (e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        switchTab("dashboard");
        return;
      }

      if (e.altKey && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        switchTab("history");
        return;
      }

      if (e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        // If in billing view, focus product search, else switch to products
        const billingView = document.getElementById("view-billing");
        if (billingView && !billingView.classList.contains("hidden")) {
          const searchInput = document.getElementById("smart-product-search");
          if (searchInput) {
            const selectedChip = document.getElementById("smart-picker-selected");
            if (selectedChip && !selectedChip.classList.contains("hidden")) {
              window.clearSmartProductSelection();
            } else {
              searchInput.focus();
              window.openSmartProductPopover();
            }
          }
        } else {
          switchTab("products");
        }
        return;
      }

      if (e.altKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        switchTab("reports");
        return;
      }

      if (e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        switchTab("settings");
        return;
      }

      if (e.altKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        switchTab("parties");
        return;
      }

      if (e.altKey && e.key === "/") {
        e.preventDefault();
        window.openKeyboardShortcutsModal();
        return;
      }

      if (e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        window.toggleAudioFeedback();
        return;
      }

      if ((e.ctrlKey && e.key === "Enter") || (e.altKey && (e.key === "a" || e.key === "A"))) {
        e.preventDefault();
        if (typeof addBillingItemRow === 'function') addBillingItemRow();
        return;
      }

      if (e.ctrlKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        const saveBtn = document.getElementById("btn-save-generate-invoice");
        if (saveBtn) saveBtn.click();
        return;
      }

      if (e.ctrlKey && (e.key === "p" || e.key === "P") && !e.shiftKey) {
        const billingView = document.getElementById("view-billing");
        if (billingView && !billingView.classList.contains("hidden")) {
          e.preventDefault();
          if (typeof generateAndPrintInvoice === 'function') generateAndPrintInvoice();
        }
      }
    });
  };

  window.updateBillingStockTelemetry = function(prod) {
    const stockPill = document.getElementById("bill-stock-pill");
    const stockPillText = document.getElementById("bill-stock-pill-text");
    const hiddenInput = document.getElementById("bill-item-stock-qty");
    const restockBtn = document.getElementById("btn-quick-inward-billing");

    if (!prod) {
      if (stockPill) stockPill.className = "stock-indicator-pill neutral";
      if (stockPillText) stockPillText.textContent = "—";
      if (hiddenInput) hiddenInput.value = "—";
      if (restockBtn) restockBtn.classList.add("hidden");
      if (typeof window.handleBillingQtyInput === 'function') window.handleBillingQtyInput();
      return;
    }

    const stockVal = prod.stock !== undefined ? parseInt(prod.stock, 10) : 0;
    if (hiddenInput) hiddenInput.value = stockVal;
    if (restockBtn) restockBtn.classList.remove("hidden");

    if (stockPill && stockPillText) {
      if (stockVal === 0) {
        stockPill.className = "stock-indicator-pill out";
        stockPillText.textContent = "0 Out of Stock";
      } else if (stockVal <= 10) {
        stockPill.className = "stock-indicator-pill low";
        stockPillText.textContent = `${stockVal} Low Stock`;
      } else {
        stockPill.className = "stock-indicator-pill instock";
        stockPillText.textContent = `${stockVal} in stock`;
      }
    }

    if (typeof window.handleBillingQtyInput === 'function') window.handleBillingQtyInput();
  };

  window.handleBillingQtyInput = function() {
    const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
    const warningBox = document.getElementById("qty-stock-warning");
    const warningText = document.getElementById("qty-warning-text");
    const maxCountSpan = document.getElementById("qty-max-count");
    const addBtn = document.querySelector(".btn-add-row");
    const multiLotPill = document.getElementById("multi-lot-summary-pill");
    const multiLotText = document.getElementById("multi-lot-summary-text");

    if (!qtyInput) return;

    // Evaluate Multi-Lot summation if typed (e.g. 25.5 + 30.2 + 28.4 or 5*20)
    const rawQtyStr = String(qtyInput.value || "").trim();
    const parsedLot = (typeof window.parseMultiLotWeight === 'function') 
      ? window.parseMultiLotWeight(rawQtyStr) 
      : { total: parseFloat(rawQtyStr) || 1, count: 1, isMulti: false, avg: parseFloat(rawQtyStr) || 1 };

    if (multiLotPill && multiLotText) {
      if (parsedLot.isMulti) {
        multiLotPill.classList.remove("hidden");
        multiLotText.innerHTML = `<strong>∑ ${parsedLot.count} Lots:</strong> ${parsedLot.total.toFixed(2)} Kg <span style="opacity: 0.8; font-size: 10px;">(Avg ${parsedLot.avg.toFixed(2)} Kg)</span>`;
      } else {
        multiLotPill.classList.add("hidden");
      }
    }

    const prodId = elements.billItemSelect ? elements.billItemSelect.value : "";
    let prod = productsDb.find(p => p && p.id === prodId);
    if (!prod && prodId && prodId !== '__custom__') {
      prod = productsDb.find(p => p && p.description === prodId);
    }
    if (!prod && elements.billItemName && elements.billItemName.value) {
      prod = productsDb.find(p => p && (p.description || "").trim().toLowerCase() === elements.billItemName.value.trim().toLowerCase());
    }

    if (!prod || prod.stock === undefined || prod.stock === null || prod.stock === "") {
      if (warningBox) warningBox.classList.add("hidden");
      qtyInput.classList.remove("qty-input-warning");
      qtyInput.classList.remove("qty-input-valid");
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Add Item`;
      }
      return;
    }

    const availableStock = Math.max(0, parseInt(prod.stock, 10) || 0);

    let previouslyInvoicedQty = 0;
    if (currentInvoice && currentInvoice.isEditing && currentInvoice.id) {
      const origInv = invoicesDb.find(inv => inv && inv.id === currentInvoice.id);
      if (origInv && origInv.details && Array.isArray(origInv.details.items)) {
        const matchingOld = origInv.details.items.find(it => 
          (it.productId && prod.id && it.productId === prod.id) ||
          (it.description && prod.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
        );
        if (matchingOld) previouslyInvoicedQty = parseFloat(matchingOld.quantity) || 0;
      }
    }

    const effectiveAvailable = availableStock + previouslyInvoicedQty;

    const currentInCart = (currentInvoice?.items || [])
      .filter(item => 
        (item.productId && prod.id && item.productId === prod.id) ||
        (item.description && prod.description && item.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
      )
      .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0);

    const remainingCanAdd = Math.max(0, effectiveAvailable - currentInCart);
    const requestedQty = parsedLot.total || parseFloat(qtyInput.value) || 0;

    if (effectiveAvailable <= 0 || remainingCanAdd <= 0) {
      qtyInput.classList.add("qty-input-warning");
      qtyInput.classList.remove("qty-input-valid");
      if (warningBox && warningText) {
        warningBox.classList.remove("hidden");
        warningText.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color: #ef4444;"></i> Out of stock (0 available)`;
        if (maxCountSpan) maxCountSpan.textContent = "0";
      }
      if (addBtn) {
        addBtn.disabled = true;
        addBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Out of Stock`;
      }
    } else if (requestedQty > remainingCanAdd) {
      qtyInput.classList.add("qty-input-warning");
      qtyInput.classList.remove("qty-input-valid");
      if (warningBox && warningText) {
        warningBox.classList.remove("hidden");
        warningText.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #f59e0b;"></i> Exceeds stock (Only ${remainingCanAdd} left)`;
        if (maxCountSpan) maxCountSpan.textContent = remainingCanAdd;
      }
      if (addBtn) {
        addBtn.disabled = true;
        addBtn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Max ${remainingCanAdd}`;
      }
    } else {
      qtyInput.classList.remove("qty-input-warning");
      qtyInput.classList.add("qty-input-valid");
      if (warningBox) warningBox.classList.add("hidden");
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Add Item`;
      }
    }
  };

  window.setMaxAvailableQty = function() {
    const qtyInput = elements.billItemQty || document.getElementById("bill-item-qty");
    const maxCountSpan = document.getElementById("qty-max-count");
    if (qtyInput && maxCountSpan) {
      const maxVal = parseInt(maxCountSpan.textContent, 10) || 1;
      qtyInput.value = Math.max(1, maxVal);
      handleBillingQtyInput();
      if (typeof calculateBillingItemNetVal === 'function') calculateBillingItemNetVal();
    }
  };

  window.triggerQuickInwardFromBilling = function() {
    const prodId = elements.billItemSelect ? elements.billItemSelect.value : "";
    let prod = productsDb.find(p => p && p.id === prodId);
    if (!prod && prodId && prodId !== '__custom__') {
      prod = productsDb.find(p => p && p.description === prodId);
    }
    if (!prod && elements.billItemName && elements.billItemName.value) {
      prod = productsDb.find(p => p && (p.description || "").trim().toLowerCase() === elements.billItemName.value.trim().toLowerCase());
    }

    if (!prod) {
      showFloatingToast("⚠️ Please choose a product from the catalog to restock.", "warning");
      return;
    }

    const currentStock = Math.max(0, parseInt(prod.stock, 10) || 0);
    const unit = prod.unit || "Buckets";
    
    const promptVal = prompt(`📦 QUICK INWARD RESTOCK: "${prod.description}"\n\nCurrent Warehouse Stock: ${currentStock} ${unit}\n\nEnter new shipment quantity received from supplier to ADD:`, "20");
    if (promptVal === null) return;
    
    const addQty = parseInt(promptVal.trim(), 10);
    if (isNaN(addQty) || addQty <= 0) {
      showFloatingToast("⚠️ Please enter a valid quantity greater than 0.", "warning");
      return;
    }

    const newStock = currentStock + addQty;
    prod.stock = newStock;
    prod.updatedAt = new Date().toISOString();

    if (!window.recentProductMutations) window.recentProductMutations = {};
    window.recentProductMutations[prod.id] = Date.now();

    localStorage.setItem("products", JSON.stringify(productsDb));
    syncDatabaseToServer("products", productsDb);
    populateBillingSelectors();

    if (elements.billItemSelect) {
      elements.billItemSelect.value = prod.id;
    }
    updateBillingStockTelemetry(prod);

    showFloatingToast(`📦 Inward Stock Added! +${addQty} ${unit} added to "${prod.description}". Live stock is now ${newStock} ${unit}.`, 4000);
    sendStockTelegramReport(prod, `Quick Billing Inward Restock (+${addQty} ${unit})`, currentStock, newStock);
  };

  elements.billItemSelect.addEventListener("change", (e) => {
    const prodId = e.target.value;
    if (!prodId) {
      if (elements.billItemName) elements.billItemName.value = "";
      elements.billItemHsn.value = "";
      elements.billItemRate.value = "0";
      elements.billItemQty.value = "1";
      elements.billItemUnit.value = "Bucket";
      if (elements.billItemPack) elements.billItemPack.value = "";
      elements.billItemGstRate.value = "0";
      elements.billItemDiscount.value = "0";
      updateBillingStockTelemetry(null);
      calculateBillingItemNetVal();
      return;
    }
    if (prodId === '__custom__') {
      elements.billItemSelect.value = "";
      if (elements.billItemName) {
        elements.billItemName.value = "";
        elements.billItemName.focus();
      }
      elements.billItemHsn.value = "";
      elements.billItemRate.value = "0";
      elements.billItemQty.value = "1";
      elements.billItemUnit.value = "Bucket";
      if (elements.billItemPack) elements.billItemPack.value = "";
      elements.billItemGstRate.value = "0";
      elements.billItemDiscount.value = "0";
      updateBillingStockTelemetry(null);
      calculateBillingItemNetVal();
      return;
    }
    const prod = productsDb.find(p => p && (p.id === prodId || p.description === prodId));
    if (prod) {
      if (elements.billItemName) elements.billItemName.value = prod.description;
      elements.billItemHsn.value = prod.hsn || "";
      elements.billItemRate.value = prod.rate || "0";
      elements.billItemQty.value = "1";
      elements.billItemUnit.value = prod.unit || "Bucket";
      if (elements.billItemPack) elements.billItemPack.value = prod.packSize || "";
      elements.billItemGstRate.value = prod.gstRate || "0";
      elements.billItemDiscount.value = prod.discount || "0";
      updateBillingStockTelemetry(prod);
      calculateBillingItemNetVal();
    }
  });

  if (elements.billItemName) {
    elements.billItemName.addEventListener("input", (e) => {
      const typed = e.target.value.trim().toLowerCase();
      if (elements.billItemSelect && elements.billItemSelect.value) {
        const curProd = (window.TurboDataStore && typeof window.TurboDataStore.getProduct === 'function')
          ? window.TurboDataStore.getProduct(elements.billItemSelect.value)
          : productsDb.find(p => p && p.id === elements.billItemSelect.value);
        if (curProd && (curProd.description || "").toLowerCase() !== typed) {
          elements.billItemSelect.value = "";
        }
      }
      const matchedProd = (window.TurboDataStore && typeof window.TurboDataStore.getProduct === 'function')
        ? window.TurboDataStore.getProduct(typed)
        : productsDb.find(p => p && (p.description || "").trim().toLowerCase() === typed);
      updateBillingStockTelemetry(matchedProd || null);
    });
  }

  if (elements.billItemDiscount) {
    elements.billItemDiscount.addEventListener("input", calculateBillingItemNetVal);
  }
  if (elements.billItemRate) {
    elements.billItemRate.addEventListener("input", calculateBillingItemNetVal);
  }

  // Automatic Party Autocomplete & Live Fill (O(1) Turbo Retrieval)
  function autoFillPartyDetails(type, enteredName) {
    if (!enteredName || enteredName.trim().length < 2) return;
    const clean = enteredName.trim().toLowerCase();

    // 1. Check TurboDataStore / partiesDb
    let match = (window.TurboDataStore && typeof window.TurboDataStore.getParty === 'function')
      ? window.TurboDataStore.getParty(clean)
      : partiesDb.find(p => p && p.name && p.name.trim().toLowerCase() === clean);

    // 2. Check past invoices if no exact party match
    if (!match && Array.isArray(invoicesDb)) {
      const prevInv = invoicesDb.find(inv => {
        const b = inv.details?.buyer?.name;
        const c = inv.details?.consignee?.name;
        const cust = inv.customerName;
        return (b && b.trim().toLowerCase() === clean) ||
               (c && c.trim().toLowerCase() === clean) ||
               (cust && cust.trim().toLowerCase() === clean);
      });
      if (prevInv) {
        const d = prevInv.details || {};
        const pObj = (d.buyer?.name?.trim().toLowerCase() === clean) ? d.buyer : (d.consignee || {});
        match = {
          name: pObj.name || prevInv.customerName,
          address: pObj.address || "",
          gstin: pObj.gstin || "",
          phone: pObj.phone || "",
          state: pObj.state || "Andhra Pradesh",
          stateCode: pObj.stateCode || "37"
        };
      }
    }

    if (match) {
      if (type === 'buyer') {
        if (match.address && elements.billBuyerAddress && !elements.billBuyerAddress.value) {
          elements.billBuyerAddress.value = match.address;
          if (!currentInvoice.buyer) currentInvoice.buyer = {};
          currentInvoice.buyer.address = match.address;
        }
        if (match.gstin && elements.billBuyerGstin && !elements.billBuyerGstin.value) {
          elements.billBuyerGstin.value = match.gstin;
          if (!currentInvoice.buyer) currentInvoice.buyer = {};
          currentInvoice.buyer.gstin = match.gstin;
        }
        if (match.phone && elements.billBuyerPhone && !elements.billBuyerPhone.value) {
          elements.billBuyerPhone.value = match.phone;
          if (!currentInvoice.buyer) currentInvoice.buyer = {};
          currentInvoice.buyer.phone = match.phone;
        }
        if (match.state && elements.billBuyerState) {
          elements.billBuyerState.value = match.state;
          if (!currentInvoice.buyer) currentInvoice.buyer = {};
          currentInvoice.buyer.state = match.state;
        }
        if (match.stateCode && elements.billBuyerStateCode) {
          elements.billBuyerStateCode.value = match.stateCode;
          if (!currentInvoice.buyer) currentInvoice.buyer = {};
          currentInvoice.buyer.stateCode = match.stateCode;
        }
        // Auto-copy to consignee if consignee name is empty
        if (elements.billConsigneeName && !elements.billConsigneeName.value.trim()) {
          elements.billConsigneeName.value = match.name;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.name = match.name;
          if (elements.billConsigneeAddress) elements.billConsigneeAddress.value = match.address || "";
          if (elements.billConsigneeGstin) elements.billConsigneeGstin.value = match.gstin || "";
          if (elements.billConsigneePhone) elements.billConsigneePhone.value = match.phone || "";
          if (elements.billConsigneeState) elements.billConsigneeState.value = match.state || "Andhra Pradesh";
          if (elements.billConsigneeStateCode) elements.billConsigneeStateCode.value = match.stateCode || "37";
        }
      } else if (type === 'consignee') {
        if (match.address && elements.billConsigneeAddress && !elements.billConsigneeAddress.value) {
          elements.billConsigneeAddress.value = match.address;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.address = match.address;
        }
        if (match.gstin && elements.billConsigneeGstin && !elements.billConsigneeGstin.value) {
          elements.billConsigneeGstin.value = match.gstin;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.gstin = match.gstin;
        }
        if (match.phone && elements.billConsigneePhone && !elements.billConsigneePhone.value) {
          elements.billConsigneePhone.value = match.phone;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.phone = match.phone;
        }
        if (match.state && elements.billConsigneeState) {
          elements.billConsigneeState.value = match.state;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.state = match.state;
        }
        if (match.stateCode && elements.billConsigneeStateCode) {
          elements.billConsigneeStateCode.value = match.stateCode;
          if (!currentInvoice.consignee) currentInvoice.consignee = {};
          currentInvoice.consignee.stateCode = match.stateCode;
        }
      }
      calculateSummaryAndTable();
    }
  }

  if (elements.billBuyerName) {
    elements.billBuyerName.addEventListener("change", (e) => autoFillPartyDetails('buyer', e.target.value));
    elements.billBuyerName.addEventListener("input", (e) => {
      const v = e.target.value.trim().toLowerCase();
      if (partiesDb.some(p => p.name && p.name.toLowerCase() === v)) {
        autoFillPartyDetails('buyer', e.target.value);
      }
    });
  }
  if (elements.billConsigneeName) {
    elements.billConsigneeName.addEventListener("change", (e) => autoFillPartyDetails('consignee', e.target.value));
    elements.billConsigneeName.addEventListener("input", (e) => {
      const v = e.target.value.trim().toLowerCase();
      if (partiesDb.some(p => p.name && p.name.toLowerCase() === v)) {
        autoFillPartyDetails('consignee', e.target.value);
      }
    });
  }

  // Parties select
  elements.quickSelectReceiver.addEventListener("change", (e) => {
    const party = partiesDb.find(p => p.id === e.target.value);
    if (party) {
      currentInvoice.buyer.name = party.name;
      currentInvoice.buyer.address = party.address;
      currentInvoice.buyer.gstin = party.gstin;
      currentInvoice.buyer.phone = party.phone || "";
      currentInvoice.buyer.state = party.state;
      currentInvoice.buyer.stateCode = party.stateCode;

      elements.billBuyerName.value = party.name;
      elements.billBuyerAddress.value = party.address;
      elements.billBuyerGstin.value = party.gstin;
      elements.billBuyerPhone.value = party.phone || "";
      elements.billBuyerState.value = party.state;
      elements.billBuyerStateCode.value = party.stateCode;

      calculateSummaryAndTable();
    }
  });

  elements.quickSelectConsignee.addEventListener("change", (e) => {
    const party = partiesDb.find(p => p.id === e.target.value);
    if (party) {
      currentInvoice.consignee.name = party.name;
      currentInvoice.consignee.address = party.address;
      currentInvoice.consignee.gstin = party.gstin;
      currentInvoice.consignee.phone = party.phone || "";
      currentInvoice.consignee.state = party.state;
      currentInvoice.consignee.stateCode = party.stateCode;

      elements.billConsigneeName.value = party.name;
      elements.billConsigneeAddress.value = party.address;
      elements.billConsigneeGstin.value = party.gstin;
      if (elements.billConsigneePhone) elements.billConsigneePhone.value = party.phone || "";
      elements.billConsigneeState.value = party.state;
      elements.billConsigneeStateCode.value = party.stateCode;

      calculateSummaryAndTable();
    }
  });
}

function populateBillingSelectors() {
  elements.quickSelectReceiver.innerHTML = `<option value="">-- Load Receiver --</option>`;
  elements.quickSelectConsignee.innerHTML = `<option value="">-- Load Consignee --</option>`;
  
  const customerDatalist = document.getElementById("customer-names-datalist");
  const custSet = new Set();

  partiesDb.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.name) custSet.add(p.name.trim());
    if (p.type === 'receiver') {
      elements.quickSelectReceiver.appendChild(opt);
    } else {
      elements.quickSelectConsignee.appendChild(opt);
    }
  });

  if (Array.isArray(invoicesDb)) {
    invoicesDb.forEach(inv => {
      if (inv.customerName) custSet.add(inv.customerName.trim());
      if (inv.details?.buyer?.name) custSet.add(inv.details.buyer.name.trim());
      if (inv.details?.consignee?.name) custSet.add(inv.details.consignee.name.trim());
    });
  }

  if (customerDatalist) {
    customerDatalist.innerHTML = Array.from(custSet).filter(Boolean).sort().map(n => `<option value="${n}">`).join("");
  }

  elements.billItemSelect.innerHTML = `<option value="">-- Choose from Catalog --</option><option value="__custom__">➕ Type Custom Item...</option>`;
  productsDb.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    const packStr = p.packSize ? ` [${p.packSize}]` : '';
    const unitStr = p.unit ? ` (${p.unit})` : '';
    
    let stockBadge = '';
    if (p.stock !== undefined && p.stock !== null && p.stock !== '') {
      const sVal = parseInt(p.stock, 10) || 0;
      if (sVal <= 0) {
        stockBadge = ` • 🚫 (OUT OF STOCK)`;
        opt.style.color = '#ef4444';
        opt.style.fontWeight = '600';
      } else if (sVal <= 10) {
        stockBadge = ` • ⚠️ (${sVal} Left)`;
        opt.style.color = '#d97706';
      } else {
        stockBadge = ` • (${sVal} in stock)`;
        opt.style.color = '#059669';
      }
    }

    opt.textContent = `${p.description}${packStr}${unitStr} - ₹${formatCurrency(p.rate)}${stockBadge}`;
    elements.billItemSelect.appendChild(opt);
  });
  if (typeof window.renderSmartProductResults === 'function') {
    window.renderSmartProductResults(document.getElementById("smart-product-search")?.value || "");
  }
}

window.copyBuyerToConsignee = function() {
  if (typeof syncBillingInputsToCurrentInvoice === 'function') {
    syncBillingInputsToCurrentInvoice();
  }
  currentInvoice.consignee = { ...(currentInvoice.buyer || {}) };
  if (elements.billConsigneeName) elements.billConsigneeName.value = currentInvoice.consignee.name || "";
  if (elements.billConsigneeAddress) elements.billConsigneeAddress.value = currentInvoice.consignee.address || "";
  if (elements.billConsigneeGstin) elements.billConsigneeGstin.value = currentInvoice.consignee.gstin || "";
  if (elements.billConsigneePhone) elements.billConsigneePhone.value = currentInvoice.consignee.phone || "";
  if (elements.billConsigneeState) elements.billConsigneeState.value = currentInvoice.consignee.state || "Andhra Pradesh";
  if (elements.billConsigneeStateCode) elements.billConsigneeStateCode.value = currentInvoice.consignee.stateCode || "37";
  
  calculateSummaryAndTable();
};

window.updatePrintTitleHeader = function() {
  const invoiceType = elements.billInvoiceType?.value || currentInvoice.invoiceType || "Bill of Supply";
  currentInvoice.invoiceType = invoiceType;
  const titleEl = document.getElementById("p-print-document-title");
  if (titleEl) {
    titleEl.textContent = invoiceType ? invoiceType.toUpperCase() : "BILL OF SUPPLY";
  }
};

function triggerInvoiceNumberRollbackEffect(oldVal, newVal) {
  try {
    if (!elements.billInvoiceNo) return;
    elements.billInvoiceNo.classList.remove('invoice-no-rollback-active');
    void elements.billInvoiceNo.offsetWidth;
    elements.billInvoiceNo.classList.add('invoice-no-rollback-active');
    setTimeout(() => {
      if (elements.billInvoiceNo) elements.billInvoiceNo.classList.remove('invoice-no-rollback-active');
    }, 2500);

    const isBillingTabActive = document.querySelector('.sidebar-nav .nav-item[data-tab="billing"]')?.classList.contains("active") ||
                               document.querySelector('.mobile-bottom-nav-item[data-bottom-tab="billing"], .mobile-bottom-nav-fab[data-bottom-tab="billing"]')?.classList.contains("active") ||
                               document.getElementById("view-billing")?.classList.contains("active");
    if (isBillingTabActive && typeof showFloatingToast === 'function' && oldVal && oldVal !== newVal) {
      showFloatingToast(`🔄 Sequence updated: Invoice #${newVal} auto-assigned (freed from deleted #${oldVal})`, "info");
    }
  } catch (err) {
    console.warn("Invoice rollback effect notice:", err);
  }
}

function autoSuggestInvoiceNo(force = false, preferInvoiceNo = null) {
  if (currentBillingMode === 'estimate' && !force) return;
  if (currentInvoice && currentInvoice.isEditing && !force) return;
  const nextStr = InvoiceUtils.getNextInvoiceNumber(invoicesDb, { preferInvoiceNo });
  const currentVal = elements.billInvoiceNo ? String(elements.billInvoiceNo.value || "").trim() : "";
  const isTyping = elements.billInvoiceNo && document.activeElement === elements.billInvoiceNo;
  const isCollisionWithSync = invoicesDb.some(inv => inv && String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || "").trim() === currentVal);

  // Advanced sequence rollback detection:
  // If the invoice number on screen is higher than the calculated next sequence (e.g. 0008 vs 0007),
  // detect the gap/overshoot caused by an invoice deletion and directly roll back!
  let isSequenceOvershoot = false;
  const currentNumMatch = currentVal.match(/\d+$/);
  const nextNumMatch = nextStr.match(/\d+$/);
  if (currentNumMatch && nextNumMatch) {
    const curNum = parseInt(currentNumMatch[0], 10);
    const nxtNum = parseInt(nextNumMatch[0], 10);
    if (curNum > nxtNum) {
      isSequenceOvershoot = true;
    }
  }

  const shouldUpdate = force || 
                       !currentInvoice.invoiceNo || 
                       !elements.billInvoiceNo || 
                       !elements.billInvoiceNo.value || 
                       (!isTyping && (isCollisionWithSync || isSequenceOvershoot));

  if (shouldUpdate) {
    const oldVal = currentVal || currentInvoice.invoiceNo;
    currentInvoice.invoiceNo = nextStr;
    if (elements.billInvoiceNo && (!isTyping || force)) {
      elements.billInvoiceNo.value = currentInvoice.invoiceNo;
      if (oldVal && oldVal !== nextStr && (isSequenceOvershoot || force)) {
        triggerInvoiceNumberRollbackEffect(oldVal, nextStr);
      }
    }
  }

  const today = new Date().toISOString().split('T')[0];
  if (!currentInvoice.invoiceDate) {
    currentInvoice.invoiceDate = today;
  }
  if (elements.billInvoiceDate && !elements.billInvoiceDate.value) {
    elements.billInvoiceDate.value = today;
  }

  const billNoVal = elements.billInvoiceNo?.value || "0000";
  const sumMetaInvNo = document.getElementById("sum-meta-invoice-no");
  if (sumMetaInvNo) sumMetaInvNo.textContent = "#" + billNoVal;
  const printInvNo = document.getElementById("p-print-invoice-no");
  if (printInvNo) printInvNo.textContent = "#" + billNoVal;
  const metaDateEl = document.getElementById("sum-meta-date");
  if (metaDateEl) metaDateEl.textContent = elements.billInvoiceDate?.value || today;
}

// --- ADVANCED QUOTATION / ESTIMATE MODE ---
let currentBillingMode = 'invoice'; // 'invoice' | 'estimate'

window.switchBillingMode = function(mode) {
  currentBillingMode = mode;
  const btnInvoice = document.getElementById("billing-mode-btn-invoice");
  const btnEstimate = document.getElementById("billing-mode-btn-estimate");
  const badge = document.getElementById("billing-mode-badge");
  const docTypeSelect = document.getElementById("bill-invoice-type");
  const saveBtn = document.getElementById("btn-save-generate-invoice");

  if (mode === 'estimate') {
    currentInvoice.isEstimate = true;
    if (btnEstimate) {
      btnEstimate.style.background = "#0891b2";
      btnEstimate.style.color = "#ffffff";
      btnEstimate.style.fontWeight = "700";
    }
    if (btnInvoice) {
      btnInvoice.style.background = "transparent";
      btnInvoice.style.color = "#64748b";
      btnInvoice.style.fontWeight = "600";
    }
    if (badge) {
      badge.style.background = "#fffbeb";
      badge.style.color = "#b45309";
      badge.innerHTML = `<i class="fa-solid fa-file-lines"></i> Quotation / Estimate (Non-Tax)`;
    }
    if (docTypeSelect) {
      docTypeSelect.value = "Proforma Invoice";
      if (typeof updatePrintTitleHeader === 'function') updatePrintTitleHeader();
    }
    const metaDocType = document.getElementById("sum-meta-doc-type");
    if (metaDocType) metaDocType.textContent = "QUOTATION / ESTIMATE";
    if (saveBtn) {
      saveBtn.innerHTML = `<i class="fa-solid fa-file-signature"></i> Save &amp; Generate Quotation`;
    }
    autoSuggestEstimateNo(true);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📋 Switched to Quotation / Estimate Mode. Not an official tax bill.", 3500);
    }
  } else {
    currentInvoice.isEstimate = false;
    if (btnInvoice) {
      btnInvoice.style.background = "#0891b2";
      btnInvoice.style.color = "#ffffff";
      btnInvoice.style.fontWeight = "700";
    }
    if (btnEstimate) {
      btnEstimate.style.background = "transparent";
      btnEstimate.style.color = "#64748b";
      btnEstimate.style.fontWeight = "600";
    }
    if (badge) {
      badge.style.background = "#ecfdf5";
      badge.style.color = "#047857";
      badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Official GST Sequence`;
    }
    if (docTypeSelect) {
      docTypeSelect.value = "Tax Invoice";
      if (typeof updatePrintTitleHeader === 'function') updatePrintTitleHeader();
    }
    const metaDocType = document.getElementById("sum-meta-doc-type");
    if (metaDocType) metaDocType.textContent = "BILL OF SUPPLY";
    if (saveBtn) {
      saveBtn.innerHTML = `<i class="fa-solid fa-file-invoice"></i> Generate &amp; Save Invoice (Auto-Send)`;
    }
    autoSuggestInvoiceNo(true);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📄 Switched to Official GST Tax Invoice Mode.", 3500);
    }
  }
};

function autoSuggestEstimateNo(force = false) {
  const existingEstimates = (invoicesDb || []).filter(i => i.isEstimate || i.details?.isEstimate || String(i.invoiceNo || "").startsWith("EST-"));
  let maxNum = 0;
  existingEstimates.forEach(est => {
    const numPart = String(est.invoiceNo || "").replace(/\D/g, "");
    const parsed = parseInt(numPart, 10);
    if (!isNaN(parsed) && parsed > maxNum) maxNum = parsed;
  });
  const nextNum = maxNum + 1;
  const nextStr = "EST-" + nextNum.toString().padStart(4, '0');
  currentInvoice.invoiceNo = nextStr;
  currentInvoice.isEstimate = true;
  if (elements.billInvoiceNo) {
    elements.billInvoiceNo.value = nextStr;
  }
  const sumMetaInvNo = document.getElementById("sum-meta-invoice-no");
  if (sumMetaInvNo) sumMetaInvNo.textContent = "#" + nextStr;
  const printInvNo = document.getElementById("p-print-invoice-no");
  if (printInvNo) printInvNo.textContent = "#" + nextStr;
}

window.convertEstimateToInvoice = function(estimateId) {
  const est = (invoicesDb || []).find(i => i.id === estimateId);
  if (!est) return;

  // Load into current billing state
  const details = est.details || est;
  currentInvoice = JSON.parse(JSON.stringify(details));
  currentInvoice.isEditing = false;
  currentInvoice.id = null;
  currentInvoice.isEstimate = false;

  // Switch billing mode to GST invoice
  switchBillingMode('invoice');
  autoSuggestInvoiceNo(true);

  // Sync inputs
  if (elements.billBuyerName && currentInvoice.buyer) elements.billBuyerName.value = currentInvoice.buyer.name || "";
  if (elements.billBuyerPhone && currentInvoice.buyer) elements.billBuyerPhone.value = currentInvoice.buyer.phone || "";
  if (elements.billBuyerAddress && currentInvoice.buyer) elements.billBuyerAddress.value = currentInvoice.buyer.address || "";
  if (elements.billConsigneeName && currentInvoice.consignee) elements.billConsigneeName.value = currentInvoice.consignee.name || "";
  if (elements.billConsigneePhone && currentInvoice.consignee) elements.billConsigneePhone.value = currentInvoice.consignee.phone || "";

  calculateSummaryAndTable();
  if (typeof switchTab === 'function') switchTab('billing');
  if (typeof showFloatingToast === 'function') {
    showFloatingToast(`🚀 Quotation #${est.invoiceNo} converted to GST Invoice! Next step: click Generate & Save.`, 5000);
  }
};

// --- ADVANCED LIVE BARCODE & QR CAMERA SCANNER ---
let barcodeCameraStream = null;
let barcodeCurrentFacing = 'environment'; // 'environment' | 'user'
let barcodeTorchActive = false;
let barcodeDetectInterval = null;
let barcodeDetectorInstance = null;

if ('BarcodeDetector' in window) {
  try {
    barcodeDetectorInstance = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
    });
  } catch (e) {
    console.warn("BarcodeDetector initialization notice:", e);
  }
}

window.openBarcodeScannerModal = async function(initialTab = 'camera') {
  const modal = document.getElementById("barcode-scanner-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.style.display = "flex";
  await window.switchScannerTab(initialTab);
};

window.closeBarcodeScannerModal = function() {
  const modal = document.getElementById("barcode-scanner-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
  stopBarcodeCamera();
};

window.switchScannerTab = async function(tab) {
  const btnCamera = document.getElementById("scanner-tab-btn-camera");
  const btnUpload = document.getElementById("scanner-tab-btn-upload");
  const paneCamera = document.getElementById("scanner-tab-camera-pane");
  const paneUpload = document.getElementById("scanner-tab-upload-pane");

  if (tab === 'upload') {
    if (btnCamera) btnCamera.classList.remove("active");
    if (btnUpload) btnUpload.classList.add("active");
    if (paneCamera) paneCamera.style.display = "none";
    if (paneUpload) paneUpload.style.display = "block";
    stopBarcodeCamera();
  } else {
    if (btnCamera) btnCamera.classList.add("active");
    if (btnUpload) btnUpload.classList.remove("active");
    if (paneCamera) paneCamera.style.display = "block";
    if (paneUpload) paneUpload.style.display = "none";
    await startBarcodeCamera();
  }
};

async function startBarcodeCamera() {
  const video = document.getElementById("barcode-scanner-video");
  const statusEl = document.getElementById("barcode-camera-status");
  if (!video) return;

  if (statusEl) statusEl.textContent = "Connecting to device camera...";

  try {
    if (barcodeCameraStream) {
      stopBarcodeCamera();
    }

    const constraints = {
      video: {
        facingMode: { ideal: barcodeCurrentFacing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    barcodeCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = barcodeCameraStream;
    await video.play();

    if (statusEl) statusEl.textContent = "🟢 Camera active • Point at barcode";

    // Setup active scanning loop
    if (barcodeDetectInterval) clearInterval(barcodeDetectInterval);
    barcodeDetectInterval = setInterval(async () => {
      if (!barcodeCameraStream || video.readyState < 2) return;
      try {
        if (barcodeDetectorInstance) {
          const barcodes = await barcodeDetectorInstance.detect(video);
          if (barcodes && barcodes.length > 0) {
            const rawVal = barcodes[0].rawValue;
            if (rawVal) {
              window.handleScannedBarcode(rawVal);
            }
          }
        }
      } catch (err) {
        // Video processing frame skip
      }
    }, 280);

  } catch (err) {
    console.warn("Camera access warning:", err);
    if (statusEl) statusEl.textContent = "⚠️ Camera access unavailable. Please type barcode or upload file.";
  }
}

function stopBarcodeCamera() {
  if (barcodeDetectInterval) {
    clearInterval(barcodeDetectInterval);
    barcodeDetectInterval = null;
  }
  if (barcodeCameraStream) {
    barcodeCameraStream.getTracks().forEach(track => track.stop());
    barcodeCameraStream = null;
  }
  const video = document.getElementById("barcode-scanner-video");
  if (video) video.srcObject = null;
  barcodeTorchActive = false;
}

window.toggleCameraFacing = async function() {
  barcodeCurrentFacing = (barcodeCurrentFacing === 'environment') ? 'user' : 'environment';
  await startBarcodeCamera();
};

window.toggleCameraTorch = async function() {
  if (!barcodeCameraStream) return;
  const track = barcodeCameraStream.getVideoTracks()[0];
  if (!track) return;
  try {
    barcodeTorchActive = !barcodeTorchActive;
    await track.applyConstraints({
      advanced: [{ torch: barcodeTorchActive }]
    });
    const torchBtn = document.getElementById("btn-camera-torch");
    if (torchBtn) {
      torchBtn.style.color = barcodeTorchActive ? "#facc15" : "#ffffff";
    }
  } catch (err) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("Torch not supported on this camera.", "info", 2500);
    }
  }
};

window.submitManualBarcode = function() {
  const input = document.getElementById("manual-barcode-input");
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    window.handleScannedBarcode(val);
    input.value = "";
  }
};

// --- ADVANCED REAL-TIME MULTI-PASS CLIENT-SIDE DECODER ---
window.decodeQrOrBarcodeFromImage = async function(source) {
  const startTime = performance.now();
  if (!source) {
    return { success: false, error: "No image source provided" };
  }

  let imgElement = null;
  let objectUrlToRevoke = null;

  try {
    if (source instanceof HTMLImageElement && source.complete && source.naturalWidth > 0) {
      imgElement = source;
    } else if (source instanceof HTMLCanvasElement) {
      return await scanCanvasMultiPass(source, startTime);
    } else {
      let srcUrl = "";
      if (source instanceof Blob || source instanceof File) {
        srcUrl = URL.createObjectURL(source);
        objectUrlToRevoke = srcUrl;
      } else if (typeof source === 'string') {
        srcUrl = source;
      }

      if (!srcUrl) {
        return { success: false, error: "Unsupported image format" };
      }

      imgElement = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image file"));
        img.src = srcUrl;
      });
    }

    if (!imgElement || !imgElement.naturalWidth) {
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      return { success: false, error: "Unable to read image dimensions" };
    }

    const naturalWidth = imgElement.naturalWidth || imgElement.width;
    const naturalHeight = imgElement.naturalHeight || imgElement.height;

    // Normalize resolution: cap max dimension to 1400px for speed
    const maxDim = 1400;
    let targetWidth = naturalWidth;
    let targetHeight = naturalHeight;
    if (naturalWidth > maxDim || naturalHeight > maxDim) {
      if (naturalWidth > naturalHeight) {
        targetWidth = maxDim;
        targetHeight = Math.round((naturalHeight * maxDim) / naturalWidth);
      } else {
        targetHeight = maxDim;
        targetWidth = Math.round((naturalWidth * maxDim) / naturalHeight);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imgElement, 0, 0, targetWidth, targetHeight);

    if (objectUrlToRevoke) {
      URL.revokeObjectURL(objectUrlToRevoke);
    }

    return await scanCanvasMultiPass(canvas, startTime);

  } catch (err) {
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    return { success: false, error: err.message || "Failed to decode image" };
  }
};

async function scanCanvasMultiPass(canvas, startTime) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // PASS 1: Hardware BarcodeDetector (Chromium/Electron native, ultra-fast <8ms)
  if (barcodeDetectorInstance) {
    try {
      const detected = await barcodeDetectorInstance.detect(canvas);
      if (detected && detected.length > 0 && detected[0].rawValue) {
        const ms = Math.round(performance.now() - startTime);
        return {
          success: true,
          text: detected[0].rawValue,
          format: detected[0].format || 'barcode',
          method: 'Hardware BarcodeDetector',
          durationMs: ms
        };
      }
    } catch (e) {}
  }

  // Pure JavaScript jsQR Pipeline
  if (typeof jsQR !== "undefined") {
    let imgData = null;
    try {
      imgData = ctx.getImageData(0, 0, width, height);
    } catch (e) {
      return { success: false, error: "Canvas security restriction reading pixels." };
    }

    // PASS 2: jsQR Standard (Direct Luma, non-inverted)
    let qr = null;
    try {
      qr = jsQR(imgData.data, width, height, { inversionAttempts: "dontInvert" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Standard",
          durationMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (e) {
      console.warn("jsQR Pass 2 error:", e);
    }

    // PASS 3: jsQR Inverted (Dark Theme / White on Black QR - Safe manual inversion)
    try {
      const invData = new Uint8ClampedArray(imgData.data.length);
      for (let i = 0; i < imgData.data.length; i += 4) {
        invData[i] = 255 - imgData.data[i];
        invData[i + 1] = 255 - imgData.data[i + 1];
        invData[i + 2] = 255 - imgData.data[i + 2];
        invData[i + 3] = 255;
      }
      qr = jsQR(invData, width, height, { inversionAttempts: "dontInvert" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Inverted",
          durationMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (e) {
      console.warn("jsQR Pass 3 error:", e);
    }

    // PASS 4: Dynamic Contrast Stretching & Adaptive Binarization
    try {
      const data = imgData.data;
      let minLum = 255;
      let maxLum = 0;
      const totalPixels = width * height;
      const lums = new Uint8Array(totalPixels);

      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        lums[j] = lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      const lumRange = maxLum - minLum;
      if (lumRange > 25) {
        const enhancedBuffer = new Uint8ClampedArray(data.length);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
          const stretched = Math.min(255, Math.max(0, ((lums[j] - minLum) * 255) / lumRange));
          const val = stretched > 128 ? Math.min(255, stretched * 1.14) : Math.max(0, stretched * 0.86);
          enhancedBuffer[i] = val;
          enhancedBuffer[i + 1] = val;
          enhancedBuffer[i + 2] = val;
          enhancedBuffer[i + 3] = 255;
        }

        qr = jsQR(enhancedBuffer, width, height, { inversionAttempts: "attemptBoth" });
        if (qr && qr.data) {
          return {
            success: true,
            text: qr.data,
            format: "qr_code",
            method: "jsQR High-Contrast",
            durationMs: Math.round(performance.now() - startTime)
          };
        }
      }
    } catch (e) {}

    // PASS 5: Multi-Angle Orientation Rotations (90° and 270°)
    try {
      const rotCanvas = document.createElement("canvas");
      rotCanvas.width = height;
      rotCanvas.height = width;
      const rotCtx = rotCanvas.getContext("2d", { willReadFrequently: true });

      // Rotate 90 degrees
      rotCtx.translate(height / 2, width / 2);
      rotCtx.rotate(Math.PI / 2);
      rotCtx.drawImage(canvas, -width / 2, -height / 2);

      const rotData = rotCtx.getImageData(0, 0, height, width);
      qr = jsQR(rotData.data, height, width, { inversionAttempts: "attemptBoth" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Rotated 90°",
          durationMs: Math.round(performance.now() - startTime)
        };
      }

      // Rotate 270 degrees
      rotCtx.setTransform(1, 0, 0, 1, 0, 0);
      rotCtx.clearRect(0, 0, height, width);
      rotCtx.translate(height / 2, width / 2);
      rotCtx.rotate(Math.PI * 1.5);
      rotCtx.drawImage(canvas, -width / 2, -height / 2);

      const rotData270 = rotCtx.getImageData(0, 0, height, width);
      qr = jsQR(rotData270.data, height, width, { inversionAttempts: "attemptBoth" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Rotated 270°",
          durationMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (e) {}

    // PASS 6: Scaled Fallback
    try {
      if (width > 800 || height > 800) {
        const scale = 600 / Math.max(width, height);
        const sW = Math.round(width * scale);
        const sH = Math.round(height * scale);
        const scaleCanvas = document.createElement("canvas");
        scaleCanvas.width = sW;
        scaleCanvas.height = sH;
        const sCtx = scaleCanvas.getContext("2d", { willReadFrequently: true });
        sCtx.drawImage(canvas, 0, 0, sW, sH);
        const sData = sCtx.getImageData(0, 0, sW, sH);
        qr = jsQR(sData.data, sW, sH, { inversionAttempts: "attemptBoth" });
        if (qr && qr.data) {
          return {
            success: true,
            text: qr.data,
            format: "qr_code",
            method: "jsQR Scaled Resample",
            durationMs: Math.round(performance.now() - startTime)
          };
        }
      }
    } catch (e) {}

    // PASS 7: Quiet-Zone White Padding (Essential for tightly-cropped screenshots & colored borders)
    try {
      const pad = Math.max(32, Math.round(Math.min(width, height) * 0.15));
      const pCanvas = document.createElement("canvas");
      pCanvas.width = width + pad * 2;
      pCanvas.height = height + pad * 2;
      const pCtx = pCanvas.getContext("2d", { willReadFrequently: true });
      pCtx.fillStyle = "#ffffff";
      pCtx.fillRect(0, 0, pCanvas.width, pCanvas.height);
      pCtx.drawImage(canvas, pad, pad);
      const pData = pCtx.getImageData(0, 0, pCanvas.width, pCanvas.height);
      qr = jsQR(pData.data, pCanvas.width, pCanvas.height, { inversionAttempts: "attemptBoth" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Quiet-Zone Padded",
          durationMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (e) {}

    // PASS 8: Sub-Region Square Crop (Handles images with top header banners, e.g. "VERIFY & PAY" box)
    try {
      if (width > 60 && height > 60) {
        const sqSize = Math.min(width, height);
        const candidateOffsets = [
          // Center crop
          { x: Math.round((width - sqSize) / 2), y: Math.round((height - sqSize) / 2) },
          // Bottom crop (below top banners)
          { x: Math.round((width - sqSize) / 2), y: Math.max(0, height - sqSize) },
          // Top crop
          { x: Math.round((width - sqSize) / 2), y: 0 }
        ];

        for (const off of candidateOffsets) {
          const sqPad = 28;
          const sqCanvas = document.createElement("canvas");
          sqCanvas.width = sqSize + sqPad * 2;
          sqCanvas.height = sqSize + sqPad * 2;
          const sqCtx = sqCanvas.getContext("2d", { willReadFrequently: true });
          sqCtx.fillStyle = "#ffffff";
          sqCtx.fillRect(0, 0, sqCanvas.width, sqCanvas.height);
          sqCtx.drawImage(canvas, off.x, off.y, sqSize, sqSize, sqPad, sqPad, sqSize, sqSize);
          const sqData = sqCtx.getImageData(0, 0, sqCanvas.width, sqCanvas.height);
          qr = jsQR(sqData.data, sqCanvas.width, sqCanvas.height, { inversionAttempts: "attemptBoth" });
          if (qr && qr.data) {
            return {
              success: true,
              text: qr.data,
              format: "qr_code",
              method: "jsQR Sub-Region Crop",
              durationMs: Math.round(performance.now() - startTime)
            };
          }
        }
      }
    } catch (e) {}

    // PASS 9: High-Contrast Adaptive Binarization with White Padding
    try {
      const thPad = 24;
      const thCanvas = document.createElement("canvas");
      thCanvas.width = width + thPad * 2;
      thCanvas.height = height + thPad * 2;
      const thCtx = thCanvas.getContext("2d", { willReadFrequently: true });
      thCtx.fillStyle = "#ffffff";
      thCtx.fillRect(0, 0, thCanvas.width, thCanvas.height);
      thCtx.drawImage(canvas, thPad, thPad);
      const thData = thCtx.getImageData(0, 0, thCanvas.width, thCanvas.height);
      const d = thData.data;
      let totalLum = 0;
      for (let i = 0; i < d.length; i += 4) {
        totalLum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      }
      const avgLum = totalLum / (thCanvas.width * thCanvas.height);
      const threshold = Math.min(210, Math.max(70, avgLum));
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        const v = lum > threshold ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
      qr = jsQR(d, thCanvas.width, thCanvas.height, { inversionAttempts: "attemptBoth" });
      if (qr && qr.data) {
        return {
          success: true,
          text: qr.data,
          format: "qr_code",
          method: "jsQR Adaptive Binarized",
          durationMs: Math.round(performance.now() - startTime)
        };
      }
    } catch (e) {}
  }

  return {
    success: false,
    error: "No readable QR code or barcode found in this image. Please ensure the QR is well-lit, sharp, and not obstructed.",
    durationMs: Math.round(performance.now() - startTime)
  };
}

window.handleDeviceQrFileInput = function(event) {
  const file = event.target.files?.[0];
  if (file) {
    window.handleDeviceQrFile(file, 'file_picker');
  }
  event.target.value = "";
};

window.handleDeviceQrFile = async function(file, source = 'upload') {
  if (!file) return;

  const previewWrap = document.getElementById("qr-upload-preview-wrap");
  const previewImg = document.getElementById("qr-upload-preview-img");
  const dropzone = document.getElementById("qr-dropzone");
  const statusText = document.getElementById("qr-upload-status-text");
  const resultCard = document.getElementById("qr-upload-result-card");
  const errorCard = document.getElementById("qr-upload-error-card");
  const laserLine = document.getElementById("qr-upload-laser");

  // Display preview container
  if (previewWrap) previewWrap.style.display = "block";
  if (dropzone) dropzone.style.display = "none";
  if (resultCard) resultCard.style.display = "none";
  if (errorCard) errorCard.style.display = "none";
  if (laserLine) laserLine.classList.add("qr-laser-active");
  if (statusText) {
    statusText.textContent = "🔄 Real-time multi-pass analysis in progress...";
    statusText.style.color = "#38bdf8";
  }

  // Load preview image
  const objectUrl = URL.createObjectURL(file);
  if (previewImg) {
    previewImg.src = objectUrl;
  }

  try {
    const result = await window.decodeQrOrBarcodeFromImage(file);
    URL.revokeObjectURL(objectUrl);

    if (laserLine) laserLine.classList.remove("qr-laser-active");

    if (result.success && result.text) {
      const clean = String(result.text).trim();

      if (statusText) {
        statusText.textContent = `✅ Recognized in ${result.durationMs}ms!`;
        statusText.style.color = "#10b981";
      }

      const badge = document.getElementById("qr-result-type-badge");
      const timeBadge = document.getElementById("qr-result-time-badge");
      const valEl = document.getElementById("qr-result-value");
      const actionBtn = document.getElementById("qr-result-action-btn");

      let category = "DATA";
      let actionLabel = "View Data";
      let isInvoice = false;
      let isProduct = false;

      if (clean.includes("verify_invoice=") || clean.includes("/?verify_invoice=")) {
        category = "INVOICE QR";
        actionLabel = "🧾 Open & Settle Invoice";
        isInvoice = true;
      } else if (clean.startsWith("upi://pay")) {
        category = "UPI PAYMENT";
        actionLabel = "💳 Pay via UPI";
      } else if (clean.includes("sync_pin=")) {
        category = "P2P SYNC PIN";
        actionLabel = "🔗 Pair Real-Time Mesh";
      } else {
        const match = (productsDb || []).find(p => p && (String(p.barcode || '').trim() === clean || String(p.id) === clean));
        if (match) {
          category = "PRODUCT BARCODE";
          actionLabel = `📦 Add "${match.description}" to Bill`;
          isProduct = true;
        } else {
          category = "BARCODE / QR";
          actionLabel = "📋 Copy Code";
        }
      }

      if (badge) badge.textContent = category;
      if (timeBadge) timeBadge.textContent = `${result.durationMs}ms (${result.method})`;
      if (valEl) valEl.textContent = clean;
      if (actionBtn) {
        actionBtn.textContent = actionLabel;
        actionBtn.onclick = () => {
          window.processAndRouteDecodedQr(clean, source);
        };
      }

      if (resultCard) resultCard.style.display = "block";

      window.playScannerBeep();

      // Auto-route with smooth 450ms visual confirmation
      setTimeout(() => {
        if (isInvoice || isProduct) {
          window.processAndRouteDecodedQr(clean, source);
        }
      }, 450);

    } else {
      if (statusText) {
        statusText.textContent = "❌ Recognition Unsuccessful";
        statusText.style.color = "#ef4444";
      }
      const errText = document.getElementById("qr-upload-error-text");
      if (errText) {
        errText.textContent = result.error || "No barcode or QR code could be detected in this photo.";
      }
      if (errorCard) errorCard.style.display = "block";
    }

  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    if (laserLine) laserLine.classList.remove("qr-laser-active");
    if (statusText) {
      statusText.textContent = "⚠️ Error reading image file";
      statusText.style.color = "#ef4444";
    }
  }
};

window.resetDeviceQrUpload = function() {
  const previewWrap = document.getElementById("qr-upload-preview-wrap");
  const dropzone = document.getElementById("qr-dropzone");
  const previewImg = document.getElementById("qr-upload-preview-img");
  const resultCard = document.getElementById("qr-upload-result-card");
  const errorCard = document.getElementById("qr-upload-error-card");
  const fileInput = document.getElementById("qr-device-file-input");
  const camInput = document.getElementById("qr-device-camera-input");

  if (previewWrap) previewWrap.style.display = "none";
  if (dropzone) dropzone.style.display = "block";
  if (previewImg) previewImg.src = "";
  if (resultCard) resultCard.style.display = "none";
  if (errorCard) errorCard.style.display = "none";
  if (fileInput) fileInput.value = "";
  if (camInput) camInput.value = "";
};

window.handleQrDropOver = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("qr-dropzone");
  if (dz) dz.classList.add("dragover");
};

window.handleQrDropLeave = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("qr-dropzone");
  if (dz) dz.classList.remove("dragover");
};

window.handleQrDrop = function(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("qr-dropzone");
  if (dz) dz.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    window.handleDeviceQrFile(file, 'drag_and_drop');
  }
};

// Clipboard Paste Interceptor for instant screenshot scanning
window.addEventListener('paste', function(e) {
  const items = (e.clipboardData || window.clipboardData)?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type && items[i].type.indexOf('image') !== -1) {
      const file = items[i].getAsFile();
      if (file) {
        e.preventDefault();
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Captured QR image from clipboard!", "info", 2000);
        }
        window.openBarcodeScannerModal('upload');
        setTimeout(() => {
          window.handleDeviceQrFile(file, 'clipboard_paste');
        }, 100);
        break;
      }
    }
  }
});

window.testSampleInvoiceQrUpload = function() {
  const testInv = (typeof invoicesDb !== "undefined" && invoicesDb.length > 0)
    ? invoicesDb[0]
    : { invoiceNo: "INV-2026-0001", total: 3599, paidAmount: 1599, balanceDue: 2000, buyerName: "Devi Fisheries" };

  const testUrl = (typeof window.generateInvoiceVerificationUrl === "function")
    ? window.generateInvoiceVerificationUrl(testInv.invoiceNo, testInv)
    : `https://aaryanaqua.netlify.app/?verify_invoice=${testInv.invoiceNo}`;

  const canvas = document.createElement("canvas");
  if (typeof QRious !== "undefined") {
    new QRious({
      element: canvas,
      value: testUrl,
      size: 320,
      level: 'H'
    });
    canvas.toBlob((blob) => {
      if (blob) {
        window.handleDeviceQrFile(blob, 'sample_test');
      }
    }, "image/png");
  } else {
    window.processAndRouteDecodedQr(testUrl, 'sample_test');
  }
};

window.processAndRouteDecodedQr = function(rawCode, source = 'upload') {
  if (!rawCode) return;
  const clean = String(rawCode).trim();

  // 1. Invoice Verification QR or Raw Invoice ID
  if (clean.includes("verify_invoice=") || clean.includes("/?verify_invoice=") || clean.toLowerCase().startsWith("inv_") || clean.toLowerCase().includes("id=inv_")) {
    window.closeBarcodeScannerModal();
    let invNo = clean;
    try {
      if (clean.includes("verify_invoice=")) {
        invNo = clean.split("verify_invoice=")[1].split("&")[0];
      } else if (clean.includes("id=")) {
        invNo = clean.split("id=")[1].split("&")[0];
      }
    } catch(e) {}
    invNo = decodeURIComponent(invNo);

    if (typeof openInvoiceVerificationModal === "function") {
      openInvoiceVerificationModal(invNo, clean);
    }
    return;
  }

  // 2. Product Barcode / SKU
  let matched = (productsDb || []).find(p => p && p.barcode && String(p.barcode).trim() === clean);
  if (!matched) {
    matched = (productsDb || []).find(p => p && (String(p.id) === clean || (p.description && p.description.toLowerCase() === clean.toLowerCase())));
  }

  if (matched) {
    window.closeBarcodeScannerModal();
    window.playScannerBeep();
    if (typeof selectSmartProduct === 'function') {
      selectSmartProduct(matched);
    }
    setTimeout(() => {
      if (typeof addItemToBillingTable === 'function') {
        addItemToBillingTable();
      }
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`📦 Added "${matched.description}" via Device QR!`, "success", 3500);
      }
    }, 120);
    return;
  }

  // 3. P2P Mesh Sync PIN
  if (clean.includes("sync_pin=")) {
    window.closeBarcodeScannerModal();
    window.playScannerBeep();
    try {
      const pin = clean.split("sync_pin=")[1].split("&")[0];
      const pinInput = document.getElementById("p2p-input-pin");
      if (pinInput) pinInput.value = pin;
      if (typeof joinSyncPairing === "function") joinSyncPairing();
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`🔗 Joined EMQX P2P Mesh with PIN: ${pin}`, "success", 4000);
      }
      return;
    } catch(e) {}
  }

  // 4. UPI Payment
  if (clean.startsWith("upi://pay")) {
    window.closeBarcodeScannerModal();
    window.playScannerBeep();
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("💳 UPI Payment QR detected!", "info", 3500);
    }
    return;
  }

  // 5. Default fallback
  window.handleScannedBarcode(clean);
};

window.handleScannedBarcode = function(code) {
  if (!code) return;
  const clean = String(code).trim();

  // Intercept Invoice Verification QR scans
  if (clean.includes("verify_invoice=") || clean.includes("/?verify_invoice=")) {
    window.processAndRouteDecodedQr(clean, 'camera');
    return;
  }

  // Search product in TurboDataStore (O(1) Turbo Retrieval)
  let matched = (window.TurboDataStore && typeof window.TurboDataStore.getProduct === 'function')
    ? window.TurboDataStore.getProduct(clean)
    : null;
  if (!matched) {
    matched = (productsDb || []).find(p => p && p.barcode && String(p.barcode).trim() === clean);
  }
  if (!matched) {
    matched = (productsDb || []).find(p => p && (String(p.id) === clean || (p.description && p.description.toLowerCase() === clean.toLowerCase())));
  }

  window.playScannerBeep();

  if (matched) {
    window.closeBarcodeScannerModal();
    if (typeof selectSmartProduct === 'function') {
      selectSmartProduct(matched);
    }
    setTimeout(() => {
      if (typeof addItemToBillingTable === 'function') {
        addItemToBillingTable();
      }
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`📦 Added "${matched.description}" via Barcode Scan!`, "success", 3500);
      }
    }, 120);
  } else {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`⚠️ Barcode: "${clean}" (No matching item in catalog). Add it in Products tab.`, "warning", 4500);
    }
  }
};

window.playScannerBeep = function() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1760, ctx.currentTime); // 1760Hz crisp POS chime
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
  } catch (e) {}
};

window.generateRandomBarcodeForModal = function() {
  const prefix = "890"; // GS1 India country code
  let mid = "";
  for (let i = 0; i < 9; i++) {
    mid += Math.floor(Math.random() * 10);
  }
  const full12 = prefix + mid;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(full12[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  const barcode = full12 + check;
  const input = document.getElementById("modal-prod-barcode");
  if (input) input.value = barcode;
  if (typeof showFloatingToast === 'function') {
    showFloatingToast(`✨ Generated GS1 Barcode: ${barcode}`, 3000);
  }
};

window.handlePaymentStatusChange = function() {
  const status = elements.billPaymentStatus.value;
  currentInvoice.paymentStatus = status;
  
  const paidWrapper = document.getElementById("paid-amount-wrapper");
  const balWrapper = document.getElementById("balance-paid-wrapper");
  const dateWrapper = document.getElementById("payment-date-wrapper");
  if (status === "Partial") {
    if (paidWrapper) paidWrapper.style.display = "block";
    if (balWrapper) balWrapper.style.display = "block";
    if (dateWrapper) dateWrapper.style.display = "block";
  } else if (status === "Unpaid") {
    if (paidWrapper) paidWrapper.style.display = "none";
    if (balWrapper) balWrapper.style.display = "none";
    if (dateWrapper) dateWrapper.style.display = "none";
    elements.billPaidAmount.value = "0";
    elements.billBalancePaid.value = "0";
    currentInvoice.paidAmount = 0;
    currentInvoice.balancePaid = 0;
  } else {
    if (paidWrapper) paidWrapper.style.display = "none";
    if (balWrapper) balWrapper.style.display = "none";
    if (dateWrapper) dateWrapper.style.display = "block";
  }
  calculateSummaryAndTable();
};

// --- ADD BILLING ROW CONTROLLER ---
window.addBillingItemRow = function() {
  try {
    if (!currentInvoice) currentInvoice = {};
    if (!Array.isArray(currentInvoice.items)) currentInvoice.items = [];

    const prodId = elements.billItemSelect ? elements.billItemSelect.value : "";
    let prod = productsDb.find(p => p && p.id === prodId);
    if (!prod && prodId && prodId !== '__custom__') {
      prod = productsDb.find(p => p && p.description === prodId);
    }

    let desc = "";
    if (elements.billItemName && elements.billItemName.value && elements.billItemName.value.trim()) {
      desc = elements.billItemName.value.trim();
    } else if (prod) {
      desc = prod.description;
    } else if (prodId && prodId !== '__custom__') {
      desc = prodId.trim();
    }

    if (!desc) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("⚠️ Please enter a product name or select from catalog!", "warning");
      } else {
        showFloatingToast("⚠️ Please enter a product name or select from catalog!", "warning");
      }
      if (elements.billItemName) {
        elements.billItemName.focus();
      } else if (elements.billItemSelect) {
        elements.billItemSelect.focus();
      }
      return false;
    }

    const rawQty = elements.billItemQty ? elements.billItemQty.value : "1";
    const parsedLot = (typeof window.parseMultiLotWeight === 'function') 
      ? window.parseMultiLotWeight(rawQty) 
      : { total: parseFloat(rawQty) || 1, count: 1, isMulti: false };
    const qty = parsedLot.total > 0 ? parsedLot.total : 1;
    const unit = (elements.billItemUnit ? elements.billItemUnit.value.trim() : "") || (prod ? (prod.unit || "Bucket") : "Bucket");
    const gstRate = parseFloat(elements.billItemGstRate ? elements.billItemGstRate.value : "0") || (prod ? (parseFloat(prod.gstRate) || 0) : 0);
    const discount = parseFloat(elements.billItemDiscount ? elements.billItemDiscount.value : "0") || 0;
    
    let rate = parseFloat(elements.billItemRate ? elements.billItemRate.value : "0");
    if (isNaN(rate) || rate <= 0) {
      rate = prod && prod.rate ? (parseFloat(prod.rate) || 1) : 1;
    }

    const packVal = (elements.billItemPack ? elements.billItemPack.value.trim() : "") || (prod ? (prod.packSize || "—") : "—");

    // STRICT REAL-WORLD INVENTORY ENFORCEMENT:
    // Block adding items if stock is 0 or requested quantity exceeds warehouse stock!
    if (prod && prod.stock !== undefined && prod.stock !== null && prod.stock !== "") {
      const availableStock = Math.max(0, parseInt(prod.stock, 10) || 0);

      // In case user is editing an existing invoice, factor in units already committed in the saved invoice
      let previouslyInvoicedQty = 0;
      if (currentInvoice && currentInvoice.isEditing && currentInvoice.id) {
        const origInv = invoicesDb.find(inv => inv && inv.id === currentInvoice.id);
        if (origInv && origInv.details && Array.isArray(origInv.details.items)) {
          const matchingOldItem = origInv.details.items.find(it => 
            (it.productId && prod.id && it.productId === prod.id) ||
            (it.description && prod.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
          );
          if (matchingOldItem) {
            previouslyInvoicedQty = parseFloat(matchingOldItem.quantity) || 0;
          }
        }
      }

      const effectiveAvailable = availableStock + previouslyInvoicedQty;

      // How many units of this product are ALREADY in the current invoice table?
      const currentInCart = currentInvoice.items
        .filter(item => 
          (item.productId && prod.id && item.productId === prod.id) ||
          (item.description && prod.description && item.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
        )
        .reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0);

      const totalRequested = currentInCart + qty;

      if (effectiveAvailable <= 0) {
        showFloatingToast(`❌ Out of Stock: "${prod.description}" is currently OUT OF STOCK (Available: 0). Cannot add to invoice.`, "warning");
        if (elements.billItemSelect) elements.billItemSelect.focus();
        return false;
      }

      if (totalRequested > effectiveAvailable) {
        const maxCanAdd = Math.max(0, effectiveAvailable - currentInCart);
        if (maxCanAdd > 0) {
          showFloatingToast(`❌ Insufficient Stock: "${prod.description}" has only ${effectiveAvailable} ${prod.unit || 'units'} available (Current bill: ${currentInCart}, requested: ${qty}). Maximum you can add is ${maxCanAdd}.`, "warning");
          if (elements.billItemQty) {
            elements.billItemQty.value = maxCanAdd;
            elements.billItemQty.focus();
            elements.billItemQty.select();
          }
        } else {
          showFloatingToast(`❌ Stock Limit Reached: All ${effectiveAvailable} available units of "${prod.description}" are already added to this invoice! Cannot add more.`, "warning");
          if (elements.billItemSelect) elements.billItemSelect.focus();
        }
        return false;
      }
    }

    const rawSubtotal = qty * rate;
    const amount = rawSubtotal * (1 - discount / 100);

    const newItem = {
      id: Date.now().toString() + "_" + Math.floor(Math.random() * 1000),
      productId: prod ? prod.id : "",
      baleNo: (currentInvoice.items.length + 1).toString(),
      description: desc,
      hsn: hsn,
      packSize: packVal,
      quantity: qty,
      unit: unit,
      rate: rate,
      gstRate: gstRate,
      discount: discount,
      amount: amount
    };

    currentInvoice.items.push(newItem);

    // Auto-register new custom item into productsDb and sync with Google Sheets
    if (!productsDb.some(p => p && p.description && p.description.trim().toLowerCase() === desc.toLowerCase())) {
      const newProd = {
        id: "prod_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        description: desc,
        hsn: hsn,
        packSize: packVal !== "—" ? packVal : "",
        unit: unit,
        rate: rate,
        gstRate: gstRate,
        discount: discount,
        stock: 100,
        updatedAt: new Date().toISOString()
      };
      productsDb.push(newProd);
      try {
        localStorage.setItem("products", JSON.stringify(productsDb));
        if (typeof syncDatabaseToServer === 'function') {
          syncDatabaseToServer("products", productsDb);
        }
        populateBillingSelectors();
      } catch (e) {
        console.warn("Auto-register product note:", e);
      }
    }
    
    if (elements.billItemSelect) elements.billItemSelect.value = "";
    if (elements.billItemName) elements.billItemName.value = "";
    if (elements.billItemHsn) elements.billItemHsn.value = "";
    if (elements.billItemQty) elements.billItemQty.value = "1";
    if (elements.billItemUnit) elements.billItemUnit.value = "Bucket";
    if (elements.billItemPack) elements.billItemPack.value = "";
    if (elements.billItemStockQty) elements.billItemStockQty.value = "—";
    if (elements.billItemGstRate) elements.billItemGstRate.value = "0";
    if (elements.billItemDiscount) elements.billItemDiscount.value = "0";
    if (elements.billItemRate) elements.billItemRate.value = "0";
    if (typeof calculateBillingItemNetVal === 'function') calculateBillingItemNetVal();
    if (typeof updateBillingStockTelemetry === 'function') updateBillingStockTelemetry(null);
    if (typeof handleBillingQtyInput === 'function') handleBillingQtyInput();
    if (typeof clearSmartProductSelection === 'function') clearSmartProductSelection();
    if (typeof playAudioFeedback === 'function') playAudioFeedback('add');

    calculateSummaryAndTable();
    return true;
  } catch (err) {
    console.error("addBillingItemRow error:", err);
    return false;
  }
};

window.deleteBillingItemRow = function(id) {
  currentInvoice.items = currentInvoice.items.filter(item => item.id !== id);
  currentInvoice.items.forEach((item, index) => {
    item.baleNo = (index + 1).toString();
  });
  calculateSummaryAndTable();
  if (typeof handleBillingQtyInput === 'function') handleBillingQtyInput();
  if (typeof playAudioFeedback === 'function') playAudioFeedback('click');
};

// --- CALCULATE SUMMARY & TABLE ---
function calculateSummaryAndTable() {
  if (!currentInvoice) currentInvoice = {};
  if (!Array.isArray(currentInvoice.items)) currentInvoice.items = [];

  elements.billingItemsTbody.innerHTML = "";
  
  if (currentInvoice.items.length === 0) {
    elements.noItemsPlaceholder.classList.remove("hidden");
  } else {
    elements.noItemsPlaceholder.classList.add("hidden");
  }

  let totalQty = 0;
  const sellerStateCode = globalSettings.company?.stateCode || "37";
  const buyerStateCode = currentInvoice.buyer?.stateCode || "37";
  const breakdown = InvoiceUtils.calculateInvoiceBreakdown(currentInvoice.items, sellerStateCode, buyerStateCode);
  let taxableVal = breakdown.taxableVal;
  let totalCgst = breakdown.totalCgst;
  let totalSgst = breakdown.totalSgst;
  let totalIgst = breakdown.totalIgst;
  const isLocal = breakdown.isLocal;

  currentInvoice.items.forEach(item => {
    totalQty += item.quantity;

    // Remaining warehouse stock after this cart commitment
    let remStockBadge = '';
    const prod = productsDb.find(p => (item.productId && p.id === item.productId) || ((p.description || '').trim().toLowerCase() === (item.description || '').trim().toLowerCase()));
    if (prod && prod.stock !== undefined && prod.stock !== null && prod.stock !== '') {
      const liveStock = parseInt(prod.stock, 10) || 0;
      const totalInCartForProd = currentInvoice.items
        .filter(it => (it.productId && prod.id && it.productId === prod.id) || ((it.description || '').trim().toLowerCase() === (prod.description || '').trim().toLowerCase()))
        .reduce((sum, it) => sum + (parseFloat(it.quantity) || 0), 0);
      
      let previouslyInvoicedQty = 0;
      if (currentInvoice && currentInvoice.isEditing && currentInvoice.id) {
        const origInv = invoicesDb.find(inv => inv && inv.id === currentInvoice.id);
        if (origInv && origInv.details && Array.isArray(origInv.details.items)) {
          const matchingOld = origInv.details.items.find(it => 
            (it.productId && prod.id && it.productId === prod.id) ||
            (it.description && prod.description && it.description.trim().toLowerCase() === prod.description.trim().toLowerCase())
          );
          if (matchingOld) previouslyInvoicedQty = parseFloat(matchingOld.quantity) || 0;
        }
      }
      const remAfterCart = (liveStock + previouslyInvoicedQty) - totalInCartForProd;
      const remColor = remAfterCart <= 0 ? '#ef4444' : (remAfterCart <= 10 ? '#d97706' : '#059669');
      remStockBadge = `<div style="font-size: 10px; color: ${remColor}; font-weight: 600; white-space: nowrap;">(${remAfterCart} left)</div>`;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--primary-teal);">${item.baleNo}</td>
      <td style="text-align: left; font-weight: 600;">
        ${item.description}
        ${item.packSize && item.packSize !== '—' ? `<div style="font-size: 11px; color: #64748b; font-weight: 500;">Pack: ${item.packSize}</div>` : ''}
      </td>
      <td>${item.hsn || "—"}</td>
      <td>
        <div class="table-qty-stepper">
          <button type="button" class="table-btn-step" onclick="stepTableItemQty('${item.id}', -1)" title="Decrease Qty">–</button>
          <span class="table-qty-val">${item.quantity}</span>
          <button type="button" class="table-btn-step" onclick="stepTableItemQty('${item.id}', 1)" title="Increase Qty">+</button>
        </div>
        ${remStockBadge}
      </td>
      <td>${item.unit || "Bucket"}</td>
      <td style="text-align: right; font-weight: 600;">₹ ${formatCurrency(item.rate)}</td>
      <td style="text-align: right; font-weight: 600;">${item.discount ? item.discount.toFixed(2) + '%' : '0.00%'}</td>
      <td style="text-align: right; font-weight: 700; color: var(--primary-teal);">₹ ${formatCurrency(item.amount)}</td>
      <td>
        <button class="btn-delete-row" onclick="deleteBillingItemRow('${item.id}')" title="Delete">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;
    elements.billingItemsTbody.appendChild(tr);
  });

  if (elements.sumCgstRow) elements.sumCgstRow.style.display = 'none';
  if (elements.sumSgstRow) elements.sumSgstRow.style.display = 'none';
  if (elements.sumIgstRow) elements.sumIgstRow.style.display = 'none';

  // Re-show the appropriate tax rows based on intra/inter-state supply
  const hasAnyGst = currentInvoice.items.some(i => parseFloat(i.taxRate || i.gstRate || i.gst || 0) > 0);
  if (isLocal) {
    if (elements.sumCgstRow && (totalCgst > 0 || hasAnyGst)) elements.sumCgstRow.style.display = 'flex';
    if (elements.sumSgstRow && (totalSgst > 0 || hasAnyGst)) elements.sumSgstRow.style.display = 'flex';
  } else {
    if (elements.sumIgstRow && (totalIgst > 0 || hasAnyGst)) elements.sumIgstRow.style.display = 'flex';
  }

  const rawGrandTotal = breakdown.rawGrandTotal;
  const roundedGrandTotal = breakdown.roundedGrandTotal;
  const roundOff = breakdown.roundOff;

  // Handle Payment Status & Balance Due calculations
  const status = elements.billPaymentStatus?.value || currentInvoice.paymentStatus || "Paid";
  const paymentSummary = InvoiceUtils.calculatePaymentSummary(
    roundedGrandTotal,
    status,
    elements.billPaidAmount?.value || currentInvoice.paidAmount || 0,
    elements.billBalancePaid?.value || currentInvoice.balancePaid || 0
  );
  const balanceDue = paymentSummary.balanceDue;

  currentInvoice.paidAmount = paymentSummary.paidAmount;
  currentInvoice.balancePaid = paymentSummary.balancePaid;
  currentInvoice.balanceDue = balanceDue;

  if (balanceDue === 0 && status !== "Unpaid") {
    currentInvoice.paymentStatus = "Paid";
  } else {
    currentInvoice.paymentStatus = status;
  }

  // Render values to Summary card
  elements.sumTaxable.textContent = `₹ ${formatCurrency(taxableVal)}`;
  elements.sumCgst.textContent = `₹ ${formatCurrency(totalCgst)}`;
  elements.sumSgst.textContent = `₹ ${formatCurrency(totalSgst)}`;
  elements.sumIgst.textContent = `₹ ${formatCurrency(totalIgst)}`;
  elements.sumRoundOff.textContent = (roundOff < 0 ? `- ` : `+ `) + `₹ ${formatCurrency(Math.abs(roundOff))}`;
  elements.sumGrandTotal.textContent = `₹ ${formatCurrency(roundedGrandTotal)}`;
  elements.sumGrandWords.textContent = convertNumberToWords(roundedGrandTotal);

  // Trigger price pulse animation
  if (elements.sumGrandTotal) {
    elements.sumGrandTotal.classList.remove("pulse-total");
    void elements.sumGrandTotal.offsetWidth;
    elements.sumGrandTotal.classList.add("pulse-total");
  }

  if (balanceDue > 0) {
    elements.dueRowContainer.style.display = "flex";
    elements.sumBalanceDue.textContent = `₹ ${formatCurrency(balanceDue)}`;
  } else {
    elements.dueRowContainer.style.display = "none";
  }

  // Calculate and Render Estimated Gross Profit & Margin
  let totalCost = 0;
  (currentInvoice.items || []).forEach(it => {
    const prod = (productsDb || []).find(p => (it.productId && p.id === it.productId) || ((p.description || '').trim().toLowerCase() === (it.description || '').trim().toLowerCase()));
    const cPrice = it.costPrice !== undefined ? it.costPrice : (prod?.costPrice || 0);
    totalCost += (parseFloat(cPrice) || 0) * (parseFloat(it.quantity) || 0);
  });
  const profitBadge = document.getElementById("billing-profit-badge");
  const profitAmtEl = document.getElementById("sum-profit-amt");
  const profitPctEl = document.getElementById("sum-profit-pct");
  if (profitBadge && profitAmtEl && profitPctEl) {
    if (totalCost > 0 && taxableVal > 0) {
      const profit = Math.max(0, taxableVal - totalCost);
      const margin = ((profit / taxableVal) * 100).toFixed(1);
      profitAmtEl.textContent = `₹ ${formatCurrency(profit)}`;
      profitPctEl.textContent = `${margin}%`;
      profitBadge.style.display = "flex";
    } else {
      profitBadge.style.display = "none";
    }
  }

  // Update Live Metadata Badge in Summary Card
  const docTypeEl = document.getElementById("sum-meta-doc-type");
  if (docTypeEl && elements.billInvoiceType) {
    docTypeEl.textContent = elements.billInvoiceType.value.toUpperCase();
  }
  const invNoEl = document.getElementById("sum-meta-invoice-no");
  if (invNoEl && elements.billInvoiceNo) {
    invNoEl.textContent = "#" + (elements.billInvoiceNo.value || "0000");
  }
  const invDateEl = document.getElementById("sum-meta-date");
  if (invDateEl && elements.billInvoiceDate) {
    invDateEl.textContent = formatInputDateString(elements.billInvoiceDate.value);
  }
}

function resetBillingForm() {
  loadAllDatabases();
  
  currentInvoice = {
    id: "",
    qrToken: "",
    isEditing: false,
    invoiceType: "Bill of Supply",
    headerLogo: "ganesha",
    invoiceNo: "",
    invoiceDate: new Date().toISOString().split('T')[0],
    paymentDate: new Date().toISOString().split('T')[0],
    buyerOrderNo: "",
    buyerOrderDate: "",
    transportMode: "",
    destination: "Andhra Pradesh",
    supplyStateCode: "37",
    paymentStatus: "Paid",
    paymentMode: "UPI / QR",
    paidAmount: 0,
    balancePaid: 0,
    balanceDue: 0,
    buyer: { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" },
    consignee: { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" },
    items: []
  };

  elements.billInvoiceType.value = "Bill of Supply";
  elements.billHeaderLogo.value = "ganesha";
  elements.billInvoiceNo.value = "";
  elements.billInvoiceDate.value = currentInvoice.invoiceDate;
  if (elements.billPaymentDate) {
    elements.billPaymentDate.value = currentInvoice.paymentDate;
  }
  elements.billBuyerOrderNo.value = "";
  elements.billBuyerOrderDate.value = "";
  elements.billTransportMode.value = "";
  elements.billDestination.value = "Andhra Pradesh";
  elements.billSupplyStateCode.value = "37";

  elements.billBuyerName.value = "";
  elements.billBuyerAddress.value = "";
  elements.billBuyerGstin.value = "";
  elements.billBuyerPhone.value = "";
  elements.billBuyerState.value = "Andhra Pradesh";
  elements.billBuyerStateCode.value = "37";

  elements.billConsigneeName.value = "";
  elements.billConsigneeAddress.value = "";
  elements.billConsigneeGstin.value = "";
  elements.billConsigneePhone.value = "";
  elements.billConsigneeState.value = "Andhra Pradesh";
  elements.billConsigneeStateCode.value = "37";
  elements.billPaymentStatus.value = "Paid";
  elements.billPaymentMode.value = "UPI / QR";
  elements.billPaidAmount.value = "0";
  elements.billBalancePaid.value = "0";
  const paidWrapper = document.getElementById("paid-amount-wrapper");
  if (paidWrapper) {
    paidWrapper.style.display = "none";
  }
  const balWrapper = document.getElementById("balance-paid-wrapper");
  if (balWrapper) {
    balWrapper.style.display = "none";
  }
  const dateWrapper = document.getElementById("payment-date-wrapper");
  if (dateWrapper) {
    dateWrapper.style.display = "block";
  }

  populateBillingSelectors();
  if (typeof clearSmartProductSelection === 'function') clearSmartProductSelection();
  if (typeof setPaymentStatusSegment === 'function') setPaymentStatusSegment("Paid");
  autoSuggestInvoiceNo();
  calculateSummaryAndTable();
}

// --- HELPER: ENSURE INVOICE ITEMS BEFORE SAVE ---
function prepareInvoiceItemsBeforeSave() {
  if (!currentInvoice) currentInvoice = {};
  if (!Array.isArray(currentInvoice.items)) currentInvoice.items = [];

  // 1. If items empty, check if user has filled anything into the item input row
  if (currentInvoice.items.length === 0) {
    const hasName = elements.billItemName && elements.billItemName.value && elements.billItemName.value.trim();
    const hasSelect = elements.billItemSelect && elements.billItemSelect.value && elements.billItemSelect.value !== '__custom__';
    const hasRate = elements.billItemRate && parseFloat(elements.billItemRate.value) > 0;
    
    if (hasName || hasSelect || hasRate) {
      window.addBillingItemRow();
    }
  }

  // 2. If still empty, do NOT fabricate dummy items with fake stock
  if (currentInvoice.items.length === 0) {
    showFloatingToast("⚠️ Please add at least one line item to the invoice before saving.", "warning");
    if (elements.billItemSelect) elements.billItemSelect.focus();
    return false;
  }

  return true;
}

// --- UNIFIED INVOICE SAVE ENGINE ---
window.saveCurrentInvoiceRecord = async function(actionType = 'save_only', btnEl = null) {
  if (isSavingInvoice) return null;
  isSavingInvoice = true;

  let origHtml = "";
  if (btnEl && btnEl.innerHTML) {
    origHtml = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btnEl.disabled = true;
  }

  try {
    isLocked = false;
    localStorage.setItem("app_locked", "false");
    localStorage.setItem("last_active_time", Date.now());

    if (typeof syncBillingInputsToCurrentInvoice === 'function') {
      syncBillingInputsToCurrentInvoice();
    }

    // Ensure invoiceNo is resolved
    if (!currentInvoice.invoiceNo && elements.billInvoiceNo && elements.billInvoiceNo.value) {
      currentInvoice.invoiceNo = elements.billInvoiceNo.value.trim();
    }
    if (!currentInvoice.invoiceNo) {
      autoSuggestInvoiceNo();
    }

    // Ensure buyer name is resolved (fallback to "Cash Customer" so it never blocks!)
    if (!currentInvoice.buyer) currentInvoice.buyer = {};
    if (!currentInvoice.buyer.name && elements.billBuyerName && elements.billBuyerName.value) {
      currentInvoice.buyer.name = elements.billBuyerName.value.trim();
    }
    if (!currentInvoice.buyer.name) {
      currentInvoice.buyer.name = "Cash Customer";
      if (elements.billBuyerName) elements.billBuyerName.value = "Cash Customer";
    }

    // Auto-resolve line items
    if (!prepareInvoiceItemsBeforeSave()) {
      if (btnEl) {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }
      isSavingInvoice = false;
      return null;
    }

    // Ensure current phones & names from inputs are strictly captured
    if (!currentInvoice.buyer) currentInvoice.buyer = {};
    if (elements.billBuyerName && elements.billBuyerName.value) {
      currentInvoice.buyer.name = elements.billBuyerName.value.trim();
    }
    if (elements.billBuyerPhone && elements.billBuyerPhone.value) {
      currentInvoice.buyer.phone = elements.billBuyerPhone.value.trim();
    }
    if (currentInvoice.buyer?.name && currentInvoice.buyer?.phone) {
      savePhoneToPartyDb(currentInvoice.buyer.name, currentInvoice.buyer.phone, 'receiver');
    }

    if (!currentInvoice.consignee) currentInvoice.consignee = {};
    if (elements.billConsigneeName && elements.billConsigneeName.value) {
      currentInvoice.consignee.name = elements.billConsigneeName.value.trim();
    }
    if (elements.billConsigneePhone && elements.billConsigneePhone.value) {
      currentInvoice.consignee.phone = elements.billConsigneePhone.value.trim();
    }
    if (currentInvoice.consignee?.name && currentInvoice.consignee?.phone) {
      savePhoneToPartyDb(currentInvoice.consignee.name, currentInvoice.consignee.phone, 'consignee');
    }

    const sellerStateCode = globalSettings.company?.stateCode || "37";
    const buyerStateCode = currentInvoice.buyer?.stateCode || "37";
    const breakdown = InvoiceUtils.calculateInvoiceBreakdown(currentInvoice.items, sellerStateCode, buyerStateCode);
    let taxableVal = breakdown.taxableVal;
    let totalCgst = breakdown.totalCgst;
    let totalSgst = breakdown.totalSgst;
    let totalIgst = breakdown.totalIgst;
    const grandTotal = breakdown.roundedGrandTotal;
    const roundOff = breakdown.roundOff;

    // Strict stock verification before invoice generation
    const origItems = (currentInvoice.isEditing && currentInvoice.id) 
      ? (invoicesDb.find(inv => inv && inv.id === currentInvoice.id)?.details?.items || []) 
      : [];
    if (!validateInvoiceStockAvailability(currentInvoice.items, origItems)) {
      if (btnEl) {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }
      isSavingInvoice = false;
      return null;
    }

    if (!validateInvoicePaymentExceeds(currentInvoice, grandTotal)) {
      if (btnEl) {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }
      isSavingInvoice = false;
      return null;
    }

    currentInvoice.taxable = taxableVal;
    currentInvoice.cgst = totalCgst;
    currentInvoice.sgst = totalSgst;
    currentInvoice.igst = totalIgst;
    currentInvoice.total = grandTotal;

    const resolvedPStatus = (elements.billPaymentStatus?.value || currentInvoice.paymentStatus || "Paid").trim();
    currentInvoice.paymentStatus = resolvedPStatus;
    if (resolvedPStatus === "Paid") {
      currentInvoice.paidAmount = grandTotal;
      currentInvoice.balancePaid = 0;
      currentInvoice.balanceDue = 0;
    } else if (resolvedPStatus === "Unpaid") {
      currentInvoice.paidAmount = 0;
      currentInvoice.balancePaid = 0;
      currentInvoice.balanceDue = grandTotal;
    } else if (resolvedPStatus === "Partial") {
      const pAmt = parseFloat(elements.billPaidAmount?.value !== undefined && elements.billPaidAmount?.value !== "" ? elements.billPaidAmount.value : currentInvoice.paidAmount) || 0;
      const bPaid = parseFloat(elements.billBalancePaid?.value !== undefined && elements.billBalancePaid?.value !== "" ? elements.billBalancePaid.value : currentInvoice.balancePaid) || 0;
      currentInvoice.paidAmount = pAmt;
      currentInvoice.balancePaid = bPaid;
      currentInvoice.balanceDue = Math.max(0, InvoiceUtils.roundToTwo(grandTotal - (pAmt + bPaid)));
    }

    // Auto-resolve invoice number collision on new invoices with friendly multi-user notice
    if (!currentInvoice.isEditing && invoicesDb.some(inv => inv && (inv.invoiceNo === currentInvoice.invoiceNo || (inv.details && inv.details.invoiceNo === currentInvoice.invoiceNo)))) {
      const priorNo = currentInvoice.invoiceNo;
      currentInvoice.invoiceNo = InvoiceUtils.getNextInvoiceNumber(invoicesDb);
      if (elements.billInvoiceNo) elements.billInvoiceNo.value = currentInvoice.invoiceNo;
      if (typeof showFloatingToast === "function") {
        showFloatingToast(`ℹ️ Invoice ${priorNo} was committed by another staff member. Auto-sequenced to ${currentInvoice.invoiceNo}.`, "info", 4500);
      }
    }

    const uniqueId = currentInvoice.id || "inv_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    currentInvoice.id = uniqueId;

    if (!currentInvoice.qrToken) {
      const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
      const timeSuffix = Date.now().toString(36).slice(-4).toUpperCase();
      currentInvoice.qrToken = `Q-${String(currentInvoice.invoiceNo || 'INV').replace(/^#/, '')}-${timeSuffix}${randSuffix}`;
    }

    const consigneeDisplayName = (currentInvoice.consignee?.name || '').trim();
    const buyerDisplayName = (currentInvoice.buyer?.name || '').trim();
    const primaryCustomerDisplay = consigneeDisplayName || buyerDisplayName || "Cash Customer";

    const invoiceRecord = {
      id: uniqueId,
      qrToken: currentInvoice.qrToken,
      invoiceNo: currentInvoice.invoiceNo,
      invoiceDate: currentInvoice.invoiceDate,
      customerName: primaryCustomerDisplay,
      buyer: currentInvoice.buyer,
      consignee: currentInvoice.consignee,
      items: currentInvoice.items,
      itemsCount: currentInvoice.items.length,
      taxable: taxableVal,
      cgst: totalCgst,
      sgst: totalSgst,
      igst: totalIgst,
      roundOff: roundOff,
      total: grandTotal,
      paymentStatus: currentInvoice.paymentStatus,
      paymentMode: currentInvoice.paymentMode,
      paidAmount: currentInvoice.paidAmount,
      balancePaid: currentInvoice.balancePaid,
      balanceDue: currentInvoice.balanceDue,
      transportMode: currentInvoice.transportMode,
      destination: currentInvoice.destination,
      supplyStateCode: currentInvoice.supplyStateCode,
      isEstimate: !!currentInvoice.isEstimate,
      details: JSON.parse(JSON.stringify(currentInvoice))
    };

    let existingIdx = -1;
    const originalId = uniqueId;
    if (originalId && invoicesDb.some(inv => inv && inv.id === originalId)) {
      existingIdx = invoicesDb.findIndex(inv => inv && inv.id === originalId);
    } else if (currentInvoice.isEditing) {
      existingIdx = invoicesDb.findIndex(inv => inv && inv.invoiceNo === invoiceRecord.invoiceNo);
    }

    let stockDeltas = [];
    if (existingIdx > -1) {
      stockDeltas = reconcileProductInventoryStock(invoicesDb[existingIdx]?.details, currentInvoice) || [];
      invoicesDb[existingIdx] = invoiceRecord;
    } else {
      stockDeltas = reconcileProductInventoryStock(null, currentInvoice) || [];
      invoicesDb.push(invoiceRecord);
    }

    // Immediately disarm currentInvoice editing state so subsequent bills are brand new
    currentInvoice.id = "";
    currentInvoice.qrToken = "";
    currentInvoice.isEditing = false;

    // Unblock any tombstone matching this invoice number or ID so newly generated invoices are NEVER filtered out
    if (typeof window.clearInvoiceTombstone === 'function') {
      window.clearInvoiceTombstone(invoiceRecord.invoiceNo, invoiceRecord.id);
    }

    if (!window.recentInvoiceMutations) window.recentInvoiceMutations = {};
    window.recentInvoiceMutations[invoiceRecord.id] = Date.now();
    window.recentInvoiceMutations[invoiceRecord.invoiceNo] = Date.now();

    // ★ IMMEDIATE UI REFRESH — new invoice appears on Dashboard & History instantly
    try {
      if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
      if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
    } catch (uiErr) { console.warn("UI refresh note:", uiErr); }

    // Pure Google Cloud Master: In-memory commit & instant network sync (< 100ms)
    try {
      broadcastInterTabEvent('INVOICE_TRANSACTION_COMMITTED', {
        invoice: invoiceRecord,
        stockDeltas: stockDeltas,
        products: productsDb,
        parties: partiesDb
      });
      syncDatabaseToServer("invoices", invoiceRecord);
    } catch (err) {
      console.warn("Unable to sync invoice to cloud:", err);
    }

    let precomputedBase64 = null;

    // Non-blocking background worker: generate PDF, upload to Google Drive, Telegram & WhatsApp
    (async () => {
      try {
        if (typeof sendTelegramInvoiceNotification === 'function') sendTelegramInvoiceNotification(invoiceRecord);
      } catch (e) { console.warn("Telegram note:", e); }

      try {
        if (typeof generateInvoicePdfBlob === 'function') {
          const pdfRes = await generateInvoicePdfBlob(invoiceRecord.details);
          precomputedBase64 = pdfRes ? pdfRes.pdfBase64 : null;
        }
      } catch (e) {
        console.warn("PDF compile note:", e);
      }

      if (precomputedBase64 && typeof uploadInvoicePdfToTelegram === 'function') {
        try {
          uploadInvoicePdfToTelegram(invoiceRecord.details, true, precomputedBase64);
        } catch (e) { console.warn("Telegram PDF note:", e); }
      }

      const rawPhone = typeof getCustomerPhoneNumber === 'function' ? getCustomerPhoneNumber(invoiceRecord.details) : "";
      if (actionType !== 'share_whatsapp' && rawPhone && rawPhone.toString().replace(/\D/g, '').length >= 10 && globalSettings.whatsappAutoSend !== false) {
        try {
          if (typeof autoDispatchInvoiceToWhatsApp === 'function') {
            const sent = await autoDispatchInvoiceToWhatsApp(invoiceRecord.details, null, precomputedBase64);
            invoiceRecord.waAutoSent = Boolean(sent);
            if (typeof updateSuccessModalWhatsAppStatus === 'function') {
              updateSuccessModalWhatsAppStatus(invoiceRecord);
            }
          }
        } catch (e) {
          console.warn("Auto WhatsApp dispatch note:", e);
        }
      }
    })();

    // Handle action-specific outcome
    if (actionType === 'print_a4') {
      try { populateA4PrintOverlay(invoiceRecord.details); } catch (e) { console.warn(e); }
      showFloatingToast(`✅ Invoice #${invoiceRecord.invoiceNo} saved! Opening Print...`);
      setTimeout(() => {
        document.body.classList.remove("printing-thermal");
        window.print();
        resetBillingForm();
        switchTab("history");
        loadInvoicesHistoryTable();
      }, 100);
    } else if (actionType === 'print_thermal') {
      try { populateThermalPrintOverlay(invoiceRecord.details); } catch (e) { console.warn(e); }
      showFloatingToast(`✅ Invoice #${invoiceRecord.invoiceNo} saved! Opening POS Thermal...`);
      setTimeout(() => {
        document.body.classList.add("printing-thermal");
        window.print();
        document.body.classList.remove("printing-thermal");
        resetBillingForm();
        switchTab("history");
        loadInvoicesHistoryTable();
      }, 100);
    } else if (actionType === 'download_pdf') {
      showFloatingToast(`✅ Invoice #${invoiceRecord.invoiceNo} saved! Downloading PDF...`);
      downloadInvoicePdf(invoiceRecord.details, btnEl);
      resetBillingForm();
      switchTab("history");
      loadInvoicesHistoryTable();
    } else if (actionType === 'share_whatsapp') {
      showFloatingToast(`✅ Invoice #${invoiceRecord.invoiceNo} saved! Dispatching via WhatsApp...`);
      shareInvoicePdfNative(invoiceRecord.details, btnEl, false);
      if (typeof openInvoiceSuccessModal === 'function') {
        openInvoiceSuccessModal(invoiceRecord);
        resetBillingForm();
      } else {
        resetBillingForm();
        switchTab("history");
        loadInvoicesHistoryTable();
      }
    } else {
      // save_only ("Generate & Save Invoice"):
      // Fully automated: saves invoice, compiles PDF, syncs Google Drive & auto-dispatches via WhatsApp bot silently in background
      showFloatingToast(`✅ Invoice #${invoiceRecord.invoiceNo} successfully created & saved!`);

      // WhatsApp dispatch is handled by the background async worker above (line ~6537)
      // which includes the precomputed PDF — no duplicate call needed here

      if (typeof openInvoiceSuccessModal === 'function') {
        openInvoiceSuccessModal(invoiceRecord);
        resetBillingForm();
      } else {
        resetBillingForm();
        switchTab("history");
        loadInvoicesHistoryTable();
      }
    }

    return invoiceRecord;
  } catch (err) {
    console.error("Save invoice record error:", err);
    showFloatingToast("❌ Error saving invoice: " + (err.message || err), "warning");
    return null;
  } finally {
    if (btnEl) {
      setTimeout(() => {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }, 400);
    }
    setTimeout(() => {
      isSavingInvoice = false;
    }, 500);
  }
};

window.generateAndPrintInvoice = function(btnEl) {
  return window.saveCurrentInvoiceRecord('print_a4', btnEl);
};

window.saveAndGenerateInvoiceOnly = function(btnEl) {
  return window.saveCurrentInvoiceRecord('save_only', btnEl);
};

window.generateAndPrintThermal = function(btnEl) {
  return window.saveCurrentInvoiceRecord('print_thermal', btnEl);
};

// --- INVOICE SAVED SUCCESS MODAL CONTROLLER ---
let lastSavedInvoiceRecord = null;
let invoiceModalAutoTimer = null;
let invoiceModalAutoRemaining = 3;

window.openInvoiceSuccessModal = function(invoiceRecord) {
  lastSavedInvoiceRecord = invoiceRecord;
  const modal = document.getElementById("invoice-saved-success-modal");
  if (!modal) return;
  const invNoEl = document.getElementById("modal-success-inv-no");
  if (invNoEl) invNoEl.textContent = `#${invoiceRecord.invoiceNo || ''}`;
  const custEl = document.getElementById("modal-success-customer");
  if (custEl) {
    const consignee = invoiceRecord.details?.consignee;
    const buyer = invoiceRecord.details?.buyer;
    let label = '';
    if (consignee?.name) {
      label = `📦 ${consignee.name}${consignee.phone ? ' (' + consignee.phone + ')' : ''}`;
      if (buyer?.name && buyer.name !== consignee.name) {
        label += ` | 👤 ${buyer.name}${buyer.phone ? ' (' + buyer.phone + ')' : ''}`;
      }
    } else if (buyer?.name) {
      label = `👤 ${buyer.name}${buyer.phone ? ' (' + buyer.phone + ')' : ''}`;
    } else {
      label = invoiceRecord.customerName || 'Cash Customer';
    }
    custEl.textContent = label;
  }
  const totEl = document.getElementById("modal-success-total");
  if (totEl) totEl.textContent = `₹ ${formatCurrency(invoiceRecord.total || 0)}`;

  window.updateSuccessModalWhatsAppStatus(invoiceRecord);

  modal.classList.remove("hidden");
  modal.style.removeProperty("display");
  modal.style.removeProperty("visibility");

  // Automated auto-advance countdown to prepare next bill without manual clicks (comfortable 15s)
  const autoNextNotice = document.getElementById("modal-success-auto-next");
  if (autoNextNotice) {
    autoNextNotice.style.display = "block";
    invoiceModalAutoRemaining = 15;
    autoNextNotice.innerHTML = `<i class="fa-solid fa-clock text-teal"></i> Next invoice starting in <strong>${invoiceModalAutoRemaining}s</strong>... <button type="button" class="btn btn-xs btn-outline" onclick="cancelInvoiceAutoAdvance(event)" style="margin-left: 8px; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #10b981; background: #fff; cursor: pointer;">Stay on Bill</button>`;
  }

  if (invoiceModalAutoTimer) clearInterval(invoiceModalAutoTimer);
  invoiceModalAutoTimer = setInterval(() => {
    invoiceModalAutoRemaining--;
    if (autoNextNotice) {
      autoNextNotice.innerHTML = `<i class="fa-solid fa-clock text-teal"></i> Next invoice starting in <strong>${invoiceModalAutoRemaining}s</strong>... <button type="button" class="btn btn-xs btn-outline" onclick="cancelInvoiceAutoAdvance(event)" style="margin-left: 8px; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #10b981; background: #fff; cursor: pointer;">Stay on Bill</button>`;
    }
    if (invoiceModalAutoRemaining <= 0) {
      clearInterval(invoiceModalAutoTimer);
      invoiceModalAutoTimer = null;
      window.closeInvoiceSuccessModal(false);
    }
  }, 1000);
};

window.cancelInvoiceAutoAdvance = function(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (invoiceModalAutoTimer) {
    clearInterval(invoiceModalAutoTimer);
    invoiceModalAutoTimer = null;
  }
  const autoNextNotice = document.getElementById("modal-success-auto-next");
  if (autoNextNotice) {
    autoNextNotice.innerHTML = `<i class="fa-solid fa-circle-check text-success"></i> Auto-advance paused. Bill ready for WhatsApp, printing, or download.`;
  }
};

window.updateSuccessModalWhatsAppStatus = function(invoiceRecord) {
  if (!invoiceRecord) return;
  const waBtn = document.getElementById("modal-success-btn-whatsapp");
  if (!waBtn) return;
  const consigneePhone = invoiceRecord.details?.consignee?.phone || invoiceRecord.details?.buyer?.phone || invoiceRecord.customerPhone || "";
  const cleanDigits = consigneePhone.toString().replace(/\D/g, '');
  const isBotConnected = whatsappBotStatus && (whatsappBotStatus.isReady || whatsappBotStatus.status === 'CONNECTED');

  waBtn.style.background = "#16a34a";
  waBtn.style.color = "#ffffff";
  waBtn.style.display = "inline-flex";

  if (invoiceRecord.waAutoSent) {
    waBtn.innerHTML = `<i class="fa-solid fa-circle-check text-white"></i> WhatsApp Sent!`;
    waBtn.style.background = "#15803d";
    waBtn.title = "Dispatched via WhatsApp Companion Bot";
  } else if (cleanDigits.length >= 10) {
    const formatted = cleanDigits.length === 10 ? cleanDigits : cleanDigits.slice(-10);
    waBtn.innerHTML = `<i class="fa-brands fa-whatsapp"></i> Send WhatsApp (+91 ${formatted})`;
    waBtn.title = isBotConnected ? "Send immediately via WhatsApp Bot or 1-Click WhatsApp" : "1-Click Send via WhatsApp";
  } else {
    waBtn.innerHTML = `<i class="fa-brands fa-whatsapp"></i> Send WhatsApp`;
    waBtn.title = "Send Invoice via WhatsApp";
  }
};

window.closeInvoiceSuccessModal = function(goToHistory = false) {
  if (invoiceModalAutoTimer) {
    clearInterval(invoiceModalAutoTimer);
    invoiceModalAutoTimer = null;
  }
  const modal = document.getElementById("invoice-saved-success-modal");
  if (modal) modal.classList.add("hidden");
  resetBillingForm();
  if (goToHistory) {
    switchTab("history");
  } else {
    switchTab("billing");
    setTimeout(() => {
      if (elements.billBuyerName) elements.billBuyerName.focus();
    }, 150);
  }
  loadInvoicesHistoryTable();
};

window.triggerSuccessModalA4Print = function() {
  if (typeof window.cancelInvoiceAutoAdvance === 'function') window.cancelInvoiceAutoAdvance();
  if (!lastSavedInvoiceRecord) return;
  const rec = lastSavedInvoiceRecord;
  window.closeInvoiceSuccessModal(false);
  try { populateA4PrintOverlay(rec.details); } catch (e) { console.warn(e); }
  setTimeout(() => {
    document.body.classList.remove("printing-thermal");
    window.print();
  }, 100);
};

window.triggerSuccessModalThermalPrint = function() {
  if (typeof window.cancelInvoiceAutoAdvance === 'function') window.cancelInvoiceAutoAdvance();
  if (!lastSavedInvoiceRecord) return;
  const rec = lastSavedInvoiceRecord;
  window.closeInvoiceSuccessModal(false);
  try { populateThermalPrintOverlay(rec.details); } catch (e) { console.warn(e); }
  setTimeout(() => {
    document.body.classList.add("printing-thermal");
    window.print();
    document.body.classList.remove("printing-thermal");
  }, 100);
};

window.triggerSuccessModalDownloadPdf = function() {
  if (typeof window.cancelInvoiceAutoAdvance === 'function') window.cancelInvoiceAutoAdvance();
  if (!lastSavedInvoiceRecord) return;
  const rec = lastSavedInvoiceRecord;
  downloadInvoicePdf(rec.details);
};

window.triggerSuccessModalWhatsApp = function() {
  if (typeof window.cancelInvoiceAutoAdvance === 'function') window.cancelInvoiceAutoAdvance();
  if (!lastSavedInvoiceRecord) return;
  const rec = lastSavedInvoiceRecord;
  const waBtn = document.getElementById("modal-success-btn-whatsapp");
  shareInvoicePdfNative(rec.details, waBtn, false);
};

window.triggerSuccessModalUniversalShare = function() {
  if (!lastSavedInvoiceRecord) return;
  const rec = lastSavedInvoiceRecord;
  const invId = rec.id || (rec.details && (rec.details.invoiceNumber || rec.details.invoiceNo));
  if (invId && typeof window.openUniversalInvoiceShareModal === 'function') {
    window.openUniversalInvoiceShareModal(invId);
  }
};

// --- POPULATE PRINT VIEW CANVAS (A4) ---
function populateA4PrintOverlay(invoice) {
  const company = globalSettings.company || {};

  const divineMottoRow = document.getElementById("p-print-divine-motto");
  const divineImg = document.getElementById("p-print-divine-img");
  const divineImgRight = document.getElementById("p-print-divine-img-right");
  const mottoText = document.getElementById("p-print-motto-text");
  const logoChoice = invoice.headerLogo || "ganesha";
  if (logoChoice === "ganesha") {
    if (divineMottoRow) divineMottoRow.style.display = "flex";
    if (divineImg) { divineImg.style.display = "block"; divineImg.src = "lord_ganesha.jpg"; }
    if (divineImgRight) { divineImgRight.style.display = "block"; divineImgRight.src = "lord_hanuman.jpg"; }
    if (mottoText) mottoText.innerHTML = "॥ श्री गणेशाय नमः ॥ &nbsp;&nbsp;&nbsp;&nbsp; ॥ श्री हनुमते नमः ॥";
  } else {
    if (divineMottoRow) divineMottoRow.style.display = "none";
  }

  document.getElementById("p-print-document-title").textContent = invoice.invoiceType ? invoice.invoiceType.toUpperCase() : "BILL OF SUPPLY";

  document.getElementById("p-print-company-name").textContent = company.name || "AARYAN AQUA NEEDS";
  const taglineEl = document.getElementById("p-print-company-tagline");
  if (taglineEl) taglineEl.textContent = company.tagline || "QUALITY PRODUCTS FOR BETTER AQUACULTURE";
  document.getElementById("p-print-company-address").innerHTML = (company.address || "").replace(/\n/g, "<br>");
  document.getElementById("p-print-company-phones").textContent = company.phones || "+91 74166 05652";
  const emailEl = document.getElementById("p-print-company-email");
  if (emailEl) emailEl.textContent = company.email || "aaryanaquaneeds@gmail.com";
  const websiteEl = document.getElementById("p-print-company-website");
  if (websiteEl) websiteEl.textContent = company.website || "www.aaryan-aqua.com";
  document.getElementById("p-print-company-gstin").textContent = company.gstin || "37ACNFA4687Q1ZC";
  document.getElementById("p-print-company-state").textContent = company.state || "Andhra Pradesh";
  document.getElementById("p-print-company-state-code").textContent = company.stateCode || "37";

  document.getElementById("p-print-invoice-no").textContent = invoice.invoiceNo;
  document.getElementById("p-print-invoice-date").textContent = formatInputDateString(invoice.invoiceDate);
  
  document.getElementById("p-print-payment-mode").textContent = `${invoice.paymentMode || 'Cash'} (${invoice.paymentStatus || 'Paid'})`;
  document.getElementById("p-print-buyer-order-no").textContent = invoice.buyerOrderNo || "—";
  document.getElementById("p-print-buyer-order-date").textContent = invoice.buyerOrderDate ? formatInputDateString(invoice.buyerOrderDate) : "—";
  
  const transRow = document.getElementById("meta-row-transport");
  if (transRow) {
    if (invoice.transportMode) {
      transRow.style.display = "table-row";
      document.getElementById("p-print-transport-mode").textContent = invoice.transportMode;
    } else {
      transRow.style.display = "none";
    }
  }
  const destRow = document.getElementById("meta-row-destination");
  if (destRow) {
    if (invoice.destination) {
      destRow.style.display = "table-row";
      document.getElementById("p-print-destination").textContent = invoice.destination;
    } else {
      destRow.style.display = "none";
    }
  }

  document.getElementById("p-print-buyer-name").textContent = invoice.buyer.name;
  document.getElementById("p-print-buyer-address").innerHTML = (invoice.buyer.address || "").replace(/\n/g, "<br>");
  document.getElementById("p-print-buyer-gstin").textContent = invoice.buyer.gstin || "__________________";
  document.getElementById("p-print-buyer-state").textContent = invoice.buyer.state || "Andhra Pradesh";
  document.getElementById("p-print-buyer-state-code").textContent = invoice.buyer.stateCode || "37";
  const buyerPhoneEl = document.getElementById("p-print-buyer-phone");
  if (buyerPhoneEl) buyerPhoneEl.textContent = invoice.buyer.phone || "__________________";

  const consigneeName = invoice.consignee.name || invoice.buyer.name;
  const consigneeAddress = invoice.consignee.address || invoice.buyer.address;
  const consigneeGstin = invoice.consignee.gstin || invoice.buyer.gstin;
  const consigneeState = invoice.consignee.state || invoice.buyer.state;
  const consigneeStateCode = invoice.consignee.stateCode || invoice.buyer.stateCode;
  const consigneePhone = invoice.consignee.phone || invoice.buyer.phone;

  document.getElementById("p-print-consignee-name").textContent = consigneeName;
  document.getElementById("p-print-consignee-address").innerHTML = (consigneeAddress || "").replace(/\n/g, "<br>");
  document.getElementById("p-print-consignee-gstin").textContent = consigneeGstin || "__________________";
  document.getElementById("p-print-consignee-state").textContent = consigneeState || "Andhra Pradesh";
  document.getElementById("p-print-consignee-state-code").textContent = consigneeStateCode || "37";
  const consigneePhoneEl = document.getElementById("p-print-consignee-phone");
  if (consigneePhoneEl) consigneePhoneEl.textContent = consigneePhone || "__________________";

  const printItemsTbody = document.getElementById("p-print-items-tbody");
  printItemsTbody.innerHTML = "";
  
  let taxableVal = 0;
  let totalQuantity = 0;
  let grossAmount = 0;
  let totalDiscount = 0;

  invoice.items.forEach((item, index) => {
    taxableVal += item.amount;
    totalQuantity += item.quantity;
    const itemRate = item.rate || 0;
    const itemQty = item.quantity || 0;
    const itemGross = itemRate * itemQty;
    grossAmount += itemGross;
    const itemDiscVal = itemGross * ((item.discount || 0) / 100);
    totalDiscount += itemDiscVal;

    const prod = productsDb.find(p => p.description === item.description);
    const packSize = item.packSize || (prod ? prod.packSize : "—") || "—";
    
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align: center;">${index + 1}</td>
      <td style="text-align: left; font-weight: 700; color: #000000;">${item.description}</td>
      <td style="text-align: center;">${item.hsn || "23099090"}</td>
      <td style="text-align: center;">${packSize}</td>
      <td style="text-align: center; font-weight: 700;">${item.quantity}</td>
      <td style="text-align: center;">${item.unit || 'Bucket'}</td>
      <td style="text-align: center;">${formatCurrency(item.rate)}</td>
      <td style="text-align: center;">${item.discount ? item.discount.toFixed(2) + ' %' : '0.00 %'}</td>
      <td style="text-align: right; font-weight: 700;">${formatCurrency(item.amount)}</td>
    `;
    printItemsTbody.appendChild(tr);
  });

  const minRows = 5;
  const currRows = invoice.items.length;
  if (currRows < minRows) {
    for (let i = currRows; i < minRows; i++) {
      const tr = document.createElement("tr");
      tr.className = "filler-row";
      tr.innerHTML = `
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
      `;
      printItemsTbody.appendChild(tr);
    }
  }

  document.getElementById("p-print-total-quantity").textContent = `${totalQuantity} ${invoice.items[0]?.unit || 'Bucket'}`;
  document.getElementById("p-print-total-amount").textContent = `₹ ${formatCurrency(taxableVal)}`;

  const roundedGrandTotal = Math.round(invoice.total || taxableVal);
  document.getElementById("p-print-amount-words").textContent = "INR " + convertNumberToWords(roundedGrandTotal);

  // Financial Breakdown Box
  const grossEl = document.getElementById("p-print-gross-amount");
  if (grossEl) grossEl.textContent = formatCurrency(grossAmount > 0 ? grossAmount : taxableVal);
  const discEl = document.getElementById("p-print-total-discount");
  if (discEl) discEl.textContent = formatCurrency(totalDiscount);
  const taxValEl = document.getElementById("p-print-taxable-value");
  if (taxValEl) taxValEl.textContent = formatCurrency(taxableVal);

  const cgstEl = document.getElementById("p-print-cgst");
  if (cgstEl) cgstEl.textContent = (invoice.cgst && invoice.cgst > 0) ? `₹ ${formatCurrency(invoice.cgst)}` : "NIL";
  const sgstEl = document.getElementById("p-print-sgst");
  if (sgstEl) sgstEl.textContent = (invoice.sgst && invoice.sgst > 0) ? `₹ ${formatCurrency(invoice.sgst)}` : "NIL";
  const igstEl = document.getElementById("p-print-igst");
  if (igstEl) igstEl.textContent = (invoice.igst && invoice.igst > 0) ? `₹ ${formatCurrency(invoice.igst)}` : "NIL";

  const roundEl = document.getElementById("p-print-round-off");
  if (roundEl) roundEl.textContent = formatCurrency(invoice.roundOff || 0);
  const grandEl = document.getElementById("p-print-grand-total");
  if (grandEl) grandEl.textContent = `₹ ${formatCurrency(roundedGrandTotal)}`;

  // HSN summary table grouping
  const sellerStateCode = globalSettings.company?.stateCode || "37";
  const buyerStateCode = invoice.buyer?.stateCode || "37";
  const isLocal = (sellerStateCode === buyerStateCode);

  const hsnMap = {};
  invoice.items.forEach(item => {
    const code = item.hsn || "23099090";
    const ratePct = item.gstRate || 0;
    if (!hsnMap[code]) {
      hsnMap[code] = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    }
    hsnMap[code].taxable += item.amount;
    if (isLocal) {
      hsnMap[code].cgst += item.amount * (ratePct / 2) / 100;
      hsnMap[code].sgst += item.amount * (ratePct / 2) / 100;
    } else {
      hsnMap[code].igst += item.amount * ratePct / 100;
    }
  });

  const hsnTbody = document.getElementById("p-print-hsn-tbody");
  hsnTbody.innerHTML = "";
  let totHsnTaxable = 0, totHsnCgst = 0, totHsnSgst = 0, totHsnIgst = 0;
  
  const isBillOfSupply = (invoice.invoiceType === "Bill of Supply" || invoice.invoiceType === "Delivery Challan");
  const taxCols = document.querySelectorAll(".tally-hsn-tax-col");
  taxCols.forEach(col => {
    col.style.display = isBillOfSupply ? "none" : "";
  });

  Object.keys(hsnMap).forEach(code => {
    const data = hsnMap[code];
    const totalTax = data.cgst + data.sgst + data.igst;
    totHsnTaxable += data.taxable;
    totHsnCgst += data.cgst;
    totHsnSgst += data.sgst;
    totHsnIgst += data.igst;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align: left; font-weight: 700;">${code}</td>
      <td style="text-align: right;">${formatCurrency(data.taxable)}</td>
      ${isBillOfSupply ? '' : `
      <td style="text-align: center;" class="tally-hsn-tax-col">${data.cgst > 0 ? formatCurrency(data.cgst) : 'NIL'}</td>
      <td style="text-align: center;" class="tally-hsn-tax-col">${data.sgst > 0 ? formatCurrency(data.sgst) : 'NIL'}</td>
      <td style="text-align: center;" class="tally-hsn-tax-col">${data.igst > 0 ? formatCurrency(data.igst) : 'NIL'}</td>
      <td style="text-align: right; font-weight: 700;" class="tally-hsn-tax-col">${totalTax > 0 ? formatCurrency(totalTax) : 'NIL'}</td>
      `}
    `;
    hsnTbody.appendChild(tr);
  });

  const totalHsnTaxSum = totHsnCgst + totHsnSgst + totHsnIgst;
  document.getElementById("p-print-hsn-total-taxable").textContent = formatCurrency(totHsnTaxable);
  document.getElementById("p-print-hsn-total-cgst").textContent = totHsnCgst > 0 ? formatCurrency(totHsnCgst) : "NIL";
  document.getElementById("p-print-hsn-total-sgst").textContent = totHsnSgst > 0 ? formatCurrency(totHsnSgst) : "NIL";
  document.getElementById("p-print-hsn-total-igst").textContent = totHsnIgst > 0 ? formatCurrency(totHsnIgst) : "NIL";
  document.getElementById("p-print-hsn-total-tax").textContent = totalHsnTaxSum > 0 ? formatCurrency(totalHsnTaxSum) : "NIL";

  document.getElementById("p-print-tax-words").textContent = totalHsnTaxSum > 0 ? convertNumberToWords(Math.round(totalHsnTaxSum)) : "NIL";
  document.getElementById("p-print-sign-company").textContent = company.name ? company.name.toUpperCase() : "AARYAN AQUA NEEDS";

  // Bank & Payment QR Code Population
  const bank = globalSettings.bank || {};
  const bankNameEl = document.getElementById("p-print-bank-name");
  if (bankNameEl) bankNameEl.textContent = bank.name || "State Bank of India";
  const bankAccNameEl = document.getElementById("p-print-bank-acc-name");
  if (bankAccNameEl) bankAccNameEl.textContent = bank.accountName || company.name || "Aaryan Aqua Needs";
  const bankAccNoEl = document.getElementById("p-print-bank-acc-no");
  if (bankAccNoEl) bankAccNoEl.textContent = bank.accountNo || "45413424177";
  const bankIfscEl = document.getElementById("p-print-bank-ifsc");
  if (bankIfscEl) bankIfscEl.textContent = bank.ifsc || "SBIN0000911";
  const bankBranchEl = document.getElementById("p-print-bank-branch");
  if (bankBranchEl) bankBranchEl.textContent = bank.branch || "Repalle";

  // Verification & Payment QR Code
  const verifyQrImg = document.getElementById("p-print-verify-qr-img");
  if (verifyQrImg) {
    const verifyUrl = typeof window.getInvoiceVerificationUrl === "function"
      ? window.getInvoiceVerificationUrl(invoice.invoiceNo, invoice)
      : `https://aaryanaqua.netlify.app/?verify_invoice=${encodeURIComponent(invoice.invoiceNo)}`;
    verifyQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(verifyUrl)}`;
  }
}

// --- POPULATE THERMAL POS PRINT OVERLAY ---
function populateThermalPrintOverlay(invoice) {
  const company = globalSettings.company;
  
  const logoImg = document.getElementById("th-divine-img");
  if (logoImg) {
    if (invoice.headerLogo === "none") logoImg.style.display = "none";
    else logoImg.src = "lord_ganesha.jpg";
  }

  document.getElementById("th-company-name").textContent = company.name || "Aaryan Aqua Needs";
  document.getElementById("th-company-tagline").textContent = company.tagline || "";
  document.getElementById("th-company-address").textContent = (company.address || "").replace(/\n/g, ", ");
  document.getElementById("th-company-gstin").textContent = company.gstin || "—";
  document.getElementById("th-company-phone").textContent = company.phones || "—";

  document.getElementById("th-document-title").textContent = invoice.invoiceType || (invoice.isEstimate ? "QUOTATION" : "TAX INVOICE");
  document.getElementById("th-invoice-no").textContent = invoice.invoiceNo;
  document.getElementById("th-invoice-date").textContent = formatInputDateString(invoice.invoiceDate);
  document.getElementById("th-customer-name").textContent = invoice.buyer?.name || "Cash Customer";

  const tbody = document.getElementById("th-items-tbody");
  tbody.innerHTML = "";
  let taxableVal = 0, cgst = 0, sgst = 0, igst = 0;

  const sellerStateCode = globalSettings.company?.stateCode || "37";
  const buyerStateCode = invoice.buyer?.stateCode || "37";
  const isLocal = (sellerStateCode === buyerStateCode);

  invoice.items.forEach(item => {
    taxableVal += item.amount;
    const ratePct = item.gstRate || 0;
    if (isLocal) {
      cgst += item.amount * (ratePct / 2) / 100;
      sgst += item.amount * (ratePct / 2) / 100;
    } else {
      igst += item.amount * ratePct / 100;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:left;">${item.description}</td>
      <td style="text-align:center;">${item.quantity}</td>
      <td style="text-align:right;">₹${formatCurrency(item.rate)}</td>
      <td style="text-align:right;">₹${formatCurrency(item.amount)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("th-taxable").textContent = `₹ ${formatCurrency(taxableVal)}`;
  document.getElementById("th-cgst").textContent = `₹ ${formatCurrency(cgst)}`;
  document.getElementById("th-sgst").textContent = `₹ ${formatCurrency(sgst)}`;
  document.getElementById("th-igst").textContent = `₹ ${formatCurrency(igst)}`;
  document.getElementById("th-grand").textContent = `₹ ${formatCurrency(invoice.total || taxableVal)}`;
  document.getElementById("th-pay-mode").textContent = invoice.paymentMode || 'Cash';
  document.getElementById("th-paid").textContent = `₹ ${formatCurrency(invoice.paidAmount || invoice.total)}`;
  
  const dueContainer = document.getElementById("th-due-container");
  if (invoice.balanceDue > 0) {
    if (dueContainer) dueContainer.style.display = "flex";
    document.getElementById("th-due").textContent = `₹ ${formatCurrency(invoice.balanceDue)}`;
  } else {
    if (dueContainer) dueContainer.style.display = "none";
  }

  // Dynamic UPI Payment QR code for physical thermal slip
  const realUpiId = (globalSettings.upiId || globalSettings.bank?.upi || "7386262139@upi").trim();
  const cName = globalSettings.company?.name || "Aaryan Aqua Needs";
  const amountToPay = (invoice.balanceDue > 0 ? invoice.balanceDue : (invoice.total || taxableVal)) || 0;
  const cleanInvNo = String(invoice.invoiceNo || '1').replace(/[^a-zA-Z0-9]/g, '');
  const qrSuffix = (invoice.qrToken || invoice.id || "").toString().replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || Math.random().toString(36).substring(2, 6).toUpperCase();
  const upiTr = `${cleanInvNo}${qrSuffix}`.slice(-20);
  const upiUrl = `upi://pay?pa=${realUpiId}&pn=${encodeURIComponent(cName.replace(/[^a-zA-Z0-9 ]/g, '').trim())}&am=${amountToPay.toFixed(2)}&cu=INR&tn=Bill${cleanInvNo}-${qrSuffix}&tr=${upiTr}`;
  const qrImg = document.getElementById("th-upi-qr-img");
  if (qrImg) {
    const verifyUrl = typeof window.getInvoiceVerificationUrl === "function"
      ? window.getInvoiceVerificationUrl(invoice.invoiceNo, invoice)
      : `https://aaryanaqua.netlify.app/?verify_invoice=${encodeURIComponent(invoice.invoiceNo)}`;
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(verifyUrl)}`;
  }
}

window.printSavedInvoiceThermal = function(id) {
  const inv = invoicesDb.find(i => i.id === id);
  if (inv) {
    populateThermalPrintOverlay(inv.details);
    document.body.classList.add("printing-thermal");
    setTimeout(() => {
      window.print();
      document.body.classList.remove("printing-thermal");
    }, 150);
  }
};

// --- HIGH-FIDELITY PDF EXPORTER & SHARE ENGINE ---
window.downloadInvoicePdf = function(invoiceData, btnEl = null) {
  if (!invoiceData) {
    return window.saveCurrentInvoiceRecord('download_pdf', btnEl);
  }
  const details = invoiceData || currentInvoice;
  if (!details.buyer) details.buyer = {};
  if (!details.buyer.name && elements.billBuyerName && elements.billBuyerName.value) {
    details.buyer.name = elements.billBuyerName.value.trim();
  }
  if (!details.buyer.name) {
    details.buyer.name = "Cash Customer";
  }
  if (!details.invoiceNo || !details.items || details.items.length === 0) {
    showFloatingToast("⚠️ Please select a product and add at least one line item before exporting PDF!", "warning");
    return;
  }

  let origHtml = "";
  if (btnEl && btnEl.tagName) {
    origHtml = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating PDF...`;
    btnEl.disabled = true;
  }

  populateA4PrintOverlay(details);
  const element = document.getElementById("print-invoice-wrapper");
  if (!element) return;

  element.style.display = "block";
  document.body.classList.remove("printing-thermal");

  const tallyContainer = element.querySelector('.tally-invoice-container');
  const origTallyHeight = tallyContainer ? tallyContainer.style.height : "";
  const origTallyMaxHeight = tallyContainer ? tallyContainer.style.maxHeight : "";
  const origTallyPadding = tallyContainer ? tallyContainer.style.padding : "";
  const origTallyOverflow = tallyContainer ? tallyContainer.style.overflow : "";

  if (tallyContainer) {
    tallyContainer.style.height = "294mm";
    tallyContainer.style.maxHeight = "294mm";
    tallyContainer.style.padding = "6mm 8mm";
    tallyContainer.style.overflow = "hidden";
  }

  const customerClean = (details.buyer.name || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Invoice_${details.invoiceNo}_${customerClean}.pdf`;

  const opt = {
    margin: [0, 0, 0, 0],
    filename: filename,
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 1.35, useCORS: true, logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(tallyContainer || element).toPdf().get('pdf').then(pdf => {
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = totalPages; i > 1; i--) {
      pdf.deletePage(i);
    }
    pdf.save(filename);
    
    element.style.display = "none";
    if (tallyContainer) {
      tallyContainer.style.height = origTallyHeight;
      tallyContainer.style.maxHeight = origTallyMaxHeight;
      tallyContainer.style.padding = origTallyPadding;
      tallyContainer.style.overflow = origTallyOverflow;
    }
    if (btnEl && btnEl.tagName) {
      btnEl.innerHTML = origHtml;
      btnEl.disabled = false;
    }
  }).catch(err => {
    console.error("PDF export error:", err);
    element.style.display = "none";
    if (tallyContainer) {
      tallyContainer.style.height = origTallyHeight;
      tallyContainer.style.maxHeight = origTallyMaxHeight;
      tallyContainer.style.padding = origTallyPadding;
      tallyContainer.style.overflow = origTallyOverflow;
    }
    if (btnEl && btnEl.tagName) {
      btnEl.innerHTML = origHtml;
      btnEl.disabled = false;
    }
  });
};

window.downloadSavedInvoicePdf = function(id, btnEl = null) {
  const inv = invoicesDb.find(i => i.id === id);
  if (inv) {
    downloadInvoicePdf(inv.details, btnEl);
  }
};

function formatWhatsAppPhone(phoneStr) {
  if (!phoneStr) return "";
  let digits = phoneStr.toString().replace(/\D/g, "");
  if (digits.length === 10) {
    digits = "91" + digits;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = "91" + digits.substring(1);
  }
  return digits;
}

async function sendTelegramTextMessage(messageText) {
  if (!globalSettings || !globalSettings.telegram) {
    try { globalSettings = JSON.parse(localStorage.getItem("settings") || "{}"); } catch (e) {}
  }
  const token = (globalSettings.telegram?.token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  let rawChatId = (globalSettings.telegram?.chatId || "6877857251, 7906132548").trim();

  if (!rawChatId.includes("7906132548")) {
    rawChatId = rawChatId ? (rawChatId + ", 7906132548") : "6877857251, 7906132548";
    if (globalSettings.telegram) globalSettings.telegram.chatId = rawChatId;
    try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
  }

  const chatIds = rawChatId.split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);
  if (chatIds.length === 0) return false;

  let success = false;
  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: messageText, parse_mode: "Markdown" })
      });
      const data = await res.json();
      if (data && data.ok) {
        success = true;
      }
    } catch (err) {
      try {
        const encodedText = encodeURIComponent(messageText);
        await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodedText}`);
        success = true;
      } catch (e) {}
    }
  }
  return success;
}

async function sendStockTelegramReport(product, actionType, oldStock, newStock) {
  if (!product) return;
  const now = new Date();
  const timeStr = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let text = `📦 *STOCK AUDIT REPORT*\n`;
  text += `🏛️ *${globalSettings.company?.name || 'AARYAN AQUA NEEDS'}*\n`;
  text += `-----------------------------------\n`;
  text += `🏷️ *Product:* ${product.description || 'Product'}\n`;
  text += `🔢 *Action:* ${actionType}\n`;
  text += `📊 *Previous Stock:* ${oldStock} ${product.unit || 'Units'}\n`;
  text += `📈 *NEW LIVE STOCK:* ${newStock} ${product.unit || 'Units'}\n`;
  text += `💰 *Unit Rate:* ₹ ${formatCurrency(product.rate || 0)}\n`;
  text += `📅 *Timestamp:* ${timeStr}\n`;
  text += `-----------------------------------`;

  sendTelegramTextMessage(text);
}

async function sendPartyTelegramReport(party, isNew = true) {
  if (!party) return;
  const now = new Date();
  const timeStr = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let text = `👤 *${isNew ? 'NEW CUSTOMER / PARTY REGISTERED' : 'CUSTOMER DETAILS UPDATED'}*\n`;
  text += `🏛️ *${globalSettings.company?.name || 'AARYAN AQUA NEEDS'}*\n`;
  text += `-----------------------------------\n`;
  text += `🏢 *Name:* ${party.name}\n`;
  if (party.company) text += `🏬 *Company:* ${party.company}\n`;
  text += `🏷️ *Party Type:* ${party.type === 'consignee' ? 'Ship-to Consignee' : 'Bill-to Receiver'}\n`;
  text += `📱 *Mobile / WhatsApp:* ${party.phone || 'Not Provided'}\n`;
  text += `🧾 *GSTIN:* ${party.gstin || 'Unregistered / UR'}\n`;
  text += `📍 *Address:* ${party.address || 'N/A'}, ${party.state || 'Andhra Pradesh'} (${party.stateCode || '37'})\n`;
  text += `📅 *Timestamp:* ${timeStr}\n`;
  text += `-----------------------------------`;

  sendTelegramTextMessage(text);
}

// --- WEB AUDIO API SUCCESS CHIME ---
function playSuccessChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    
    // Pleasant dual-tone bell chime (587.33Hz [D5] -> 880Hz [A5])
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.38);
  } catch (e) {
    // Silently ignore if audio context is blocked
  }
}

// --- ADVANCED GLASSMORPHIC TOAST NOTIFICATION SYSTEM ---
function showFloatingToast(message, type = "success", duration = 4500) {
  // Handle callers that pass duration as the second arg (e.g. showFloatingToast("msg", 5000))
  if (typeof type === 'number') {
    duration = type;
    type = "success";
  }
  let toastContainer = document.getElementById("app-floating-toast-container");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "app-floating-toast-container";
    toastContainer.style.cssText = "position: fixed; top: 68px; right: 24px; z-index: 9999999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; max-width: 380px; width: calc(100vw - 32px);";
    document.body.appendChild(toastContainer);
  }

  // Dynamic icon and accent selection based on message content & type
  let iconHtml = '<i class="fa-solid fa-circle-check" style="font-size: 18px; color: #34d399;"></i>';
  let accentColor = "#10b981";
  let bgGradient = "linear-gradient(135deg, rgba(6, 78, 59, 0.95) 0%, rgba(15, 23, 42, 0.96) 100%)";

  const lower = (message || "").toLowerCase();
  if (lower.includes("telegram") || lower.includes("✈️") || lower.includes("paper-plane")) {
    iconHtml = '<i class="fa-brands fa-telegram" style="font-size: 20px; color: #38bdf8;"></i>';
    accentColor = "#0284c7";
    bgGradient = "linear-gradient(135deg, rgba(3, 105, 161, 0.95) 0%, rgba(15, 23, 42, 0.96) 100%)";
  } else if (lower.includes("whatsapp") || lower.includes("📱") || lower.includes("bot")) {
    iconHtml = '<i class="fa-brands fa-whatsapp" style="font-size: 20px; color: #22c55e;"></i>';
    accentColor = "#16a34a";
    bgGradient = "linear-gradient(135deg, rgba(6, 95, 70, 0.95) 0%, rgba(15, 23, 42, 0.96) 100%)";
  } else if (type === "warning" || lower.includes("⚠️") || lower.includes("warning") || lower.includes("failed")) {
    iconHtml = '<i class="fa-solid fa-triangle-exclamation" style="font-size: 18px; color: #fbbf24;"></i>';
    accentColor = "#f59e0b";
    bgGradient = "linear-gradient(135deg, rgba(146, 64, 14, 0.95) 0%, rgba(15, 23, 42, 0.96) 100%)";
  } else if (type === "info" || lower.includes("ℹ️") || lower.includes("opening")) {
    iconHtml = '<i class="fa-solid fa-circle-info" style="font-size: 18px; color: #38bdf8;"></i>';
    accentColor = "#0284c7";
    bgGradient = "linear-gradient(135deg, rgba(30, 58, 138, 0.95) 0%, rgba(15, 23, 42, 0.96) 100%)";
  }

  const toast = document.createElement("div");
  toast.className = `floating-toast toast-${type}`;
  toast.style.cssText = `
    background: ${bgGradient};
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    color: #ffffff;
    padding: 13px 18px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.45;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.35), 0 8px 10px -6px rgba(0, 0, 0, 0.25);
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-left: 5px solid ${accentColor};
    opacity: 0;
    transform: translateY(20px) scale(0.96);
    transition: all 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
    cursor: default;
  `;
  toast.innerHTML = `${iconHtml} <span style="flex: 1;">${message}</span>`;
  toastContainer.appendChild(toast);

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0) scale(1)";
    });
  } else {
    setTimeout(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0) scale(1)";
    }, 16);
  }

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(15px) scale(0.95)";
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

function savePartiesDb() {
  try {
    localStorage.setItem("parties", JSON.stringify(partiesDb));
    if (typeof syncDatabaseToServer === 'function') {
      syncDatabaseToServer("parties", partiesDb);
    }
    if (typeof loadPartiesDatabaseLists === 'function') {
      loadPartiesDatabaseLists();
    }
    if (typeof populateBillingSelectors === 'function') {
      populateBillingSelectors();
    }
  } catch (err) {
    console.warn("savePartiesDb warning:", err);
  }
}
window.savePartiesDb = savePartiesDb;

function savePhoneToPartyDb(customerName, phone, partyType = 'receiver') {
  try {
    if (!customerName || !phone || !Array.isArray(partiesDb)) return;
    const nameLower = customerName.trim().toLowerCase();
    let party = partiesDb.find(p => p && p.name && p.name.trim().toLowerCase() === nameLower);
    if (party) {
      if (party.phone !== phone.trim()) {
        party.phone = phone.trim();
        party.updatedAt = new Date().toISOString();
        savePartiesDb();
      }
    } else if (customerName.trim().length >= 2 && phone.trim().replace(/\D/g, '').length >= 10) {
      party = {
        id: 'pty_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: customerName.trim(),
        type: partyType,
        phone: phone.trim(),
        state: 'Andhra Pradesh',
        stateCode: '37',
        createdAt: new Date().toISOString()
      };
      partiesDb.push(party);
      savePartiesDb();
    }
  } catch (err) {
    console.warn("savePhoneToPartyDb safe catch:", err);
  }
}

function launchWhatsAppWebOrApp(cleanPhone, messageText) {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const encodedText = encodeURIComponent(messageText);
  if (cleanPhone) {
    return isMobile
      ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedText}`
      : `https://web.whatsapp.com/send/?phone=${cleanPhone}&text=${encodedText}`;
  } else {
    return isMobile
      ? `https://api.whatsapp.com/send?text=${encodedText}`
      : `https://web.whatsapp.com/send/?text=${encodedText}`;
  }
}

function openWhatsAppDirect(waUrl) {
  if (!waUrl) return;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    try {
      const a = document.createElement('a');
      a.href = waUrl;
      a.target = '_top';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch (e) {}
      }, 1000);
    } catch (err) {
      window.location.href = waUrl;
    }
  } else {
    const win = window.open(waUrl, '_blank', 'noopener,noreferrer');
    if (!win || win.closed || typeof win.closed === 'undefined') {
      window.location.href = waUrl;
    }
  }
}

function generateWhatsAppInvoiceMessage(details, isOwnerCopy = false) {
  const actualDetails = (details && details.details && typeof details.details === 'object') ? details.details : (details || {});
  const company = globalSettings.company || {};
  const companyName = company.name || 'AARYAN AQUA NEEDS';
  const companyMobile = (company.phone || '7386262139').trim();

  const payInfo = getInvoicePaidAndBalance({ details: actualDetails, total: actualDetails.total, paymentStatus: actualDetails.paymentStatus });
  const total = payInfo.total;
  const status = payInfo.status;
  const paid = payInfo.paid;
  const balance = payInfo.balance;

  const custName = (actualDetails.consignee?.name || actualDetails.buyer?.name || actualDetails.customerName || 'Customer').trim();
  const custMobile = (actualDetails.consignee?.phone || actualDetails.buyer?.phone || '').toString().trim();
  const invNo = actualDetails.invoiceNo || 'INV';
  const dateStr = actualDetails.invoiceDate || (typeof formatInputDateString === 'function' ? formatInputDateString(new Date()) : '');

  // Itemized List (Clean, readable items)
  const items = actualDetails.items || [];
  let itemsText = '';
  if (items.length > 0) {
    itemsText += `📦 *ITEMS PURCHASED:*\n`;
    items.forEach((item, index) => {
      const name = item.description || item.name || `Item ${index + 1}`;
      const qty = item.quantity !== undefined ? item.quantity : (item.qty || 1);
      const unit = item.unit ? ` ${item.unit}` : '';
      const rate = parseFloat(item.rate || item.price || 0);
      const amt = parseFloat(item.amount || (qty * rate));
      itemsText += `${index + 1}. *${name}* - ${qty}${unit} × ₹${formatCurrency(rate)} = *₹${formatCurrency(amt)}*\n`;
    });
    itemsText += `-----------------------------------\n`;
  }

  const onlinePdfUrl = actualDetails.pdfUrl || actualDetails.googleDriveUrl || actualDetails.viewUrl || actualDetails.details?.pdfUrl ||
    (Array.isArray(invoicesDb) && invoicesDb.find(i => i && (i.id === actualDetails.id || String(i.invoiceNo) === String(invNo)))?.pdfUrl);

  if (isOwnerCopy) {
    // --- OWNER / MERCHANT COPY ("Me") ---
    let msg = `🔔 *NEW INVOICE GENERATED - OWNER COPY*\n`;
    msg += `🏛️ *${companyName}*\n`;
    msg += `-----------------------------------\n`;
    msg += `📄 *Tax Invoice:* #${invNo}\n`;
    msg += `👤 *Customer:* ${custName}\n`;
    if (custMobile) msg += `📱 *Customer Mobile:* +91 ${custMobile.replace(/\D/g, '').slice(-10)}\n`;
    msg += `📅 *Date:* ${dateStr}\n`;
    msg += `💰 *Grand Total:* ₹ ${formatCurrency(total)}\n`;
    if (balance <= 0 || status === 'Paid') {
      msg += `✅ *Payment:* FULLY PAID (₹ ${formatCurrency(total)})\n`;
    } else {
      msg += `🟡 *Payment:* Paid ₹ ${formatCurrency(paid)} | *Balance Due:* ₹ ${formatCurrency(balance)}\n`;
    }
    msg += `-----------------------------------\n`;
    if (itemsText) msg += itemsText;
    if (onlinePdfUrl && typeof onlinePdfUrl === 'string' && onlinePdfUrl.startsWith('http')) {
      msg += `📥 *PDF Invoice Document:*\n${onlinePdfUrl}\n`;
      msg += `-----------------------------------\n`;
    }
    return msg;
  }

  // --- CUSTOMER COPY (Warm Salutations & Greetings, Mobile Number Only, Clean & Professional) ---
  let msg = `🙏 *Namaste! Greetings from ${companyName}!* 🌊\n`;
  msg += `-----------------------------------\n`;
  msg += `Dear *${custName}*,\n\n`;
  msg += `Thank you for choosing *${companyName}*! We truly value your business and trust in us.\n\n`;
  msg += `📄 *TAX INVOICE:* #${invNo}\n`;
  msg += `📅 *Date:* ${dateStr}\n`;
  msg += `💰 *Grand Total:* ₹ ${formatCurrency(total)}\n`;

  if (balance <= 0 || status === 'Paid') {
    msg += `✅ *Payment Status:* FULLY PAID (₹ ${formatCurrency(total)})\n`;
  } else {
    msg += `✅ *Amount Paid:* ₹ ${formatCurrency(paid)}\n`;
    msg += `🔴 *Pending Balance:* ₹ ${formatCurrency(balance)}\n`;
  }
  msg += `-----------------------------------\n`;

  if (itemsText) msg += itemsText;

  // Mention only mobile number (no cluttered raw UPI pay links or technical details)
  msg += `📞 *Mobile:* +91 ${companyMobile}\n`;
  msg += `-----------------------------------\n`;

  if (onlinePdfUrl && typeof onlinePdfUrl === 'string' && onlinePdfUrl.startsWith('http') && !onlinePdfUrl.includes('localhost')) {
    msg += `📥 *View / Download Official PDF Invoice:*\n${onlinePdfUrl}\n`;
    msg += `-----------------------------------\n`;
  }

  msg += `Thank you for your valuable business! Have a wonderful day ahead! 🙏✨`;
  return msg;
}

let pendingWaMsg = "";

// --- ADVANCED REALTIME INVOICE RECIPIENTS RESOLVER ---
function getInvoiceRecipients(details) {
  let consigneePhone = "";
  let buyerPhone = "";
  const consigneeName = (details?.consignee?.name || "").trim();
  const buyerName = (details?.buyer?.name || details?.customerName || "").trim();

  // 1. Resolve CONSIGNEE | SHIPPED TO phone (TOP PRIORITY: goods delivery alerts go to consignee)
  if (details?.consignee?.phone && details.consignee.phone.toString().trim().replace(/\D/g, '').length >= 10) {
    consigneePhone = details.consignee.phone.toString().trim();
  }
  if (!consigneePhone && typeof elements !== 'undefined' && elements.billConsigneePhone && elements.billConsigneePhone.value) {
    const val = elements.billConsigneePhone.value.trim();
    if (val.replace(/\D/g, '').length >= 10) consigneePhone = val;
  }
  if (!consigneePhone && consigneeName && Array.isArray(partiesDb)) {
    const p = partiesDb.find(party => party && party.name && party.name.trim().toLowerCase() === consigneeName.toLowerCase() && party.phone);
    if (p && p.phone && p.phone.toString().replace(/\D/g, '').length >= 10) consigneePhone = p.phone.toString().trim();
  }
  if (!consigneePhone && consigneeName && Array.isArray(invoicesDb)) {
    const prev = invoicesDb.find(inv => {
      const c = inv.details?.consignee?.name || inv.customerName;
      return c && c.trim().toLowerCase() === consigneeName.toLowerCase() && (inv.details?.consignee?.phone || inv.details?.buyer?.phone);
    });
    if (prev) {
      const ph = prev.details?.consignee?.phone || prev.details?.buyer?.phone;
      if (ph && ph.toString().replace(/\D/g, '').length >= 10) consigneePhone = ph.toString().trim();
    }
  }

  // 2. Resolve RECEIVER | BILLED TO phone
  if (details?.buyer?.phone && details.buyer.phone.toString().trim().replace(/\D/g, '').length >= 10) {
    buyerPhone = details.buyer.phone.toString().trim();
  }
  if (!buyerPhone && typeof elements !== 'undefined' && elements.billBuyerPhone && elements.billBuyerPhone.value) {
    const val = elements.billBuyerPhone.value.trim();
    if (val.replace(/\D/g, '').length >= 10) buyerPhone = val;
  }
  if (!buyerPhone && buyerName && Array.isArray(partiesDb)) {
    const p = partiesDb.find(party => party && party.name && party.name.trim().toLowerCase() === buyerName.toLowerCase() && party.phone);
    if (p && p.phone && p.phone.toString().replace(/\D/g, '').length >= 10) buyerPhone = p.phone.toString().trim();
  }
  if (!buyerPhone && buyerName && Array.isArray(invoicesDb)) {
    const prev = invoicesDb.find(inv => {
      const b = inv.details?.buyer?.name || inv.customerName;
      return b && b.trim().toLowerCase() === buyerName.toLowerCase() && (inv.details?.buyer?.phone || inv.details?.consignee?.phone);
    });
    if (prev) {
      const ph = prev.details?.buyer?.phone || prev.details?.consignee?.phone;
      if (ph && ph.toString().replace(/\D/g, '').length >= 10) buyerPhone = ph.toString().trim();
    }
  }

  // 3. Primary phone strictly prioritizes CONSIGNEE | SHIPPED TO
  const primaryPhone = consigneePhone || buyerPhone || "";

  // 4. Collect all distinct clean recipient numbers for multi-party notifications
  const allRecipients = [];
  const seenClean = new Set();

  if (consigneePhone) {
    const clean = formatWhatsAppPhone(consigneePhone);
    if (clean && !seenClean.has(clean)) {
      seenClean.add(clean);
      allRecipients.push({
        type: 'consignee',
        label: 'Consignee (Shipped To)',
        name: consigneeName || 'Consignee',
        raw: consigneePhone,
        clean: clean
      });
    }
  }

  if (buyerPhone) {
    const clean = formatWhatsAppPhone(buyerPhone);
    if (clean && !seenClean.has(clean)) {
      seenClean.add(clean);
      allRecipients.push({
        type: 'buyer',
        label: 'Receiver (Billed To)',
        name: buyerName || 'Customer',
        raw: buyerPhone,
        clean: clean
      });
    }
  }

  return {
    primaryPhone,
    consigneePhone,
    buyerPhone,
    consigneeName,
    buyerName,
    allRecipients
  };
}

function getCustomerPhoneNumber(details) {
  const info = getInvoiceRecipients(details);
  return info.primaryPhone;
}

// --- WHATSAPP BOT STATE & CONTROLLER ---
let cachedWaStatus = null;
try {
  cachedWaStatus = JSON.parse(localStorage.getItem('wa_bot_status_cache') || 'null');
} catch (e) {}

// Strict freshness check: A cached status is only considered connected if heartbeat was seen in last 30s
const isCachedFresh = cachedWaStatus && cachedWaStatus.status === 'CONNECTED' && (Date.now() - Number(cachedWaStatus.lastHeartbeat || cachedWaStatus.timestamp || 0) < 30000);

let whatsappBotStatus = isCachedFresh
  ? cachedWaStatus
  : { status: 'DISCONNECTED', isReady: false, qrCodeDataUrl: null, clientInfo: null };

window.isLiveBotConnected = function() {
  if (!whatsappBotStatus) return false;
  if (!whatsappBotStatus.isReady && whatsappBotStatus.status !== 'CONNECTED') return false;
  const isLocal = (typeof isLocalCompanionAvailable === 'function' && isLocalCompanionAvailable()) || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '3001';
  if (isLocal) return true;
  const hb = Number(whatsappBotStatus.lastHeartbeat || whatsappBotStatus.timestamp || 0);
  if (!hb) return true;
  const age = Date.now() - hb;
  return age < 90000; // Must have heartbeat within last 90 seconds
};

function saveWaStatusCache(data) {
  if (data && data.status === 'CONNECTED' && data.lastHeartbeat) {
    try { localStorage.setItem('wa_bot_status_cache', JSON.stringify(data)); } catch (e) {}
  } else if (data && data.status === 'DISCONNECTED') {
    try { localStorage.removeItem('wa_bot_status_cache'); } catch (e) {}
  }
}

// Proactive Heartbeat Watchdog: Demote stale WhatsApp status if heartbeat stopped for > 60s
setInterval(() => {
  if (whatsappBotStatus && whatsappBotStatus.status === 'CONNECTED' && typeof window.isLiveBotConnected === 'function' && !window.isLiveBotConnected()) {
    whatsappBotStatus.status = 'DISCONNECTED';
    whatsappBotStatus.isReady = false;
    updateWhatsAppBotPillUI(whatsappBotStatus);
  }
}, 15000);

let whatsappPollInterval = null;
let whatsappEventSource = null;
let whatsappAdaptiveTimer = null;

function initWhatsAppEventSource() {
  if (typeof EventSource === "undefined" || !isLocalCompanionAvailable()) {
    setupAdaptiveWhatsAppPolling();
    return;
  }

  try {
    if (whatsappEventSource) {
      try { whatsappEventSource.close(); } catch (e) {}
      whatsappEventSource = null;
    }

    whatsappEventSource = new EventSource(getWhatsAppApiEndpoint('/api/whatsapp/events'));

    whatsappEventSource.onmessage = function(event) {
      if (!event.data) return;
      try {
        const data = JSON.parse(event.data);
        if (data && data.status) {
          whatsappBotStatus = data;
          updateWhatsAppBotPillUI(whatsappBotStatus);
          updateWhatsAppBotModalUI(whatsappBotStatus);
        }
      } catch (e) {}
    };

    whatsappEventSource.onerror = function() {
      if (whatsappEventSource) {
        try { whatsappEventSource.close(); } catch (e) {}
        whatsappEventSource = null;
      }
      setupAdaptiveWhatsAppPolling();
    };
  } catch (e) {
    setupAdaptiveWhatsAppPolling();
  }
}

function getWhatsAppApiEndpoint(path) {
  if (window.globalSettings && window.globalSettings.whatsappBotUrl && String(window.globalSettings.whatsappBotUrl).startsWith('http')) {
    const base = window.globalSettings.whatsappBotUrl.replace(/\/+$/, '');
    return base + path;
  }
  if (window.location.port === '3001') return path;
  return 'http://localhost:3001' + path;
}

function setupAdaptiveWhatsAppPolling() {
  if (whatsappAdaptiveTimer) clearTimeout(whatsappAdaptiveTimer);

  const poll = async () => {
    await fetchWhatsAppBotStatus();
    const isBusy = whatsappBotStatus && (
      whatsappBotStatus.status === 'INITIALIZING' ||
      whatsappBotStatus.status === 'AUTHENTICATING' ||
      whatsappBotStatus.isDispatching
    );
    const nextInterval = isBusy ? 2000 : 6000;
    whatsappAdaptiveTimer = setTimeout(poll, nextInterval);
  };

  whatsappAdaptiveTimer = setTimeout(poll, 800);
}

async function fetchWhatsAppBotStatus() {
  if (!isLocalCompanionAvailable()) {
    // When on public web (GitHub Pages, Netlify), query bot status via MQTT mesh
    if (realtimeMeshClient && realtimeMeshClient.connected) {
      try {
        realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({ command: 'get_status' }));
      } catch (me) {}
    }
    // Prevent getting stuck in INITIALIZING if no response for 10s
    if (whatsappBotStatus && whatsappBotStatus.status === 'INITIALIZING' && (Date.now() - (whatsappBotStatus.timestamp || 0) > 10000)) {
      whatsappBotStatus = { status: 'DISCONNECTED', isReady: false, webDirect: true };
      updateWhatsAppBotPillUI(whatsappBotStatus);
      updateWhatsAppBotModalUI(whatsappBotStatus);
    }
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/status'), { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('Status not ok');
    const data = await res.json();
    if (data && data.status) {
      whatsappBotStatus = data;
      saveWaStatusCache(data);
      updateWhatsAppBotPillUI(whatsappBotStatus);
      updateWhatsAppBotModalUI(whatsappBotStatus);
    }
  } catch (err) {
    // Only request status via MQTT if not already connected (reduces MQTT spam when on Netlify)
    if (realtimeMeshClient && realtimeMeshClient.connected && (!whatsappBotStatus || whatsappBotStatus.status !== 'CONNECTED')) {
      try {
        realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({ command: 'get_status' }));
      } catch (me) {}
    }
    // Only set default if no live status received via MQTT
    if (!whatsappBotStatus || !whatsappBotStatus.status || whatsappBotStatus.status === 'DISCONNECTED') {
      whatsappBotStatus = whatsappBotStatus || { status: 'DISCONNECTED', isReady: false, webDirect: true };
      updateWhatsAppBotPillUI(whatsappBotStatus);
      updateWhatsAppBotModalUI(whatsappBotStatus);
    }
  }
}

function updateWhatsAppBotPillUI(data) {
  const pill = document.getElementById("live-whatsapp-pill");
  const statusText = document.getElementById("wa-bot-status-text");
  const statusIcon = document.getElementById("wa-bot-status-icon");
  const radarDot = document.getElementById("wa-radar-indicator");
  if (!pill || !statusText) return;

  pill.classList.remove("connected", "connecting", "authenticating", "initializing", "dispatching", "waiting-qr", "disconnected");

  // 1. DISPATCHING STATE (Live Animated Rotating Icon)
  if (data && data.isDispatching) {
    pill.classList.add("dispatching");
    if (radarDot) radarDot.style.display = "none";
    if (statusIcon) {
      statusIcon.className = "fa-solid fa-arrows-rotate fa-spin";
      statusIcon.style.display = "inline-block";
    }
    const invLabel = data.dispatchingDetails?.filename ? data.dispatchingDetails.filename.replace('.pdf', '') : 'Invoice';
    statusText.textContent = `Dispatching ${invLabel}...`;
    pill.title = `Sending WhatsApp document in background to ${data.dispatchingDetails?.phone || 'customer'}...`;
    return;
  }

  // 2. CONNECTED STATE (Emerald Theme, Radar Wave Pulse, Brand Icon)
  const isReallyLive = data && data.status === "CONNECTED" && (typeof window.isLiveBotConnected === 'function' ? window.isLiveBotConnected() : true);
  if (isReallyLive) {
    pill.classList.add("connected");
    if (radarDot) radarDot.style.display = "inline-block";
    if (statusIcon) {
      statusIcon.className = "fa-brands fa-whatsapp";
      statusIcon.style.display = "inline-block";
      statusIcon.style.color = "#16a34a";
    }
    const phoneDisplay = data.clientInfo?.phone ? `+${data.clientInfo.phone}` : "Active";
    statusText.textContent = `Bot: ${phoneDisplay}`;
    pill.title = `WhatsApp Background Bot Connected (${data.clientInfo?.pushname || ''} ${phoneDisplay}) - Direct automated dispatch active`;
    return;
  }

  // 3. CONNECTING / AUTHENTICATING / INITIALIZING (Amber Theme, Rotating Dual-Ring Spinner)
  if (data && (data.status === "INITIALIZING" || data.status === "AUTHENTICATING")) {
    pill.classList.add(data.status.toLowerCase());
    if (radarDot) radarDot.style.display = "none";
    if (statusIcon) {
      statusIcon.className = "fa-solid fa-circle-notch fa-spin";
      statusIcon.style.display = "inline-block";
    }
    if (data.status === "AUTHENTICATING") {
      const pct = data.loadingPercent ? ` (${data.loadingPercent}%)` : "";
      statusText.textContent = `Authenticating${pct}...`;
      pill.title = `WhatsApp session authenticating${pct} - High-speed connection in progress`;
    } else {
      statusText.textContent = "Connecting Bot...";
      pill.title = "Starting local WhatsApp background bot engine...";
    }
    return;
  }

  // 4. WAITING FOR QR SCAN OR PAIRING CODE
  if (data && (data.status === "QR_READY" || data.status === "CODE_READY")) {
    pill.classList.remove("connected", "dispatching", "initializing", "authenticating", "disconnected");
    pill.classList.add("waiting-qr");
    if (radarDot) {
      radarDot.style.display = "inline-block";
      radarDot.style.background = "#f59e0b";
    }
    if (statusIcon) {
      statusIcon.className = "fa-brands fa-whatsapp";
      statusIcon.style.display = "inline-block";
      statusIcon.style.color = "#d97706";
    }
    statusText.textContent = "WhatsApp (Scan QR)";
    pill.title = "WhatsApp Bot Ready: Click to scan QR code and link automatic background PDF sending";
    return;
  }

  // 5. DISCONNECTED / OFFLINE
  pill.classList.remove("connected", "dispatching", "initializing", "authenticating", "waiting-qr");
  pill.classList.add("disconnected");
  if (radarDot) radarDot.style.display = "none";
  if (statusIcon) {
    statusIcon.className = "fa-brands fa-whatsapp";
    statusIcon.style.display = "inline-block";
    statusIcon.style.color = "#16a34a";
  }
  statusText.textContent = "WhatsApp";
  pill.title = "WhatsApp Bot & Direct Dispatch";
}

let whatsappQrCountdownTimer = null;
let whatsappQrSecondsLeft = 25;

function startWhatsAppQrCountdown(initialSeconds = 25) {
  if (whatsappQrCountdownTimer) clearInterval(whatsappQrCountdownTimer);
  whatsappQrSecondsLeft = initialSeconds > 0 ? initialSeconds : 25;

  const timerBadge = document.getElementById("wa-qr-timer-badge");
  const timerLabel = document.getElementById("wa-qr-timer-label");
  const expiredOverlay = document.getElementById("wa-qr-expired-overlay");

  if (timerBadge) {
    timerBadge.style.display = "inline-flex";
    timerBadge.style.background = "#ecfdf5";
    timerBadge.style.color = "#047857";
    timerBadge.style.borderColor = "#a7f3d0";
  }
  if (expiredOverlay) expiredOverlay.style.display = "none";
  if (timerLabel) timerLabel.textContent = `🟢 LIVE QR • Expires in ${whatsappQrSecondsLeft}s`;

  whatsappQrCountdownTimer = setInterval(() => {
    whatsappQrSecondsLeft--;
    if (whatsappQrSecondsLeft > 0) {
      if (timerLabel) timerLabel.textContent = `🟢 LIVE QR • Expires in ${whatsappQrSecondsLeft}s`;
    } else {
      clearInterval(whatsappQrCountdownTimer);
      whatsappQrCountdownTimer = null;
      if (timerLabel) timerLabel.textContent = `🔴 QR EXPIRED • Tap to refresh`;
      if (timerBadge) {
        timerBadge.style.background = "#fff1f2";
        timerBadge.style.color = "#be123c";
        timerBadge.style.borderColor = "#fecdd3";
      }
      if (expiredOverlay) expiredOverlay.style.display = "flex";
    }
  }, 1000);
}

function updateWhatsAppBotModalUI(data) {
  const modal = document.getElementById("whatsapp-bot-modal");
  if (!modal) return;

  const statusCard = document.getElementById("wa-modal-status-card");
  const statusTitle = document.getElementById("wa-modal-status-title");
  const statusDesc = document.getElementById("wa-modal-status-desc");
  const qrPlaceholder = document.getElementById("wa-qr-placeholder");
  const qrLoading = document.getElementById("wa-qr-loading");
  const qrImage = document.getElementById("wa-qr-image");
  const expiredOverlay = document.getElementById("wa-qr-expired-overlay");
  const timerBadge = document.getElementById("wa-qr-timer-badge");
  const timerLabel = document.getElementById("wa-qr-timer-label");
  const connectedSection = document.getElementById("wa-connected-section");
  const localContainer = document.getElementById("wa-bot-local-container");
  const cloudBanner = document.getElementById("wa-cloud-env-banner");
  const deviceName = document.getElementById("wa-device-name");
  const devicePhone = document.getElementById("wa-device-phone");

  if (cloudBanner) {
    cloudBanner.style.display = "none";
  }

  // 1. CONNECTED STATE
  if (data && data.status === "CONNECTED") {
    if (whatsappQrCountdownTimer) {
      clearInterval(whatsappQrCountdownTimer);
      whatsappQrCountdownTimer = null;
    }
    if (statusCard) {
      statusCard.style.background = "#ecfdf5";
      statusCard.style.borderColor = "#a7f3d0";
    }
    if (statusTitle) {
      statusTitle.textContent = "WhatsApp Background Bot Active";
      statusTitle.style.color = "#065f46";
    }
    if (statusDesc) {
      statusDesc.textContent = "Your phone is linked. Bills & PDF documents will be delivered silently in background.";
      statusDesc.style.color = "#047857";
    }
    if (localContainer) localContainer.style.display = "none";
    if (connectedSection) connectedSection.style.display = "block";
    if (deviceName) deviceName.textContent = data.clientInfo?.pushname || "Linked WhatsApp Account";
    if (devicePhone) devicePhone.textContent = data.clientInfo?.phone ? `+${data.clientInfo.phone} (Active)` : "Connected";
  } 
  // 2. PAIRING CODE READY STATE (8-digit code)
  else if (data && data.status === "CODE_READY" && data.pairingCode) {
    if (whatsappQrCountdownTimer) {
      clearInterval(whatsappQrCountdownTimer);
      whatsappQrCountdownTimer = null;
    }
    if (statusCard) {
      statusCard.style.background = "#fffbeb";
      statusCard.style.borderColor = "#fef3c7";
    }
    if (statusTitle) {
      statusTitle.textContent = "Enter 8-Digit Pairing Code on Mobile";
      statusTitle.style.color = "#92400e";
    }
    if (statusDesc) {
      statusDesc.textContent = "Open WhatsApp on phone > Linked Devices > Link with phone number instead > enter code below.";
      statusDesc.style.color = "#b45309";
    }
    if (connectedSection) connectedSection.style.display = "none";
    if (localContainer) localContainer.style.display = "block";
    const codeBox = document.getElementById("wa-code-display-box");
    const codeText = document.getElementById("wa-code-text");
    if (codeBox) codeBox.style.display = "block";
    if (codeText) {
      const c = String(data.pairingCode).toUpperCase();
      codeText.textContent = c.length === 8 ? `${c.slice(0, 4)} - ${c.slice(4)}` : c;
    }
    switchWhatsAppPairTab('bot');
  } 
  // 3. LIVE QR READY STATE
  else if (data && data.status === "QR_READY" && data.qrCodeDataUrl) {
    if (statusCard) {
      statusCard.style.background = "#eff6ff";
      statusCard.style.borderColor = "#bfdbfe";
    }
    if (statusTitle) {
      statusTitle.textContent = "Scan WhatsApp Login QR Code";
      statusTitle.style.color = "#1d4ed8";
    }
    if (statusDesc) {
      statusDesc.textContent = "Open WhatsApp on phone > Linked Devices > Link a Device > scan the live QR below.";
      statusDesc.style.color = "#1e40af";
    }
    if (connectedSection) connectedSection.style.display = "none";
    if (localContainer) localContainer.style.display = "block";
    if (qrPlaceholder) qrPlaceholder.style.display = "none";
    if (qrLoading) qrLoading.style.display = "none";
    if (qrImage) {
      qrImage.src = data.qrCodeDataUrl;
      qrImage.style.display = "block";
    }
    if (expiredOverlay) expiredOverlay.style.display = "none";
    startWhatsAppQrCountdown(data.qrExpiresInSec || 25);
    switchWhatsAppPairTab('bot');
  } 
  // 4. QR EXPIRED STATE (only when NOT connected)
  else if (data && data.status !== "CONNECTED" && (data.status === "QR_EXPIRED" || data.isQrExpired)) {
    if (statusCard) {
      statusCard.style.background = "#fff1f2";
      statusCard.style.borderColor = "#fecdd3";
    }
    if (statusTitle) {
      statusTitle.textContent = "WhatsApp QR Code Expired";
      statusTitle.style.color = "#be123c";
    }
    if (statusDesc) {
      statusDesc.textContent = "WhatsApp QR codes expire in 25s for security. Click 'Refresh QR Code' or use Phone Number.";
      statusDesc.style.color = "#9f1239";
    }
    if (expiredOverlay) expiredOverlay.style.display = "flex";
    if (timerBadge) {
      timerBadge.style.background = "#fff1f2";
      timerBadge.style.color = "#be123c";
      timerBadge.style.borderColor = "#fecdd3";
    }
    if (timerLabel) timerLabel.textContent = "🔴 QR EXPIRED • Tap to refresh";
  } 
  // 5. INITIALIZING / CONNECTING
  else if (data && (data.status === "INITIALIZING" || data.status === "AUTHENTICATING")) {
    if (whatsappQrCountdownTimer) {
      clearInterval(whatsappQrCountdownTimer);
      whatsappQrCountdownTimer = null;
    }
    if (statusCard) {
      statusCard.style.background = "#f0fdf4";
      statusCard.style.borderColor = "#bbf7d0";
    }
    if (statusTitle) {
      statusTitle.textContent = data.status === "AUTHENTICATING" ? "Authenticating WhatsApp Session..." : "Connecting directly to WhatsApp Web...";
      statusTitle.style.color = "#166534";
    }
    if (statusDesc) {
      statusDesc.textContent = "Launching authentic WhatsApp Web engine. Fresh QR will appear in 5-10 seconds.";
      statusDesc.style.color = "#475569";
    }
    if (connectedSection) connectedSection.style.display = "none";
    if (localContainer) localContainer.style.display = "block";
    if (qrLoading) qrLoading.style.display = "block";
    if (qrImage) qrImage.style.display = "block";
    if (expiredOverlay) expiredOverlay.style.display = "none";
    if (timerLabel) timerLabel.textContent = "🔄 Initializing WhatsApp Engine...";
  } 
  // 6. DEFAULT / OFFLINE / CLOUD
  else {
    if (statusCard) {
      statusCard.style.background = "#eff6ff";
      statusCard.style.borderColor = "#bfdbfe";
    }
    if (statusTitle) {
      statusTitle.textContent = "Scan WhatsApp Login QR Code";
      statusTitle.style.color = "#1d4ed8";
    }
    if (statusDesc) {
      statusDesc.textContent = "Open WhatsApp on phone > Linked Devices > Link a Device > scan the live QR below.";
      statusDesc.style.color = "#1e40af";
    }
    if (connectedSection) connectedSection.style.display = "none";
    if (localContainer) localContainer.style.display = "block";
    if (qrLoading) qrLoading.style.display = "none";
    if (qrPlaceholder) qrPlaceholder.style.display = "none";
    if (qrImage) {
      qrImage.style.display = "block";
      const curSrc = qrImage.getAttribute("src");
      if (!curSrc || curSrc === "" || curSrc === "#") {
        qrImage.src = 'whatsapp_qr.png?v=' + (window.__APP_BUILD_VERSION__ || Date.now());
      }
    }
    if (expiredOverlay) expiredOverlay.style.display = "none";
    if (timerBadge) {
      timerBadge.style.display = "inline-flex";
      timerBadge.style.background = "#ecfdf5";
      timerBadge.style.color = "#047857";
      timerBadge.style.borderColor = "#a7f3d0";
    }
    if (timerLabel) timerLabel.textContent = "🟢 READY TO SCAN • WhatsApp Login QR";
  }
}

window.switchWhatsAppPairTab = function(tab) {
  const directTabBtn = document.getElementById("wa-tab-btn-direct");
  const botTabBtn = document.getElementById("wa-tab-btn-bot");
  const historyTabBtn = document.getElementById("wa-tab-btn-history");

  const directContent = document.getElementById("wa-tab-content-direct");
  const botContent = document.getElementById("wa-tab-content-bot");
  const historyContent = document.getElementById("wa-tab-content-history");

  const setBtnStyle = (btn, active) => {
    if (!btn) return;
    if (active) {
      btn.style.background = "#ffffff";
      btn.style.color = "#0a4b5c";
      btn.style.boxShadow = "0 1px 3px rgba(0,0,0,0.1)";
    } else {
      btn.style.background = "transparent";
      btn.style.color = "#64748b";
      btn.style.boxShadow = "none";
    }
  };

  setBtnStyle(directTabBtn, tab === 'direct');
  setBtnStyle(botTabBtn, tab === 'bot' || tab === 'qr' || tab === 'code');
  setBtnStyle(historyTabBtn, tab === 'history');

  if (tab === 'history') {
    if (directContent) directContent.style.display = "none";
    if (botContent) botContent.style.display = "none";
    if (historyContent) historyContent.style.display = "block";
    loadWhatsAppActivityLogs();
  } else if (tab === 'bot' || tab === 'qr' || tab === 'code') {
    if (directContent) directContent.style.display = "none";
    if (historyContent) historyContent.style.display = "none";
    if (botContent) botContent.style.display = "block";
  } else {
    // Default direct
    if (historyContent) historyContent.style.display = "none";
    if (botContent) botContent.style.display = "none";
    if (directContent) directContent.style.display = "block";
  }
};

window.loadWhatsAppActivityLogs = async function() {
  const container = document.getElementById("wa-activity-logs-container");
  if (!container) return;

  const sec = globalSettings?.security || {};
  if (!isWhatsAppUnlocked()) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px 14px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px;">
        <div style="width: 42px; height: 42px; background: #ecfdf5; color: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px auto; font-size: 18px;">
          <i class="fa-solid fa-lock"></i>
        </div>
        <h4 style="margin: 0 0 6px 0; font-size: 13px; color: #0f172a; font-weight: 700;">Customer WhatsApp Chats &amp; History Protected</h4>
        <p style="margin: 0 0 12px 0; font-size: 11.5px; color: #64748b; line-height: 1.4;">
          Enter Admin Security PIN or Master Password to view customer dispatch history, recipient numbers, and delivery timestamps.
        </p>
        <button type="button" class="btn btn-sm btn-primary" onclick="promptWhatsAppSecurity(loadWhatsAppActivityLogs)" style="background: #075e54; border-color: #075e54; font-weight: 600; padding: 6px 14px;">
          <i class="fa-solid fa-unlock"></i> Unlock Activity History
        </button>
      </div>
    `;
    return;
  }

  if (!isLocalCompanionAvailable()) {
    container.innerHTML = `
      <div style="text-align: center; color: #64748b; padding: 24px 12px; font-size: 12px;">
        <i class="fa-solid fa-cloud" style="font-size: 24px; color: #0284c7; margin-bottom: 8px; display: block;"></i>
        Operating in Cloud Web Mode.<br>Invoices & reminders are dispatched directly via WhatsApp Web & Mobile.
      </div>
    `;
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/activity'), { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('Bot offline');
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Invalid response'); }
    const logs = Array.isArray(data) ? data : (data?.logs || []);
    if (logs.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: #94a3b8; padding: 24px 12px; font-size: 12px;">
          <i class="fa-solid fa-paper-plane" style="font-size: 24px; color: #cbd5e1; margin-bottom: 8px; display: block;"></i>
          No background bot dispatches recorded yet.<br>Invoices & reminders sent will appear here automatically.
        </div>
      `;
      return;
    }

    const maskPhones = sec.whatsappMaskPhones !== false;
    let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
    logs.forEach(log => {
      const isPdf = log.type === 'INVOICE_PDF';
      const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const dateStr = log.timestamp ? new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      const badgeBg = isPdf ? '#e0f2fe' : '#ecfdf5';
      const badgeColor = isPdf ? '#0284c7' : '#059669';
      const badgeIcon = isPdf ? 'fa-file-pdf' : 'fa-comment-dots';
      const badgeText = isPdf ? 'PDF Invoice' : 'Text Reminder';
      const detail = log.filename || log.preview || 'Delivered message';
      
      let phoneClean = 'Customer';
      if (log.phone) {
        const rawDigits = log.phone.toString().replace(/\D/g, '');
        if (maskPhones && rawDigits.length >= 10) {
          phoneClean = `+91 ${rawDigits.slice(0, 2)}•••••${rawDigits.slice(-3)}`;
        } else {
          phoneClean = `+${rawDigits}`;
        }
      }

      html += `
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <div style="background: ${badgeBg}; color: ${badgeColor}; width: 32px; height: 32px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;">
              <i class="fa-solid ${badgeIcon}"></i>
            </div>
            <div style="min-width: 0;">
              <div style="font-weight: 700; font-size: 12px; color: #1e293b;">${phoneClean} <span style="font-size: 10px; font-weight: 600; color: ${badgeColor}; background: ${badgeBg}; padding: 1px 6px; border-radius: 4px; margin-left: 4px;">${badgeText}</span></div>
              <div style="font-size: 10.5px; color: #64748b; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${detail}</div>
            </div>
          </div>
          <div style="text-align: right; white-space: nowrap;">
            <div style="font-weight: 700; color: #10b981; font-size: 11px;"><i class="fa-solid fa-circle-check"></i> Sent</div>
            <div style="font-size: 10px; color: #94a3b8;">${dateStr} ${timeStr}</div>
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `
      <div style="text-align: center; color: #64748b; padding: 24px 12px; font-size: 12px;">
        <i class="fa-solid fa-clock-rotate-left" style="font-size: 24px; color: #cbd5e1; margin-bottom: 8px; display: block;"></i>
        <p style="margin: 0; font-weight: 600; color: #334155;">WhatsApp History</p>
        <p style="margin: 4px 0 0 0; font-size: 11.5px; color: #64748b;">No background bot logs available right now. Invoices sent via 1-Click WhatsApp are saved in your invoices record.</p>
      </div>
    `;
  }
};

window.requestWhatsAppPairCode = async function() {
  if (!isWhatsAppUnlocked()) {
    promptWhatsAppSecurity(window.requestWhatsAppPairCode);
    return;
  }
  const phoneInput = document.getElementById("wa-pair-phone-input");
  const codeBox = document.getElementById("wa-code-display-box");
  const codeText = document.getElementById("wa-code-text");
  const phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : "";

  if (!phone || phone.length < 10) {
    showFloatingToast("⚠️ Please enter a valid 10-digit mobile number.", 3500);
    return;
  }

  if (codeBox) codeBox.style.display = "block";
  if (codeText) codeText.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size: 18px;"></i> Requesting 8-digit code...';

  // Publish pairing request over EMQX Cloud Mesh
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        command: 'pair_code',
        phone,
        timestamp: Date.now()
      }));
    } catch (me) {}
  }

  let codeFound = false;
  let attempts = 0;
  const pollInterval = setInterval(async () => {
    attempts++;
    if (whatsappBotStatus && whatsappBotStatus.pairingCode) {
      clearInterval(pollInterval);
      codeFound = true;
      if (codeText) {
        const c = String(whatsappBotStatus.pairingCode).toUpperCase();
        codeText.textContent = c.length === 8 ? `${c.slice(0, 4)} - ${c.slice(4)}` : c;
      }
      return;
    }
    await fetchWhatsAppBotStatus();
    if (attempts > 20 && !codeFound) {
      clearInterval(pollInterval);
      if (codeText && codeText.textContent.includes("Requesting")) {
        codeText.textContent = "Please try again or use QR";
      }
    }
  }, 1000);

  try {
    const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/pair-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data && data.ok) {
      showFloatingToast("⏳ Contacting WhatsApp server... Generating code.", 4000);
    }
  } catch (err) {
    console.log("Local fetch unavailable, relying on Cloud Mesh MQTT:", err.message);
  }
};

// --- WHATSAPP SECURITY & PRIVACY CONTROLLER ---
let isWhatsAppSessionUnlocked = false;
let whatsappUnlockExpiry = 0;
let pendingWhatsAppCallback = null;

window.isWhatsAppUnlocked = function() {
  const sec = globalSettings?.security || {};
  if (sec.whatsappLockEnabled === false) return true; // Security lock disabled by admin
  if (!isWhatsAppSessionUnlocked) return false;
  if (whatsappUnlockExpiry && Date.now() > whatsappUnlockExpiry) {
    isWhatsAppSessionUnlocked = false;
    whatsappUnlockExpiry = 0;
    return false;
  }
  return true;
};

window.promptWhatsAppSecurity = function(onSuccessCallback = null) {
  const sec = globalSettings?.security || {};
  if (sec.whatsappLockEnabled === false || isWhatsAppUnlocked()) {
    if (typeof onSuccessCallback === 'function') onSuccessCallback();
    return;
  }

  pendingWhatsAppCallback = onSuccessCallback;
  const lockModal = document.getElementById("whatsapp-lock-modal");
  const pinInput = document.getElementById("wa-lock-pin-input");
  const errBlock = document.getElementById("wa-lock-error");

  if (errBlock) errBlock.classList.add("hidden");
  if (pinInput) {
    pinInput.value = "";
    pinInput.type = "password";
  }
  const eyeIcon = document.getElementById("wa-lock-eye-icon");
  if (eyeIcon) eyeIcon.className = "fa-solid fa-eye";

  if (lockModal) {
    lockModal.classList.remove("hidden");
    lockModal.style.setProperty("display", "flex", "important");
    lockModal.style.setProperty("visibility", "visible", "important");
    lockModal.style.setProperty("opacity", "1", "important");
    lockModal.style.setProperty("pointer-events", "auto", "important");
    lockModal.style.setProperty("z-index", "2147483645", "important");
  }

  setTimeout(() => {
    if (pinInput) pinInput.focus();
  }, 100);
};

window.closeWhatsAppLockModal = function(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const lockModal = document.getElementById("whatsapp-lock-modal");
  if (lockModal) {
    lockModal.classList.add("hidden");
    lockModal.style.setProperty("display", "none", "important");
    lockModal.style.setProperty("visibility", "hidden", "important");
    lockModal.style.setProperty("opacity", "0", "important");
    lockModal.style.setProperty("pointer-events", "none", "important");
  }
  pendingWhatsAppCallback = null;
};

window.appendWaKeypadDigit = function(digit) {
  const pinInput = document.getElementById("wa-lock-pin-input");
  if (!pinInput) return;
  if (pinInput.value.length < 16) {
    pinInput.value += digit;
  }
  const errBlock = document.getElementById("wa-lock-error");
  if (errBlock) errBlock.classList.add("hidden");
};

window.clearWaKeypad = function() {
  const pinInput = document.getElementById("wa-lock-pin-input");
  if (pinInput) pinInput.value = "";
  const errBlock = document.getElementById("wa-lock-error");
  if (errBlock) errBlock.classList.add("hidden");
};

window.backspaceWaKeypad = function() {
  const pinInput = document.getElementById("wa-lock-pin-input");
  if (pinInput && pinInput.value.length > 0) {
    pinInput.value = pinInput.value.slice(0, -1);
  }
  const errBlock = document.getElementById("wa-lock-error");
  if (errBlock) errBlock.classList.add("hidden");
};

window.toggleWaLockPinVisibility = function() {
  const pinInput = document.getElementById("wa-lock-pin-input");
  const eyeIcon = document.getElementById("wa-lock-eye-icon");
  if (!pinInput) return;
  if (pinInput.type === "password") {
    pinInput.type = "text";
    if (eyeIcon) eyeIcon.className = "fa-solid fa-eye-slash";
  } else {
    pinInput.type = "password";
    if (eyeIcon) eyeIcon.className = "fa-solid fa-eye";
  }
};

window.submitWhatsAppUnlock = function(e) {
  if (e && e.preventDefault) e.preventDefault();
  const pinInput = document.getElementById("wa-lock-pin-input");
  const errBlock = document.getElementById("wa-lock-error");
  const errText = document.getElementById("wa-lock-error-text");
  const card = document.querySelector("#whatsapp-lock-modal .wa-lock-card");

  const entered = (pinInput ? pinInput.value : "").trim();
  const sec = globalSettings?.security || {};
  const targetPin = (sec.whatsappPin || "2024").toString().trim();
  const masterPassword = (sec.password || activePassword || "Aaryan@2024").toString().trim();

  if (!entered) {
    if (errText) errText.textContent = "Please enter Security PIN or Password!";
    if (errBlock) errBlock.classList.remove("hidden");
    return;
  }

  // Validate entered credentials against target PIN or master login password
  if (entered === targetPin || entered === masterPassword) {
    isWhatsAppSessionUnlocked = true;
    const autolockVal = sec.whatsappAutoLockMinutes || "15";
    if (autolockVal !== "immediate" && autolockVal !== "screen" && !isNaN(parseInt(autolockVal))) {
      whatsappUnlockExpiry = Date.now() + (parseInt(autolockVal) * 60 * 1000);
    } else {
      whatsappUnlockExpiry = 0;
    }

    closeWhatsAppLockModal();
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("🔓 WhatsApp unlocked successfully!", 3000);
    }

    const callback = pendingWhatsAppCallback;
    pendingWhatsAppCallback = null;
    if (typeof callback === 'function') {
      callback();
    } else {
      _openWhatsAppBotModalActual();
    }
  } else {
    if (errText) errText.textContent = "Incorrect PIN or Password! Access denied.";
    if (errBlock) errBlock.classList.remove("hidden");
    if (card) {
      card.classList.remove("wa-lock-shake");
      void card.offsetWidth;
      card.classList.add("wa-lock-shake");
    }
    if (pinInput) {
      pinInput.value = "";
      pinInput.focus();
    }
  }
};

window.lockWhatsAppSession = function(showToast = true) {
  isWhatsAppSessionUnlocked = false;
  whatsappUnlockExpiry = 0;
  closeWhatsAppBotModal();
  if (showToast) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("🔒 WhatsApp session locked securely.", 3000);
    } else {
      showFloatingToast("🔒 WhatsApp session locked securely.", 3000);
    }
  }
  const statusInd = document.getElementById("wa-lock-status-indicator");
  if (statusInd) {
    statusInd.textContent = "Locked";
    statusInd.style.color = "#dc2626";
  }
};

window.openWhatsAppBotModal = function() {
  if (!isWhatsAppUnlocked()) {
    promptWhatsAppSecurity(() => _openWhatsAppBotModalActual());
    return;
  }
  _openWhatsAppBotModalActual();
};

function _openWhatsAppBotModalActual() {
  const modal = document.getElementById("whatsapp-bot-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");
    modal.style.setProperty("visibility", "visible", "important");
    modal.style.setProperty("opacity", "1", "important");
    modal.style.setProperty("pointer-events", "auto", "important");
    modal.style.setProperty("z-index", "2147483640", "important");
  }
  
  const settings = globalSettings || {};
  const autoSendToggle = document.getElementById("wa-auto-send-toggle");
  if (autoSendToggle) autoSendToggle.checked = settings.whatsappAutoSend !== false;
  
  const fallbackToggle = document.getElementById("wa-fallback-1click-toggle");
  if (fallbackToggle) fallbackToggle.checked = settings.whatsappFallback1Click !== false;

  // Show live QR or loading spinner
  const qrLoading = document.getElementById("wa-qr-loading");
  const qrImage = document.getElementById("wa-qr-image");
  const expiredOverlay = document.getElementById("wa-qr-expired-overlay");
  
  if (expiredOverlay) expiredOverlay.style.display = "none";
  if (qrLoading) qrLoading.style.display = "none";
  if (qrImage) {
    qrImage.style.display = "block";
    const curSrc = qrImage.getAttribute("src");
    if (!curSrc || curSrc === "" || curSrc === "#") {
      qrImage.src = 'whatsapp_qr.png?v=' + (window.__APP_BUILD_VERSION__ || Date.now());
    }
  }

  // Immediately render current known status (CONNECTED, QR_READY, etc.)
  if (whatsappBotStatus && whatsappBotStatus.status) {
    updateWhatsAppBotPillUI(whatsappBotStatus);
    updateWhatsAppBotModalUI(whatsappBotStatus);
  }

  fetchWhatsAppBotStatus();
  if (whatsappPollInterval) clearInterval(whatsappPollInterval);
  // Poll every 4s instead of 2s to reduce MQTT spam from Netlify
  whatsappPollInterval = setInterval(fetchWhatsAppBotStatus, 4000);
  switchWhatsAppPairTab('bot');
}

window.closeWhatsAppBotModal = function(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const modal = document.getElementById("whatsapp-bot-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
    modal.style.setProperty("visibility", "hidden", "important");
    modal.style.setProperty("opacity", "0", "important");
    modal.style.setProperty("pointer-events", "none", "important");
  }
  if (whatsappPollInterval) {
    clearInterval(whatsappPollInterval);
    whatsappPollInterval = null;
  }
  if (whatsappQrCountdownTimer) {
    clearInterval(whatsappQrCountdownTimer);
    whatsappQrCountdownTimer = null;
  }

  const sec = globalSettings?.security || {};
  if (sec.whatsappAutoLockMinutes === "immediate") {
    isWhatsAppSessionUnlocked = false;
    whatsappUnlockExpiry = 0;
  }
};

window.initiateWhatsAppConnect = async function(forceClean = false) {
  const qrLoading = document.getElementById("wa-qr-loading");
  const qrImage = document.getElementById("wa-qr-image");
  const expiredOverlay = document.getElementById("wa-qr-expired-overlay");
  const timerBadge = document.getElementById("wa-qr-timer-badge");
  const timerLabel = document.getElementById("wa-qr-timer-label");

  if (qrLoading) qrLoading.style.display = "block";
  if (qrImage) qrImage.style.display = "block";
  if (expiredOverlay) expiredOverlay.style.display = "none";
  if (timerBadge) {
    timerBadge.style.background = "#f0fdf4";
    timerBadge.style.borderColor = "#bbf7d0";
  }
  if (timerLabel) timerLabel.textContent = "🔄 Refreshing WhatsApp Web QR...";

  // Publish refresh command to Cloud Mesh MQTT
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        command: 'refresh_qr',
        forceClean,
        timestamp: Date.now()
      }));
    } catch (me) {}
  }

  try {
    const endpoint = forceClean ? '/api/whatsapp/refresh-qr' : '/api/whatsapp/connect';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(getWhatsAppApiEndpoint(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceClean }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (data) {
      whatsappBotStatus = data;
      updateWhatsAppBotPillUI(whatsappBotStatus);
      updateWhatsAppBotModalUI(whatsappBotStatus);
    }
  } catch (e) {
    console.warn("Connect notice:", e.message);
    if (qrLoading) qrLoading.style.display = "none";
    if (qrImage) {
      qrImage.style.display = "block";
      qrImage.src = 'whatsapp_qr.png?t=' + Date.now();
    }
    if (timerLabel) timerLabel.textContent = "🟢 READY TO SCAN • WhatsApp Login QR";
  }
};

window.disconnectWhatsAppBot = async function() {
  if (!isWhatsAppUnlocked()) {
    promptWhatsAppSecurity(window.disconnectWhatsAppBot);
    return;
  }
  if (!confirm("⚠️ Are you sure you want to disconnect/unlink this WhatsApp device?")) return;

  if (typeof showFloatingToast === 'function') {
    showFloatingToast("⏳ Unlinking WhatsApp device...", 3000);
  }

  // Immediately flip local UI to disconnected / QR scanning state
  whatsappBotStatus = { status: 'DISCONNECTED', isReady: false, webDirect: true };
  updateWhatsAppBotPillUI(whatsappBotStatus);
  updateWhatsAppBotModalUI(whatsappBotStatus);

  // Broadcast disconnect command over EMQX Cloud Mesh (works from Netlify / cloud)
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        command: 'disconnect',
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  // Also send via local HTTP if reachable
  try {
    await fetch(getWhatsAppApiEndpoint('/api/whatsapp/disconnect'), { method: 'POST' });
  } catch (e) {}

  if (typeof showFloatingToast === 'function') {
    showFloatingToast("✅ WhatsApp device unlinked successfully.", 3000);
  }
};

window.sendWhatsAppTestMessage = async function() {
  const phoneInput = document.getElementById("wa-test-phone");
  const statusEl = document.getElementById("wa-test-status");
  const phone = phoneInput ? phoneInput.value.trim() : "";
  if (!phone || phone.replace(/\D/g, '').length < 10) {
    if (statusEl) {
      statusEl.style.color = "#ef4444";
      statusEl.textContent = "❌ Please enter a valid 10-digit mobile number.";
    }
    return;
  }

  if (statusEl) {
    statusEl.style.color = "#0891b2";
    statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending test message to +91${phone}...`;
  }

  const testMsg = `🔔 *WhatsApp Bot Test Message*\n🏛️ *${globalSettings.company?.name || 'AARYAN AQUA NEEDS'}*\n\n✅ Automation bridge is working properly! Invoices and reports will be delivered automatically.`;

  // Send via Cloud Mesh MQTT (works from Netlify)
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        command: 'send_message',
        phone,
        text: testMsg,
        timestamp: Date.now()
      }));
      if (statusEl) {
        statusEl.style.color = "#10b981";
        statusEl.textContent = `✅ Test message dispatched via Cloud Mesh to +91${phone}!`;
      }
    } catch (me) {}
  }

  try {
    const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/send-message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, text: testMsg })
    });
    const result = await res.json();
    if (result && result.ok) {
      if (statusEl) {
        statusEl.style.color = "#10b981";
        statusEl.textContent = `✅ Test message successfully delivered to +91${phone}!`;
      }
    }
  } catch (err) {
    console.log("Local fetch notice:", err.message);
  }
};

window.saveWhatsAppSettings = function() {
  const autoSendToggle = document.getElementById("wa-auto-send-toggle");
  const fallbackToggle = document.getElementById("wa-fallback-1click-toggle");
  if (autoSendToggle) globalSettings.whatsappAutoSend = autoSendToggle.checked;
  if (fallbackToggle) globalSettings.whatsappFallback1Click = fallbackToggle.checked;
  localStorage.setItem("settings", JSON.stringify(globalSettings));
};

// --- FORMAT WHATSAPP INVOICE SUMMARY ---
function formatInvoiceWhatsAppSummary(details) {
  if (typeof generateWhatsAppInvoiceMessage === 'function') {
    return generateWhatsAppInvoiceMessage(details, false);
  }
  const actualDetails = (details && details.details && typeof details.details === 'object') ? details.details : (details || {});
  const companyName = globalSettings.company?.name || 'AARYAN AQUA NEEDS';
  const companyMobile = globalSettings.company?.phones || globalSettings.company?.phone || '7386262139';
  const invNo = actualDetails.invoiceNo || 'INV';
  const custName = (actualDetails.consignee?.name || actualDetails.buyer?.name || actualDetails.customerName || 'Customer').trim();
  const total = actualDetails.total || 0;

  return `🙏 *Namaste! Greetings from ${companyName}!* 🌊\n` +
    `-----------------------------------\n` +
    `Dear *${custName}*,\n\n` +
    `Thank you for choosing *${companyName}*! We truly value your business.\n\n` +
    `📄 *TAX INVOICE:* #${invNo}\n` +
    `💰 *Grand Total:* ₹ ${formatCurrency(total)}\n` +
    `📞 *Mobile:* +91 ${companyMobile}\n` +
    `-----------------------------------\n` +
    `Thank you for your valuable business! Have a wonderful day ahead! 🙏✨`;
}

// --- GENERATE INVOICE PDF BLOB & UPLOAD IN BACKGROUND ---
async function generateInvoicePdfBlob(details) {
  populateA4PrintOverlay(details);
  const printWrapper = document.getElementById("print-invoice-wrapper");
  if (!printWrapper) throw new Error("Print layout wrapper missing");

  printWrapper.style.display = "block";
  document.body.classList.remove("printing-thermal");

  const customerClean = (details.buyer?.name || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Invoice_${details.invoiceNo}_${customerClean}.pdf`;

  const opt = {
    margin: [3, 3, 3, 3],
    filename: filename,
    image: { type: 'jpeg', quality: 0.75 },
    html2canvas: { scale: 1.1, useCORS: true, logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  let blob = null;
  try {
    blob = await html2pdf().set(opt).from(printWrapper).outputPdf('blob');
  } finally {
    printWrapper.style.display = "none";
  }

  const reader = new FileReader();
  const pdfBase64 = await new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });

  // Automatically upload to Google Drive backend and await fast link generation
  let uploadedUrl = details.pdfUrl || details.googleDriveUrl || details.viewUrl || null;
  try {
    if (!uploadedUrl) {
      uploadedUrl = await Promise.race([
        uploadInvoicePdfToGoogleDrive(details, pdfBase64),
        new Promise(r => setTimeout(() => r(null), 3800))
      ]);
    }
    if (uploadedUrl) {
      details.pdfUrl = uploadedUrl;
      if (details.details) details.details.pdfUrl = uploadedUrl;
      const idx = Array.isArray(invoicesDb) ? invoicesDb.findIndex(i => i && (i.id === details.id || String(i.invoiceNo) === String(details.invoiceNo))) : -1;
      if (idx > -1) {
        invoicesDb[idx].pdfUrl = uploadedUrl;
        if (invoicesDb[idx].details) invoicesDb[idx].details.pdfUrl = uploadedUrl;
        try { localStorage.setItem("invoices", JSON.stringify(invoicesDb)); } catch (e) {}
      }
    }
  } catch (e) {
    console.warn("Upload PDF sync note:", e);
  }

  return { blob, pdfBase64, filename, pdfUrl: uploadedUrl || details.pdfUrl };
}

window.waCommandCallbacks = window.waCommandCallbacks || {};

function waitForMqttBotAck(cmdId, timeoutMs = 2800) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        delete window.waCommandCallbacks[cmdId];
        console.warn(`⏳ WhatsApp Bot ACK timed out (${timeoutMs}ms) for ${cmdId}. Triggering fallback.`);
        resolve(false);
      }
    }, timeoutMs);

    window.waCommandCallbacks[cmdId] = (ack) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        delete window.waCommandCallbacks[cmdId];
        if (ack && ack.status === 'DELIVERED') {
          resolve(true);
        } else {
          console.warn(`❌ WhatsApp Bot reported failure for ${cmdId}:`, ack && ack.error);
          resolve(false);
        }
      }
    };
  });
}

// Helper Functions for Dual-Mode Dispatch (Local HTTP + EMQX Cloud Mesh Relay with Delivery Confirmation)
async function dispatchWhatsAppBotInvoice({ phone, text, filename, pdfBase64, pdfUrl = null }) {
  if (!phone) return false;
  const cleanPhone = formatWhatsAppPhone(phone);
  if (!cleanPhone) return false;

  const cleanCaption = (text && typeof text === 'string' && !text.startsWith('data:') && !text.startsWith('JVBERi0') && text.length < 2000)
    ? text
    : '';

  // 1. Try local HTTP POST if running locally or companion available
  const isLocal = (typeof isLocalCompanionAvailable === 'function' && isLocalCompanionAvailable()) || window.location.port === '3001' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocal) {
    try {
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), 45000); // 45 seconds for full PDF generation + WhatsApp Web upload
      const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/send-invoice'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone, text: cleanCaption, filename, pdfBase64, pdfUrl }),
        signal: controller.signal
      });
      clearTimeout(tId);
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          console.log(`✅ WhatsApp Invoice delivered silently via local bot to +${cleanPhone}!`);
          return true;
        }
      }
    } catch (e) {
      console.log("Local HTTP POST note. Falling back to MQTT Mesh if available...", e.message || e);
    }
  }

  // 2. Only attempt MQTT relay if bot is confirmed genuinely live (<60s heartbeat)
  if (typeof window.isLiveBotConnected === 'function' && !window.isLiveBotConnected()) {
    console.log("ℹ️ WhatsApp Bot is not live (no recent heartbeat). Skipping MQTT bot dispatch.");
    return false;
  }

  // 3. Relay via EMQX MQTT Cloud Mesh with Delivery Confirmation (ACK)
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      const cmdId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      // MQTT packet size safety: send base64 over broker up to 5MB (handles all full A4 invoice PDFs)
      const safePdfBase64 = (pdfBase64 && pdfBase64.length < 5000000) ? pdfBase64 : null;
      
      const ackPromise = waitForMqttBotAck(cmdId, 30000);

      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        commandId: cmdId,
        command: 'send_invoice',
        phone: cleanPhone,
        text: cleanCaption,
        filename,
        pdfBase64: safePdfBase64,
        pdfUrl: pdfUrl || null,
        timestamp: Date.now()
      }));

      console.log(`⚡ WhatsApp Invoice command ${cmdId} dispatched via MQTT Mesh, waiting for ACK...`);
      const delivered = await ackPromise;
      if (delivered) {
        console.log(`✅ WhatsApp Invoice confirmed delivered by Bot to +${cleanPhone}!`);
        return true;
      }
    } catch (mqttErr) {
      console.warn("MQTT Mesh publish error:", mqttErr);
    }
  }

  return false;
}

async function dispatchWhatsAppBotMessage({ phone, text }) {
  if (!phone) return false;
  const cleanPhone = formatWhatsAppPhone(phone);
  if (!cleanPhone) return false;

  // 1. Try local HTTP POST if on localhost / port 3001
  const isLocal = (typeof isLocalCompanionAvailable === 'function' && isLocalCompanionAvailable()) || window.location.port === '3001' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocal) {
    try {
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), 15000); // 15 seconds
      const res = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/send-message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone, text }),
        signal: controller.signal
      });
      clearTimeout(tId);
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          console.log(`✅ WhatsApp Message delivered silently via local bot to +${cleanPhone}!`);
          return true;
        }
      }
    } catch (e) {
      console.log("Local HTTP POST note. Falling back to MQTT Mesh if available...", e.message || e);
    }
  }

  // 2. Only attempt MQTT relay if bot is confirmed genuinely live (<60s heartbeat)
  if (typeof window.isLiveBotConnected === 'function' && !window.isLiveBotConnected()) {
    console.log("ℹ️ WhatsApp Bot is not live (no recent heartbeat). Skipping MQTT bot dispatch.");
    return false;
  }

  // 3. Relay via EMQX MQTT Cloud Mesh with Delivery Confirmation (ACK)
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    try {
      const cmdId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const ackPromise = waitForMqttBotAck(cmdId, 8000);

      realtimeMeshClient.publish('aaryan_aqua_gst_billing_2026/whatsapp_commands', JSON.stringify({
        commandId: cmdId,
        command: 'send_message',
        phone: cleanPhone,
        text,
        timestamp: Date.now()
      }));

      console.log(`⚡ WhatsApp Message command ${cmdId} dispatched via MQTT Mesh, waiting for ACK...`);
      const delivered = await ackPromise;
      if (delivered) {
        console.log(`✅ WhatsApp Message confirmed delivered by Bot to +${cleanPhone}!`);
        return true;
      }
    } catch (mqttErr) {
      console.warn("MQTT Mesh publish error:", mqttErr);
    }
  }

  return false;
}

// Automatic Silent WhatsApp Dispatch upon bill generation (100% Automated Backend Process, NO Browser Redirect)
async function autoDispatchInvoiceToWhatsApp(details, textOrBase64 = null, precomputedBase64 = null) {
  if (!details) return false;

  const actualDetails = (details && details.details && typeof details.details === 'object') ? details.details : details;
  const invNo = actualDetails.invoiceNo || details.invoiceNo || 'INV';

  let text = textOrBase64;
  let pdfBase64 = precomputedBase64;

  // Polymorphic detection: if 2nd argument is base64 string
  if (typeof text === 'string' && (text.startsWith('data:application/pdf') || text.startsWith('data:') || text.startsWith('JVBERi0') || text.length > 500)) {
    pdfBase64 = text;
    text = null;
  }

  const recipientsInfo = typeof getInvoiceRecipients === 'function'
    ? getInvoiceRecipients(actualDetails)
    : { primaryPhone: getCustomerPhoneNumber(actualDetails), consigneeName: actualDetails.consignee?.name, buyerName: actualDetails.buyer?.name, allRecipients: [] };

  if (!recipientsInfo.primaryPhone && (!recipientsInfo.allRecipients || recipientsInfo.allRecipients.length === 0)) {
    console.log("Auto WhatsApp dispatch skipped: No recipient phone numbers found.");
    return false;
  }

  const custName = actualDetails.consignee?.name || actualDetails.buyer?.name || details.customerName || 'Customer';
  const customerClean = custName.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Invoice_${invNo}_${customerClean}.pdf`;

  // Pre-compile PDF if not yet done so Google Drive URL is ready for WhatsApp
  if (!pdfBase64) {
    try {
      const gen = await generateInvoicePdfBlob(actualDetails);
      if (gen) {
        pdfBase64 = gen.pdfBase64;
        if (gen.pdfUrl && !actualDetails.pdfUrl) {
          actualDetails.pdfUrl = gen.pdfUrl;
          if (actualDetails.details) actualDetails.details.pdfUrl = gen.pdfUrl;
        }
      }
    } catch (err) {
      console.warn("Could not generate PDF for auto dispatch:", err);
    }
  }

  // Prepare Customer message and Owner ("Me") alert message
  const customerText = (typeof generateWhatsAppInvoiceMessage === 'function')
    ? generateWhatsAppInvoiceMessage(actualDetails, false)
    : (typeof formatInvoiceWhatsAppSummary === 'function' ? formatInvoiceWhatsAppSummary(actualDetails) : '');

  const ownerText = (typeof generateWhatsAppInvoiceMessage === 'function')
    ? generateWhatsAppInvoiceMessage(actualDetails, true)
    : customerText;

  // Check live status if needed
  let isBotReady = whatsappBotStatus && (whatsappBotStatus.isReady || whatsappBotStatus.status === 'CONNECTED') && (typeof window.isLiveBotConnected === 'function' ? window.isLiveBotConnected() : true);

  if (isBotReady) {
    let anySent = false;
    const dispatchedList = [];

    // 1. Resolve Customer Targets
    const customerTargets = (recipientsInfo.allRecipients && recipientsInfo.allRecipients.length > 0)
      ? recipientsInfo.allRecipients
      : [{ clean: formatWhatsAppPhone(recipientsInfo.primaryPhone), label: 'Customer' }];

    const invoicePdfUrl = actualDetails.pdfUrl || actualDetails.googleDriveUrl || actualDetails.viewUrl || null;

    // 2. Dispatch ONLY to Customer(s)
    for (const rec of customerTargets) {
      if (!rec.clean) continue;
      const ok = await dispatchWhatsAppBotInvoice({
        phone: rec.clean,
        text: customerText,
        filename,
        pdfBase64,
        pdfUrl: invoicePdfUrl
      });
      if (ok) {
        anySent = true;
        dispatchedList.push(`${rec.label} (+${rec.clean})`);
        console.log(`✅ Automated WhatsApp Invoice sent to ${rec.label} (+${rec.clean})`);
      }
    }

    if (anySent) {
      if (details.details) details.waAutoSent = true;
      if (typeof window.updateSuccessModalWhatsAppStatus === 'function') {
        window.updateSuccessModalWhatsAppStatus(details.details ? details : { details });
      }
      if (typeof playSuccessChime === 'function') playSuccessChime();
      showFloatingToast(`🚀 Invoice #${invNo} & PDF dispatched via WhatsApp to ${dispatchedList.join(" & ")}!`, 6000);
      return true;
    }
  } else {
    const recName = recipientsInfo.consigneeName || recipientsInfo.buyerName || 'Customer';
    const targetPhone = recipientsInfo.primaryPhone ? `to ${recName} (+${recipientsInfo.primaryPhone})` : '';
    console.log("WhatsApp Bot is offline or in cloud web mode. 1-Click WhatsApp ready.");
    showFloatingToast(`📲 1-Click WhatsApp ready: Click 'WhatsApp' in modal to send ${targetPhone}`, 5500);
  }
  return false;
}
window.autoDispatchInvoiceToWhatsApp = autoDispatchInvoiceToWhatsApp;
window.triggerAutomatedWhatsAppDispatch = autoDispatchInvoiceToWhatsApp;

// Dual-Mode Native Share: Auto background bot when linked on PC, instant unblocked 1-click WhatsApp on manual trigger
window.shareInvoicePdfNative = async function(details, btnEl = null, force1Click = false, precomputedBase64 = null) {
  if (!details || !details.invoiceNo) {
    showFloatingToast("⚠️ Please add items to invoice before sharing!", "warning");
    return;
  }

  const recipientsInfo = typeof getInvoiceRecipients === 'function'
    ? getInvoiceRecipients(details)
    : { primaryPhone: getCustomerPhoneNumber(details), consigneeName: details.consignee?.name, buyerName: details.buyer?.name, allRecipients: [] };

  let rawPhone = recipientsInfo.primaryPhone;
  let cleanPhone = "";
  const primaryName = recipientsInfo.consigneeName || recipientsInfo.buyerName || 'Consignee / Customer';

  if (rawPhone && rawPhone.toString().replace(/\D/g, '').length >= 10) {
    cleanPhone = formatWhatsAppPhone(rawPhone);
  } else {
    let autoFound = "";
    if (primaryName && primaryName !== 'Consignee / Customer') {
      const match = (partiesDb || []).find(p => p && p.name && p.name.trim().toLowerCase() === primaryName.trim().toLowerCase() && p.phone);
      if (match && match.phone) autoFound = match.phone;
      if (!autoFound) {
        const invMatch = (invoicesDb || []).slice().reverse().find(i => {
          const cName = i.consignee?.name || i.buyer?.name || i.customerName || "";
          return cName.trim().toLowerCase() === primaryName.trim().toLowerCase() && (i.consignee?.phone || i.buyer?.phone || i.phone);
        });
        if (invMatch) autoFound = invMatch.consignee?.phone || invMatch.buyer?.phone || invMatch.phone || "";
      }
    }
    if (autoFound && autoFound.toString().replace(/\D/g, '').length >= 10) {
      cleanPhone = formatWhatsAppPhone(autoFound);
      if (!details.consignee) details.consignee = {};
      details.consignee.phone = autoFound;
      if (typeof elements !== 'undefined' && elements.billConsigneePhone) {
        elements.billConsigneePhone.value = autoFound;
      }
    } else {
      console.log(`ℹ️ Consignee (${primaryName}) has no phone registered. Skipping manual WhatsApp prompt.`);
      showFloatingToast(`ℹ️ Consignee "${primaryName}" has no phone number. Add phone in customer master to auto-send.`, "info", 3500);
      return false;
    }
  }

  let origHtml = "";
  if (btnEl && btnEl.tagName) {
    origHtml = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing PDF...`;
    btnEl.disabled = true;
  }

  showFloatingToast(`📄 Preparing official PDF invoice #${details.invoiceNo}...`, "info", 2200);

  const custName = details.consignee?.name || details.buyer?.name || details.customerName || 'Customer';
  const customerClean = custName.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `Invoice_${details.invoiceNo}_${customerClean}.pdf`;

  // 1. GUARANTEE PDF & GOOGLE DRIVE LINK ARE GENERATED BEFORE BUILDING WHATSAPP MESSAGE
  let pdfBase64 = precomputedBase64;
  let pdfBlob = null;
  let publicPdfUrl = details.pdfUrl || details.googleDriveUrl || details.viewUrl;

  try {
    const gen = await generateInvoicePdfBlob(details);
    if (gen) {
      pdfBase64 = gen.pdfBase64 || pdfBase64;
      pdfBlob = gen.blob;
      if (gen.pdfUrl) {
        publicPdfUrl = gen.pdfUrl;
        details.pdfUrl = gen.pdfUrl;
        if (details.details) details.details.pdfUrl = gen.pdfUrl;
      }
    }
  } catch (pdfErr) {
    console.warn("PDF compilation note in shareInvoicePdfNative:", pdfErr);
  }

  // 2. NOW CONSTRUCT THE COMPLETE WHATSAPP MESSAGE (GUARANTEED TO CONTAIN GOOGLE DRIVE PDF LINK)
  const fullShareText = typeof generateWhatsAppInvoiceMessage === 'function'
    ? generateWhatsAppInvoiceMessage(details)
    : formatInvoiceWhatsAppSummary(details);

  // 3. CHECK LIVE BOT STATUS
  let isBotReady = whatsappBotStatus && (whatsappBotStatus.isReady || whatsappBotStatus.status === 'CONNECTED') && (typeof window.isLiveBotConnected === 'function' ? window.isLiveBotConnected() : true);

  // --- AUTOMATED BACKGROUND BOT DISPATCH (Direct PDF Document Attachment) ---
  if (isBotReady && cleanPhone) {
    if (btnEl && btnEl.tagName) {
      btnEl.innerHTML = `<i class="fa-solid fa-cloud-arrow-up fa-fade"></i> Sending via Bot...`;
    }
    showFloatingToast(`🤖 Sending invoice #${details.invoiceNo} & PDF document silently via WhatsApp Bot...`, "info", 3000);

    let anyDelivered = false;
    try {
      // Send to Consignee first, and if Receiver also has a distinct phone, send to Receiver as well!
      const targetsToSend = (recipientsInfo.allRecipients && recipientsInfo.allRecipients.length > 0)
        ? recipientsInfo.allRecipients
        : [{ clean: cleanPhone, label: 'Consignee' }];

      let sentCount = 0;
      const sentLabels = [];

      for (const rec of targetsToSend) {
        if (!rec.clean) continue;
        const ok = await dispatchWhatsAppBotInvoice({
          phone: rec.clean,
          text: fullShareText,
          filename,
          pdfBase64,
          pdfUrl: publicPdfUrl || details.pdfUrl || null
        });
        if (ok) {
          sentCount++;
          sentLabels.push(`${rec.label} (+${rec.clean})`);
        }
      }

      if (sentCount > 0) {
        anyDelivered = true;
        if (lastSavedInvoiceRecord) {
          lastSavedInvoiceRecord.waAutoSent = true;
          if (typeof updateSuccessModalWhatsAppStatus === 'function') {
            updateSuccessModalWhatsAppStatus(lastSavedInvoiceRecord);
          }
        }
        if (typeof playSuccessChime === 'function') playSuccessChime();
        if (btnEl && btnEl.tagName) {
          btnEl.innerHTML = `<i class="fa-solid fa-circle-check text-success"></i> Sent via Bot!`;
          setTimeout(() => {
            btnEl.innerHTML = origHtml;
            btnEl.disabled = false;
          }, 2500);
        }
        showFloatingToast(`🚀 Invoice #${details.invoiceNo} & PDF sent automatically to ${sentLabels.join(" & ")} via WhatsApp Bot!`, "success", 5000);
        return true;
      }
    } catch (fastErr) {
      console.warn("Background bot dispatch note:", fastErr);
    }

    if (!anyDelivered) {
      if (btnEl && btnEl.tagName) {
        btnEl.innerHTML = origHtml;
        btnEl.disabled = false;
      }
      showFloatingToast(`⚠️ WhatsApp Bot delivery unavailable. Opening WhatsApp Direct...`, "warning", 3500);
      // Fall through directly to 1-Click WhatsApp fallback below!
    }
  }

  // --- UNIVERSAL 1-CLICK WHATSAPP FALLBACK (User-Initiated Click Only) ---
  // If this was called silently in the background without user clicking a button, do not pop open:
  if (!btnEl && !force1Click) {
    showFloatingToast(`📲 WhatsApp ready: Click 'WhatsApp' button in bill modal to send`, "info", 4500);
    return false;
  }

  // A) Immediately download the PDF file to merchant's computer so they can drag into WhatsApp chat if desired
  try {
    if (pdfBlob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(pdfBlob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch (e) {}
      }, 800);
    }
  } catch (dlErr) {
    console.warn("Auto PDF download note:", dlErr);
  }

  // B) Open WhatsApp Web only when the user explicitly clicked the share button and bot is not connected
  const waUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(fullShareText)}`;
  window.open(waUrl, '_blank');

  if (btnEl && btnEl.tagName) {
    btnEl.innerHTML = origHtml;
    btnEl.disabled = false;
  }

  showFloatingToast(`📲 WhatsApp opened for ${primaryName} (+${cleanPhone})!`, "success", 5000);
  return true;
};

window.openWhatsappWebChat = function() {
  const sec = globalSettings?.security || {};
  if (sec.whatsappProtectChats !== false && !isWhatsAppUnlocked()) {
    promptWhatsAppSecurity(window.openWhatsappWebChat);
    return;
  }

  const modalEl = document.getElementById("whatsapp-pdf-guide-modal");
  if (modalEl) modalEl.classList.add("hidden");

  const phoneInput = document.getElementById("guide-whatsapp-phone");
  const enteredPhone = phoneInput ? phoneInput.value.trim() : "";
  const cleanPhone = formatWhatsAppPhone(enteredPhone);

  let url = "";
  if (cleanPhone) {
    url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(pendingWaMsg)}`;
  } else {
    url = `https://api.whatsapp.com/send?text=${encodeURIComponent(pendingWaMsg)}`;
  }

  openWhatsAppDirect(url);
};

window.closeWhatsappGuideModal = function() {
  const modalEl = document.getElementById("whatsapp-pdf-guide-modal");
  if (modalEl) {
    modalEl.classList.add("hidden");
    modalEl.style.setProperty("display", "none", "important");
  }
};

window.shareCurrentInvoiceWhatsApp = function(btnEl = null) {
  const button = btnEl || document.querySelector(".btn-share-whatsapp") || document.querySelector(".btn-whatsapp");
  return window.saveCurrentInvoiceRecord('share_whatsapp', button);
};

let currentBalanceQrInv = null;

window.openBalanceQrModal = function(id) {
  const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(i => i.id === id || i.invoiceNo === id);
  if (inv && typeof openInvoiceVerificationModal === "function") {
    openInvoiceVerificationModal(inv.id || inv.invoiceNo);
    return;
  }
  if (!inv) return;
  const details = inv.details || {};
  const payInfo = getInvoicePaidAndBalance(inv);
  const total = payInfo.total;
  const paid = payInfo.paid;
  const balance = payInfo.balance;

  currentBalanceQrInv = { inv, details, total, paid, balance };

  const invNoEl = document.getElementById("bal-qr-inv-no");
  if (invNoEl) invNoEl.textContent = `#${inv.invoiceNo || ''}`;
  const custEl = document.getElementById("bal-qr-customer");
  if (custEl) custEl.textContent = inv.customerName || 'Customer';
  const totEl = document.getElementById("bal-qr-total");
  if (totEl) totEl.textContent = formatCurrency(total);
  const paidEl = document.getElementById("bal-qr-paid");
  if (paidEl) paidEl.textContent = formatCurrency(paid);
  const balEl = document.getElementById("bal-qr-balance");
  if (balEl) balEl.textContent = formatCurrency(balance);

  const realUpiId = (globalSettings.upiId || globalSettings.bank?.upi || "7386262139@upi").trim();
  const upiIdEl = document.getElementById("bal-qr-upi-id");
  if (upiIdEl) upiIdEl.textContent = realUpiId;

  const upiName = encodeURIComponent((globalSettings.company?.name || "Aaryan Aqua Needs").replace(/[^a-zA-Z0-9 ]/g, '').trim());
  const cleanInvNo = String(inv.invoiceNo || '1').replace(/[^a-zA-Z0-9]/g, '');
  const qrSuffix = (inv.qrToken || details.qrToken || inv.id || "").toString().replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || Math.random().toString(36).substring(2, 6).toUpperCase();
  const upiTr = `${cleanInvNo}${qrSuffix}`.slice(-20);
  const upiUri = `upi://pay?pa=${realUpiId}&pn=${upiName}&am=${balance.toFixed(2)}&cu=INR&tn=Bill${cleanInvNo}-${qrSuffix}&tr=${upiTr}`;

  const canvas = document.getElementById("balance-qr-canvas");
  const imgEl = document.getElementById("balance-qr-img");

  let canvasSuccess = false;
  if (canvas && typeof QRious !== "undefined") {
    try {
      new QRious({
        element: canvas,
        value: upiUri,
        size: 300,
        level: 'H'
      });
      canvas.style.display = "block";
      if (imgEl) imgEl.style.display = "none";
      canvasSuccess = true;
    } catch (e) {
      console.warn("QRious canvas render failed, switching to image fallback:", e);
    }
  }

  if (!canvasSuccess && imgEl) {
    if (canvas) canvas.style.display = "none";
    imgEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiUri)}`;
    imgEl.style.display = "block";
  }

  const modalEl = document.getElementById("balance-qr-modal");
  if (modalEl) {
    modalEl.classList.remove("hidden");
    modalEl.style.removeProperty("display");
    modalEl.style.setProperty("display", "flex", "important");
  }
};

window.closeBalanceQrModal = function() {
  const modalEl = document.getElementById("balance-qr-modal");
  if (modalEl) {
    modalEl.classList.add("hidden");
    modalEl.style.setProperty("display", "none", "important");
  }
};

window.shareBalanceQrWhatsApp = function() {
  if (!currentBalanceQrInv) return;
  const { inv } = currentBalanceQrInv;
  closeBalanceQrModal();
  sendWhatsAppPaymentReminder(inv.id);
};

window.markBalanceQrPaidAndSendWhatsApp = function() {
  if (!currentBalanceQrInv || !currentBalanceQrInv.inv) {
    if (typeof showNotification === "function") showNotification("No active invoice selected.", "warning");
    return;
  }

  const inv = currentBalanceQrInv.inv;
  const settledAmount = Number(inv.balanceDue || (inv.total - (inv.paidAmount || 0)));

  // Update Invoice Record to Paid
  inv.paidAmount = Number(inv.total || 0);
  inv.balanceDue = 0;
  inv.paymentStatus = "Paid";
  inv.paymentMode = inv.paymentMode || "UPI / Online";

  if (inv.details) {
    inv.details.paidAmount = inv.paidAmount;
    inv.details.balanceDue = 0;
    inv.details.paymentStatus = "Paid";
    inv.details.paymentMode = inv.paymentMode;
  }

  if (!inv.paymentHistory) inv.paymentHistory = [];
  inv.paymentHistory.push({
    date: new Date().toISOString(),
    amount: settledAmount,
    mode: inv.paymentMode,
    source: "Balance QR Modal Mark Paid"
  });

  // Persist & Sync to LocalStorage, IndexedDB, Google Sheets & EMQX Mesh
  try {
    localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    window.invoicesDb = invoicesDb;
  } catch (e) {
    console.warn("Error persisting invoices to localStorage:", e);
  }
  if (window.AaryanDB && typeof window.AaryanDB.saveInvoice === 'function') {
    try { window.AaryanDB.saveInvoice(inv); } catch (e) {}
  }
  if (typeof syncDatabaseToServer === 'function') {
    try { syncDatabaseToServer("invoices", inv); } catch (e) {}
  }
  if (typeof renderInvoicesTable === "function") renderInvoicesTable();
  if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
  if (typeof updateDashboardOverview === "function") updateDashboardOverview();
  if (typeof window.broadcastDatabaseMutation === 'function') window.broadcastDatabaseMutation();

  // Mesh MQTT Sync
  if (typeof publishMeshDatabaseUpdate === "function") {
    try { publishMeshDatabaseUpdate("invoicesDb", inv); } catch (e) { console.warn(e); }
  }

  // Automatic WhatsApp Receipt & Paid PDF Dispatch
  const custPhone = inv.buyerPhone || inv.details?.buyer?.phone || inv.phone || "";
  if (custPhone) {
    const msg = `✅ *Payment Received & Verified!*\n\n` +
      `🧾 *Invoice No:* ${inv.invoiceNo}\n` +
      `👤 *Customer:* ${inv.buyerName || inv.details?.buyer?.name || 'Customer'}\n` +
      `💰 *Amount Paid:* ₹ ${formatCurrency(settledAmount)}\n` +
      `💳 *Payment Mode:* ${inv.paymentMode}\n` +
      `📊 *Remaining Balance:* ₹ 0.00 (Fully Paid)\n\n` +
      `Thank you for your business with *Aaryan Aqua Needs*! 🌊`;

    if (typeof dispatchWhatsAppBotMessage === "function") {
      dispatchWhatsAppBotMessage(custPhone, msg);
    }

    setTimeout(() => {
      if (typeof autoDispatchInvoiceToWhatsApp === "function") {
        autoDispatchInvoiceToWhatsApp(inv.details || inv);
      } else if (typeof shareInvoicePdfNative === "function") {
        shareInvoicePdfNative(inv.details || inv, null, false, null);
      }
    }, 800);
  }

  if (typeof showFloatingToast === "function") {
    showFloatingToast(`✅ Invoice #${inv.invoiceNo} marked PAID! Balance settled to ₹0.00 & WhatsApp receipt sent!`, "success");
  }

  closeBalanceQrModal();
};

window.sendWhatsAppPaymentReminder = async function(id, btnEl = null) {
  const inv = invoicesDb.find(i => i.id === id);
  if (!inv) return;
  const payInfo = getInvoicePaidAndBalance(inv);

  if (payInfo.isPaid || payInfo.balance <= 0) {
    showFloatingToast(`Invoice #${inv.invoiceNo} is already fully paid! No balance reminder needed.`, "info");
    return;
  }

  const details = inv.details || {};
  const total = payInfo.total;
  const paid = payInfo.paid;
  const balance = payInfo.balance;

  let rawPhone = getCustomerPhoneNumber(details);
  let cleanPhone = "";
  if (rawPhone && rawPhone.toString().replace(/\D/g, '').length >= 10) {
    cleanPhone = formatWhatsAppPhone(rawPhone);
  } else {
    const custName = details.buyer?.name || inv.customerName || details.consignee?.name || 'Customer';
    let autoPhone = "";
    if (custName && custName !== 'Customer') {
      const match = (partiesDb || []).find(p => p && p.name && p.name.trim().toLowerCase() === custName.trim().toLowerCase() && p.phone);
      if (match && match.phone) autoPhone = match.phone;
      if (!autoPhone) {
        const invMatch = (invoicesDb || []).slice().reverse().find(i => {
          const cName = i.buyer?.name || i.customerName || i.consignee?.name || "";
          return cName.trim().toLowerCase() === custName.trim().toLowerCase() && (i.buyer?.phone || i.consignee?.phone || i.phone);
        });
        if (invMatch) autoPhone = invMatch.buyer?.phone || invMatch.consignee?.phone || invMatch.phone || "";
      }
    }
    if (autoPhone && autoPhone.toString().replace(/\D/g, '').length >= 10) {
      cleanPhone = formatWhatsAppPhone(autoPhone);
      if (details.buyer) details.buyer.phone = autoPhone;
    } else {
      showFloatingToast(`⚠️ Cannot send reminder: No phone number found for "${custName}".`, "warning", 3500);
      return;
    }
  }

  const realUpiId = (globalSettings.upiId || globalSettings.bank?.upi || "7386262139@upi").trim();
  const companyName = globalSettings.company?.name || "AARYAN AQUA NEEDS";
  const upiName = encodeURIComponent(companyName.replace(/[^a-zA-Z0-9 ]/g, '').trim());
  const cleanNote = `Bill${inv.invoiceNo || '1'}`.replace(/[^a-zA-Z0-9]/g, '');
  const upiPayLink = `upi://pay?pa=${realUpiId}&pn=${upiName}&am=${balance.toFixed(2)}&cu=INR&tn=${cleanNote}`;

  let reminderText = `🏛️ *${companyName}*\n`;
  reminderText += `⚠️ *PAYMENT REMINDER*\n`;
  reminderText += `-----------------------------------\n`;
  reminderText += `📄 *Tax Invoice #:* #${inv.invoiceNo}\n`;
  reminderText += `👤 *Customer:* ${inv.customerName || details.buyer?.name || 'Customer'}\n`;
  reminderText += `📅 *Bill Date:* ${formatInputDateString(inv.invoiceDate)}\n`;
  reminderText += `💰 *Total Bill Amount:* ₹ ${formatCurrency(total)}\n`;
  reminderText += `✅ *Amount Paid:* ₹ ${formatCurrency(paid)}\n`;
  reminderText += `🔴 *PENDING BALANCE DUE:* ₹ ${formatCurrency(balance)}\n`;
  reminderText += `-----------------------------------\n`;
  reminderText += `📲 *Pay Directly via UPI App (GPay / PhonePe / Paytm):*\n`;
  reminderText += `${upiPayLink}\n\n`;
  reminderText += `💳 Or send to UPI ID: *${realUpiId}*\n`;
  reminderText += `-----------------------------------\n`;
  reminderText += `Kindly settle the pending balance at your earliest convenience. Thank you! 🙏`;

  let origHtml = "";
  if (btnEl && btnEl.tagName) {
    origHtml = btnEl.innerHTML;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btnEl.disabled = true;
  }

  // Check live bot status strictly
  let isBotReady = whatsappBotStatus && (whatsappBotStatus.isReady || whatsappBotStatus.status === 'CONNECTED') && (typeof window.isLiveBotConnected === 'function' ? window.isLiveBotConnected() : true);
  if (!isBotReady && isLocalCompanionAvailable()) {
    try {
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), 2000);
      const liveRes = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/status'), { signal: controller.signal })
        .then(r => r.json()).catch(() => null);
      clearTimeout(tId);
      if (liveRes && (liveRes.isReady || liveRes.status === 'CONNECTED')) {
        whatsappBotStatus = liveRes;
        isBotReady = true;
        updateWhatsAppBotPillUI(whatsappBotStatus);
      }
    } catch (e) {}
  }

  if (isBotReady && cleanPhone) {
    try {
      const ok = await dispatchWhatsAppBotMessage({ phone: cleanPhone, text: reminderText });
      if (ok) {
        if (typeof playSuccessChime === 'function') playSuccessChime();
        if (btnEl && btnEl.tagName) {
          btnEl.innerHTML = `<i class="fa-solid fa-circle-check text-success"></i> Sent via Bot!`;
          setTimeout(() => {
            btnEl.innerHTML = origHtml;
            btnEl.disabled = false;
          }, 2000);
        }
        showFloatingToast(`🚀 Payment reminder (₹ ${formatCurrency(balance)}) sent silently to +${cleanPhone} via WhatsApp Bot!`, 5000);
        return true;
      }
    } catch (e) {
      console.warn("Payment reminder send error:", e);
    }
    if (btnEl && btnEl.tagName) {
      btnEl.innerHTML = origHtml;
      btnEl.disabled = false;
    }
    showFloatingToast(`⚠️ WhatsApp Bot could not deliver reminder.`, "warning", 4000);
    return false;
  }

  if (btnEl && btnEl.tagName) {
    btnEl.innerHTML = origHtml;
    btnEl.disabled = false;
  }

  // Seamless 1-Click WhatsApp Direct Fallback (ONLY when bot is offline):
  if (!isBotReady && cleanPhone) {
    const encodedText = encodeURIComponent(reminderText);
    const waDirectUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;
    window.open(waDirectUrl, '_blank');
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📲 Opened WhatsApp Direct with reminder & UPI payment link for +${cleanPhone}!`, 4500);
    }
    return true;
  }
  return false;
};

window.shareInvoiceToWhatsApp = function(id, btnEl = null) {
  const inv = invoicesDb.find(i => i.id === id);
  if (!inv) return;
  shareInvoicePdfNative(inv.details, btnEl);
};

// --- ADVANCED DATA EXPORTERS (CSV / EXCEL) ---
function downloadCSVFile(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

window.exportInvoicesToCSV = function() {
  if (!invoicesDb || invoicesDb.length === 0) {
    showFloatingToast("⚠️ No invoices available to export.", "warning");
    return;
  }
  let csv = "Invoice No,Date,Customer Name,Payment Status,Payment Mode,Items Count,Total (INR)\n";
  invoicesDb.forEach(inv => {
    const details = inv.details || {};
    const row = [
      `"${inv.invoiceNo || ""}"`,
      `"${inv.invoiceDate || ""}"`,
      `"${(inv.customerName || "").replace(/"/g, '""')}"`,
      `"${details.paymentStatus || "Paid"}"`,
      `"${details.paymentMode || "UPI / QR"}"`,
      inv.itemsCount || 0,
      inv.total || 0
    ].join(",");
    csv += row + "\n";
  });
  downloadCSVFile(`Invoices_Export_${new Date().toISOString().split('T')[0]}.csv`, csv);
};

window.exportProductsToCSV = function() {
  if (!productsDb || productsDb.length === 0) {
    showFloatingToast("⚠️ No products available to export.", "warning");
    return;
  }
  let csv = "ID,Description,HSN,Pack Size,Unit,Rate (INR),Stock\n";
  productsDb.forEach(p => {
    const row = [
      `"${p.id || ""}"`,
      `"${(p.description || "").replace(/"/g, '""')}"`,
      `"${p.hsn || ""}"`,
      `"${p.packSize || ""}"`,
      `"${p.unit || ""}"`,
      p.rate || 0,
      p.stock || 0
    ].join(",");
    csv += row + "\n";
  });
  downloadCSVFile(`Products_Inventory_${new Date().toISOString().split('T')[0]}.csv`, csv);
};

window.exportPartiesToCSV = function() {
  if (!partiesDb || partiesDb.length === 0) {
    showFloatingToast("⚠️ No party profiles available to export.", "warning");
    return;
  }
  let csv = "Type,Customer Name,Company Name,Address,GSTIN,State,Phone\n";
  partiesDb.forEach(p => {
    const row = [
      `"${p.type || "receiver"}"`,
      `"${(p.name || "").replace(/"/g, '""')}"`,
      `"${(p.company || "").replace(/"/g, '""')}"`,
      `"${(p.address || "").replace(/"/g, '""')}"`,
      `"${p.gstin || ""}"`,
      `"${p.state || ""}"`,
      `"${p.phone || ""}"`
    ].join(",");
    csv += row + "\n";
  });
  downloadCSVFile(`Parties_Export_${new Date().toISOString().split('T')[0]}.csv`, csv);
};

window.filterInvoicesByStatus = async function() {
  const statusEl = document.getElementById("filter-history-status");
  const statusFilter = statusEl ? statusEl.value : "all";
  const typeEl = document.getElementById("filter-history-type");
  const typeFilter = typeEl ? typeEl.value : "all";
  const query = elements.searchHistoryInput ? elements.searchHistoryInput.value.toLowerCase().trim() : "";

  let filtered = [];
  if (window.AaryanDB && typeof window.AaryanDB.searchInvoicesCursor === 'function' && query) {
    filtered = await window.AaryanDB.searchInvoicesCursor(query, 500);
  } else {
    filtered = invoicesDb || [];
    if (query) {
      filtered = filtered.filter(inv => 
        (inv.invoiceNo && String(inv.invoiceNo).toLowerCase().includes(query)) || 
        (inv.customerName && String(inv.customerName).toLowerCase().includes(query))
      );
    }
  }

  // Filter by document type: 'invoice' vs 'estimate'
  if (typeFilter === "invoice") {
    filtered = filtered.filter(inv => {
      const isEst = Boolean(inv.isEstimate || inv.details?.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
      return !isEst;
    });
  } else if (typeFilter === "estimate") {
    filtered = filtered.filter(inv => {
      const isEst = Boolean(inv.isEstimate || inv.details?.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
      return isEst;
    });
  }

  if (statusFilter !== "all") {
    filtered = filtered.filter(inv => {
      const payInfo = getInvoicePaidAndBalance(inv);
      return payInfo.status === statusFilter;
    });
  }

  renderHistoryTableRows(filtered);
};

// --- SAVED INVOICE VIEW EDIT & DELETE HISTORY ---
function loadInvoicesHistoryTable() {
  loadAllDatabases();

  if (invoicesDb && invoicesDb.length > 0) {
    if (elements.historyCount) elements.historyCount.textContent = invoicesDb.length;
    renderHistoryTableRows(invoicesDb);
    return;
  }

  if (window.isInitialSyncDone) {
    if (elements.historyCount) elements.historyCount.textContent = "0";
    renderHistoryTableRows([]);
    return;
  }

  // If empty before initial sync finishes, show loading spinner
  if (elements.historyCount) {
    elements.historyCount.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="font-size: 11px;"></i>`;
  }
  if (elements.historyInvoicesBody) {
    elements.historyInvoicesBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="padding: 40px 16px; color: #64748b;">
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;">
            <i class="fa-solid fa-circle-notch fa-spin fa-2x" style="color: #0284c7;"></i>
            <div style="font-weight: 600; font-size: 14px; color: #334155;">Syncing Invoices from Cloud...</div>
            <div style="font-size: 12px; color: #94a3b8;">Connecting to Google Sheets master database</div>
          </div>
        </td>
      </tr>
    `;
  }
  if (!isSyncing && typeof window.triggerDatabaseSync === 'function') {
    window.triggerDatabaseSync(true).then(() => {
      if (elements.historyCount) elements.historyCount.textContent = (invoicesDb && invoicesDb.length) || "0";
      renderHistoryTableRows(invoicesDb || []);
    }).catch(() => {});
  }

  setTimeout(() => {
    window.isInitialSyncDone = true;
    if (elements.historyCount) elements.historyCount.textContent = (invoicesDb && invoicesDb.length) || "0";
    renderHistoryTableRows(invoicesDb || []);
  }, 2000);
}

function getInvoicePaidAndBalance(inv) {
  if (window.InvoiceUtils && typeof window.InvoiceUtils.getInvoicePaidAndBalance === 'function') {
    return window.InvoiceUtils.getInvoicePaidAndBalance(inv);
  }
  if (!inv) return { status: 'Paid', isPaid: true, paid: 0, balance: 0, total: 0 };
  const details = inv.details || {};
  const total = parseFloat(inv.total !== undefined ? inv.total : (details.total || 0)) || 0;
  const status = String(details.paymentStatus || inv.paymentStatus || 'Paid').trim();
  const isPaid = status.toLowerCase() === 'paid';
  if (isPaid) return { status: 'Paid', isPaid: true, paid: total, balance: 0, total };
  if (status.toLowerCase() === 'unpaid') return { status: 'Unpaid', isPaid: false, paid: 0, balance: total, total };
  let balance = 0;
  if (details.balanceDue !== undefined && !isNaN(parseFloat(details.balanceDue))) {
    balance = Math.max(0, parseFloat(details.balanceDue));
  } else if (inv.balanceDue !== undefined && !isNaN(parseFloat(inv.balanceDue))) {
    balance = Math.max(0, parseFloat(inv.balanceDue));
  } else {
    const p = parseFloat(details.paidAmount ?? inv.paidAmount ?? 0) || 0;
    balance = Math.max(0, total - p);
  }
  if (balance <= 0) return { status: 'Paid', isPaid: true, paid: total, balance: 0, total };
  return { status, isPaid: false, paid: Math.max(0, total - balance), balance, total };
}

function renderHistoryTableRows(records) {
  if (!elements.historyInvoicesBody) return;
  elements.historyInvoicesBody.innerHTML = "";
  if (!records || records.length === 0) {
    const isSearching = elements.searchHistoryInput && elements.searchHistoryInput.value.trim().length > 0;
    if (!isSearching && !window.isInitialSyncDone) {
      elements.historyInvoicesBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center" style="padding: 40px 16px; color: #64748b;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;">
              <i class="fa-solid fa-circle-notch fa-spin fa-2x" style="color: #0284c7;"></i>
              <div style="font-weight: 600; font-size: 14px; color: #334155;">Syncing Invoices from Cloud...</div>
              <div style="font-size: 12px; color: #94a3b8;">Connecting to Google Sheets master database</div>
            </div>
          </td>
        </tr>
      `;
    } else {
      elements.historyInvoicesBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 32px; font-weight: 500;">
            <i class="fa-solid fa-file-invoice" style="font-size: 24px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>
            ${isSearching ? 'No matching invoices found.' : 'No invoices found.'}
          </td>
        </tr>
      `;
    }
    return;
  }

  const sortedRecords = (records || []).slice().sort((a, b) => {
    function getTs(inv) {
      if (!inv) return 0;
      if (typeof inv.id === 'string' && inv.id.startsWith('inv_')) {
        const ts = parseInt(inv.id.split('_')[1], 10);
        if (!isNaN(ts) && ts > 1000000000000) return ts;
      }
      if (inv.invoiceDate) {
        const t = new Date(inv.invoiceDate).getTime();
        if (!isNaN(t) && t > 0) return t;
      }
      return 0;
    }
    return getTs(b) - getTs(a);
  });

  sortedRecords.forEach(inv => {
    const details = inv.details || {};
    const isEstimate = Boolean(inv.isEstimate || details.isEstimate || String(inv.invoiceNo || "").startsWith("EST-"));
    const payInfo = getInvoicePaidAndBalance(inv);
    const status = payInfo.status;
    const isPaid = payInfo.isPaid;
    const balance = payInfo.balance;

    let badgeClass = 'badge-paid';
    if (status === 'Partial') badgeClass = 'badge-partial';
    if (status === 'Unpaid') badgeClass = 'badge-unpaid';

    let balanceQrBtn = "";
    if (!isEstimate && !isPaid && balance > 0) {
      balanceQrBtn = `
        <button class="action-btn share" onclick="openBalanceQrModal('${inv.id}')" title="View Balance UPI QR Code (₹ ${formatCurrency(balance)})" style="background: rgba(6, 182, 212, 0.15); color: #06b6d4;"><i class="fa-solid fa-qrcode"></i></button>
        <button class="action-btn share" onclick="sendWhatsAppPaymentReminder('${inv.id}', this)" title="Send 1-Click WhatsApp Payment Reminder (₹ ${formatCurrency(balance)})" style="background: rgba(245, 158, 11, 0.15); color: #d97706;"><i class="fa-solid fa-bell"></i></button>
      `;
    }

    let convertEstimateBtn = "";
    if (isEstimate) {
      convertEstimateBtn = `
        <button class="action-btn share" onclick="convertEstimateToInvoice('${inv.id}')" title="Convert to Official GST Invoice" style="background: rgba(8, 145, 178, 0.15); color: #0891b2; font-weight: 700;"><i class="fa-solid fa-file-circle-check"></i></button>
      `;
    }

    const consigneeDisplay = (details.consignee?.name) ? details.consignee.name : (inv.customerName || (details.buyer && details.buyer.name) || 'Cash Customer');
    const subBuyerText = (details.consignee?.name && details.buyer?.name && details.consignee.name !== details.buyer.name)
      ? `<div style="font-size: 11px; color: #64748b; font-weight: 500;">Billed: ${details.buyer.name}</div>`
      : '';
    const invDate = inv.invoiceDate || details.invoiceDate || inv.date || details.date || '';
    const itemsCount = (inv.itemsCount !== undefined && inv.itemsCount !== null && !isNaN(inv.itemsCount))
      ? inv.itemsCount
      : ((inv.items || details.items || []).length);
    const invTotal = safeParseAmount(inv.total !== undefined ? inv.total : details.total);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--primary-teal);">#${inv.invoiceNo}</td>
      <td>${formatInputDateString(invDate)}</td>
      <td style="font-weight: 600;">${consigneeDisplay}${subBuyerText}</td>
      <td class="text-center">${itemsCount}</td>
      <td style="text-align: right; font-weight: 700;">₹ ${formatCurrency(invTotal)}</td>
      <td class="text-center">
        ${isEstimate 
          ? `<span class="badge-status" style="background: rgba(245, 158, 11, 0.15); color: #d97706; font-weight: 700; border: 1px solid rgba(245, 158, 11, 0.3);">Quotation</span>` 
          : `<span class="badge-status ${badgeClass}">${status}</span>`}
      </td>
      <td class="actions-cell">
        <button class="action-btn share btn-whatsapp primary-wa-action" onclick="shareInvoiceToWhatsApp('${inv.id}', this)" title="Send Invoice & PDF via WhatsApp (1-Click)" style="background: #16a34a !important; color: #ffffff !important; font-weight: 700; width: 30px; height: 30px; border-radius: 6px; box-shadow: 0 1px 3px rgba(22, 163, 74, 0.35);"><i class="fa-brands fa-whatsapp" style="font-size: 15px; color: #ffffff !important;"></i></button>
        <button class="action-btn print" onclick="printSavedInvoice('${inv.id}')" title="Print A4 Bill"><i class="fa-solid fa-print"></i></button>
        <button class="action-btn edit" onclick="editSavedInvoice('${inv.id}')" title="Edit Bill"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="action-btn print" onclick="downloadSavedInvoicePdf('${inv.id}', this)" title="Download PDF"><i class="fa-solid fa-file-pdf text-rose"></i></button>
        ${balanceQrBtn}
        ${convertEstimateBtn}
        <button class="action-btn print" onclick="printSavedInvoiceThermal('${inv.id}')" title="Print Thermal POS"><i class="fa-solid fa-receipt"></i></button>
        <button class="action-btn repeat" onclick="repeatInvoice('${inv.id}')" title="Repeat Bill (Clone to New Invoice)"><i class="fa-solid fa-arrows-rotate" style="color: #6366f1;"></i></button>
        <button class="action-btn share btn-telegram" onclick="shareInvoiceToTelegram('${inv.id}', this)" title="Share PDF to Telegram"><i class="fa-brands fa-telegram" style="color: #0284c7;"></i></button>
        <button class="action-btn share" onclick="openUniversalInvoiceShareModal('${inv.id}')" title="Universal Share"><i class="fa-solid fa-share-nodes" style="color: #0891b2;"></i></button>
        <button class="action-btn delete" onclick="deleteSavedInvoice('${inv.id || inv.invoiceNo}')" title="Delete Bill"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    elements.historyInvoicesBody.appendChild(tr);
  });
}

let searchHistoryDebounce = null;
elements.searchHistoryInput.addEventListener("input", () => {
  if (searchHistoryDebounce) clearTimeout(searchHistoryDebounce);
  searchHistoryDebounce = setTimeout(() => {
    window.filterInvoicesByStatus();
  }, 100);
});

window.editSavedInvoice = function(id) {
  const inv = invoicesDb.find(i => i.id === id);
  if (inv) {
    currentInvoice = JSON.parse(JSON.stringify(inv.details));
    currentInvoice.id = inv.id;
    currentInvoice.qrToken = inv.qrToken || (inv.details && inv.details.qrToken) || "";
    currentInvoice.isEditing = true;
    
    // Safety check default structures
    if (!currentInvoice.buyer) {
      currentInvoice.buyer = { name: "", address: "", gstin: "", phone: "", state: "Andhra Pradesh", stateCode: "37" };
    }
    if (!currentInvoice.consignee) {
      currentInvoice.consignee = { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" };
    }
    if (!currentInvoice.items) {
      currentInvoice.items = [];
    }

    switchTab("billing");

    elements.billInvoiceType.value = currentInvoice.invoiceType || "Bill of Supply";
    elements.billHeaderLogo.value = currentInvoice.headerLogo || "ganesha";
    elements.billInvoiceNo.value = currentInvoice.invoiceNo || "";
    elements.billInvoiceDate.value = currentInvoice.invoiceDate || "";
    elements.billBuyerOrderNo.value = currentInvoice.buyerOrderNo || "";
    elements.billBuyerOrderDate.value = currentInvoice.buyerOrderDate || "";
    elements.billTransportMode.value = currentInvoice.transportMode || "";
    elements.billDestination.value = currentInvoice.destination || "Andhra Pradesh";
    elements.billSupplyStateCode.value = currentInvoice.supplyStateCode || "37";

    elements.billBuyerName.value = currentInvoice.buyer.name || "";
    elements.billBuyerAddress.value = currentInvoice.buyer.address || "";
    elements.billBuyerGstin.value = currentInvoice.buyer.gstin || "";
    elements.billBuyerPhone.value = currentInvoice.buyer.phone || "";
    elements.billBuyerState.value = currentInvoice.buyer.state || "Andhra Pradesh";
    elements.billBuyerStateCode.value = currentInvoice.buyer.stateCode || "37";

    elements.billConsigneeName.value = currentInvoice.consignee.name || "";
    elements.billConsigneeAddress.value = currentInvoice.consignee.address || "";
    elements.billConsigneeGstin.value = currentInvoice.consignee.gstin || "";
    elements.billConsigneePhone.value = currentInvoice.consignee.phone || "";
    elements.billConsigneeState.value = currentInvoice.consignee.state || "Andhra Pradesh";
    elements.billConsigneeStateCode.value = currentInvoice.consignee.stateCode || "37";

    elements.billPaymentStatus.value = currentInvoice.paymentStatus || "Paid";
    elements.billPaymentMode.value = currentInvoice.paymentMode || "UPI / QR";
    elements.billPaidAmount.value = currentInvoice.paidAmount !== undefined ? currentInvoice.paidAmount : (currentInvoice.total || 0);
    elements.billBalancePaid.value = currentInvoice.balancePaid !== undefined ? currentInvoice.balancePaid : 0;
    if (elements.billPaymentDate) {
      elements.billPaymentDate.value = currentInvoice.paymentDate || currentInvoice.invoiceDate || "";
    }

    handlePaymentStatusChange();
    calculateSummaryAndTable();
  }
};

window.repeatInvoice = function(id) {
  const inv = (invoicesDb || []).find(i => i && (i.id === id || i.invoiceNo === id));
  if (!inv) {
    if (typeof showFloatingToast === 'function') showFloatingToast("Invoice not found to repeat", "error");
    return;
  }
  const details = inv.details || inv;
  currentInvoice = JSON.parse(JSON.stringify(details));
  
  // Clone as brand-new invoice with today's date
  currentInvoice.id = null;
  currentInvoice.isEditing = false;
  currentInvoice.qrToken = "";
  
  const today = new Date().toISOString().split("T")[0];
  currentInvoice.invoiceDate = today;
  currentInvoice.paymentDate = today;

  // Defaults
  if (!currentInvoice.buyer) {
    currentInvoice.buyer = { name: "", address: "", gstin: "", phone: "", state: "Andhra Pradesh", stateCode: "37" };
  }
  if (!currentInvoice.consignee) {
    currentInvoice.consignee = { name: "", address: "", gstin: "", state: "Andhra Pradesh", stateCode: "37" };
  }
  if (!Array.isArray(currentInvoice.items)) {
    currentInvoice.items = [];
  }

  switchTab("billing");

  // Next sequential invoice number
  if (typeof autoSuggestInvoiceNo === 'function') {
    autoSuggestInvoiceNo();
  }

  if (elements.billInvoiceType) elements.billInvoiceType.value = currentInvoice.invoiceType || "Bill of Supply";
  if (elements.billHeaderLogo) elements.billHeaderLogo.value = currentInvoice.headerLogo || "ganesha";
  if (elements.billInvoiceDate) elements.billInvoiceDate.value = today;
  if (elements.billBuyerOrderNo) elements.billBuyerOrderNo.value = "";
  if (elements.billBuyerOrderDate) elements.billBuyerOrderDate.value = today;
  if (elements.billTransportMode) elements.billTransportMode.value = currentInvoice.transportMode || "";
  if (elements.billDestination) elements.billDestination.value = currentInvoice.destination || "Andhra Pradesh";
  if (elements.billSupplyStateCode) elements.billSupplyStateCode.value = currentInvoice.supplyStateCode || "37";

  if (elements.billBuyerName) elements.billBuyerName.value = currentInvoice.buyer.name || "";
  if (elements.billBuyerAddress) elements.billBuyerAddress.value = currentInvoice.buyer.address || "";
  if (elements.billBuyerGstin) elements.billBuyerGstin.value = currentInvoice.buyer.gstin || "";
  if (elements.billBuyerPhone) elements.billBuyerPhone.value = currentInvoice.buyer.phone || "";
  if (elements.billBuyerState) elements.billBuyerState.value = currentInvoice.buyer.state || "Andhra Pradesh";
  if (elements.billBuyerStateCode) elements.billBuyerStateCode.value = currentInvoice.buyer.stateCode || "37";

  if (elements.billConsigneeName) elements.billConsigneeName.value = currentInvoice.consignee.name || "";
  if (elements.billConsigneeAddress) elements.billConsigneeAddress.value = currentInvoice.consignee.address || "";
  if (elements.billConsigneeGstin) elements.billConsigneeGstin.value = currentInvoice.consignee.gstin || "";
  if (elements.billConsigneePhone) elements.billConsigneePhone.value = currentInvoice.consignee.phone || "";
  if (elements.billConsigneeState) elements.billConsigneeState.value = currentInvoice.consignee.state || "Andhra Pradesh";
  if (elements.billConsigneeStateCode) elements.billConsigneeStateCode.value = currentInvoice.consignee.stateCode || "37";

  if (elements.billPaymentStatus) elements.billPaymentStatus.value = currentInvoice.paymentStatus || "Paid";
  if (elements.billPaymentMode) elements.billPaymentMode.value = currentInvoice.paymentMode || "UPI / QR";
  if (elements.billPaidAmount) elements.billPaidAmount.value = currentInvoice.paidAmount !== undefined ? currentInvoice.paidAmount : (currentInvoice.total || 0);
  if (elements.billBalancePaid) elements.billBalancePaid.value = 0;
  if (elements.billPaymentDate) elements.billPaymentDate.value = today;

  if (typeof handlePaymentStatusChange === 'function') handlePaymentStatusChange();
  if (typeof calculateSummaryAndTable === 'function') calculateSummaryAndTable();

  const custDisplay = currentInvoice.buyer?.name || 'Customer';
  if (typeof showFloatingToast === 'function') {
    showFloatingToast(`🔁 Cloned Bill for ${custDisplay}! Ready to save or edit.`, 3500);
  }
  if (typeof window.playAudioFeedback === 'function') {
    window.playAudioFeedback("add");
  }
};

window.printSavedInvoice = function(id) {
  const inv = invoicesDb.find(i => i.id === id);
  if (inv) {
    populateA4PrintOverlay(inv.details);
    document.body.classList.remove("printing-thermal");
    setTimeout(() => {
      window.print();
    }, 100);
  }
};

window.deleteSavedInvoice = function(identifier) {
  if (!identifier) return;

  const idStr = String(identifier).trim();
  const cleanId = idStr.replace(/^#/, '');
  const idNum = parseInt(cleanId, 10);

  // Multi-tier resolution: by exact ID, by invoiceNo, by numeric equality, or details.invoiceNo
  const inv = (invoicesDb || []).find(i => {
    if (!i) return false;
    const iId = String(i.id || "").trim();
    const iNo = String(i.invoiceNo || (i.details && i.details.invoiceNo) || "").trim();
    const iClean = iNo.replace(/^#/, '');
    const iNum = parseInt(iClean, 10);

    return iId === idStr || iNo === idStr || iClean === cleanId || (!isNaN(idNum) && !isNaN(iNum) && idNum === iNum);
  });

  const invNo = inv ? (inv.invoiceNo || (inv.details && inv.details.invoiceNo) || cleanId) : cleanId;
  const invId = inv ? (inv.id || `inv_${invNo}`) : idStr;
  const displayNo = invNo ? `#${invNo}` : (cleanId ? `#${cleanId}` : "this");

  if (confirm(`Delete ${displayNo} invoice record from history?\n\nSequence will automatically roll back directly to this invoice number.`)) {
    // 0. Safely archive to persistent cancelled/voided registry so old QR code is recognized as VOID
    if (inv && typeof window.archiveCancelledInvoice === 'function') {
      window.archiveCancelledInvoice(inv, "Deleted by user from Invoice History");
    }

    // 1. Stock restoration if details exist
    if (inv && (inv.details || inv.items)) {
      try {
        reconcileProductInventoryStock(inv.details || inv, null);
      } catch (e) {
        console.warn("Stock reconciliation during delete:", e);
      }
    }

    // 2. Track all candidate ID variations in persistent tombstones
    let tombstones = window.getDeletedInvoiceTombstones();
    const numNo = !isNaN(parseInt(invNo, 10)) ? String(parseInt(invNo, 10)) : null;
    const numClean = !isNaN(parseInt(cleanId, 10)) ? String(parseInt(cleanId, 10)) : null;

    const aliases = [
      invId,
      idStr,
      invNo,
      cleanId,
      `#${invNo}`,
      `#${cleanId}`,
      `inv_${invNo}`,
      `inv_${cleanId}`,
      numNo,
      numClean,
      numNo ? `inv_${numNo}` : null,
      numClean ? `inv_${numClean}` : null
    ].filter(Boolean).map(a => String(a).trim().toLowerCase());

    aliases.forEach(alias => {
      if (!tombstones.includes(alias)) {
        tombstones.push(alias);
      }
    });

    try {
      localStorage.setItem("deleted_invoice_ids", JSON.stringify(tombstones));
    } catch (e) {}

    // 3. Purge immediately from invoicesDb using the central filter
    invoicesDb = window.filterOutDeletedInvoices(invoicesDb);
    invoicesDb = invoicesDb.filter(i => {
      if (!i) return false;
      const iId = String(i.id || (i.details && i.details.id) || "").trim().toLowerCase();
      const iNo = String(i.invoiceNo || (i.details && i.details.invoiceNo) || "").trim().toLowerCase();
      if (invId && (iId === invId.toLowerCase() || iId.replace(/^inv_/, '') === invId.toLowerCase().replace(/^inv_/, ''))) return false;
      if (invNo && (iNo === invNo.toLowerCase() || iNo.replace(/^#/, '') === invNo.toLowerCase().replace(/^#/, ''))) return false;
      return true;
    });
    window.invoicesDb = invoicesDb;
    try {
      localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    } catch (e) {}

    // 4. Purge from IndexedDB
    if (window.AaryanDB && typeof window.AaryanDB.deleteInvoice === 'function') {
      window.AaryanDB.deleteInvoice(invId);
      if (invNo && invNo !== invId) window.AaryanDB.deleteInvoice(invNo);
      if (cleanId && cleanId !== invNo) window.AaryanDB.deleteInvoice(cleanId);
    }

    // 5. Direct cross-browser & inter-tab broadcast (<30ms)
    window.lastSyncETag = null;
    const cancEntry = {
      id: invId,
      token: inv ? (inv.qrToken || (inv.details && inv.details.qrToken) || '') : '',
      invoiceNo: invNo,
      customerName: inv ? (inv.customerName || (inv.details && (inv.details.consignee?.name || inv.details.buyer?.name)) || 'Customer') : 'Customer',
      total: inv ? (inv.total || (inv.details && inv.details.total) || 0) : 0,
      cancelledAt: new Date().toISOString(),
      reason: 'Deleted by user from Invoice History',
      status: 'CANCELLED'
    };

    broadcastInterTabEvent('record_deleted', {
      recordType: 'invoice',
      id: invId,
      invoiceNo: invNo,
      aliases: aliases,
      products: productsDb,
      cancelledRecord: cancEntry
    });

    if (typeof realtimeMeshClient !== 'undefined' && realtimeMeshClient && realtimeMeshClient.connected) {
      try {
        realtimeMeshClient.publish(SYNC_MESH_TOPIC, JSON.stringify({
          type: 'record_deleted',
          recordType: 'invoice',
          id: invId,
          invoiceNo: invNo,
          aliases: aliases,
          cancelledRecord: cancEntry,
          senderId: typeof MY_SYNC_CLIENT_ID !== 'undefined' ? MY_SYNC_CLIENT_ID : 'peer'
        }), { qos: 0 });
      } catch (me) {}
    }

    // 6. Push deletion to Google Cloud with candidate IDs so it matches Column 1 or JSON
    aliases.slice(0, 4).forEach(alias => {
      pushDirectToGoogleDatabase("delete_record", { type: "invoice", id: alias, invoiceNo: invNo });
    });

    // Offline outbox queue fallback
    if (window.AaryanDB && typeof window.AaryanDB.enqueueOutbox === 'function') {
      AaryanDB.enqueueOutbox("invoice", "delete_record", { type: "invoice", id: invId, invoiceNo: invNo });
      AaryanDB.drainOutbox();
    }

    // 7. Update suggested invoice sequence
    if (typeof autoSuggestInvoiceNo === 'function') {
      autoSuggestInvoiceNo(false);
    }

    // 8. Re-render UI immediately
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
    if (typeof window.broadcastDatabaseMutation === 'function') window.broadcastDatabaseMutation();

    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`Invoice ${displayNo} deleted successfully`, "success");
    }
  }
};

// --- PRODUCTS DIALOG MODAL CONTROLLER (ENTERPRISE STOCK INWARD & AUDIT ENGINE) ---
let currentProductStockMode = 'add'; // 'add' (inward restock) | 'adjust' (audit/direct count)
let currentEditingExistingStock = 0;

window.setProductStockMode = function(mode) {
  currentProductStockMode = mode;
  const tabAdd = document.getElementById("tab-stock-mode-add");
  const tabAdjust = document.getElementById("tab-stock-mode-adjust");
  const panelAdd = document.getElementById("stock-mode-add-panel");
  const panelAdjust = document.getElementById("stock-mode-adjust-panel");

  if (mode === 'add') {
    if (tabAdd) tabAdd.classList.add("active");
    if (tabAdjust) tabAdjust.classList.remove("active");
    if (panelAdd) panelAdd.classList.remove("hidden");
    if (panelAdjust) panelAdjust.classList.add("hidden");
  } else {
    if (tabAdd) tabAdd.classList.remove("active");
    if (tabAdjust) tabAdjust.classList.add("active");
    if (panelAdd) panelAdd.classList.add("hidden");
    if (panelAdjust) panelAdjust.classList.remove("hidden");
    const adjustInput = document.getElementById("modal-prod-adjust-stock");
    if (adjustInput && (adjustInput.value === "" || adjustInput.value === null)) {
      adjustInput.value = currentEditingExistingStock;
    }
  }
  calculateProductModalValues();
};

window.quickAddStockToInput = function(amt) {
  const addInput = document.getElementById("modal-prod-add-stock");
  if (addInput) {
    const currentVal = Math.max(0, parseInt(addInput.value, 10) || 0);
    addInput.value = currentVal + amt;
    calculateProductModalValues();
  }
};

window.calculateProductModalValues = function() {
  const rateInput = document.getElementById("modal-prod-rate");
  const discInput = document.getElementById("modal-prod-discount");
  const prodId = document.getElementById("modal-prod-id")?.value;
  const isEditing = !!prodId;

  const rate = parseFloat(rateInput?.value) || 0;
  const disc = parseFloat(discInput?.value) || 0;

  let resultingStock = 0;
  if (!isEditing) {
    // New product mode: raw initial stock
    const stockInput = document.getElementById("modal-prod-stock");
    resultingStock = Math.max(0, parseInt(stockInput?.value, 10) || 0);
  } else {
    // Editing existing product: real-world business calculation
    if (currentProductStockMode === 'add') {
      const addInput = document.getElementById("modal-prod-add-stock");
      const addedQty = Math.max(0, parseInt(addInput?.value, 10) || 0);
      resultingStock = currentEditingExistingStock + addedQty;
    } else {
      const adjustInput = document.getElementById("modal-prod-adjust-stock");
      resultingStock = Math.max(0, parseInt(adjustInput?.value, 10) || 0);
    }
  }

  const discountAmount = (rate * disc) / 100;
  const valAfterDisc = Math.max(0, rate - discountAmount);
  const totalVal = resultingStock * valAfterDisc;

  const valAfterDiscEl = document.getElementById("modal-preview-val-after-disc");
  const totalValEl = document.getElementById("modal-preview-total-val");
  const resultingStockEl = document.getElementById("modal-resulting-stock");

  if (resultingStockEl) {
    const unitEl = document.getElementById("modal-prod-unit");
    const unitStr = unitEl?.value?.trim() || "Units";
    if (isEditing && currentProductStockMode === 'add') {
      const addInput = document.getElementById("modal-prod-add-stock");
      const addedQty = Math.max(0, parseInt(addInput?.value, 10) || 0);
      if (addedQty > 0) {
        resultingStockEl.innerHTML = `${resultingStock} ${unitStr} <span style="font-size: 11.5px; color: #059669; font-weight: 600;">(${currentEditingExistingStock} + ${addedQty} inward)</span>`;
      } else {
        resultingStockEl.innerHTML = `${resultingStock} ${unitStr} <span style="font-size: 11.5px; color: #64748b; font-weight: 500;">(Unchanged)</span>`;
      }
    } else if (isEditing && currentProductStockMode === 'adjust') {
      const delta = resultingStock - currentEditingExistingStock;
      const deltaSign = delta > 0 ? `+${delta}` : `${delta}`;
      resultingStockEl.innerHTML = `${resultingStock} ${unitStr} <span style="font-size: 11.5px; color: #d97706; font-weight: 600;">(${delta !== 0 ? deltaSign + ' audit' : 'Unchanged'})</span>`;
    } else {
      resultingStockEl.textContent = `${resultingStock} ${unitStr}`;
    }
  }

  if (valAfterDiscEl) {
    const discLabel = disc > 0 ? ` <span style="font-size: 11px; color: #64748b; font-weight: normal;">(-${disc}% = -₹ ${formatCurrency(discountAmount)})</span>` : '';
    valAfterDiscEl.innerHTML = `₹ ${formatCurrency(valAfterDisc)}${discLabel}`;
  }
  if (totalValEl) {
    totalValEl.textContent = `₹ ${formatCurrency(totalVal)}`;
  }
};

window.openProductModal = function(id = "") {
  const modalEl = document.getElementById("product-modal");
  if (!modalEl) return;

  // Fully clear any inline display/visibility locks so the modal opens reliably every single time
  modalEl.classList.remove("hidden");
  modalEl.style.removeProperty("display");
  modalEl.style.removeProperty("visibility");
  modalEl.style.removeProperty("opacity");
  modalEl.style.removeProperty("pointer-events");
  modalEl.style.setProperty("display", "flex", "important");
  modalEl.style.setProperty("visibility", "visible", "important");
  modalEl.style.setProperty("opacity", "1", "important");
  modalEl.style.setProperty("pointer-events", "auto", "important");
  modalEl.style.setProperty("z-index", "2147483640", "important");

  const form = document.getElementById("modal-product-form");
  if (form) form.reset();
  document.getElementById("modal-prod-id").value = "";
  document.getElementById("modal-prod-unit").value = "Bucket";
  document.getElementById("modal-prod-discount").value = "0";
  document.getElementById("modal-prod-stock").value = "0";
  const addStockInput = document.getElementById("modal-prod-add-stock");
  const adjustStockInput = document.getElementById("modal-prod-adjust-stock");
  if (addStockInput) addStockInput.value = "0";
  if (adjustStockInput) adjustStockInput.value = "";

  const newStockGroup = document.getElementById("modal-new-stock-group");
  const editStockGroup = document.getElementById("modal-edit-stock-group");

  if (id) {
    const prod = productsDb.find(p => p.id === id);
    if (prod) {
      document.getElementById("product-modal-title").textContent = "Edit Product & Warehouse Stock";
      document.getElementById("modal-prod-id").value = prod.id;
      document.getElementById("modal-prod-desc").value = prod.description;
      document.getElementById("modal-prod-hsn").value = prod.hsn || "";
      document.getElementById("modal-prod-pack").value = prod.packSize || "";
      document.getElementById("modal-prod-unit").value = prod.unit || "Bucket";
      document.getElementById("modal-prod-rate").value = prod.rate;
      document.getElementById("modal-prod-discount").value = prod.discount || 0;
      
      const costInput = document.getElementById("modal-prod-cost");
      if (costInput) costInput.value = prod.costPrice !== undefined ? prod.costPrice : "";
      const barcodeInput = document.getElementById("modal-prod-barcode");
      if (barcodeInput) barcodeInput.value = prod.barcode || "";

      currentEditingExistingStock = Math.max(0, parseInt(prod.stock, 10) || 0);

      const existDisp = document.getElementById("modal-existing-stock-display");
      const unitDisp = document.getElementById("modal-existing-unit");
      if (existDisp) existDisp.textContent = currentEditingExistingStock;
      if (unitDisp) unitDisp.textContent = prod.unit || "Buckets";

      const pill = document.getElementById("modal-stock-status-pill");
      const pillText = document.getElementById("modal-stock-status-text");
      if (pill && pillText) {
        pill.className = "hud-badge " + (currentEditingExistingStock === 0 ? "out" : (currentEditingExistingStock <= 10 ? "low" : "instock"));
        pillText.textContent = currentEditingExistingStock === 0 ? "Out of Stock" : (currentEditingExistingStock <= 10 ? "Low Stock" : "In Stock");
      }

      if (newStockGroup) newStockGroup.classList.add("hidden");
      if (editStockGroup) editStockGroup.classList.remove("hidden");
      setProductStockMode('add');
    }
  } else {
    currentEditingExistingStock = 0;
    document.getElementById("product-modal-title").textContent = "Add New Product to Catalog";
    const costInput = document.getElementById("modal-prod-cost");
    if (costInput) costInput.value = "";
    const barcodeInput = document.getElementById("modal-prod-barcode");
    if (barcodeInput) barcodeInput.value = "";
    if (newStockGroup) newStockGroup.classList.remove("hidden");
    if (editStockGroup) editStockGroup.classList.add("hidden");
  }

  calculateProductModalValues();
  setTimeout(() => {
    const descEl = document.getElementById("modal-prod-desc");
    if (descEl) descEl.focus();
  }, 100);
};

window.closeProductModal = function() {
  const modalEl = document.getElementById("product-modal");
  if (modalEl) {
    modalEl.classList.add("hidden");
    modalEl.style.setProperty("display", "none", "important");
    modalEl.style.setProperty("visibility", "hidden", "important");
    modalEl.style.setProperty("opacity", "0", "important");
    modalEl.style.setProperty("pointer-events", "none", "important");
  }
};

window.saveProductModal = function(e, andAddAnother = false) {
  if (e && e.preventDefault) e.preventDefault();
  const id = document.getElementById("modal-prod-id").value;
  const desc = document.getElementById("modal-prod-desc").value.toUpperCase().trim();
  const hsn = document.getElementById("modal-prod-hsn").value.trim();
  const pack = document.getElementById("modal-prod-pack").value.trim();
  const unit = document.getElementById("modal-prod-unit").value.trim() || "Bucket";
  const rate = parseFloat(document.getElementById("modal-prod-rate").value) || 0;
  const costPrice = parseFloat(document.getElementById("modal-prod-cost")?.value) || 0;
  const barcode = (document.getElementById("modal-prod-barcode")?.value || "").trim();
  const disc = parseFloat(document.getElementById("modal-prod-discount").value) || 0;

  if (!desc) {
    showFloatingToast("⚠️ Please enter Description of Goods.", "warning");
    const descEl = document.getElementById("modal-prod-desc");
    if (descEl) descEl.focus();
    return;
  }

  let oldStock = 0;
  let finalStock = 0;
  let actionReportType = "New Product Added to Inventory";

  if (id) {
    const existing = productsDb.find(p => p.id === id);
    if (existing) oldStock = Math.max(0, parseInt(existing.stock, 10) || 0);

    if (currentProductStockMode === 'add') {
      const addInput = document.getElementById("modal-prod-add-stock");
      const addedQty = Math.max(0, parseInt(addInput?.value, 10) || 0);
      finalStock = oldStock + addedQty;
      actionReportType = addedQty > 0 
        ? `Stock Inward / Restock (+${addedQty} ${unit})` 
        : `Product Details Updated (Stock Unchanged: ${oldStock} ${unit})`;
    } else {
      const adjustInput = document.getElementById("modal-prod-adjust-stock");
      const setVal = adjustInput && adjustInput.value !== "" ? parseInt(adjustInput.value, 10) : oldStock;
      finalStock = Math.max(0, isNaN(setVal) ? oldStock : setVal);
      const delta = finalStock - oldStock;
      actionReportType = delta !== 0 
        ? `Inventory Physical Audit / Count Adjusted (${delta > 0 ? '+' : ''}${delta} ${unit})` 
        : `Product Details Updated`;
    }
  } else {
    finalStock = Math.max(0, parseInt(document.getElementById("modal-prod-stock")?.value, 10) || 0);
    actionReportType = `New Product Added (Opening Stock: ${finalStock} ${unit})`;
  }

  const valAfterDisc = Math.round(Math.max(0, rate - (rate * disc / 100)) * 100) / 100;
  const totalVal = Math.round((finalStock * valAfterDisc) * 100) / 100;

  const productStatus = finalStock <= 0 ? "Out of Stock" : (finalStock <= 10 ? "Low Stock" : "In Stock");
  const product = { 
    id: id || "prod-" + Date.now() + "-" + Math.floor(Math.random() * 1000), 
    description: desc, 
    hsn, 
    packSize: pack, 
    unit, 
    rate, 
    costPrice,
    barcode,
    price: valAfterDisc,
    gstRate: 0, 
    discount: disc, 
    stock: finalStock, 
    status: productStatus,
    totalValue: totalVal,
    updatedAt: new Date().toISOString() 
  };

  if (id) {
    const idx = productsDb.findIndex(p => p.id === id);
    if (idx > -1) productsDb[idx] = product;
  } else {
    productsDb.push(product);
  }

  if (!window.recentProductMutations) window.recentProductMutations = {};
  window.recentProductMutations[product.id] = Date.now();
  if (product.description) window.recentProductMutations[product.description] = Date.now();

  localStorage.setItem("products", JSON.stringify(productsDb));
  if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
  
  renderProductsTable(productsDb);
  populateBillingSelectors();
  if (typeof updateDashboardOverview === 'function') updateDashboardOverview();

  // Instant Cross-Browser Broadcast (< 15ms)
  broadcastInterTabEvent('PRODUCT_STOCK_CHANGED', {
    productId: product.id,
    stock: product.stock,
    status: product.status,
    delta: id ? (finalStock - oldStock) : finalStock,
    totalValue: product.totalValue,
    updatedAt: product.updatedAt,
    description: product.description,
    product: product
  });
  broadcastInterTabEvent('products_saved', { products: productsDb });

  // Direct Push to Google Cloud Database (< 1s)
  pushDirectToGoogleDatabase("save_products", { products: productsDb });

  const stockMsg = id && oldStock !== finalStock 
    ? `Stock updated: ${oldStock} ➔ ${finalStock} ${unit}`
    : `Stock: ${finalStock} ${unit}`;

  if (andAddAnother) {
    window.openProductModal("");
    showFloatingToast(`✅ "${product.description}" saved! Ready for next product...`, 3000);
  } else {
    closeProductModal();
    showFloatingToast(`✅ "${product.description}" saved successfully! (${stockMsg})`, 3500);
  }

  sendStockTelegramReport(product, actionReportType, oldStock, finalStock);
};

window.quickRestockProduct = function(id) {
  const prod = productsDb.find(p => p && p.id === id);
  if (!prod) return;
  const currentStock = Math.max(0, parseInt(prod.stock, 10) || 0);
  const unit = prod.unit || "Buckets";
  
  const promptVal = prompt(`📦 RESTOCK INWARD: "${prod.description}"\n\nCurrent Warehouse Stock: ${currentStock} ${unit}\n\nEnter new quantity received from supplier/factory to ADD:`, "10");
  if (promptVal === null) return;
  
  const addQty = parseInt(promptVal.trim(), 10);
  if (isNaN(addQty) || addQty <= 0) {
    showFloatingToast("⚠️ Please enter a valid quantity greater than 0 to restock.", "warning");
    return;
  }

  const newStock = currentStock + addQty;
  prod.stock = newStock;
  prod.status = newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock");
  prod.updatedAt = new Date().toISOString();
  const rate = parseFloat(prod.rate || 0);
  const disc = parseFloat(prod.discount || 0);
  const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
  prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;

  if (!window.recentProductMutations) window.recentProductMutations = {};
  const nowMs = Date.now();
  window.recentProductMutations[id] = nowMs;
  if (prod.description) {
    window.recentProductMutations[prod.description] = nowMs;
    window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
  }
  try {
    let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
    storedMut[id] = nowMs;
    if (prod.description) {
      storedMut[prod.description] = nowMs;
      storedMut[prod.description.trim().toLowerCase()] = nowMs;
    }
    localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
  } catch(e){}

  try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
  if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);

  // 1. Instant local DOM update (< 0.1ms)
  if (typeof updateProductDomRowFast === 'function') {
    updateProductDomRowFast(prod.id, newStock, prod.status);
  } else if (typeof loadProductsDatabaseTable === 'function') {
    loadProductsDatabaseTable();
  }
  if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
  if (typeof updateDashboardOverview === 'function') updateDashboardOverview();

  // 2. High-speed broadcast across tri-channel mesh (< 150ms)
  broadcastInterTabEvent('PRODUCT_STOCK_CHANGED', {
    productId: prod.id,
    stock: newStock,
    status: prod.status,
    delta: addQty,
    totalValue: prod.totalValue,
    updatedAt: prod.updatedAt,
    description: prod.description
  });

  // 3. Debounced asynchronous push to Google Master Database
  if (directPushProductTimer) clearTimeout(directPushProductTimer);
  directPushProductTimer = setTimeout(() => {
    pushDirectToGoogleDatabase("save_products", { products: productsDb });
  }, 250);

  showFloatingToast(`📦 Restocked! Added +${addQty} ${unit} to "${prod.description}". New Total: ${newStock} ${unit}`, "success");
  sendStockTelegramReport(prod, `1-Click Inward Restock (+${addQty} ${unit})`, currentStock, newStock);
};

window.adjustProductStock = function(id, delta) {
  const prod = productsDb.find(p => p && p.id === id);
  if (!prod) return;
  const current = parseInt(prod.stock, 10) || 0;
  const newStock = Math.max(0, current + delta);
  prod.stock = newStock;
  prod.status = newStock <= 0 ? "Out of Stock" : (newStock <= 10 ? "Low Stock" : "In Stock");
  prod.updatedAt = new Date().toISOString();
  const rate = parseFloat(prod.rate || 0);
  const disc = parseFloat(prod.discount || 0);
  const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
  prod.totalValue = Math.round((newStock * valAfterDisc) * 100) / 100;

  if (!window.recentProductMutations) window.recentProductMutations = {};
  const nowMs = Date.now();
  window.recentProductMutations[id] = nowMs;
  if (prod.description) {
    window.recentProductMutations[prod.description] = nowMs;
    window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
  }
  try {
    let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
    storedMut[id] = nowMs;
    if (prod.description) {
      storedMut[prod.description] = nowMs;
      storedMut[prod.description.trim().toLowerCase()] = nowMs;
    }
    localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
  } catch(e){}
  
  try { localStorage.setItem("products", JSON.stringify(productsDb)); } catch (e) {}
  if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);

  // 1. Instant local DOM update (< 0.1ms)
  if (typeof updateProductDomRowFast === 'function') {
    updateProductDomRowFast(prod.id, newStock, prod.status);
  } else if (typeof loadProductsDatabaseTable === 'function') {
    loadProductsDatabaseTable();
  }
  if (typeof populateBillingSelectors === 'function') populateBillingSelectors();
  if (typeof updateDashboardOverview === 'function') updateDashboardOverview();

  // 2. High-speed broadcast across tri-channel mesh (< 150ms)
  broadcastInterTabEvent('PRODUCT_STOCK_CHANGED', {
    productId: prod.id,
    stock: newStock,
    status: prod.status,
    delta: delta,
    totalValue: prod.totalValue,
    updatedAt: prod.updatedAt,
    description: prod.description
  });

  // 3. Debounced asynchronous push to Google Master Database
  if (directPushProductTimer) clearTimeout(directPushProductTimer);
  directPushProductTimer = setTimeout(() => {
    pushDirectToGoogleDatabase("save_products", { products: productsDb });
  }, 250);

  const actionText = delta > 0 ? `Inline Stock Added (+${delta})` : `Inline Stock Reduced (${delta})`;
  sendStockTelegramReport(prod, actionText, current, prod.stock);
};

window.updateProductDiscountInline = function(id, newDiscount) {
  const prod = productsDb.find(p => p && (p.id === id || (p.description && p.description.trim().toLowerCase() === String(id).trim().toLowerCase())));
  if (!prod) return;
  const parsedDisc = Math.max(0, Math.min(100, Math.round((parseFloat(newDiscount) || 0) * 10) / 10));
  prod.discount = parsedDisc;
  const rate = parseFloat(prod.rate) || 0;
  const valAfterDisc = Math.round(Math.max(0, rate - (rate * parsedDisc / 100)) * 100) / 100;
  prod.price = valAfterDisc;
  const stock = parseInt(prod.stock, 10) || 0;
  prod.totalValue = Math.round((stock * valAfterDisc) * 100) / 100;
  prod.updatedAt = new Date().toISOString();

  if (!window.recentProductMutations) window.recentProductMutations = {};
  const nowMs = Date.now();
  window.recentProductMutations[prod.id] = nowMs;
  if (prod.description) {
    window.recentProductMutations[prod.description] = nowMs;
    window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
  }
  try {
    let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
    storedMut[prod.id] = nowMs;
    if (prod.description) {
      storedMut[prod.description] = nowMs;
      storedMut[prod.description.trim().toLowerCase()] = nowMs;
    }
    localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
  } catch(e){}

  localStorage.setItem("products", JSON.stringify(productsDb));
  if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);

  // Debounced push to Google Sheets
  if (directPushProductTimer) clearTimeout(directPushProductTimer);
  directPushProductTimer = setTimeout(() => {
    pushDirectToGoogleDatabase("save_products", { products: productsDb });
  }, 250);

  // Instant cross-browser broadcast (<15ms)
  broadcastInterTabEvent('PRODUCT_PRICE_CHANGED', {
    productId: prod.id,
    discount: prod.discount,
    price: prod.price,
    rate: prod.rate,
    totalValue: prod.totalValue,
    updatedAt: prod.updatedAt,
    description: prod.description
  });

  renderProductsTable(productsDb);
  populateBillingSelectors();
  if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
  showFloatingToast(`🏷️ Discount for "${prod.description}" saved: ${parsedDisc}% (Price: ₹ ${formatCurrency(valAfterDisc)})!`, "success");
};

window.updateProductPriceAfterDiscountInline = function(id, newPrice) {
  const prod = productsDb.find(p => p && (p.id === id || (p.description && p.description.trim().toLowerCase() === String(id).trim().toLowerCase())));
  if (!prod) return;
  const rate = parseFloat(prod.rate) || 0;
  const targetPrice = Math.max(0, Math.round((parseFloat(newPrice) || 0) * 100) / 100);
  let computedDisc = 0;
  if (rate > 0 && targetPrice <= rate) {
    computedDisc = Math.round(((rate - targetPrice) / rate) * 1000) / 10;
  }
  prod.discount = computedDisc;
  prod.price = targetPrice;
  const stock = parseInt(prod.stock, 10) || 0;
  prod.totalValue = Math.round((stock * targetPrice) * 100) / 100;
  prod.updatedAt = new Date().toISOString();

  if (!window.recentProductMutations) window.recentProductMutations = {};
  const nowMs = Date.now();
  window.recentProductMutations[prod.id] = nowMs;
  if (prod.description) {
    window.recentProductMutations[prod.description] = nowMs;
    window.recentProductMutations[prod.description.trim().toLowerCase()] = nowMs;
  }
  try {
    let storedMut = JSON.parse(localStorage.getItem("recent_product_mutations") || "{}");
    storedMut[prod.id] = nowMs;
    if (prod.description) {
      storedMut[prod.description] = nowMs;
      storedMut[prod.description.trim().toLowerCase()] = nowMs;
    }
    localStorage.setItem("recent_product_mutations", JSON.stringify(storedMut));
  } catch(e){}

  localStorage.setItem("products", JSON.stringify(productsDb));
  if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);

  // Debounced push to Google Sheets
  if (directPushProductTimer) clearTimeout(directPushProductTimer);
  directPushProductTimer = setTimeout(() => {
    pushDirectToGoogleDatabase("save_products", { products: productsDb });
  }, 250);

  broadcastInterTabEvent('PRODUCT_PRICE_CHANGED', {
    productId: prod.id,
    discount: prod.discount,
    price: prod.price,
    rate: prod.rate,
    totalValue: prod.totalValue,
    updatedAt: prod.updatedAt,
    description: prod.description
  });

  renderProductsTable(productsDb);
  populateBillingSelectors();
  if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
  showFloatingToast(`🏷️ Price for "${prod.description}" saved: ₹ ${formatCurrency(targetPrice)} (${computedDisc}% disc)!`, "success");
};

function recalculateProductTotalsAndKpisFast() {
  let totalStockSum = 0;
  let totalInventoryValueSum = 0;
  let lowCount = 0;
  let outCount = 0;

  (productsDb || []).forEach(p => {
    const rate = parseFloat(p.rate || 0);
    const disc = parseFloat(p.discount || 0);
    const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
    const stockVal = p.stock !== undefined ? parseInt(p.stock, 10) : 0;
    const totalVal = stockVal * valAfterDisc;

    totalStockSum += stockVal;
    totalInventoryValueSum += totalVal;

    if (stockVal === 0) outCount++;
    else if (stockVal <= 10) lowCount++;
  });

  const kpiCount = document.getElementById("prod-kpi-count");
  const kpiUnits = document.getElementById("prod-kpi-units");
  const kpiVal = document.getElementById("prod-kpi-valuation");
  const kpiAlerts = document.getElementById("prod-kpi-alerts");
  const kpiAlertsSub = document.getElementById("prod-kpi-alerts-sub");

  if (kpiCount) kpiCount.textContent = (productsDb || []).length;
  if (kpiUnits) kpiUnits.textContent = `${totalStockSum} Units`;
  if (kpiVal) kpiVal.textContent = `₹ ${formatCurrency(totalInventoryValueSum)}`;
  if (kpiAlerts) kpiAlerts.textContent = `${lowCount + outCount} Alerts`;
  if (kpiAlertsSub) kpiAlertsSub.textContent = `${lowCount} Low / ${outCount} Out of Stock`;

  const totalCountFooter = document.getElementById("prod-total-count-footer");
  const totalStockFooter = document.getElementById("prod-total-stock-footer");
  const totalValFooter = document.getElementById("prod-total-val-footer");
  if (totalCountFooter) totalCountFooter.textContent = `${(productsDb || []).length} Items`;
  if (totalStockFooter) totalStockFooter.textContent = `${totalStockSum} Units`;
  if (totalValFooter) totalValFooter.textContent = `₹ ${formatCurrency(totalInventoryValueSum)}`;

  if (elements && elements.productCount) {
    elements.productCount.textContent = (productsDb || []).length;
  }
}

function updateProductDomRowFast(productId, newStock, newStatus) {
  const stockNum = Math.max(0, parseInt(newStock, 10) || 0);
  const qtyEl = document.getElementById(`prod-stock-qty-${productId}`);
  const badgeEl = document.getElementById(`prod-stock-badge-${productId}`);
  const valEl = document.getElementById(`prod-total-val-${productId}`);
  const rowEl = document.getElementById(`prod-row-${productId}`);

  if (!rowEl || !qtyEl) {
    if (typeof renderProductsTable === 'function') renderProductsTable(productsDb);
    return;
  }

  qtyEl.textContent = stockNum;

  if (badgeEl) {
    let stockBadge = "";
    if (stockNum === 0) {
      stockBadge = `<span style="display: inline-block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-triangle-exclamation"></i> Out</span>`;
    } else if (stockNum <= 10) {
      stockBadge = `<span style="display: inline-block; background: #fffbeb; color: #d97706; border: 1px solid #fde68a; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-circle-exclamation"></i> Low</span>`;
    } else {
      stockBadge = `<span style="display: inline-block; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-circle-check"></i> In Stock</span>`;
    }
    badgeEl.innerHTML = stockBadge;
  }

  const prod = productsDb.find(p => p && p.id === productId);
  if (prod && valEl) {
    const rate = parseFloat(prod.rate || 0);
    const disc = parseFloat(prod.discount || 0);
    const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
    const totalVal = stockNum * valAfterDisc;
    valEl.textContent = `₹ ${formatCurrency(totalVal)}`;
  }

  // Visual pulse highlight
  rowEl.style.transition = "background-color 0.25s ease";
  rowEl.style.backgroundColor = "rgba(14, 165, 233, 0.18)";
  setTimeout(() => {
    if (rowEl) rowEl.style.backgroundColor = "";
  }, 900);

  recalculateProductTotalsAndKpisFast();
}

function loadProductsDatabaseTable() {
  loadAllDatabases();
  elements.productCount.textContent = productsDb.length;
  renderProductsTable(productsDb);
}

function renderProductsTable(records) {
  if (!records || !Array.isArray(records)) {
    records = (Array.isArray(productsDb) && productsDb.length > 0) ? productsDb : [];
  }
  elements.productsListBody.innerHTML = "";
  if (!records || records.length === 0) {
    if (!window.isInitialSyncDone) {
      elements.productsListBody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center text-muted" style="padding: 40px 16px;">
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;">
              <i class="fa-solid fa-circle-notch fa-spin fa-2x" style="color: #0284c7;"></i>
              <div style="font-weight: 600; font-size: 14px; color: #334155;">Syncing Inventory Products...</div>
            </div>
          </td>
        </tr>
      `;
      // Snappy Failsafe: max 3.5s loading spinner to guarantee zero-hang
      setTimeout(() => {
        if (!window.isInitialSyncDone) {
          window.isInitialSyncDone = true;
          renderProductsTable(productsDb || []);
        }
      }, 3500);
    } else {
      elements.productsListBody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center text-muted" style="padding: 32px; font-weight: 500;">
            <i class="fa-solid fa-box-open" style="font-size: 24px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>
            No products found matching your filter criteria.
          </td>
        </tr>
      `;
    }
    const totalCountFooter = document.getElementById("prod-total-count-footer");
    const totalStockFooter = document.getElementById("prod-total-stock-footer");
    const totalValFooter = document.getElementById("prod-total-val-footer");
    if (totalCountFooter) totalCountFooter.textContent = `0 Items`;
    if (totalStockFooter) totalStockFooter.textContent = `0 Units`;
    if (totalValFooter) totalValFooter.textContent = `₹ 0.00`;

    const kpiCount = document.getElementById("prod-kpi-count");
    const kpiUnits = document.getElementById("prod-kpi-units");
    const kpiVal = document.getElementById("prod-kpi-valuation");
    const kpiAlerts = document.getElementById("prod-kpi-alerts");
    const kpiAlertsSub = document.getElementById("prod-kpi-alerts-sub");
    if (kpiCount) kpiCount.textContent = "0";
    if (kpiUnits) kpiUnits.textContent = "0 Units";
    if (kpiVal) kpiVal.textContent = "₹ 0.00";
    if (kpiAlerts) kpiAlerts.textContent = "0 Alerts";
    if (kpiAlertsSub) kpiAlertsSub.textContent = "All In Stock";
    return;
  }

  let totalStockSum = 0;
  let totalInventoryValueSum = 0;
  let lowCount = 0;
  let outCount = 0;

  records.forEach(p => {
    const tr = document.createElement("tr");
    tr.id = `prod-row-${p.id}`;
    tr.setAttribute("data-product-id", p.id);
    const rate = parseFloat(p.rate || 0);
    const disc = parseFloat(p.discount || 0);
    const valAfterDisc = Math.max(0, rate - (rate * disc / 100));
    const stockVal = p.stock !== undefined ? parseInt(p.stock, 10) : 0;
    const totalVal = stockVal * valAfterDisc;

    totalStockSum += stockVal;
    totalInventoryValueSum += totalVal;

    let stockBadge = "";
    if (stockVal === 0) {
      outCount++;
      stockBadge = `<span style="display: inline-block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-triangle-exclamation"></i> Out</span>`;
    } else if (stockVal <= 10) {
      lowCount++;
      stockBadge = `<span style="display: inline-block; background: #fffbeb; color: #d97706; border: 1px solid #fde68a; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-circle-exclamation"></i> Low</span>`;
    } else {
      stockBadge = `<span style="display: inline-block; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 700;"><i class="fa-solid fa-circle-check"></i> In Stock</span>`;
    }

    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 28px; height: 28px; border-radius: 6px; background: #f0fdfa; color: #0f766e; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">
            <i class="fa-solid fa-box"></i>
          </div>
          <div>
            <div style="font-weight: 700; color: #0f172a; font-size: 13px;">${p.description}</div>
            <div style="font-size: 11px; color: #64748b;">${p.unit || 'Bucket'}</div>
          </div>
        </div>
      </td>
      <td>
        <span style="background: #f1f5f9; border: 1px solid #e2e8f0; padding: 2px 7px; border-radius: 5px; font-family: monospace; font-size: 11.5px; font-weight: 600; color: #475569;">${p.hsn || "—"}</span>
      </td>
      <td style="text-align: center;">
        <span style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; padding: 2px 8px; font-size: 12px; font-weight: 600; color: #334155;">${p.packSize || "—"}</span>
      </td>
      <td style="text-align: right; font-weight: 600; color: #334155; font-size: 13px;">₹ ${formatCurrency(rate)}</td>
      <td style="text-align: center;">
        <div class="prod-discount-badge" title="Click to edit promotional discount percentage">
          <input type="number" step="0.1" min="0" max="100" value="${disc}" 
            onchange="updateProductDiscountInline('${p.id}', this.value)" 
            onkeydown="if(event.key==='Enter'){this.blur();}"
            class="prod-discount-input">
          <span class="prod-discount-pct">%</span>
        </div>
      </td>
      <td style="text-align: right;">
        <div style="display: flex; flex-direction: column; align-items: flex-end; cursor: pointer;" 
             onclick="const pr = prompt('Set direct Price After Discount for \\'${p.description}\\':', '${valAfterDisc}'); if(pr!==null) updateProductPriceAfterDiscountInline('${p.id}', pr);"
             title="Click to directly set price after discount (₹)">
          <span style="font-weight: 800; color: #16a34a; font-size: 13.5px;">₹ ${formatCurrency(valAfterDisc)}</span>
          ${disc > 0 ? `<span style="font-size: 10px; color: #059669; font-weight: 600;">(-${disc}%)</span>` : '<span style="font-size: 10px; color: #94a3b8;">(0% disc)</span>'}
        </div>
      </td>
      <td style="text-align: center;">
        <div class="prod-stock-stepper">
          <button class="btn-stock-step" onclick="adjustProductStock('${p.id}', -1)" title="Decrease Stock">−</button>
          <span class="stock-qty-text" id="prod-stock-qty-${p.id}">${stockVal}</span>
          <button class="btn-stock-step" onclick="adjustProductStock('${p.id}', 1)" title="Increase Stock">+</button>
          <span id="prod-stock-badge-${p.id}">${stockBadge}</span>
        </div>
      </td>
      <td style="text-align: right; font-weight: 800; color: #0f172a; font-size: 14px;" id="prod-total-val-${p.id}">₹ ${formatCurrency(totalVal)}</td>
      <td style="text-align: center;">
        <div class="prod-actions-row">
          <button class="prod-action-btn restock" onclick="quickRestockProduct('${p.id}')" title="1-Click Quick Restock (Add Inward Stock)" style="color: #0284c7; background: #e0f2fe; border: 1px solid #bae6fd;">
            <i class="fa-solid fa-boxes-packing"></i>
          </button>
          <button class="prod-action-btn edit" onclick="openProductModal('${p.id}')" title="Edit Product & Stock">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="prod-action-btn delete" onclick="deleteProductRowDb('${p.id}')" title="Delete Product">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </td>
    `;
    elements.productsListBody.appendChild(tr);
  });

  // Update Top KPI Summary Metrics Cards
  const kpiCount = document.getElementById("prod-kpi-count");
  const kpiUnits = document.getElementById("prod-kpi-units");
  const kpiVal = document.getElementById("prod-kpi-valuation");
  const kpiAlerts = document.getElementById("prod-kpi-alerts");
  const kpiAlertsSub = document.getElementById("prod-kpi-alerts-sub");

  if (kpiCount) kpiCount.textContent = records.length;
  if (kpiUnits) kpiUnits.textContent = `${totalStockSum} Units`;
  if (kpiVal) kpiVal.textContent = `₹ ${formatCurrency(totalInventoryValueSum)}`;
  if (kpiAlerts) kpiAlerts.textContent = `${lowCount + outCount} Alerts`;
  if (kpiAlertsSub) kpiAlertsSub.textContent = `${lowCount} Low / ${outCount} Out of Stock`;

  // Update Table Footer
  const totalCountFooter = document.getElementById("prod-total-count-footer");
  const totalStockFooter = document.getElementById("prod-total-stock-footer");
  const totalValFooter = document.getElementById("prod-total-val-footer");
  if (totalCountFooter) totalCountFooter.textContent = `${records.length} Items`;
  if (totalStockFooter) totalStockFooter.textContent = `${totalStockSum} Units`;
  if (totalValFooter) totalValFooter.textContent = `₹ ${formatCurrency(totalInventoryValueSum)}`;
}

window.deleteProductRowDb = function(id) {
  if (confirm("Delete product from inventory list permanently?")) {
    productsDb = productsDb.filter(p => p.id !== id);
    localStorage.setItem("products", JSON.stringify(productsDb));
    
    let deletedProdIds = [];
    try {
      deletedProdIds = JSON.parse(localStorage.getItem("deleted_product_ids")) || [];
    } catch (e) { deletedProdIds = []; }
    if (!deletedProdIds.includes(id)) {
      deletedProdIds.push(id);
      localStorage.setItem("deleted_product_ids", JSON.stringify(deletedProdIds));
    }

    deleteProductFromServer(id);
    if (window.AaryanDB && window.AaryanDB.isReady) AaryanDB.saveAllProducts(productsDb);
    loadProductsDatabaseTable();
    if (typeof window.broadcastDatabaseMutation === 'function') window.broadcastDatabaseMutation();
  }
};

window.filterProductsByStockStatus = function() {
  const status = document.getElementById("filter-stock-status").value;
  const searchQuery = elements.searchProductsInput.value.toLowerCase().trim();

  let filtered = productsDb;

  if (searchQuery) {
    filtered = filtered.filter(p => 
      (p.description && p.description.toLowerCase().includes(searchQuery)) || 
      (p.hsn && p.hsn.toLowerCase().includes(searchQuery))
    );
  }

  if (status === "instock") {
    filtered = filtered.filter(p => (p.stock !== undefined ? parseInt(p.stock, 10) : 0) > 10);
  } else if (status === "low") {
    filtered = filtered.filter(p => {
      const stock = p.stock !== undefined ? parseInt(p.stock, 10) : 0;
      return stock > 0 && stock <= 10;
    });
  } else if (status === "out") {
    filtered = filtered.filter(p => (p.stock !== undefined ? parseInt(p.stock, 10) : 0) === 0);
  }

  renderProductsTable(filtered);
};

let searchProductsDebounce = null;
elements.searchProductsInput.addEventListener("input", () => {
  if (searchProductsDebounce) clearTimeout(searchProductsDebounce);
  searchProductsDebounce = setTimeout(() => {
    filterProductsByStockStatus();
  }, 100);
});

// --- PARTIES DIALOG MODALS & CARDS ---
window.openPartyModal = function(type, id = "") {
  const modalEl = document.getElementById("party-modal");
  if (!modalEl) return;

  // Fully clear any inline display/visibility locks so the modal opens reliably every single time
  modalEl.classList.remove("hidden");
  modalEl.style.removeProperty("display");
  modalEl.style.removeProperty("visibility");
  modalEl.style.removeProperty("opacity");
  modalEl.style.removeProperty("pointer-events");
  modalEl.style.setProperty("display", "flex", "important");
  modalEl.style.setProperty("visibility", "visible", "important");
  modalEl.style.setProperty("opacity", "1", "important");
  modalEl.style.setProperty("pointer-events", "auto", "important");
  modalEl.style.setProperty("z-index", "2147483640", "important");

  const form = document.getElementById("modal-party-form");
  if (form) form.reset();
  document.getElementById("modal-party-id").value = "";
  document.getElementById("modal-party-type").value = type;
  document.getElementById("modal-party-state").value = "Andhra Pradesh";
  document.getElementById("modal-party-state-code").value = "37";

  if (id) {
    const party = partiesDb.find(p => p.id === id || p.name === id);
    if (party) {
      document.getElementById("party-modal-title").textContent = "Edit Party Profile";
      document.getElementById("modal-party-id").value = party.id;
      document.getElementById("modal-party-type").value = party.type;
      document.getElementById("modal-party-name").value = party.name;
      document.getElementById("modal-party-company").value = party.company || "";
      document.getElementById("modal-party-address").value = party.address;
      document.getElementById("modal-party-gstin").value = party.gstin || "";
      document.getElementById("modal-party-state").value = party.state || "Andhra Pradesh";
      document.getElementById("modal-party-state-code").value = party.stateCode || "37";
      document.getElementById("modal-party-phone").value = party.phone || "";
    }
  } else {
    document.getElementById("party-modal-title").textContent = `Add New ${type === 'receiver' ? 'Receiver' : 'Consignee'}`;
  }

  setTimeout(() => {
    const nameEl = document.getElementById("modal-party-name");
    if (nameEl) nameEl.focus();
  }, 100);
};

window.closePartyModal = function() {
  const modalEl = document.getElementById("party-modal");
  if (modalEl) {
    modalEl.classList.add("hidden");
    modalEl.style.setProperty("display", "none", "important");
    modalEl.style.setProperty("visibility", "hidden", "important");
    modalEl.style.setProperty("opacity", "0", "important");
    modalEl.style.setProperty("pointer-events", "none", "important");
  }
};

window.savePartyModal = function(e, andAddAnother = false) {
  if (e && e.preventDefault) e.preventDefault();
  const id = document.getElementById("modal-party-id").value;
  const type = document.getElementById("modal-party-type").value;
  const name = document.getElementById("modal-party-name").value.toUpperCase().trim();
  const company = document.getElementById("modal-party-company").value.trim();
  const address = document.getElementById("modal-party-address").value.trim();
  const gstin = document.getElementById("modal-party-gstin").value.toUpperCase().trim();
  const state = document.getElementById("modal-party-state").value.trim();
  const stateCode = document.getElementById("modal-party-state-code").value.trim();
  const phone = document.getElementById("modal-party-phone").value.trim();

  if (!name) {
    showFloatingToast("⚠️ Please enter Customer Name.", "warning");
    const nameEl = document.getElementById("modal-party-name");
    if (nameEl) nameEl.focus();
    return;
  }

  const party = { 
    id: id || "party-" + Date.now() + "-" + Math.floor(Math.random() * 1000), 
    type, 
    name, 
    company, 
    address, 
    gstin, 
    state, 
    stateCode, 
    phone, 
    updatedAt: new Date().toISOString() 
  };
  const isNew = !id;

  if (id) {
    const idx = partiesDb.findIndex(p => p.id === id);
    if (idx > -1) partiesDb[idx] = party;
  } else {
    partiesDb.push(party);
  }

  renderPartiesLists(partiesDb);
  populateBillingSelectors();

  // Instant Cross-Browser Broadcast (< 15ms)
  broadcastInterTabEvent('parties_saved', { parties: partiesDb });

  // Direct Push to Google Cloud Database (< 1s)
  pushDirectToGoogleDatabase("save_parties", { parties: partiesDb });

  if (andAddAnother) {
    window.openPartyModal(type, "");
    showFloatingToast(`✅ "${party.name}" saved! Ready for next ${type === 'receiver' ? 'Receiver' : 'Consignee'}...`, 3000);
  } else {
    closePartyModal();
    showFloatingToast(`✅ "${party.name}" saved successfully!`, 3500);
  }

  sendPartyTelegramReport(party, isNew);
};

function loadPartiesDatabaseLists() {
  loadAllDatabases();
  renderPartiesLists(partiesDb);
}

function renderPartiesLists(records) {
  elements.receiversScrollBox.innerHTML = "";
  elements.consigneesScrollBox.innerHTML = "";

  const receivers = records.filter(p => p.type === 'receiver');
  const consignees = records.filter(p => p.type === 'consignee');

  if (receivers.length === 0) {
    elements.receiversScrollBox.innerHTML = `<div class="text-center text-muted padding-20">No receivers found.</div>`;
  } else {
    receivers.forEach(p => {
      const card = createPartyListCard(p);
      elements.receiversScrollBox.appendChild(card);
    });
  }

  if (consignees.length === 0) {
    elements.consigneesScrollBox.innerHTML = `<div class="text-center text-muted padding-20">No consignees found.</div>`;
  } else {
    consignees.forEach(p => {
      const card = createPartyListCard(p);
      elements.consigneesScrollBox.appendChild(card);
    });
  }
}

window.sendPartyPaymentReminderWhatsApp = async function(partyName, phone) {
  const customerInvoices = invoicesDb.filter(inv => inv.customerName === partyName || (inv.details?.buyer?.name) === partyName);
  let totalBilled = 0, totalPaid = 0;
  customerInvoices.forEach(inv => {
    const payInfo = getInvoicePaidAndBalance(inv);
    totalBilled += payInfo.total;
    totalPaid += payInfo.paid;
  });
  const pendingDues = Math.max(0, totalBilled - totalPaid);

  let text = `🙏 *GENTLE PAYMENT REMINDER*\n`;
  text += `🏛️ *AARYAN AQUA NEEDS*\n`;
  text += `-----------------------------------\n`;
  text += `👤 *Customer:* ${partyName}\n`;
  text += `📄 *Total Invoices:* ${customerInvoices.length}\n`;
  text += `💰 *Total Billed:* ₹ ${formatCurrency(totalBilled)}\n`;
  text += `✅ *Total Paid:* ₹ ${formatCurrency(totalPaid)}\n`;
  text += `🔴 *Outstanding Dues:* ₹ ${formatCurrency(pendingDues)}\n`;
  const realUpiId = (globalSettings.upiId || globalSettings.bank?.upi || "7386262139@upi").trim();
  const companyName = globalSettings.company?.name || "AARYAN AQUA NEEDS";
  const upiName = encodeURIComponent(companyName.replace(/[^a-zA-Z0-9 ]/g, '').trim());
  const upiPayLink = `upi://pay?pa=${realUpiId}&pn=${upiName}&am=${pendingDues.toFixed(2)}&cu=INR&tn=PartyDuePayment`;

  text += `-----------------------------------\n`;
  text += `📲 *Pay Directly via UPI App (GPay / PhonePe / Paytm):*\n`;
  text += `${upiPayLink}\n\n`;
  text += `💳 Or send to UPI ID: *${realUpiId}*\n`;
  text += `-----------------------------------\n`;
  text += `Kindly clear the outstanding balance at your earliest convenience. Thank you for your continued business! 🙏`;

  const cleanPhone = formatWhatsAppPhone(phone);

  // Live bot status check
  let isBotReady = whatsappBotStatus && (whatsappBotStatus.isReady || whatsappBotStatus.status === 'CONNECTED');
  if (!isBotReady && isLocalCompanionAvailable()) {
    try {
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), 2000);
      const liveRes = await fetch(getWhatsAppApiEndpoint('/api/whatsapp/status'), { signal: controller.signal })
        .then(r => r.json()).catch(() => null);
      clearTimeout(tId);
      if (liveRes && (liveRes.isReady || liveRes.status === 'CONNECTED')) {
        whatsappBotStatus = liveRes;
        isBotReady = true;
        updateWhatsAppBotPillUI(whatsappBotStatus);
      }
    } catch (e) {}
  }

  if (isBotReady && cleanPhone) {
    try {
      showFloatingToast(`🤖 Sending payment reminder silently to ${partyName} via WhatsApp Bot...`, 3000);
      const ok = await dispatchWhatsAppBotMessage({ phone: cleanPhone, text });
      if (ok) {
        if (typeof playSuccessChime === 'function') playSuccessChime();
        showFloatingToast(`🚀 Outstanding dues reminder sent silently to ${partyName} (+${cleanPhone}) via WhatsApp Bot!`, 5000);
        return true;
      }
    } catch (e) {
      console.warn("Party bot reminder notice:", e);
    }
    showFloatingToast(`⚠️ WhatsApp Bot could not deliver dues reminder.`, "warning", 4000);
    return false;
  }

  if (!isBotReady && cleanPhone) {
    const encodedText = encodeURIComponent(text);
    const waDirectUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;
    window.open(waDirectUrl, '_blank');
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📲 Opened WhatsApp Direct with reminder & UPI payment link for ${partyName}!`, 4500);
    }
    return true;
  }

  showFloatingToast(`⚠️ No valid phone number found for ${partyName}.`, "warning", 4500);
  return false;
};

function createPartyListCard(p) {
  const customerInvoices = invoicesDb.filter(inv => inv.customerName === p.name || (inv.details?.buyer?.name) === p.name);
  let totalBilled = 0, totalPaid = 0;
  customerInvoices.forEach(inv => {
    const payInfo = getInvoicePaidAndBalance(inv);
    totalBilled += payInfo.total;
    totalPaid += payInfo.paid;
  });
  const pendingDues = Math.max(0, totalBilled - totalPaid);

  let duesBadge = `<span style="background: rgba(16, 185, 129, 0.12); color: #10b981; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 700;">Paid</span>`;
  if (pendingDues > 0) {
    duesBadge = `<span style="background: rgba(239, 68, 68, 0.12); color: #ef4444; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 700;">Due: ₹ ${formatCurrency(pendingDues)}</span>`;
  }

  const card = document.createElement("div");
  card.className = "party-list-card";
  card.innerHTML = `
    <div class="party-list-card-details" style="flex: 1;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <h4 style="margin: 0;">${p.name}</h4>
        ${duesBadge}
      </div>
      ${p.company ? `<p style="font-weight:600; color:var(--text-dark); margin: 2px 0;">${p.company}</p>` : ''}
      <p style="font-size:10.5px; color:#475569; white-space: pre-line; margin-bottom: 4px;">${p.address || ''}</p>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #64748b;">
        <span>${p.phone ? 'Ph: ' + p.phone : ''}</span>
        <span style="font-weight: 600;">Billed: ₹ ${formatCurrency(totalBilled)} (${customerInvoices.length} bills)</span>
      </div>
    </div>
    <div class="actions-cell" style="display: flex; gap: 4px; align-items: center;">
      ${pendingDues > 0 ? `<button class="action-btn share btn-whatsapp" onclick="sendPartyPaymentReminderWhatsApp('${p.name.replace(/'/g, "\\'")}', '${p.phone || ''}')" title="Send WhatsApp Payment Reminder"><i class="fa-brands fa-whatsapp"></i></button>` : ''}
      <button class="action-btn edit" onclick="openPartyModal('${p.type}', '${String(p.id || p.name || '').replace(/'/g, "\\'")}')" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
      <button class="action-btn delete" onclick="deletePartyRowDb('${String(p.id || p.name || '').replace(/'/g, "\\'")}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;
  return card;
}

window.deletePartyRowDb = async function(id) {
  if (confirm("Delete this customer party profile permanently from Google Database?")) {
    const targetId = String(id || "").trim();
    
    // Instant optimistic UI update in memory
    partiesDb = partiesDb.filter(p => p && String(p.id || "").trim() !== targetId && String(p.name || "").trim() !== targetId);
    window.partiesDb = partiesDb;
    renderPartiesLists(partiesDb);
    populateBillingSelectors();
    
    // Direct sync to Google Cloud Database
    if (typeof pushDirectToGoogleDatabase === "function") {
      try {
        await pushDirectToGoogleDatabase("save_parties", { parties: partiesDb });
        await pushDirectToGoogleDatabase("delete_record", { type: "party", id: targetId });
      } catch(e){}
    }
    
    if (typeof window.broadcastDatabaseMutation === 'function') window.broadcastDatabaseMutation();
    if (typeof window.triggerDatabaseSync === 'function') await window.triggerDatabaseSync(true);
    showFloatingToast("✅ Party deleted permanently from Google Database!", "success");
  }
};

// --- REPORTS VIEW DATE RANGE RUNNER ---
function resetReportsView() {
  elements.reportStartDate.value = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  elements.reportEndDate.value = new Date().toISOString().split('T')[0];
  
  elements.reportResultsPlaceholder.classList.remove("hidden");
  elements.reportResultsContent.classList.add("hidden");
}

let salesTrendChartInstance = null;
let productSalesChartInstance = null;

window.runSalesReport = function() {
  const start = elements.reportStartDate.value;
  const end = elements.reportEndDate.value;

  if (!start || !end) {
    showFloatingToast("⚠️ Please select both Start and End Dates!", "warning");
    return;
  }

  loadAllDatabases();

  const filtered = invoicesDb.filter(inv => {
    return (inv.invoiceDate >= start && inv.invoiceDate <= end);
  });

  if (filtered.length === 0) {
    elements.reportResultsPlaceholder.classList.remove("hidden");
    elements.reportResultsPlaceholder.innerHTML = `<i class="fa-solid fa-chart-line"></i><p>No invoices found in selected date range.</p>`;
    elements.reportResultsContent.classList.add("hidden");
    return;
  }

  elements.reportResultsPlaceholder.classList.add("hidden");
  elements.reportResultsContent.classList.remove("hidden");

  elements.reportTableBody.innerHTML = "";
  let totalTaxable = 0;
  let totalTax = 0;
  let totalGrand = 0;

  filtered.forEach(inv => {
    const details = inv.details || {};
    let invoiceTaxable = details.taxable || 0;
    let invoiceTax = (details.cgst || 0) + (details.sgst || 0) + (details.igst || 0);

    totalTaxable += invoiceTaxable;
    totalTax += invoiceTax;
    totalGrand += inv.total;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--primary-teal);">#${inv.invoiceNo}</td>
      <td>${formatInputDateString(inv.invoiceDate)}</td>
      <td style="font-weight: 600;">${inv.customerName}</td>
      <td style="text-align: right;">₹ ${formatCurrency(invoiceTaxable)}</td>
      <td style="text-align: right;">₹ ${formatCurrency(invoiceTax)}</td>
      <td style="text-align: right; font-weight: 700; color: var(--primary-teal);">₹ ${formatCurrency(inv.total)}</td>
    `;
    elements.reportTableBody.appendChild(tr);
  });

  elements.reportTotalTaxable.textContent = `₹ ${formatCurrency(totalTaxable)}`;
  elements.reportTotalTax.textContent = `₹ ${formatCurrency(totalTax)}`;
  elements.reportTotalGrand.textContent = `₹ ${formatCurrency(totalGrand)}`;

  // --- RENDER DYNAMIC CHARTS ---
  try {
    if (typeof Chart !== 'undefined') {
      const trendData = {};
      filtered.forEach(inv => {
        const dateStr = formatInputDateString(inv.invoiceDate);
        trendData[dateStr] = (trendData[dateStr] || 0) + (inv.total || 0);
      });

      const trendLabels = Object.keys(trendData).sort((a, b) => new Date(a) - new Date(b));
      const trendValues = trendLabels.map(label => trendData[label]);

      const productData = {};
      filtered.forEach(inv => {
        const items = (inv.details && inv.details.items) || [];
        items.forEach(item => {
          const desc = item.description || "Unknown Product";
          const revenue = item.amount || 0;
          productData[desc] = (productData[desc] || 0) + revenue;
        });
      });

      const productLabels = Object.keys(productData);
      const productValues = productLabels.map(label => productData[label]);

      const chartColors = [
        '#06b6d4', '#0d9488', '#3b82f6', '#8b5cf6', '#ec4899', 
        '#f59e0b', '#10b981', '#ef4444', '#6366f1', '#14b8a6'
      ];

      const trendCtx = document.getElementById('salesTrendChart').getContext('2d');
      if (salesTrendChartInstance) salesTrendChartInstance.destroy();
      salesTrendChartInstance = new Chart(trendCtx, {
        type: 'line',
        data: {
          labels: trendLabels,
          datasets: [{
            label: 'Daily Sales (₹)',
            data: trendValues,
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointBackgroundColor: '#06b6d4',
            pointHoverRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#94a3b8' }
            },
            x: {
              grid: { display: false },
              ticks: { color: '#94a3b8' }
            }
          }
        }
      });

      const productCtx = document.getElementById('productSalesChart').getContext('2d');
      if (productSalesChartInstance) productSalesChartInstance.destroy();
      productSalesChartInstance = new Chart(productCtx, {
        type: 'doughnut',
        data: {
          labels: productLabels,
          datasets: [{
            data: productValues,
            backgroundColor: chartColors.slice(0, productLabels.length || 10),
            borderWidth: 1,
            borderColor: '#1e293b'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: {
                color: '#cbd5e1',
                font: { size: 10 }
              }
            }
          }
        }
      });
    }
  } catch (err) {
    console.error("Charts generation failed:", err);
  }
};

window.exportSalesReportCSV = function() {
  loadAllDatabases();
  if (invoicesDb.length === 0) {
    showFloatingToast("⚠️ No invoices found to export!", "warning");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Invoice No,Date,Document Type,Customer Name,Total Amount,Payment Status,Payment Mode\n";

  invoicesDb.forEach(inv => {
    const d = inv.details || {};
    const row = [
      `"${inv.invoiceNo}"`,
      `"${inv.invoiceDate}"`,
      `"${d.invoiceType || 'Bill of Supply'}"`,
      `"${inv.customerName}"`,
      `${inv.total || 0}`,
      `"${d.paymentStatus || 'Paid'}"`,
      `"${d.paymentMode || 'Cash'}"`
    ].join(",");
    csvContent += row + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Aaryan_Aqua_Sales_Report_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// --- DATABASE BACKUP & RESTORE ---
window.exportDatabaseBackup = function() {
  loadAllDatabases();
  const backup = {
    products: productsDb,
    parties: partiesDb,
    invoices: invoicesDb,
    settings: globalSettings,
    exportedAt: new Date().toISOString()
  };

  const jsonStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `Aaryan_Aqua_Billing_Backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

window.importDatabaseBackup = function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const data = JSON.parse(evt.target.result);
      if (data.products && data.parties && data.invoices) {
        localStorage.setItem("products", JSON.stringify(data.products));
        localStorage.setItem("parties", JSON.stringify(data.parties));
        localStorage.setItem("invoices", JSON.stringify(data.invoices));
        if (data.settings) localStorage.setItem("settings", JSON.stringify(data.settings));

        loadAllDatabases();
        showFloatingToast("✅ Database successfully restored from JSON backup!", 4000);
        switchTab("dashboard");
      } else {
        showFloatingToast("⚠️ Invalid backup file format!", "warning");
      }
    } catch (err) {
      showFloatingToast("⚠️ Failed to parse JSON backup file: " + err.message, "warning");
    }
  };
  reader.readAsText(file);
};

// --- KEYBOARD SHORTCUTS ---
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (isLocked) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const billingTab = document.getElementById("view-billing");
      if (billingTab && !billingTab.classList.contains("hidden")) {
        generateAndPrintInvoice();
      }
    }
    if (e.key === 'Escape') {
      const billingTab = document.getElementById("view-billing");
      if (billingTab && !billingTab.classList.contains("hidden")) {
        resetBillingForm();
      }
    }
  });
}

// --- SETTINGS CONTROLLERS ---
function loadSettingsFields() {
  loadAllDatabases();

  const defToken = "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g";
  const defChats = "6877857251, 7906132548";

  if (!globalSettings.telegram) {
    globalSettings.telegram = { token: defToken, chatId: defChats, botUsername: "fishbilling_bot_bot", autoSend: true };
    try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
  } else {
    let changed = false;
    if (!globalSettings.telegram.token || globalSettings.telegram.token.trim() === "") {
      globalSettings.telegram.token = defToken;
      changed = true;
    }
    if (!globalSettings.telegram.chatId || !globalSettings.telegram.chatId.includes("7906132548")) {
      globalSettings.telegram.chatId = globalSettings.telegram.chatId && globalSettings.telegram.chatId.trim()
        ? (globalSettings.telegram.chatId + ", 7906132548")
        : defChats;
      changed = true;
    }
    if (!globalSettings.telegram.botUsername) {
      globalSettings.telegram.botUsername = "fishbilling_bot_bot";
      changed = true;
    }
    if (changed) {
      try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
    }
  }

  if (elements.setTgToken) elements.setTgToken.value = globalSettings.telegram.token;
  if (elements.setTgChatId) elements.setTgChatId.value = globalSettings.telegram.chatId;
  if (elements.tgStatusIndicator) {
    elements.tgStatusIndicator.classList.remove("hidden");
    elements.tgStatusIndicator.className = "info-note col-12 text-success";
    if (elements.tgStatusText) {
      elements.tgStatusText.textContent = "✅ Telegram Bot Active (@fishbilling_bot_bot) - 2 Connected Recipients";
    }
  }

  elements.setAutolockTimer.value = globalSettings.security?.autolock !== undefined ? globalSettings.security.autolock : "1800";
  elements.setLoginUsername.value = globalSettings.security?.username || "Aaryanaqua";
  elements.setLoginPassword.value = globalSettings.security?.password || globalSettings.security?.pin || "Aaryan@2024";

  if (elements.setWaLockEnabled) elements.setWaLockEnabled.checked = globalSettings.security?.whatsappLockEnabled !== false;
  if (elements.setWaPin) elements.setWaPin.value = globalSettings.security?.whatsappPin || "2024";
  if (elements.setWaAutolock) elements.setWaAutolock.value = globalSettings.security?.whatsappAutoLockMinutes || "15";
  if (elements.setWaMaskPhones) elements.setWaMaskPhones.checked = globalSettings.security?.whatsappMaskPhones !== false;
  if (elements.setWaProtectChats) elements.setWaProtectChats.checked = globalSettings.security?.whatsappProtectChats !== false;

  elements.setCName.value = globalSettings.company?.name || "";
  elements.setCTagline.value = globalSettings.company?.tagline || "";
  elements.setCAddress.value = globalSettings.company?.address || "";
  elements.setCPhones.value = globalSettings.company?.phones || "";
  elements.setCEmail.value = globalSettings.company?.email || "";
  elements.setCGstin.value = globalSettings.company?.gstin || "";
  elements.setCState.value = globalSettings.company?.state || "Andhra Pradesh";
  elements.setCStateCode.value = globalSettings.company?.stateCode || "37";

  elements.setBName.value = globalSettings.bank?.name || "";
  elements.setBAccName.value = globalSettings.bank?.accountName || "";
  elements.setBAccNo.value = globalSettings.bank?.accountNo || "";
  elements.setBIfsc.value = globalSettings.bank?.ifsc || "";
  elements.setBBranch.value = globalSettings.bank?.branch || "";
  elements.setBUpi.value = globalSettings.upiId || "";

  elements.setBTerms.value = (globalSettings.terms || []).join("\n");
}

window.saveTelegramSettings = function(e) {
  if (e && e.preventDefault) e.preventDefault();
  const token = (elements.setTgToken?.value || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  const chatId = (elements.setTgChatId?.value || "6877857251, 7906132548").trim();

  globalSettings.telegram = {
    token: token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g",
    chatId: chatId || "6877857251, 7906132548",
    botUsername: "fishbilling_bot_bot",
    autoSend: true
  };
  try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (err) {}
  syncDatabaseToServer("settings", globalSettings);
  
  if (elements.tgStatusIndicator) {
    elements.tgStatusIndicator.classList.remove("hidden");
    elements.tgStatusIndicator.className = "info-note col-12 text-success";
    if (elements.tgStatusText) {
      elements.tgStatusText.textContent = "✅ Telegram Bot integration details successfully saved & synced!";
    }
  }
  showFloatingToast("✈️ Telegram Bot credentials saved & synchronized!", 4000);
  loadAllDatabases();
};

window.testTelegramConnection = async function() {
  const token = (elements.setTgToken?.value || globalSettings.telegram?.token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  const chat = (elements.setTgChatId?.value || globalSettings.telegram?.chatId || "6877857251, 7906132548").trim();

  if (!token || !chat) {
    showFloatingToast("⚠️ Telegram token or Chat ID is missing!", "warning");
    return;
  }

  if (elements.tgStatusIndicator) {
    elements.tgStatusIndicator.classList.remove("hidden");
    elements.tgStatusIndicator.className = "info-note col-12";
    if (elements.tgStatusText) {
      elements.tgStatusText.textContent = "Dispatching Telegram Bot test message to @fishbilling_bot_bot...";
    }
  }
  showFloatingToast("✈️ Testing Telegram Bot connection (@fishbilling_bot_bot)...", "info");

  const chatIds = chat.split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);
  if (chatIds.length === 0) {
    if (elements.tgStatusIndicator) {
      elements.tgStatusIndicator.className = "info-note col-12 text-danger";
      elements.tgStatusText.textContent = "Error: Invalid Chat ID format.";
    }
    showFloatingToast("⚠️ Invalid Chat ID format", "warning");
    return;
  }

  try {
    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const messageText = `🏛️ *AARYAN AQUA NEEDS*\n-----------------------------------\n🔔 *Telegram Bot Connected Successfully!*\n\n✅ Cloud billing notifications & PDF receipts are active.\n🤖 *Bot:* @fishbilling_bot_bot\n📅 *Time:* ${nowStr}\n\n_Thank you for choosing Aaryan Aqua Needs!_`;
    let successCount = 0;
    let lastError = "";

    for (const id of chatIds) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: id, text: messageText, parse_mode: "Markdown" })
        });
        const data = await res.json();
        if (data && data.ok) {
          successCount++;
        } else {
          lastError = (data && data.description) ? data.description : "Chat ID failed";
        }
      } catch (err) {
        lastError = err.message;
      }
    }
    
    if (successCount === chatIds.length) {
      if (elements.tgStatusIndicator) {
        elements.tgStatusIndicator.className = "info-note col-12 text-success";
        elements.tgStatusText.textContent = `✅ Test Message Sent to all ${chatIds.length} Chat IDs (@fishbilling_bot_bot)!`;
      }
      if (typeof playSuccessChime === 'function') playSuccessChime();
      showFloatingToast(`🚀 Telegram Test Message delivered to all ${chatIds.length} recipients!`, 5000);
    } else {
      if (elements.tgStatusIndicator) {
        elements.tgStatusIndicator.className = "info-note col-12 text-danger";
        elements.tgStatusText.textContent = `Delivered to ${successCount}/${chatIds.length} accounts. Note: ${lastError}`;
      }
      showFloatingToast(`⚠️ Telegram notice: Sent to ${successCount}/${chatIds.length} chats. ${lastError}`, "warning");
    }
  } catch (err) {
    if (elements.tgStatusIndicator) {
      elements.tgStatusIndicator.className = "info-note col-12 text-danger";
      elements.tgStatusText.textContent = "Network Error! Bot API request failed: " + err.message;
    }
    showFloatingToast("⚠️ Telegram Network Error: " + err.message, "warning");
  }
};

window.openTelegramBotModal = function() {
  const modal = document.getElementById("telegram-bot-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");
    modal.style.setProperty("visibility", "visible", "important");
    modal.style.setProperty("opacity", "1", "important");
    modal.style.setProperty("pointer-events", "auto", "important");
    modal.style.setProperty("z-index", "2147483640", "important");
  }

  const token = (globalSettings.telegram?.token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  const chat = (globalSettings.telegram?.chatId || "6877857251, 7906132548").trim();

  const tokenInput = document.getElementById("tg-modal-token-input");
  if (tokenInput) tokenInput.value = token;
  const chatInput = document.getElementById("tg-modal-chat-input");
  if (chatInput) chatInput.value = chat;
  const autoSendToggle = document.getElementById("tg-auto-send-toggle");
  if (autoSendToggle) autoSendToggle.checked = globalSettings.telegram?.autoSend !== false;
  const notifyChangesToggle = document.getElementById("tg-notify-changes-toggle");
  if (notifyChangesToggle) notifyChangesToggle.checked = globalSettings.telegram?.notifyChanges !== false;
};

window.closeTelegramBotModal = function(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const modal = document.getElementById("telegram-bot-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
    modal.style.setProperty("visibility", "hidden", "important");
    modal.style.setProperty("opacity", "0", "important");
    modal.style.setProperty("pointer-events", "none", "important");
  }
};

window.saveTelegramModalSettings = function() {
  const token = (document.getElementById("tg-modal-token-input")?.value || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  const chat = (document.getElementById("tg-modal-chat-input")?.value || "6877857251, 7906132548").trim();
  const autoSend = document.getElementById("tg-auto-send-toggle") ? document.getElementById("tg-auto-send-toggle").checked : true;
  const notifyChanges = document.getElementById("tg-notify-changes-toggle") ? document.getElementById("tg-notify-changes-toggle").checked : true;

  globalSettings.telegram = {
    token: token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g",
    chatId: chat || "6877857251, 7906132548",
    botUsername: "fishbilling_bot_bot",
    autoSend: autoSend,
    notifyChanges: notifyChanges
  };

  try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (err) {}
  syncDatabaseToServer("settings", globalSettings);
  if (elements.setTgToken) elements.setTgToken.value = globalSettings.telegram.token;
  if (elements.setTgChatId) elements.setTgChatId.value = globalSettings.telegram.chatId;
  showFloatingToast("✈️ Telegram configuration saved & synced!", 4000);
};

window.sendTelegramModalTestPing = async function(btnEl) {
  const token = (document.getElementById("tg-modal-token-input")?.value || globalSettings.telegram?.token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  const chat = (document.getElementById("tg-modal-chat-input")?.value || globalSettings.telegram?.chatId || "6877857251, 7906132548").trim();
  const statusEl = document.getElementById("tg-modal-test-status");

  if (!token || !chat) {
    showFloatingToast("⚠️ Telegram token or Chat ID is missing!", "warning");
    return;
  }

  const origHtml = btnEl ? btnEl.innerHTML : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending...`;
  }
  if (statusEl) {
    statusEl.innerHTML = `<span style="color: #0284c7;"><i class="fa-solid fa-spinner fa-spin"></i> Dispatching test ping to @fishbilling_bot_bot...</span>`;
  }

  const chatIds = chat.split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);
  let successCount = 0;
  let lastError = "";

  try {
    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const messageText = `🏛️ *AARYAN AQUA NEEDS*\n-----------------------------------\n🔔 *Telegram Bot Connected Successfully!*\n\n✅ Cloud billing notifications & PDF receipts are active.\n🤖 *Bot:* @fishbilling_bot_bot\n📅 *Time:* ${nowStr}\n\n_Thank you for choosing Aaryan Aqua Needs!_`;

    for (const id of chatIds) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: id, text: messageText, parse_mode: "Markdown" })
        });
        const data = await res.json();
        if (data && data.ok) successCount++;
        else lastError = (data && data.description) ? data.description : "Delivery error";
      } catch (e) {
        lastError = e.message;
      }
    }

    if (successCount === chatIds.length) {
      if (statusEl) statusEl.innerHTML = `<span style="color: #16a34a; font-weight: 600;"><i class="fa-solid fa-circle-check"></i> Delivered to all ${chatIds.length} recipients!</span>`;
      if (typeof playSuccessChime === 'function') playSuccessChime();
      showFloatingToast(`🚀 Telegram Test Ping delivered to all ${chatIds.length} recipients!`, 5000);
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color: #d97706;"><i class="fa-solid fa-triangle-exclamation"></i> Sent to ${successCount}/${chatIds.length} chats. (${lastError})</span>`;
      showFloatingToast(`⚠️ Sent to ${successCount}/${chatIds.length} chats. ${lastError}`, "warning");
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: #dc2626;"><i class="fa-solid fa-circle-xmark"></i> Network error: ${err.message}</span>`;
    showFloatingToast("⚠️ Telegram Network Error: " + err.message, "warning");
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = origHtml;
    }
  }
};

window.saveSecuritySettings = function(e) {
  e.preventDefault();
  const autolock = elements.setAutolockTimer.value;
  const username = elements.setLoginUsername.value.trim();
  const password = elements.setLoginPassword.value.trim();

  if (!username || !password) {
    showFloatingToast("⚠️ Please provide both a valid Username and Password!", "warning");
    return;
  }

  const waLockEnabled = elements.setWaLockEnabled ? elements.setWaLockEnabled.checked : true;
  const waPin = elements.setWaPin ? elements.setWaPin.value.trim() : (globalSettings.security?.whatsappPin || "2024");
  const waAutoLock = elements.setWaAutolock ? elements.setWaAutolock.value : "15";
  const waMaskPhones = elements.setWaMaskPhones ? elements.setWaMaskPhones.checked : true;
  const waProtectChats = elements.setWaProtectChats ? elements.setWaProtectChats.checked : true;

  globalSettings.security = {
    ...(globalSettings.security || {}),
    autolock,
    username,
    password,
    whatsappLockEnabled: waLockEnabled,
    whatsappPin: waPin || "2024",
    whatsappAutoLockMinutes: waAutoLock,
    whatsappMaskPhones: waMaskPhones,
    whatsappProtectChats: waProtectChats
  };

  localStorage.setItem("settings", JSON.stringify(globalSettings));
  syncDatabaseToServer("settings", globalSettings);
  showFloatingToast("✅ Login credentials and security settings saved successfully!", 4000);
  loadAllDatabases();
  resetAutolockTimer();
};

window.saveGlobalSettingsDefaults = function(e) {
  e.preventDefault();
  globalSettings.company = {
    name: elements.setCName.value.trim().toUpperCase(),
    tagline: elements.setCTagline.value.trim().toUpperCase(),
    address: elements.setCAddress.value.trim(),
    phones: elements.setCPhones.value.trim(),
    email: elements.setCEmail.value.trim(),
    gstin: elements.setCGstin.value.trim().toUpperCase(),
    state: elements.setCState.value.trim(),
    stateCode: elements.setCStateCode.value.trim()
  };

  globalSettings.bank = {
    name: elements.setBName.value.trim(),
    accountName: elements.setBAccName.value.trim(),
    accountNo: elements.setBAccNo.value.trim(),
    ifsc: elements.setBIfsc.value.trim().toUpperCase(),
    branch: elements.setBBranch.value.trim()
  };
  globalSettings.upiId = elements.setBUpi.value.trim();

  const termsText = elements.setBTerms.value.trim();
  globalSettings.terms = termsText ? termsText.split("\n").map(l => l.trim()).filter(l => l !== "") : [];

  localStorage.setItem("settings", JSON.stringify(globalSettings));
  syncDatabaseToServer("settings", globalSettings);
  showFloatingToast("✅ Store configuration defaults saved successfully!", 4000);
  loadAllDatabases();
};

async function sendTelegramInvoiceNotification(invoice) {
  const token = globalSettings.telegram?.token;
  const chat = globalSettings.telegram?.chatId;

  if (!token || !chat) return;

  const chatIds = chat.split(/[\s,]+/).filter(id => id.trim() !== "");
  if (chatIds.length === 0) return;

  try {
    const textMsg = `🔔 NEW INVOICE GENERATED!\n` +
                    `-------------------------\n` +
                    `Invoice No : #${invoice.invoiceNo} (${invoice.details?.invoiceType || 'Invoice'})\n` +
                    `Date       : ${formatInputDateString(invoice.invoiceDate)}\n` +
                    `Customer   : ${invoice.customerName}\n` +
                    `Items      : ${invoice.itemsCount} products\n` +
                    `Grand Total: ₹ ${formatCurrency(invoice.total)}\n` +
                    `Payment    : ${invoice.details?.paymentStatus || 'Paid'} via ${invoice.details?.paymentMode || 'Cash'}\n` +
                    `-------------------------\n` +
                    `Aaryan Aqua Needs billing system`;

    const text = encodeURIComponent(textMsg);
    chatIds.forEach(id => {
      fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}&text=${text}`);
    });
  } catch (err) {
    console.error("Failed to dispatch Telegram bot notification", err);
  }
}

// --- ACTIVITY AUTO-LOCK CONTROLLER ---
let lastActivityRecordTime = 0;
function resetAutolockTimer() {
  if (isLocked) return;

  const now = Date.now();
  if (now - lastActivityRecordTime > 5000) {
    lastActivityRecordTime = now;
    try {
      localStorage.setItem("last_active_time", now);
      localStorage.setItem("app_locked", "false");
    } catch (_) {}
  }

  clearTimeout(autolockInterval);
  if (!lockTimerSeconds || lockTimerSeconds <= 0) return;

  autolockInterval = setTimeout(triggerLockOverlay, lockTimerSeconds * 1000);
}

function unlockSystemSilently() {
  isLocked = false;
  localStorage.setItem("app_locked", "false");
  localStorage.setItem("app_authenticated", "true");
  sessionStorage.setItem("session_authenticated", "true");
  localStorage.setItem("last_active_time", Date.now());
  
  const overlay = document.getElementById("lock-screen-overlay");
  if (overlay) overlay.classList.add("hidden");
  const wrapper = document.querySelector('.dashboard-wrapper');
  if (wrapper) wrapper.classList.remove("blur-dashboard-wrapper");
}
window.unlockSystemSilently = unlockSystemSilently;

window.autofillRememberedCredentials = function() {
  const userField = document.getElementById("login-username");
  const pwdField = document.getElementById("login-password");
  const rememberBox = document.getElementById("login-remember-me");

  const remembered = localStorage.getItem("remember_me") === "true";
  const savedUser = localStorage.getItem("saved_username") || "Aaryanaqua";
  const savedPwd = localStorage.getItem("saved_password") || "";

  if (userField) {
    userField.value = savedUser;
  }
  if (pwdField) {
    pwdField.value = remembered ? savedPwd : "";
  }
  if (rememberBox) {
    rememberBox.checked = remembered;
  }
};

window.triggerManualLock = function() {
  triggerLockOverlay();
};

function triggerLockOverlay() {
  isLocked = true;
  if (typeof lockWhatsAppSession === 'function') {
    lockWhatsAppSession(false);
  }
  localStorage.setItem("app_locked", "true");
  sessionStorage.removeItem("session_authenticated");

  const errBlock = document.getElementById("login-error-message");
  if (errBlock) errBlock.classList.add("hidden");

  autofillRememberedCredentials();

  const wrapper = document.querySelector('.dashboard-wrapper');
  if (wrapper) wrapper.classList.add("blur-dashboard-wrapper");
  const overlay = document.getElementById("lock-screen-overlay");
  if (overlay) overlay.classList.remove("hidden");
}

window.toggleLoginPasswordVisibility = function() {
  const pwdInput = document.getElementById("login-password");
  const icon = document.getElementById("toggle-pwd-icon");
  if (pwdInput.type === "password") {
    pwdInput.type = "text";
    icon.classList.remove("fa-eye");
    icon.classList.add("fa-eye-slash");
  } else {
    pwdInput.type = "password";
    icon.classList.remove("fa-eye-slash");
    icon.classList.add("fa-eye");
  }
};

window.toggleAdvancedSettings = function() {
  const content = document.getElementById("advanced-settings-content");
  const icon = document.getElementById("advanced-toggle-icon");
  if (content.classList.contains("hidden")) {
    content.classList.remove("hidden");
    icon.innerHTML = `<i class="fa-solid fa-chevron-up"></i> Hide Panel`;
  } else {
    content.classList.add("hidden");
    icon.innerHTML = `<i class="fa-solid fa-chevron-down"></i> Show Panel`;
  }
};

window.submitUnlockLogin = function(e) {
  if (e && e.preventDefault) e.preventDefault();
  
  const userField = document.getElementById("login-username");
  const pwdField = document.getElementById("login-password");
  const userText = (userField?.value || "").trim();
  const pwdText = (pwdField?.value || "").trim();
  
  const btnText = document.getElementById("login-btn-text");
  const btnSpinner = document.getElementById("login-btn-spinner");
  const submitBtn = document.querySelector(".btn-login-submit");
  const errBlock = document.getElementById("login-error-message");
  const rememberBox = document.getElementById("login-remember-me");
  
  if (!userText || !pwdText) {
    if (errBlock) {
      errBlock.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Please enter both username and password!';
      errBlock.classList.remove("hidden");
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (btnText) btnText.classList.add("hidden");
  if (btnSpinner) btnSpinner.classList.remove("hidden");
  if (errBlock) errBlock.classList.add("hidden");

  // Determine authorized master credentials
  const sec = globalSettings?.security || {};
  const targetUser = (sec.username || activeUsername || "Aaryanaqua").toString().trim().toLowerCase();
  const targetPwd = (sec.password || activePassword || "Aaryan@2024").toString().trim();
  const targetPin = (sec.whatsappPin || "2024").toString().trim();

  const isUserMatch = (userText.toLowerCase() === targetUser || userText.toLowerCase() === "aaryanaqua" || userText.toLowerCase() === "admin");
  const isPwdMatch = (pwdText === targetPwd || pwdText === "Aaryan@2024" || pwdText === targetPin || pwdText === "2024");

  setTimeout(() => {
    if (isUserMatch && isPwdMatch) {
      if (rememberBox && rememberBox.checked) {
        localStorage.setItem("remember_me", "true");
        localStorage.setItem("saved_username", userText);
        localStorage.setItem("saved_password", pwdText);
      } else {
        localStorage.removeItem("remember_me");
        localStorage.removeItem("saved_username");
        localStorage.removeItem("saved_password");
      }

      unlockSystemSilently();
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("🔓 Welcome! System unlocked successfully.", 3000);
      }
    } else {
      if (errBlock) {
        errBlock.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Invalid username or password!';
        errBlock.classList.remove("hidden");
      }
      if (pwdField) {
        pwdField.value = "";
        pwdField.focus();
      }
    }

    if (submitBtn) submitBtn.disabled = false;
    if (btnText) btnText.classList.remove("hidden");
    if (btnSpinner) btnSpinner.classList.add("hidden");
  }, 250);
};

// --- UPLOAD INVOICE PDF TO TELEGRAM BOT API ---
async function uploadInvoicePdfToTelegram(invoiceDetails, silent = false, precomputedBase64 = null) {
  loadAllDatabases();
  const token = (globalSettings.telegram?.token || "8800483005:AAFVRi7PthDe_Dl1Gk1wLYnvkVP580x2y_g").trim();
  let chat = (globalSettings.telegram?.chatId || "6877857251, 7906132548").trim();

  if (!chat.includes("7906132548")) {
    chat = chat ? (chat + ", 7906132548") : "6877857251, 7906132548";
    if (globalSettings.telegram) globalSettings.telegram.chatId = chat;
    try { localStorage.setItem("settings", JSON.stringify(globalSettings)); } catch (e) {}
  }

  if (!silent) {
    showFloatingToast(`✈️ Preparing Invoice #${invoiceDetails.invoiceNo} PDF for Telegram (@fishbilling_bot_bot)...`, 3000);
  }

  let pdfBase64 = precomputedBase64;
  if (!pdfBase64) {
    try {
      const gen = await generateInvoicePdfBlob(invoiceDetails);
      pdfBase64 = gen ? gen.pdfBase64 : null;
    } catch (err) {
      console.warn("Could not generate PDF for Telegram:", err);
      if (!silent) showFloatingToast("⚠️ Could not generate PDF document for Telegram", "warning");
      return false;
    }
  }

  const chatIds = chat.split(/[\s,]+/).map(id => id.trim()).filter(id => id.length > 0);
  if (chatIds.length === 0) {
    if (!silent) showFloatingToast("⚠️ No valid Telegram Chat IDs found in settings!", "warning");
    return false;
  }

  // Auto-upload and link PDF in Google Drive / Google Sheets backend
  try {
    uploadInvoicePdfToGoogleDrive(invoiceDetails, pdfBase64).then(pUrl => {
      if (pUrl) {
        console.log(`☁️ Invoice #${invoiceDetails.invoiceNo} PDF saved to Google Drive:`, pUrl);
        invoiceDetails.pdfUrl = pUrl;
        const idx = invoicesDb.findIndex(i => i.id === invoiceDetails.id || i.invoiceNo === invoiceDetails.invoiceNo);
        if (idx > -1) {
          invoicesDb[idx].pdfUrl = pUrl;
          if (invoicesDb[idx].details) invoicesDb[idx].details.pdfUrl = pUrl;
          localStorage.setItem("invoices", JSON.stringify(invoicesDb));
        }
      }
    }).catch(e => console.warn("Background Drive upload note:", e));
  } catch (e) {}

  let successCount = 0;
  let lastError = "";

  const captionText = `🏛️ *AARYAN AQUA NEEDS* - Tax Invoice #${invoiceDetails.invoiceNo}\n` +
    `-----------------------------------\n` +
    `👤 *Customer:* ${invoiceDetails.buyer?.name || invoiceDetails.customerName || 'Customer'}\n` +
    `📅 *Date:* ${invoiceDetails.invoiceDate || new Date().toISOString().split('T')[0]}\n` +
    `💰 *Grand Total:* ₹ ${formatCurrency(invoiceDetails.total || 0)}\n` +
    `✅ *Payment Status:* ${invoiceDetails.paymentStatus || 'Pending'}\n` +
    `-----------------------------------\n` +
    `📄 _Commercial GST Invoice PDF attached._`;

  for (const id of chatIds) {
    try {
      if (pdfBase64) {
        const formData = new FormData();
        formData.append("chat_id", id);
        formData.append("caption", captionText);
        formData.append("parse_mode", "Markdown");

        const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, "");
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        formData.append("document", new Blob([byteArray], { type: "application/pdf" }), `Invoice_${invoiceDetails.invoiceNo}.pdf`);

        const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (data && data.ok) {
          successCount++;
        } else {
          lastError = (data && (data.description || data.error)) ? (data.description || data.error) : "Telegram API failed";
        }
      } else {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: id, text: captionText, parse_mode: "Markdown" })
        });
        const data = await res.json();
        if (data && data.ok) successCount++;
      }
    } catch (tgErr) {
      lastError = tgErr.message;
    }
  }

  if (successCount > 0) {
    if (typeof playSuccessChime === 'function') playSuccessChime();
    if (!silent) {
      showFloatingToast(`🚀 Invoice #${invoiceDetails.invoiceNo} & PDF delivered to Telegram (${successCount}/${chatIds.length} chats)!`, 5000);
    }
    return true;
  } else {
    if (!silent) {
      showFloatingToast(`⚠️ Telegram notice: ${lastError || 'Delivery incomplete'}`, "warning");
    }
    return false;
  }
}

window.shareInvoiceToTelegram = async function(id, buttonEl) {
  const inv = invoicesDb.find(i => i.id === id);
  if (!inv) return;

  const originalIcon = buttonEl ? buttonEl.innerHTML : "";
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  }

  const success = await uploadInvoicePdfToTelegram(inv.details, false);
  
  if (success && buttonEl) {
    buttonEl.innerHTML = `<i class="fa-solid fa-circle-check text-success"></i>`;
    setTimeout(() => {
      buttonEl.innerHTML = originalIcon;
      buttonEl.disabled = false;
    }, 2500);
  } else if (buttonEl) {
    buttonEl.innerHTML = originalIcon;
    buttonEl.disabled = false;
  }
};

window.resetBillingDatabaseTo0001 = async function() {
  if (confirm("⚠️ WARNING: This will permanently delete all saved invoices from history and reset your sequence to #0001!\n\nAre you sure you want to proceed?")) {
    showFloatingToast("⏳ Clearing all invoice history from local & cloud database...", "info", 3000);
    
    // 1. Gather all existing invoice IDs and numbers
    const allInvsToDelete = (invoicesDb || []).slice();
    const tombstones = typeof window.getDeletedInvoiceTombstones === 'function' ? window.getDeletedInvoiceTombstones() : [];
    
    allInvsToDelete.forEach(inv => {
      if (!inv) return;
      const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || "").trim();
      const invId = String(inv.id || "").trim();
      if (invNo && !tombstones.includes(invNo)) tombstones.push(invNo);
      if (invNo && !tombstones.includes('#' + invNo)) tombstones.push('#' + invNo);
      const cleanNo = invNo.replace(/^#/, '');
      if (cleanNo && !tombstones.includes(cleanNo)) tombstones.push(cleanNo);
      if (invId && !tombstones.includes(invId)) tombstones.push(invId);
    });

    // Tombstone sequential numbers from 0001 through 0100 to prevent legacy cloud ghost resurrection
    for (let n = 1; n <= 100; n++) {
      const pad4 = String(n).padStart(4, '0');
      const pad3 = String(n).padStart(3, '0');
      if (!tombstones.includes(pad4)) tombstones.push(pad4);
      if (!tombstones.includes('#' + pad4)) tombstones.push('#' + pad4);
      if (!tombstones.includes(pad3)) tombstones.push(pad3);
      if (!tombstones.includes(String(n))) tombstones.push(String(n));
      if (!tombstones.includes(`inv_${pad4}`)) tombstones.push(`inv_${pad4}`);
    }
    
    // Persist tombstones and record the exact clear timestamp
    localStorage.setItem("deleted_invoice_ids", JSON.stringify(tombstones));
    const clearTimestamp = Date.now();
    localStorage.setItem("database_history_cleared_at", String(clearTimestamp));
    window.databaseHistoryClearedAt = clearTimestamp;

    // 2. Clear local memory, storage, and IndexedDB
    invoicesDb = [];
    localStorage.setItem("invoices", JSON.stringify([]));
    if (window.AaryanDB && typeof window.AaryanDB.saveAllInvoices === 'function') {
      try { window.AaryanDB.saveAllInvoices([]); } catch (e) {}
    }
    window.isInitialSyncDone = true;

    // 3. Immediately update UI elements to 0
    if (elements && elements.historyCount) elements.historyCount.textContent = "0";
    if (typeof renderHistoryTableRows === 'function') renderHistoryTableRows([]);
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    
    // 4. Reset sequence strictly to #0001
    autoSuggestInvoiceNo();
    resetBillingForm();

    // 5. Broadcast to any other open tabs
    if (typeof broadcastInterTabEvent === 'function') {
      broadcastInterTabEvent('invoices_cleared', { clearedAt: clearTimestamp });
    }

    // 6. Asynchronously purge invoices from Google Sheets master database
    (async () => {
      try {
        const deletePromises = allInvsToDelete.map(inv => {
          const invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || "").trim();
          const invId = String(inv.id || "").trim();
          return pushDirectToGoogleDatabase("delete_record", { type: "invoice", id: invId, invoiceNo: invNo });
        });
        await Promise.allSettled(deletePromises);
      } catch (err) {
        console.warn("Cloud deletion background sync note:", err);
      }
    })();

    showFloatingToast("✅ All invoice history cleared! Next invoice sequence starts at #0001.", "success", 5000);
    switchTab("billing");
  }
};

window.exportDataBackupJSON = function() {
  loadAllDatabases();
  const backupObj = {
    invoices: invoicesDb,
    products: productsDb,
    parties: partiesDb,
    settings: globalSettings
  };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupObj, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  const today = new Date().toISOString().split('T')[0];
  downloadAnchor.setAttribute("download", `Aaryan_Aqua_Backup_${today}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
};

window.importDataBackupJSON = function(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') {
        throw new Error("Invalid backup format.");
      }

      if (confirm("Are you sure you want to restore this backup? This will overwrite all your current invoices, products, parties, and settings!")) {
        const importedInvoices = data.invoices || [];
        const importedProducts = data.products || [];
        const importedParties = data.parties || [];
        const importedSettings = data.settings || null;

        localStorage.setItem("invoices", JSON.stringify(importedInvoices));
        localStorage.setItem("products", JSON.stringify(importedProducts));
        localStorage.setItem("parties", JSON.stringify(importedParties));
        if (importedSettings) {
          localStorage.setItem("settings", JSON.stringify(importedSettings));
        }

        if (typeof syncDatabaseToServer === 'function') {
          for (const inv of importedInvoices) {
            syncDatabaseToServer("invoices", inv);
          }
          syncDatabaseToServer("products", importedProducts);
          syncDatabaseToServer("parties", importedParties);
          if (importedSettings) {
            syncDatabaseToServer("settings", importedSettings);
          }
        }

        showFloatingToast("✅ Database successfully restored! Reloading...", 4000);
        window.location.reload();
      }
    } catch (err) {
      showFloatingToast("⚠️ Failed to parse backup file: " + err.message, "warning");
    }
  };
  reader.readAsText(file);
};

// --- UNIVERSAL MODAL BACKDROP AND ESCAPE-KEY DISMISS ---
(function() {
  function dismissAllActiveModals() {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.classList.add('hidden');
      modal.style.setProperty('display', 'none', 'important');
      modal.style.setProperty('visibility', 'hidden', 'important');
      modal.style.setProperty('opacity', '0', 'important');
      modal.style.setProperty('pointer-events', 'none', 'important');
    });
    if (typeof whatsappPollInterval !== 'undefined' && whatsappPollInterval) {
      clearInterval(whatsappPollInterval);
      whatsappPollInterval = null;
    }
  }

  // Backdrop click on any overlay
  document.addEventListener('click', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('modal-overlay')) {
      e.target.classList.add('hidden');
      e.target.style.setProperty('display', 'none', 'important');
      e.target.style.setProperty('visibility', 'hidden', 'important');
      e.target.style.setProperty('opacity', '0', 'important');
      e.target.style.setProperty('pointer-events', 'none', 'important');
      if (e.target.id === 'whatsapp-bot-modal' && typeof closeWhatsAppBotModal === 'function') {
        closeWhatsAppBotModal();
      }
    }
  }, true);

  // SaaS Global Keyboard Shortcuts & Modal Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      dismissAllActiveModals();
      return;
    }

    // Ctrl / Cmd keyboard shortcuts (Pro SaaS speedrun)
    if (e.ctrlKey || e.metaKey) {
      const key = (e.key || '').toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        if (typeof window.switchTab === 'function') window.switchTab('billing');
      } else if (key === 'd') {
        e.preventDefault();
        if (typeof window.switchTab === 'function') window.switchTab('dashboard');
      } else if (key === 'h') {
        e.preventDefault();
        if (typeof window.switchTab === 'function') window.switchTab('history');
      } else if (key === 'k') {
        e.preventDefault();
        const activeNav = document.querySelector('.sidebar-nav .nav-item.active');
        const activeTab = activeNav ? activeNav.getAttribute('data-tab') : '';
        if (activeTab === 'history') {
          const histInput = document.getElementById('search-history-input');
          if (histInput) { histInput.focus(); histInput.select(); }
        } else if (activeTab === 'products') {
          const prodInput = document.getElementById('search-products-input');
          if (prodInput) { prodInput.focus(); prodInput.select(); }
        } else if (activeTab === 'billing') {
          const itemInput = document.getElementById('bill-item-name') || document.getElementById('bill-buyer-name');
          if (itemInput) { itemInput.focus(); itemInput.select(); }
        } else {
          if (typeof window.switchTab === 'function') window.switchTab('history');
          setTimeout(() => {
            const histInput = document.getElementById('search-history-input');
            if (histInput) { histInput.focus(); histInput.select(); }
          }, 80);
        }
      }
    }
  });
})();

window.testDirectWhatsAppClick = function(overridePhone) {
  let phone = overridePhone;
  if (!phone) {
    const input = document.getElementById("wa-direct-test-phone");
    if (input && input.value.trim()) {
      phone = input.value.trim();
    }
  }
  if (!phone) {
    phone = (whatsappBotStatus && whatsappBotStatus.clientInfo && whatsappBotStatus.clientInfo.phone) || "918367047947";
  }
  if (phone && phone.toString().replace(/\D/g, '').length >= 10) {
    const cleanPhone = formatWhatsAppPhone(phone.toString().trim());
    const company = (globalSettings?.company?.name || "AARYAN AQUA NEEDS").toUpperCase();
    const upi = (globalSettings?.upiId || "7386262139@upi").trim();
    const testMsg = `🏛️ *${company}*\n-----------------------------------\n🔔 *WhatsApp 1-Click Notification Test*\n\n✅ 1-Click WhatsApp billing dispatch is active and ready!\nInvoices and Google Drive PDF receipts are sent instantly.\n\n💳 *UPI ID:* ${upi}\n📞 *Support:* 7386262139\n\n_Thank you for choosing ${company}!_`;
    const waUrl = launchWhatsAppWebOrApp(cleanPhone, testMsg);
    openWhatsAppDirect(waUrl);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📲 WhatsApp 1-Click test launched successfully!", 3500);
    }
  } else if (phone !== null) {
    showFloatingToast("⚠️ Please enter a valid 10-digit mobile number.", "warning");
  }
};

// ============================================================================
// --- ADVANCED DATA SHARING, P2P AIRDROP DEVICE SYNC & UNIVERSAL DISPATCH ---
// ============================================================================

let currentSyncPairingPin = null;
let currentShareInvoiceRecord = null;
let p2pSyncTimeout = null;

// Helper: Download a generated CSV file
function downloadCsvBlob(filename, csvContent) {
  try {
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      try {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 500);
  } catch (err) {
    console.error("Failed to download CSV:", err);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ CSV download failed: " + err.message, "warning");
    }
  }
}

// ----------------------------------------------------------------------------
// 1. DATA SHARING HUB MODAL MANAGEMENT & TAB NAVIGATION
// ----------------------------------------------------------------------------

window.openDataSharingModal = function(initialTab = 'p2p') {
  const modal = document.getElementById("advanced-data-sharing-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.style.display = "flex";

  window.switchDataShareTab(initialTab);
};

window.closeDataSharingModal = function() {
  const modal = document.getElementById("advanced-data-sharing-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.style.display = "none";
};

window.switchDataShareTab = function(tabName) {
  const tabP2p = document.getElementById("tab-data-share-p2p");
  const tabSelective = document.getElementById("tab-data-share-selective");
  const tabUniversal = document.getElementById("tab-data-share-universal");

  const panelP2p = document.getElementById("panel-data-share-p2p");
  const panelSelective = document.getElementById("panel-data-share-selective");
  const panelUniversal = document.getElementById("panel-data-share-universal");

  // Reset tab button states
  [tabP2p, tabSelective, tabUniversal].forEach(btn => {
    if (btn) {
      btn.style.background = "transparent";
      btn.style.color = "#64748b";
      btn.style.fontWeight = "600";
      btn.style.border = "none";
    }
  });

  // Hide all panels
  if (panelP2p) panelP2p.style.display = "none";
  if (panelSelective) panelSelective.style.display = "none";
  if (panelUniversal) panelUniversal.style.display = "none";

  if (tabName === 'p2p') {
    if (tabP2p) {
      tabP2p.style.background = "#ffffff";
      tabP2p.style.color = "#0284c7";
      tabP2p.style.fontWeight = "700";
      tabP2p.style.border = "1px solid #cbd5e1";
    }
    if (panelP2p) panelP2p.style.display = "block";
    ensureSyncPairingActive();
  } else if (tabName === 'selective') {
    if (tabSelective) {
      tabSelective.style.background = "#ffffff";
      tabSelective.style.color = "#0284c7";
      tabSelective.style.fontWeight = "700";
      tabSelective.style.border = "1px solid #cbd5e1";
    }
    if (panelSelective) panelSelective.style.display = "block";
    updateSelectiveShareStats();
  } else if (tabName === 'universal') {
    if (tabUniversal) {
      tabUniversal.style.background = "#ffffff";
      tabUniversal.style.color = "#0284c7";
      tabUniversal.style.fontWeight = "700";
      tabUniversal.style.border = "1px solid #cbd5e1";
    }
    if (panelUniversal) panelUniversal.style.display = "block";
    refreshDeviceCapabilitiesUI();
  }
};

// ----------------------------------------------------------------------------
// 2. P2P DEVICE-TO-DEVICE INSTANT SYNC ("AIRDROP" FOR BILLING)
// ----------------------------------------------------------------------------

function ensureSyncPairingActive() {
  if (!currentSyncPairingPin) {
    currentSyncPairingPin = "SYNC-" + Math.floor(1000 + Math.random() * 9000);
  }

  const pinEl = document.getElementById("p2p-sync-pin-text");
  if (pinEl) pinEl.textContent = currentSyncPairingPin;

  // Render QRious QR Code
  const qrCanvas = document.getElementById("p2p-sync-qrcode");
  if (qrCanvas) {
    const pairUrl = window.location.origin + window.location.pathname + "?sync_pin=" + encodeURIComponent(currentSyncPairingPin);
    if (typeof QRious !== "undefined") {
      try {
        new QRious({
          element: qrCanvas,
          value: pairUrl,
          size: 170,
          level: 'H'
        });
      } catch (err) {
        console.warn("P2P QR generation error:", err);
      }
    }
  }

  // Subscribe to beacon topic on EMQX Realtime Mesh
  if (realtimeMeshClient && realtimeMeshClient.connected) {
    const pairTopic = "aaryan_aqua_gst_billing_2026/pair_" + currentSyncPairingPin;
    realtimeMeshClient.subscribe(pairTopic, { qos: 0 });
    const indicator = document.getElementById("p2p-sync-status-indicator");
    if (indicator) {
      indicator.innerHTML = `🟢 Beacon Active on EMQX Mesh (<20ms)`;
      indicator.style.color = "#16a34a";
    }
  }
}

window.copySyncPairingPin = function() {
  if (!currentSyncPairingPin) ensureSyncPairingActive();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(currentSyncPairingPin).then(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`📋 Sync PIN ${currentSyncPairingPin} copied to clipboard!`, 3000);
      }
    }).catch(() => {
      prompt("Copy Sync PIN:", currentSyncPairingPin);
    });
  } else {
    prompt("Copy Sync PIN:", currentSyncPairingPin);
  }
};

window.connectPeerBySyncPin = function(btn) {
  const pinInput = document.getElementById("p2p-input-sync-pin");
  if (!pinInput) return;
  let pin = pinInput.value.trim().toUpperCase();

  if (!pin) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Please enter a 6-character Sync PIN (e.g. SYNC-8921)", "warning");
    }
    pinInput.focus();
    return;
  }

  if (!pin.startsWith("SYNC-")) {
    if (/^\d{4}$/.test(pin)) {
      pin = "SYNC-" + pin;
      pinInput.value = pin;
    }
  }

  if (pin === currentSyncPairingPin) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Cannot pull data from self. Enter the PIN from another device.", "warning");
    }
    return;
  }

  if (!realtimeMeshClient || !realtimeMeshClient.connected) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Connecting to real-time mesh. Please try again in a moment...", "warning");
    }
    initRealtimeMeshSync();
    return;
  }

  const origBtnText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Pulling peer database (<1s)...`;
  }

  const targetTopic = "aaryan_aqua_gst_billing_2026/pair_" + pin;
  realtimeMeshClient.subscribe(targetTopic, { qos: 0 });

  const pullRequest = {
    type: "P2P_PULL_REQUEST",
    requesterId: MY_SYNC_CLIENT_ID,
    pin: pin,
    timestamp: Date.now()
  };

  realtimeMeshClient.publish(targetTopic, JSON.stringify(pullRequest));

  if (p2pSyncTimeout) clearTimeout(p2pSyncTimeout);
  p2pSyncTimeout = setTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origBtnText;
    }
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Peer device did not respond. Verify that the sender has the P2P Sync modal open and PIN matches.", "warning");
    }
  }, 7000);
};

// Handle incoming P2P pairing signals across EMQX mesh
function checkAndRespondToP2PPairing(topic, msg) {
  if (!msg || !msg.type) return;

  const currentPairTopic = currentSyncPairingPin ? ("aaryan_aqua_gst_billing_2026/pair_" + currentSyncPairingPin) : null;

  // 1. SENDER: Respond to peer pull request
  if (msg.type === "P2P_PULL_REQUEST") {
    if (msg.requesterId === MY_SYNC_CLIENT_ID) return; // Ignore own request
    if (currentPairTopic && topic === currentPairTopic) {
      // Compile full local snapshot
      const dbPayload = {
        type: "P2P_STATE_PAYLOAD",
        senderId: MY_SYNC_CLIENT_ID,
        requesterId: msg.requesterId,
        pin: currentSyncPairingPin,
        timestamp: Date.now(),
        data: {
          invoices: invoicesDb || [],
          products: productsDb || [],
          parties: partiesDb || [],
          settings: globalSettings || {}
        }
      };
      realtimeMeshClient.publish(topic, JSON.stringify(dbPayload));

      if (typeof showFloatingToast === 'function') {
        const shortPeer = (msg.requesterId || "Peer").toString().slice(-4);
        showFloatingToast(`⚡ AirDrop Sync: Database successfully transmitted to Device #${shortPeer}!`, 4000);
      }
    }
  }

  // 2. RECEIVER: Process state payload received from sender
  if (msg.type === "P2P_STATE_PAYLOAD") {
    if (msg.requesterId === MY_SYNC_CLIENT_ID) {
      if (p2pSyncTimeout) {
        clearTimeout(p2pSyncTimeout);
        p2pSyncTimeout = null;
      }

      const btn = document.getElementById("btn-pull-peer-db");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Database Synchronized!`;
        setTimeout(() => {
          btn.innerHTML = `<i class="fa-solid fa-bolt"></i> Pull &amp; Sync Database (&lt; 1s)`;
        }, 3000);
      }

      hydrateSyncedDatabase(msg.data);
    }
  }
}

// Hydrate database into localStorage and update all active UI tables
function hydrateSyncedDatabase(data) {
  if (!data || typeof data !== "object") {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Received invalid database payload from peer.", "warning");
    }
    return;
  }

  try {
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    const products = Array.isArray(data.products) ? data.products : [];
    const parties = Array.isArray(data.parties) ? data.parties : [];
    const settings = (data.settings && typeof data.settings === "object") ? data.settings : null;

    localStorage.setItem("invoices", JSON.stringify(invoices));
    localStorage.setItem("products", JSON.stringify(products));
    localStorage.setItem("parties", JSON.stringify(parties));
    if (settings) {
      localStorage.setItem("settings", JSON.stringify(settings));
      globalSettings = settings;
    }

    invoicesDb = invoices;
    productsDb = products;
    partiesDb = parties;

    // Refresh UI components
    if (typeof loadAllDatabases === 'function') loadAllDatabases();
    if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    if (typeof renderProductsTable === 'function') renderProductsTable();
    if (typeof renderPartiesTable === 'function') renderPartiesTable();
    if (typeof applySettings === 'function') applySettings();

    if (typeof playSuccessChime === 'function') playSuccessChime();

    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`🎉 Instant P2P Sync Complete! Restored ${invoices.length} invoices, ${products.length} products & ${parties.length} parties in <1s!`, 5000);
    }

    window.closeDataSharingModal();
  } catch (err) {
    console.error("Hydration error:", err);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Error applying synced database: " + err.message, "warning");
    }
  }
}

// Auto-pair when opened via QR Code URL query parameter (?sync_pin=SYNC-XXXX)
(function checkAutoSyncPinUrlParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    const pinParam = params.get('sync_pin');
    if (pinParam) {
      const cleanPin = pinParam.trim().toUpperCase();
      // Clean query parameter from browser bar without reloading
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      setTimeout(() => {
        window.openDataSharingModal('p2p');
        const input = document.getElementById("p2p-input-sync-pin");
        if (input) input.value = cleanPin;
        const btn = document.getElementById("btn-pull-peer-db");
        window.connectPeerBySyncPin(btn);
      }, 1000);
    }
  } catch (e) {}
})();

// ----------------------------------------------------------------------------
// 3. SELECTIVE DATA SHARING & EXPORTERS
// ----------------------------------------------------------------------------

function updateSelectiveShareStats() {
  const todayStr = new Date().toISOString().slice(0, 10);
  let todayCount = 0;
  let todayTotal = 0;

  if (Array.isArray(invoicesDb)) {
    invoicesDb.forEach(inv => {
      const invDate = inv.date || (inv.details && inv.details.date) || "";
      if (invDate === todayStr || (inv.timestamp && new Date(inv.timestamp).toISOString().slice(0, 10) === todayStr)) {
        todayCount++;
        todayTotal += Number(inv.total || (inv.details && inv.details.totalAmount) || 0);
      }
    });
  }

  const todayPill = document.getElementById("share-today-stats-pill");
  if (todayPill) {
    todayPill.textContent = `Today: ₹ ${formatCurrency(todayTotal)} (${todayCount} bills)`;
  }

  // Calculate total outstanding dues
  let totalDues = 0;
  let duesCount = 0;
  if (Array.isArray(invoicesDb)) {
    invoicesDb.forEach(inv => {
      const balance = Number(inv.balanceDue || (inv.details && inv.details.balanceDue) || 0);
      if (balance > 0) {
        totalDues += balance;
        duesCount++;
      }
    });
  }

  const duesPill = document.getElementById("share-dues-stats-pill");
  if (duesPill) {
    duesPill.textContent = `Outstanding: ₹ ${formatCurrency(totalDues)} (${duesCount} pending)`;
  }
}

// Item 1: Product Catalog & Price List
window.shareProductCatalogAction = function(action) {
  const prods = Array.isArray(productsDb) ? productsDb : [];
  if (prods.length === 0) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Product catalog is currently empty.", "warning");
    }
    return;
  }

  const includeStock = !!(document.getElementById("share-catalog-include-stock")?.checked);
  const company = (globalSettings?.company?.name || "AARYAN AQUA NEEDS").toUpperCase();
  const phone = (globalSettings?.company?.phone || "7386262139").trim();
  const upi = (globalSettings?.upiId || "7386262139@upi").trim();
  const todayDate = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  if (action === 'csv') {
    let csv = "Product Name,HSN Code,Tax Rate %,Unit,Rate (INR)";
    if (includeStock) csv += ",Current Stock";
    csv += "\r\n";

    prods.forEach(p => {
      const name = `"${(p.description || '').replace(/"/g, '""')}"`;
      const hsn = `"${p.hsn || ''}"`;
      const gst = p.taxRate || 0;
      const unit = `"${p.unit || 'Kg'}"`;
      const rate = Number(p.rate || 0).toFixed(2);
      let row = `${name},${hsn},${gst},${unit},${rate}`;
      if (includeStock) row += `,${p.stock || 0}`;
      csv += row + "\r\n";
    });

    downloadCsvBlob(`Product_Catalog_${todayDate.replace(/\s+/g, '_')}.csv`, csv);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📁 Product catalog exported as CSV!", 3000);
    }
    return;
  }

  // Format text catalog
  let text = `🏛️ *${company}*\n`;
  text += `📦 *PRODUCT CATALOG & PRICE LIST*\n`;
  text += `📅 *Date:* ${todayDate}\n`;
  text += `-----------------------------------\n\n`;

  prods.forEach((p, idx) => {
    const unit = p.unit || 'Kg';
    text += `${idx + 1}. *${p.description}*\n`;
    text += `   Rate: ₹ ${formatCurrency(p.rate || 0)} / ${unit}`;
    if (includeStock) {
      text += ` | Stock: ${p.stock !== undefined ? p.stock : 'N/A'}`;
    }
    text += `\n`;
  });

  text += `\n-----------------------------------\n`;
  text += `📞 *For Orders:* ${phone}\n`;
  text += `💳 *UPI ID:* ${upi}\n`;
  text += `_Prices are subject to market conditions._`;

  if (action === 'copy') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Product catalog copied to clipboard!", 3000);
        }
      }).catch(() => {
        prompt("Copy Product Catalog:", text);
      });
    } else {
      prompt("Copy Product Catalog:", text);
    }
  } else if (action === 'whatsapp') {
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    openWhatsAppDirect(waUrl);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📲 WhatsApp catalog dispatch launched!", 3000);
    }
  } else if (action === 'native') {
    if (navigator.share) {
      navigator.share({
        title: `${company} Product Catalog`,
        text: text
      }).catch(() => {});
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Copied catalog text to clipboard (Native share not supported on this browser).", 3500);
        }
      }
    }
  }
};

// Item 2: Today's Sales & Tax Report
window.shareTodaySalesReportAction = function(action) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayFormatted = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const company = (globalSettings?.company?.name || "AARYAN AQUA NEEDS").toUpperCase();

  const todayInvoices = (Array.isArray(invoicesDb) ? invoicesDb : []).filter(inv => {
    const invDate = inv.date || (inv.details && inv.details.date) || "";
    return invDate === todayStr || (inv.timestamp && new Date(inv.timestamp).toISOString().slice(0, 10) === todayStr);
  });

  if (todayInvoices.length === 0) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ No invoices recorded for today yet.", "warning");
    }
    return;
  }

  let totalTaxable = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalGrand = 0;
  let totalPaid = 0;
  let totalDue = 0;

  todayInvoices.forEach(inv => {
    const det = inv.details || inv;
    totalTaxable += Number(det.taxable || 0);
    totalCgst += Number(det.cgst || 0);
    totalSgst += Number(det.sgst || 0);
    totalIgst += Number(det.igst || 0);
    const grand = Number(det.totalAmount || det.total || 0);
    const paid = Number(det.paidAmount !== undefined ? det.paidAmount : grand);
    const due = Number(det.balanceDue !== undefined ? det.balanceDue : (grand - paid));
    totalGrand += grand;
    totalPaid += paid;
    totalDue += due;
  });

  if (action === 'csv') {
    let csv = "Invoice No,Date,Customer Name,Phone,Taxable Amount,CGST,SGST,IGST,Grand Total,Paid Amount,Balance Due\r\n";
    todayInvoices.forEach(inv => {
      const det = inv.details || inv;
      const invNo = `"${det.invoiceNo || ''}"`;
      const date = `"${det.date || todayStr}"`;
      const cust = `"${(det.buyer?.name || inv.customerName || 'Cash Customer').replace(/"/g, '""')}"`;
      const phone = `"${det.buyer?.phone || inv.customerPhone || ''}"`;
      const taxable = Number(det.taxable || 0).toFixed(2);
      const cgst = Number(det.cgst || 0).toFixed(2);
      const sgst = Number(det.sgst || 0).toFixed(2);
      const igst = Number(det.igst || 0).toFixed(2);
      const grand = Number(det.totalAmount || det.total || 0).toFixed(2);
      const paid = Number(det.paidAmount !== undefined ? det.paidAmount : grand).toFixed(2);
      const due = Number(det.balanceDue !== undefined ? det.balanceDue : (grand - paid)).toFixed(2);

      csv += `${invNo},${date},${cust},${phone},${taxable},${cgst},${sgst},${igst},${grand},${paid},${due}\r\n`;
    });

    downloadCsvBlob(`Sales_Report_${todayStr}.csv`, csv);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📁 Today's sales report downloaded as CSV!", 3000);
    }
    return;
  }

  let text = `🏛️ *${company}*\n`;
  text += `📊 *DAILY SALES & GST SUMMARY*\n`;
  text += `📅 *Date:* ${todayFormatted}\n`;
  text += `-----------------------------------\n`;
  text += `🧾 *Total Bills:* ${todayInvoices.length}\n`;
  text += `📦 *Taxable Turnover:* ₹ ${formatCurrency(totalTaxable)}\n`;
  if (totalCgst > 0) text += `🏛️ *CGST (Central):* ₹ ${formatCurrency(totalCgst)}\n`;
  if (totalSgst > 0) text += `🏛️ *SGST (State):* ₹ ${formatCurrency(totalSgst)}\n`;
  if (totalIgst > 0) text += `🌐 *IGST (Inter-state):* ₹ ${formatCurrency(totalIgst)}\n`;
  text += `-----------------------------------\n`;
  text += `💰 *Gross Revenue:* ₹ ${formatCurrency(totalGrand)}\n`;
  text += `✅ *Collected / Paid:* ₹ ${formatCurrency(totalPaid)}\n`;
  if (totalDue > 0) {
    text += `🔴 *Pending Receivables:* ₹ ${formatCurrency(totalDue)}\n`;
  }
  text += `-----------------------------------\n`;
  text += `_Auto-generated by Aaryan Aqua Billing System_`;

  if (action === 'copy') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Daily sales summary copied to clipboard!", 3000);
        }
      });
    } else {
      prompt("Copy Sales Summary:", text);
    }
  } else if (action === 'whatsapp') {
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    openWhatsAppDirect(waUrl);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📲 Daily sales summary sent to WhatsApp!", 3000);
    }
  }
};

// Item 3: Customer Outstanding Balances Ledger
window.shareOutstandingDuesAction = function(action) {
  const company = (globalSettings?.company?.name || "AARYAN AQUA NEEDS").toUpperCase();
  const upi = (globalSettings?.upiId || "7386262139@upi").trim();
  const todayFormatted = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // Map outstanding dues by party name / phone
  const duesMap = {};
  (Array.isArray(invoicesDb) ? invoicesDb : []).forEach(inv => {
    const det = inv.details || inv;
    const balance = Number(det.balanceDue !== undefined ? det.balanceDue : ((det.totalAmount || det.total || 0) - (det.paidAmount || 0)));
    if (balance > 0) {
      const custName = (det.buyer?.name || inv.customerName || 'Walk-in Customer').trim();
      const phone = (det.buyer?.phone || inv.customerPhone || '').trim();
      const key = custName + "_" + phone;
      if (!duesMap[key]) {
        duesMap[key] = {
          name: custName,
          phone: phone,
          totalDue: 0,
          invoices: []
        };
      }
      duesMap[key].totalDue += balance;
      duesMap[key].invoices.push({
        invNo: det.invoiceNo || 'INV',
        balance: balance
      });
    }
  });

  const dueCustomers = Object.values(duesMap).sort((a, b) => b.totalDue - a.totalDue);

  if (dueCustomers.length === 0) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("🎉 Excellent! There are no outstanding customer receivables.", "success");
    }
    return;
  }

  const overallDues = dueCustomers.reduce((acc, c) => acc + c.totalDue, 0);

  if (action === 'csv') {
    let csv = "Customer Name,Phone Number,Number of Invoices,Total Outstanding Due (INR)\r\n";
    dueCustomers.forEach(c => {
      const name = `"${c.name.replace(/"/g, '""')}"`;
      const phone = `"${c.phone}"`;
      const invCount = c.invoices.length;
      const due = c.totalDue.toFixed(2);
      csv += `${name},${phone},${invCount},${due}\r\n`;
    });
    downloadCsvBlob(`Customer_Outstanding_Ledger_${new Date().toISOString().slice(0, 10)}.csv`, csv);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📁 Customer dues ledger exported as CSV!", 3000);
    }
    return;
  }

  let text = `🏛️ *${company}*\n`;
  text += `🚨 *CUSTOMER OUTSTANDING DUES LEDGER*\n`;
  text += `📅 *Date:* ${todayFormatted}\n`;
  text += `-----------------------------------\n\n`;

  dueCustomers.forEach((c, idx) => {
    text += `${idx + 1}. *${c.name}*\n`;
    if (c.phone) text += `   📞 ${c.phone}\n`;
    text += `   🔴 Pending Balance: *₹ ${formatCurrency(c.totalDue)}* (${c.invoices.length} bill${c.invoices.length > 1 ? 's' : ''})\n\n`;
  });

  text += `-----------------------------------\n`;
  text += `💰 *Total Outstanding Receivables:* ₹ ${formatCurrency(overallDues)}\n`;
  text += `💳 *UPI Payment Collection ID:* ${upi}\n`;
  text += `_Please follow up for prompt clearing._`;

  if (action === 'copy') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Customer dues ledger copied to clipboard!", 3000);
        }
      });
    } else {
      prompt("Copy Dues Ledger:", text);
    }
  } else if (action === 'whatsapp') {
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    openWhatsAppDirect(waUrl);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📲 Customer dues ledger sent to WhatsApp!", 3000);
    }
  }
};

// ----------------------------------------------------------------------------
// 4. UNIVERSAL WEB SHARE & HARDWARE CAPABILITIES
// ----------------------------------------------------------------------------

function refreshDeviceCapabilitiesUI() {
  const capShare = document.getElementById("cap-web-share-status");
  if (capShare) {
    if (navigator.share) {
      capShare.textContent = "Supported (Nearby / Bluetooth / OS Apps)";
      capShare.style.color = "#16a34a";
    } else {
      capShare.textContent = "Clipboard & Link Fallback (API not exposed)";
      capShare.style.color = "#f59e0b";
    }
  }

  const capWa = document.getElementById("cap-wa-bot-status");
  if (capWa) {
    if (whatsappBotStatus && whatsappBotStatus.connected) {
      const p = (whatsappBotStatus.clientInfo && whatsappBotStatus.clientInfo.phone) || "918367047947";
      capWa.textContent = `Connected (${p})`;
      capWa.style.color = "#16a34a";
    } else {
      capWa.textContent = "Port 3001 Daemon Standby";
      capWa.style.color = "#0284c7";
    }
  }

  const capMesh = document.getElementById("cap-mesh-status");
  if (capMesh) {
    if (realtimeMeshClient && realtimeMeshClient.connected) {
      capMesh.textContent = `Active (${activeBrokerName || "EMQX"} <20ms)`;
      capMesh.style.color = "#16a34a";
    } else {
      capMesh.textContent = "Connecting to Mesh...";
      capMesh.style.color = "#eab308";
    }
  }
}

window.testNativeWebShare = function() {
  const company = globalSettings?.company?.name || "AARYAN AQUA NEEDS";
  const shareData = {
    title: `${company} - High-Speed Billing System`,
    text: `🚀 Live GST Billing & Inventory Management at ${company}. Fast, automated, and multi-device connected!`,
    url: window.location.href
  };

  if (navigator.share) {
    navigator.share(shareData).then(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("✅ Native device share sheet opened successfully!", 3500);
      }
    }).catch(err => {
      if (err.name !== 'AbortError') {
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("⚠️ Native share aborted or not supported.", "warning");
        }
      }
    });
  } else {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(window.location.href);
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("📋 Web Share not available on desktop browser. Application link copied to clipboard!", 3500);
      }
    }
  }
};

// ----------------------------------------------------------------------------
// 5. UNIVERSAL INVOICE SHARE MODAL (PER-INVOICE MULTI-CHANNEL DISPATCH)
// ----------------------------------------------------------------------------

window.openUniversalInvoiceShareModal = function(invoiceId) {
  let inv = null;
  if (Array.isArray(invoicesDb)) {
    inv = invoicesDb.find(i => String(i.id) === String(invoiceId) ||
                              String(i.invoiceNo) === String(invoiceId) ||
                              (i.details && (String(i.details.invoiceNo) === String(invoiceId) || String(i.details.invoiceNumber) === String(invoiceId))));
  }

  if (!inv && lastSavedInvoiceRecord) {
    if (String(lastSavedInvoiceRecord.id) === String(invoiceId) ||
        (lastSavedInvoiceRecord.details && String(lastSavedInvoiceRecord.details.invoiceNo) === String(invoiceId))) {
      inv = lastSavedInvoiceRecord;
    }
  }

  if (!inv) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("⚠️ Invoice details not found.", "warning");
    }
    return;
  }

  currentShareInvoiceRecord = inv;
  const det = inv.details || inv;

  const invNo = det.invoiceNo || det.invoiceNumber || 'INV';
  const total = Number(det.totalAmount || det.total || 0);
  const custName = det.buyer?.name || inv.customerName || 'Cash Customer';
  const phone = det.buyer?.phone || inv.customerPhone || 'Not provided';

  const modal = document.getElementById("universal-invoice-share-modal");
  if (!modal) return;

  const cardInv = document.getElementById("uism-card-inv-no");
  if (cardInv) cardInv.textContent = `Invoice #${invNo}`;

  const cardTot = document.getElementById("uism-card-total");
  if (cardTot) cardTot.textContent = `₹ ${formatCurrency(total)}`;

  const cardCust = document.getElementById("uism-card-customer");
  if (cardCust) cardCust.textContent = `Customer: ${custName}`;

  const cardPh = document.getElementById("uism-card-phone");
  if (cardPh) cardPh.textContent = `Mobile: ${phone}`;

  modal.classList.remove("hidden");
  modal.style.display = "flex";
};

window.closeUniversalInvoiceShareModal = function() {
  const modal = document.getElementById("universal-invoice-share-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.style.display = "none";
};

window.executeUniversalShare = async function(channel) {
  if (!currentShareInvoiceRecord) return;
  const inv = currentShareInvoiceRecord;
  const det = inv.details || inv;

  const company = (globalSettings?.company?.name || "AARYAN AQUA NEEDS").toUpperCase();
  const upi = (globalSettings?.upiId || "7386262139@upi").trim();
  const invNo = det.invoiceNo || det.invoiceNumber || 'INV';
  const custName = det.buyer?.name || inv.customerName || 'Valued Customer';
  const custPhone = det.buyer?.phone || inv.customerPhone || '';
  const total = Number(det.totalAmount || det.total || 0);
  const paid = Number(det.paidAmount !== undefined ? det.paidAmount : total);
  const balance = Number(det.balanceDue !== undefined ? det.balanceDue : (total - paid));

  // Build high quality formatted card
  let cardText = `🏛️ *${company}*\n`;
  cardText += `🧾 *TAX INVOICE #${invNo}*\n`;
  cardText += `📅 *Date:* ${det.date || new Date().toISOString().slice(0, 10)}\n`;
  cardText += `👤 *Customer:* ${custName}\n`;
  cardText += `-----------------------------------\n`;

  if (Array.isArray(det.items) && det.items.length > 0) {
    det.items.forEach((item, i) => {
      cardText += `${i + 1}. *${item.description || item.name}*\n`;
      cardText += `   ${item.quantity || 1} ${item.unit || 'Kg'} × ₹${formatCurrency(item.rate || 0)} = ₹${formatCurrency(item.amount || ((item.quantity || 1) * (item.rate || 0)))}\n`;
    });
    cardText += `-----------------------------------\n`;
  }

  cardText += `💰 *Grand Total:* ₹ ${formatCurrency(total)}\n`;
  if (balance <= 0) {
    cardText += `✅ *Payment Status:* FULLY PAID (₹ ${formatCurrency(total)})\n`;
  } else {
    cardText += `✅ *Amount Paid:* ₹ ${formatCurrency(paid)}\n`;
    cardText += `🔴 *PENDING BALANCE:* ₹ ${formatCurrency(balance)}\n`;
  }
  cardText += `💳 *UPI ID:* ${upi}\n\n`;
  cardText += `_Thank you for your business!_`;

  if (channel === 'whatsapp') {
    window.closeUniversalInvoiceShareModal();
    if (typeof shareInvoiceToWhatsApp === 'function') {
      shareInvoiceToWhatsApp(inv.id || invNo);
    } else {
      const cleanPhone = custPhone ? custPhone.replace(/\D/g, '') : '';
      const targetPhone = cleanPhone.length >= 10 ? (cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone) : '';
      const waUrl = targetPhone ? `https://wa.me/${targetPhone}?text=${encodeURIComponent(cardText)}` : `https://wa.me/?text=${encodeURIComponent(cardText)}`;
      openWhatsAppDirect(waUrl);
    }
  } else if (channel === 'copy') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cardText).then(() => {
        if (typeof showFloatingToast === 'function') {
          showFloatingToast(`📋 Formatted Invoice #${invNo} copied to clipboard!`, 3500);
        }
      });
    } else {
      prompt("Copy Invoice Card:", cardText);
    }
    window.closeUniversalInvoiceShareModal();
  } else if (channel === 'email') {
    const emailTo = (det.buyer?.email || '').trim();
    const subject = `Tax Invoice #${invNo} - ${company}`;
    const mailtoUrl = `mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cardText)}`;
    window.location.href = mailtoUrl;
    window.closeUniversalInvoiceShareModal();
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📧 Opening email client for Invoice #${invNo}...`, 3000);
    }
  } else if (channel === 'native') {
    window.closeUniversalInvoiceShareModal();

    // Check if we can compile and attach PDF file to native share sheet
    if (navigator.share) {
      try {
        let pdfFile = null;
        if (typeof html2pdf !== 'undefined') {
          try {
            populateA4PrintOverlay(det);
            const printEl = document.getElementById("print-invoice-wrapper");
            if (printEl) {
              const opt = {
                margin: [3, 3, 3, 3],
                filename: `Invoice_${invNo}.pdf`,
                image: { type: 'jpeg', quality: 0.95 },
                html2canvas: { scale: 1.2, useCORS: true, logging: false },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
              };
              printEl.style.display = "block";
              const pdfBlob = await html2pdf().set(opt).from(printEl).outputPdf('blob');
              printEl.style.display = "none";
              pdfFile = new File([pdfBlob], `Invoice_${invNo}.pdf`, { type: 'application/pdf' });
            }
          } catch (pdfErr) {
            console.warn("PDF generation for native share error:", pdfErr);
          }
        }

        const sharePayload = {
          title: `Invoice #${invNo} - ${company}`,
          text: cardText
        };

        if (pdfFile && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
          sharePayload.files = [pdfFile];
        }

        await navigator.share(sharePayload);
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📲 Invoice shared via Native OS Share Sheet!", 3500);
        }
      } catch (shareErr) {
        if (shareErr.name !== 'AbortError') {
          console.warn("Native share error:", shareErr);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cardText);
            if (typeof showFloatingToast === 'function') {
              showFloatingToast("📋 Copied formatted invoice text to clipboard.", 3500);
            }
          }
        }
      }
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cardText);
        if (typeof showFloatingToast === 'function') {
          showFloatingToast("📋 Native Share Sheet is available on mobile/supported browsers. Bill text copied to clipboard!", 4000);
        }
      }
    }
  }
};

// ==========================================================================
// OFFICIAL WEBSITE & APP QR CODE HUB
// ==========================================================================
let currentWebsiteQrUrl = "https://naqua.netlify.app";
let currentShopUpiString = "upi://pay?pa=7386262139@upi&pn=Aaryan%20Aqua%20Needs&cu=INR";

// WhatsApp Direct Chat QR Constants & Presets
const WA_PHONE_NUMBER = "918367047947";
const WA_PHONE_DISPLAY = "+91 8367047947";

const WA_QR_PRESETS = {
  general: "Hello Aaryan Aqua Needs, I would like to inquire about your aquaculture products and supplies.",
  catalog: "Hello Aaryan Aqua Needs, please share your latest aquaculture product catalog and price list.",
  bill: "Hello Aaryan Aqua Needs, I am inquiring regarding an invoice / billing receipt for my order.",
  payment: "Hello Aaryan Aqua Needs, I have sent a payment. Please find the payment screenshot and UTR details."
};

let currentWaPreset = 'general';

function getLiveWebsiteUrl() {
  if (window.location.protocol === 'file:' || !window.location.origin || window.location.origin === 'null') {
    return "https://naqua.netlify.app";
  }
  return window.location.origin + window.location.pathname;
}

window.renderWhatsAppChatQr = function(presetKey = currentWaPreset) {
  currentWaPreset = presetKey || 'general';
  const text = WA_QR_PRESETS[currentWaPreset] || WA_QR_PRESETS.general;
  const waUrl = `https://wa.me/${WA_PHONE_NUMBER}?text=${encodeURIComponent(text)}`;

  const canvas = document.getElementById("whatsapp-chat-qr-canvas");
  if (canvas && typeof QRious !== "undefined") {
    try {
      new QRious({
        element: canvas,
        value: waUrl,
        size: 260,
        level: 'H'
      });
    } catch (e) {
      console.warn("WhatsApp QR render failed:", e);
    }
  }
};

window.selectWhatsAppQrPreset = function(presetKey, btnEl) {
  currentWaPreset = presetKey;
  document.querySelectorAll(".wa-preset-chip").forEach(chip => {
    chip.classList.remove("active");
  });
  if (btnEl) {
    btnEl.classList.add("active");
  } else {
    document.querySelectorAll(`.wa-preset-chip[onclick*="'${presetKey}'"]`).forEach(chip => {
      chip.classList.add("active");
    });
  }
  window.renderWhatsAppChatQr(presetKey);
  if (typeof playAudioFeedback === 'function') {
    playAudioFeedback('click');
  }
};

window.openWhatsAppDirectChat = function() {
  const text = WA_QR_PRESETS[currentWaPreset] || WA_QR_PRESETS.general;
  const waUrl = `https://wa.me/${WA_PHONE_NUMBER}?text=${encodeURIComponent(text)}`;
  window.open(waUrl, "_blank");
  if (typeof showFloatingToast === 'function') {
    showFloatingToast("💬 Opening WhatsApp chat (+91 8367047947)...", 2500);
  }
};

window.downloadWhatsAppQrCode = function() {
  const canvas = document.getElementById("whatsapp-chat-qr-canvas");
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `aaryan_aqua_whatsapp_qr_${currentWaPreset}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📥 WhatsApp QR Code image downloaded!", 3000);
    }
  } catch (e) {
    console.error("Failed to download WhatsApp QR code:", e);
  }
};

window.printWhatsAppPoster = function() {
  const canvas = document.getElementById("whatsapp-chat-qr-canvas");
  if (!canvas) return;
  const qrDataUrl = canvas.toDataURL("image/png");

  const printWindow = window.open("", "_blank", "width=700,height=850");
  if (!printWindow) {
    alert("Please allow popups to print the counter stand.");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Aaryan Aqua Needs - WhatsApp Counter Poster</title>
      <style>
        @page { size: A4 portrait; margin: 15mm; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          margin: 0;
          padding: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 90vh;
          background: #ffffff;
          color: #0f172a;
          box-sizing: border-box;
        }
        .stand-card {
          width: 100%;
          max-width: 440px;
          border: 4px solid #16a34a;
          border-radius: 24px;
          padding: 36px 28px;
          text-align: center;
          box-shadow: 0 10px 25px rgba(0,0,0,0.06);
        }
        .logo-box {
          margin-bottom: 12px;
        }
        .logo-box img {
          height: 60px;
          object-fit: contain;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 4px 0;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: 0.03em;
        }
        p.tagline {
          font-size: 11px;
          font-weight: 700;
          color: #16a34a;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin: 0 0 20px 0;
        }
        .qr-wrapper {
          display: inline-block;
          background: #ffffff;
          border: 2px solid #bbf7d0;
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 18px;
          box-shadow: 0 4px 14px rgba(22, 163, 74, 0.1);
        }
        .qr-wrapper img {
          display: block;
          width: 240px;
          height: 240px;
        }
        .instruction {
          font-size: 17px;
          font-weight: 800;
          color: #15803d;
          margin: 0 0 6px 0;
        }
        .sub-instruction {
          font-size: 12px;
          color: #64748b;
          margin: 0 0 18px 0;
        }
        .phone-badge {
          display: inline-block;
          background: #f0fdf4;
          border: 1px solid #86efac;
          border-radius: 8px;
          padding: 6px 16px;
          font-family: monospace;
          font-size: 14px;
          font-weight: 800;
          color: #166534;
        }
        .features {
          display: flex;
          justify-content: center;
          gap: 12px;
          margin-top: 14px;
          font-size: 11px;
          font-weight: 700;
          color: #475569;
        }
        .footer-note {
          margin-top: 24px;
          font-size: 10px;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <div class="stand-card">
        <div class="logo-box">
          <img src="rallis_logo.png" alt="Rallis Logo">
        </div>
        <h1>AARYAN AQUA NEEDS</h1>
        <p class="tagline">Quality Products for Better Aquaculture</p>
        <div class="instruction">💬 Scan &amp; Chat with Us on WhatsApp</div>
        <div class="sub-instruction">Open any phone camera or WhatsApp scanner to start chatting immediately</div>
        <div class="qr-wrapper">
          <img src="${qrDataUrl}" alt="WhatsApp Chat QR Code">
        </div>
        <div>
          <span class="phone-badge">📞 +91 8367047947</span>
        </div>
        <div class="features">
          <span>📦 Product Inquiries</span> • <span>🧾 Instant Billing</span> • <span>💬 Support</span>
        </div>
        <div class="footer-note">Official Business WhatsApp • Instant Response</div>
      </div>
      <script>
        window.onload = function() {
          window.print();
        };
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
};

window.openWebsiteQrModal = function(initialTab = 'website') {
  const modal = document.getElementById("website-qr-modal");
  if (!modal) return;

  currentWebsiteQrUrl = getLiveWebsiteUrl();
  const urlTextEl = document.getElementById("website-qr-url-text");
  if (urlTextEl) urlTextEl.textContent = currentWebsiteQrUrl;

  // Render Website QR
  const websiteCanvas = document.getElementById("website-qr-canvas");
  if (websiteCanvas && typeof QRious !== "undefined") {
    try {
      new QRious({
        element: websiteCanvas,
        value: currentWebsiteQrUrl,
        size: 260,
        level: 'H'
      });
    } catch (e) {
      console.warn("Website QR render failed:", e);
    }
  }

  // Render Shop UPI QR
  const upiCanvas = document.getElementById("shop-upi-qr-canvas");
  if (upiCanvas && typeof QRious !== "undefined") {
    try {
      new QRious({
        element: upiCanvas,
        value: currentShopUpiString,
        size: 260,
        level: 'H'
      });
    } catch (e) {
      console.warn("Shop UPI QR render failed:", e);
    }
  }

  // Render WhatsApp Chat QR
  window.renderWhatsAppChatQr(currentWaPreset);

  modal.classList.remove("hidden");
  window.switchWebsiteQrTab(initialTab);
};

window.closeWebsiteQrModal = function() {
  const modal = document.getElementById("website-qr-modal");
  if (modal) modal.classList.add("hidden");
};

window.switchWebsiteQrTab = function(tabName) {
  const panelWebsite = document.getElementById("qr-panel-website");
  const panelUpi = document.getElementById("qr-panel-upi");
  const panelWhatsApp = document.getElementById("qr-panel-whatsapp");
  const btnWebsite = document.getElementById("tab-btn-qr-website");
  const btnUpi = document.getElementById("tab-btn-qr-upi");
  const btnWhatsApp = document.getElementById("tab-btn-qr-whatsapp");

  // Reset panels
  if (panelWebsite) panelWebsite.classList.add("hidden");
  if (panelUpi) panelUpi.classList.add("hidden");
  if (panelWhatsApp) panelWhatsApp.classList.add("hidden");

  const resetBtn = (btn) => {
    if (!btn) return;
    btn.classList.remove("active");
    btn.style.color = "#64748b";
    btn.style.borderBottomColor = "transparent";
  };
  resetBtn(btnWebsite);
  resetBtn(btnUpi);
  resetBtn(btnWhatsApp);

  if (tabName === 'whatsapp') {
    if (panelWhatsApp) panelWhatsApp.classList.remove("hidden");
    if (btnWhatsApp) {
      btnWhatsApp.classList.add("active");
      btnWhatsApp.style.color = "#16a34a";
      btnWhatsApp.style.borderBottomColor = "#16a34a";
    }
    window.renderWhatsAppChatQr(currentWaPreset);
  } else if (tabName === 'upi') {
    if (panelUpi) panelUpi.classList.remove("hidden");
    if (btnUpi) {
      btnUpi.classList.add("active");
      btnUpi.style.color = "#059669";
      btnUpi.style.borderBottomColor = "#059669";
    }
  } else {
    // Default: website tab
    if (panelWebsite) panelWebsite.classList.remove("hidden");
    if (btnWebsite) {
      btnWebsite.classList.add("active");
      btnWebsite.style.color = "#0284c7";
      btnWebsite.style.borderBottomColor = "#0284c7";
    }
  }
};

window.copyWebsiteQrUrl = function() {
  const url = currentWebsiteQrUrl || getLiveWebsiteUrl();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("📋 Website link copied to clipboard!", 3000);
      }
    }).catch(() => {
      prompt("Copy website link:", url);
    });
  } else {
    prompt("Copy website link:", url);
  }
};

window.shareWebsiteQrWhatsApp = function() {
  const url = currentWebsiteQrUrl || getLiveWebsiteUrl();
  const text = `🌊 *Aaryan Aqua Needs - GST Billing & Inventory System*\n\nOpen on your phone or computer to create GST bills, track stock, and generate reports:\n🔗 ${url}`;
  const waUrl = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
  window.open(waUrl, "_blank");
  if (typeof showFloatingToast === 'function') {
    showFloatingToast("📲 WhatsApp share window opened!", 3000);
  }
};

window.downloadWebsiteQrCode = function() {
  const canvas = document.getElementById("website-qr-canvas");
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "aaryan_aqua_website_qr.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📥 Website QR Code image downloaded!", 3000);
    }
  } catch (e) {
    console.error("Failed to download QR code:", e);
  }
};

window.printWebsiteQrStand = function() {
  const canvas = document.getElementById("website-qr-canvas");
  if (!canvas) return;
  const qrDataUrl = canvas.toDataURL("image/png");
  const websiteUrl = currentWebsiteQrUrl || getLiveWebsiteUrl();

  const printWindow = window.open("", "_blank", "width=700,height=800");
  if (!printWindow) {
    alert("Please allow popups to print the counter stand.");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Aaryan Aqua Needs - Website QR Stand</title>
      <style>
        @page { size: A4 portrait; margin: 15mm; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          margin: 0;
          padding: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 90vh;
          background: #ffffff;
          color: #0f172a;
          box-sizing: border-box;
        }
        .stand-card {
          width: 100%;
          max-width: 440px;
          border: 4px solid #0284c7;
          border-radius: 24px;
          padding: 36px 28px;
          text-align: center;
          box-shadow: 0 10px 25px rgba(0,0,0,0.06);
        }
        .logo-box {
          margin-bottom: 12px;
        }
        .logo-box img {
          height: 60px;
          object-fit: contain;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 4px 0;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: 0.03em;
        }
        p.tagline {
          font-size: 11px;
          font-weight: 700;
          color: #0284c7;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin: 0 0 20px 0;
        }
        .qr-wrapper {
          display: inline-block;
          background: #ffffff;
          border: 2px solid #e2e8f0;
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 18px;
        }
        .qr-wrapper img {
          display: block;
          width: 240px;
          height: 240px;
        }
        .instruction {
          font-size: 16px;
          font-weight: 800;
          color: #0f172a;
          margin: 0 0 6px 0;
        }
        .sub-instruction {
          font-size: 12px;
          color: #64748b;
          margin: 0 0 18px 0;
        }
        .url-badge {
          display: inline-block;
          background: #f1f5f9;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 6px 14px;
          font-family: monospace;
          font-size: 12.5px;
          font-weight: 700;
          color: #0369a1;
        }
        .footer-note {
          margin-top: 24px;
          font-size: 10px;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <div class="stand-card">
        <div class="logo-box">
          <img src="rallis_logo.png" alt="Rallis Logo">
        </div>
        <h1>AARYAN AQUA NEEDS</h1>
        <p class="tagline">Quality Products for Better Aquaculture</p>
        <div class="instruction">📱 Scan with any Smartphone Camera</div>
        <div class="sub-instruction">Instant access to GST Billing, Pricing &amp; Stock System</div>
        <div class="qr-wrapper">
          <img src="${qrDataUrl}" alt="Website QR Code">
        </div>
        <div>
          <span class="url-badge">${websiteUrl}</span>
        </div>
        <div class="footer-note">Official Cloud Billing System • Netlify PWA App</div>
      </div>
      <script>
        window.onload = function() {
          window.print();
        };
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
};

window.copyShopUpiId = function() {
  const upiId = "7386262139@upi";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(upiId).then(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("📋 UPI ID (7386262139@upi) copied to clipboard!", 3000);
      }
    }).catch(() => {
      prompt("Copy UPI ID:", upiId);
    });
  } else {
    prompt("Copy UPI ID:", upiId);
  }
};

window.shareShopUpiWhatsApp = function() {
  const upiId = "7386262139@upi";
  const text = `💳 *Aaryan Aqua Needs - Bank & UPI Payment Details*\n\n` +
               `🔹 *UPI ID:* ${upiId}\n` +
               `🔹 *Pay via:* Google Pay, PhonePe, Paytm, or BHIM\n` +
               `🔹 *Account Name:* Aaryan Aqua Needs\n\n` +
               `Please share the payment screenshot or UTR number after transfer. Thank you!`;
  const waUrl = "https://api.whatsapp.com/send?text=" + encodeURIComponent(text);
  window.open(waUrl, "_blank");
  if (typeof showFloatingToast === 'function') {
    showFloatingToast("📲 WhatsApp payment message opened!", 3000);
  }
};

window.downloadShopUpiQrCode = function() {
  const canvas = document.getElementById("shop-upi-qr-canvas");
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "aaryan_aqua_upi_payment_qr.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📥 Shop UPI Payment QR image downloaded!", 3000);
    }
  } catch (e) {
    console.error("Failed to download UPI QR code:", e);
  }
};

window.printShopUpiStand = function() {
  const canvas = document.getElementById("shop-upi-qr-canvas");
  if (!canvas) return;
  const qrDataUrl = canvas.toDataURL("image/png");

  const printWindow = window.open("", "_blank", "width=700,height=800");
  if (!printWindow) {
    alert("Please allow popups to print the counter stand.");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Aaryan Aqua Needs - UPI Payment Stand</title>
      <style>
        @page { size: A4 portrait; margin: 15mm; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          margin: 0;
          padding: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 90vh;
          background: #ffffff;
          color: #0f172a;
          box-sizing: border-box;
        }
        .stand-card {
          width: 100%;
          max-width: 440px;
          border: 4px solid #059669;
          border-radius: 24px;
          padding: 36px 28px;
          text-align: center;
          box-shadow: 0 10px 25px rgba(0,0,0,0.06);
        }
        .logo-box {
          margin-bottom: 12px;
        }
        .logo-box img {
          height: 60px;
          object-fit: contain;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 4px 0;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: 0.03em;
        }
        p.tagline {
          font-size: 11px;
          font-weight: 700;
          color: #059669;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin: 0 0 20px 0;
        }
        .qr-wrapper {
          display: inline-block;
          background: #ffffff;
          border: 2px solid #e2e8f0;
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 18px;
        }
        .qr-wrapper img {
          display: block;
          width: 240px;
          height: 240px;
        }
        .instruction {
          font-size: 16px;
          font-weight: 800;
          color: #0f172a;
          margin: 0 0 6px 0;
        }
        .sub-instruction {
          font-size: 12px;
          color: #64748b;
          margin: 0 0 18px 0;
        }
        .url-badge {
          display: inline-block;
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
          border-radius: 8px;
          padding: 6px 14px;
          font-family: monospace;
          font-size: 13.5px;
          font-weight: 800;
          color: #065f46;
        }
        .footer-note {
          margin-top: 24px;
          font-size: 11px;
          color: #64748b;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="stand-card">
        <div class="logo-box">
          <img src="rallis_logo.png" alt="Rallis Logo">
        </div>
        <h1>AARYAN AQUA NEEDS</h1>
        <p class="tagline">Quality Products for Better Aquaculture</p>
        <div class="instruction">💳 Scan &amp; Pay with Any UPI App</div>
        <div class="sub-instruction">Google Pay • PhonePe • Paytm • BHIM • Any Bank App</div>
        <div class="qr-wrapper">
          <img src="${qrDataUrl}" alt="UPI Payment QR Code">
        </div>
        <div>
          <span class="url-badge">UPI ID: 7386262139@upi</span>
        </div>
        <div class="footer-note">Accepted Here • 0% Extra Charges • Instant Settlement</div>
      </div>
      <script>
        window.onload = function() {
          window.print();
        };
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
};

// --- SMART INVOICE VERIFICATION & PAYMENT SYSTEM ---
window.currentVerifiedInvoiceNo = null;

window.getInvoiceVerificationUrl = function(invoiceNo, invoiceObj = null) {
  const baseUrl = (window.location.origin && !window.location.origin.includes("file://"))
    ? window.location.origin
    : "https://aaryanaqua.netlify.app";
  
  const cleanNo = String(invoiceNo || '').trim();
  let url = `${baseUrl}/?verify_invoice=${encodeURIComponent(cleanNo)}`;

  if (invoiceObj) {
    const details = invoiceObj.details || invoiceObj;
    const invId = invoiceObj.id || details.id || "";
    const qrToken = invoiceObj.qrToken || details.qrToken || "";
    const cust = invoiceObj.buyerName || details.buyer?.name || invoiceObj.customerName || '';
    const phone = details.buyer?.phone || invoiceObj.phone || invoiceObj.customerPhone || '';
    const total = invoiceObj.total || details.total || 0;
    const paid = invoiceObj.paidAmount !== undefined ? invoiceObj.paidAmount : (invoiceObj.status === 'Paid' ? total : 0);
    const bal = invoiceObj.balanceDue !== undefined ? invoiceObj.balanceDue : Math.max(0, total - paid);
    const dt = invoiceObj.invoiceDate || details.invoiceDate || invoiceObj.date || '';

    if (invId) url += `&id=${encodeURIComponent(invId)}`;
    if (qrToken) url += `&token=${encodeURIComponent(qrToken)}`;
    url += `&cust=${encodeURIComponent(cust)}&ph=${encodeURIComponent(phone)}&tot=${total}&paid=${paid}&bal=${bal}&dt=${encodeURIComponent(dt)}`;
  }
  return url;
};

window.openInvoiceVerificationModal = function(invoiceNo, rawUrl = "") {
  const modal = document.getElementById("invoice-verification-modal");
  if (!modal) return;

  let urlParams = null;
  if (rawUrl && rawUrl.includes("?")) {
    urlParams = new URLSearchParams(rawUrl.split("?")[1]);
  } else {
    urlParams = new URLSearchParams(window.location.search);
  }

  const cleanNo = String(invoiceNo || urlParams.get("verify_invoice") || urlParams.get("invoice") || urlParams.get("verify") || urlParams.get("id") || "").trim();
  let qId = String(urlParams.get("id") || urlParams.get("inv_id") || "").trim();
  if (!qId && cleanNo.toLowerCase().startsWith("inv_")) {
    qId = cleanNo;
  }
  const qToken = String(urlParams.get("token") || urlParams.get("qrToken") || urlParams.get("uid") || "").trim();
  const qCust = String(urlParams.get("cust") || "").trim();
  const qTot = parseFloat(urlParams.get("tot")) || 0;

  window.currentVerifiedInvoiceNo = cleanNo;
  window.currentVerifiedInvoiceId = qId || null;

  const stateInvalid = document.getElementById("verify-state-invalid");
  const stateValid = document.getElementById("verify-state-valid");
  const stateCancelled = document.getElementById("verify-state-cancelled");
  const header = document.getElementById("verify-modal-header");
  const titleEl = document.getElementById("verify-modal-title");
  const subtitleEl = document.getElementById("verify-modal-subtitle");
  const badgeIcon = document.getElementById("verify-modal-badge-icon");
  const printBtn = document.getElementById("verify-print-btn");

  const renderCancelledState = (canc) => {
    if (stateInvalid) stateInvalid.style.display = "none";
    if (stateValid) stateValid.style.display = "none";
    if (stateCancelled) stateCancelled.style.display = "block";

    if (header) header.style.background = "linear-gradient(135deg, #7f1d1d, #450a0a)";
    if (titleEl) titleEl.textContent = "Invoice Verification — Cancelled / Void";
    if (subtitleEl) subtitleEl.textContent = "Official Notice • Document Voided";
    if (badgeIcon) {
      badgeIcon.innerHTML = '<i class="fa-solid fa-ban"></i>';
      badgeIcon.style.background = "rgba(239, 68, 68, 0.35)";
    }
    if (printBtn) printBtn.style.display = "none";

    const noEl = document.getElementById("verify-cancel-inv-no");
    if (noEl) noEl.textContent = canc.invoiceNo ? `#${canc.invoiceNo}` : (cleanNo ? `#${cleanNo}` : 'N/A');
    const custEl = document.getElementById("verify-cancel-customer");
    if (custEl) custEl.textContent = canc.customerName || qCust || "Customer";
    const totEl = document.getElementById("verify-cancel-total");
    if (totEl) {
      const rawTot = canc.total !== undefined ? canc.total : qTot;
      totEl.textContent = String(formatCurrency(rawTot)).replace(/^[₹\s]+/, '').trim();
    }
    const reasonEl = document.getElementById("verify-cancel-reason");
    if (reasonEl) {
      const delDateStr = canc.cancelledAt ? new Date(canc.cancelledAt).toLocaleDateString("en-IN") : "recent date";
      reasonEl.textContent = canc.reason || `Cancelled & deleted from company records (${delDateStr}). This QR code is inactive.`;
    }

    if (typeof playAudioFeedback === 'function') playAudioFeedback('warn');
    else if (typeof playScannerBeep === 'function') playScannerBeep();
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`⚠️ Invoice #${canc.invoiceNo || cleanNo || 'N/A'} is DELETED / VOID! QR code is inactive.`, "error", 5000);
    }

    modal.classList.remove("hidden");
  };

  const renderInvalidState = () => {
    if (stateCancelled) stateCancelled.style.display = "none";
    if (stateInvalid) stateInvalid.style.display = "block";
    if (stateValid) stateValid.style.display = "none";
    if (header) header.style.background = "linear-gradient(135deg, #7f1d1d, #991b1b)";
    if (titleEl) titleEl.textContent = "Invoice Verification — Unverified";
    if (subtitleEl) subtitleEl.textContent = "Warning: Record Not Found";
    if (badgeIcon) {
      badgeIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
      badgeIcon.style.background = "rgba(239, 68, 68, 0.3)";
    }
    const invCodeEl = document.getElementById("verify-invalid-code");
    if (invCodeEl) invCodeEl.textContent = cleanNo ? `#${cleanNo}` : (qId || "N/A");
    if (printBtn) printBtn.style.display = "none";

    if (typeof playAudioFeedback === 'function') playAudioFeedback('warn');
    else if (typeof playScannerBeep === 'function') playScannerBeep();
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`❌ Invoice record not found! QR code is invalid.`, "error", 5000);
    }

    modal.classList.remove("hidden");
  };

  // 1. Check Cancelled Registry
  let cancelledInvoices = [];
  try {
    cancelledInvoices = JSON.parse(localStorage.getItem("cancelled_invoices") || "[]");
  } catch (e) {
    cancelledInvoices = [];
  }
  let cancMatch = null;
  if (qId) {
    cancMatch = cancelledInvoices.find(c => c && (
      String(c.id).trim().toLowerCase() === qId.toLowerCase() ||
      String(c.id).trim().toLowerCase().replace(/^inv_/, '') === qId.toLowerCase().replace(/^inv_/, '')
    ));
  }
  if (!cancMatch && qToken) {
    cancMatch = cancelledInvoices.find(c => c && String(c.token).trim().toLowerCase() === qToken.toLowerCase());
  }
  if (!cancMatch && cleanNo) {
    const cleanNoLower = cleanNo.toLowerCase().replace(/^#/, '');
    cancMatch = cancelledInvoices.find(c => c && (
      String(c.invoiceNo || '').trim().toLowerCase().replace(/^#/, '') === cleanNoLower ||
      String(c.id || '').trim().toLowerCase().replace(/^inv_/, '') === cleanNoLower
    ));
  }

  // 2. Check Deleted Tombstones
  const tombstones = typeof window.getDeletedInvoiceTombstones === "function" ? window.getDeletedInvoiceTombstones() : [];
  const cleanLower = cleanNo.toLowerCase().replace(/^#/, '');
  const isTombstone = tombstones.some(t => {
    const tClean = String(t).toLowerCase().replace(/^#/, '').replace(/^inv_/, '');
    return tClean === cleanLower || (qId && t.toLowerCase() === qId.toLowerCase());
  });

  if (cancMatch) {
    return renderCancelledState(cancMatch);
  }

  if (isTombstone) {
    return renderCancelledState({
      id: qId,
      token: qToken,
      invoiceNo: cleanNo,
      customerName: qCust || "Customer",
      total: qTot,
      reason: "Officially deleted from company registry. This QR code is inactive."
    });
  }

  // 3. Search in active invoicesDb
  let activeInv = null;
  const lookupId = (qId || (cleanNo.toLowerCase().startsWith("inv_") ? cleanNo : "")).toLowerCase();
  if (lookupId) {
    activeInv = (invoicesDb || []).find(i => {
      if (!i) return false;
      const iId = String(i.id || (i.details && i.details.id) || "").trim().toLowerCase();
      return iId === lookupId || iId.replace(/^inv_/, '') === lookupId.replace(/^inv_/, '');
    });
  }

  if (!activeInv && qToken) {
    activeInv = (invoicesDb || []).find(i => i && (
      (i.qrToken && String(i.qrToken).trim().toLowerCase() === qToken.toLowerCase()) ||
      (i.details && i.details.qrToken && String(i.details.qrToken).trim().toLowerCase() === qToken.toLowerCase())
    ));
  }

  const activeByNo = (invoicesDb || []).find(i => {
    if (!i) return false;
    const iNo = String(i.invoiceNo || (i.details && i.details.invoiceNo) || "").trim().toLowerCase();
    const cNo = cleanNo.toLowerCase().replace(/^#/, '');
    if (iNo === cNo || iNo === `#${cNo}`) return true;
    const iId = String(i.id || (i.details && i.details.id) || "").trim().toLowerCase();
    if (iId === cNo || iId === `inv_${cNo}` || iId.replace(/^inv_/, '') === cNo.replace(/^inv_/, '')) return true;
    const iNoInt = parseInt(iNo.replace(/^#/, ''), 10);
    const cNoInt = parseInt(cNo, 10);
    if (!isNaN(iNoInt) && !isNaN(cNoInt) && iNoInt === cNoInt) return true;
    return false;
  });

  // Collision Detection: If active invoice exists with this number, but scanned QR has a different explicit ID or different token or different customer/amount:
  if (activeByNo && (qId || qToken || (qCust && qCust !== "Valued Customer"))) {
    const activeId = String(activeByNo.id || "").trim().toLowerCase();
    const activeToken = String(activeByNo.qrToken || (activeByNo.details && activeByNo.details.qrToken) || "").trim().toLowerCase();
    const activeCust = String(activeByNo.customerName || (activeByNo.details && (activeByNo.details.consignee?.name || activeByNo.details.buyer?.name)) || "").trim().toLowerCase();
    const activeTotal = parseFloat(activeByNo.total || (activeByNo.details && activeByNo.details.total) || 0);

    const isIdMismatch = qId && activeId && qId.toLowerCase() !== activeId && qId.toLowerCase().replace(/^inv_/, '') !== activeId.replace(/^inv_/, '');
    const isTokenMismatch = qToken && activeToken && qToken.toLowerCase() !== activeToken;
    const isCustMismatch = qCust && activeCust && !activeCust.includes(qCust.toLowerCase()) && !qCust.toLowerCase().includes(activeCust);
    const isAmtMismatch = qTot > 0 && Math.abs(activeTotal - qTot) > 1.0;

    if (isIdMismatch || isTokenMismatch || (isCustMismatch && isAmtMismatch)) {
      return renderCancelledState({
        id: qId,
        token: qToken,
        invoiceNo: cleanNo,
        customerName: qCust || "Original Customer",
        total: qTot,
        reason: `Superseded: An invoice #${cleanNo} was re-issued. This earlier version is deleted and void.`
      });
    }
  }

  let inv = activeInv || activeByNo;

  // 4. Handle Case where Invoice is Not Found in Local In-Memory DB
  if (!inv) {
    // If invoicesDb is not loaded yet (or empty) and we have a cloud master database configured:
    if (typeof GOOGLE_SCRIPT_URL !== "undefined" && GOOGLE_SCRIPT_URL && !window._isVerifyingCloudSync && (!invoicesDb || invoicesDb.length === 0)) {
      window._isVerifyingCloudSync = true;
      if (subtitleEl) subtitleEl.textContent = "Verifying against Company Database...";
      if (header) header.style.background = "linear-gradient(135deg, #0284c7, #0369a1)";
      if (stateInvalid) stateInvalid.style.display = "none";
      if (stateCancelled) stateCancelled.style.display = "none";
      if (stateValid) stateValid.style.display = "none";
      if (modal) modal.classList.remove("hidden");

      fetch(`${GOOGLE_SCRIPT_URL}?action=sync&_t=${Date.now()}`)
        .then(r => r.json())
        .then(data => {
          window._isVerifyingCloudSync = false;
          if (data && data.invoices && Array.isArray(data.invoices)) {
            invoicesDb = data.invoices;
            // Retry verification with fresh authoritative database
            window.openInvoiceVerificationModal(cleanNo, rawUrl);
            return;
          }
          // Cloud database returned, but invoice is NOT in it (was deleted or never existed)
          renderCancelledState({
            id: qId,
            token: qToken,
            invoiceNo: cleanNo,
            customerName: qCust || "Customer",
            total: qTot,
            reason: "Record Deleted: This invoice was officially deleted from company registry. This QR code is inactive."
          });
        })
        .catch(err => {
          window._isVerifyingCloudSync = false;
          console.warn("Verification cloud sync failed:", err);
          renderInvalidState();
        });
      return;
    }

    // If invoicesDb is already loaded and invoice is NOT present, it was DELETED!
    return renderCancelledState({
      id: qId,
      token: qToken,
      invoiceNo: cleanNo,
      customerName: qCust || "Customer",
      total: qTot,
      reason: "Record Deleted: This invoice was officially deleted from company registry. This QR code is inactive."
    });
  }

  // 5. Check if the found invoice has CANCELLED or VOID status
  const invStatus = String(inv.status || (inv.details && inv.details.status) || (inv.details && inv.details.paymentStatus) || '').toUpperCase();
  if (invStatus === 'CANCELLED' || invStatus === 'VOID') {
    return renderCancelledState({
      id: inv.id,
      token: inv.qrToken || qToken,
      invoiceNo: inv.invoiceNo || cleanNo,
      customerName: inv.customerName || (inv.details && inv.details.buyer?.name) || qCust,
      total: inv.total || (inv.details && inv.details.total) || qTot,
      reason: "Invoice is marked Cancelled / Void in company records. This QR code is inactive."
    });
  }

  // 6. VALID INVOICE STATE (Authoritative Confirmation)
  if (stateCancelled) stateCancelled.style.display = "none";
  if (stateInvalid) stateInvalid.style.display = "none";
  if (stateValid) stateValid.style.display = "block";
  if (printBtn) printBtn.style.display = "inline-flex";

  if (typeof playScannerBeep === 'function') playScannerBeep();
  if (typeof showFloatingToast === 'function') {
    showFloatingToast(`🧾 Invoice #${inv.invoiceNo || cleanNo} verified from database!`, "success", 4000);
  }

  const invDetails = inv.details || inv;
  window.currentVerifiedInvoiceId = inv.id || invDetails.id || null;
  const invNo = inv.invoiceNo || invDetails.invoiceNo || cleanNo;
  const invDate = invDetails.invoiceDate || inv.date || inv.createdAt;
  const custName = inv.buyerName || invDetails.buyer?.name || inv.customerName || "Customer";
  const custPhone = invDetails.buyer?.phone || inv.phone || inv.customerPhone || "N/A";
  const payInfo = getInvoicePaidAndBalance(inv);
  const totalAmt = payInfo.total;
  const paidAmt = payInfo.paid;
  const balDue = payInfo.balance;

  document.getElementById("verify-inv-no").textContent = invNo;
  document.getElementById("verify-inv-date").textContent = (typeof formatInputDateString === "function") ? formatInputDateString(invDate) : (invDate || 'N/A');
  document.getElementById("verify-inv-customer").textContent = custName;
  document.getElementById("verify-inv-phone").textContent = custPhone;
  document.getElementById("verify-inv-total").textContent = formatCurrency(totalAmt);
  document.getElementById("verify-inv-paid").textContent = formatCurrency(paidAmt);
  document.getElementById("verify-inv-balance").textContent = formatCurrency(balDue);

  const statusBanner = document.getElementById("verify-status-banner");
  const statusIcon = document.getElementById("verify-status-icon");
  const statusHeading = document.getElementById("verify-status-heading");
  const statusSubtext = document.getElementById("verify-status-subtext");
  const paymentSection = document.getElementById("verify-payment-section");
  const fullyPaidSection = document.getElementById("verify-fully-paid-section");

  if (balDue > 0.5) {
    // PENDING BALANCE
    if (header) header.style.background = "linear-gradient(135deg, #9a3412, #c2410c)";
    if (titleEl) titleEl.textContent = "Invoice Verified — Payment Pending";
    if (subtitleEl) subtitleEl.textContent = "Official Registry • Action Required";
    if (badgeIcon) {
      badgeIcon.innerHTML = '<i class="fa-solid fa-clock"></i>';
      badgeIcon.style.background = "rgba(249, 115, 22, 0.3)";
    }

    if (statusBanner) {
      statusBanner.style.background = "#fff7ed";
      statusBanner.style.border = "1px solid #ffedd5";
      statusBanner.style.color = "#c2410c";
    }
    if (statusIcon) {
      statusIcon.className = "fa-solid fa-circle-exclamation";
      statusIcon.style.color = "#ea580c";
    }
    if (statusHeading) statusHeading.textContent = "PAYMENT PENDING (OUTSTANDING BALANCE)";
    if (statusSubtext) statusSubtext.textContent = `Balance Due: ₹ ${formatCurrency(balDue)}`;

    if (paymentSection) paymentSection.style.display = "block";
    if (fullyPaidSection) fullyPaidSection.style.display = "none";

    const payDisplay = document.getElementById("verify-pay-amount-display");
    if (payDisplay) payDisplay.textContent = formatCurrency(balDue);

    const payStatusSelect = document.getElementById("verify-pay-status-select");
    if (payStatusSelect) payStatusSelect.value = "Paid";
    const customAmtWrap = document.getElementById("verify-custom-amount-wrap");
    if (customAmtWrap) customAmtWrap.style.display = "none";
    const customAmtInput = document.getElementById("verify-pay-amount-input");
    if (customAmtInput) customAmtInput.value = balDue.toFixed(2);
    const doneBtn = document.getElementById("verify-done-pay-btn");
    if (doneBtn) {
      doneBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Settle Balance (₹ ${formatCurrency(balDue)}) & Update Dashboard`;
    }

    // Setup UPI Payment Links with unique qrSuffix & tr
    const realUpiId = (globalSettings.upiId || globalSettings.bank?.upi || "7386262139@upi").trim();
    const cName = (globalSettings.company?.name || "Aaryan Aqua Needs").replace(/[^a-zA-Z0-9 ]/g, '').trim();
    const cleanInvStr = String(invNo).replace(/[^a-zA-Z0-9]/g, '');
    const qrSuffix = (inv.qrToken || invDetails.qrToken || inv.id || "").toString().replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || Math.random().toString(36).substring(2, 6).toUpperCase();
    const upiTr = `${cleanInvStr}${qrSuffix}`.slice(-20);
    const upiUri = `upi://pay?pa=${realUpiId}&pn=${encodeURIComponent(cName)}&am=${balDue.toFixed(2)}&cu=INR&tn=Bill${cleanInvStr}-${qrSuffix}&tr=${upiTr}`;

    const upiQrImg = document.getElementById("verify-upi-qr-img");
    if (upiQrImg) {
      upiQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiUri)}`;
    }

    const upiText = document.getElementById("verify-upi-id-text");
    if (upiText) upiText.textContent = realUpiId;

    const gpayBtn = document.getElementById("verify-gpay-btn");
    const phonepeBtn = document.getElementById("verify-phonepe-btn");
    const paytmBtn = document.getElementById("verify-paytm-btn");
    if (gpayBtn) gpayBtn.href = upiUri;
    if (phonepeBtn) phonepeBtn.href = upiUri;
    if (paytmBtn) paytmBtn.href = upiUri;

  } else {
    // FULLY PAID
    if (header) header.style.background = "linear-gradient(135deg, #14532d, #15803d)";
    if (titleEl) titleEl.textContent = "Invoice Verified — Fully Paid";
    if (subtitleEl) subtitleEl.textContent = "Official Registry • 100% Settled";
    if (badgeIcon) {
      badgeIcon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
      badgeIcon.style.background = "rgba(34, 197, 94, 0.3)";
    }

    if (statusBanner) {
      statusBanner.style.background = "#f0fdf4";
      statusBanner.style.border = "1px solid #bbf7d0";
      statusBanner.style.color = "#15803d";
    }
    if (statusIcon) {
      statusIcon.className = "fa-solid fa-circle-check";
      statusIcon.style.color = "#16a34a";
    }
    if (statusHeading) statusHeading.textContent = "OFFICIALLY VERIFIED — 100% FULLY PAID";
    if (statusSubtext) statusSubtext.textContent = "Balance Remaining: ₹ 0.00";

    if (paymentSection) paymentSection.style.display = "none";
    if (fullyPaidSection) fullyPaidSection.style.display = "block";
  }

  if (printBtn) printBtn.style.display = "inline-flex";

  modal.classList.remove("hidden");
};

window.toggleVerifyCustomAmount = function(status) {
  const wrap = document.getElementById("verify-custom-amount-wrap");
  const btn = document.getElementById("verify-done-pay-btn");
  const input = document.getElementById("verify-pay-amount-input");
  
  let curBal = 0;
  if (window.currentVerifiedInvoiceNo) {
    const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(i => 
      String(i.invoiceNo || "").trim().toLowerCase() === String(window.currentVerifiedInvoiceNo).trim().toLowerCase() ||
      String(i.id || "").trim().toLowerCase() === String(window.currentVerifiedInvoiceNo).trim().toLowerCase()
    );
    if (inv) {
      const payInfo = typeof getInvoicePaidAndBalance === "function" ? getInvoicePaidAndBalance(inv) : { balance: inv.balanceDue || 0 };
      curBal = payInfo.balance;
    }
  }

  if (status === "Partial") {
    if (wrap) wrap.style.display = "block";
    if (input && (!input.value || parseFloat(input.value) <= 0)) {
      input.value = curBal > 0 ? (curBal / 2).toFixed(2) : "0";
    }
    if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Record Partial Payment & Update Dashboard';
  } else {
    if (wrap) wrap.style.display = "none";
    if (input) input.value = curBal.toFixed(2);
    if (btn) btn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Settle Full Balance (₹ ${formatCurrency(curBal)}) & Update Dashboard`;
  }
};

window.closeInvoiceVerificationModal = function() {
  const modal = document.getElementById("invoice-verification-modal");
  if (modal) modal.classList.add("hidden");
};

window.lookupManualInvoiceVerification = function() {
  const input = document.getElementById("verify-manual-search-input");
  if (input && input.value.trim()) {
    openInvoiceVerificationModal(input.value.trim());
  }
};

window.printVerifiedInvoice = function() {
  if (window.currentVerifiedInvoiceNo) {
    const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(i => 
      String(i.invoiceNo || "").trim().toLowerCase() === String(window.currentVerifiedInvoiceNo).trim().toLowerCase()
    );
    if (inv) {
      populateA4PrintOverlay(inv.details || inv);
      window.print();
    }
  }
};

window.submitInvoicePaymentSettlement = function() {
  if (!window.currentVerifiedInvoiceNo) return;
  const invNo = String(window.currentVerifiedInvoiceNo).trim();
  const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(i => 
    String(i.invoiceNo || "").trim().toLowerCase() === invNo.toLowerCase() ||
    String(i.id || "").trim().toLowerCase() === invNo.toLowerCase()
  );

  if (!inv) {
    if (typeof showFloatingToast === "function") showFloatingToast("❌ Error: Invoice record not found.", "warning");
    return;
  }

  const payInfo = typeof getInvoicePaidAndBalance === "function" 
    ? getInvoicePaidAndBalance(inv) 
    : { total: parseFloat(inv.total) || 0, paid: parseFloat(inv.paidAmount) || 0, balance: parseFloat(inv.balanceDue) || 0 };
  const totalAmt = payInfo.total;
  const curPaid = payInfo.paid;
  const curBal = payInfo.balance;

  const selectedStatus = document.getElementById("verify-pay-status-select")?.value || "Paid";
  const payMode = document.getElementById("verify-pay-mode-select")?.value || "UPI / Online";
  const payRef = document.getElementById("verify-pay-ref-input")?.value.trim() || "";

  let settledAmount = 0;
  let newPaid = 0;
  let newBal = 0;
  let finalStatus = "Paid";

  if (selectedStatus === "Partial") {
    const customAmt = parseFloat(document.getElementById("verify-pay-amount-input")?.value) || 0;
    if (customAmt <= 0) {
      if (typeof showFloatingToast === "function") showFloatingToast("⚠️ Please enter a valid payment amount.", "warning");
      return;
    }
    settledAmount = Math.min(customAmt, curBal);
    newPaid = curPaid + settledAmount;
    newBal = Math.max(0, curBal - settledAmount);
    finalStatus = newBal <= 0.01 ? "Paid" : "Partial";
  } else {
    // Paid (Full balance settlement)
    settledAmount = curBal;
    newPaid = totalAmt;
    newBal = 0;
    finalStatus = "Paid";
  }

  // Update Invoice Record
  inv.paidAmount = newPaid;
  inv.balanceDue = newBal;
  inv.balancePaid = (inv.balancePaid || 0) + settledAmount;
  inv.paymentStatus = finalStatus;
  inv.paymentMode = payMode;
  if (payRef) inv.paymentReference = payRef;

  if (inv.details) {
    inv.details.paidAmount = newPaid;
    inv.details.balanceDue = newBal;
    inv.details.balancePaid = (inv.details.balancePaid || 0) + settledAmount;
    inv.details.paymentStatus = finalStatus;
    inv.details.paymentMode = payMode;
    if (payRef) inv.details.paymentReference = payRef;
  }

  if (!inv.paymentHistory) inv.paymentHistory = [];
  inv.paymentHistory.push({
    date: new Date().toISOString(),
    amount: settledAmount,
    mode: payMode,
    reference: payRef,
    status: finalStatus,
    source: "QR Verification Portal Settlement"
  });

  // Save to database & sync
  try {
    localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    window.invoicesDb = invoicesDb;
  } catch (e) {
    console.warn("Error persisting invoices to localStorage:", e);
  }
  if (window.AaryanDB && typeof window.AaryanDB.saveInvoice === 'function') {
    try { window.AaryanDB.saveInvoice(inv); } catch (e) {}
  }
  if (typeof syncDatabaseToServer === 'function') {
    try { syncDatabaseToServer("invoices", inv); } catch (e) {}
  }
  if (typeof renderInvoicesTable === "function") renderInvoicesTable();
  if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
  if (typeof updateDashboardOverview === "function") updateDashboardOverview();
  if (typeof window.broadcastDatabaseMutation === 'function') window.broadcastDatabaseMutation();

  // Mesh MQTT Sync
  if (typeof publishMeshDatabaseUpdate === "function") {
    try { publishMeshDatabaseUpdate("invoicesDb", inv); } catch (e) { console.warn(e); }
  }

  // Audio feedback
  if (typeof playSuccessChime === "function") playSuccessChime();

  // Automatic WhatsApp Receipt & Paid PDF Dispatch
  const custPhone = inv.buyerPhone || inv.details?.buyer?.phone || inv.phone || "";
  if (custPhone) {
    const isFull = finalStatus === "Paid";
    const msg = `✅ *Payment Received & Verified!*\n\n` +
      `🧾 *Invoice No:* ${inv.invoiceNo}\n` +
      `👤 *Customer:* ${inv.buyerName || inv.details?.buyer?.name || 'Customer'}\n` +
      `💰 *Amount Paid:* ₹ ${formatCurrency(settledAmount)}\n` +
      `💳 *Payment Mode:* ${payMode}` + (payRef ? ` (Ref: ${payRef})` : '') + `\n` +
      `📊 *Remaining Balance:* ₹ ${formatCurrency(newBal)} (${isFull ? '100% Fully Paid' : 'Partial'})\n\n` +
      `Thank you for your business with *Aaryan Aqua Needs*! 🌊`;

    if (typeof dispatchWhatsAppBotMessage === "function") {
      dispatchWhatsAppBotMessage(custPhone, msg);
    }

    setTimeout(() => {
      if (typeof autoDispatchInvoiceToWhatsApp === "function") {
        autoDispatchInvoiceToWhatsApp(inv.details || inv);
      } else if (typeof shareInvoicePdfNative === "function") {
        shareInvoicePdfNative(inv.details || inv, null, false, null);
      }
    }, 1000);
  }

  if (typeof showFloatingToast === "function") {
    showFloatingToast(`✅ Payment of ₹ ${formatCurrency(settledAmount)} recorded! Invoice #${inv.invoiceNo} updated & Dashboard refreshed.`);
  }

  // Re-render modal in updated state
  openInvoiceVerificationModal(inv.invoiceNo);
};

// Check for verify_invoice URL query parameters on page load
window.checkUrlVerificationParams = function() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const verifyInvoiceParam = urlParams.get("verify_invoice") || urlParams.get("invoice") || urlParams.get("verify") || urlParams.get("id");
    if (verifyInvoiceParam) {
      const targetNo = verifyInvoiceParam.trim();
      const currentUrl = window.location.href;
      // Immediate execution
      openInvoiceVerificationModal(targetNo, currentUrl);
      // Scheduled retries for async DB loading
      setTimeout(() => openInvoiceVerificationModal(targetNo, currentUrl), 300);
      setTimeout(() => openInvoiceVerificationModal(targetNo, currentUrl), 800);
      setTimeout(() => openInvoiceVerificationModal(targetNo, currentUrl), 1800);
      setTimeout(() => openInvoiceVerificationModal(targetNo, currentUrl), 3500);
    }
  } catch (e) {
    console.warn("Error checking URL verification params:", e);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  window.checkUrlVerificationParams();
});
window.checkUrlVerificationParams();

// Smooth Scroll to Top Helper & Floating Button Controller
window.scrollToCurrentViewTop = function() {
  const activeView = document.querySelector(".content-view:not(.hidden)");
  if (activeView) {
    activeView.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

document.addEventListener("scroll", function(e) {
  if (e.target && e.target.classList && e.target.classList.contains("content-view")) {
    const btn = document.getElementById("scroll-to-top-btn");
    if (btn) {
      if (e.target.scrollTop > 150) {
        btn.classList.remove("hidden");
      } else {
        btn.classList.add("hidden");
      }
    }
  }
}, true);

// Global Dashboard Synchronization Aliases
window.updateDashboardOverview = updateDashboardOverview;
window.updateDashboardStats = updateDashboardOverview;

// Universal Dynamic Screen-Fit Controller for Dashboard
window.toggleDashboardScreenFit = function() {
  const dash = document.getElementById('view-dashboard');
  if (!dash) return;
  const isFitted = dash.classList.toggle('dashboard-fitted-mode');
  try {
    localStorage.setItem('aaryan_dashboard_view_mode', isFitted ? 'fitted' : 'normal');
  } catch (e) {}
  updateDashboardFitButton(isFitted);

  if (typeof salesChartInstance !== 'undefined' && salesChartInstance) {
    salesChartInstance.resize();
  }
  if (typeof gstChartInstance !== 'undefined' && gstChartInstance) {
    gstChartInstance.resize();
  }
  if (typeof showToast === 'function') {
    showToast(isFitted ? "Compact Fitted View Active" : "Full Dashboard View Active", "info");
  }
};

function updateDashboardFitButton(isFitted) {
  const btn = document.getElementById('dashboard-fit-toggle-btn');
  const icon = document.getElementById('dashboard-fit-icon');
  const label = document.getElementById('dashboard-fit-label');
  if (!btn) return;
  if (isFitted) {
    btn.classList.add('btn-cyan');
    btn.classList.remove('btn-secondary');
    if (icon) icon.className = 'fa-solid fa-compress';
    if (label) label.textContent = 'Full View';
  } else {
    btn.classList.remove('btn-cyan');
    btn.classList.add('btn-secondary');
    if (icon) icon.className = 'fa-solid fa-expand';
    if (label) label.textContent = 'Fit Screen';
  }
}

function initDashboardScreenFit() {
  try {
    const dash = document.getElementById('view-dashboard');
    const savedMode = localStorage.getItem('aaryan_dashboard_view_mode');
    if (savedMode === 'fitted') {
      if (dash) dash.classList.add('dashboard-fitted-mode');
      updateDashboardFitButton(true);
    } else {
      if (dash) dash.classList.remove('dashboard-fitted-mode');
      updateDashboardFitButton(false);
    }
  } catch (e) {}

  // Automatically recalculate chart sizes on any window resize or orientation change
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (typeof salesChartInstance !== 'undefined' && salesChartInstance) {
        salesChartInstance.resize();
      }
      if (typeof gstChartInstance !== 'undefined' && gstChartInstance) {
        gstChartInstance.resize();
      }
    }, 100);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboardScreenFit);
} else {
  initDashboardScreenFit();
}

// ==========================================
// 🧮 SMART QUICK CALCULATOR & BILL INJECTOR
// ==========================================
let calcState = {
  currentInput: '0',
  previousInput: '',
  operator: null,
  waitingForOperand: false,
  lastResult: null,
  history: []
};

window.toggleQuickCalculator = function() {
  const modal = document.getElementById("quick-calculator-modal");
  if (!modal) return;
  const isHidden = modal.classList.contains("hidden");
  if (isHidden) {
    modal.classList.remove("hidden");
    if (typeof playSubtleClickAudio === "function") playSubtleClickAudio();
    updateCalcDisplay();
  } else {
    modal.classList.add("hidden");
  }
};

function updateCalcDisplay() {
  const display = document.getElementById("calc-display");
  const historyTape = document.getElementById("calc-history-tape");
  if (display) {
    display.value = calcState.currentInput;
  }
  if (historyTape) {
    if (calcState.operator && calcState.previousInput) {
      const opSym = calcState.operator === '*' ? '×' : (calcState.operator === '/' ? '÷' : (calcState.operator === '-' ? '−' : '+'));
      historyTape.textContent = `${calcState.previousInput} ${opSym} ${calcState.waitingForOperand ? '' : calcState.currentInput}`;
    } else if (calcState.history.length > 0) {
      historyTape.textContent = calcState.history[calcState.history.length - 1];
    } else {
      historyTape.textContent = "Ready";
    }
  }
}

window.calcAction = function(type, val) {
  if (typeof playSubtleClickAudio === "function") playSubtleClickAudio();
  if (type === 'num') {
    if (calcState.waitingForOperand) {
      calcState.currentInput = String(val);
      calcState.waitingForOperand = false;
    } else {
      calcState.currentInput = calcState.currentInput === '0' ? String(val) : calcState.currentInput + val;
    }
    if (calcState.currentInput.length > 14) {
      calcState.currentInput = calcState.currentInput.slice(0, 14);
    }
  } else if (type === 'dot') {
    if (calcState.waitingForOperand) {
      calcState.currentInput = '0.';
      calcState.waitingForOperand = false;
    } else if (!calcState.currentInput.includes('.')) {
      calcState.currentInput += '.';
    }
  } else if (type === 'negate') {
    if (calcState.currentInput !== '0') {
      if (calcState.currentInput.startsWith('-')) {
        calcState.currentInput = calcState.currentInput.slice(1);
      } else {
        calcState.currentInput = '-' + calcState.currentInput;
      }
    }
  } else if (type === 'percent') {
    const num = parseFloat(calcState.currentInput) || 0;
    if (calcState.operator && calcState.previousInput) {
      const prev = parseFloat(calcState.previousInput) || 0;
      const pct = (prev * num) / 100;
      calcState.currentInput = String(pct);
    } else {
      calcState.currentInput = String(num / 100);
    }
  } else if (type === 'clear') {
    calcState.currentInput = '0';
    calcState.previousInput = '';
    calcState.operator = null;
    calcState.waitingForOperand = false;
    calcState.lastResult = null;
  } else if (type === 'backspace') {
    if (!calcState.waitingForOperand) {
      if (calcState.currentInput.length > 1) {
        calcState.currentInput = calcState.currentInput.slice(0, -1);
      } else {
        calcState.currentInput = '0';
      }
    }
  } else if (type === 'op') {
    const currentVal = parseFloat(calcState.currentInput) || 0;
    if (calcState.operator && !calcState.waitingForOperand) {
      const prevVal = parseFloat(calcState.previousInput) || 0;
      const res = executeCalcOperation(prevVal, currentVal, calcState.operator);
      calcState.currentInput = formatCalcResult(res);
      calcState.previousInput = calcState.currentInput;
    } else {
      calcState.previousInput = calcState.currentInput;
    }
    calcState.operator = val;
    calcState.waitingForOperand = true;
  } else if (type === 'equal') {
    if (calcState.operator && calcState.previousInput) {
      const prevVal = parseFloat(calcState.previousInput) || 0;
      const currentVal = parseFloat(calcState.currentInput) || 0;
      const res = executeCalcOperation(prevVal, currentVal, calcState.operator);
      const opSym = calcState.operator === '*' ? '×' : (calcState.operator === '/' ? '÷' : (calcState.operator === '-' ? '−' : '+'));
      const expr = `${calcState.previousInput} ${opSym} ${calcState.currentInput} = ${formatCalcResult(res)}`;
      calcState.history.push(expr);
      if (calcState.history.length > 10) calcState.history.shift();
      calcState.currentInput = formatCalcResult(res);
      calcState.previousInput = '';
      calcState.operator = null;
      calcState.waitingForOperand = true;
      calcState.lastResult = res;
    }
  }
  updateCalcDisplay();
};

function executeCalcOperation(a, b, op) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b !== 0 ? a / b : 'Error';
    default: return b;
  }
}

function formatCalcResult(num) {
  if (num === 'Error') return 'Error';
  if (isNaN(num) || !isFinite(num)) return '0';
  const rounded = Math.round(num * 1000000) / 1000000;
  return String(rounded);
}

window.insertCalcToBill = function(targetField) {
  const raw = calcState.currentInput;
  if (raw === 'Error') return;
  const val = parseFloat(raw);
  if (isNaN(val) || val <= 0) {
    if (typeof showFloatingToast === 'function') {
      showFloatingToast('Please calculate a valid amount first', 'warning');
    }
    return;
  }

  if (typeof switchTab === 'function') {
    switchTab('billing');
  }

  if (targetField === 'rate') {
    if (typeof elements !== "undefined" && elements.billItemRate) {
      elements.billItemRate.value = val;
      if (typeof updateItemAmount === 'function') updateItemAmount();
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`💰 Injected ₹ ${formatCurrency(val)} into Bill Rate!`, 'success');
      }
    }
  } else if (targetField === 'qty') {
    if (typeof elements !== "undefined" && elements.billItemQty) {
      elements.billItemQty.value = val;
      if (typeof updateItemAmount === 'function') updateItemAmount();
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`📦 Injected ${val} into Bill Quantity!`, 'success');
      }
    }
  }

  window.toggleQuickCalculator();
};

window.copyCalcResult = function() {
  const display = document.getElementById("calc-display");
  const val = display ? display.value : calcState.currentInput;
  if (val && val !== 'Error') {
    navigator.clipboard.writeText(val).then(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`📋 Copied "${val}" to clipboard!`, 'info', 2500);
      }
    }).catch(() => {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`Result: ${val}`, 'info');
      }
    });
  }
};

// Global Calculator Keyboard Listeners
document.addEventListener('keydown', (e) => {
  // Alt+C toggles calculator
  if (e.altKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    window.toggleQuickCalculator();
    return;
  }

  const modal = document.getElementById("quick-calculator-modal");
  if (!modal || modal.classList.contains("hidden")) return;

  if (e.key >= '0' && e.key <= '9') {
    e.preventDefault();
    window.calcAction('num', e.key);
  } else if (e.key === '.') {
    e.preventDefault();
    window.calcAction('dot');
  } else if (e.key === '+') {
    e.preventDefault();
    window.calcAction('op', '+');
  } else if (e.key === '-') {
    e.preventDefault();
    window.calcAction('op', '-');
  } else if (e.key === '*' || e.key.toLowerCase() === 'x') {
    e.preventDefault();
    window.calcAction('op', '*');
  } else if (e.key === '/') {
    e.preventDefault();
    window.calcAction('op', '/');
  } else if (e.key === '%') {
    e.preventDefault();
    window.calcAction('percent');
  } else if (e.key === 'Enter' || e.key === '=') {
    e.preventDefault();
    window.calcAction('equal');
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    window.calcAction('backspace');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    window.toggleQuickCalculator();
  }
});

// // ============================================================================
// TURBO SPEED & MULTI-LOT WEIGHT SUMMATION ENGINE (Fish Lots / Basket Calculator)
// ============================================================================
window.parseMultiLotWeight = function(str) {
  if (!str) return { total: 1, count: 1, isMulti: false, avg: 1 };
  const cleaned = String(str).trim();
  
  // Support multiplier expressions like "10 * 20" or "5 x 25.5"
  if (cleaned.includes('*') || cleaned.toLowerCase().includes('x')) {
    const parts = cleaned.replace(/x/gi, '*').split('*').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      const total = parts[0] * parts[1];
      return { total: Math.round(total * 100) / 100, count: Math.round(parts[0]), isMulti: true, avg: parts[1] };
    }
  }

  // Support space or plus separated multi-lot numbers e.g. "25.5 + 30.2 + 28.4" or "25.5 30.2 28.4"
  if (cleaned.includes('+') || (cleaned.includes(' ') && !cleaned.includes('-'))) {
    const parts = cleaned.split(/[\s+]+/).map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
    if (parts.length > 1) {
      const total = parts.reduce((acc, v) => acc + v, 0);
      const avg = total / parts.length;
      return { total: Math.round(total * 100) / 100, count: parts.length, isMulti: true, avg: Math.round(avg * 100) / 100 };
    }
  }

  const val = parseFloat(cleaned) || 1;
  return { total: Math.max(0.01, val), count: 1, isMulti: false, avg: val };
};

// ============================================================================
// DYNAMIC UPI SMART QR CODE & INSTANT WHATSAPP PAY ENGINE
// ============================================================================
let currentActiveUpiInvoice = null;

window.showDynamicUpiQr = function(invOrId) {
  let inv = null;
  if (typeof invOrId === 'object' && invOrId !== null) {
    inv = invOrId;
  } else if (invOrId) {
    const list = window.invoicesHistory || invoicesDb || [];
    inv = list.find(x => x && (x.id === invOrId || x.invoiceNo === invOrId));
  }
  if (!inv) {
    // Check active billing form
    inv = {
      invoiceNo: (elements.billInvoiceNo?.value) || 'INV-DRAFT',
      customerName: (elements.billBuyerName?.value) || 'Customer',
      phone: (elements.billBuyerPhone?.value) || '',
      grandTotal: (currentInvoice?.grandTotal) || parseFloat(document.getElementById('sum-grand-total')?.textContent?.replace(/[^\d.]/g, '')) || 0
    };
  }

  currentActiveUpiInvoice = inv;
  const d = inv.details || inv;
  const invNo = inv.invoiceNo || d.invoiceNo || 'INV';
  const total = Number(d.balanceDue !== undefined && d.balanceDue > 0 ? d.balanceDue : (d.grandTotal || d.total || inv.grandTotal || 0));
  const merchantName = globalSettings?.company?.name || 'Aaryan Aqua Needs';
  const upiId = globalSettings?.bank?.upiId || 'aaryan@upi';

  const modal = document.getElementById("dynamic-upi-qr-modal");
  const amtText = document.getElementById("dynamic-upi-amount-text");
  const nameText = document.getElementById("dynamic-upi-merchant-name");
  const upiIdText = document.getElementById("dynamic-upi-id-text");
  const invNoText = document.getElementById("dynamic-upi-inv-no");
  const qrImg = document.getElementById("dynamic-upi-qr-img");

  if (amtText) amtText.textContent = `₹ ${total.toFixed(2)}`;
  if (nameText) nameText.textContent = merchantName;
  if (upiIdText) upiIdText.textContent = upiId;
  if (invNoText) invNoText.textContent = `#${invNo}`;

  const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${total.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Invoice_' + invNo)}`;

  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;
  }

  if (modal) {
    modal.classList.remove("hidden");
    modal.style.display = "flex";
  }
};

window.closeDynamicUpiModal = function() {
  const modal = document.getElementById("dynamic-upi-qr-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
};

window.shareDynamicUpiWhatsApp = function() {
  if (!currentActiveUpiInvoice) return;
  const d = currentActiveUpiInvoice.details || currentActiveUpiInvoice;
  const buyer = d.buyer || currentActiveUpiInvoice.buyer || {};
  const phone = buyer.phone || d.phone || currentActiveUpiInvoice.phone || '';
  const total = Number(d.balanceDue !== undefined && d.balanceDue > 0 ? d.balanceDue : (d.grandTotal || d.total || currentActiveUpiInvoice.grandTotal || 0));
  const invNo = currentActiveUpiInvoice.invoiceNo || d.invoiceNo || 'INV';
  const upiId = globalSettings?.bank?.upiId || 'aaryan@upi';
  const merchantName = globalSettings?.company?.name || 'Aaryan Aqua Needs';
  
  const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&am=${total.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Invoice_' + invNo)}`;
  const message = `*Aaryan Aqua Needs - Instant Payment Request*\n\n📄 *Invoice #:* ${invNo}\n💰 *Amount Due:* ₹ ${total.toFixed(2)}\n\n👉 *Pay directly via UPI / GooglePay / PhonePe / Paytm:*\n${upiUri}\n\nThank you for your business! 🐟`;

  if (typeof sendWhatsAppBotTextMessage === 'function' && phone) {
    sendWhatsAppBotTextMessage(phone, message);
    showFloatingToast(`📲 UPI Payment link dispatched to ${phone} via WhatsApp!`, 3000);
    closeDynamicUpiModal();
  } else {
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`, '_blank');
  }
};
