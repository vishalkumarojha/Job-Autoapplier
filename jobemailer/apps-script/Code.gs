/*******************************************************
 * JOB APPLICATION EMAILER
 * Sheet tab: "Sheet1"
 * Columns (A..O):
 *  1 COMPANY | 2 CONTACT NAME | 3 CONTACT EMAIL | 4 ROLE
 *  5 JOB LINK | 6 SOURCE | 7 LOCATION | 8 NOTES
 *  9 TRIGGER | 10 EMAIL SENT ON | 11 STATUS
 * 12 FOLLOW UP TRIGGER | 13 FOLLOW UP SENT ON | 14 FOLLOW UP STATUS
 * 15 THREAD ID  (auto-filled, do not edit)
 *******************************************************/

/* ============ CONFIG — EDIT THESE ============ */
var SHEET_NAME     = "Sheet1";

var MY_NAME        = "Vishal Kumar Ojha";                      // full name
var SENDER_NAME    = "Vishal Kumar Ojha";                      // shows as "From" name
var MY_PHONE       = "+91-8948356580";
var MY_LINKEDIN    = "https://www.linkedin.com/in/Vishalkumarojha";
var MY_GITHUB      = "https://github.com/vishalkumarojha";

var RESUME_LINK    = "https://docs.google.com/document/d/1BcxcuZkgRLkzBlR_NGt8envOhLIDYnuAea99qxhufFw/edit?tab=t.8ugd522sig0u";  // always in body
var RESUME_FILE_ID = "";    // Drive file ID of resume PDF. Leave "" to send link only.

var DAILY_CAP      = 50;    // max sends per calendar day (consumer Gmail limit is 500)
var SEND_DELAY_MS  = 500;   // pause between sends in bulk runs
/* ============================================= */

var COL_COMPANY    = 1;
var COL_NAME       = 2;
var COL_EMAIL      = 3;
var COL_ROLE       = 4;
var COL_JOBLINK    = 5;
var COL_SOURCE     = 6;
var COL_LOCATION   = 7;
var COL_NOTES      = 8;
var COL_TRIGGER    = 9;
var COL_SENT_ON    = 10;
var COL_STATUS     = 11;
var COL_FU_TRIGGER = 12;
var COL_FU_SENT_ON = 13;
var COL_FU_STATUS  = 14;
var COL_THREAD     = 15;
var LAST_COL       = 15;

var GREEN_BG = "#d4edda", GREEN_FG = "#155724";
var RED_BG   = "#f8d7da", RED_FG   = "#721c24";
var AMBER_BG = "#fff3cd", AMBER_FG = "#856404";

