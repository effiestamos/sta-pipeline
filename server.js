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
  'OWEN SAMMARONE'
];

const CLOSER_DROPDOWN_MAP = {
  'AMMAR ELMAHALAWY': 'Ammar',
  'JACK WATSON': 'Jack',
  'DAVE BATEMAN': 'Dave',
  'FOX MACPHERSON': 'Fox',
  'APOLO MENDOZA': 'Apolo',
  'OWEN SAMMARONE': 'Owen'
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

function applyFUPRules(prospect) {
  if (!prospect.isFollowUp) return prospect;
  const notes = (prospect.eodNotes || '').toUpperCase();
  const isRS = notes.includes('FUP - RS') || notes.includes('FUP-RS');
  const isNS = notes.includes('FUP - NS') || notes.includes('FUP-NS');
  const isCancelled = notes.includes('FUP - CANCELLED') || notes.includes('FUP - CANCELED');
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
    'friday': 5, 'saturday': 6, 'sunday': 0,
    'tomorrow': null, 'next week': null
  };

  const lower = dayMention.toLowerCase().trim();
  
  if (lower === 'tomorrow') {
    const tomorrow = new Date(baseDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return `${tomorrow.getMonth() + 1}/${tomorrow.getDate()}/${tomorrow.getFullYear()}`;
  }
  
  if (lower === 'next week') {
    return `${parts[0]}/?/${parts[2]}`;
  }

  const targetDay = dayMap[lower];
  if (targetDay !== undefined && targetDay !== null) {
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
  // FDQ gets NO color
  if (!color) return;

  const sheetInfoResponse = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  const sheet = sheetInfoResponse.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: 0,
            endColumnIndex: 11
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: color
            }
          },
          fields: 'userEnteredFormat.backgroundColor'
        }
      }]
    }
  });
}

async function applyRedText(sheets, tabName, rowIndex, colIndex) {
  const sheetInfoResponse = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  const sheet = sheetInfoResponse.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: colIndex,
            endColumnIndex: colIndex + 1
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                foregroundColor: { red: 1, green: 0, blue: 0 }
              }
            }
          },
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
- First time calls that are RS, NS, or Cancelled — call never happened
- Calls that were "handed off" to someone else
- Entries that are just "LT" with no notes — transferred to another rep, call never happened with this closer
- CP NS, CP RS, CP Cancelled — call source entries with no-show/cancelled/rescheduled, skip them
- Examples: "Que Jay - RS", "Karla - NS", "John - Cancelled", "Gabriela - handed off", "LT"

WHAT TO LOG AS NEW PROSPECT (isFollowUp: false):
- First time calls where the call actually happened and closer wrote notes

WHAT TO LOG AS FOLLOW-UP (isFollowUp: true):
- Any entry with FUP right after the name
- Log all follow-ups even if RS, NS, or Cancelled

PROSPECT NAME RULES:
- Extract ONLY the prospect's name. Strip out everything else.
- Examples of what to strip: "Closers.io Consult w/", "& Fox Macpherson", "& [closer name]", "(CP)", setter names before the prospect name
- "Closers.io Consult w/ Kevan Nhundu & Fox Macpherson" → name is "Kevan Nhundu"
- "Closers.io Consult w/ arsh Singh & Fox Macpherson (CP)" → name is "Arsh Singh"

EOD NOTES RULES:
- For NEW prospects: prefix with date like "5/8 EOD" then verbatim notes
- For FOLLOW-UPS: prefix with "5/8 EOD FUP - RS" then verbatim notes
- Copy VERBATIM after the prefix. Include CP references in the notes if the call happened.
- Do not include CP references if the call was skipped.

FOLLOW-UP DATE RULES:
- If exact date given (e.g. "FU Monday", "FU Thursday", "tomorrow", "in 2 days"): set nextFollowUpDate to the day name or "tomorrow" and I will calculate the actual date
- If "next week" with no specific day: set to "NEXT_WEEK"
- If only "will nurture", "ULLP", "sending resources", no follow up booked: set to "NURTURE"
- If no follow-up mentioned: null

TEMPERATURE RULES:
- 🔥🔥🔥 = ONLY for closed deals. Never use for anything else.
- Hot = verbal yes, reviewing contract, paying tomorrow/in 2 days/end of week, imminent payment, on the verge
- Warm = FUP booked, bought in but has an objection
- Cool = some interest but slowing down, DQ sent to ULLP
- Cold = DQ, FDQ, NS, Cancelled

