import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '15mb' }));

const {
  GEMINI_API_KEY,
  ANTHROPIC_API_KEY,
  HUBSPOT_ACCESS_TOKEN,
  CUSTOM_CRM_WEBHOOK_URL,
  CUSTOM_CRM_API_KEY,
  APP_PASSCODE,
  PORT,
} = process.env;

// ---------- passcode gate ----------
app.use('/api', (req, res, next) => {
  if (!APP_PASSCODE) return next();
  if (req.get('x-passcode') === APP_PASSCODE) return next();
  return res.status(401).json({ error: 'passcode required' });
});

// ---------- static frontend ----------
app.use(express.static('public'));

// ---------- scan schema ----------
const CONTACT_FIELDS = [
  'first_name', 'last_name', 'job_title', 'company', 'email',
  'phone', 'phone_work', 'website', 'address', 'notes',
];

const SCAN_PROMPT =
  'This is a photo of a business card. Extract the contact information. ' +
  'Use null for any field not present on the card. Format phone numbers with their ' +
  'country code if shown.';

function geminiSchema() {
  const properties = {};
  for (const f of CONTACT_FIELDS) {
    properties[f] = { type: 'string', nullable: true };
  }
  properties.confidence = { type: 'string', enum: ['high', 'medium', 'low'] };
  return {
    type: 'object',
    properties,
    required: [...CONTACT_FIELDS, 'confidence'],
  };
}

function anthropicSchema() {
  const properties = {};
  for (const f of CONTACT_FIELDS) {
    properties[f] = { type: ['string', 'null'] };
  }
  properties.confidence = { type: 'string', enum: ['high', 'medium', 'low'] };
  return {
    type: 'object',
    properties,
    required: [...CONTACT_FIELDS, 'confidence'],
  };
}

async function scanWithGemini(image, mediaType) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mediaType, data: image } },
          { text: SCAN_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(),
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}

async function scanWithAnthropic(image, mediaType) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: SCAN_PROMPT },
        ],
      },
    ],
    output_config: {
      type: 'json_schema',
      schema: anthropicSchema(),
    },
  });

  const block = resp.content?.find((c) => c.type === 'text' || c.type === 'output_json');
  const raw = block?.type === 'output_json' ? block.json : JSON.parse(block.text);
  return raw;
}

app.post('/api/scan', async (req, res) => {
  try {
    const { image, mediaType } = req.body || {};
    if (!image || !mediaType) {
      return res.status(400).json({ error: 'image and mediaType are required' });
    }

    let contact;
    if (GEMINI_API_KEY) {
      contact = await scanWithGemini(image, mediaType);
    } else if (ANTHROPIC_API_KEY) {
      contact = await scanWithAnthropic(image, mediaType);
    } else {
      return res.status(500).json({ error: 'No scanner configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.' });
    }

    res.json({ contact });
  } catch (err) {
    console.error('scan error', err);
    res.status(500).json({ error: err.message || 'scan failed' });
  }
});

// ---------- HubSpot helpers ----------
const HUBSPOT_BASE = 'https://api.hubapi.com';

function hubspotHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  };
}

function digitsOnly(phone) {
  return (phone || '').replace(/\D/g, '');
}

async function hubspotSearch(filterGroups) {
  const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      filterGroups,
      properties: ['firstname', 'lastname', 'email', 'phone', 'company'],
      limit: 10,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HubSpot search error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.results || [];
}