/* ---------------- MENU / SETUP ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Job Emailer")
    .addItem("Send all pending applications", "sendAllPending")
    .addItem("Send all pending follow-ups", "sendAllFollowUps")
    .addSeparator()
    .addItem("Reset selected row", "resetRow")
    .addItem("Check config & quota", "validateConfig")
    .addSeparator()
    .addItem("Setup trigger (run once)", "setupTrigger")
    .addToUi();
}

function setupTrigger() {
  var all = ScriptApp.getProjectTriggers(), i;
  for (i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === "onEditInstallable") { ScriptApp.deleteTrigger(all[i]); }
  }
  ScriptApp.newTrigger("onEditInstallable")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  SpreadsheetApp.getUi().alert("Trigger installed.");
}

function validateConfig() {
  var problems = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEET_NAME) === null) { problems.push("Sheet tab '" + SHEET_NAME + "' not found."); }
  if (MY_NAME.indexOf("X") > -1 || MY_NAME === "") { problems.push("MY_NAME not set."); }
  if (MY_PHONE.indexOf("X") > -1) { problems.push("MY_PHONE not set."); }
  if (MY_LINKEDIN.indexOf("XXXXX") > -1) { problems.push("MY_LINKEDIN not set."); }
  if (MY_GITHUB.indexOf("XXXXX") > -1) { problems.push("MY_GITHUB not set."); }
  if (RESUME_LINK.indexOf("XXXX") > -1) { problems.push("RESUME_LINK not set."); }
  if (RESUME_FILE_ID !== "") {
    try {
      var f = DriveApp.getFileById(RESUME_FILE_ID);
      problems.push("OK: resume attachment found -> " + f.getName() + " (" + Math.round(f.getSize() / 1024) + " KB)");
    } catch (ex) {
      problems.push("RESUME_FILE_ID unreadable: " + ex.message);
    }
  } else {
    problems.push("OK: no RESUME_FILE_ID set, link-only mode.");
  }
  var hasTrigger = false, all = ScriptApp.getProjectTriggers(), i;
  for (i = 0; i < all.length; i++) { if (all[i].getHandlerFunction() === "onEditInstallable") { hasTrigger = true; } }
  if (!hasTrigger) { problems.push("Edit trigger NOT installed. Run 'Setup trigger'."); }

  if (typeof Gmail === "undefined") {
    problems.push("Gmail advanced service NOT enabled \u2014 follow-ups will go as a NEW email instead of an in-thread reply. Editor left panel > Services > + > Gmail API.");
  } else {
    problems.push("OK: Gmail advanced service enabled, follow-ups reply in-thread.");
  }
  problems.push("Gmail quota left today: " + MailApp.getRemainingDailyQuota());
  problems.push("Script cap: " + countSentToday_() + " / " + DAILY_CAP + " used today.");
  SpreadsheetApp.getUi().alert(problems.join("\n"));
}

/* ---------------- TRIGGER ---------------- */

function onEditInstallable(e) {
  if (!e || !e.range) { return; }
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) { return; }
  var row = e.range.getRow(), col = e.range.getColumn();
  if (row < 2) { return; }
  if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) { return; }
  var val = (e.value || "").toString().trim().toUpperCase();
  if (val !== "Y" && val !== "YES") { return; }
  if (col === COL_TRIGGER)    { sendApplication(sheet, row); }
  if (col === COL_FU_TRIGGER) { sendFollowUp(sheet, row); }
}

/* ---------------- DAILY CAP ---------------- */

