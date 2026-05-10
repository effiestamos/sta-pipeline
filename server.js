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
    const prompt = `You are a sales data extraction assistant. Parse this EOD (End of Day) report from closer "${closerName}" and extract structured data.

EOD TEXT:
${eodText}

RULES:
1. Skip cancelled or no-show FIRST TIME calls entirely - do not include them in prospects array. Add them to skipped array with reason.
2. Only include prospects where the FIRST TIME call actually happened.
3. Always include follow-up calls even if they were NS or Cancelled - they are already in the pipeline.
4. A follow-up call is identified by "FUP", "fup", "follow up", or "follow-up" appearing RIGHT AFTER the prospect name (e.g. "Grant - FUP - Closed" or "Juliana - fup - needs to sort..."). Do NOT treat "FUP" inside the notes/summary as a follow-up indicator.
5. For closed deals, Offered is always "Yes".
6. Temperature rules:
   - If a follow-up is booked (even just "FUP next week"), temperature is minimum "Warm"
   - "Super bought in" + FUP booked = offer was likely made, temp = "Warm" minimum
   - FUP - RS (rescheduled): set suggestedTemp to null (no change)
   - FUP - NS (no show): set suggestedTemp to "Cold"
   - FUP - Cancelled: set suggestedTemp to "Cold"
7. EOD notes must be VERBATIM - copy exactly as written including typos, profanity, and casual language. Do not clean up or paraphrase.
8. For follow-up entries, prefix the eodNotes with the date like "5/8 EOD FUP - RS" before the rest of the notes.
9. Extract the date from the EOD text. Format as M/D/YYYY.
10. If stats show a FUP close but no closed prospect is named in EOD notes, add "MISSING_CLOSE" to globalFlags.
11. If offer count in stats doesn't match confirmed offers from notes, add "OFFER_MISMATCH" to globalFlags.
12. "Trial mention" or "got time closed before trial" implies main offer was made first - set offered to "Yes".
13. FUP - RS means rescheduled - do NOT change status, set suggestedStatus to null.

STATUS OPTIONS: ${STATUS_OPTIONS.join(', ')}
TEMP OPTIONS: ${TEMP_OPTIONS.join(', ')} or null for no change

Return ONLY valid JSON with no markdown formatting:
{
  "date": "M/D/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Prospect Full Name",
      "isFollowUp": false,
      "eodNotes": "VERBATIM notes exactly as written",
      "suggestedStatus": "one of STATUS_OPTIONS or null",
      "suggestedTemp": "one of TEMP_OPTIONS or null",
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

    // Get existing data to find prospect rows for FUPs
    const existingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A:K`,
    });
    
    const existingRows = existingResponse.data.values || [];
    
    // Build prospect name to row index map
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
          // Get current EOD notes
          const currentNotesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
          });
          const currentNotes = currentNotesResponse.data.values?.[0]?.[0] || '';
          const updatedNotes = currentNotes + '\n' + prospect.eodNotes;
          
          // Update EOD notes (Column E)
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!E${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[updatedNotes]] },
          });
          
          // Update Last Effort date (Column F)
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${tabName}'!F${existingRowIndex}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[date]] },
          });
          
          // Update Next Follow Up Date (Column G) if provided
          if (prospect.nextFollowUpDate) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!G${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.nextFollowUpDate]] },
            });
          }
          
          // Update Offered (Column H) if known
          if (prospect.offered === 'Yes' || prospect.offered === 'No') {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!H${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.offered]] },
            });
          }

          // Update Temp (Column I) only if suggestedTemp is not null
          if (prospect.suggestedTemp) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!I${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.suggestedTemp]] },
            });
          }
          
          // Update Status (Column J) only if suggestedStatus is not null
          if (prospect.suggestedStatus) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${tabName}'!J${existingRowIndex}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [[prospect.suggestedStatus]] },
            });
          }

        } else {
          // Prospect not found - flag it
          console.log(`FUP prospect not found in sheet: ${prospect.name}`);
        }
      } else {
        // New prospect - append new row
        // Column order: A=Date, B=Closer, C=Prospect Name, D=Setter, E=EOD Notes, F=Last Effort, G=Next FUP Date, H=Offered, I=Temp, J=Status, K=Notes
        const rowData = [
          date,                                                                    // A - Date of Call
          closerName,                                                              // B - Closer
          prospect.name + (prospect.email ? ` | ${prospect.email}` : ''),        // C - Prospect Name
          prospect.setter || '',                                                   // D - Setter
          prospect.eodNotes,                                                       // E - EOD Notes
          date,                                                                    // F - Last Effort (same as date of call for new prospects)
          prospect.nextFollowUpDate || '',                                         // G - Next Follow Up Date
          prospect.offered === 'Yes' ? 'YES' : prospect.offered === 'No' ? 'NO' : '',  // H - Offered
          prospect.suggestedTemp || '',                                            // I - Temp
          prospect.suggestedStatus || '',                                          // J - Status
          ''                                                                       // K - Notes
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