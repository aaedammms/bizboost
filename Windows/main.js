const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

let win, db, session = null;
// Keep the same per-user database directory across source and installed builds.
// Changing productName must not silently move accounts or inventory.
const legacyUserData = path.join(app.getPath('appData'), 'e-inventory-sqlite-starter');
fs.mkdirSync(legacyUserData, { recursive: true });
app.setPath('userData', legacyUserData);
const dbPath = () => path.join(app.getPath('userData'), 'inventory.sqlite');

function openDb() {
  db = new DatabaseSync(dbPath());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      min_stock INTEGER NOT NULL DEFAULT 0 CHECK(min_stock >= 0),
      selling_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(selling_price_cents >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      type TEXT NOT NULL CHECK(type IN ('IN','OUT')),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','supervisor','staff')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS store_owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_username TEXT NOT NULL, -- legacy column name; stores approving Supervisor username
      owner_username TEXT NOT NULL,
      affected_products INTEGER NOT NULL,
      cleared_units INTEGER NOT NULL,
      backup_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_profile (
      id INTEGER PRIMARY KEY CHECK(id=1),
      name TEXT NOT NULL DEFAULT '',
      registration TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      logo_data TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movement_id INTEGER NOT NULL UNIQUE REFERENCES movements(id),
      invoice_number TEXT NOT NULL UNIQUE,
      seller TEXT NOT NULL,
      buyer TEXT NOT NULL,
      buyer_address TEXT NOT NULL DEFAULT '',
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
  const cols=db.prepare('PRAGMA table_info(products)').all();
  if(!cols.some(x=>x.name==='archived')) db.exec('ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if(!cols.some(x=>x.name==='deleted')) db.exec('ALTER TABLE products ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  // Idempotent migration of existing users and legacy approval-only owner accounts.
  const userSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
  if(userSchema.includes("'admin'") || !userSchema.includes("'supervisor'")) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE users_migrated (id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
        salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','supervisor','staff')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO users_migrated(id,username,password_hash,salt,role,created_at)
        SELECT id,username,password_hash,salt,CASE WHEN role='admin' THEN 'supervisor' ELSE role END,created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_migrated RENAME TO users;`);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  // Owner-controlled cap for Supervisor accounts. Existing Admin accounts are migrated to Supervisor.
  const supervisorCountAtMigration=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='supervisor'").get().n;
  const existingSupervisorCap=db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='max_supervisors'").get();
  if(!existingSupervisorCap) db.prepare('INSERT INTO app_settings(setting_key,setting_value) VALUES(?,?)').run('max_supervisors',String(Math.max(1,supervisorCountAtMigration)));
  else if(Number(existingSupervisorCap.setting_value)<supervisorCountAtMigration)
    db.prepare("UPDATE app_settings SET setting_value=? WHERE setting_key='max_supervisors'").run(String(supervisorCountAtMigration));

  const profileColumns=db.prepare('PRAGMA table_info(company_profile)').all();
  if(!profileColumns.some(col=>col.name==='logo_data')) db.exec("ALTER TABLE company_profile ADD COLUMN logo_data TEXT NOT NULL DEFAULT ''");
  if(!profileColumns.some(col=>col.name==='sst_registration')) db.exec("ALTER TABLE company_profile ADD COLUMN sst_registration TEXT NOT NULL DEFAULT ''");
  // Keep legacy store_owners table for compatibility, but make its accounts able to log in.
  for(const old of db.prepare('SELECT username,password_hash,salt,created_at FROM store_owners').all()) {
    const existing=db.prepare('SELECT id,role FROM users WHERE username=?').get(old.username);
    if(!existing) {
      db.prepare('INSERT INTO users(username,password_hash,salt,role,created_at) VALUES(?,?,?,?,?)')
        .run(old.username,old.password_hash,old.salt,'owner',old.created_at);
    } else if(existing.role!=='owner') {
      // Preserve both identities rather than overwrite an existing Supervisor or Staff login.
      const username=(old.username.slice(0,26)+'-owner');
      if(!db.prepare('SELECT id FROM users WHERE username=?').get(username))
        db.prepare('INSERT INTO users(username,password_hash,salt,role,created_at) VALUES(?,?,?,?,?)')
          .run(username,old.password_hash,old.salt,'owner',old.created_at);
    }
  }
  // Upgrade databases that had an Admin login but no separate Owner account.
  // The oldest migrated Supervisor becomes the Owner so the installation remains manageable.
  const ownerExists=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").get().n>0;
  if(!ownerExists) {
    const firstSupervisor=db.prepare("SELECT id FROM users WHERE role='supervisor' ORDER BY id LIMIT 1").get();
    if(firstSupervisor) db.prepare("UPDATE users SET role='owner' WHERE id=?").run(firstSupervisor.id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS product_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
    sku TEXT NOT NULL, name TEXT NOT NULL, quantity_at_deletion INTEGER NOT NULL,
    deleted_by TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT,number TEXT UNIQUE,buyer_name TEXT NOT NULL,buyer_address TEXT NOT NULL DEFAULT '',customer_id INTEGER REFERENCES customers(id),customer_type TEXT NOT NULL DEFAULT 'other',subtotal_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL DEFAULT 0,total_cents INTEGER NOT NULL DEFAULT 0,currency_code TEXT NOT NULL DEFAULT 'MYR',currency_symbol TEXT NOT NULL DEFAULT 'RM',currency_decimals INTEGER NOT NULL DEFAULT 2,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL REFERENCES sales(id),product_id INTEGER NOT NULL REFERENCES products(id),sku TEXT NOT NULL,name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price_cents INTEGER NOT NULL,tax_rate_bps INTEGER NOT NULL DEFAULT 0,line_tax_cents INTEGER NOT NULL DEFAULT 0,movement_id INTEGER REFERENCES movements(id));
    CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RECEIVED')),created_by TEXT NOT NULL,received_by TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')),received_at TEXT);
    CREATE TABLE IF NOT EXISTS purchase_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES purchase_orders(id),product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL,unit_cost_cents INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS quotations(id INTEGER PRIMARY KEY AUTOINCREMENT,quotation_number TEXT NOT NULL UNIQUE,customer_name TEXT NOT NULL,customer_type TEXT NOT NULL DEFAULT 'other',customer_phone TEXT NOT NULL DEFAULT '',customer_email TEXT NOT NULL DEFAULT '',customer_address TEXT NOT NULL DEFAULT '',quotation_date TEXT NOT NULL,valid_until TEXT NOT NULL,payment_terms TEXT NOT NULL DEFAULT '',reference TEXT NOT NULL DEFAULT '',sales_agent TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',terms TEXT NOT NULL DEFAULT '',subtotal_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,currency_code TEXT NOT NULL DEFAULT 'MYR',currency_symbol TEXT NOT NULL DEFAULT 'RM',currency_decimals INTEGER NOT NULL DEFAULT 2,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS quotation_items(id INTEGER PRIMARY KEY AUTOINCREMENT,quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,product_id INTEGER REFERENCES products(id),sku TEXT NOT NULL DEFAULT '',description TEXT NOT NULL,quantity REAL NOT NULL CHECK(quantity>0),unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps>=0 AND tax_rate_bps<=10000),line_subtotal_cents INTEGER NOT NULL,line_tax_cents INTEGER NOT NULL);`);

  const quotationColumns=db.prepare('PRAGMA table_info(quotations)').all();
  for(const [name,definition] of [['currency_code',"TEXT NOT NULL DEFAULT 'MYR'"],['currency_symbol',"TEXT NOT NULL DEFAULT 'RM'"],['currency_decimals','INTEGER NOT NULL DEFAULT 2'],['customer_type',"TEXT NOT NULL DEFAULT 'other'"]]) if(!quotationColumns.some(col=>col.name===name)) db.exec(`ALTER TABLE quotations ADD COLUMN ${name} ${definition}`);

  // v0.3.7 migrations: central product pricing, configurable currency, and tax-aware sales.
  const productCols=db.prepare('PRAGMA table_info(products)').all();
  if(!productCols.some(col=>col.name==='selling_price_cents')) db.exec('ALTER TABLE products ADD COLUMN selling_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(selling_price_cents >= 0)');
  const salesCols=db.prepare('PRAGMA table_info(sales)').all();
  if(!salesCols.some(col=>col.name==='customer_type')) db.exec("ALTER TABLE sales ADD COLUMN customer_type TEXT NOT NULL DEFAULT 'other'");
  if(!salesCols.some(col=>col.name==='tax_cents')) db.exec('ALTER TABLE sales ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0');
  if(!salesCols.some(col=>col.name==='total_cents')) db.exec('ALTER TABLE sales ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE sales SET total_cents=subtotal_cents WHERE total_cents=0 AND subtotal_cents<>0');
  for(const [name,definition] of [['currency_code',"TEXT NOT NULL DEFAULT 'MYR'"],['currency_symbol',"TEXT NOT NULL DEFAULT 'RM'"],['currency_decimals','INTEGER NOT NULL DEFAULT 2']]) if(!salesCols.some(col=>col.name===name)) db.exec(`ALTER TABLE sales ADD COLUMN ${name} ${definition}`);
  const saleItemCols=db.prepare('PRAGMA table_info(sale_items)').all();
  if(!saleItemCols.some(col=>col.name==='tax_rate_bps')) db.exec('ALTER TABLE sale_items ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0');
  if(!saleItemCols.some(col=>col.name==='line_tax_cents')) db.exec('ALTER TABLE sale_items ADD COLUMN line_tax_cents INTEGER NOT NULL DEFAULT 0');
  db.exec(`INSERT OR IGNORE INTO app_settings(setting_key,setting_value) VALUES
    ('currency_code','MYR'),('currency_symbol','RM'),('currency_decimals','2')`);

}
function validProduct(p) {
  if (!p || typeof p !== 'object') throw Error('Invalid product');
  const sku = String(p.sku || '').trim(), name = String(p.name || '').trim();
  const category = String(p.category || '').trim();
  const quantity = Number(p.quantity), minStock = Number(p.min_stock ?? 0);
  const sellingPriceCents = validMoney(p.selling_price ?? 0);
  if (!sku || !name || sku.length > 100 || name.length > 250 || category.length > 150 || !Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(minStock) || minStock < 0) throw Error('Check SKU, name, category and quantities');
  return { sku, name, category, quantity, minStock, sellingPriceCents };
}
function validCredentials(p) {
  const username = String(p?.username ?? '').trim();
  const password = String(p?.password ?? '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw Error('Username must be 3–32 letters, numbers, dots, underscores or hyphens');
  if (password.length < 10 || password.length > 128) throw Error('Password must be 10–128 characters');
  return { username, password };
}
function createUser(payload, role) {
  const {username,password}=validCredentials(payload);
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
  const result=db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)').run(username,hash,salt,role);
  return {id:Number(result.lastInsertRowid),username,role};
}
function verifyPassword(record, password) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const salt = record ? Buffer.from(record.salt, 'hex') : Buffer.alloc(16);
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = record ? Buffer.from(record.password_hash, 'hex') : Buffer.alloc(64);
  return Boolean(record) && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function requireSession(role) {
  if (!session) throw Error('Please sign in first');
  if(role==='supervisor' && !['owner','supervisor'].includes(session.role)) throw Error('Supervisor or Owner access required');
  if(role==='owner' && session.role!=='owner') throw Error('Store Owner access required');
}
function audit(action, details) {
  db.prepare('INSERT INTO audit_events(actor,action,details) VALUES(?,?,?)').run(session?.username || 'system',action,String(details).slice(0,500));
}
function configuredCurrencyDecimals() {
  try { return Number(db?.prepare("SELECT setting_value FROM app_settings WHERE setting_key='currency_decimals'").get()?.setting_value ?? 2); }
  catch { return 2; }
}
function configuredCurrency() {
  try { const rows=db.prepare('SELECT setting_key,setting_value FROM app_settings').all(); const v=Object.fromEntries(rows.map(row=>[row.setting_key,row.setting_value])); return {currencyCode:v.currency_code||'MYR',currencySymbol:v.currency_symbol||'RM',currencyDecimals:Number(v.currency_decimals??2)}; }
  catch { return {currencyCode:'MYR',currencySymbol:'RM',currencyDecimals:2}; }
}
function validMoney(value) {
  const x=Number(value), decimals=configuredCurrencyDecimals();
  if(!Number.isFinite(x)||x<0||x>100000000||Math.abs(x*10**decimals-Math.round(x*10**decimals))>0.000001) throw Error(`Enter a valid amount with up to ${decimals} decimal places`);
  return Math.round(x*(10**decimals)); // Minor units use the configured currency precision; old records keep their own precision snapshot.
}
function cleanText(v,max=200) {const s=String(v??'').trim();if(s.length>max) throw Error('Field is too long');return s;}
function validPositive(v) {const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw Error('Enter a positive whole number');return n;}
function csvValue(v){const s=String(v??'');return '"'+s.replace(/"/g,'""')+'"';}

async function exportCommercialPdf({kind,number,date,customerName,customerType='',customerPhone='',customerEmail='',customerAddress='',paymentTerms='',validUntil='',reference='',salesAgent='',notes='',terms='',items,subtotalCents,taxCents,totalCents,profile,currencyCode='MYR',currencySymbol='RM',currencyDecimals=2}) {
  const title=kind==='quotation'?'QUOTATION':'INVOICE';
  const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=c=>(Number(c||0)/(10**currencyDecimals)).toFixed(currencyDecimals);
  const moneyLabel=c=>`${safe(currencySymbol)} ${money(c)}`;
  const logo=profile?.logo_data?`<img class="logo" src="${profile.logo_data}" alt="Company logo">`:'';
  const lineRows=(items||[]).map((item,index)=>{
    const qty=Number(item.quantity)||0, rate=Number(item.tax_rate_bps||0)/100;
    const amount=Number(item.line_subtotal_cents ?? Math.round(qty*Number(item.unit_price_cents||0)));
    const tax=Number(item.line_tax_cents ?? 0);
    return `<tr><td class="center">${index+1}</td><td><strong>${safe(item.description||item.name)}</strong>${item.sku?`<div class="sub">Code: ${safe(item.sku)}</div>`:''}</td><td class="right">${qty.toLocaleString('en-MY',{maximumFractionDigits:3})}</td><td class="right">${money(item.unit_price_cents)}</td><td class="right">${rate.toFixed(2)}%</td><td class="right">${money(amount+tax)}</td></tr>`;
  }).join('');
  const taxLabel=Number(taxCents||0)>0?'SST / Tax':'SST / Tax (if applicable)';
  const footerNote=kind==='invoice'?'COMMERCIAL INVOICE — This document is not an LHDN MyInvois-validated e-Invoice.':'QUOTATION — This document is an offer and is not a tax invoice.';
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:15mm}*{box-sizing:border-box}body{font:11px Arial,Helvetica,sans-serif;color:#20242a;background:#fff;margin:0}
    .top-rule{height:4px;background:#374151;margin-bottom:24px}.head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:17px;border-bottom:1px solid #cbd1d8}
    .identity{display:flex;align-items:center;gap:15px;min-width:0}.logo{max-width:112px;max-height:76px;object-fit:contain}
    h1{font-size:20px;line-height:1.2;color:#20242a;margin:0 0 6px}.company-meta{font-size:9px;color:#626b75;line-height:1.55}.doc-title{text-align:right;min-width:175px}.doc-title .type{font-size:18px;letter-spacing:1.5px;font-weight:800;color:#263445}.doc-title .number{font-size:13px;font-weight:bold;margin-top:7px;color:#20242a}.doc-title .date{font-size:9px;color:#626b75;line-height:1.6;margin-top:5px}
    .parties{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:22px 0}.party{border:1px solid #d7dce2;padding:12px 14px;min-height:92px;background:#f8f9fb}.label{font-size:9px;letter-spacing:.8px;font-weight:bold;color:#657181;text-transform:uppercase;margin-bottom:8px}.party strong{font-size:12px;color:#20242a}.party p{font-size:10px;line-height:1.5;margin:5px 0 0;color:#505963;white-space:pre-line}
    .details{display:flex;gap:24px;flex-wrap:wrap;margin:0 0 17px;font-size:9px;color:#505963}.details b{color:#20242a}
    table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:8px}thead{display:table-header-group}th{background:#374151;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.4px;padding:10px 8px;text-align:left}td{padding:10px 8px;border-bottom:1px solid #e1e5e9;vertical-align:top;font-size:10px;overflow-wrap:anywhere}.center{text-align:center}.right{text-align:right}.sub{font-size:8px;color:#737d88;margin-top:4px}
    .summary{width:270px;margin:20px 0 0 auto}.sum-row{display:flex;justify-content:space-between;padding:6px 2px;font-size:10px;color:#505963}.sum-row.total{border-top:2px solid #64748b;margin-top:5px;padding-top:11px;font-size:15px;font-weight:bold;color:#20242a}
    .terms-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:30px;padding-top:15px;border-top:1px solid #d7dce2}.terms-grid h3{font-size:10px;color:#374151;margin:0 0 7px}.terms-grid p{font-size:9px;line-height:1.5;color:#505963;margin:0;white-space:pre-line}.signature{display:flex;justify-content:space-between;gap:30px;margin-top:42px}.sign{width:42%;border-top:1px solid #9aa3ad;padding-top:7px;font-size:9px;color:#505963}.foot{margin-top:25px;padding-top:10px;border-top:1px solid #e1e5e9;text-align:center;color:#737d88;font-size:8px}
  </style></head><body><div class="top-rule"></div><header class="head"><div class="identity">${logo}<div><h1>${safe(profile?.name||'Company Name')}</h1><div class="company-meta">${profile?.registration?`Registration No.: ${safe(profile.registration)}<br>`:''}${profile?.sst_registration?`SST Registration No.: ${safe(profile.sst_registration)}<br>`:''}${profile?.address?`${safe(profile.address).replace(/\n/g,'<br>')}<br>`:''}${profile?.phone?`${safe(profile.phone)}<br>`:''}${profile?.email?safe(profile.email):''}</div></div></div><div class="doc-title"><div class="type">${title}</div><div class="number">${safe(number)}</div><div class="date">Date: ${safe(date)}${validUntil?`<br>Valid Until: ${safe(validUntil)}`:''}</div></div></header>
  <section class="parties"><div class="party"><div class="label">${kind==='invoice'?'Bill To':'Prepared For'}</div><strong>${safe(customerName)}</strong><p>${customerType?`Customer type: ${safe(({ 'walk-in':'Walk-in',online:'Online',other:'Other' })[customerType]||'Other')}\n`:''}${safe(customerAddress)}${customerPhone?`\n${safe(customerPhone)}`:''}${customerEmail?`\n${safe(customerEmail)}`:''}</p></div><div class="party"><div class="label">Document Information</div><strong>${safe(profile?.name||'Company')}</strong><p>${reference?`Reference: ${safe(reference)}\n`:''}${salesAgent?`Sales Agent: ${safe(salesAgent)}\n`:''}${paymentTerms?`Payment Terms: ${safe(paymentTerms)}`:''}</p></div></section>
  <table><thead><tr><th style="width:6%">No.</th><th style="width:42%">Description</th><th style="width:10%;text-align:right">Qty</th><th style="width:14%;text-align:right">Unit (${safe(currencyCode)})</th><th style="width:10%;text-align:right">SST / Tax</th><th style="width:18%;text-align:right">Amount (${safe(currencyCode)})</th></tr></thead><tbody>${lineRows||'<tr><td colspan="6">No items</td></tr>'}</tbody></table>
  <div class="summary"><div class="sum-row"><span>Subtotal</span><b>${moneyLabel(subtotalCents)}</b></div><div class="sum-row"><span>${taxLabel}</span><b>${moneyLabel(taxCents)}</b></div><div class="sum-row total"><span>TOTAL (${safe(currencyCode)})</span><span>${moneyLabel(totalCents)}</span></div></div>
  <div class="terms-grid"><div><h3>Notes</h3><p>${safe(notes||'—')}</p></div><div><h3>Terms &amp; Conditions</h3><p>${safe(terms|| (kind==='quotation'?'This quotation is subject to the stated validity period and agreed terms.':'Please retain this document for your records.'))}</p></div></div>
  <div class="signature"><div class="sign">Prepared by / Authorized signature</div><div class="sign">Customer acceptance / Date</div></div><div class="foot">${footerNote} &nbsp;•&nbsp; Generated by E-Inventory Pro</div></body></html>`;
  const defaultName=`${number}.pdf`;
  const {canceled,filePath}=await dialog.showSaveDialog(win,{title:`Export ${title.toLowerCase()} PDF`,defaultPath:defaultName,filters:[{name:'PDF document',extensions:['pdf']}]});
  if(canceled||!filePath)return {canceled:true};
  const popup=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false}});
  try{await popup.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));const pdf=await popup.webContents.printToPDF({pageSize:'A4',printBackground:true});fs.writeFileSync(filePath,pdf);return {canceled:false,filePath};}
  finally{popup.destroy();}
}
function registerHandlers() {
  ipcMain.handle('settings:get',()=>{
    requireSession();
    const rows=db.prepare('SELECT setting_key,setting_value FROM app_settings').all();
    const values=Object.fromEntries(rows.map(row=>[row.setting_key,row.setting_value]));
    return {currencyCode:values.currency_code||'MYR',currencySymbol:values.currency_symbol||'RM',currencyDecimals:Number(values.currency_decimals??2)};
  });
  ipcMain.handle('settings:save',(_,payload)=>{
    requireSession('supervisor');
    const code=cleanText(payload?.currencyCode,8).toUpperCase();
    const symbol=cleanText(payload?.currencySymbol,12);
    const decimals=Number(payload?.currencyDecimals);
    if(!/^[A-Z0-9]{2,8}$/.test(code)) throw Error('Currency code must contain 2–8 letters or numbers');
    if(!symbol) throw Error('Currency symbol is required');
    if(![0,2,3].includes(decimals)) throw Error('Choose 0, 2 or 3 decimal places');
    const previous=configuredCurrency();
    const set=db.prepare('INSERT INTO app_settings(setting_key,setting_value) VALUES(?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Keep each product's displayed numeric price stable when currency precision changes.
      // This is a scale adjustment only, never an exchange-rate conversion.
      if(previous.currencyDecimals!==decimals){
        const updatePrice=db.prepare("UPDATE products SET selling_price_cents=?,updated_at=datetime('now') WHERE id=?");
        for(const row of db.prepare('SELECT id,selling_price_cents FROM products').all()){
          const amount=Number(row.selling_price_cents||0)/(10**previous.currencyDecimals);
          const scaled=Math.round(amount*(10**decimals));
          if(!Number.isSafeInteger(scaled))throw Error('A product price is too large for the selected precision');
          updatePrice.run(scaled,row.id);
        }
      }
      set.run('currency_code',code);set.run('currency_symbol',symbol);set.run('currency_decimals',String(decimals));
      audit('CURRENCY_SETTINGS',`${code} · ${symbol} · ${decimals} decimal places`);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return {currencyCode:code,currencySymbol:symbol,currencyDecimals:decimals};
  });
  ipcMain.handle('company:get', () => {
    requireSession();
    return db.prepare('SELECT name,registration,sst_registration,email,phone,address,logo_data FROM company_profile WHERE id=1').get() || {name:'',registration:'',sst_registration:'',email:'',phone:'',address:'',logo_data:''};
  });
  ipcMain.handle('company:save', (_,payload) => {
    requireSession('supervisor');
    if(!payload || typeof payload !== 'object') throw Error('Invalid company details');
    const clean=(key,max) => {
      const v=String(payload[key] ?? '').trim();
      if(v.length>max) throw Error(`${key} exceeds the permitted length`);
      return v;
    };
    const name=clean('name',150), registration=clean('registration',80), sstRegistration=clean('sst_registration',80), email=clean('email',150), phone=clean('phone',60), address=clean('address',500);
    if(!name) throw Error('Company name is required');
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Enter a valid company email');
    db.prepare(`INSERT INTO company_profile(id,name,registration,sst_registration,email,phone,address) VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,registration=excluded.registration,sst_registration=excluded.sst_registration,
      email=excluded.email,phone=excluded.phone,address=excluded.address`).run(name,registration,sstRegistration,email,phone,address);
    audit('COMPANY_UPDATE', name);
    return {name,registration,sst_registration:sstRegistration,email,phone,address};
  });
  ipcMain.handle('company:logo', (_, payload) => {
    requireSession('supervisor');
    if (payload === null) {
      db.prepare("UPDATE company_profile SET logo_data='' WHERE id=1").run();
      audit('LOGO_REMOVE','Company logo removed');
      return {logo_data:''};
    }
    if(typeof payload!=='string' || payload.length>1000000) throw Error('Logo must be smaller than 500 KB');
    const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(payload);
    if(!match) throw Error('Select a PNG, JPEG or WebP logo');
    const bytes=Buffer.from(match[2],'base64');
    if(bytes.length>500000 || bytes.length<12) throw Error('Logo must be smaller than 500 KB');
    const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
    const jpg=bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff;
    const webp=bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
    if(!((match[1]==='png'&&png)||(match[1]==='jpeg'&&jpg)||(match[1]==='webp'&&webp))) throw Error('Logo file content is not a supported image');
    db.prepare("INSERT INTO company_profile(id,logo_data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET logo_data=excluded.logo_data").run(payload);
    audit('LOGO_UPDATE','Company logo uploaded');
    return {logo_data:payload};
  });
  ipcMain.handle('auth:state', () => ({needsSetup:db.prepare('SELECT COUNT(*) AS count FROM users').get().count===0, user:session}));
  ipcMain.handle('auth:setup', (_ , payload) => {
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count!==0) throw Error('Initial account already exists');
    session=createUser(payload,'owner');
    db.prepare("INSERT OR IGNORE INTO app_settings(setting_key,setting_value) VALUES('max_supervisors','1')").run();
    audit('OWNER_ACCOUNT_SETUP',session.username); return session;
  });
  ipcMain.handle('auth:login', (_ , payload) => {
    const username=String(payload?.username??'').trim();
    const password=String(payload?.password??'');
    if(password.length>128) throw Error('Invalid username or password');
    const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const salt=user ? Buffer.from(user.salt,'hex') : Buffer.alloc(16);
    const hash=crypto.scryptSync(password,salt,64);
    const stored=user ? Buffer.from(user.password_hash,'hex') : Buffer.alloc(64);
    if (!user || !crypto.timingSafeEqual(hash,stored)) throw Error('Invalid username or password');
    session={id:user.id,username:user.username,role:user.role}; audit('LOGIN',user.username);return session;
  });
  ipcMain.handle('auth:logout',()=>{if(session)audit('LOGOUT',session.username);session=null;return true;});
  ipcMain.handle('users:list',()=>{requireSession('supervisor');return db.prepare('SELECT id,username,role,created_at FROM users ORDER BY id').all();});
  ipcMain.handle('users:create',(_,payload)=>{
    requireSession('supervisor');
    if(!['supervisor','staff'].includes(payload?.role))throw Error('Role must be Supervisor or Staff');
    if(payload.role==='supervisor') {
      const cap=Number(db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='max_supervisors'").get()?.setting_value ?? 1);
      const count=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='supervisor'").get().n;
      if(count>=cap)throw Error(`Supervisor account limit reached (${count}/${cap}). Ask the Owner to increase the limit.`);
    }
    const created=createUser(payload,payload.role);audit('USER_CREATE',`${created.username} (${created.role})`);return created;
  });
  ipcMain.handle('owner:state',()=>{
    requireSession('supervisor');
    const configured=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").get().n>0;
    const supervisorCount=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='supervisor'").get().n;
    const maxSupervisors=Number(db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='max_supervisors'").get()?.setting_value ?? 1);
    return {configured,supervisorCount,maxSupervisors,canEditLimit:session.role==='owner'};
  });
  ipcMain.handle('owner:limits:save',(_,payload)=>{
    requireSession('owner');
    const cap=Number(payload?.maxSupervisors);
    if(!Number.isSafeInteger(cap)||cap<0||cap>1000)throw Error('Enter a whole-number Supervisor limit between 0 and 1000');
    const count=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='supervisor'").get().n;
    if(cap<count)throw Error(`The current ${count} Supervisor account(s) must be removed before setting a lower limit.`);
    db.prepare("INSERT INTO app_settings(setting_key,setting_value) VALUES('max_supervisors',?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value").run(String(cap));
    audit('SUPERVISOR_LIMIT_UPDATE',`Maximum Supervisor accounts set to ${cap}`);
    return {maxSupervisors:cap,supervisorCount:count};
  });
  ipcMain.handle('stock:reset-all', async (_, payload) => {
    requireSession('supervisor');
    if(payload?.phrase !== 'RESET ALL STOCK')throw Error('Type RESET ALL STOCK exactly');
    const supervisorName=String(payload?.supervisorUsername??'').trim();
    const ownerName=String(payload?.ownerUsername??'').trim();
    const supervisor=db.prepare("SELECT * FROM users WHERE username=? AND role='supervisor'").get(supervisorName);
    const owner=db.prepare("SELECT * FROM users WHERE username=? AND role='owner'").get(ownerName);
    if(!supervisor || !owner || supervisor.id===owner.id)throw Error('Select two different Supervisor and Owner accounts');
    if(!verifyPassword(supervisor,payload?.supervisorPassword))throw Error('Incorrect Supervisor credentials');
    if(!verifyPassword(owner,payload?.ownerPassword))throw Error('Incorrect Owner credentials');
    if(!((session.role==='supervisor'&&session.id===supervisor.id)||(session.role==='owner'&&session.id===owner.id)))
      throw Error('The signed-in user must be one of the two approvers');
    const approvedId=session.id;
    const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(quantity),0) AS units FROM products WHERE quantity > 0').get();
    if (totals.count === 0) throw Error('All stock quantities are already zero');
    const {response} = await dialog.showMessageBox(win, {
      type:'warning', buttons:['Cancel','Confirm stock reset'], defaultId:0,cancelId:0,noLink:true,
      message:'Reset ALL product quantities to zero?',
      detail:`${totals.count} products and ${totals.units} units will be affected. Products and transaction history will be preserved. A safety backup will be created first.`
    });
    if (response !== 1) return { canceled:true };
    // Reconfirm authorization after async dialog; no changes may happen without both credentials.
    requireSession('supervisor');
    if(session.id!==approvedId || !verifyPassword(supervisor,payload.supervisorPassword) || !verifyPassword(owner,payload.ownerPassword))throw Error('Approval expired');
    const backupPath = path.join(app.getPath('userData'),`pre-stock-reset-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
    await backup(db,backupPath); // Abort if no backup can be made.
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare('SELECT id,quantity FROM products WHERE quantity > 0').all();
      const record = db.prepare("INSERT INTO movements(product_id,type,quantity,note) VALUES (?,'OUT',?,?)");
      const update = db.prepare("UPDATE products SET quantity=0,updated_at=datetime('now') WHERE id=?");
      for (const row of rows) {
        record.run(row.id,row.quantity,`FULL STOCK RESET approved by Supervisor ${supervisor.username} and Owner ${owner.username}`);
        update.run(row.id);
      }
      const units = rows.reduce((n,row)=>n+row.quantity,0);
      db.prepare('INSERT INTO stock_resets(admin_username,owner_username,affected_products,cleared_units,backup_path) VALUES(?,?,?,?,?)').run(supervisor.username,owner.username,rows.length,units,backupPath);
      audit('STOCK_RESET',`${rows.length} products; ${units} units; Supervisor ${supervisor.username}; Owner ${owner.username}`);
      db.exec('COMMIT');
      return {canceled:false,affectedProducts:rows.length,clearedUnits:units,backupPath};
    } catch(e) {db.exec('ROLLBACK');throw e;}
  });
  ipcMain.handle('products:list', () => {requireSession();return db.prepare('SELECT * FROM products WHERE deleted=0 ORDER BY archived,name').all();});
  ipcMain.handle('products:add', (_, payload) => {
    requireSession();
    const p = validProduct(payload);
    const result = db.prepare('INSERT INTO products(sku,name,category,quantity,min_stock,selling_price_cents) VALUES (?,?,?,?,?,?)').run(p.sku,p.name,p.category,p.quantity,p.minStock,p.sellingPriceCents);
    audit('PRODUCT_ADD', p.sku);
    return { id: Number(result.lastInsertRowid) };
  });
  ipcMain.handle('products:update',(_,payload)=>{
    requireSession('supervisor');
    const id=Number(payload?.id);
    if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid product');
    const old=db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if(!old || old.deleted)throw Error('Product not found');
    const p=validProduct({...payload,quantity:old.quantity});
    db.prepare("UPDATE products SET sku=?,name=?,category=?,min_stock=?,selling_price_cents=?,updated_at=datetime('now') WHERE id=?").run(p.sku,p.name,p.category,p.minStock,p.sellingPriceCents,id);
    audit('PRODUCT_EDIT', old.sku);
    return {ok:true};
  });
  ipcMain.handle('products:archive',(_,payload)=>{
    requireSession('supervisor');const id=Number(payload?.id);
    if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid product');
    const p=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!p || p.deleted)throw Error('Product not found');
    if(p.quantity!==0 && !p.archived)throw Error('Stock must be zero before archiving. Record legitimate stock movements first.');
    db.prepare("UPDATE products SET archived=?,updated_at=datetime('now') WHERE id=?").run(p.archived?0:1,id);
    audit(p.archived?'PRODUCT_RESTORE':'PRODUCT_ARCHIVE',p.sku);
    return {ok:true};
  });
  ipcMain.handle('products:delete',(_,payload)=>{
    requireSession('supervisor');
    const id=Number(payload?.id), reason=String(payload?.reason??'').trim();
    if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid product');
    if(reason.length<3||reason.length>500)throw Error('Enter a deletion reason (3–500 characters)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const product=db.prepare('SELECT * FROM products WHERE id=? AND deleted=0').get(id);
      if(!product)throw Error('Product not found or already deleted');
      db.prepare('INSERT INTO product_deletions(product_id,sku,name,quantity_at_deletion,deleted_by,reason) VALUES(?,?,?,?,?,?)')
        .run(id,product.sku,product.name,product.quantity,session.username,reason);
      db.prepare("UPDATE products SET deleted=1,archived=1,updated_at=datetime('now') WHERE id=?").run(id);
      audit('PRODUCT_DELETE',`${product.sku} — ${reason}`);
      db.exec('COMMIT');
      return {ok:true,removedQuantity:product.quantity};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  });
  ipcMain.handle('stock:move', (_, payload) => {
    requireSession();
    const id = Number(payload?.id), quantity = Number(payload?.quantity), type = payload?.type;
    const note = String(payload?.note ?? '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || !['IN','OUT'].includes(type) || note.length > 500) throw Error('Invalid stock movement');
    db.exec('BEGIN IMMEDIATE');
    try {
      const item = db.prepare('SELECT quantity,archived,deleted FROM products WHERE id=?').get(id);
      if (!item) throw Error('Product not found');
      if(item.archived || item.deleted)throw Error('Unavailable or deleted product cannot have stock movements');
      const newQty = item.quantity + (type === 'IN' ? quantity : -quantity);
      if (newQty < 0 || !Number.isSafeInteger(newQty)) throw Error('Insufficient stock or quantity overflow');
      db.prepare("UPDATE products SET quantity=?,updated_at=datetime('now') WHERE id=?").run(newQty,id);
      db.prepare('INSERT INTO movements(product_id,type,quantity,note) VALUES(?,?,?,?)').run(id,type,quantity,note);
      db.exec('COMMIT');
      audit('STOCK_'+type,`Product #${id} qty ${quantity}`);
      return { quantity: newQty };
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  });
  ipcMain.handle('movements:list', () => {requireSession();return db.prepare('SELECT m.id,p.sku,p.name,m.type,m.quantity,m.note,m.created_at FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 200').all();});
  ipcMain.handle('invoice:list',()=>{
    requireSession();return db.prepare(`SELECT i.*,m.quantity,m.type,p.sku,p.name
      FROM invoices i JOIN movements m ON m.id=i.movement_id
      JOIN products p ON p.id=m.product_id ORDER BY i.id DESC`).all();
  });
  ipcMain.handle('invoice:create',(_,payload)=>{
    requireSession();
    const movementId=Number(payload?.movementId);
    const seller=String(payload?.seller??'').trim();
    const buyer=String(payload?.buyer??'').trim();
    const buyerAddress=String(payload?.buyerAddress??'').trim();
    const price=Number(payload?.price);
    if(!Number.isSafeInteger(movementId)||movementId<=0||!seller||!buyer||seller.length>200||buyer.length>200||buyerAddress.length>500||!Number.isFinite(price)||price<0||price>100000000||Math.round(price*100)/100!==price)throw Error('Check seller, buyer and unit price (two decimal places maximum)');
    const m=db.prepare("SELECT id FROM movements WHERE id=? AND type='OUT'").get(movementId);
    if(!m)throw Error('Choose an outbound stock transaction');
    const number='INV-'+String(movementId).padStart(6,'0');
    const r=db.prepare('INSERT INTO invoices(movement_id,invoice_number,seller,buyer,buyer_address,unit_price_cents) VALUES (?,?,?,?,?,?)').run(movementId,number,seller,buyer,buyerAddress,Math.round(price*100));
    audit('DRAFT_INVOICE_CREATE',number);
    return {id:Number(r.lastInsertRowid)};
  });
  ipcMain.handle('invoice:pdf',async(_,id)=>{
    requireSession();id=validPositive(id);
    const invoice=db.prepare(`SELECT i.*,m.quantity,p.sku,p.name FROM invoices i JOIN movements m ON m.id=i.movement_id JOIN products p ON p.id=m.product_id WHERE i.id=?`).get(id);
    if(!invoice)throw Error('Invoice not found');
    const profile=db.prepare('SELECT * FROM company_profile WHERE id=1').get()||{};
    const subtotal=invoice.unit_price_cents*invoice.quantity;
    const settings=Object.fromEntries(db.prepare('SELECT setting_key,setting_value FROM app_settings').all().map(row=>[row.setting_key,row.setting_value]));
    const result=await exportCommercialPdf({kind:'invoice',number:invoice.invoice_number,date:invoice.created_at,customerName:invoice.buyer,customerAddress:invoice.buyer_address,items:[{sku:invoice.sku,description:invoice.name,quantity:invoice.quantity,unit_price_cents:invoice.unit_price_cents,line_subtotal_cents:subtotal,line_tax_cents:0,tax_rate_bps:0}],subtotalCents:subtotal,taxCents:0,totalCents:subtotal,profile:{...profile,name:profile.name||invoice.seller},currencyCode:'MYR',currencySymbol:'RM',currencyDecimals:2});
    if(!result.canceled)audit('DRAFT_INVOICE_PDF',invoice.invoice_number);
    return result;
  });
  // v0.3.0 — independent sales, reporting, purchasing, and audit panels.
  ipcMain.handle('customers:list',()=>{requireSession();return db.prepare('SELECT * FROM customers ORDER BY name').all();});
  ipcMain.handle('customers:add',(_,p)=>{requireSession();const name=cleanText(p?.name);if(!name)throw Error('Customer name is required');
    const id=db.prepare('INSERT INTO customers(name,phone,email,address) VALUES(?,?,?,?)').run(name,cleanText(p?.phone,60),cleanText(p?.email,120),cleanText(p?.address,500)).lastInsertRowid;
    audit('CUSTOMER_ADD',`Customer #${id} ${name}`);return {id:Number(id)};});
  ipcMain.handle('sales:list',()=>{requireSession();return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM sale_items WHERE sale_id=s.id) AS line_count FROM sales s ORDER BY s.id DESC LIMIT 200`).all();});
  ipcMain.handle('sales:detail',(_,saleId)=>{requireSession();const id=validPositive(saleId);const sale=db.prepare('SELECT s.*,c.phone AS customer_phone,c.email AS customer_email FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(id);if(!sale)throw Error('Sale not found');return {sale,items:db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(id)};});
  ipcMain.handle('sales:create',(_,p)=>{
    requireSession();const customerType=String(p?.customerType||'walk-in').trim().toLowerCase();if(!['walk-in','online','other'].includes(customerType))throw Error('Select a valid customer type');const buyer=cleanText(p?.buyer,200)||(customerType==='walk-in'?'Walk-in customer':'');if(!buyer)throw Error('Buyer name required for online or other customers');const address=cleanText(p?.address,500);
    const lines=Array.isArray(p?.items)?p.items:[];if(!lines.length||lines.length>100)throw Error('Add 1–100 products to sale');
    let subtotal=0,taxTotal=0;const seen=new Set();const validated=lines.map(line=>{
      const id=validPositive(line.productId),quantity=validPositive(line.quantity);
      const rateBps=Number(line.taxRateBps??0);
      if(!Number.isSafeInteger(rateBps)||rateBps<0||rateBps>10000)throw Error('Tax rate must be between 0 and 100 percent');
      if(seen.has(id))throw Error('A product can only appear once per sale');seen.add(id);
      const product=db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if(!product || product.deleted || product.archived)throw Error('Product unavailable');
      if(product.quantity<quantity)throw Error(`Insufficient stock for ${product.sku} (available: ${product.quantity})`);
      const price=Number(product.selling_price_cents||0);
      const lineSubtotal=quantity*price,lineTax=Math.round(lineSubtotal*rateBps/10000);
      if(!Number.isSafeInteger(lineSubtotal)||!Number.isSafeInteger(lineTax))throw Error('Sale line amount too large');
      subtotal+=lineSubtotal;taxTotal+=lineTax;
      if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(taxTotal))throw Error('Sale total too large');
      return {product,quantity,price,rateBps,lineTax};});
    const total=subtotal+taxTotal;if(!Number.isSafeInteger(total))throw Error('Sale total too large');
    const currency=configuredCurrency();
    db.exec('BEGIN IMMEDIATE');try{
      const result=db.prepare('INSERT INTO sales(buyer_name,buyer_address,customer_id,customer_type,subtotal_cents,tax_cents,total_cents,currency_code,currency_symbol,currency_decimals,created_by) VALUES(?,?,NULL,?,?,?,?,?,?,?,?)').run(buyer,address,customerType,subtotal,taxTotal,total,currency.currencyCode,currency.currencySymbol,currency.currencyDecimals,session.username);
      const saleId=Number(result.lastInsertRowid);const number='SALE-'+String(saleId).padStart(6,'0');db.prepare('UPDATE sales SET number=? WHERE id=?').run(number,saleId);
      for(const x of validated){const product=x.product;
        const affected=db.prepare("UPDATE products SET quantity=quantity-?,updated_at=datetime('now') WHERE id=? AND quantity>=? AND archived=0 AND deleted=0").run(x.quantity,product.id,x.quantity);
        if(affected.changes!==1)throw Error(`Stock changed for ${product.sku}; retry the sale`);
        const movement=db.prepare("INSERT INTO movements(product_id,type,quantity,note) VALUES(?,'OUT',?,?)").run(product.id,x.quantity,`Sale ${number}`);
        db.prepare('INSERT INTO sale_items(sale_id,product_id,sku,name,quantity,unit_price_cents,tax_rate_bps,line_tax_cents,movement_id) VALUES(?,?,?,?,?,?,?,?,?)').run(saleId,product.id,product.sku,product.name,x.quantity,x.price,x.rateBps,x.lineTax,Number(movement.lastInsertRowid));
      }
      audit('SALE_CREATE',`${number} · ${buyer} · ${customerType} · subtotal ${subtotal} · tax ${taxTotal}`);db.exec('COMMIT');return {id:saleId,number,subtotal_cents:subtotal,tax_cents:taxTotal,total_cents:total};
    }catch(error){db.exec('ROLLBACK');throw error;}
  });
  ipcMain.handle('sales:pdf',async(_,saleId)=>{
    requireSession();const id=validPositive(saleId);
    const sale=db.prepare('SELECT s.*,c.phone AS customer_phone,c.email AS customer_email FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?').get(id);if(!sale)throw Error('Sale not found');
    const lines=db.prepare('SELECT sku,name,quantity,unit_price_cents,tax_rate_bps,line_tax_cents FROM sale_items WHERE sale_id=? ORDER BY id').all(id);
    const items=lines.map(line=>({sku:line.sku,description:line.name,quantity:line.quantity,unit_price_cents:line.unit_price_cents,line_subtotal_cents:line.quantity*line.unit_price_cents,line_tax_cents:line.line_tax_cents||0,tax_rate_bps:line.tax_rate_bps||0}));
    const profile=db.prepare('SELECT * FROM company_profile WHERE id=1').get()||{};
    const result=await exportCommercialPdf({kind:'invoice',number:'INV-'+String(sale.created_at||new Date().getFullYear()).slice(0,4)+'-'+String(id).padStart(6,'0'),date:sale.created_at,customerName:sale.buyer_name,customerType:sale.customer_type||'other',customerPhone:sale.customer_phone||'',customerEmail:sale.customer_email||'',customerAddress:sale.buyer_address,items,subtotalCents:sale.subtotal_cents,taxCents:sale.tax_cents||0,totalCents:sale.total_cents||sale.subtotal_cents,profile,currencyCode:sale.currency_code||'MYR',currencySymbol:sale.currency_symbol||'RM',currencyDecimals:Number(sale.currency_decimals??2),terms:'Commercial invoice for the completed sale.'});
    if(!result.canceled)audit('SALE_INVOICE_PDF',sale.number);
    return result;
  });
  ipcMain.handle('quotations:list',()=>{
    requireSession();return db.prepare(`SELECT q.*, (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id=q.id) AS line_count FROM quotations q ORDER BY q.id DESC LIMIT 300`).all();
  });
  ipcMain.handle('quotations:create',(_,payload)=>{
    requireSession();
    const customerType=String(payload?.customerType||'walk-in').trim().toLowerCase();if(!['walk-in','online','other'].includes(customerType))throw Error('Select a valid customer type');const customerName=cleanText(payload?.customerName,200)||(customerType==='walk-in'?'Walk-in customer':'');if(!customerName)throw Error('Customer / company name is required for online or other customers');
    const customerPhone=cleanText(payload?.customerPhone,60),customerEmail=cleanText(payload?.customerEmail,120),customerAddress=cleanText(payload?.customerAddress,500);
    if(customerEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))throw Error('Enter a valid customer email');
    const date=cleanText(payload?.quotationDate,10),validUntil=cleanText(payload?.validUntil,10);
    const validDate=x=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(x+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===x;};
    if(!validDate(date)||!validDate(validUntil))throw Error('Enter a valid quotation date and expiry date');
    if(validUntil<date)throw Error('Quotation validity date cannot be earlier than the quotation date');
    const paymentTerms=cleanText(payload?.paymentTerms,160),reference=cleanText(payload?.reference,100),salesAgent=cleanText(payload?.salesAgent,100),notes=cleanText(payload?.notes,1000),terms=cleanText(payload?.terms,2000);
    const lines=Array.isArray(payload?.items)?payload.items:[];if(!lines.length||lines.length>100)throw Error('Add between 1 and 100 quotation items');
    let subtotal=0,taxTotal=0;
    const validated=lines.map(line=>{
      const productId=line?.productId?validPositive(line.productId):null;
      const quantity=Number(line?.quantity);if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000||Math.abs(quantity*1000-Math.round(quantity*1000))>0.000001)throw Error('Enter a positive item quantity with up to three decimal places');
      const rate=Number(line?.taxRate);
      if(!Number.isFinite(rate)||rate<0||rate>100||Math.abs(rate*100-Math.round(rate*100))>0.000001)throw Error('Tax rate must be between 0 and 100 percent, using up to two decimals');
      let description,sku,unitPrice;
      if(productId){
        const product=db.prepare('SELECT * FROM products WHERE id=? AND deleted=0 AND archived=0').get(productId);
        if(!product)throw Error('Selected inventory product is no longer active');
        description=product.name;sku=product.sku;unitPrice=Number(product.selling_price_cents||0);
      } else {
        description=cleanText(line?.description,300);if(!description)throw Error('Each manual service item needs a description');
        sku=cleanText(line?.sku,100);unitPrice=validMoney(Number(line?.unitPrice));
      }
      const lineSubtotal=Math.round(quantity*unitPrice),rateBps=Math.round(rate*100),lineTax=Math.round(lineSubtotal*rateBps/10000);
      if(!Number.isSafeInteger(lineSubtotal)||!Number.isSafeInteger(lineTax))throw Error('Quotation item amount is too large');
      subtotal+=lineSubtotal;taxTotal+=lineTax;if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(taxTotal))throw Error('Quotation total is too large');
      return {productId,sku,description,quantity,unitPrice,rateBps,lineSubtotal,lineTax};
    });
    const total=subtotal+taxTotal;if(!Number.isSafeInteger(total))throw Error('Quotation total is too large');
    const currency=configuredCurrency();
    db.exec('BEGIN IMMEDIATE');try{
      const temp='TEMP-'+crypto.randomUUID();
      const result=db.prepare(`INSERT INTO quotations(quotation_number,customer_name,customer_type,customer_phone,customer_email,customer_address,quotation_date,valid_until,payment_terms,reference,sales_agent,notes,terms,subtotal_cents,tax_cents,total_cents,currency_code,currency_symbol,currency_decimals,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(temp,customerName,customerType,customerPhone,customerEmail,customerAddress,date,validUntil,paymentTerms,reference,salesAgent,notes,terms,subtotal,taxTotal,total,currency.currencyCode,currency.currencySymbol,currency.currencyDecimals,session.username);
      const id=Number(result.lastInsertRowid),number=`QTN-${date.slice(0,4)}-${String(id).padStart(6,'0')}`;
      db.prepare('UPDATE quotations SET quotation_number=? WHERE id=?').run(number,id);
      const insert=db.prepare('INSERT INTO quotation_items(quotation_id,product_id,sku,description,quantity,unit_price_cents,tax_rate_bps,line_subtotal_cents,line_tax_cents) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const x of validated)insert.run(id,x.productId,x.sku,x.description,x.quantity,x.unitPrice,x.rateBps,x.lineSubtotal,x.lineTax);
      audit('QUOTATION_CREATE',`${number} · ${customerName} · ${currency.currencyCode} ${ (total/(10**currency.currencyDecimals)).toFixed(currency.currencyDecimals)}`);db.exec('COMMIT');return {id,number,subtotal_cents:subtotal,tax_cents:taxTotal,total_cents:total};
    }catch(error){db.exec('ROLLBACK');throw error;}
  });
  ipcMain.handle('quotations:pdf',async(_,quotationId)=>{
    requireSession();const id=validPositive(quotationId);
    const quote=db.prepare('SELECT * FROM quotations WHERE id=?').get(id);if(!quote)throw Error('Quotation not found');
    const items=db.prepare('SELECT sku,description,quantity,unit_price_cents,tax_rate_bps,line_subtotal_cents,line_tax_cents FROM quotation_items WHERE quotation_id=? ORDER BY id').all(id);
    const profile=db.prepare('SELECT * FROM company_profile WHERE id=1').get()||{};
    const result=await exportCommercialPdf({kind:'quotation',number:quote.quotation_number,date:quote.quotation_date,validUntil:quote.valid_until,customerName:quote.customer_name,customerType:quote.customer_type||'other',customerPhone:quote.customer_phone,customerEmail:quote.customer_email,customerAddress:quote.customer_address,paymentTerms:quote.payment_terms,reference:quote.reference,salesAgent:quote.sales_agent,notes:quote.notes,terms:quote.terms,items,subtotalCents:quote.subtotal_cents,taxCents:quote.tax_cents,totalCents:quote.total_cents,profile,currencyCode:quote.currency_code||'MYR',currencySymbol:quote.currency_symbol||'RM',currencyDecimals:Number(quote.currency_decimals??2)});
    if(!result.canceled)audit('QUOTATION_PDF',quote.quotation_number);return result;
  });
  ipcMain.handle('suppliers:list',()=>{requireSession();return db.prepare('SELECT * FROM suppliers ORDER BY name').all();});
  ipcMain.handle('suppliers:add',(_,p)=>{requireSession('supervisor');const name=cleanText(p?.name);if(!name)throw Error('Supplier name required');const result=db.prepare('INSERT INTO suppliers(name,phone,email) VALUES(?,?,?)').run(name,cleanText(p?.phone,60),cleanText(p?.email,120));audit('SUPPLIER_ADD',name);return {id:Number(result.lastInsertRowid)};});
  ipcMain.handle('purchases:list',()=>{requireSession();return db.prepare(`SELECT o.*,s.name AS supplier_name FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id ORDER BY o.id DESC LIMIT 200`).all();});
  ipcMain.handle('purchases:create',(_,p)=>{requireSession('supervisor');const supplierId=validPositive(p?.supplierId);if(!db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId))throw Error('Supplier not found');const productId=validPositive(p?.productId),qty=validPositive(p?.quantity),cost=validMoney(p?.cost);if(!db.prepare('SELECT id FROM products WHERE id=? AND deleted=0 AND archived=0').get(productId))throw Error('Active product not found');
    db.exec('BEGIN IMMEDIATE');try{const result=db.prepare('INSERT INTO purchase_orders(supplier_id,created_by) VALUES(?,?)').run(supplierId,session.username);const id=Number(result.lastInsertRowid);db.prepare('INSERT INTO purchase_items(order_id,product_id,quantity,unit_cost_cents) VALUES(?,?,?,?)').run(id,productId,qty,cost);audit('PURCHASE_ORDER_CREATE',`PO #${id} · qty ${qty}`);db.exec('COMMIT');return {id};}catch(e){db.exec('ROLLBACK');throw e;}});
  ipcMain.handle('purchases:receive',(_,orderId)=>{requireSession('supervisor');const id=validPositive(orderId);db.exec('BEGIN IMMEDIATE');try{const order=db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);if(!order||order.status!=='OPEN')throw Error('Purchase order is not open');const lines=db.prepare('SELECT * FROM purchase_items WHERE order_id=?').all(id);
    for(const x of lines){const updated=db.prepare("UPDATE products SET quantity=quantity+?,updated_at=datetime('now') WHERE id=? AND deleted=0 AND archived=0 AND quantity<=?").run(x.quantity,x.product_id,Number.MAX_SAFE_INTEGER-x.quantity);if(updated.changes!==1)throw Error('A product is no longer available or quantity exceeds safe limit');db.prepare("INSERT INTO movements(product_id,type,quantity,note) VALUES(?,'IN',?,?)").run(x.product_id,x.quantity,`Purchase order #${id}`);}
    db.prepare("UPDATE purchase_orders SET status='RECEIVED',received_at=datetime('now'),received_by=? WHERE id=?").run(session.username,id);audit('PURCHASE_RECEIVE',`PO #${id}`);db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}});
  ipcMain.handle('analytics:summary',()=>{requireSession();return {
    orders:db.prepare('SELECT COUNT(*) AS count FROM sales').get(),
    revenueByCurrency:db.prepare('SELECT currency_code,currency_symbol,currency_decimals,COUNT(*) AS count,COALESCE(SUM(subtotal_cents),0) AS cents FROM sales GROUP BY currency_code,currency_symbol,currency_decimals ORDER BY currency_code').all(),
    daily:db.prepare("SELECT substr(created_at,1,10) AS day,currency_code,currency_symbol,currency_decimals,COUNT(*) AS count,SUM(subtotal_cents) AS cents FROM sales GROUP BY substr(created_at,1,10),currency_code,currency_symbol,currency_decimals ORDER BY day DESC LIMIT 60").all().reverse(),
    top:db.prepare('SELECT i.sku,i.name,s.currency_code,s.currency_symbol,s.currency_decimals,SUM(i.quantity) AS qty,SUM(i.quantity*i.unit_price_cents) AS cents FROM sale_items i JOIN sales s ON s.id=i.sale_id GROUP BY i.product_id,s.currency_code,s.currency_symbol,s.currency_decimals ORDER BY qty DESC LIMIT 20').all(),
    low:db.prepare('SELECT sku,name,quantity,min_stock FROM products WHERE deleted=0 AND archived=0 AND quantity<=min_stock ORDER BY quantity LIMIT 30').all()
  };});
  ipcMain.handle('reports:export',async(_,which)=>{requireSession('supervisor');
    const sources={products:()=>db.prepare("SELECT sku,name,category,quantity,min_stock,selling_price_cents,(SELECT setting_value FROM app_settings WHERE setting_key='currency_code') AS currency_code,(SELECT setting_value FROM app_settings WHERE setting_key='currency_symbol') AS currency_symbol,(SELECT setting_value FROM app_settings WHERE setting_key='currency_decimals') AS currency_decimals,archived FROM products WHERE deleted=0").all(),sales:()=>db.prepare('SELECT number,buyer_name,customer_type,subtotal_cents,tax_cents,total_cents,currency_code,currency_symbol,currency_decimals,created_at,created_by FROM sales').all(),movements:()=>db.prepare('SELECT p.sku,m.type,m.quantity,m.note,m.created_at FROM movements m JOIN products p ON p.id=m.product_id').all(),purchases:()=>db.prepare('SELECT o.id,s.name AS supplier,o.status,o.created_at,o.received_at FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id').all()};
    if(!Object.prototype.hasOwnProperty.call(sources,which))throw Error('Unknown report');const rows=sources[which]();const headers=rows.length?Object.keys(rows[0]):({products:['sku','name','category','quantity','min_stock','selling_price_cents','currency_code','currency_symbol','currency_decimals','archived'],sales:['number','buyer_name','customer_type','subtotal_cents','tax_cents','total_cents','currency_code','currency_symbol','currency_decimals','created_at','created_by'],movements:['sku','type','quantity','note','created_at'],purchases:['id','supplier','status','created_at','received_at']})[which];
    const {canceled,filePath}=await dialog.showSaveDialog(win,{title:'Export '+which+' CSV',defaultPath:`E-Inventory-${which}-${new Date().toISOString().slice(0,10)}.csv`,filters:[{name:'CSV',extensions:['csv']}]});if(canceled||!filePath)return {canceled:true};
    const csv='\ufeff'+[headers.map(csvValue).join(','),...rows.map(row=>headers.map(k=>csvValue(row[k])).join(','))].join('\r\n');fs.writeFileSync(filePath,csv,'utf8');audit('REPORT_EXPORT',which);return {canceled:false,count:rows.length};});
  ipcMain.handle('audit:list',()=>{requireSession('owner');return db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 300').all();});
  ipcMain.handle('backup:create', async () => {
    requireSession('supervisor');
    const { canceled,filePath } = await dialog.showSaveDialog(win,{title:'Save E-Inventory Backup',defaultPath:`E-Inventory-${new Date().toISOString().slice(0,10)}.sqlite`,filters:[{name:'SQLite backup',extensions:['sqlite']} ]});
    if(canceled || !filePath) return {canceled:true};
    if(path.resolve(filePath) === path.resolve(dbPath())) throw Error('Choose a different backup destination');
    await backup(db,filePath);
    return {canceled:false};
  });
  ipcMain.handle('backup:restore', async () => {
    requireSession('supervisor');
    const {canceled,filePaths} = await dialog.showOpenDialog(win,{title:'Select SQLite Backup',properties:['openFile'],filters:[{name:'SQLite backup',extensions:['sqlite','db']}]});
    if(canceled || !filePaths.length) return {canceled:true};
    const source = filePaths[0];
    if(path.resolve(source) === path.resolve(dbPath())) throw Error('Cannot restore from the active database');
    // Validate source before replacing the active database.
    const test = new DatabaseSync(source,{readOnly:true});
    try {
      if(test.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Backup failed integrity check');
      for(const table of ['products','movements']) if(!test.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('Not an E-Inventory backup');
    } finally { test.close(); }
    const {response} = await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Restore'],defaultId:0,cancelId:0,message:'Replace your current inventory with this backup?',detail:'This will overwrite the current database. A safety backup of the current database will be saved first.'});
    if(response!==1) return {canceled:true};
    const safety = path.join(app.getPath('userData'),`pre-restore-${Date.now()}.sqlite`);
    await backup(db,safety);
    db.close();
    try {
      fs.copyFileSync(source, dbPath());
      openDb();
      session=null;
      return {canceled:false, safetyBackup:safety};
    } catch(err) {
      fs.copyFileSync(safety,dbPath());
      openDb();
      throw err;
    }
  });
}
app.whenReady().then(() => {
  // Remove Electron's native File / Edit / View / Window menu from the app.
  // The renderer does not need a menu bar; hide it in both development and packaged builds.
  Menu.setApplicationMenu(null);
  openDb(); registerHandlers();
  const packaged = app.isPackaged;
  win = new BrowserWindow({
    title: 'E-Inventory Pro',
    width: 1250,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !packaged
    }
  });
  // Keep the normal Windows title bar (minimize / maximize / close),
  // but launch the application maximized to use the full available screen.
  win.once('ready-to-show', () => {
    win.maximize();
    win.setMenuBarVisibility(false);
    win.show();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  if (packaged) {
    // Block common Chromium DevTools shortcuts in installed builds.
    win.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      const blocked = key === 'f12' ||
        ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key)) ||
        ((input.control || input.meta) && input.alt && key === 'i');
      if (blocked) event.preventDefault();
    });
    // Defensive close in case DevTools is opened by another path.
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
    win.webContents.on('context-menu', event => event.preventDefault());
  }
  win.loadFile('index.html');
});
app.on('window-all-closed',()=>{if(db) db.close(); if(process.platform!=='darwin') app.quit();});