function todayKey_() {
  return "sent_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}
function countSentToday_() {
  var v = PropertiesService.getScriptProperties().getProperty(todayKey_());
  return v === null ? 0 : parseInt(v, 10);
}
function bumpSentToday_() {
  PropertiesService.getScriptProperties().setProperty(todayKey_(), String(countSentToday_() + 1));
}
function capBlocked_() {
  if (countSentToday_() >= DAILY_CAP) { return "Daily cap reached (" + DAILY_CAP + "). Try tomorrow."; }
  if (MailApp.getRemainingDailyQuota() <= 0) { return "Gmail daily quota exhausted."; }
  return "";
}

/* ---------------- HELPERS ---------------- */

function esc_(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cell_(data, col) {
  var v = data[col - 1];
  return (v === null || v === undefined) ? "" : v.toString().trim();
}
function isEmail_(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
}
function firstName_(full) {
  if (full === "") { return ""; }
  var clean = full.replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, "").trim();
  var parts = clean.split(/\s+/);
  return parts[0];
}
function htmlToPlain_(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function markStatus_(sheet, row, col, text, bg, fg) {
  sheet.getRange(row, col).setValue(text).setBackground(bg).setFontColor(fg);
}
function isDone_(status) {
  var s = status.toLowerCase();
  return s.indexOf("sent") === 0 || s.indexOf("failed") === 0 || s.indexOf("skipped") === 0 || s.indexOf("blocked") === 0;
}

/* Resume attachment: never fatal. Returns {blob: Blob|null, note: string} */
function getResumeBlob_(requestData) {
  var hasApprovedId = requestData && Object.prototype.hasOwnProperty.call(requestData, "approvedResumeFileId");
  var fileId = hasApprovedId ? requestData.approvedResumeFileId : RESUME_FILE_ID;
  if (hasApprovedId && (typeof fileId !== "string" || fileId.trim() === "")) {
    return { blob: null, note: "", error: true };
  }
  if (fileId === "") { return { blob: null, note: "" }; }
  try {
    return { blob: DriveApp.getFileById(fileId).getBlob(), note: "" };
  } catch (ex) {
    if (hasApprovedId) { return { blob: null, note: "", error: true }; }
    return { blob: null, note: " (no attachment: " + ex.message + ")" };
  }
}

/* Duplicate guard: same email already Sent on another row.
   ponytail: re-reads sheet per row, O(n^2) in bulk. Fine under ~2k rows; cache the column if it ever drags. */
function duplicateRow_(sheet, row, email) {
  var last = sheet.getLastRow();
  if (last < 2) { return 0; }
  var vals = sheet.getRange(2, 1, last - 1, LAST_COL).getValues();
  var target = email.toLowerCase(), i, r;
  for (i = 0; i < vals.length; i++) {
    r = i + 2;
    if (r === row) { continue; }
    if (cell_(vals[i], COL_EMAIL).toLowerCase() !== target) { continue; }
    if (cell_(vals[i], COL_STATUS).toLowerCase().indexOf("sent") === 0) { return r; }
  }
  return 0;
}

/* ---------------- COPY BUILDERS (graceful when fields blank) ---------------- */

function buildSubject_(role, company) {
  if (role !== "" && company !== "") { return "Application — " + role + " | " + MY_NAME; }
  if (role !== "")                   { return "Application — " + role + " | " + MY_NAME; }
  if (company !== "")                { return "Exploring opportunities at " + company + " | " + MY_NAME; }
  return "Exploring opportunities | " + MY_NAME;
}

function buildGreeting_(name) {
  var f = firstName_(name);
  return f === "" ? "Hi," : "Hi " + esc_(f) + ",";
}

function buildIntro_(role, company, jobLink, source) {
  var r = esc_(role), c = esc_(company), line;
  if (role !== "" && company !== "") {
    line = "I’m writing to apply for the <strong>" + r + "</strong> role at <strong>" + c + "</strong>.";
  } else if (role !== "") {
    line = "I’m writing to apply for <strong>" + r + "</strong> roles on your team.";
  } else if (company !== "") {
    line = "I’m reaching out about opportunities at <strong>" + c + "</strong>.";
  } else {
    line = "I’m reaching out about open roles on your team.";
  }
  if (jobLink !== "") {
    line += " I came across the opening <a href=\"" + esc_(jobLink) + "\">here</a>.";
  } else if (source !== "") {
    line += " I came across it via " + esc_(source) + ".";
  }
  return line;
}

function buildLocationLine_(location) {
  if (location === "") { return ""; }
  return "<p>On location — " + esc_(location) + " works for me, and I’m equally comfortable with remote or hybrid.</p>";
}

function buildNotesLine_(notes) {
  if (notes === "") { return ""; }
  return "<p>" + esc_(notes) + "</p>";
}

function buildSignature_() {
  var s = "";
  s += "<p>Best regards,<br>";
  s += "<strong>" + esc_(MY_NAME) + "</strong><br>";
  s += "✉ <a href=\"mailto:" + esc_(Session.getActiveUser().getEmail()) + "\">" + esc_(Session.getActiveUser().getEmail()) + "</a><br>";
  s += "☎ " + esc_(MY_PHONE) + "<br>";
  s += "LinkedIn: <a href=\"" + esc_(MY_LINKEDIN) + "\">" + esc_(MY_LINKEDIN) + "</a><br>";
  s += "GitHub: <a href=\"" + esc_(MY_GITHUB) + "\">" + esc_(MY_GITHUB) + "</a>";
  s += "</p>";
  return s;
}

function renderTemplate_(file, vars) {
  var t = HtmlService.createTemplateFromFile(file), k;
  for (k in vars) { if (vars.hasOwnProperty(k)) { t[k] = vars[k]; } }
  return t.evaluate().getContent();
}

/* ---------------- SEND: APPLICATION ---------------- */

function approvedApplicationContent_(requestData) {
  if (!requestData) { return null; }
  var hasSubject = Object.prototype.hasOwnProperty.call(requestData, "approvedSubject");
  var hasMessage = Object.prototype.hasOwnProperty.call(requestData, "approvedMessage");
  if (!hasSubject && !hasMessage) { return null; }
  if (!hasSubject || !hasMessage || typeof requestData.approvedSubject !== "string" ||
      typeof requestData.approvedMessage !== "string" || requestData.approvedSubject.trim() === "" ||
      requestData.approvedMessage.trim() === "") {
    throw new Error("Approved subject and message must both be non-empty strings.");
  }
  // Keep the validated originals byte-for-byte: trim is only used for the empty check.
  return { subject: requestData.approvedSubject, plain: requestData.approvedMessage };
}

function sendApplication(sheet, row, requestData) {
  var data = sheet.getRange(row, 1, 1, LAST_COL).getValues()[0];

  var trigger = cell_(data, COL_TRIGGER).toUpperCase();
  var status  = cell_(data, COL_STATUS);
  if (trigger !== "Y" && trigger !== "YES") { return; }
  if (isDone_(status)) { return; }

  var email = cell_(data, COL_EMAIL);
  if (email === "") {
    markStatus_(sheet, row, COL_STATUS, "Skipped: CONTACT EMAIL is empty", AMBER_BG, AMBER_FG);
    return;
  }
  if (!isEmail_(email)) {
    markStatus_(sheet, row, COL_STATUS, "Skipped: invalid email [" + email + "]", AMBER_BG, AMBER_FG);
    return;
  }
  var dup = duplicateRow_(sheet, row, email);
  if (dup > 0) {
    markStatus_(sheet, row, COL_STATUS, "Skipped: duplicate, already sent to this address in row " + dup, AMBER_BG, AMBER_FG);
    return;
  }
  var cap = capBlocked_();
  if (cap !== "") {
    markStatus_(sheet, row, COL_STATUS, "Blocked: " + cap, AMBER_BG, AMBER_FG);
    return;
  }

  var company  = cell_(data, COL_COMPANY);
  var name     = cell_(data, COL_NAME);
  var role     = cell_(data, COL_ROLE);
  var jobLink  = cell_(data, COL_JOBLINK);
  var source   = cell_(data, COL_SOURCE);
  var location = cell_(data, COL_LOCATION);
  var notes    = cell_(data, COL_NOTES);

  var approvedContent;
  try {
    approvedContent = approvedApplicationContent_(requestData);
  } catch (ex) {
    markStatus_(sheet, row, COL_STATUS, "Failed: " + ex.message, RED_BG, RED_FG);
    return;
  }

  var res = getResumeBlob_(requestData);
  if (res.error) {
    markStatus_(sheet, row, COL_STATUS, "Failed: approved resume unavailable", RED_BG, RED_FG);
    return;
  }
  var subject = approvedContent ? approvedContent.subject : buildSubject_(role, company);
  var html, plain;
  if (approvedContent) {
    plain = approvedContent.plain;
  } else {
    try {
      html = renderTemplate_("Email", {
  greeting:     buildGreeting_(name),
  intro:        buildIntro_(role, company, jobLink, source),

  role:         esc_(role),
  company:      esc_(company),

  locationLine: buildLocationLine_(location),
  notesLine:    buildNotesLine_(notes),
  resumeLink:   esc_(RESUME_LINK),
  attached:     res.blob !== null,
  signature:    buildSignature_()
      });
    } catch (ex) {
      markStatus_(sheet, row, COL_STATUS, "Failed: template error — " + ex.message, RED_BG, RED_FG);
      return;
    }
    plain = htmlToPlain_(html);
  }

  var opts = { name: SENDER_NAME };
  if (!approvedContent) { opts.htmlBody = html; }
  if (res.blob !== null) { opts.attachments = [res.blob]; }

  try {
    var msg = GmailApp.createDraft(email, subject, plain, opts).send();
    var threadId = "";
    try { threadId = msg.getThread().getId(); } catch (e2) { threadId = ""; }

    bumpSentToday_();
    sheet.getRange(row, COL_SENT_ON).setValue(new Date()).setNumberFormat("dd-mmm-yyyy hh:mm");
    if (threadId !== "") { sheet.getRange(row, COL_THREAD).setValue(threadId); }
    markStatus_(sheet, row, COL_STATUS, "Sent" + res.note, GREEN_BG, GREEN_FG);
  } catch (ex) {
    markStatus_(sheet, row, COL_STATUS, "Failed: " + ex.message, RED_BG, RED_FG);
    Logger.log("Row " + row + " failed: " + ex.stack);
  }
}

/* ---------------- SEND: FOLLOW-UP ---------------- */

/* RFC 2047 encode a header value so em-dashes / non-ASCII survive. */
function encodeHeader_(s) {
  if (/^[\x20-\x7E]*$/.test(s)) { return s; }
  return "=?UTF-8?B?" + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + "?=";
}

/* True reply: explicit To, In-Reply-To + References so it lands IN the thread
   at the recruiter's end. Needs the Gmail advanced service enabled.
   GmailThread.reply() cannot be used here — it replies to the sender of the
   last message, which is us, so the follow-up would come back to our own inbox. */
function threadedReply_(threadId, toEmail, fallbackSubject, htmlBody, plainBody) {
  var thread = GmailApp.getThreadById(threadId);
  if (thread === null) { throw new Error("thread " + threadId + " not found (deleted or wrong account)"); }
  var msgs = thread.getMessages();
  if (msgs.length === 0) { throw new Error("thread " + threadId + " has no messages"); }

  var lastId = msgs[msgs.length - 1].getId();
  var meta = Gmail.Users.Messages.get("me", lastId, {
    format: "metadata",
    metadataHeaders: ["Message-ID", "Subject", "References"]
  });
  var hdrs = (meta.payload && meta.payload.headers) ? meta.payload.headers : [];
  var msgId = "", refs = "", subj = fallbackSubject, i, n;
  for (i = 0; i < hdrs.length; i++) {
    n = hdrs[i].name.toLowerCase();
    if (n === "message-id") { msgId = hdrs[i].value; }
    if (n === "references")  { refs  = hdrs[i].value; }
    if (n === "subject")     { subj  = hdrs[i].value; }
  }
  if (msgId === "") { throw new Error("could not read Message-ID of last message in thread"); }
  if (subj.toLowerCase().indexOf("re:") !== 0) { subj = "Re: " + subj; }

  var me = Session.getActiveUser().getEmail();
  var boundary = "b" + Date.now();
  var lines = [];
  lines.push('From: ' + encodeHeader_(SENDER_NAME) + ' <' + me + '>');
  lines.push('To: ' + toEmail);
  lines.push('Subject: ' + encodeHeader_(subj));
  lines.push('In-Reply-To: ' + msgId);
  lines.push('References: ' + (refs === "" ? msgId : refs + " " + msgId));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');
  lines.push('--' + boundary);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Utilities.base64Encode(plainBody, Utilities.Charset.UTF_8));
  lines.push('--' + boundary);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Utilities.base64Encode(htmlBody, Utilities.Charset.UTF_8));
  lines.push('--' + boundary + '--');

  var raw = Utilities.base64EncodeWebSafe(lines.join('\r\n'), Utilities.Charset.UTF_8);
  Gmail.Users.Messages.send({ raw: raw, threadId: threadId }, "me");
}

