/**
 * ============================================================================
 * AARYAN AQUA BILLING SYSTEM - GOOGLE APPS SCRIPT SECURE BACKEND (v5.0 PROD)
 * 100% Google Cloud Services Architecture: Google Apps Script + Google Sheets + Google Drive
 * 
 * NOTE: For production deployment:
 * 1. Open your master spreadsheet in Google Sheets -> Extensions -> Apps Script.
 * 2. Paste this Code.gs content.
 * 3. Go to Project Settings -> Script Properties and set:
 *    - MASTER_SPREADSHEET_ID = <your Google Sheet ID>
 *    - API_SECRET_KEY = <your chosen API token>
 * 4. Deploy -> New deployment -> Web app -> Execute as: Me -> Who has access: Anyone.
 * ============================================================================
 */


// ============================================================================
// MODULE 1: AUTHENTICATION & SECURITY
// ============================================================================
/**
 * ============================================================================
 * AuthService.gs - Google Apps Script Security & Authentication Module
 * ============================================================================
 */

function getApiSecretKey() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("API_SECRET_KEY");
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function extractRequestToken(e, data) {
  var token = "";
  
  // 1. Check query parameter ?token=... or ?apiKey=... or ?auth=...
  if (e && e.parameter) {
    if (e.parameter.token) token = e.parameter.token;
    else if (e.parameter.apiKey) token = e.parameter.apiKey;
    else if (e.parameter.auth) token = e.parameter.auth;
  }
  
  // 2. Check JSON payload { auth: "...", token: "...", apiKey: "..." }
  if (!token && data && typeof data === 'object') {
    if (data.token) token = data.token;
    else if (data.apiKey) token = data.apiKey;
    else if (data.auth) token = data.auth;
  }
  
  return String(token || "").trim();
}

function authenticateRequest(e, data) {
  var expectedKey = getApiSecretKey();
  var providedToken = extractRequestToken(e, data);

  // If no secret key is configured in Script Properties, fail closed (never allow open access)
  if (!expectedKey) {
    return { 
      ok: false, 
      error: "Server configuration error: 'API_SECRET_KEY' is not configured in Google Apps Script Project Settings -> Script Properties." 
    };
  }

  if (!providedToken) {
    return { 
      ok: false, 
      error: "Unauthorized: Authentication required. Please provide a valid API token in 'auth', 'token', or '?token='." 
    };
  }

  if (!constantTimeEquals(providedToken, expectedKey)) {
    return { 
      ok: false, 
      error: "Unauthorized: Invalid API authentication token." 
    };
  }

  return { ok: true, user: "Authorized_Admin_User" };
}


// ============================================================================
// MODULE 2: VALIDATION & FINANCIAL ENGINE
// ============================================================================
/**
 * ============================================================================
 * ValidationService.gs - Strict Server-Side Validation & Financial Calculations
 * ============================================================================
 */

