const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPREADSHEET_ID = '11YuQ4xweAflQmiREbaC1IbC_8heTt9UN3FHQy-ry0EE';

const CLOSERS = [
  'AMMAR ELMAHALAWY',
  'JACK WATSON',
  'DAVE BATEMAN',
  'FOX MACPHERSON',
  'APOLO MENDOZA',
  'OWEN SAMMARONE',
  'LOGAN EWELL',
  'DAVID MELMAN'
];

const CLOSER_DROPDOWN_MAP = {
  'AMMAR ELMAHALAWY': 'Ammar',
  'JACK WATSON': 'Jack',
  'DAVE BATEMAN': 'Dave',
  'FOX MACPHERSON': 'Fox',
  'APOLO MENDOZA': 'Apolo',
  'OWEN SAMMARONE': 'Owen',
  'LOGAN EWELL': 'Logan',
  'DAVID MELMAN': 'David'
};

const STATUS_OPTIONS = [
  'CLOSED👍🏼',
  'Deposit 💵 Referral',
  'DQ',
  'FDQ',
  'Partner | Multiple Partners',
  'Sticker Shock | Investment Issue',
  'Iffy / Feeling it Out / Not Sure',
  'DIM - do it myself',
  'Fact Finder/Coaching/Researching',
  'Timing/Logistics',
  'Need to pitch/offer',
  'Not Moving Forward',
  'Y - Long follow up',
  'Re-offer',
  'Burned 🚒',
  'Refund'
];

const STATUS_MAP = {
  'closed': 'CLOSED👍🏼',
  'close': 'CLOSED👍🏼',
  'won': 'CLOSED👍🏼',
  'closed👍🏼': 'CLOSED👍🏼',
  'deposit': 'Deposit 💵 Referral',
  'deposit 💵 referral': 'Deposit 💵 Referral',
  'dq': 'DQ',
  'fdq': 'FDQ',
  'financially dq': 'FDQ',
  'financially dqd': 'FDQ',
  "financially dq'd": 'FDQ',
  'partner | multiple partners': 'Partner | Multiple Partners',
  'partner/multiple partners': 'Partner | Multiple Partners',
  'sticker shock | investment issue': 'Sticker Shock | Investment Issue',
  'sticker shock': 'Sticker Shock | Investment Issue',
  'iffy / feeling it out / not sure': 'Iffy / Feeling it Out / Not Sure',
  'iffy/feeling it out/not sure': 'Iffy / Feeling it Out / Not Sure',
  'iffy': 'Iffy / Feeling it Out / Not Sure',
  'dim - do it myself': 'DIM - do it myself',
  'dim': 'DIM - do it myself',
  'fact finder/coaching/researching': 'Fact Finder/Coaching/Researching',
  'fact finder / coaching / researching': 'Fact Finder/Coaching/Researching',
  'fact finder': 'Fact Finder/Coaching/Researching',
  'timing/logistics': 'Timing/Logistics',
  'timing / logistics': 'Timing/Logistics',
  'timing': 'Timing/Logistics',
  'need to pitch/offer': 'Need to pitch/offer',
  'need to pitch / offer': 'Need to pitch/offer',
  'need to pitch': 'Need to pitch/offer',
  'not moving forward': 'Not Moving Forward',
  'y - long follow up': 'Y - Long follow up',
  'y - long follow-up': 'Y - Long follow up',
  'long follow up': 'Y - Long follow up',
  're-offer': 'Re-offer',
  'reoffer': 'Re-offer',
  'burned': 'Burned 🚒',
  'burned 🚒': 'Burned 🚒',
  'refund': 'Refund'
};

const TEMP_OPTIONS = ['Cold', 'Cool', 'Warm', 'Hot', '🔥🔥🔥'];

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

function mapStatus(status) {
  if (!status) return null;
  const mapped = STATUS_MAP[status.toLowerCase().trim()];
  return mapped || status;
}

