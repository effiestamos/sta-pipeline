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

// Map full names to sheet dropdown values
const CLOSER_DROPDOWN_MAP = {
  'AMMAR ELMAHALAWY': 'Ammar',
  'JACK WATSON': 'Jack',
  'DAVE BATEMAN': 'Dave',
  'FOX MACPHERSON': 'Fox',
  'APOLO MENDOZA': 'Apolo',
  'OWEN SAMMARONE': 'Owen'
};

const STATUS_OPTIONS = [
  'Closed', 'Deposit', 'DQ', 'FDQ',
  'Partner | Multiple Partners',
  'Sticker Shock | Investment Issue',
  'Iffy / Feeling it Out / Not Sure',
  'DIM - Do It Myself',
  'Fact Finder / Coaching / Researching',
  'Timing / Logistics',
  'Need to Pitch / Offer',
  'Not Moving Forward',
  'Y - Long Follow Up',
  'Re-Offer',
  'Burned'
];

const TEMP_OPTIONS = ['Cold', 'Cool', 'Warm', 'Hot', '🔥🔥🔥'];

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
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

async function applyRowColor(sheets, tabName, rowIndex, status) {
  let color = null;
  if (status === 'Closed') {
    color = { red: 0.851, green: 0.918, blue: 0.827 }; // #d9ead3
  } else if (status === 'DQ' || status === 'FDQ') {
    color = { red: 0.988, green: 0.898, blue: 0.804 }; // #fce5cd
  }
  
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
- First time calls that are RS, NS, or Cancelled — the call never happened
- Examples: "Que Jay - RS", "Karla - NS", "John - Cancelled"

WHAT TO LOG AS NEW PROSPECT (isFollowUp: false):
- First time calls where the call actually happened and closer wrote notes about the conversation

WHAT TO LOG AS FOLLOW-UP (isFollowUp: true):
- Any entry with FUP right after the name: "Alan Ruchtein - FUP - RS"
- Log all follow-ups even if RS, NS, or Cancelled

EOD NOTES RULES:
- For NEW prospects: prefix notes with date like "5/8 EOD" then the verbatim notes. Example: "5/8 EOD helps startups raise funds..."
- For FOLLOW-UPS: prefix with date and FUP outcome like "5/8 EOD FUP - RS" then verbatim notes
- Copy everything VERBATIM after the prefix. Exact words. No changes. No cleanup.

OFFERS: Closed = Yes. "Didn't offer" = No. Trial mention = Yes.

Extract date from EOD. Format M/D/YYYY.

STATUS OPTIONS: ${STATUS_OPTIONS.join(', ')}
TEMP OPTIONS: ${TEMP_OPTIONS.join(', ')}

Return ONLY valid JSON no markdown:
{
  "date": "M/D/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Name",
      "isFollowUp": false,
      "eodNotes": "5/8 EOD verbatim notes here",
      "suggestedStatus": "status or null",
      "suggestedTemp": "temp or null",
      "offered": "Yes|No|Unknown",
      "nextFollowUpDate": "M/D/YYYY or null",
      "setter": "name or null",
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