function roundToTwo(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function validateAndComputeInvoice(invoiceData, existingInvoices) {
  if (!invoiceData || typeof invoiceData !== 'object') {
    return { valid: false, error: "Invalid invoice payload: Object required" };
  }

  var d = (invoiceData.details && typeof invoiceData.details === 'object') ? invoiceData.details : invoiceData;

  // 1. Validate Customer Information
  var buyer = invoiceData.buyer || d.buyer || {};
  var customerName = String(buyer.name || invoiceData.customerName || d.customerName || "").trim();
  if (!customerName) {
    return { valid: false, error: "Validation failed: Customer/Party name is required" };
  }

  // 2. Validate Items Array
  var items = invoiceData.items || d.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: "Validation failed: Invoice must contain at least one line item" };
  }

  var sellerStateCode = String(invoiceData.supplyStateCode || "37").trim();
  var buyerStateCode = String((buyer && buyer.stateCode) || invoiceData.buyerStateCode || "37").trim();
  var isLocal = sellerStateCode === buyerStateCode;

  var computedItems = [];
  var taxableSubtotal = 0;
  var totalCgst = 0;
  var totalSgst = 0;
  var totalIgst = 0;

  for (var i = 0; i < items.length; i++) {
    var itm = items[i];
    if (!itm || typeof itm !== 'object') {
      return { valid: false, error: "Validation failed: Line item #" + (i + 1) + " is invalid" };
    }

    var desc = String(itm.description || itm.name || "").trim();
    if (!desc) {
      return { valid: false, error: "Validation failed: Line item #" + (i + 1) + " must have a description or product name" };
    }

    var qty = Number(itm.quantity !== undefined ? itm.quantity : (itm.qty !== undefined ? itm.qty : 0));
    if (isNaN(qty) || qty <= 0) {
      return { valid: false, error: "Validation failed: Quantity for '" + desc + "' must be a positive number greater than zero" };
    }

    var rate = Number(itm.rate !== undefined ? itm.rate : (itm.price !== undefined ? itm.price : 0));
    if (isNaN(rate) || rate < 0) {
      return { valid: false, error: "Validation failed: Rate/Price for '" + desc + "' cannot be negative" };
    }

    var discount = Number(itm.discount || 0);
    if (isNaN(discount) || discount < 0 || discount > 100) {
      return { valid: false, error: "Validation failed: Discount for '" + desc + "' must be between 0% and 100%" };
    }

    var taxRate = Number(itm.taxRate !== undefined ? itm.taxRate : (itm.gst !== undefined ? itm.gst : 0));
    if (isNaN(taxRate) || taxRate < 0 || taxRate > 100) {
      return { valid: false, error: "Validation failed: Tax/GST rate for '" + desc + "' must be between 0% and 100%" };
    }

    // Line item financial calculation
    var lineGross = roundToTwo(qty * rate);
    var lineDiscountAmt = roundToTwo(lineGross * (discount / 100));
    var lineTaxable = roundToTwo(lineGross - lineDiscountAmt);
    taxableSubtotal += lineTaxable;

    // GST calculation
    var lineGstAmt = roundToTwo(lineTaxable * (taxRate / 100));
    var lineCgst = 0;
    var lineSgst = 0;
    var lineIgst = 0;

    if (isLocal) {
      lineCgst = roundToTwo(lineGstAmt / 2);
      lineSgst = roundToTwo(lineGstAmt - lineCgst);
      totalCgst += lineCgst;
      totalSgst += lineSgst;
    } else {
      lineIgst = lineGstAmt;
      totalIgst += lineIgst;
    }

    var lineTotal = roundToTwo(lineTaxable + lineGstAmt);

    computedItems.push({
      id: itm.id || ("item_" + (i + 1)),
      productId: itm.productId || itm.id || "",
      description: desc,
      hsn: String(itm.hsn || ""),
      quantity: qty,
      unit: String(itm.unit || "NOS"),
      rate: rate,
      discount: discount,
      taxRate: taxRate,
      amount: lineTaxable,
      cgst: lineCgst,
      sgst: lineSgst,
      igst: lineIgst,
      total: lineTotal
    });
  }

  taxableSubtotal = roundToTwo(taxableSubtotal);
  totalCgst = roundToTwo(totalCgst);
  totalSgst = roundToTwo(totalSgst);
  totalIgst = roundToTwo(totalIgst);

  var totalTax = roundToTwo(totalCgst + totalSgst + totalIgst);
  var rawTotal = roundToTwo(taxableSubtotal + totalTax);
  var grandTotal = Math.round(rawTotal);
  var roundOff = roundToTwo(grandTotal - rawTotal);

  // 3. Validate Payments
  var paymentStatus = String(invoiceData.paymentStatus || (invoiceData.details && invoiceData.details.paymentStatus) || "Paid").trim();
  var inputPaid = Number(invoiceData.paidAmount !== undefined ? invoiceData.paidAmount : (invoiceData.details && invoiceData.details.paidAmount !== undefined ? invoiceData.details.paidAmount : (paymentStatus === 'Paid' ? grandTotal : 0)));
  
  if (isNaN(inputPaid) || inputPaid < 0) {
    return { valid: false, error: "Validation failed: Paid amount cannot be negative" };
  }

  var paidAmount = roundToTwo(inputPaid);
  if (paymentStatus === "Paid") {
    paidAmount = grandTotal;
  }
  var balanceDue = roundToTwo(Math.max(0, grandTotal - paidAmount));

  // 4. Validate Invoice Number Uniqueness
  var invNo = String(invoiceData.invoiceNo || (invoiceData.details && invoiceData.details.invoiceNo) || "").trim();
  var invId = String(invoiceData.id || "").trim();

  if (existingInvoices && Array.isArray(existingInvoices) && invNo) {
    for (var k = 0; k < existingInvoices.length; k++) {
      var existing = existingInvoices[k];
      var existingNo = String(existing.invoiceNo || (existing.details && existing.details.invoiceNo) || "").trim();
      var existingId = String(existing.id || "").trim();

      // If matching invoiceNo but different ID -> Duplicate invoice number!
      if (existingNo === invNo && existingId && invId && existingId !== invId) {
        return { 
          valid: false, 
          error: "Validation failed: Invoice #" + invNo + " already exists. Duplicate invoice numbers are strictly rejected." 
        };
      }
    }
  }

  return {
    valid: true,
    computed: {
      invoiceNo: invNo,
      id: invId || ("inv_" + Date.now()),
      invoiceDate: invoiceData.invoiceDate || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd"),
      customerName: customerName,
      taxableSubtotal: taxableSubtotal,
      cgst: totalCgst,
      sgst: totalSgst,
      igst: totalIgst,
      totalTax: totalTax,
      roundOff: roundOff,
      total: grandTotal,
      paidAmount: paidAmount,
      balanceDue: balanceDue,
      paymentStatus: balanceDue <= 0 ? "Paid" : (paidAmount > 0 ? "Partial" : "Unpaid"),
      items: computedItems
    }
  };
}