function shouldSkipProspect(prospect) {
  // NEVER skip follow-up calls
  if (prospect.isFollowUp) return false;

  const notes = (prospect.eodNotes || '').trim();
  const nameUpper = (prospect.name || '').trim().toUpperCase();

  if (nameUpper === 'LT') return true;

  // Skip new calls that are NS or RS — no call happened
  const notesUpper = notes.toUpperCase();
  const strippedForNS = notesUpper.replace(/^\d+\/\d+\/?(\d+)?\s+EOD\s*/i, '').trim();
  const isFUP = /\bFUP\b/.test(notesUpper) || /\bFU\b/.test(notesUpper);
  if (/\bNS\b/.test(strippedForNS) && !isFUP) return true;
  if (/\bRS\b/.test(strippedForNS) && !isFUP) return true;

  // Strip date prefix for remaining checks
  const strippedNotes = notes
    .replace(/^\d+\/\d+\/?(\d+)?\s+EOD\s*/i, '')
    .trim();

  if (strippedNotes === '') return true;

  // If the entire note ends with LT or LT'd (with optional setter info before it) = skip
  if (/^.*LT'?[Dd]?\s*$/.test(strippedNotes)) return true;

  // LT at the very start with fewer than 4 words after = skip
  const ltAtStart = strippedNotes.match(/^LT'?[Dd]?\s*[-–]?\s*(.*)/i);
  if (ltAtStart) {
    const afterLT = (ltAtStart[1] || '').trim();
    const wordCount = afterLT.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount < 4) return true;
  }

  return false;
}

function applyFUPRules(prospect) {
  if (!prospect.isFollowUp) return prospect;
  const notes = (prospect.eodNotes || '').toUpperCase();
  // Match both FUP and FU variants
  const isRS = notes.includes('FUP - RS') || notes.includes('FUP-RS') || notes.includes('FU - RS') || notes.includes('FU-RS');
  const isNS = notes.includes('FUP - NS') || notes.includes('FUP-NS') || notes.includes('FU - NS') || notes.includes('FU-NS');
  const isCancelled = notes.includes('FUP - CANCELLED') || notes.includes('FUP - CANCELED') || notes.includes('FU - CANCELLED') || notes.includes('FU - CANCELED');
  if (isRS) {
    prospect.suggestedTemp = null;
    prospect.suggestedStatus = null;
  } else if (isNS || isCancelled) {
    prospect.suggestedTemp = 'Cold';
    prospect.suggestedStatus = null;
  }
  return prospect;
}

function calculateFollowUpDate(eodDate, dayMention) {
  const parts = eodDate.split('/');
  const baseDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  const dayMap = {
    'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
    'friday': 5, 'saturday': 6, 'sunday': 0
  };
  const lower = dayMention.toLowerCase().trim();
  if (lower === 'tomorrow') {
    const tomorrow = new Date(baseDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return `${tomorrow.getMonth() + 1}/${tomorrow.getDate()}/${tomorrow.getFullYear()}`;
  }
  // FIX 2: Roll month correctly for "next week"
  if (lower === 'next week') {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + 7);
    return `${next.getMonth() + 1}/?/${next.getFullYear()}`;
  }
  const targetDay = dayMap[lower];
  if (targetDay !== undefined) {
    const result = new Date(baseDate);
    const currentDay = result.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    result.setDate(result.getDate() + daysUntil);
    return `${result.getMonth() + 1}/${result.getDate()}/${result.getFullYear()}`;
  }
  return null;
}

async function applyRowColor(sheets, tabName, rowIndex, status) {
  let color = null;
  if (status === 'CLOSED👍🏼') {
    color = { red: 0.851, green: 0.918, blue: 0.827 };
  } else if (status === 'DQ') {
    color = { red: 0.988, green: 0.898, blue: 0.804 };
  }
  if (!color) return;

  const sheetInfoResponse = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = sheetInfoResponse.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: 0, endColumnIndex: 11 },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: 'userEnteredFormat.backgroundColor'
        }
      }]
    }
  });
}