function sendFollowUp(sheet, row) {
  var data = sheet.getRange(row, 1, 1, LAST_COL).getValues()[0];

  var trigger  = cell_(data, COL_FU_TRIGGER).toUpperCase();
  var fuStatus = cell_(data, COL_FU_STATUS);
  if (trigger !== "Y" && trigger !== "YES") { return; }
  if (isDone_(fuStatus)) { return; }

  var mainStatus = cell_(data, COL_STATUS).toLowerCase();
  if (mainStatus.indexOf("sent") !== 0) {
    markStatus_(sheet, row, COL_FU_STATUS, "Skipped: original application not sent yet", AMBER_BG, AMBER_FG);
    return;
  }
  var email = cell_(data, COL_EMAIL);
  if (!isEmail_(email)) {
    markStatus_(sheet, row, COL_FU_STATUS, "Skipped: invalid email [" + email + "]", AMBER_BG, AMBER_FG);
    return;
  }
  var cap = capBlocked_();
  if (cap !== "") {
    markStatus_(sheet, row, COL_FU_STATUS, "Blocked: " + cap, AMBER_BG, AMBER_FG);
    return;
  }

  var company  = cell_(data, COL_COMPANY);
  var name     = cell_(data, COL_NAME);
  var role     = cell_(data, COL_ROLE);
  var threadId = cell_(data, COL_THREAD);

  var ref;
  if (role !== "" && company !== "") { ref = "my application for the <strong>" + esc_(role) + "</strong> role at <strong>" + esc_(company) + "</strong>"; }
  else if (role !== "")              { ref = "my application for the <strong>" + esc_(role) + "</strong> role"; }
  else if (company !== "")           { ref = "my note about opportunities at <strong>" + esc_(company) + "</strong>"; }
  else                               { ref = "my earlier note about open roles"; }

  var html;
  try {
    html = renderTemplate_("FollowUp", {
      greeting:   buildGreeting_(name),
      reference:  ref,
      resumeLink: esc_(RESUME_LINK),
      signature:  buildSignature_()
    });
  } catch (ex) {
    markStatus_(sheet, row, COL_FU_STATUS, "Failed: template error — " + ex.message, RED_BG, RED_FG);
    return;
  }
  var plain = htmlToPlain_(html);
  var subject = buildSubject_(role, company);

  var mode = "";
  try {
    if (threadId !== "" && typeof Gmail !== "undefined") {
      threadedReply_(threadId, email, subject, html, plain);
      mode = " (in thread)";
    } else {
      if (threadId !== "" && typeof Gmail === "undefined") {
        mode = " (new thread — enable the Gmail advanced service to reply in-thread)";
      } else {
        mode = " (new thread — no thread id stored for this row)";
      }
      GmailApp.createDraft(email, "Re: " + subject, plain, { htmlBody: html, name: SENDER_NAME }).send();
    }
    bumpSentToday_();
    sheet.getRange(row, COL_FU_SENT_ON).setValue(new Date()).setNumberFormat("dd-mmm-yyyy hh:mm");
    markStatus_(sheet, row, COL_FU_STATUS, "Sent to " + email + mode, GREEN_BG, GREEN_FG);
  } catch (ex) {
    markStatus_(sheet, row, COL_FU_STATUS, "Failed: " + ex.message, RED_BG, RED_FG);
    Logger.log("Row " + row + " follow-up failed: " + ex.stack);
  }
}

