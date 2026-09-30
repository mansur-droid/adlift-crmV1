import { supabase } from './supabaseClient';

const columns = [
  ['created_at', 'Submitted At'],
  ['first_name', 'First Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['brokerage', 'Brokerage'],
  ['city', 'City'],
  ['state', 'State'],
  ['average_home_price', 'Average Home Price'],
  ['target_buyer_type', 'Target Buyer Type'],
  ['target_price_range', 'Target Price Range'],
  ['target_areas', 'Target Areas'],
  ['current_acquisition_methods', 'Current Acquisition Methods'],
  ['current_monthly_buyer_volume', 'Current Monthly Buyer Volume'],
  ['currently_running_ads', 'Running Ads'],
  ['monthly_ad_budget', 'Monthly Ad Budget'],
  ['marketing_consent', 'Marketing Consent'],
  ['status', 'Status'],
];

let cache = [];
let loading = false;
let lastFetch = 0;
let deleting = false;

async function isAdmin() {
  const { data: { session }, error } = await supabase.auth.refreshSession();
  return !error && session?.user?.app_metadata?.role === 'admin';
}

function isSubmissionsActive() {
  return [...document.querySelectorAll('aside button.active')].some(
    (button) => button.textContent && button.textContent.trim().includes('Submissions'),
  );
}

function isAdminView() {
  return document.querySelector('aside .roleBadge')?.textContent?.trim().toLowerCase() === 'admin';
}

function formatValue(row, key) {
  const value = row[key];
  if (key === 'created_at') return value ? new Date(value).toLocaleString() : '-';
  if (key === 'marketing_consent') return value === true ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchAuditSubmissions(force = false) {
  const now = Date.now();
  if (loading || (!force && now - lastFetch < 2500)) return;
  loading = true;
  const { data, error } = await supabase
    .from('audit_requests')
    .select('id,created_at,first_name,email,phone,brokerage,city,state,average_home_price,target_buyer_type,target_price_range,target_areas,current_acquisition_methods,current_monthly_buyer_volume,currently_running_ads,monthly_ad_budget,marketing_consent,status')
    .order('created_at', { ascending: false });
  loading = false;
  lastFetch = Date.now();
  if (error) {
    console.error('Failed to load website audit submissions', error);
    renderError(error.message);
    return;
  }
  cache = data || [];
  renderAuditSubmissions();
}

function getSubmissionCard() {
  if (!isSubmissionsActive()) return null;
  return [...document.querySelectorAll('main section.card')].find(
    (section) => section.querySelector('.sectionTop h1')?.textContent?.trim() === 'Submissions',
  ) || null;
}

function renderError(message) {
  const card = getSubmissionCard();
  if (!card) return;
  const old = card.querySelector('#website-audit-submissions');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'website-audit-submissions';
  box.className = 'dataError';
  box.textContent = `Could not load website submissions: ${message}`;
  card.appendChild(box);
}

function showDeleteError(message) {
  const card = getSubmissionCard();
  if (!card) return;
  let box = card.querySelector('#submission-delete-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'submission-delete-error';
    box.className = 'dataError';
    card.querySelector('.search')?.before(box);
  }
  box.textContent = message;
}

async function deleteSubmissions(ids) {
  if (deleting || !ids.length || !(await isAdmin())) return;
  deleting = true;
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const { data, error } = await supabase.from('audit_requests').delete().in('id', batch).select('id');
      if (error) throw error;
      if (data?.length !== batch.length) throw new Error('Some submissions could not be deleted.');
    }
    getSubmissionCard()?.querySelector('#submission-delete-error')?.remove();
  } catch (error) {
    showDeleteError(`Could not delete submissions: ${error.message}`);
  } finally {
    deleting = false;
    await fetchAuditSubmissions(true);
  }
}

function renderAuditSubmissions() {
  const card = getSubmissionCard();
  if (!card) return;

  const actions = card.querySelector('.sectionActions');
  if (actions) actions.style.display = 'none';
  let deleteAll = card.querySelector('#delete-all-audit-submissions');
  if (!deleteAll) {
    deleteAll = document.createElement('button');
    deleteAll.id = 'delete-all-audit-submissions';
    deleteAll.type = 'button';
    deleteAll.className = 'danger';
    deleteAll.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg> Delete all';
    card.querySelector('.sectionTop')?.appendChild(deleteAll);
  }
  deleteAll.hidden = !cache.length || !isAdminView();
  deleteAll.disabled = deleting;

  const subtitle = card.querySelector('.sectionTop p');
  if (subtitle) subtitle.textContent = `${cache.length} website audit submission${cache.length === 1 ? '' : 's'}`;

  const searchInput = card.querySelector('.search input');
  if (searchInput) searchInput.placeholder = 'Search website audit submissions...';
  const search = (searchInput?.value || '').trim().toLowerCase();
  const rows = search
    ? cache.filter((row) => JSON.stringify(row).toLowerCase().includes(search))
    : cache;

  const builtInEmpty = card.querySelector(':scope > .empty');
  if (builtInEmpty) builtInEmpty.style.display = 'none';
  const builtInTable = card.querySelector(':scope > .tableWrap:not(#website-audit-submissions)');
  if (builtInTable) builtInTable.style.display = 'none';

  let container = card.querySelector('#website-audit-submissions');
  if (!container) {
    container = document.createElement('div');
    container.id = 'website-audit-submissions';
    card.appendChild(container);
  }

  if (!rows.length) {
    container.className = 'empty';
    container.textContent = cache.length ? 'No submissions match your search.' : 'No website audit submissions yet.';
    return;
  }

  container.className = 'tableWrap';
  container.innerHTML = `
    <table>
      <thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}${isAdminView() ? '<th class="audit-actions-column">Actions</th>' : ''}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(formatValue(row, key))}</td>`).join('')}${isAdminView() ? `<td class="audit-actions-column"><div class="actions"><button type="button" class="delete-audit-submission" data-id="${escapeHtml(row.id)}" aria-label="Delete submission from ${escapeHtml(row.first_name || row.email || 'unknown')}" title="Delete submission"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg></button></div></td>` : ''}</tr>`).join('')}</tbody>
    </table>`;
}

document.addEventListener('click', async (event) => {
  const rowButton = event.target.closest('.delete-audit-submission');
  const allButton = event.target.closest('#delete-all-audit-submissions');
  if (!rowButton && !allButton) return;
  if (rowButton) {
    const row = cache.find((item) => item.id === rowButton.dataset.id);
    if (row && window.confirm(`Delete the submission from ${row.first_name || row.email || 'this person'}? This cannot be undone.`)) {
      await deleteSubmissions([row.id]);
    }
  } else if (cache.length && window.confirm(`Delete all ${cache.length} website audit submissions? This cannot be undone.`)) {
    await deleteSubmissions(cache.map((row) => row.id));
  }
});

function update() {
  if (!isSubmissionsActive()) return;
  renderAuditSubmissions();
  fetchAuditSubmissions();
}

window.addEventListener('load', () => setTimeout(() => fetchAuditSubmissions(true), 300));
document.addEventListener('click', () => setTimeout(update, 250));
document.addEventListener('input', () => setTimeout(renderAuditSubmissions, 100));
setInterval(update, 2500);
