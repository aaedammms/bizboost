const $ = selector => document.querySelector(selector);
const api = window.inventoryAPI;
let user = null, products = [], movements = [], invoices = [];
let appSettings = {currencyCode:'MYR',currencySymbol:'RM',currencyDecimals:2};
let quotationItems = [], documentSales = [], quotationHistory = [];
let company = {name:'',registration:'',sst_registration:'',email:'',phone:'',address:'',logo_data:''};
const canManage=()=>['supervisor','owner'].includes(user?.role);
function cash(minorUnits,currency=null){const cfg=currency||appSettings;const value=Number(minorUnits||0)/(10**Number(cfg.currencyDecimals??2));return `${cfg.currencySymbol||'RM'} ${value.toLocaleString(undefined,{minimumFractionDigits:Number(cfg.currencyDecimals??2),maximumFractionDigits:Number(cfg.currencyDecimals??2)})}`;}
function updateCurrencyLabels(){
 document.querySelectorAll('[data-currency-label]').forEach(el=>{el.textContent=`${el.dataset.currencyLabel} (${appSettings.currencyCode})`;});
 const step=(10**(-appSettings.currencyDecimals)).toString();
 for(const id of ['salePrice','quotationUnitPrice']){const el=document.getElementById(id);if(el)el.step=step;}
 for(const selector of ['#add input[name="selling_price"]','#editProduct input[name="selling_price"]']){const el=document.querySelector(selector);if(el)el.step=step;}
 if(typeof renderCart==='function')renderCart();if(typeof renderQuotationLines==='function')renderQuotationLines();
}
let toastTimer;
function notify(message, error=false) {
  const el=$('#toast'); el.textContent=message; el.className='visible'+(error?' error-toast':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{el.className='';},5500);
}
function problem(error){const s=String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,'');
  if(s.includes('UNIQUE constraint failed: products.sku')) return 'This SKU already exists. Please use a different SKU.';
  if(s.includes('UNIQUE constraint failed: users.username')) return 'That username is already registered.';
  return s;
}
// In-app delete dialog: Electron does not reliably implement window.prompt().
function confirmProductDeletion(product) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';
    overlay.innerHTML = `
      <form class="delete-dialog" aria-labelledby="deleteTitle">
        <h3 id="deleteTitle">Delete product</h3>
        <p class="delete-warning">Remove <strong class="delete-product-name"></strong> from the active inventory? This preserves transaction and invoice history but removes the item from stock lists.</p>
        <p class="delete-warning">Currently recorded units: <strong class="delete-quantity"></strong>. A deletion audit record will be saved.</p>
        <label>Reason for deletion (at least 3 characters)
          <textarea name="reason" required minlength="3" maxlength="500" rows="3" placeholder="For example: test product entered by mistake"></textarea>
        </label>
        <label>To confirm, type <strong class="delete-phrase"></strong>
          <input name="confirmation" required autocomplete="off" spellcheck="false" />
        </label>
        <p class="delete-inline-error" role="alert" aria-live="polite"></p>
        <div class="delete-buttons"><button type="button" class="outline" data-cancel>Cancel</button><button type="submit" class="delete-danger-button">Delete product</button></div>
      </form>`;
    const form=overlay.querySelector('form');
    overlay.querySelector('.delete-product-name').textContent=`${product.sku} — ${product.name}`;
    overlay.querySelector('.delete-quantity').textContent=String(product.quantity);
    const phrase=`DELETE ${product.sku}`;
    overlay.querySelector('.delete-phrase').textContent=phrase;
    const finish=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value);};
    const onKey=e=>{if(e.key==='Escape')finish(null);};
    document.addEventListener('keydown',onKey);
    overlay.querySelector('[data-cancel]').addEventListener('click',()=>finish(null));
    overlay.addEventListener('mousedown',e=>{if(e.target===overlay)finish(null);});
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const reason=form.elements.reason.value.trim();
      const typed=form.elements.confirmation.value;
      if(reason.length<3 || reason.length>500 || typed!==phrase){
        overlay.querySelector('.delete-inline-error').textContent=typed!==phrase?`Type ${phrase} exactly to continue.`:'Provide a reason between 3 and 500 characters.';
        return;
      }
      finish({reason});
    });
    document.body.append(overlay);
    form.elements.reason.focus();
  });
}
function cell(tr,value){let td=document.createElement('td');td.textContent=String(value??'');tr.append(td);return td;}
function closeMenu(){ $('#appView').classList.remove('menu-open'); $('#menuBackdrop')?.classList.remove('visible'); $('#menuBackdrop')?.classList.add('hidden'); $('#menuToggle')?.setAttribute('aria-expanded','false'); }
function openMenu(){ $('#appView').classList.add('menu-open'); $('#menuBackdrop')?.classList.remove('hidden'); $('#menuToggle')?.setAttribute('aria-expanded','true'); requestAnimationFrame(()=>$('#menuBackdrop')?.classList.add('visible')); }
function toggleMenu(){ $('#appView').classList.contains('menu-open') ? closeMenu() : openMenu(); }
function showPage(name){for(const page of document.querySelectorAll('.page'))page.classList.toggle('hidden',page.id!==name);
 for(const nav of document.querySelectorAll('.nav'))nav.classList.toggle('active',nav.dataset.page===name);
 updateCompanyHeader();
 if(name==='settings'&&canManage()){loadUsers();loadOwnerState();loadAppSettings().catch(e=>notify(problem(e),true));} if(['sales','reports','audit'].includes(name))loadExtra(name).catch(e=>notify(problem(e),true)); if(name==='documents')loadDocuments().catch(e=>notify(problem(e),true)); closeMenu();}