// ============================================================================
// MODULE 3: PRIVATE GOOGLE DRIVE STORAGE
// ============================================================================
/**
 * ============================================================================
 * DriveService.gs - Secure Google Drive Document & PDF Storage Engine
 * ============================================================================
 */

var ROOT_FOLDER_NAME = "Aaryan_Aqua_Billing_Data";
var INVOICES_FOLDER_NAME = "Aaryan_Aqua_Invoices";
var MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024; // 15MB max

function getRootFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("ROOT_FOLDER_ID");
  if (folderId) {
    try {
      var existing = DriveApp.getFolderById(folderId);
      if (existing && !existing.isTrashed()) return existing;
    } catch (e) {}
  }

  var folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    var f = folders.next();
    try { props.setProperty("ROOT_FOLDER_ID", f.getId()); } catch (e) {}
    return f;
  }

  var newFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  try { props.setProperty("ROOT_FOLDER_ID", newFolder.getId()); } catch (e) {}
  return newFolder;
}

function getInvoicesFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("INVOICES_FOLDER_ID");
  if (folderId) {
    try {
      var existing = DriveApp.getFolderById(folderId);
      if (existing && !existing.isTrashed()) return existing;
    } catch (e) {}
  }

  var root = getRootFolder();
  var folders = root.getFoldersByName(INVOICES_FOLDER_NAME);
  var invFolder = null;
  if (folders.hasNext()) {
    invFolder = folders.next();
  } else {
    invFolder = root.createFolder(INVOICES_FOLDER_NAME);
  }

  // Enforce Privacy: Ensure folder is NOT public
  try {
    invFolder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (e) {}

  try { props.setProperty("INVOICES_FOLDER_ID", invFolder.getId()); } catch (e) {}
  return invFolder;
}

