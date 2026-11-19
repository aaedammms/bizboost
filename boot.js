(function(){
  try {
    var stored = localStorage.getItem('ei-theme');
    var t = stored || 'modern-blue';
    if (t === 'light' || t === 'burgundy') t = 'modern-blue';
    if (!['modern-blue', 'midnight', 'emerald'].includes(t)) t = 'modern-blue';
    document.documentElement.dataset.theme = t;
    document.addEventListener('DOMContentLoaded', function(){
      if (document.body) document.body.dataset.theme = t;
      try { localStorage.setItem('ei-theme', t); } catch (_) {}
    });
  } catch (e) {
    document.documentElement.dataset.theme = 'modern-blue';
    document.addEventListener('DOMContentLoaded', function(){
      if (document.body) document.body.dataset.theme = 'modern-blue';
    });
  }
})();