function theme(name){if(name==='light'||name==='burgundy'||!['modern-blue','midnight','emerald'].includes(name))name='modern-blue';document.documentElement.dataset.theme=name; document.body.dataset.theme=name;
 try{localStorage.setItem('ei-theme',name);}catch{} document.querySelectorAll('[data-theme-choice]').forEach(b=>b.classList.toggle('selected',b.dataset.themeChoice===name));}
function setView(isAuthenticated){
  const auth=$('#authView');
  const app=$('#appView');
  auth.hidden=Boolean(isAuthenticated);
  app.hidden=!isAuthenticated;
  auth.classList.toggle('hidden',Boolean(isAuthenticated));
  app.classList.toggle('hidden',!isAuthenticated);
  auth.style.display=isAuthenticated?'none':'grid';
  app.style.display=isAuthenticated?'block':'none';
  if(!isAuthenticated)closeMenu();
  window.scrollTo(0,0);
}
function enter(account){user=account;setView(true);
 $('#userChip').textContent=`${user.username} · ${{owner:'Owner',supervisor:'Supervisor',staff:'Staff'}[user.role]||user.role}`;
 const roleSelector=$('#newUser').elements.role;for(const option of roleSelector.options)option.disabled=false;roleSelector.value='staff';document.querySelectorAll('.manager-only').forEach(e=>e.classList.toggle('hidden',!canManage()));document.querySelectorAll('.owner-only').forEach(e=>e.classList.toggle('hidden',user.role!=='owner'));
 showPage('dashboard');loadCompany().catch(e=>notify(problem(e),true));loadAppSettings().catch(e=>notify(problem(e),true));refresh().catch(e=>notify(problem(e),true));}
async function state(){const r=await api.authState();if(r.user){enter(r.user);return;}
 setView(false);
 const setup=r.needsSetup;$('#authIntro').textContent=setup?'Create the Owner account for this computer.':'Sign in to your offline inventory workspace.';
 $('#authButton').textContent=setup?'Create Owner account':'Sign in';$('#authForm').dataset.setup=setup?'yes':'no';
 $('#authForm').elements.password.autocomplete=setup?'new-password':'current-password';}
$('#authForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,submit=$('#authButton');$('#authError').textContent='';submit.disabled=true;
 try{const data=Object.fromEntries(new FormData(form));const account=form.dataset.setup==='yes'?await api.setup(data):await api.login(data);form.reset();enter(account);}
 catch(err){$('#authError').textContent=problem(err);}finally{submit.disabled=false;}});
$('#signout').addEventListener('click',async()=>{await api.logout();user=null;await state();});
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
$('#openSalesFromInvoices').addEventListener('click',()=>showPage('sales'));
$('#menuToggle')?.addEventListener('click',toggleMenu); $('#menuClose')?.addEventListener('click',closeMenu); $('#menuBackdrop')?.addEventListener('click',closeMenu); document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeMenu(); });
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.go)));
document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>theme(b.dataset.themeChoice)));

