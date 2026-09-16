/**
 * ============================================================================
 * SpreadsheetService.gs - Authoritative Data Store Engine using Google Sheets
 * ============================================================================
 */

var SPREADSHEET_NAME = "Aaryan_Aqua_Live_Master_Sheet";

function getMasterSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  var sheetId = props.getProperty("MASTER_SPREADSHEET_ID");
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      Logger.log("Could not open spreadsheet by configured ID: " + e.message);
    }
  }

  if (!ss) {
    var root = getRootFolder();
    var files = root.getFilesByName(SPREADSHEET_NAME);
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
    } else {
      ss = SpreadsheetApp.create(SPREADSHEET_NAME);
      var ssFile = DriveApp.getFileById(ss.getId());
      root.addFile(ssFile);
      DriveApp.getRootFolder().removeFile(ssFile);
    }
    try {
      props.setProperty("MASTER_SPREADSHEET_ID", ss.getId());
    } catch (pe) {}
  }

  // Fast-path: only run tab setup once per lifecycle, skipping 10+ RPC calls on every request
  var isSetup = props.getProperty("TABS_SETUP_DONE");
  if (!isSetup) {
    setupSpreadsheetTabs(ss);
    try { props.setProperty("TABS_SETUP_DONE", "true"); } catch (e) {}
  }
  return ss;
}

function setupSpreadsheetTabs(ss) {
  if (!ss) ss = getMasterSpreadsheet();

  var invoiceHeaders = [
    "Invoice No", "Date", "Customer Name", "Items Count", "Total (₹)", 
    "Payment Status", "Payment Mode", "Paid (₹)", "Balance (₹)", 
    "Buyer Order No", "Transport", "Destination", "PDF Link", "Last Updated", "Invoice Data JSON"
  ];

  var inventoryHeaders = [
    "Product ID", "Product Description", "HSN Code", "Pack Size", 
    "Unit", "Base Rate (₹)", "Discount (%)", "Price After Disc (₹)", "Stock Qty", "Total Value (₹)", "Status"
  ];

  var customerHeaders = [
    "Party ID", "Customer / Party Name", "Type", "GSTIN / UIN", 
    "Phone Number", "State", "State Code", "Full Address"
  ];

  var settingsHeaders = ["Setting Key", "Setting Value JSON", "Last Updated"];
  var auditHeaders = ["Timestamp", "Action", "User / Client", "Record ID", "Status", "Details"];

  ensureSheetWithHeaders(ss, "Invoices", invoiceHeaders, "#1a73e8");
  ensureSheetWithHeaders(ss, "Inventory", inventoryHeaders, "#0d9488");
  ensureSheetWithHeaders(ss, "Customers", customerHeaders, "#7c3aed");
  ensureSheetWithHeaders(ss, "Settings", settingsHeaders, "#ea580c");
  ensureSheetWithHeaders(ss, "Audit_Logs", auditHeaders, "#475569");

  var sheet1 = ss.getSheetByName("Sheet1");
  if (sheet1 && ss.getSheets().length > 1) {
    try { ss.deleteSheet(sheet1); } catch (e) {}
  }
}

function ensureSheetWithHeaders(ss, sheetName, headers, headerColor) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground(headerColor || "#1a73e8");
    headerRange.setFontColor("#ffffff");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);

    for (var i = 1; i <= headers.length; i++) {
      sheet.setColumnWidth(i, 150);
    }
  }
  return sheet;
}

// --- INVOICES CRUD FROM AUTHORITATIVE GOOGLE SHEET ---

function readInvoicesFromSheet(ss) {
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Invoices");
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var invoices = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var invNo = String(row[0] || "").trim();
    if (!invNo) continue;

    var rawJson = row[14] ? String(row[14]).trim() : "";
    var invObj = null;

    if (rawJson && (rawJson.startsWith("{") || rawJson.startsWith("["))) {
      try {
        invObj = JSON.parse(rawJson);
      } catch (e) {}
    }

    if (!invObj) {
      invObj = {
        id: "inv_" + invNo,
        invoiceNo: invNo,
        invoiceDate: row[1] ? String(row[1]) : "",
        customerName: row[2] ? String(row[2]) : "",
        itemsCount: Number(row[3] || 1),
        total: Number(row[4] || 0),
        paymentStatus: row[5] ? String(row[5]) : "Paid",
        paymentMode: row[6] ? String(row[6]) : "Cash",
        paidAmount: Number(row[7] || 0),
        balanceDue: Number(row[8] || 0),
        buyerOrderNo: row[9] ? String(row[9]) : "",
        transportMode: row[10] ? String(row[10]) : "",
        destination: row[11] ? String(row[11]) : "",
        pdfUrl: row[12] ? String(row[12]) : "",
        updatedAt: row[13] ? String(row[13]) : ""
      };
      invObj.details = Object.assign({}, invObj);
    }

    invoices.push(invObj);
  }

  return invoices;
}

