(() => {
const $ = s => document.querySelector(s);
const COUNTRIES = `US|United States|1;GB|United Kingdom|44;CA|Canada|1;AU|Australia|61;NZ|New Zealand|64;IE|Ireland|353;DE|Germany|49;FR|France|33;ES|Spain|34;IT|Italy|39;PT|Portugal|351;NL|Netherlands|31;BE|Belgium|32;CH|Switzerland|41;AT|Austria|43;SE|Sweden|46;NO|Norway|47;DK|Denmark|45;FI|Finland|358;PL|Poland|48;CZ|Czechia|420;RO|Romania|40;GR|Greece|30;TR|Turkey|90;UA|Ukraine|380;RU|Russia|7;KZ|Kazakhstan|7;AE|United Arab Emirates|971;SA|Saudi Arabia|966;QA|Qatar|974;KW|Kuwait|965;EG|Egypt|20;MA|Morocco|212;DZ|Algeria|213;TN|Tunisia|216;NG|Nigeria|234;GH|Ghana|233;KE|Kenya|254;UG|Uganda|256;TZ|Tanzania|255;ZA|South Africa|27;ET|Ethiopia|251;CM|Cameroon|237;SN|Senegal|221;CI|Côte d'Ivoire|225;IN|India|91;PK|Pakistan|92;BD|Bangladesh|880;LK|Sri Lanka|94;NP|Nepal|977;CN|China|86;HK|Hong Kong|852;JP|Japan|81;KR|South Korea|82;PH|Philippines|63;ID|Indonesia|62;MY|Malaysia|60;SG|Singapore|65;TH|Thailand|66;VN|Vietnam|84;BR|Brazil|55;AR|Argentina|54;CL|Chile|56;CO|Colombia|57;PE|Peru|51;MX|Mexico|52;VE|Venezuela|58;EC|Ecuador|593;UY|Uruguay|598;BO|Bolivia|591;PY|Paraguay|595`.split(';').map(s => { const [c, n] = s.split('|'); return { n, f: String.fromCodePoint(...[...c].map(x => 127397 + x.charCodeAt())) }; }).sort((a, b) => a.n.localeCompare(b.n));
const STATUS = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected' };
const f = $('#pf'), country = $('#country'), pay = $('#payment'), pmsg = $('#pmsg');
let payments = {}, wallets = [], numStore = {}, locked = false;

country.innerHTML = '<option value="">Select country</option>' + COUNTRIES.map(c => `<option value="${c.n}">${c.f} ${c.n}</option>`).join('');
const fillPay = sel => {
  const list = payments[country.value] || payments.default || [];
  pay.innerHTML = '<option value="">Select payment method</option>' + list.map(p => `<option value="${p}">${p}</option>`).join('');
  if (sel && list.includes(sel)) pay.value = sel;
  renderNums();
};
country.addEventListener('change', () => fillPay());

pay.addEventListener('change', () => renderNums());
function renderNums() {
  const m = pay.value, on = wallets.includes(m);
  $('#numBox').hidden = !on;
  if (!on) return;
  $('#numLegend').textContent = `${m} numbers`;
  const arr = numStore[m] = numStore[m] && numStore[m].length ? numStore[m] : [''];
  const list = $('#numList'); list.textContent = '';
  arr.forEach((v, i) => {
    const row = document.createElement('div'); row.className = 'numrow';
    const inp = document.createElement('input');
    inp.type = 'tel'; inp.inputMode = 'tel'; inp.maxLength = 30; inp.value = v; inp.disabled = locked;
    inp.placeholder = `${m} number (+880…)`; inp.setAttribute('aria-label', `${m} number ${i + 1}`);
    inp.oninput = () => { arr[i] = inp.value; $('#numErr').textContent = ''; };
    row.append(inp);
    if (arr.length > 1 && !locked) {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'btn btn-ghost danger'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove number');
      x.onclick = () => { arr.splice(i, 1); renderNums(); };
      row.append(x);
    }
    list.append(row);
  });
  $('#numAdd').hidden = locked || arr.length >= 5;
}
$('#numAdd').onclick = () => { (numStore[pay.value] ||= ['']).push(''); renderNums(); };

const api = async (url, opts = {}) => {
  const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { status: r.status, data: d });
  return d;
};
const show = (el, cls, t) => { el.hidden = false; el.className = 'msg ' + cls; el.textContent = t; };
const setErr = (el, t) => { const s = el.closest('label')?.querySelector('.err'); if (s) s.textContent = t || ''; el.classList.toggle('bad', !!t); };

function setStatus(st) {
  const b = $('#stBadge'); b.textContent = STATUS[st] || ''; b.className = 'badge ' + (st || 'pending'); b.hidden = !st;
  const n = $('#stNote');
  locked = st === 'approved';
  [...f.elements].forEach(e => { e.disabled = locked; });
  $('#pbtn').hidden = locked;
  renderNums();
  if (st === 'approved') show(n, 'ok', 'Your application has been approved. Your information is locked.');
  else if (st === 'rejected') show(n, 'fail', 'Your application was not approved. Please review your details and submit again.');
  else if (st === 'pending') show(n, 'info', 'Your information has been submitted and is waiting for review. You can update it until it is approved.');
  else n.hidden = true;
}
function enter(me) {
  payments = me.payments; wallets = me.walletMethods || [];
  $('#loginCard').hidden = true; $('#formCard').hidden = false; $('#outBtn').hidden = false;
  $('#whoLine').textContent = `Signed in as ${me.userId}`;
  const d = me.form || {};
  numStore = {}; (d.paymentNumbers || []).forEach(x => { (numStore[x.method] ||= []).push(x.number); });
  ['fullName', 'dob', 'country', 'city', 'address', 'mobile', 'whatsapp', 'telegram', 'email', 'reference', 'referenceName'].forEach(k => { f.elements[k].value = d[k] || ''; });
  if (!d.fullName) f.elements.fullName.value = me.name || '';
  fillPay(d.payment);
  setStatus(d.status || null);
}
function leave() {
  $('#formCard').hidden = true; $('#loginCard').hidden = false; $('#outBtn').hidden = true;
  f.reset(); numStore = {}; renderNums(); $('#lf').reset(); $('#lmsg').hidden = true; pmsg.hidden = true;
}

$('#lf').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#lbtn'); btn.disabled = true;
  try {
    await api('/api/user/login', { method: 'POST', body: JSON.stringify({ userId: e.target.uid.value, password: e.target.pw.value }) });
    e.target.pw.value = '';
    enter(await api('/api/user/me'));
  } catch (err) { show($('#lmsg'), 'fail', err.message); }
  btn.disabled = false;
});
$('#outBtn').addEventListener('click', async () => { await api('/api/user/logout', { method: 'POST' }).catch(() => {}); leave(); });

