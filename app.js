(() => {
const $ = s => document.querySelector(s);
const COUNTRIES = `US|United States|1;GB|United Kingdom|44;CA|Canada|1;AU|Australia|61;NZ|New Zealand|64;IE|Ireland|353;DE|Germany|49;FR|France|33;ES|Spain|34;IT|Italy|39;PT|Portugal|351;NL|Netherlands|31;BE|Belgium|32;CH|Switzerland|41;AT|Austria|43;SE|Sweden|46;NO|Norway|47;DK|Denmark|45;FI|Finland|358;PL|Poland|48;CZ|Czechia|420;RO|Romania|40;GR|Greece|30;TR|Turkey|90;UA|Ukraine|380;RU|Russia|7;KZ|Kazakhstan|7;AE|United Arab Emirates|971;SA|Saudi Arabia|966;QA|Qatar|974;KW|Kuwait|965;EG|Egypt|20;MA|Morocco|212;DZ|Algeria|213;TN|Tunisia|216;NG|Nigeria|234;GH|Ghana|233;KE|Kenya|254;UG|Uganda|256;TZ|Tanzania|255;ZA|South Africa|27;ET|Ethiopia|251;CM|Cameroon|237;SN|Senegal|221;CI|Côte d'Ivoire|225;IN|India|91;PK|Pakistan|92;BD|Bangladesh|880;LK|Sri Lanka|94;NP|Nepal|977;CN|China|86;HK|Hong Kong|852;JP|Japan|81;KR|South Korea|82;PH|Philippines|63;ID|Indonesia|62;MY|Malaysia|60;SG|Singapore|65;TH|Thailand|66;VN|Vietnam|84;BR|Brazil|55;AR|Argentina|54;CL|Chile|56;CO|Colombia|57;PE|Peru|51;MX|Mexico|52;VE|Venezuela|58;EC|Ecuador|593;UY|Uruguay|598;BO|Bolivia|591;PY|Paraguay|595`
  .split(';').map(s => { const [c, n, d] = s.split('|'); return { n, d, f: String.fromCodePoint(...[...c].map(x => 127397 + x.charCodeAt())) }; })
  .sort((a, b) => a.n.localeCompare(b.n));

const form = $('#form'), msg = $('#msg'), submit = $('#submit');
const country = $('#country'), dial = $('#dial');
country.innerHTML = '<option value="">Select country</option>' + COUNTRIES.map(c => `<option value="${c.n}" data-d="${c.d}">${c.f} ${c.n}</option>`).join('');
dial.innerHTML = COUNTRIES.map(c => `<option value="${c.d}" data-n="${c.n}">${c.f} +${c.d}</option>`).join('');
dial.value = '1';
country.addEventListener('change', () => { const o = country.selectedOptions[0]; if (o && o.dataset.d) dial.value = o.dataset.d; });

const api = async (url, opts = {}) => {
  const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: r.status, data });
  return data;
};
const digits = s => s.replace(/\D/g, '');
const setErr = (el, text) => { const s = el.closest('label')?.querySelector('.err'); if (s) s.textContent = text || ''; el.classList.toggle('bad', !!text); };

// ---------- Registration ----------
const validate = () => {
  const f = form.elements; let ok = true;
  const check = (el, bad, text) => { setErr(el, bad ? text : ''); if (bad) ok = false; };
  check(f.name, f.name.value.trim().length < 2, 'Enter your full name.');
  check(f.email, !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim()), 'Enter a valid email address.');
  check(f.country, !f.country.value, 'Select your country.');
  const pd = digits(f.phone.value);
  check(f.phone, !/^[\d\s\-()]+$/.test(f.phone.value) || pd.length < 5 || pd.length > 13, 'Enter a valid phone number.');
  check(f.telegram, !/^@?[A-Za-z0-9_]{5,32}$/.test(f.telegram.value.trim()), 'Use 5–32 letters, numbers or underscores.');
  const wd = digits(f.whatsapp.value);
  check(f.whatsapp, !/^\+?[\d\s\-()]+$/.test(f.whatsapp.value) || wd.length < 7 || wd.length > 15, 'Enter a valid WhatsApp number with country code.');
  $('#consentErr').textContent = f.consent.checked ? '' : 'You must accept the Privacy Policy.';
  if (!f.consent.checked) ok = false;
  return ok;
};
const show = (cls, text) => { msg.hidden = false; msg.className = cls; msg.textContent = text; };

