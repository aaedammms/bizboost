const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, data) => ipcRenderer.invoke(name, data);
contextBridge.exposeInMainWorld('inventoryAPI', {
  settingsGet: () => invoke('settings:get'), saveSettings: data => invoke('settings:save',data),
  authState: () => invoke('auth:state'), setup: data => invoke('auth:setup',data),
  login: data => invoke('auth:login',data), logout: () => invoke('auth:logout'),
  company: () => invoke('company:get'), saveCompany: data => invoke('company:save',data), saveLogo: data => invoke('company:logo',data),
  users: () => invoke('users:list'), createUser: data => invoke('users:create',data),
  products: () => invoke('products:list'), addProduct: data => invoke('products:add',data),
  updateProduct: data => invoke('products:update',data), archiveProduct: data => invoke('products:archive',data), deleteProduct: data => invoke('products:delete',data),
  invoices: () => invoke('invoice:list'), createInvoice: data => invoke('invoice:create',data), invoicePDF: id => invoke('invoice:pdf',id),
  moveStock: data => invoke('stock:move',data), movements: () => invoke('movements:list'),
  ownerState: () => invoke('owner:state'), saveSupervisorLimit: data => invoke('owner:limits:save',data),
  resetAllStock: data => invoke('stock:reset-all',data),
  customers: () => invoke('customers:list'), addCustomer: data => invoke('customers:add',data),
  sales: () => invoke('sales:list'), createSale: data => invoke('sales:create',data), saleDetails: id => invoke('sales:detail',id), salePDF: id => invoke('sales:pdf',id),
  quotations: () => invoke('quotations:list'), createQuotation: data => invoke('quotations:create',data), quotationPDF: id => invoke('quotations:pdf',id),
  suppliers: () => invoke('suppliers:list'), addSupplier: data => invoke('suppliers:add',data),
  purchases: () => invoke('purchases:list'), createPurchase: data => invoke('purchases:create',data), receivePurchase: id => invoke('purchases:receive',id),
  analytics: () => invoke('analytics:summary'), exportReport: type => invoke('reports:export',type), auditEvents: () => invoke('audit:list'),
  backup: () => invoke('backup:create'), restore: () => invoke('backup:restore')
});