function updateCompanyHeader(){
  $('#companyHeader').textContent=company.name||'Your Company';
  $('#companyHeader').title=company.name||'Set your company name in Settings';
  const logo=$('#headerLogo');logo.classList.toggle('hidden',!company.logo_data);if(company.logo_data)logo.src=company.logo_data;else logo.removeAttribute('src');
  const dashboardLogo=$('#dashboardLogo');dashboardLogo.classList.toggle('hidden',!company.logo_data);if(company.logo_data)dashboardLogo.src=company.logo_data;else dashboardLogo.removeAttribute('src');
}
async function loadCompany(){
  company=await api.company();
  updateCompanyHeader();
  const form=$('#companyForm');
  for(const field of ['name','registration','sst_registration','email','phone','address'])form.elements[field].value=company[field]||'';
  const isManager=canManage();
  for(const el of form.querySelectorAll('input,textarea'))el.disabled=!isManager;
  $('#companySave').classList.toggle('hidden',!isManager);
  $('#companyEditNote').classList.toggle('hidden',isManager);
  const preview=$('#logoPreview');preview.classList.toggle('hidden',!company.logo_data);$('#logoPlaceholder').classList.toggle('hidden',!!company.logo_data);if(company.logo_data)preview.src=company.logo_data;else preview.removeAttribute('src');
  $('#companyLogoInput').disabled=!isManager;$('#removeCompanyLogo').disabled=!isManager;
}
const currencyPresets={MYR:{symbol:'RM',decimals:2},USD:{symbol:'$',decimals:2},EUR:{symbol:'€',decimals:2},GBP:{symbol:'£',decimals:2},SGD:{symbol:'S$',decimals:2},AUD:{symbol:'A$',decimals:2},CAD:{symbol:'C$',decimals:2},CHF:{symbol:'CHF',decimals:2},CNY:{symbol:'¥',decimals:2},JPY:{symbol:'¥',decimals:0},KRW:{symbol:'₩',decimals:0},INR:{symbol:'₹',decimals:2},IDR:{symbol:'Rp',decimals:2},PHP:{symbol:'₱',decimals:2},VND:{symbol:'₫',decimals:0},THB:{symbol:'฿',decimals:2},BND:{symbol:'B$',decimals:2},AED:{symbol:'د.إ',decimals:2},SAR:{symbol:'﷼',decimals:2},NZD:{symbol:'NZ$',decimals:2},HKD:{symbol:'HK$',decimals:2},TWD:{symbol:'NT$',decimals:2},TRY:{symbol:'₺',decimals:2},BRL:{symbol:'R$',decimals:2},ZAR:{symbol:'R',decimals:2},BHD:{symbol:'BD',decimals:3},KWD:{symbol:'KD',decimals:3},OMR:{symbol:'OMR',decimals:3},JOD:{symbol:'JD',decimals:3},TND:{symbol:'DT',decimals:3}};
async function loadAppSettings(){
 appSettings=await api.settingsGet();
 if($('#currencyPreset')){$('#currencyPreset').value=currencyPresets[appSettings.currencyCode]?appSettings.currencyCode:'CUSTOM';$('#currencyCode').value=appSettings.currencyCode;$('#currencySymbol').value=appSettings.currencySymbol;$('#currencyDecimals').value=String(appSettings.currencyDecimals);for(const el of $('#currencyForm').querySelectorAll('input,select'))el.disabled=!canManage();$('#currencySave').classList.toggle('hidden',!canManage());}
 updateCurrencyLabels();
}
$('#currencyPreset').addEventListener('change',()=>{const code=$('#currencyPreset').value;if(currencyPresets[code]){$('#currencyCode').value=code;$('#currencySymbol').value=currencyPresets[code].symbol;$('#currencyDecimals').value=String(currencyPresets[code].decimals);}});
$('#currencyForm').addEventListener('submit',async e=>{e.preventDefault();if(!canManage())return;if(cart.length||quotationItems.length){notify('Complete the sales cart and save or clear the quotation draft before changing currency.',true);return;}const button=$('#currencySave');button.disabled=true;try{appSettings=await api.saveSettings({currencyCode:$('#currencyCode').value,currencySymbol:$('#currencySymbol').value,currencyDecimals:Number($('#currencyDecimals').value)});updateCurrencyLabels();await refresh();await Promise.all([loadExtra('sales'),loadDocuments()]);notify(`Currency updated to ${appSettings.currencyCode}`);}catch(err){notify(problem(err),true);}finally{button.disabled=false;}});
$('#companyForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!canManage())return;
  const form=e.currentTarget,button=$('#companySave');button.disabled=true;
  try{company=await api.saveCompany(Object.fromEntries(new FormData(form)));updateCompanyHeader();notify('Company details saved');}
  catch(error){notify(problem(error),true);}finally{button.disabled=false;}
});