async function findExistingContact(contact) {
  // 1. email match
  if (contact.email) {
    const results = await hubspotSearch([
      {
        filters: [
          { propertyName: 'email', operator: 'EQ', value: contact.email.toLowerCase() },
        ],
      },
    ]);
    if (results.length > 0) return { match: results[0], matchedBy: 'email' };
  }

  // 2. phone match (digits only, check phone and phone_work against candidates)
  const cardPhones = [contact.phone, contact.phone_work].filter(Boolean).map(digitsOnly).filter(Boolean);
  if (cardPhones.length > 0) {
    // HubSpot search can't do "contains digits" cleanly, so pull candidates by
    // searching CONTAINS_TOKEN on last few digits, then verify locally.
    for (const cardPhone of cardPhones) {
      const suffix = cardPhone.slice(-7);
      if (!suffix) continue;
      const results = await hubspotSearch([
        { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: suffix }] },
      ]);
      const match = results.find((r) => {
        const hsPhone = digitsOnly(r.properties.phone);
        return hsPhone && cardPhones.some((cp) => cp.endsWith(hsPhone.slice(-9)) || hsPhone.endsWith(cp.slice(-9)));
      });
      if (match) return { match, matchedBy: 'phone' };
    }
  }

  // 3. first_name + last_name exact
  if (contact.first_name && contact.last_name) {
    const results = await hubspotSearch([
      {
        filters: [
          { propertyName: 'firstname', operator: 'EQ', value: contact.first_name },
          { propertyName: 'lastname', operator: 'EQ', value: contact.last_name },
        ],
      },
    ]);
    if (results.length > 0) {
      const cardPhone = cardPhones[0];
      for (const candidate of results) {
        const hsPhone = digitsOnly(candidate.properties.phone);
        if (cardPhone && hsPhone) {
          // Both have a phone: only match if trailing 9 digits agree.
          if (cardPhone.slice(-9) === hsPhone.slice(-9)) {
            return { match: candidate, matchedBy: 'name' };
          }
        } else {
          // At least one side has no phone to disambiguate with; accept name match.
          return { match: candidate, matchedBy: 'name' };
        }
      }
    }
  }

  return { match: null, matchedBy: null };
}

function buildHubspotProps(contact) {
  const mapping = {
    first_name: 'firstname',
    last_name: 'lastname',
    email: 'email',
    phone: 'phone',
    company: 'company',
    job_title: 'jobtitle',
    website: 'website',
    address: 'address',
  };
  const props = {};
  for (const [field, hsProp] of Object.entries(mapping)) {
    const value = contact[field];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      props[hsProp] = value;
    }
  }
  return props;
}

async function saveToHubspot(contact) {
  const { match, matchedBy } = await findExistingContact(contact);
  const props = buildHubspotProps(contact);

  let contactId;
  let created;

  if (match) {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${match.id}`, {
      method: 'PATCH',
      headers: hubspotHeaders(),
      body: JSON.stringify({ properties: props }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HubSpot update error ${resp.status}: ${text}`);
    }
    contactId = match.id;
    created = false;
  } else {
    const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: hubspotHeaders(),
      body: JSON.stringify({ properties: props }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HubSpot create error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    contactId = data.id;
    created = true;
  }

  let noteAdded = false;
  if (contact.my_note) {
    await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: hubspotHeaders(),
      body: JSON.stringify({
        properties: {
          hs_note_body: `📇 ${contact.my_note}`,
          hs_timestamp: new Date().toISOString(),
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 202,
              },
            ],
          },
        ],
      }),
    }).then(async (resp) => {
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HubSpot note error ${resp.status}: ${text}`);
      }
      noteAdded = true;
    });
  }

  return { contactId, created, matchedBy, noteAdded };
}

app.post('/api/contacts', async (req, res) => {
  try {
    const { contact } = req.body || {};
    if (!contact) return res.status(400).json({ error: 'contact is required' });

    let hubspot = { note: 'skipped: HUBSPOT_ACCESS_TOKEN not set' };
    if (HUBSPOT_ACCESS_TOKEN) {
      hubspot = await saveToHubspot(contact);
    }

    if (CUSTOM_CRM_WEBHOOK_URL) {
      try {
        await fetch(CUSTOM_CRM_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(CUSTOM_CRM_API_KEY ? { authorization: `Bearer ${CUSTOM_CRM_API_KEY}` } : {}),
          },
          body: JSON.stringify({ source: 'bizcard-scanner', contact }),
        });
      } catch (err) {
        console.error('custom CRM webhook failed', err);
      }
    }

    res.json({ hubspot });
  } catch (err) {
    console.error('save contact error', err);
    res.status(500).json({ error: err.message || 'save failed' });
  }
});

const port = PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`bizcard-scanner listening on ${port}`);
});