function validate() {
  let ok = true;
  const v = k => f.elements[k].value.trim();
  const chk = (k, bad, t) => { setErr(f.elements[k], bad ? t : ''); if (bad) ok = false; };
  const ph = k => { const s = v(k), n = s.replace(/\D/g, ''); return !/^\+?[\d\s\-()]+$/.test(s) || n.length < 7 || n.length > 15; };
  const t = new Date(), p2 = n => String(n).padStart(2, '0');
  const min = `${t.getFullYear() - 18}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  chk('fullName', v('fullName').length < 2, 'Enter your full name.');
  chk('dob', !v('dob') || v('dob') > min, 'Enter a valid date of birth (18+).');
  chk('country', !v('country'), 'Select your country.');
  chk('city', v('city').length < 2, 'Enter your city.');
  chk('address', v('address').length < 5, 'Enter your full address.');
  chk('mobile', ph('mobile'), 'Enter a valid number with country code.');
  chk('whatsapp', ph('whatsapp'), 'Enter a valid number with country code.');
  chk('telegram', !/^@?[A-Za-z0-9_]{5,32}$/.test(v('telegram')), 'Use 5–32 letters, numbers or underscores.');
  chk('email', !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email')), 'Enter a valid email address.');
  chk('payment', !v('payment'), 'Select a payment method.');
  if (!$('#numBox').hidden) {
    const m = pay.value, arr = (numStore[m] || []).map(x => x.trim()).filter(Boolean);
    const badN = !arr.length ? `Add at least one ${m} number.`
      : arr.some(n => !/^\+?[\d\s\-()]+$/.test(n) || n.replace(/\D/g, '').length < 7 || n.replace(/\D/g, '').length > 15) ? 'Enter valid numbers with country code.' : '';
    $('#numErr').textContent = badN; if (badN) ok = false;
  }
  $('#consentErr').textContent = f.elements.consent.checked ? '' : 'Please confirm to continue.';
  return ok && f.elements.consent.checked;
}
let sending = false;
f.addEventListener('submit', async e => {
  e.preventDefault();
  if (sending || locked) return;
  pmsg.hidden = true;
  if (!validate()) return;
  sending = true; const btn = $('#pbtn'); btn.disabled = true; btn.textContent = 'SUBMITTING…';
  const body = {}; ['fullName', 'dob', 'country', 'city', 'address', 'mobile', 'whatsapp', 'telegram', 'email', 'payment', 'reference', 'referenceName'].forEach(k => { body[k] = f.elements[k].value; });
  body.consent = f.elements.consent.checked;
  body.paymentNumbers = wallets.includes(pay.value) ? (numStore[pay.value] || []).map(x => x.trim()).filter(Boolean) : [];
  try {
    await api('/api/user/form', { method: 'PUT', body: JSON.stringify(body) });
    setStatus('pending'); show(pmsg, 'ok', 'Your information has been submitted successfully.');
  } catch (err) {
    if (err.status === 401) { leave(); show($('#lmsg'), 'fail', 'Your session has ended. Please log in again.'); }
    else {
      show(pmsg, 'fail', err.message);
      for (const [k, m] of Object.entries(err.data?.errors || {})) { if (k === 'paymentNumbers') $('#numErr').textContent = m; else if (f.elements[k] && k !== 'consent') setErr(f.elements[k], m); }
    }
  }
  sending = false; btn.disabled = false; btn.textContent = 'SUBMIT INFORMATION';
});
f.addEventListener('input', e => { if (e.target.name && e.target.type !== 'checkbox') setErr(e.target, ''); });

api('/api/user/me').then(enter).catch(() => {});
})();