$('#companyLogoInput').addEventListener('change',async e=>{
 const file=e.target.files?.[0];if(!file)return;
 if(!canManage()){notify('Supervisor or Owner permission required',true);return;}
 if(file.size>500000 || !['image/png','image/jpeg','image/webp'].includes(file.type)){notify('Use a PNG, JPEG or WebP image under 500 KB',true);e.target.value='';return;}
 try {const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
   await api.saveLogo(data);await loadCompany();notify('Company logo saved. It will appear in the header and draft invoices.');
 }catch(error){notify(problem(error),true);}finally{e.target.value='';}
});
$('#removeCompanyLogo').addEventListener('click',async()=>{
 if(!canManage() || !confirm('Remove the company logo from your profile and future invoice PDFs?'))return;
 try{await api.saveLogo(null);await loadCompany();notify('Company logo removed');}catch(error){notify(problem(error),true);}
});
function render(){const items=$('#items'),history=$('#history'),options=$('#productId');items.replaceChildren();history.replaceChildren();options.replaceChildren();
 for(const p of products){const tr=document.createElement('tr');for(const v of [p.sku,p.name,p.category,p.quantity,p.min_stock,cash(p.selling_price_cents)])cell(tr,v);
 const actions=document.createElement('td');
 if(canManage()){
  const actionGroup=document.createElement('div');actionGroup.className='product-actions';
  const edit=document.createElement('button');edit.type='button';edit.textContent='Edit';edit.className='outline product-edit';
  edit.addEventListener('click',()=>{const f=$('#editProduct');for(const k of ['id','sku','name','category','min_stock'])f.elements[k].value=p[k];f.elements.selling_price.value=(Number(p.selling_price_cents||0)/(10**appSettings.currencyDecimals)).toFixed(appSettings.currencyDecimals);showPage('inventory');f.scrollIntoView({behavior:'smooth'});});
  const archive=document.createElement('button');archive.type='button';archive.className='outline danger product-action product-availability';
  archive.textContent=p.archived?'Restore Product':'Mark Unavailable';
  archive.title=p.archived?'Restore product to inventory':'Hide product from active inventory (requires zero stock)';
  archive.addEventListener('click',async()=>{
    if(!p.archived && Number(p.quantity)!==0){notify(`Cannot mark ${p.sku} unavailable: ${p.quantity} units remain. Record a legitimate stock-out or adjustment first.`,true);return;}
    if(!confirm(p.archived?`Restore ${p.sku} to active inventory?`:`Mark ${p.sku} unavailable? This keeps the product record and transaction history.`))return;
    try{await api.archiveProduct({id:p.id});await refresh();notify(p.archived?'Product restored':'Product marked unavailable');}catch(e){notify(problem(e),true);}
  });
  const remove=document.createElement('button');remove.type='button';remove.className='outline danger product-action product-delete';remove.textContent='Delete Product';
  remove.title='Remove product from active inventory; preserve transaction and invoice history';
  remove.addEventListener('click',async()=>{
    const approval=await confirmProductDeletion(p);
    if(!approval)return;
    remove.disabled=true;
    try{
      await api.deleteProduct({id:p.id,reason:approval.reason});
      await refresh();
      notify(`${p.sku} deleted from active inventory. Its historical records are preserved.`);
    }catch(e){notify(problem(e),true);}finally{remove.disabled=false;}
  });actionGroup.append(edit,archive,remove);actions.append(actionGroup);
 } else {actions.textContent='Supervisor only';}
 tr.append(actions);
 const td=document.createElement('td'),badge=document.createElement('span');const low=p.quantity<=p.min_stock;
 badge.className='pill '+(low?'low':'ok');badge.textContent=p.archived?'Unavailable':low?'Low stock':'Healthy';td.append(badge);tr.append(td);items.append(tr);

 const o=document.createElement('option');o.value=p.id;o.disabled=Boolean(p.archived);o.textContent=`${p.sku} — ${p.name}`;options.append(o);}
 if(!products.length){let tr=document.createElement('tr');let td=cell(tr,'No products yet. Add your first item above.');td.colSpan=8;items.append(tr);}
 for(const m of movements){let tr=document.createElement('tr');for(const v of [m.created_at,`${m.sku} — ${m.name}`,m.type,m.quantity,m.note])cell(tr,v);history.append(tr);}
 const active=products.filter(p=>!p.archived);const low=active.filter(p=>p.quantity<=p.min_stock).length;$('#totalProducts').textContent=active.length;$('#totalUnits').textContent=active.reduce((a,p)=>a+p.quantity,0).toLocaleString();$('#lowCount').textContent=low;$('#movesCount').textContent=movements.length;
 $('#healthyStat').textContent=active.length-low;$('#lowStat').textContent=low;
 const gauge=$('#healthGauge'),healthy=active.length-low;
 const pct=active.length?Math.round(100*healthy/active.length):0;
 gauge.classList.toggle('no-data',!active.length);
 gauge.style.setProperty('--gauge-fill',`${pct}%`);
 $('#gaugePercent').textContent=active.length?`${pct}%`:'—';
 $('#gaugeSummary').textContent=active.length?`${healthy} healthy · ${low} low-stock product${low===1?'':'s'}`:'Register products to see stock health.';
 gauge.setAttribute('aria-label',active.length?`${pct}% of products have healthy stock, ${low} low stock`:'No inventory data yet');
 const activity=$('#activity');activity.replaceChildren();if(!movements.length){let p=document.createElement('p');p.textContent='No stock movements yet.';activity.append(p);}for(const m of movements.slice(0,5)){const row=document.createElement('div');row.className='activity-item';const info=document.createElement('div'),strong=document.createElement('strong'),time=document.createElement('small'),qty=document.createElement('span');strong.textContent=m.name;time.textContent=m.created_at+' UTC';qty.textContent=`${m.type==='IN'?'+':'−'}${m.quantity}`;qty.style.color=m.type==='IN'?'var(--success)':'var(--danger)';info.append(strong,time);row.append(info,qty);activity.append(row);}}
async function refresh(){[products,movements,invoices]=await Promise.all([api.products(),api.movements(),api.invoices()]);render();if(!$('#documents').classList.contains('hidden'))loadDocuments().catch(e=>notify(problem(e),true));}
$('#editProduct').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));data.id=Number(data.id);data.min_stock=Number(data.min_stock);try{await api.updateProduct(data);await refresh();notify('Product updated');}catch(err){notify(problem(err),true);}});
$('#search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const tr of $('#items').rows){tr.hidden=!tr.textContent.toLowerCase().includes(q);}});
$('#add').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
 try{const p=Object.fromEntries(new FormData(form));p.sku=p.sku.trim();p.name=p.name.trim();p.quantity=Number(p.quantity);p.min_stock=Number(p.min_stock);p.selling_price=Number(p.selling_price);if(!p.sku||!p.name||![p.quantity,p.min_stock].every(x=>Number.isSafeInteger(x)&&x>=0)||!Number.isFinite(p.selling_price)||p.selling_price<0)throw Error('Enter valid product details and non-negative whole quantities');
 await api.addProduct(p);form.reset();await refresh();notify('Product added successfully');}catch(err){notify(problem(err),true);}finally{btn.disabled=false;}});
$('#move').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
 try{const m=Object.fromEntries(new FormData(form));m.id=Number(m.id);m.quantity=Number(m.quantity);if(!Number.isSafeInteger(m.quantity)||m.quantity<1)throw Error('Enter a positive whole number');await api.moveStock(m);await refresh();notify('Stock movement saved');}catch(err){notify(problem(err),true);}finally{btn.disabled=false;}});
