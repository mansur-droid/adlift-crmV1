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

function isSubmissionsActive() {
  return [...document.querySelectorAll('aside button.active')].some(
    (button) => button.textContent && button.textContent.trim().includes('Submissions'),
  );
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
    .select('created_at,first_name,email,phone,brokerage,city,state,average_home_price,target_buyer_type,target_price_range,target_areas,current_acquisition_methods,current_monthly_buyer_volume,currently_running_ads,monthly_ad_budget,marketing_consent,status')
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

function renderAuditSubmissions() {
  const card = getSubmissionCard();
  if (!card) return;

  const actions = card.querySelector('.sectionActions');
  if (actions) actions.style.display = 'none';

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
      <thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(formatValue(row, key))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

function update() {
  if (!isSubmissionsActive()) return;
  renderAuditSubmissions();
  fetchAuditSubmissions();
}

window.addEventListener('load', () => setTimeout(() => fetchAuditSubmissions(true), 300));
document.addEventListener('click', () => setTimeout(update, 250));
document.addEventListener('input', () => setTimeout(renderAuditSubmissions, 100));
setInterval(update, 2500);
