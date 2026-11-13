(() => {
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { status: r.status });
  return d;
};
const fmt = v => v ? new Date(v).toLocaleString() : '—';
const fail = e => { if (e.status === 401) location.reload(); else alert(e.message); };
const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn btn-ghost ' + cls; b.textContent = label; b.onclick = fn; return b; };
const badge = (t, c) => { const s = document.createElement('span'); s.className = 'badge ' + c; s.textContent = t; return s; };
const fill = (tb, rows, cols, actions) => {
  tb.textContent = '';
  rows.forEach(r => {
    const tr = tb.insertRow();
    cols.forEach(c => { const td = tr.insertCell(), v = c(r); v instanceof Node ? td.append(v) : (td.textContent = v); });
    tr.insertCell().append(...actions(r));
  });
};

// ----- tabs -----
const panels = { Apps: '#tabApps', Forms: '#tabForms', Users: '#tabUsers' };
const loaders = { Forms: loadForms, Users: loadUsers };
function tab(n) {
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === n));
  for (const k in panels) $(panels[k]).hidden = k !== n;
  if (loaders[n]) loaders[n]();
}
$$('.tab').forEach(b => { b.onclick = () => tab(b.dataset.tab); });
document.addEventListener('admin-mode', e => { if (e.detail) tab('Apps'); });

// ----- onboarding forms -----
async function loadForms() {
  try {
    const d = await api('/api/admin/forms?' + new URLSearchParams({ q: $('#fq').value.trim(), status: $('#fStatus').value }));
    fill($('#fRows'), d.rows,
      [r => r.id, r => r.full_name, r => r.user_id, r => r.country, r => r.mobile, r => r.payment_method, r => badge(r.status, r.status), r => fmt(r.submitted_at)],
      r => [btn('View', '', () => viewForm(r)), btn('Approve', '', () => setStatus(r, 'approved')), btn('Reject', 'danger', () => setStatus(r, 'rejected'))]);
    $('#fEmpty').hidden = d.rows.length > 0;
  } catch (e) { fail(e); }
}
function viewForm(r) {
  const dl = document.createElement('dl');
  [['User ID', r.user_id], ['Full name', r.full_name], ['Date of birth', r.dob], ['Country', r.country], ['City', r.city], ['Address', r.address],
   ['Mobile', r.mobile], ['WhatsApp', r.whatsapp], ['Telegram', '@' + r.telegram], ['Email', r.email], ['Payment method', r.payment_method], ['Payment numbers', (r.payment_numbers || []).map(x => `${x.method}: ${x.number}`).join(', ') || '—'], ['Reference name', r.reference_name || '—'],
   ['Reference', r.reference_info || '—'], ['Status', r.status], ['Submitted', fmt(r.submitted_at)], ['Reviewed', fmt(r.reviewed_at)]]
    .forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); });
  $('#viewBody').replaceChildren(dl); $('#viewDlg').showModal();
}
async function setStatus(r, status) {
  if (!confirm(`${status === 'approved' ? 'Approve' : 'Reject'} the application from ${r.full_name}?`)) return;
  try { await api('/api/admin/forms/' + r.id, { method: 'PATCH', body: JSON.stringify({ status }) }); loadForms(); } catch (e) { fail(e); }
}
let ft; $('#fq').addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(loadForms, 250); });
$('#fStatus').addEventListener('change', loadForms);

// ----- credentials -----
async function loadUsers() {
  try {
    const [d, apps] = await Promise.all([api('/api/admin/users'), api('/api/admin/applications')]);
    const sel = $('#uApp'), cur = sel.value;
    sel.innerHTML = '<option value="">No linked application</option>';
    apps.rows.forEach(a => sel.add(new Option(`#${a.id} ${a.name} (${a.email})`, a.id)));
    sel.value = cur;
    fill($('#uRows'), d.rows,
      [r => r.user_id, r => r.name, r => r.telegram ? '@' + r.telegram : '—', r => r.status ? badge(r.status, r.status) : 'No form yet',
       r => r.active ? badge('active', 'approved') : badge('disabled', 'off'), r => fmt(r.last_login)],
      r => [btn('New password', '', () => reset(r)), btn(r.active ? 'Disable' : 'Enable', '', () => toggle(r)), btn('Delete', 'danger', () => remove(r))]);
    $('#uEmpty').hidden = d.rows.length > 0;
  } catch (e) { fail(e); }
}
function cred(d) {
  const msg = `BC GAME WORLD – Applicant login\nLogin page: ${location.origin}/portal\nUser ID: ${d.userId}\nPassword: ${d.password}`;
  $('#credMsg').value = msg;
  const a = $('#credTg');
  a.href = d.telegram ? `https://t.me/${encodeURIComponent(d.telegram)}` : `https://t.me/share/url?url=${encodeURIComponent(location.origin + '/portal')}&text=${encodeURIComponent(msg)}`;
  a.textContent = d.telegram ? `Open Telegram (@${d.telegram})` : 'Send via Telegram';
  $('#credDlg').showModal();
}
const copy = () => { const t = $('#credMsg'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).catch(() => document.execCommand('copy')); };
$('#credCopy').onclick = () => { copy(); $('#credCopy').textContent = 'Copied'; setTimeout(() => { $('#credCopy').textContent = 'Copy message'; }, 1500); };
$('#credTg').addEventListener('click', copy);
$('#credClose').onclick = () => { $('#credMsg').value = ''; $('#credDlg').close(); };
$('#credDlg').addEventListener('close', () => { $('#credMsg').value = ''; });

$('#uGen').onclick = async () => {
  try {
    const d = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: $('#uName').value.trim(), application_id: $('#uApp').value || null }) });
    $('#uName').value = ''; $('#uApp').value = ''; cred(d); loadUsers();
  } catch (e) { fail(e); }
};
async function reset(r) {
  if (!confirm(`Generate a new password for ${r.user_id}? The old one stops working.`)) return;
  try { cred(await api(`/api/admin/users/${r.id}/reset`, { method: 'POST' })); } catch (e) { fail(e); }
}
async function toggle(r) {
  try { await api('/api/admin/users/' + r.id, { method: 'PATCH', body: JSON.stringify({ active: !r.active }) }); loadUsers(); } catch (e) { fail(e); }
}
async function remove(r) {
  if (!confirm(`Delete ${r.user_id} and any information they submitted? This cannot be undone.`)) return;
  try { await api('/api/admin/users/' + r.id, { method: 'DELETE' }); loadUsers(); } catch (e) { fail(e); }
}
})();