async function loadUsers(){try{let rows=await api.users();$('#users').replaceChildren();for(const x of rows){let tr=document.createElement('tr');for(const v of [x.username,({owner:'Owner',supervisor:'Supervisor',staff:'Staff'}[x.role]||x.role),x.created_at])cell(tr,v);$('#users').append(tr);}}catch(err){notify(problem(err),true);}}
$('#newUser').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;try{await api.createUser(Object.fromEntries(new FormData(form)));form.reset();await loadUsers();await loadOwnerState();notify('Account created');}catch(err){notify(problem(err),true);}finally{btn.disabled=false;}});
$('#backup').addEventListener('click',async()=>{try{const r=await api.backup();notify(r.canceled?'Backup canceled':'Backup saved successfully');}catch(err){notify(problem(err),true);}});
$('#restore').addEventListener('click',async()=>{try{const r=await api.restore();if(r.canceled){notify('Restore canceled');return;}user=null;await state();notify('Backup restored. Sign in again.');}catch(err){notify(problem(err),true);}});
theme((()=>{try{return localStorage.getItem('ei-theme')||'modern-blue'}catch{return'modern-blue'}})());state().catch(e=>notify(problem(e),true));

async function loadOwnerState(){
 try {
  const state=await api.ownerState();
  $('#supervisorLimit').value=state.maxSupervisors;
  $('#supervisorCountText').textContent=`Supervisor accounts: ${state.supervisorCount} of ${state.maxSupervisors} allowed`;
  $('#supervisorLimitForm').classList.toggle('hidden',!state.canEditLimit);
  $('#supervisorLimitReadOnly').classList.toggle('hidden',state.canEditLimit);
  $('#resetStockButton').disabled=state.supervisorCount===0;
 } catch(e){notify(problem(e),true);}
}
$('#supervisorLimitForm').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button');btn.disabled=true;
 try{const result=await api.saveSupervisorLimit({maxSupervisors:Number(form.elements.maxSupervisors.value)});$('#supervisorCountText').textContent=`Supervisor accounts: ${result.supervisorCount} of ${result.maxSupervisors} allowed`;notify('Supervisor account limit saved.');}
 catch(err){notify(problem(err),true);}finally{btn.disabled=false;}
});
$('#resetStock').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget,btn=$('#resetStockButton');
 const data=Object.fromEntries(new FormData(form));
 if(data.phrase!=='RESET ALL STOCK'){notify('Type RESET ALL STOCK exactly',true);return;}
 btn.disabled=true;
 try{
  const result=await api.resetAllStock(data);
  form.reset();
  if(result.canceled){notify('Stock reset canceled');return;}
  await refresh();
  notify(`Reset complete: ${result.affectedProducts} products, ${result.clearedUnits} units. Safety backup created.`);
 }catch(err){notify(problem(err),true);}finally{btn.disabled=false;}
});


// v0.3.0 — new independent sales, analytics, purchasing and audit panels.
let cart=[];
const optionFor=(select,value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);};
function fillProductSelect(id){const sel=$(id);sel.replaceChildren();for(const p of products.filter(p=>!p.deleted&&!p.archived))optionFor(sel,p.id,`${p.sku} — ${p.name} (${p.quantity} available · ${cash(p.selling_price_cents)} each)`);}
function renderCart(){const table=$('#cartLines');table.replaceChildren();let subtotal=0,taxTotal=0;for(const [index,line] of cart.entries()){
 const product=products.find(p=>Number(p.id)===line.productId);if(!product)continue;const tr=document.createElement('tr');const lineSubtotal=line.priceCents*line.quantity,lineTax=Math.round(lineSubtotal*line.taxRateBps/10000);subtotal+=lineSubtotal;taxTotal+=lineTax;
 for(const x of [product.name,line.quantity,cash(line.priceCents),`${(line.taxRateBps/100).toFixed(2)}%`,cash(lineSubtotal+lineTax)])cell(tr,x);
 const td=document.createElement('td');const b=document.createElement('button');b.textContent='Remove';b.className='outline';b.onclick=()=>{cart.splice(index,1);renderCart();};td.append(b);tr.append(td);table.append(tr);
 }$('#cartSubtotal').textContent=cash(subtotal);$('#cartTax').textContent=cash(taxTotal);$('#cartTotal').textContent=cash(subtotal+taxTotal);
}
$('#saleProduct').addEventListener('change',()=>{const product=products.find(p=>Number(p.id)===Number($('#saleProduct').value));$('#salePrice').value=product?(Number(product.selling_price_cents||0)/(10**appSettings.currencyDecimals)).toFixed(appSettings.currencyDecimals):'';});
$('#saleAddLine').addEventListener('submit',e=>{e.preventDefault();const id=Number($('#saleProduct').value),quantity=Number($('#saleQuantity').value),taxRate=Number($('#saleTaxRate').value),product=products.find(p=>Number(p.id)===id);
 if(!product||!Number.isSafeInteger(quantity)||quantity<1||quantity>product.quantity||!Number.isFinite(taxRate)||taxRate<0||taxRate>100||Math.abs(taxRate*100-Math.round(taxRate*100))>0.000001){notify('Check product, available stock, quantity and tax rate.',true);return;}
 if(cart.some(x=>x.productId===id)){notify('Product is already in the cart. Remove it to change quantity.',true);return;}
 cart.push({productId:id,quantity,priceCents:Number(product.selling_price_cents||0),taxRateBps:Math.round(taxRate*100)});renderCart();$('#saleQuantity').value=1;$('#saleTaxRate').value='0';});
