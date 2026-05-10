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

CRITICAL RULES FOR WHAT TO SKIP vs WHAT TO LOG:

SKIP ENTIRELY (do not add to prospects, add to skipped array with reason):
- First time calls that are RS (rescheduled) — e.g. "Que Jay - RS"
- First time calls that are NS (no show) — e.g. "Karla - NS"  
- First time calls that are Cancelled — e.g. "John - Cancelled"
- Any first time call where the call did not actually happen

LOG AS NEW PROSPECT (isFollowUp: false):
- First time calls where the call actually happened and there are notes about the conversation

LOG AS FOLLOW-UP (isFollowUp: true):
- Any entry that has "FUP" right after the prospect name — e.g. "Alan Ruchtein - FUP - RS"
- Follow-up calls get appended to the existing prospect row in the sheet
- Follow-up calls are logged even if they were RS, NS, or Cancelled

TEMPERATURE RULES FOR FOLLOW-UPS:
- FUP - RS (rescheduled): suggestedTemp = null (no change to existing temp)
- FUP - NS (no show): suggestedTemp = "Cold"
- FUP - Cancelled: suggestedTemp = "Cold"
- FUP with live conversation and FUP booked: suggestedTemp = "Warm" minimum

STATUS RULES FOR FOLLOW-UPS:
- FUP - RS: suggestedStatus = null (no change)
- FUP - NS: suggestedStatus = null (no change)
- FUP - Cancelled: suggestedStatus = null (no change)
- FUP - Closed: suggestedStatus = "Closed"
- FUP with live conversation: suggest appropriate status based on notes

TEMPERATURE RULES FOR NEW PROSPECTS:
- FUP booked = minimum "Warm"
- "Super bought in" + FUP booked = "Warm" minimum
- DQ or FDQ = "Cold"
- Cancelled or NS = skip entirely

OFFER RULES:
- Closed deals: offered = "Yes" always
- "Trial mention" or "got time closed before trial": offered = "Yes"
- "Didn't offer": offered = "No"
- Cross-check offers made in stats against prospects

EOD NOTES RULES:
- Copy notes VERBATIM - exact words, typos, profanity, casual language - do not change anything
- For follow-up entries prefix with date: "5/8 EOD FUP - RS" then the rest verbatim

STATUS OPTIONS: ${STATUS_OPTIONS.join(', ')}
TEMP OPTIONS: ${TEMP_OPTIONS.join(', ')} or null

Return ONLY valid JSON no markdown:
{
  "date": "M/D/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Prospect Full Name",
      "isFollowUp": false,
      "eodNotes": "VERBATIM notes",
      "suggestedStatus": "status or null",
      "suggestedTemp": "temp or null",
      "offered": "Yes|No|Unknown",
      "nextFollowUpDate": "M/D/YYYY or null",
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
  "skipped": ["prospect name - reason"],
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

    for (const prospect of prospects) {
      if (prospect.isFollowUp) {
        const existingRowIndex = prospectRowMap[prospect.name.toLowerCase().trim()];
        
        if (existingRowIndex) {
          const currentNotesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
          });
          const currentNotes = currentNotesResponse.data.values?.[0]?.[0] || '';
          const updatedNotes = currentNotes + '\n' + prospect.eodNotes;
          
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[updatedNotes]] },
          });
          
          // F = Last Effort
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!F${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[date]] },
          });
          
          // G = Next Follow Up Date
          if (prospect.nextFollowUpDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!G${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.nextFollowUpDate]] },
            });
          }
          
          // H = Offered
          if (prospect.offered === 'Yes' || prospect.offered === 'No') {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!H${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.offered]] },
            });
          }

          // I = Temp - only update if not null
          if (prospect.suggestedTemp) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!I${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.suggestedTemp]] },
            });
          }
          
          // J = Status - only update if not null
          if (prospect.suggestedStatus) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!J${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.suggestedStatus]] },
            });
          }

        } else {
          console.log(`FUP prospect not found in sheet: ${prospect.name}`);
        }
      } else {
        // A=Date, B=Closer, C=Name, D=Setter, E=EOD Notes, F=Last Effort, G=Next FUP, H=Offered, I=Temp, J=Status, K=Notes
        const rowData = [
          date,
          closerName,
          prospect.name + (prospect.email ? ` | ${prospect.email}` : ''),
          prospect.setter || '',
          prospect.eodNotes,
          date,
          prospect.nextFollowUpDate || '',
          prospect.offered === 'Yes' ? 'YES' : prospect.offered === 'No' ? 'NO' : '',
          prospect.suggestedTemp || '',
          prospect.suggestedStatus || '',
          ''
        ];

        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${tabName}'!A:K`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [rowData] },
        });
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