/* ---------------- BULK RUNS ---------------- */

function getSheetOrWarn_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (sheet === null) { SpreadsheetApp.getUi().alert("Sheet tab '" + SHEET_NAME + "' not found. Fix SHEET_NAME."); }
  return sheet;
}

function sendAllPending() {
  var sheet = getSheetOrWarn_();
  if (sheet === null) { return; }
  var last = sheet.getLastRow();
  if (last < 2) { SpreadsheetApp.getUi().alert("No data rows."); return; }
  var vals = sheet.getRange(2, 1, last - 1, LAST_COL).getValues();
  var sent = 0, skipped = 0, i, trigger, status;
  for (i = 0; i < vals.length; i++) {
    trigger = cell_(vals[i], COL_TRIGGER).toUpperCase();
    status  = cell_(vals[i], COL_STATUS);
    if (trigger !== "Y" && trigger !== "YES") { continue; }
    if (isDone_(status)) { skipped++; continue; }
    if (capBlocked_() !== "") { break; }
    sendApplication(sheet, i + 2);
    sent++;
    Utilities.sleep(SEND_DELAY_MS);
  }
  SpreadsheetApp.getUi().alert("Applications — processed: " + sent + ", already done: " + skipped +
    "\nUsed today: " + countSentToday_() + "/" + DAILY_CAP);
}