function updateSaleCustomerType(){
 const type=$('#saleCustomerType').value,buyer=$('#saleBuyer');
 if(type==='walk-in'){buyer.required=false;buyer.placeholder='Optional for walk-in customer';}
 else{buyer.required=true;buyer.placeholder=type==='online'?'Online buyer / order name':'Customer / company name';if(buyer.value.trim().toLowerCase()==='walk-in customer')buyer.value='';}
}
$('#saleCustomerType').addEventListener('change',updateSaleCustomerType);updateSaleCustomerType();
$('#saleCheckout').addEventListener('click',async()=>{if(!cart.length){notify('Add products before checkout',true);return;}const customerType=$('#saleCustomerType').value;const buyer=$('#saleBuyer').value.trim()||(customerType==='walk-in'?'Walk-in customer':'');if(!buyer){notify('Enter buyer name for online or other customers',true);return;}
 if(!confirm(`Complete sale for ${buyer} (${customerTypeLabel(customerType)})? Stock will be deducted and this cannot be undone automatically.`))return;
 const button=$('#saleCheckout');button.disabled=true;try{const result=await api.createSale({buyer,address:$('#saleAddress').value,customerType,items:cart.map(line=>({productId:line.productId,quantity:line.quantity,taxRateBps:line.taxRateBps}))});cart=[];renderCart();await refresh();await loadExtra('sales');notify(`${result.number} saved · ${cash(result.total_cents)}. Open Invoices to export the commercial invoice PDF.`);}catch(err){notify(problem(err),true);}finally{button.disabled=false;}});