let sending = false;
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (sending) return;
  msg.hidden = true;
  if (!validate()) return;
  sending = true; submit.disabled = true; submit.querySelector('.spin').hidden = false; submit.querySelector('.lbl').textContent = 'SUBMITTING…';
  const f = form.elements;
  try {
    await api('/api/apply', { method: 'POST', body: JSON.stringify({
      name: f.name.value, email: f.email.value, country: f.country.value,
      phone: `+${dial.value} ${f.phone.value.trim()}`, telegram: f.telegram.value, whatsapp: f.whatsapp.value, consent: f.consent.checked }) });
    form.reset(); dial.value = '1';
    show('ok', 'Congratulations! Your application has been submitted successfully. Our team will contact you soon.');
    submit.querySelector('.lbl').textContent = 'APPLICATION SUBMITTED';
    submit.disabled = true; sending = false; submit.querySelector('.spin').hidden = true;
    setTimeout(() => { submit.disabled = false; submit.querySelector('.lbl').textContent = 'SUBMIT APPLICATION'; }, 8000);
    return;
  } catch (err) {
    show('fail', err.message || 'Submission failed. Please try again.');
    if (err.data?.errors) for (const [k, v] of Object.entries(err.data.errors)) if (form.elements[k] && k !== 'consent') setErr(form.elements[k], v);
  }
  sending = false; submit.disabled = false; submit.querySelector('.spin').hidden = true; submit.querySelector('.lbl').textContent = 'SUBMIT APPLICATION';
});
form.addEventListener('input', e => { if (e.target.name && e.target.type !== 'checkbox') setErr(e.target, ''); });

// ---------- Admin ----------
const authBtn = $('#authBtn'), loginDlg = $('#loginDlg'), viewDlg = $('#viewDlg');
let loggedIn = false, timer;
const setMode = on => {
  loggedIn = on;
  $('#landing').hidden = on; $('#admin').hidden = !on;
  authBtn.textContent = on ? 'Logout' : 'Login';
  if (on) loadApps();
};
authBtn.addEventListener('click', async () => {
  if (loggedIn) { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); setMode(false); }
  else { $('#loginErr').textContent = ''; loginDlg.showModal(); }
});
$('#loginCancel').addEventListener('click', () => loginDlg.close());
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    f.password.value = ''; loginDlg.close(); setMode(true);
  } catch (err) { $('#loginErr').textContent = err.message; }
});

const qs = () => new URLSearchParams({ q: $('#q').value.trim(), country: $('#fCountry').value }).toString();
const fmt = iso => new Date(iso).toLocaleString();
async function loadApps() {
  try {
    const d = await api('/api/admin/applications?' + qs());
    $('#sTotal').textContent = d.total; $('#sToday').textContent = d.today;
    const sel = $('#fCountry'), cur = sel.value;
    sel.innerHTML = '<option value="">All countries</option>';
    d.countries.forEach(c => sel.add(new Option(c, c)));
    sel.value = d.countries.includes(cur) ? cur : '';
    const tb = $('#rows'); tb.textContent = '';
    d.rows.forEach(r => {
      const tr = tb.insertRow();
      [r.id, r.name, r.email, r.country, r.phone, '@' + r.telegram, r.whatsapp, fmt(r.created_at)].forEach(v => { tr.insertCell().textContent = v; });
      const td = tr.insertCell();
      const v = document.createElement('button'); v.className = 'btn btn-ghost'; v.textContent = 'View'; v.onclick = () => view(r);
      const x = document.createElement('button'); x.className = 'btn btn-ghost danger'; x.textContent = 'Delete'; x.onclick = () => del(r);
      td.append(v, x);
    });
    $('#empty').hidden = d.rows.length > 0;
  } catch (err) { if (err.status === 401) setMode(false); }
}
function view(r) {
  const dl = document.createElement('dl');
  [['ID', r.id], ['Name', r.name], ['Email', r.email], ['Country', r.country], ['Phone', r.phone], ['Telegram', '@' + r.telegram], ['WhatsApp', r.whatsapp], ['Date', fmt(r.created_at)]]
    .forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); });
  $('#viewBody').replaceChildren(dl); viewDlg.showModal();
}
$('#viewClose').addEventListener('click', () => viewDlg.close());
async function del(r) {
  if (!confirm(`Delete the application from ${r.name}? This cannot be undone.`)) return;
  try { await api('/api/admin/applications/' + r.id, { method: 'DELETE' }); loadApps(); } catch (err) { alert(err.message); }
}
$('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadApps, 250); });
$('#fCountry').addEventListener('change', loadApps);
$('#exportBtn').addEventListener('click', () => { location.href = '/api/admin/export?' + qs(); });

api('/api/admin/me').then(() => setMode(true)).catch(() => {});
})();