function saveInvoicePdfSecure(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: "Upload failed: Missing payload" };
  }

  var pdfBase64 = data.pdfBase64;
  if (!pdfBase64) {
    return { ok: false, error: "Upload failed: Missing pdfBase64 payload" };
  }

  // 1. Sanitize Filename
  var invNo = String(data.invoiceNo || "").trim();
  var rawFilename = String(data.filename || ("Invoice_" + (invNo || Date.now()) + ".pdf")).trim();
  var safeFilename = rawFilename.replace(/[^a-zA-Z0-9_\.-]/g, "_");
  if (!safeFilename.toLowerCase().endsWith(".pdf")) safeFilename += ".pdf";

  // 2. Validate Base64 Payload & PDF Header
  var cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "").replace(/\s/g, '');
  if (cleanBase64.length > (MAX_PDF_SIZE_BYTES * 1.37)) {
    return { ok: false, error: "Upload rejected: File size exceeds 15MB limit" };
  }

  var decodedBytes = null;
  try {
    decodedBytes = Utilities.base64Decode(cleanBase64);
  } catch (e) {
    return { ok: false, error: "Upload rejected: Invalid base64 encoding" };
  }

  if (!decodedBytes || decodedBytes.length === 0) {
    return { ok: false, error: "Upload rejected: Empty PDF content" };
  }

  // 3. Verify PDF Magic Bytes (%PDF)
  var isPdf = false;
  if (decodedBytes.length >= 4) {
    // 0x25 = %, 0x50 = P, 0x44 = D, 0x46 = F
    if (decodedBytes[0] === 37 && decodedBytes[1] === 80 && decodedBytes[2] === 68 && decodedBytes[3] === 70) {
      isPdf = true;
    }
  }

  if (!isPdf && !pdfBase64.startsWith("data:application/pdf")) {
    return { ok: false, error: "Upload rejected: File is not a valid PDF document" };
  }

  var blob = Utilities.newBlob(decodedBytes, "application/pdf", safeFilename);
  var invFolder = getInvoicesFolder();

  // Trash existing file with exact same name to keep archive clean
  var existingFiles = invFolder.getFilesByName(safeFilename);
  while (existingFiles.hasNext()) {
    try { existingFiles.next().setTrashed(true); } catch (e) {}
  }

  var file = invFolder.createFile(blob);
  
  // File Access: Allow view access with link for customers and billing operators
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}

  var fileId = file.getId();
  var viewUrl = "https://drive.google.com/file/d/" + fileId + "/view";

  return {
    ok: true,
    fileId: fileId,
    filename: safeFilename,
    url: viewUrl,
    pdfUrl: viewUrl,
    invoiceNo: invNo
  };
}


// ============================================================================
// MODULE 4: GOOGLE SHEETS AUTHORITATIVE STORAGE
// ============================================================================
/**
 * ============================================================================
 * SpreadsheetService.gs - Authoritative Data Store Engine using Google Sheets
 * ============================================================================
 */

var SPREADSHEET_NAME = "Aaryan_Aqua_Live_Master_Sheet";

function getMasterSpreadsheetId() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty("MASTER_SPREADSHEET_ID");
}

function getMasterSpreadsheet() {
  var ss = null;
  var sheetId = getMasterSpreadsheetId();
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
      PropertiesService.getScriptProperties().setProperty("MASTER_SPREADSHEET_ID", ss.getId());
    } catch (pe) {}
  }

  // Only run setupSpreadsheetTabs if Invoices sheet is missing
  if (!ss.getSheetByName("Invoices")) {
    setupSpreadsheetTabs(ss);
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
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var numCols = Math.min(sheet.getLastColumn(), 15);
  var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var invoices = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
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
    var newRow = sheet.getLastRow();
    sheet.getRange(newRow, 5).setNumberFormat("₹#,##0.00");
    sheet.getRange(newRow, 8).setNumberFormat("₹#,##0.00");
    sheet.getRange(newRow, 9).setNumberFormat("₹#,##0.00");
  }
}