function customerTypeLabel(value){return ({'walk-in':'Walk-in','online':'Online','other':'Other'})[String(value||'other')]||'Other';}
function setDocumentTab(tab){
 const isInvoice=tab==='invoice';$('#invoicePanel').classList.toggle('hidden',!isInvoice);$('#quotationPanel').classList.toggle('hidden',isInvoice);
 document.querySelectorAll('[data-document-tab]').forEach(b=>{const active=b.dataset.documentTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
}
document.querySelectorAll('[data-document-tab]').forEach(b=>b.addEventListener('click',()=>setDocumentTab(b.dataset.documentTab)));
function renderSalesInvoices(){
 const body=$('#invoiceRegister');body.replaceChildren();
 const rows=[
  ...documentSales.map(sale=>({kind:'sale',id:sale.id,date:sale.created_at,number:'INV-'+String(sale.created_at||new Date().getFullYear()).slice(0,4)+'-'+String(sale.id).padStart(6,'0'),customer:sale.buyer_name,customerType:customerTypeLabel(sale.customer_type),source:'Sales & Checkout',items:`${sale.line_count} line(s)`,total:(sale.total_cents??sale.subtotal_cents),currency:{currencyCode:sale.currency_code||'MYR',currencySymbol:sale.currency_symbol||'RM',currencyDecimals:Number(sale.currency_decimals??2)}})),
  ...invoices.map(invoice=>({kind:'legacy',id:invoice.id,date:invoice.created_at,number:invoice.invoice_number,customer:invoice.buyer,customerType:'Legacy',source:'Legacy stock-out',items:`1 line · Qty ${invoice.quantity}`,total:invoice.unit_price_cents*invoice.quantity,currency:{currencyCode:'MYR',currencySymbol:'RM',currencyDecimals:2}}))
 ].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
 if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.textContent='No invoices yet. Create a sale through Sales & Checkout to generate your first invoice.';tr.append(td);body.append(tr);return;}
 for(const row of rows){
  const tr=document.createElement('tr');
  for(const value of [row.number,row.customer,row.customerType,row.source,row.items,cash(row.total,row.currency),row.date||'—'])cell(tr,value);
  const td=document.createElement('td'),button=document.createElement('button');button.className='outline';button.textContent='Export PDF';
  button.addEventListener('click',async()=>{button.disabled=true;try{const result=row.kind==='sale'?await api.salePDF(row.id):await api.invoicePDF(row.id);notify(result.canceled?'PDF export canceled':'Invoice PDF saved');}catch(error){notify(problem(error),true);}finally{button.disabled=false;}});
  td.append(button);tr.append(td);body.append(tr);
 }
}
function renderQuotationHistory(){const body=$('#quotationHistory');body.replaceChildren();for(const q of quotationHistory){const tr=document.createElement('tr');for(const value of [q.quotation_number,q.customer_name,customerTypeLabel(q.customer_type),q.quotation_date,q.valid_until,cash(q.total_cents,{currencyCode:q.currency_code||'MYR',currencySymbol:q.currency_symbol||'RM',currencyDecimals:Number(q.currency_decimals??2)})])cell(tr,value);const td=document.createElement('td'),button=document.createElement('button');button.className='outline';button.textContent='Export PDF';button.addEventListener('click',async()=>{button.disabled=true;try{const r=await api.quotationPDF(q.id);notify(r.canceled?'PDF export canceled':'Quotation PDF saved');}catch(e){notify(problem(e),true);}finally{button.disabled=false;}});td.append(button);tr.append(td);body.append(tr);}}
function renderQuotationLines(){const body=$('#quotationLines');body.replaceChildren();let subtotal=0,tax=0;for(const [index,item] of quotationItems.entries()){const base=Math.round(item.quantity*item.unitPriceCents),lineTax=Math.round(base*item.taxRateBps/10000);subtotal+=base;tax+=lineTax;const tr=document.createElement('tr');for(const value of [item.description,item.quantity.toLocaleString('en-MY',{maximumFractionDigits:3}),cash(item.unitPriceCents),(item.taxRateBps/100).toFixed(2)+'%',cash(base+lineTax)])cell(tr,value);const td=document.createElement('td'),remove=document.createElement('button');remove.type='button';remove.className='outline danger';remove.textContent='Remove';remove.addEventListener('click',()=>{quotationItems.splice(index,1);renderQuotationLines();});td.append(remove);tr.append(td);body.append(tr);}$('#quotationSubtotal').textContent=cash(subtotal);$('#quotationTax').textContent=cash(tax);$('#quotationTotal').textContent=cash(subtotal+tax);}
function clearQuotationDraft(){quotationItems=[];renderQuotationLines();$('#quotationForm').reset();$('#quotationProduct').value='';$('#quotationUnitPrice').value='';$('#quotationUnitPrice').readOnly=true;$('#quotationPriceLabel').textContent=`Unit price from Inventory (${appSettings.currencyCode})`;updateQuotationCustomerType();$('#quotationCustomerPhone').value='';$('#quotationCustomerEmail').value='';$('#quotationCustomerAddress').value='';setQuotationDates();}
function setQuotationDates(){const today=new Date();const localDate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;const date=localDate(today);const end=new Date(today.getFullYear(),today.getMonth(),today.getDate()+14);const expiry=localDate(end);$('#quotationDate').value=date;$('#quotationValidUntil').value=expiry;}
async function loadDocuments(){
 const [sales,quotes,legacyInvoices]=await Promise.all([api.sales(),api.quotations(),api.invoices()]);documentSales=sales;quotationHistory=quotes;invoices=legacyInvoices;renderSalesInvoices();renderQuotationHistory();
 const productSelect=$('#quotationProduct'),productValue=productSelect.value;productSelect.replaceChildren();optionFor(productSelect,'','Select an inventory product');for(const product of products.filter(p=>!p.deleted&&!p.archived))optionFor(productSelect,product.id,`${product.sku} — ${product.name} · ${product.quantity} available · ${cash(product.selling_price_cents)} each`);productSelect.value=productValue;if(productValue)$('#quotationProduct').dispatchEvent(new Event('change'));
 if(!$('#quotationDate').value)setQuotationDates();
}
function updateQuotationCustomerType(){
 const type=$('#quotationCustomerType').value,name=$('#quotationCustomerName');
 if(type==='walk-in'){
   name.required=false;name.placeholder='Walk-in customer';
   if(!name.value.trim())name.value='Walk-in customer';
 }else{
   name.required=true;name.placeholder=type==='online'?'Online buyer / order name':'Customer / company name';
   if(name.value.trim().toLowerCase()==='walk-in customer')name.value='';
 }
}
$('#quotationCustomerType').addEventListener('change',updateQuotationCustomerType);updateQuotationCustomerType();
$('#quotationProduct').addEventListener('change',()=>{const product=products.find(p=>Number(p.id)===Number($('#quotationProduct').value));const price=$('#quotationUnitPrice');price.readOnly=true;if(product){price.value=(Number(product.selling_price_cents||0)/(10**appSettings.currencyDecimals)).toFixed(appSettings.currencyDecimals);$('#quotationPriceLabel').textContent=`Unit price from Inventory (${appSettings.currencyCode})`;}else{price.value='';$('#quotationPriceLabel').textContent=`Unit price from Inventory (${appSettings.currencyCode})`;}});
$('#addQuotationItem').addEventListener('click',()=>{const productId=Number($('#quotationProduct').value),product=products.find(p=>Number(p.id)===productId);const quantity=Number($('#quotationQuantity').value),taxRate=Number($('#quotationTaxRate').value);
 if(!product){notify('Select an inventory product first.',true);return;}
 if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!Number.isFinite(taxRate)||taxRate<0||taxRate>100||Math.abs(taxRate*100-Math.round(taxRate*100))>0.000001){notify('Enter a whole-number quantity and a tax rate between 0 and 100%.',true);return;}
 if(quotationItems.some(item=>item.productId===productId)){notify('This product is already in the quotation. Remove its existing line to change the quantity.',true);return;}
 const unitPriceCents=Number(product.selling_price_cents||0);if(!Number.isSafeInteger(unitPriceCents)||unitPriceCents<0){notify('The selected inventory selling price is invalid. Update it in Inventory.',true);return;}
 quotationItems.push({productId,sku:product.sku,description:product.name,quantity,unitPrice:unitPriceCents/(10**appSettings.currencyDecimals),unitPriceCents,taxRateBps:Math.round(taxRate*100)});renderQuotationLines();$('#quotationProduct').value='';$('#quotationQuantity').value='1';$('#quotationUnitPrice').value='';$('#quotationTaxRate').value='0';});