OFFER RULES:
- Closed = Yes always
- "Didn't offer" or "No offer" = No
- "Pitched trial" or trial mention = Yes
- "Gave coaching", "ULLP", "gave resources" without pitching = No
- Cross check: total Yes offers must match the offersMade number in stats

STATUS OPTIONS (use EXACTLY as written):
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

TEMP OPTIONS: Cold, Cool, Warm, Hot, 🔥🔥🔥

Return ONLY valid JSON no markdown:
{
  "date": "M/D/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Prospect name only",
      "isFollowUp": false,
      "eodNotes": "5/8 EOD verbatim notes",
      "suggestedStatus": "exact status or null",
      "suggestedTemp": "temp or null",
      "offered": "Yes|No|Unknown",
      "nextFollowUpDate": "day name like Monday/Thursday/tomorrow or NEXT_WEEK or NURTURE or M/D/YYYY or null",
      "setter": "setter name or null",
      "email": "",
      "flags": []
    }
  ],
  "stats": {
    "scheduledConsults": 0,
    "liveConsults": 0,
    "offersMade": 0,
    "oneCallCloses": 0,
    "followUpsScheduled": 0,
    "followUpsTaken": 0,
    "followUpCloses": 0,
    "totalFERevenue": 0,
    "totalFECollected": 0
  },
  "skipped": ["name - reason"],
  "globalFlags": []
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text;
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    // Process dates and statuses
    parsed.prospects = parsed.prospects.map(p => {
      p.suggestedStatus = mapStatus(p.suggestedStatus);

      if (p.nextFollowUpDate) {
        const fupLower = p.nextFollowUpDate.toLowerCase().trim();
        if (fupLower === 'nurture') {
          p.nextFollowUpDate = '?';
          p.nextFollowUpDateIsApprox = true;
        } else if (fupLower === 'next_week' || fupLower === 'next week') {
          const parts = parsed.date.split('/');
          p.nextFollowUpDate = `${parts[0]}/?/${parts[2]}`;
          p.nextFollowUpDateIsApprox = true;
        } else if (['monday','tuesday','wednesday','thursday','friday','saturday','sunday','tomorrow'].includes(fupLower)) {
          const calculated = calculateFollowUpDate(parsed.date, fupLower);
          if (calculated) {
            p.nextFollowUpDate = calculated;
          }
        } else if (fupLower.includes('in ') && fupLower.includes('day')) {
          // "in 2 days" etc
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

    // Check offer count mismatch
    const confirmedOffers = parsed.prospects.filter(p => p.offered === 'Yes').length;
    const statsOffers = parsed.stats?.offersMade || 0;
    if (confirmedOffers !== statsOffers && statsOffers > 0) {
      if (!parsed.globalFlags) parsed.globalFlags = [];
      parsed.globalFlags.push(`OFFER_MISMATCH: Stats show ${statsOffers} offers but only ${confirmedOffers} confirmed. Review offer selections.`);
    }

    // Check FUP close mismatch
    const statsFollowUpCloses = parsed.stats?.followUpCloses || 0;
    const confirmedFUPCloses = parsed.prospects.filter(p => p.isFollowUp && p.suggestedStatus === 'CLOSED👍🏼').length;
    if (statsFollowUpCloses > confirmedFUPCloses) {
      if (!parsed.globalFlags) parsed.globalFlags = [];
      parsed.globalFlags.push(`MISSING_CLOSE: Stats show ${statsFollowUpCloses} FUP close(s) but only ${confirmedFUPCloses} found in EOD notes. Check STA Sales channel.`);
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

    const prospectRowMap = {};
    existingRows.forEach((row, index) => {
      if (index === 0) return;
      const name = (row[2] || '').toLowerCase().trim();
      if (name) {
        prospectRowMap[name] = index + 1;
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
        const existingRowIndex = prospectRowMap[p.name.toLowerCase().trim()];

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
            if (isApproxDate) {
              await applyRedText(sheets, tabName, existingRowIndex, 6);
            }
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

        if (p.suggestedStatus) {
          await applyRowColor(sheets, tabName, targetRow, p.suggestedStatus);
        }

        if (isApproxDate) {
          await applyRedText(sheets, tabName, targetRow, 6);
        }
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