function writeInvoiceToSheet(inv, ss) {
  if (!inv) return;
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Invoices");
  if (!sheet) return;

  var invNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || inv.id || "").trim();
  var invDate = inv.invoiceDate || (inv.details && inv.details.invoiceDate) || "";
  var custName = inv.customerName || (inv.details && inv.details.buyer ? inv.details.buyer.name : "") || "";
  var itemsCount = inv.itemsCount || (inv.details && inv.details.items ? inv.details.items.length : 0);
  var total = Number(inv.total || (inv.details && inv.details.total) || 0);

  var d = inv.details || {};
  var payStatus = d.paymentStatus || inv.paymentStatus || "Paid";
  var payMode = d.paymentMode || inv.paymentMode || "";
  var paidAmt = Number(d.paidAmount !== undefined ? d.paidAmount : (inv.paidAmount !== undefined ? inv.paidAmount : total));
  var balDue = Number(d.balanceDue !== undefined ? d.balanceDue : (inv.balanceDue !== undefined ? inv.balanceDue : (total - paidAmt)));
  var orderNo = d.buyerOrderNo || inv.buyerOrderNo || "";
  var transport = d.transportMode || inv.transportMode || "";
  var dest = d.destination || inv.destination || "";
  var lastUpdated = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss");
  var pdfUrl = inv.pdfUrl || d.pdfUrl || "";

  var fullJson = JSON.stringify(inv);

  var lastRow = sheet.getLastRow();
  var targetRow = -1;

  if (lastRow >= 2) {
    var idColVals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < idColVals.length; r++) {
      if (String(idColVals[r][0]).trim() === invNo) {
        targetRow = r + 2;
        break;
      }
    }
  }

  var rowData = [
    invNo, invDate, custName, itemsCount, total,
    payStatus, payMode, paidAmt, balDue,
    orderNo, transport, dest, pdfUrl, lastUpdated, fullJson
  ];

  if (targetRow > -1) {
    sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

function deleteInvoiceFromSheet(delId, ss) {
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Invoices");
  if (!sheet || sheet.getLastRow() < 2) return false;

  var lastRow = sheet.getLastRow();
  var idVals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var target = String(delId).trim();

  for (var r = idVals.length - 1; r >= 0; r--) {
    var cellVal = String(idVals[r][0]).trim();
    if (cellVal === target) {
      sheet.deleteRow(r + 2);
      return true;
    }
  }
  return false;
}

// --- INVENTORY CRUD FROM AUTHORITATIVE GOOGLE SHEET ---

function readInventoryFromSheet(ss) {
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Inventory");
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var products = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var id = String(row[0] || "").trim();
    if (!id && !row[1]) continue;

    products.push({
      id: id || ("prod_" + i),
      description: String(row[1] || ""),
      hsn: String(row[2] || ""),
      packSize: String(row[3] || ""),
      unit: String(row[4] || "NOS"),
      rate: Number(row[5] || 0),
      discount: Number(row[6] || 0),
      price: Number(row[7] || row[5] || 0),
      stock: Number(row[8] || 0),
      totalValue: Number(row[9] || 0),
      status: String(row[10] || "In Stock"),
      updatedAt: new Date().toISOString()
    });
  }
  return products;
}

function writeInventoryToSheet(products, ss) {
  if (!Array.isArray(products)) return;
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Inventory");
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 11).clearContent();
  }

  if (products.length === 0) return;

  var rows = products.map(function(p, idx) {
    var rate = Number(p.rate || 0);
    var disc = Number(p.discount || 0);
    var valAfterDisc = roundToTwo(Math.max(0, rate - (rate * disc / 100)));
    var stock = Number(p.stock || 0);
    var totalVal = roundToTwo(stock * valAfterDisc);
    var status = stock <= 0 ? "Out of Stock" : (stock <= 5 ? "Low Stock" : "In Stock");
    return [
      p.id || ("prod_" + (idx + 1)),
      p.description || "",
      p.hsn || "",
      p.packSize || "",
      p.unit || "NOS",
      rate,
      disc,
      valAfterDisc,
      stock,
      totalVal,
      status
    ];
  });

  sheet.getRange(2, 1, rows.length, 11).setValues(rows);
  sheet.getRange(2, 6, rows.length, 1).setNumberFormat("₹#,##0.00");
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat("0.00\"%\"");
  sheet.getRange(2, 8, rows.length, 1).setNumberFormat("₹#,##0.00");
  sheet.getRange(2, 10, rows.length, 1).setNumberFormat("₹#,##0.00");
}

// --- CUSTOMERS CRUD FROM AUTHORITATIVE GOOGLE SHEET ---

function readCustomersFromSheet(ss) {
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Customers");
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];

  var parties = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var id = String(row[0] || "").trim();
    if (!id && !row[1]) continue;

    parties.push({
      id: id || ("party_" + i),
      name: String(row[1] || ""),
      type: String(row[2] || "buyer"),
      gstin: String(row[3] || ""),
      phone: String(row[4] || ""),
      state: String(row[5] || "Andhra Pradesh"),
      stateCode: String(row[6] || "37"),
      address: String(row[7] || "")
    });
  }
  return parties;
}

function writeCustomersToSheet(parties, ss) {
  if (!Array.isArray(parties)) return;
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Customers");
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 8).clearContent();
  }

  if (parties.length === 0) return;

  var rows = parties.map(function(p, idx) {
    return [
      p.id || ("party_" + (idx + 1)),
      p.name || "",
      p.type || "buyer",
      p.gstin || "",
      p.phone || "",
      p.state || "Andhra Pradesh",
      p.stateCode || "37",
      p.address || ""
    ];
  });

  sheet.getRange(2, 1, rows.length, 8).setValues(rows);
}

// --- AUDIT LOGGING ---

function appendAuditLog(action, user, recordId, status, details, ss) {
  try {
    if (!ss) ss = getMasterSpreadsheet();
    var sheet = ss.getSheetByName("Audit_Logs");
    if (!sheet) return;

    var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss");
    var row = [
      timestamp,
      String(action || ""),
      String(user || "System"),
      String(recordId || "—"),
      String(status || "SUCCESS"),
      String(details || "")
    ];
    sheet.appendRow(row);
  } catch (e) {
    Logger.log("Audit log failed: " + e.message);
  }
}