async function applyRedText(sheets, tabName, rowIndex, colIndex) {
  const sheetInfoResponse = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = sheetInfoResponse.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: rowIndex - 1, endRowIndex: rowIndex, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
          cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 1, green: 0, blue: 0 } } } },
          fields: 'userEnteredFormat.textFormat.foregroundColor'
        }
      }]
    }
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/closers', (req, res) => {
  res.json(CLOSERS);
});

app.post('/api/parse-eod', async (req, res) => {
  const { eodText, closerName } = req.body;
  if (!eodText || !closerName) {
    return res.status(400).json({ error: 'Missing EOD text or closer name' });
  }

  try {
    const prompt = `You are a sales data extraction assistant. Parse this EOD report from closer "${closerName}".

EOD TEXT:
${eodText}

WHAT TO SKIP (add to skipped array, do NOT add to prospects):
- First time calls that are RS or NS — no call took place, add to skipped as "Name - NS, no call took place" or "Name - RS, no call took place"
- Calls "handed off" with no call notes
- "LT" alone with no call summary — call was transferred, never happened with this closer
- "LT'd" alone or with only setter info and no call summary — skip it
- Examples to skip: "Gisele - Sunaiana set - LT'd", "John - LT", "Maria - Nick set - LT'd"
- CP NS, CP RS, CP Cancelled

WHAT TO LOG AS NEW PROSPECT (isFollowUp: false):
- First time calls with actual conversation notes
- NS or RS on a new call = DO NOT log (add to skipped)
- "LT" or "LT'd" WITH real call notes after = LOG
- "Handoff from [name]" WITH real call notes = LOG

WHAT TO LOG AS FOLLOW-UP (isFollowUp: true):
- ANY entry with FUP or FU right after the name — ALWAYS log these, no exceptions
- FU and FUP mean the same thing — treat them identically
- FUP - NS = log it, FU - NS = log it
- FUP - RS = log it, FU - RS = log it
- FUP - Cancelled = log it, FU - Cancelled = log it
- FUP - Closed = log it, FU - Closed = log it

PROSPECT NAME EXTRACTION:
- Extract ONLY the prospect's name
- Strip ONLY: "Closers.io Consult w/", "& [closer name]", "(CP)"
- Keep everything else in notes verbatim

EOD NOTES RULES:
- New prospects: prefix "M/D EOD" then ALL remaining text verbatim
- Follow-ups: prefix "M/D EOD FUP - [outcome]" then verbatim
- Copy VERBATIM — do not remove any words

FOLLOW-UP DATE RULES:
- Specific day (Monday, Thursday, tomorrow, in 2 days): use that day name
- "Next week" with no specific day: use NEXT_WEEK
- A specific future date is mentioned (e.g. "June 10th", "6/10"): return it as M/D/YYYY using the correct month and year — if the EOD is from May and the date mentioned is in June or later, use June (or the correct month), not May
- Will nurture/ULLP/no FUP booked: NURTURE
- No follow-up: null

DATE AND MONTH AWARENESS:
- The EOD date tells you what month and year we are in
- If someone says "next week" and the EOD is 5/30/2026, next week is in June 2026 — do NOT keep it in May
- If a day of the week is mentioned (e.g. "Thursday") and that day is in the next calendar month based on the EOD date, resolve it to the correct month
- Always use the actual calendar to resolve day names to dates — never assume the month stays the same

TEMPERATURE RULES:
- 🔥🔥🔥 = ONLY closed deals
- Hot = verbal yes, reviewing contract, imminent payment
- Warm = FUP booked, bought in but objection
- Cool = some interest, slowing down, DQ to ULLP
- Cold = DQ, FDQ, NS, Cancelled

OFFER RULES:
- Closed = Yes
- "No Offer" or "Didn't offer" = No
- Trial mention = Yes
- Coaching/ULLP without pitching = No

STATUS OPTIONS (exact):
CLOSED👍🏼
Deposit 💵 Referral
DQ
FDQ
Partner | Multiple Partners
Sticker Shock | Investment Issue
Iffy / Feeling it Out / Not Sure
DIM - do it myself
Fact Finder/Coaching/Researching
Timing/Logistics
Need to pitch/offer
Not Moving Forward
Y - Long follow up
Re-offer
Burned 🚒
Refund

Return ONLY valid JSON:
{
  "date": "M/D/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Prospect name only",
      "isFollowUp": false,
      "eodNotes": "date EOD verbatim notes",
      "suggestedStatus": "exact status or null",
      "suggestedTemp": "temp or null",
      "offered": "Yes|No|Unknown",
      "nextFollowUpDate": "day/NEXT_WEEK/NURTURE/M/D/YYYY/null",
      "setter": "name or null",
      "email": "",
      "flags": []
    }
  ],
  "stats": {
    "scheduledConsults": 0, "liveConsults": 0, "offersMade": 0,
    "oneCallCloses": 0, "followUpsScheduled": 0, "followUpsTaken": 0,
    "followUpCloses": 0, "totalFERevenue": 0, "totalFECollected": 0
  },
  "skipped": ["name - reason"],
  "globalFlags": []
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text;
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    const skipped = parsed.skipped || [];
    parsed.prospects = parsed.prospects.filter(p => {
      if (shouldSkipProspect(p)) {
        skipped.push(`${p.name} - NS or LT only, no call took place`);
        return false;
      }
      return true;
    });
    parsed.skipped = skipped;

    parsed.prospects = parsed.prospects.map(p => {
      p.suggestedStatus = mapStatus(p.suggestedStatus);

      if (p.nextFollowUpDate) {
        const fupLower = p.nextFollowUpDate.toLowerCase().trim();
        if (fupLower === 'nurture') {
          p.nextFollowUpDate = '?';
          p.nextFollowUpDateIsApprox = true;
        } else if (fupLower === 'next_week' || fupLower === 'next week') {
          // FIX 2: Roll month correctly — add 7 days to EOD date instead of keeping same month
          const parts = parsed.date.split('/');
          const base = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
          base.setDate(base.getDate() + 7);
          p.nextFollowUpDate = `${base.getMonth() + 1}/?/${base.getFullYear()}`;
          p.nextFollowUpDateIsApprox = true;
        } else if (['monday','tuesday','wednesday','thursday','friday','saturday','sunday','tomorrow'].includes(fupLower)) {
          const calculated = calculateFollowUpDate(parsed.date, fupLower);
          if (calculated) p.nextFollowUpDate = calculated;
        } else if (fupLower.includes('in ') && fupLower.includes('day')) {
          const match = fupLower.match(/in (\d+) day/);
          if (match) {
            const parts = parsed.date.split('/');
            const base = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
            base.setDate(base.getDate() + parseInt(match[1]));
            p.nextFollowUpDate = `${base.getMonth() + 1}/${base.getDate()}/${base.getFullYear()}`;
          }
        }
      }
      return p;
    });

    const confirmedOffers = parsed.prospects.filter(p => p.offered === 'Yes').length;
    const statsOffers = parsed.stats?.offersMade || 0;
    if (confirmedOffers !== statsOffers && statsOffers > 0) {
      if (!parsed.globalFlags) parsed.globalFlags = [];
      parsed.globalFlags.push(`OFFER_MISMATCH: Stats show ${statsOffers} offers but ${confirmedOffers} confirmed. Review offer selections.`);
    }

    const statsFollowUpCloses = parsed.stats?.followUpCloses || 0;
    const confirmedFUPCloses = parsed.prospects.filter(p => p.isFollowUp && p.suggestedStatus === 'CLOSED👍🏼').length;
    if (statsFollowUpCloses > confirmedFUPCloses) {
      if (!parsed.globalFlags) parsed.globalFlags = [];
      parsed.globalFlags.push(`MISSING_CLOSE: Stats show ${statsFollowUpCloses} FUP close(s) but only ${confirmedFUPCloses} found. Check STA Sales channel.`);
    }

    parsed.prospects = parsed.prospects.map(applyFUPRules);
    res.json(parsed);
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: 'Failed to parse EOD: ' + error.message });
  }
});

app.post('/api/save-to-sheets', async (req, res) => {
  const { prospects, stats, date, closerName } = req.body;

  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const tabName = closerName;
    const closerShortName = CLOSER_DROPDOWN_MAP[closerName] || closerName;

    const existingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A:K`,
    });
    const existingRows = existingResponse.data.values || [];

    // FIX 1: Strip " | email" suffix from column C before building the lookup map
    const prospectRowMap = {};
    existingRows.forEach((row, index) => {
      if (index === 0) return;
      const rawName = (row[2] || '').split('|')[0].toLowerCase().trim();
      if (rawName) {
        prospectRowMap[rawName] = index + 1;
        const firstName = rawName.split(' ')[0];
        if (!prospectRowMap[firstName]) {
          prospectRowMap[firstName] = index + 1;
        }
      }
    });

    let lastDataRow = 1;
    existingRows.forEach((row, index) => {
      if (row && row[0] && row[0].toString().trim() !== '') {
        lastDataRow = index + 1;
      }
    });

    for (const prospect of prospects) {
      const p = applyFUPRules(prospect);
      p.suggestedStatus = mapStatus(p.suggestedStatus);
      const isApproxDate = p.nextFollowUpDate && p.nextFollowUpDate.includes('?');

      if (p.isFollowUp) {
        const nameLower = p.name.toLowerCase().trim();
        const firstName = nameLower.split(' ')[0];
        const existingRowIndex = prospectRowMap[nameLower] || prospectRowMap[firstName];

        if (existingRowIndex) {
          const currentNotesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
          });
          const currentNotes = currentNotesResponse.data.values?.[0]?.[0] || '';
          const updatedNotes = currentNotes + '\n\n' + p.eodNotes;

          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[updatedNotes]] },
          });

          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!F${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[date]] },
          });

          if (p.nextFollowUpDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!G${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[p.nextFollowUpDate]] },
            });
            if (isApproxDate) await applyRedText(sheets, tabName, existingRowIndex, 6);
          }

          if (p.offered === 'Yes' || p.offered === 'No') {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!H${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[p.offered]] },
            });
          }

          if (p.suggestedTemp) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!I${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[p.suggestedTemp]] },
            });
          }

          if (p.suggestedStatus) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!J${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[p.suggestedStatus]] },
            });
            await applyRowColor(sheets, tabName, existingRowIndex, p.suggestedStatus);
          }

        } else {
          console.log(`FUP prospect not found: ${p.name}`);
        }

      } else {
        lastDataRow++;
        const targetRow = lastDataRow;

        const rowData = [
          date,
          closerShortName,
          p.name + (p.email ? ` | ${p.email}` : ''),
          p.setter || '',
          p.eodNotes,
          date,
          p.nextFollowUpDate || '',
          p.offered === 'Yes' ? 'YES' : p.offered === 'No' ? 'NO' : '',
          p.suggestedTemp || '',
          p.suggestedStatus || '',
          ''
        ];

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${tabName}'!A${targetRow}:K${targetRow}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [rowData] },
        });

        if (p.suggestedStatus) await applyRowColor(sheets, tabName, targetRow, p.suggestedStatus);
        if (isApproxDate) await applyRedText(sheets, tabName, targetRow, 6);
      }
    }

    res.json({ success: true, message: `Saved ${prospects.length} prospects to ${tabName} tab` });
  } catch (error) {
    console.error('Sheets error:', error);
    res.status(500).json({ error: 'Failed to save to sheets: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});