function sendAllFollowUps() {
  var sheet = getSheetOrWarn_();
  if (sheet === null) { return; }
  var last = sheet.getLastRow();
  if (last < 2) { SpreadsheetApp.getUi().alert("No data rows."); return; }
  var vals = sheet.getRange(2, 1, last - 1, LAST_COL).getValues();
  var sent = 0, skipped = 0, i, trigger, status;
  for (i = 0; i < vals.length; i++) {
    trigger = cell_(vals[i], COL_FU_TRIGGER).toUpperCase();
    status  = cell_(vals[i], COL_FU_STATUS);
    if (trigger !== "Y" && trigger !== "YES") { continue; }
    if (isDone_(status)) { skipped++; continue; }
    if (capBlocked_() !== "") { break; }
    sendFollowUp(sheet, i + 2);
    sent++;
    Utilities.sleep(SEND_DELAY_MS);
  }
  SpreadsheetApp.getUi().alert("Follow-ups — processed: " + sent + ", already done: " + skipped +
    "\nUsed today: " + countSentToday_() + "/" + DAILY_CAP);
}

/* ---------------- RESET ---------------- */

function resetRow() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) { SpreadsheetApp.getUi().alert("Not on '" + SHEET_NAME + "'."); return; }
  var row = sheet.getActiveRange().getRow();
  if (row < 2) { return; }
  var ui = SpreadsheetApp.getUi();
  if (ui.alert("Confirm", "Reset row " + row + "? Clears both triggers, statuses, sent dates and thread link.", ui.ButtonSet.YES_NO) !== ui.Button.YES) { return; }
  var cols = [COL_TRIGGER, COL_SENT_ON, COL_STATUS, COL_FU_TRIGGER, COL_FU_SENT_ON, COL_FU_STATUS, COL_THREAD], i;
  for (i = 0; i < cols.length; i++) {
    sheet.getRange(row, cols[i]).clearContent().setBackground(null).setFontColor(null);
  }
}