$('#quotationForm').addEventListener('submit',async e=>{e.preventDefault();if(!quotationItems.length){notify('Add at least one quotation item before saving.',true);return;}const form=e.currentTarget,data=Object.fromEntries(new FormData(form));data.items=quotationItems.map(x=>({productId:x.productId,sku:x.sku,description:x.description,quantity:x.quantity,unitPrice:x.unitPriceCents/(10**appSettings.currencyDecimals),taxRate:x.taxRateBps/100}));data.customerType=data.customerType||'walk-in';const button=$('#saveQuotation');button.disabled=true;try{const result=await api.createQuotation(data);notify(`${result.number} saved successfully. Export its PDF from quotation history.`);clearQuotationDraft();await loadDocuments();}catch(err){notify(problem(err),true);}finally{button.disabled=false;}});
$('#clearQuotation').addEventListener('click',()=>{if(quotationItems.length||$('#quotationCustomerName').value){if(!confirm('Clear the current quotation draft?'))return;}clearQuotationDraft();});

for(const button of document.querySelectorAll('.report-export'))button.addEventListener('click',async()=>{try{const r=await api.exportReport(button.dataset.report);notify(r.canceled?'Export canceled':`CSV exported: ${r.count} records`);}catch(err){notify(problem(err),true);}});
async function loadExtra(name){
 if(name==='sales'){
   const sales=await api.sales();
   fillProductSelect('#saleProduct');$('#saleProduct').dispatchEvent(new Event('change'));const table=$('#salesHistory');table.replaceChildren();for(const s of sales){const tr=document.createElement('tr');for(const x of [s.number,s.buyer_name,customerTypeLabel(s.customer_type),s.line_count,cash(s.total_cents??s.subtotal_cents,{currencyCode:s.currency_code||'MYR',currencySymbol:s.currency_symbol||'RM',currencyDecimals:Number(s.currency_decimals??2)}),s.created_at])cell(tr,x);table.append(tr);}renderCart();
 }
 if(name==='reports'){
   const data=await api.analytics();$('#reportSales').textContent=data.orders.count;const revenue=$('#reportRevenue');revenue.replaceChildren();
   if(!data.revenueByCurrency.length){const empty=document.createElement('div');empty.className='revenue-empty';empty.textContent='No completed sales yet. Revenue will appear here after checkout.';revenue.append(empty);}
   for(const item of data.revenueByCurrency){const card=document.createElement('div');card.className='revenue-currency-card';const header=document.createElement('div');header.className='revenue-currency-header';const code=document.createElement('span');code.className='revenue-currency-code';code.textContent=item.currency_code;const count=document.createElement('span');count.className='revenue-currency-count';count.textContent=`${item.count} sale${Number(item.count)===1?'':'s'}`;header.append(code,count);const amount=document.createElement('strong');amount.className='revenue-currency-amount';amount.textContent=cash(item.cents,{currencyCode:item.currency_code,currencySymbol:item.currency_symbol,currencyDecimals:Number(item.currency_decimals)});const note=document.createElement('small');note.textContent=`${item.currency_symbol} · subtotal before tax`;card.append(header,amount,note);revenue.append(card);}
   const chart=$('#dailySales');chart.replaceChildren();const maxByCurrency={};for(const item of data.daily)maxByCurrency[item.currency_code]=Math.max(maxByCurrency[item.currency_code]||1,item.cents);for(const item of data.daily){const row=document.createElement('div');row.className='bar-row';const date=document.createElement('span');date.textContent=`${item.day} · ${item.currency_code}`;const track=document.createElement('div');track.className='bar-track';const bar=document.createElement('div');bar.className='bar-fill';bar.style.width=(100*item.cents/Math.max(1,maxByCurrency[item.currency_code]))+'%';track.append(bar);const amount=document.createElement('span');amount.textContent=cash(item.cents,{currencyCode:item.currency_code,currencySymbol:item.currency_symbol,currencyDecimals:Number(item.currency_decimals)});row.append(date,track,amount);chart.append(row);}
   if(!data.daily.length)chart.textContent='No sales recorded yet.';
   $('#topProducts').replaceChildren();for(const x of data.top){const row=document.createElement('tr');for(const v of [x.name,x.qty,cash(x.cents,{currencyCode:x.currency_code,currencySymbol:x.currency_symbol,currencyDecimals:Number(x.currency_decimals)})])cell(row,v);$('#topProducts').append(row);}
   $('#restockList').replaceChildren();for(const x of data.low){const row=document.createElement('tr');for(const v of [x.sku,x.name,x.quantity,x.min_stock])cell(row,v);$('#restockList').append(row);}
 }
 if(name==='audit'){const body=$('#auditRows');body.replaceChildren();if(user?.role!=='owner'){$('#auditAccessNote').classList.remove('hidden');return;}$('#auditAccessNote').classList.add('hidden');for(const x of await api.auditEvents()){const row=document.createElement('tr');for(const v of [x.created_at,x.actor,x.action,x.details])cell(row,v);body.append(row);}}
}
