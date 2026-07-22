const scanView = document.getElementById('scan-view');
const loadingView = document.getElementById('loading-view');
const reviewView = document.getElementById('review-view');
const scanBtn = document.getElementById('scan-btn');
const fileInput = document.getElementById('file-input');
const reviewForm = document.getElementById('review-form');
const confidenceBadge = document.getElementById('confidence-badge');
const confidenceHelp = document.getElementById('confidence-help');
const resultBanner = document.getElementById('result-banner');
const vcfBtn = document.getElementById('vcf-btn');
const rescanBtn = document.getElementById('rescan-btn');
const saveBtn = document.getElementById('save-btn');

let lastContact = null;

function showView(view) {
  for (const v of [scanView, loadingView, reviewView]) v.classList.add('hidden');
  view.classList.remove('hidden');
}

// ---------- passcode-aware fetch wrapper ----------
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const passcode = localStorage.getItem('passcode');
  if (passcode) headers['x-passcode'] = passcode;

  let resp = await fetch(path, { ...options, headers });

  if (resp.status === 401) {
    const entered = window.prompt('Enter access passcode:');
    if (entered) {
      localStorage.setItem('passcode', entered);
      headers['x-passcode'] = entered;
      resp = await fetch(path, { ...options, headers });
    }
  }

  return resp;
}

// ---------- scan button ----------
scanBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;

  showView(loadingView);

  try {
    const { base64, mediaType } = await downscaleImage(file);
    const resp = await api('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Scan failed');

    populateForm(data.contact);
    showView(reviewView);
  } catch (err) {
    alert('Scan failed: ' + err.message);
    showView(scanView);
  }
});

// ---------- client-side downscale ----------
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onerror = reject;

    img.onload = () => {
      const maxEdge = 1568;
      let { width, height } = img;
      if (width > height && width > maxEdge) {
        height = Math.round((height * maxEdge) / width);
        width = maxEdge;
      } else if (height >= width && height > maxEdge) {
        width = Math.round((width * maxEdge) / height);
        height = maxEdge;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, mediaType: 'image/jpeg' });
    };

    reader.readAsDataURL(file);
  });
}

// ---------- review form ----------
const FORM_FIELDS = [
  'first_name', 'last_name', 'job_title', 'company', 'email',
  'phone', 'phone_work', 'website', 'address', 'notes',
];

function populateForm(contact) {
  for (const field of FORM_FIELDS) {
    document.getElementById(field).value = contact[field] || '';
  }
  document.getElementById('my_note').value = '';

  const confidence = contact.confidence || 'low';
  confidenceBadge.textContent =
    confidence === 'high' ? '✅ High confidence'
    : confidence === 'medium' ? '⚠️ Medium confidence'
    : '❗ Low confidence';
  confidenceBadge.className = `confidence-badge confidence-${confidence}`;

  confidenceHelp.textContent =
    confidence === 'high' ? 'Looks solid — a quick glance should do.'
    : confidence === 'medium' ? 'Double-check the fields below before saving.'
    : 'The photo was hard to read — please verify every field.';

  resultBanner.className = 'result-banner hidden';
  vcfBtn.classList.add('hidden');
}

function readForm() {
  const contact = {};
  for (const field of FORM_FIELDS) {
    contact[field] = document.getElementById(field).value.trim() || null;
  }
  contact.my_note = document.getElementById('my_note').value.trim() || null;
  return contact;
}

rescanBtn.addEventListener('click', () => {
  lastContact = null;
  showView(scanView);
});

reviewForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const contact = readForm();
  lastContact = contact;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  resultBanner.className = 'result-banner hidden';
  vcfBtn.classList.add('hidden');

  try {
    const resp = await api('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');

    const hubspot = data.hubspot || {};
    let message = '';

    if (hubspot.note) {
      message = hubspot.note;
      resultBanner.classList.add('result-info');
      downloadVcf(contact);
    } else if (hubspot.created) {
      message = '✅ Saved as a new HubSpot contact.';
      resultBanner.classList.add('result-success');
      downloadVcf(contact);
    } else {
      message = `ℹ️ Already in HubSpot (matched by ${hubspot.matchedBy}) — updated, no duplicate created.`;
      resultBanner.classList.add('result-info');
      vcfBtn.classList.remove('hidden');
    }

    if (hubspot.noteAdded) {
      message += ' 📝 Note added to their HubSpot timeline.';
    }

    resultBanner.textContent = message;
    resultBanner.classList.remove('hidden');
  } catch (err) {
    resultBanner.textContent = '❌ ' + err.message;
    resultBanner.className = 'result-banner result-error';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save contact';
  }
});

vcfBtn.addEventListener('click', () => {
  if (lastContact) downloadVcf(lastContact);
});

// ---------- .vcf builder ----------
function escapeVcf(value) {
  if (!value) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function downloadVcf(contact) {
  const first = contact.first_name || '';
  const last = contact.last_name || '';
  const noteParts = [contact.my_note, contact.notes].filter(Boolean);
  const combinedNote = noteParts.join(' — ');

  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`N:${escapeVcf(last)};${escapeVcf(first)};;;`);
  lines.push(`FN:${escapeVcf([first, last].filter(Boolean).join(' '))}`);
  if (contact.company) lines.push(`ORG:${escapeVcf(contact.company)}`);
  if (contact.job_title) lines.push(`TITLE:${escapeVcf(contact.job_title)}`);
  if (contact.phone) lines.push(`TEL;TYPE=CELL:${escapeVcf(contact.phone)}`);
  if (contact.phone_work) lines.push(`TEL;TYPE=WORK:${escapeVcf(contact.phone_work)}`);
  if (contact.email) lines.push(`EMAIL;TYPE=WORK:${escapeVcf(contact.email)}`);
  if (contact.website) lines.push(`URL:${escapeVcf(contact.website)}`);
  if (contact.address) lines.push(`ADR;TYPE=WORK:;;${escapeVcf(contact.address)};;;;`);
  if (combinedNote) lines.push(`NOTE:${escapeVcf(combinedNote)}`);
  lines.push('END:VCARD');

  const vcfText = lines.join('\r\n');
  const blob = new Blob([vcfText], { type: 'text/vcard' });
  const url = URL.createObjectURL(blob);

  const filenameBase = [first, last].filter(Boolean).join('_') || 'contact';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