/* ============ DASHBOARD API BRIDGE ============
   Serves the Vercel dashboard. Public GET /exec returns a status object so
   you can verify the deployment from a browser / incognito window.
   Script Property required: DASHBOARD_API_TOKEN */

function doGet(){return out_({ok:true,service:'Job Outreach API'});}
function doPost(e){try{var r=JSON.parse(e.postData.contents||'{}');if(r.token!==PropertiesService.getScriptProperties().getProperty('DASHBOARD_API_TOKEN'))return out_({ok:false,error:'Unauthorized'});var a=r.action,d=r.data||{};if(a==='dashboard')return out_({ok:true,data:dash_()});if(a==='jobs')return out_({ok:true,data:jobs_()});if(a==='followups')return out_({ok:true,data:jobs_().filter(function(j){return j.followUpTrigger||j.followUpStatus||j.threadId;})});if(a==='add'||a==='send')return out_(add_(d,a==='send'));if(a==='update')return out_(update_(d));if(a==='delete')return out_(del_(d));if(a==='sendFollowUp')return out_(follow_(d));return out_({ok:false,error:'Unknown action'});}catch(x){return out_({ok:false,error:x.message});}}
function out_(x){return ContentService.createTextOutput(JSON.stringify(x)).setMimeType(ContentService.MimeType.JSON);}
function s_(){var s=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);if(!s)throw Error('Sheet '+SHEET_NAME+' not found.');return s;}
function jobs_(){var v=s_().getDataRange().getDisplayValues(),o=[],r;for(var i=1;i<v.length;i++){r=v[i];if(r.join('')!=='')o.push({id:i+1,company:r[0],contactName:r[1],contactEmail:r[2],role:r[3],jobLink:r[4],source:r[5],location:r[6],notes:r[7],trigger:r[8],emailSentOn:r[9],status:r[10],followUpTrigger:r[11],followUpSentOn:r[12],followUpStatus:r[13],threadId:r[14]});}return o;}
function dash_(){var j=jobs_();return{stats:{total:j.length,sent:j.filter(function(x){return/^sent/i.test(x.status);}).length,pending:j.filter(function(x){return!x.status||!/^(sent|failed|skipped|blocked)/i.test(x.status);}).length,followUpsDue:j.filter(function(x){return/^(y|yes)$/i.test(x.followUpTrigger)&&!/^sent/i.test(x.followUpStatus);}).length},recent:j.slice(-8).reverse()};}
function valid_(p,send){var j={company:String(p.company||'').trim(),contactName:String(p.contactName||'').trim(),contactEmail:String(p.contactEmail||'').trim(),role:String(p.role||'').trim(),jobLink:String(p.jobLink||'').trim(),source:String(p.source||'LinkedIn').trim(),location:String(p.location||'').trim(),notes:String(p.notes||'').trim()};if(!j.company||!j.role)throw Error('Company and role are required.');if(j.contactEmail&&!isEmail_(j.contactEmail))throw Error('Invalid contact email.');if(send&&!j.contactEmail)throw Error('Contact email is required before sending.');return j;}
function duplicate_(j,ignore){return jobs_().filter(function(x){return x.id!==ignore;}).find(function(x){return(j.jobLink&&x.jobLink===j.jobLink)||(x.company.toLowerCase()===j.company.toLowerCase()&&x.role.toLowerCase()===j.role.toLowerCase()&&(!j.contactEmail||x.contactEmail.toLowerCase()===j.contactEmail.toLowerCase()));});}
function put_(j,send,old){var r=old||Array(LAST_COL).fill('');[j.company,j.contactName,j.contactEmail,j.role,j.jobLink,j.source,j.location,j.notes].forEach(function(x,i){r[i]=x;});if(send){r[8]='Y';r[10]='';}return r;}
function add_(p,send){var j=valid_(p,send),d=duplicate_(j,0);if(d&&!p.allowDuplicate)return{ok:false,code:'DUPLICATE',message:'Similar job already exists.'};var s=s_();s.appendRow(put_(j,send));var id=s.getLastRow();if(send)sendApplication(s,id,p);SpreadsheetApp.flush();return{ok:true,message:send?'Email processed by your existing automation.':'Job added successfully.'};}
function update_(p){var s=s_(),id=Number(p.id),j=valid_(p,false),d=duplicate_(j,id);if(id<2||id>s.getLastRow())throw Error('Job not found.');if(d&&!p.allowDuplicate)return{ok:false,code:'DUPLICATE',message:'Similar job already exists.'};var old=s.getRange(id,1,1,LAST_COL).getValues()[0];s.getRange(id,1,1,LAST_COL).setValues([put_(j,false,old)]);return{ok:true,message:'Job updated successfully.'};}
function del_(p){var s=s_(),id=Number(p.id);if(id<2||id>s.getLastRow())throw Error('Job not found.');s.deleteRow(id);return{ok:true,message:'Job deleted successfully.'};}
function follow_(p){var s=s_(),id=Number(p.id);if(id<2||id>s.getLastRow())throw Error('Job not found.');s.getRange(id,COL_FU_TRIGGER).setValue('Y');sendFollowUp(s,id);SpreadsheetApp.flush();return{ok:true,message:'Follow-up processed by your existing automation.'};}