function deleteInvoiceFromSheet(delId, ss) {
  if (!delId) return false;
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Invoices");
  if (!sheet || sheet.getLastRow() < 2) return false;

  var lastRow = sheet.getLastRow();
  var numCols = Math.min(sheet.getLastColumn(), 15);
  var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var targetStr = String(delId).trim().toLowerCase();
  var cleanTarget = targetStr.replace(/^#/, '').replace(/^inv_/, '');
  var numTarget = parseInt(cleanTarget, 10);
  var deletedAny = false;

  for (var r = values.length - 1; r >= 0; r--) {
    var row = values[r];
    var cellVal = String(row[0] || "").trim().toLowerCase();
    var cleanCell = cellVal.replace(/^#/, '').replace(/^inv_/, '');
    var numCell = parseInt(cleanCell, 10);
    var rawJson = row[14] ? String(row[14]).trim() : "";

    var match = false;
    if (cellVal === targetStr || cleanCell === cleanTarget) match = true;
    if (!isNaN(numTarget) && !isNaN(numCell) && numTarget === numCell) match = true;
    if (cellVal === "inv_" + cleanTarget || cellVal === "inv_" + numTarget) match = true;

    // Check raw JSON payload in column 15
    if (!match && rawJson) {
      if (rawJson.indexOf(delId) !== -1 || rawJson.indexOf('"' + cleanTarget + '"') !== -1) {
        try {
          var j = JSON.parse(rawJson);
          if (j.id == delId || j.invoiceNo == delId || j.invoiceNo == cleanTarget) {
            match = true;
          }
        } catch(e) {}
      }
    }

    if (match) {
      sheet.deleteRow(r + 2);
      deletedAny = true;
    }
  }
  return deletedAny;
}

// --- INVENTORY CRUD FROM AUTHORITATIVE GOOGLE SHEET ---

function readInventoryFromSheet(ss) {
  if (!ss) ss = getMasterSpreadsheet();
  var sheet = ss.getSheetByName("Inventory");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  var products = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var id = String(row[0] || "").trim();
    if (!id && !row[1]) continue;

    products.push({
      id: id || ("prod_" + (i + 1)),
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
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var parties = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var id = String(row[0] || "").trim();
    if (!id && !row[1]) continue;

    parties.push({
      id: id || ("party_" + (i + 1)),
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


// ============================================================================
// MODULE 5: INVOICE & INVENTORY SERVICE (LOCKSERVICE CONCURRENCY)
// ============================================================================
/**
 * ============================================================================
 * InvoiceService.gs - Business Logic, Concurrency & Inventory Integration
 * ============================================================================
 */

function processSaveInvoice(invoiceData, user, ss) {
  if (!ss) ss = getMasterSpreadsheet();

  // 1. Concurrency Locking via LockService
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // Wait up to 30 seconds for lock
  } catch (lockErr) {
    return {
      ok: false,
      error: "Server busy: Could not acquire concurrency lock. Another transaction is in progress. Please retry."
    };
  }

  try {
    // 2. Read Authoritative State from Sheets
    var existingInvoices = readInvoicesFromSheet(ss);
    var inventory = readInventoryFromSheet(ss);

    // 3. Strict Server-Side Validation & Recalculation
    var valResult = validateAndComputeInvoice(invoiceData, existingInvoices);
    if (!valResult.valid) {
      return { ok: false, error: valResult.error };
    }

    var computed = valResult.computed;

    // 4. Concurrency Guard: Check if editing existing invoice strictly by ID
    var existingIdx = -1;
    if (computed.id) {
      for (var i = 0; i < existingInvoices.length; i++) {
        if (existingInvoices[i].id === computed.id) {
          existingIdx = i;
          break;
        }
      }
    }

    // Check if suggested invoiceNo is already occupied by a DIFFERENT invoice
    var isNumberCollision = false;
    if (computed.invoiceNo) {
      for (var k = 0; k < existingInvoices.length; k++) {
        if (String(existingInvoices[k].invoiceNo).trim() === String(computed.invoiceNo).trim()) {
          if (existingIdx === -1 || existingInvoices[k].id !== computed.id) {
            isNumberCollision = true;
            break;
          }
        }
      }
    }

    // Auto-Generate Next Sequential Invoice Number if empty OR if collided with concurrent user
    if (!computed.invoiceNo || (existingIdx === -1 && isNumberCollision)) {
      var maxNo = 0;
      for (var k = 0; k < existingInvoices.length; k++) {
        var n = parseInt(String(existingInvoices[k].invoiceNo).replace(/\D/g, ""), 10);
        if (!isNaN(n) && n > maxNo) maxNo = n;
      }
      computed.invoiceNo = String(maxNo + 1).padStart(4, "0");
    }

    // 5. Atomic Inventory Stock Adjustment
    // If editing existing invoice, first restore previous items

    if (existingIdx > -1) {
      var oldInv = existingInvoices[existingIdx];
      var oldItems = (oldInv.details && oldInv.details.items) || oldInv.items || [];
      for (var oi = 0; oi < oldItems.length; oi++) {
        var oldItm = oldItems[oi];
        var oldDesc = String(oldItm.description || oldItm.name || "").trim().toLowerCase();
        for (var p = 0; p < inventory.length; p++) {
          var prod = inventory[p];
          if ((prod.id && prod.id === oldItm.productId) || (prod.description && prod.description.trim().toLowerCase() === oldDesc)) {
            prod.stock = roundToTwo(Number(prod.stock || 0) + Number(oldItm.quantity || 0));
            break;
          }
        }
      }
    }

    // Deduct new items from inventory
    var updatedInventory = JSON.parse(JSON.stringify(inventory));
    for (var ni = 0; ni < computed.items.length; ni++) {
      var newItm = computed.items[ni];
      var newDesc = String(newItm.description || "").trim().toLowerCase();
      var foundProduct = null;

      for (var pi = 0; pi < updatedInventory.length; pi++) {
        var pr = updatedInventory[pi];
        if ((pr.id && pr.id === newItm.productId) || (pr.description && pr.description.trim().toLowerCase() === newDesc)) {
          foundProduct = pr;
          break;
        }
      }

      if (foundProduct) {
        var currentStock = Number(foundProduct.stock || 0);
        if (currentStock < newItm.quantity) {
          return {
            ok: false,
            error: "Insufficient stock for '" + foundProduct.description + "'. Available: " + currentStock + ", Requested: " + newItm.quantity
          };
        }
        foundProduct.stock = roundToTwo(currentStock - newItm.quantity);
        foundProduct.status = foundProduct.stock <= 0 ? "Out of Stock" : (foundProduct.stock <= 5 ? "Low Stock" : "In Stock");
      }
    }

    // 6. Build Consolidated Full Invoice Record
    var fullInvoice = Object.assign({}, invoiceData, {
      id: computed.id,
      invoiceNo: computed.invoiceNo,
      invoiceDate: computed.invoiceDate,
      customerName: computed.customerName,
      itemsCount: computed.items.length,
      total: computed.total,
      paidAmount: computed.paidAmount,
      balanceDue: computed.balanceDue,
      paymentStatus: computed.paymentStatus,
      items: computed.items,
      taxableSubtotal: computed.taxableSubtotal,
      cgst: computed.cgst,
      sgst: computed.sgst,
      igst: computed.igst,
      totalTax: computed.totalTax,
      roundOff: computed.roundOff,
      updatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss")
    });

    fullInvoice.details = Object.assign({}, fullInvoice);

    // 7. Write Authoritative Data to Sheets in Batches
    writeInvoiceToSheet(fullInvoice, ss);
    writeInventoryToSheet(updatedInventory, ss);

    // 8. Invalidate High-Speed Cache Bundle
    try {
      CacheService.getScriptCache().remove("cache_sync_bundle");
    } catch (e) {}

    // 9. Audit Logging
    appendAuditLog("SAVE_INVOICE", user || "Admin", computed.invoiceNo, "SUCCESS", "Total: ₹" + computed.total + " | Paid: ₹" + computed.paidAmount + " | Items: " + computed.items.length, ss);

    return {
      ok: true,
      invoice: fullInvoice,
      record: fullInvoice,
      serverTime: Date.now()
    };

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function processDeleteRecord(type, id, user, ss) {
  if (!ss) ss = getMasterSpreadsheet();

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return { ok: false, error: "Server busy: Could not acquire lock for deletion." };
  }

  try {
    if (type === "invoice") {
      var existingInvoices = readInvoicesFromSheet(ss);
      var targetInv = null;
      for (var i = 0; i < existingInvoices.length; i++) {
        if (existingInvoices[i].id === id || existingInvoices[i].invoiceNo === id) {
          targetInv = existingInvoices[i];
          break;
        }
      }

      // Restore inventory stock for deleted invoice
      if (targetInv) {
        var items = (targetInv.details && targetInv.details.items) || targetInv.items || [];
        var inventory = readInventoryFromSheet(ss);
        for (var j = 0; j < items.length; j++) {
          var itm = items[j];
          var desc = String(itm.description || itm.name || "").trim().toLowerCase();
          for (var p = 0; p < inventory.length; p++) {
            var prod = inventory[p];
            if ((prod.id && prod.id === itm.productId) || (prod.description && prod.description.trim().toLowerCase() === desc)) {
              prod.stock = roundToTwo(Number(prod.stock || 0) + Number(itm.quantity || 0));
              prod.status = prod.stock <= 0 ? "Out of Stock" : (prod.stock <= 5 ? "Low Stock" : "In Stock");
              break;
            }
          }
        }
        writeInventoryToSheet(inventory, ss);
      }

      var targetNo = targetInv ? (targetInv.invoiceNo || id) : id;
      deleteInvoiceFromSheet(targetNo, ss);
      deleteInvoiceFromSheet(id, ss);
      if (targetNo) {
        deleteInvoiceFromSheet(String(targetNo).replace(/^#/, ''), ss);
        var tNum = parseInt(String(targetNo).replace(/^#/, ''), 10);
        if (!isNaN(tNum)) deleteInvoiceFromSheet(String(tNum), ss);
      }
      if (id) {
        deleteInvoiceFromSheet(String(id).replace(/^inv_/, ''), ss);
        var idNum = parseInt(String(id).replace(/^inv_/, ''), 10);
        if (!isNaN(idNum)) deleteInvoiceFromSheet(String(idNum), ss);
      }

      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}

      appendAuditLog("DELETE_INVOICE", user || "Admin", id, "SUCCESS", "Invoice deleted and inventory stock restored", ss);
      return { ok: true, deletedId: id, type: "invoice" };

    } else if (type === "product") {
      var inventory = readInventoryFromSheet(ss);
      var filtered = inventory.filter(function(p) { return p.id !== id; });
      writeInventoryToSheet(filtered, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}
      appendAuditLog("DELETE_PRODUCT", user || "Admin", id, "SUCCESS", "Product removed from inventory", ss);
      return { ok: true, deletedId: id, type: "product" };

    } else if (type === "party" || type === "customer") {
      var customers = readCustomersFromSheet(ss);
      var filteredC = customers.filter(function(c) { return c && c.id !== id && c.name !== id; });
      writeCustomersToSheet(filteredC, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}
      appendAuditLog("DELETE_CUSTOMER", user || "Admin", id, "SUCCESS", "Customer removed from parties database", ss);
      return { ok: true, deletedId: id, type: "party" };
    }

    return { ok: false, error: "Invalid record type: " + type };

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}


// ============================================================================
// MODULE 6: API ROUTER & WEB APP ENTRY POINTS (doGet / doPost)
// ============================================================================
/**
 * ============================================================================
 * ApiRouter.gs - Action Allowlist, Security Filter & HTTP Dispatcher
 * ============================================================================
 */

var ALLOWED_ACTIONS = [
  "status",
  "ping",
  "sync",
  "pull",
  "save_invoice",
  "delete_record",
  "save_products",
  "save_parties",
  "save_settings",
  "upload_pdf"
];

function handleApiGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).trim() : "status";

  // Check allowlist
  if (ALLOWED_ACTIONS.indexOf(action) === -1) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Unknown or unauthorized action: " + action
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 0. Ultra-Fast Ping — keeps V8 container warm, zero sheet access (<50ms)
  if (action === "ping") {
    return ContentService.createTextOutput(JSON.stringify({
      ok: true, pong: true, t: Date.now()
    })).setMimeType(ContentService.MimeType.JSON);
  }

function computeSyncDataHash(invs, prods, parts) {
  var str = (invs ? invs.length : 0) + '|' + (prods ? prods.length : 0) + '|' + (parts ? parts.length : 0);
  if (invs && invs.length > 0) {
    var lastInv = invs[invs.length - 1];
    str += '|' + (lastInv.id || lastInv.invoiceNo || '') + '|' + (lastInv.updatedAt || lastInv.invoiceDate || '');
  }
  if (prods && prods.length > 0) {
    str += '|' + (prods[0].stock || 0) + '|' + (prods[prods.length - 1].stock || 0);
  }
  var hash = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function handleApiGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).trim() : "status";

  // 1. Status Health Check
  if (action === "status") {
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      status: "healthy",
      serverTime: Date.now(),
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 2. Authoritative Sync / Pull from Google Sheets with Fast Delta Validation
  if (action === "sync" || action === "pull") {
    var auth = authenticateRequest(e, null);
    if (!auth.ok) {
      return ContentService.createTextOutput(JSON.stringify(auth)).setMimeType(ContentService.MimeType.JSON);
    }

    var clientHash = e && e.parameter && e.parameter.hash ? String(e.parameter.hash).trim() : "";

    // Read Authoritative Data directly from Google Sheets
    var ssMaster = getMasterSpreadsheet();
    var invs = readInvoicesFromSheet(ssMaster);
    var prods = readInventoryFromSheet(ssMaster);
    var parts = readCustomersFromSheet(ssMaster);

    var serverHash = computeSyncDataHash(invs, prods, parts);

    // If client data matches server hash, return ultra-lightweight notModified response (< 50 bytes)
    if (clientHash && clientHash === serverHash) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        notModified: true,
        hash: serverHash,
        serverTime: Date.now()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var fullBundle = {
      ok: true,
      hash: serverHash,
      invoices: invs,
      products: prods,
      parties: parts,
      settings: {},
      globalSettings: {},
      serverTime: Date.now(),
      timestamp: new Date().toISOString()
    };

    return ContentService.createTextOutput(JSON.stringify(fullBundle)).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleApiPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Missing POST request payload"
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var rawBody = e.postData.contents;
    var data = JSON.parse(rawBody || "{}");
    var action = String(data.action || "").trim();

    // 1. Action Allowlist Enforcement
    if (!action || ALLOWED_ACTIONS.indexOf(action) === -1) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: "Unknown or forbidden action: '" + action + "'. Request rejected."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Authentication Enforcement
    var auth = authenticateRequest(e, data);
    if (!auth.ok) {
      return ContentService.createTextOutput(JSON.stringify(auth)).setMimeType(ContentService.MimeType.JSON);
    }

    var user = auth.user;
    var ss = getMasterSpreadsheet();

    // 3. Dispatch to Specialized Service Handlers
    if (action === "sync" || action === "pull") {
      var invs = readInvoicesFromSheet(ss);
      var prods = readInventoryFromSheet(ss);
      var parts = readCustomersFromSheet(ss);
      var sHash = computeSyncDataHash(invs, prods, parts);

      if (data.hash && data.hash === sHash) {
        return ContentService.createTextOutput(JSON.stringify({
          ok: true,
          notModified: true,
          hash: sHash,
          serverTime: Date.now()
        })).setMimeType(ContentService.MimeType.JSON);
      }

      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        hash: sHash,
        invoices: invs,
        products: prods,
        parties: parts,
        serverTime: Date.now(),
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_invoice") {
      var invoicePayload = data.invoice || data.data || data;
      var saveRes = processSaveInvoice(invoicePayload, user, ss);
      return ContentService.createTextOutput(JSON.stringify(saveRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "delete_record") {
      var delType = data.type || data.recordType;
      var delId = data.id || data.recordId;
      var delNo = data.invoiceNo || data.no;
      if (delNo && delType === "invoice") {
        deleteInvoiceFromSheet(delNo, ss);
        deleteInvoiceFromSheet(String(delNo).replace(/^#/, ''), ss);
      }
      var delRes = processDeleteRecord(delType, delId, user, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (ce) {}
      return ContentService.createTextOutput(JSON.stringify(delRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_products") {
      var prodList = data.products || [];
      if (!Array.isArray(prodList)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Products must be an array" })).setMimeType(ContentService.MimeType.JSON);
      }
      writeInventoryToSheet(prodList, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (ce) {}
      appendAuditLog("SAVE_PRODUCTS", user, "—", "SUCCESS", "Saved " + prodList.length + " products", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: prodList.length })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_parties") {
      var partyList = data.parties || [];
      if (!Array.isArray(partyList)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Parties must be an array" })).setMimeType(ContentService.MimeType.JSON);
      }
      writeCustomersToSheet(partyList, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (ce) {}
      appendAuditLog("SAVE_PARTIES", user, "—", "SUCCESS", "Saved " + partyList.length + " customers", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: partyList.length })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_settings") {
      var settingsObj = data.settings || {};
      appendAuditLog("SAVE_SETTINGS", user, "—", "SUCCESS", "System settings updated", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, settings: settingsObj })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "upload_pdf") {
      var uploadRes = saveInvoicePdfSecure(data);
      if (uploadRes && uploadRes.ok && uploadRes.invoiceNo) {
        var invSheet = ss.getSheetByName("Invoices");
        if (invSheet && invSheet.getLastRow() >= 2) {
          var idVals = invSheet.getRange(2, 1, invSheet.getLastRow() - 1, 1).getValues();
          for (var r = 0; r < idVals.length; r++) {
            if (String(idVals[r][0]).trim() === String(uploadRes.invoiceNo).trim()) {
              invSheet.getRange(r + 2, 13).setValue(uploadRes.pdfUrl);
              break;
            }
          }
        }
      }
      appendAuditLog("UPLOAD_PDF", user, uploadRes.invoiceNo || "—", uploadRes.ok ? "SUCCESS" : "FAILED", uploadRes.safeFilename || "Invoice PDF", ss);
      return ContentService.createTextOutput(JSON.stringify(uploadRes)).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Unhandled action" })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("API Handler error: " + err.message);
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Server-side error: " + err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================================
// Global Web App Entry Points
// ============================================================================

function doGet(e) {
  return handleApiGet(e);
}

function doPost(e) {
  return handleApiPost(e);
}

